/**
 * StreamAuction Cloud Functions
 * MVP Phase 1 - 경매 유형 A: 신규 매물 경매
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onRequest} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getDatabase} = require("firebase-admin/database");

const app = initializeApp();
const db = getFirestore(app, "streamauction");
const rtdb = getDatabase(app);

setGlobalOptions({
  maxInstances: 10,
  region: "asia-northeast3",
});

const AUCTION_DURATION_MS = 5 * 60 * 1000;
const SNIPE_WINDOW_MS = 15 * 1000;
const SNIPE_EXTENSION_MS = 15 * 1000;
const FEE_RATE = 0.05;


// ============================================
// 헬퍼: 만료된 경매 자동 정산
// 모든 함수 진입 시 호출해서 타이머 없이도 동작
// ============================================
async function checkAndFinalizeExpiredAuction() {
  const currentRef = rtdb.ref("auction/current");
  const snap = await currentRef.once("value");
  const current = snap.val();

  if (!current || current.status !== "active") return null;
  if (Date.now() < current.endsAt) return null;

  logger.info(`만료된 경매 발견, 자동 정산: ${current.auctionId}`);
  return await doFinalizeAuction(current);
}

// ============================================
// 헬퍼: 만료된 경매 요청 강제청산 처리
// 24시간 미회신 → 보유자 시세 100% 환급 + 무보유 전환
// ============================================
async function checkAndFinalizeExpiredRequests() {
  const now = Date.now();
  const expiredSnap = await db.collection("auctionRequests")
      .where("status", "==", "pending")
      .where("expiresAt", "<=", now)
      .get();

  if (expiredSnap.empty) return;

  const requests = expiredSnap.docs.map((d) => ({ref: d.ref, data: d.data()}));

  // 리스팅 일괄 조회
  const listingSnaps = await Promise.all(
      requests.map((r) => db.collection("listings").doc(r.data.listingId).get()),
  );

  // 강제청산 대상 owner 수집 (config + owner user doc 병렬 조회를 위해 선행)
  const affectedOwners = new Set();
  requests.forEach((req, i) => {
    const listingSnap = listingSnaps[i];
    if (!listingSnap.exists) return;
    const listing = listingSnap.data();
    if (listing.ownerId && listing.ownerId === req.data.ownerId) {
      affectedOwners.add(listing.ownerId);
    }
  });

  const ownerIdList = [...affectedOwners];
  const [configSnap, ...ownerUserSnaps] = await Promise.all([
    db.collection("system").doc("config").get(),
    ...ownerIdList.map((id) => db.collection("users").doc(id).get()),
  ]);
  const config = configSnap.data();
  const ownerUserMap = {};
  ownerIdList.forEach((id, i) => {
    ownerUserMap[id] = ownerUserSnaps[i];
  });

  const batch = db.batch();
  // 같은 보유자의 복수 만료를 합산하기 위해 누적
  const ownerUpdates = {}; // ownerId → {balance, listingIds}

  requests.forEach((req, i) => {
    const listingSnap = listingSnaps[i];
    const reqData = req.data;

    // 요청 상태 만료로 변경
    batch.update(req.ref, {
      status: "expired",
      respondedAt: FieldValue.serverTimestamp(),
    });

    if (!listingSnap.exists) return;
    const listing = listingSnap.data();

    // 소유자가 요청 당시와 다르면 강제청산 건너뜀 (소유권 이미 변경됨)
    if (!listing.ownerId || listing.ownerId !== reqData.ownerId) {
      batch.update(listingSnap.ref, {pendingRequestId: null});
      logger.info(`만료 요청 ${reqData.requestId}: 소유자 변경됨, 강제청산 건너뜀`);
      return;
    }

    const refundAmount = listing.currentPrice || 0;

    // 매물 무보유 전환
    batch.update(listingSnap.ref, {
      ownerId: null,
      pendingRequestId: null,
      immunityUntil: null,
    });

    // 보유자 잔액/보유 목록 업데이트 누적
    if (!ownerUpdates[listing.ownerId]) {
      ownerUpdates[listing.ownerId] = {balance: 0, listingIds: []};
    }
    ownerUpdates[listing.ownerId].balance += refundAmount;
    ownerUpdates[listing.ownerId].listingIds.push(reqData.listingId);

    logger.info(
        `강제청산: listingId=${reqData.listingId}, ownerId=${listing.ownerId}, 환급=${refundAmount}G`,
    );
  });

  // 보유자별 잔액 환급 + 보유 목록 제거 + 튜토리얼 보상
  for (const [ownerId, updates] of Object.entries(ownerUpdates)) {
    const ownerRef = db.collection("users").doc(ownerId);
    const ownerData = ownerUserMap[ownerId]?.data();

    let totalBalance = updates.balance;
    const ownerBatchUpdate = {
      ownedListingIds: FieldValue.arrayRemove(...updates.listingIds),
      ownedCount: FieldValue.increment(-updates.listingIds.length),
    };

    if (ownerData && !ownerData.tutorialRewards?.firstForceLiquidation) {
      const bonus = config?.tutorialRewards?.firstForceLiquidation || 10000;
      totalBalance += bonus;
      ownerBatchUpdate["tutorialRewards.firstForceLiquidation"] = true;
      logger.info(`튜토리얼 보상(강제청산): uid=${ownerId}, ${bonus}G`);
    }

    ownerBatchUpdate.balance = FieldValue.increment(totalBalance);
    batch.update(ownerRef, ownerBatchUpdate);
  }

  await batch.commit();
  logger.info(`만료된 경매 요청 ${expiredSnap.size}건 강제청산 처리 완료`);
}

// ============================================
// 헬퍼: 경매 정산 실행
// ============================================
async function doFinalizeAuction(current) {
  const {
    auctionId, listingId, type,
    displayName, soopId, profileImageUrl,
    registeredBy, startPrice,
    sellerId, requestId: auctionRequestId,
    currentPrice, highestBidderId,
    bidCount, startedAt,
  } = current;

  // holder = Type B (보유자 승인), selloff = Type C (손절)
  const isHolder = type === "holder" || type === "selloff";
  const isWon = bidCount > 0 && !!highestBidderId;
  const finalPrice = isWon ? currentPrice : startPrice;

  // Type B(holder) 유찰 시: 신청자(registeredBy) 잔액이 충분하면 자동 낙찰
  let holderAutoWin = false;
  if (type === "holder" && !isWon && registeredBy) {
    const requesterSnap = await db.collection("users").doc(registeredBy).get();
    const requesterBalance = requesterSnap.exists ? (requesterSnap.data().balance || 0) : 0;
    holderAutoWin = requesterBalance >= startPrice;
  }

  // winnerId 결정
  // Type A 유찰: 등록자 자동 낙찰
  // Type B 유찰 + 잔액 충분: 신청자 자동 낙찰
  // Type B 유찰 + 잔액 부족 / Type C 유찰: null
  const winnerId = isWon ? highestBidderId :
    holderAutoWin ? registeredBy :
    isHolder ? null :
    registeredBy;

  const effectiveIsWon = isWon || holderAutoWin;

  logger.info(`경매 정산: ${auctionId}, type=${type}, 낙찰=${isWon}, autoWin=${holderAutoWin}, 낙찰자=${winnerId}, 가격=${finalPrice}`);

  const configSnap = await db.collection("system").doc("config").get();
  const config = configSnap.data();
  const batch = db.batch();

  const listingRef = db.collection("listings").doc(listingId);
  const listingSnap = await listingRef.get();
  const existingData = listingSnap.exists ? listingSnap.data() : {};
  const now = FieldValue.serverTimestamp();

  // 1. listings 업데이트
  if (isHolder) {
    if (effectiveIsWon) {
      batch.update(listingRef, {
        ownerId: winnerId,
        currentPrice: finalPrice,
        lastTradedAt: now,
        totalTradeCount: FieldValue.increment(1),
        totalTradeVolume: FieldValue.increment(finalPrice),
        highestPrice: finalPrice > (existingData.highestPrice || 0) ?
          finalPrice : existingData.highestPrice,
        lowestPrice: finalPrice < (existingData.lowestPrice || Infinity) ?
          finalPrice : existingData.lowestPrice,
        pendingRequestId: null,
        isLocked: false,
        immunityUntil: null,
      });
    } else {
      // 유찰: 소유권 유지
      // Type B(holder)만 면역 기간 설정, Type C(selloff)는 자발적 등록이므로 불필요
      const listingUpdate = {pendingRequestId: null, isLocked: false};
      if (type === "holder") {
        listingUpdate.immunityUntil = Date.now() + 24 * 60 * 60 * 1000;
      }
      batch.update(listingRef, listingUpdate);
    }
  } else {
    // Type A
    if (!listingSnap.exists) {
      batch.set(listingRef, {
        soopId,
        displayName,
        normalizedNickname: displayName.toLowerCase().replace(/\s/g, ""),
        profileImageUrl: profileImageUrl || null,
        ownerId: winnerId,
        currentPrice: finalPrice,
        basePrice: config.basePrice || 50000,
        lastTradedAt: now,
        totalTradeCount: 1,
        totalTradeVolume: finalPrice,
        highestPrice: finalPrice,
        lowestPrice: finalPrice,
        createdBy: registeredBy,
        createdAt: now,
        isLocked: false,
        reportCount: 0,
        isMosaicked: false,
        reportReasons: {
          inappropriateImage: 0,
          profanity: 0,
          misinformation: 0,
          other: 0,
        },
        schemaVersion: 2,
      });
    } else {
      batch.update(listingRef, {
        ownerId: winnerId,
        currentPrice: finalPrice,
        lastTradedAt: now,
        totalTradeCount: FieldValue.increment(1),
        totalTradeVolume: FieldValue.increment(finalPrice),
        highestPrice: finalPrice > existingData.highestPrice ?
          finalPrice : existingData.highestPrice,
        lowestPrice: finalPrice < existingData.lowestPrice ?
          finalPrice : existingData.lowestPrice,
      });
    }
  }

  // 2. 낙찰자 users 문서 갱신
  if (winnerId) {
    const winnerRef = db.collection("users").doc(winnerId);
    batch.update(winnerRef, {
      ownedListingIds: FieldValue.arrayUnion(listingId),
      ownedCount: FieldValue.increment(1),
      lastLoginAt: now,
    });
  }

  // 3. 잔액 처리
  if (isHolder) {
    if (effectiveIsWon && sellerId) {
      const sellerPayout = Math.floor(finalPrice * (1 - FEE_RATE));
      const sellerRef = db.collection("users").doc(sellerId);
      batch.update(sellerRef, {
        balance: FieldValue.increment(sellerPayout),
        ownedListingIds: FieldValue.arrayRemove(listingId),
        ownedCount: FieldValue.increment(-1),
      });
      logger.info(`판매자 정산: uid=${sellerId}, amount=${sellerPayout}`);

      // Type B 자동 낙찰(유찰 → 신청자 구매): 신청자 잔액 차감
      if (holderAutoWin && registeredBy) {
        const requesterRef = db.collection("users").doc(registeredBy);
        batch.update(requesterRef, {balance: FieldValue.increment(-startPrice)});
        logger.info(`신청자 자동낙찰 차감: uid=${registeredBy}, amount=${startPrice}`);
      }
      // isWon(실제 낙찰) 시엔 placeBid 에스크로에서 이미 차감됨
    }
    // 진짜 유찰(잔액 부족 포함): 잔액 변동 없음
  } else {
    // Type A: 타인 낙찰 시 등록자에게 basePrice 환급
    if (isWon && winnerId !== registeredBy) {
      const registrantRef = db.collection("users").doc(registeredBy);
      const refundAmount = config.basePrice || 50000;
      batch.update(registrantRef, {balance: FieldValue.increment(refundAmount)});
      logger.info(`등록자 basePrice 환급: uid=${registeredBy}, amount=${refundAmount}`);
    }
  }

  // 4. auctionRequests 상태 업데이트 (Type B)
  if (isHolder && auctionRequestId) {
    const requestRef = db.collection("auctionRequests").doc(auctionRequestId);
    batch.update(requestRef, {
      status: effectiveIsWon ? "completed" : "failed",
      respondedAt: now,
    });
  }

  // 5. auctionHistory 저장
  const historyRef = db.collection("auctionHistory").doc(auctionId);
  batch.set(historyRef, {
    auctionId,
    listingId,
    soopId,
    displayName,
    type: type || "new",
    registeredBy,
    sellerId: sellerId || null,
    requestId: auctionRequestId || null,
    startPrice,
    finalPrice,
    winnerId: winnerId || null,
    isWon: effectiveIsWon,
    bidCount: bidCount || 0,
    startedAt: new Date(startedAt),
    endedAt: now,
    schemaVersion: 1,
  });

  // 6. 튜토리얼 보상 체크 (실제 입찰 낙찰만, 자동 낙찰 제외)
  if (isWon && highestBidderId) {
    const winnerRef = db.collection("users").doc(highestBidderId);
    const winnerSnap = await winnerRef.get();
    const winnerData = winnerSnap.data();
    if (winnerData && !winnerData.tutorialRewards?.firstPurchase) {
      const tutorialBonus = config.tutorialRewards?.firstPurchase || 30000;
      batch.update(winnerRef, {
        "balance": FieldValue.increment(tutorialBonus),
        "tutorialRewards.firstPurchase": true,
      });
      logger.info(`튜토리얼 보상(첫 낙찰): uid=${highestBidderId}, ${tutorialBonus}G`);
    }
  }

  await batch.commit();

  await rtdb.ref("auction/current").set({
    status: "completed",
    auctionId,
    finalPrice,
    winnerId: winnerId || null,
    completedAt: Date.now(),
  });

  setTimeout(async () => {
    await startNextFromQueue();
  }, 3000);

  logger.info(`경매 정산 완료: ${auctionId}`);
  return {auctionId, finalPrice, winnerId, isWon};
}

// ============================================
// 헬퍼: 대기열에서 다음 경매 시작
// ============================================
async function startNextFromQueue() {
  const queueRef = rtdb.ref("auction/queue");
  const queueSnap = await queueRef.once("value");
  const queue = queueSnap.val();

  if (!queue) {
    // 대기열 비어있으면 경매 없음 상태로
    await rtdb.ref("auction/current").set(null);
    logger.info("대기열 비어있음, 경매 없음 상태");
    return;
  }

  // queuedAt 기준 오름차순 정렬 (우선권 패스 사용 시 queuedAt=0)
  const entries = Object.entries(queue).sort((a, b) => (a[1].queuedAt || 0) - (b[1].queuedAt || 0));
  const [nextKey, next] = entries[0];

  // 대기열에서 제거
  await queueRef.child(nextKey).remove();

  // 현재 경매 시작
  const now = Date.now();
  const endsAt = now + AUCTION_DURATION_MS;

  await rtdb.ref("auction/current").set({
    auctionId: next.auctionId,
    listingId: next.listingId,
    type: next.type || "new",
    displayName: next.displayName,
    soopId: next.soopId,
    profileImageUrl: next.profileImageUrl || null,
    registeredBy: next.registeredBy,
    sellerId: next.sellerId || null,
    requestId: next.requestId || null,
    startPrice: next.startPrice,
    currentPrice: next.startPrice,
    highestBidderId: null,
    highestBidderName: null,
    bidCount: 0,
    startedAt: now,
    endsAt,
    status: "active",
  });

  // 입찰 기록 초기화
  await rtdb.ref("auction/bids").remove();

  logger.info(`다음 경매 시작: ${next.auctionId}, ${next.displayName}, 종료: ${new Date(endsAt).toISOString()}`);
}


// ============================================
// helloWorld: 테스트용
// ============================================
exports.helloWorld = onRequest(
    {region: "asia-northeast3", invoker: "public"},
    (req, res) => res.send("Hello from StreamAuction! 🎉"),
);


// ============================================
// initializeUser: 유저 가입 처리
// ============================================
exports.initializeUser = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      await checkAndFinalizeExpiredAuction();

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;
      const isAnonymous = authProvider === "anonymous";
      const authType = isAnonymous ? "anonymous" : "google";

      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data();
      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);

        if (userSnap.exists) {
          const userData = userSnap.data();
          const updates = {lastLoginAt: FieldValue.serverTimestamp()};
          if (userData.blockedListingIds === undefined) {
            updates.blockedListingIds = [];
          }
          if (userData.onboardingStep === undefined) {
            updates.onboardingStep = 4;
          }
          transaction.update(userRef, updates);

          return {
            isNewUser: false,
            uid,
            authType: userData.authType,
            balance: userData.balance,
            ownedCount: userData.ownedCount || 0,
            ownedLimit: userData.ownedLimit,
            displayName: userData.displayName || null,
            blockedListingIds: userData.blockedListingIds || [],
            onboardingStep: userData.onboardingStep ?? 4,
            tutorialRewards: userData.tutorialRewards || {},
            consecutiveLoginDays: userData.consecutiveLoginDays || 0,
            lastDailyRewardAt: userData.lastDailyRewardAt?.toMillis?.() || null,
            detailViewPassExpiresAt: userData.detailViewPassExpiresAt || null,
            historyViewPassExpiresAt: userData.historyViewPassExpiresAt || null,
            queuePriorityPassExpiresAt: userData.queuePriorityPassExpiresAt || null,
          };
        }

        const balance = isAnonymous ?
          config.anonymousBonus : config.googleBonus;
        const ownedLimit = isAnonymous ?
          config.anonymousOwnedLimit : config.googleOwnedLimit;

        const newUser = {
          uid,
          authType,
          email: request.auth.token.email || null,
          displayName: request.auth.token.name || null,
          photoURL: request.auth.token.picture || null,
          balance,
          ownedListingIds: [],
          ownedCount: 0,
          ownedLimit,
          createdAt: FieldValue.serverTimestamp(),
          lastLoginAt: FieldValue.serverTimestamp(),
          lastDailyRewardAt: null,
          consecutiveLoginDays: 0,
          adRewardCountToday: 0,
          adRewardLastAt: null,
          tutorialRewards: {
            firstPurchase: false,
            firstTrade: false,
            firstSelloff: false,
            firstForceLiquidation: false,
          },
          blockedListingIds: [],
          onboardingStep: 0,
          isBanned: false,
          banReason: null,
          schemaVersion: 2,
        };

        transaction.set(userRef, newUser);

        return {
          isNewUser: true,
          uid,
          authType,
          balance,
          ownedCount: 0,
          ownedLimit,
          displayName: newUser.displayName,
          blockedListingIds: [],
          onboardingStep: 0,
          tutorialRewards: {},
        };
      });

      return result;
    },
);


// ============================================
// convertAnonymousToGoogle: 익명 → Google 전환
// ============================================
exports.convertAnonymousToGoogle = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;

      if (authProvider !== "google.com") {
        throw new HttpsError("failed-precondition", "Google 로그인이 필요합니다.");
      }

      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data();
      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) {
          throw new HttpsError("not-found", "유저 데이터를 찾을 수 없습니다.");
        }
        const userData = userSnap.data();
        if (userData.authType === "google") {
          throw new HttpsError("already-exists", "이미 Google 계정입니다.");
        }

        const conversionBonus = config.googleBonus - config.anonymousBonus;
        const newBalance = userData.balance + conversionBonus;

        transaction.update(userRef, {
          authType: "google",
          email: request.auth.token.email || userData.email,
          displayName: request.auth.token.name || userData.displayName,
          photoURL: request.auth.token.picture || userData.photoURL,
          balance: newBalance,
          ownedLimit: config.googleOwnedLimit,
          convertedAt: FieldValue.serverTimestamp(),
          lastLoginAt: FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          uid,
          authType: "google",
          balance: newBalance,
          conversionBonus,
          ownedCount: userData.ownedCount || 0,
          ownedLimit: config.googleOwnedLimit,
          displayName: request.auth.token.name || userData.displayName,
        };
      });

      return result;
    },
);


// ============================================
// searchListing: 매물 검색
// 닉네임 또는 soop ID로 검색
// 반환: 매물 정보 또는 null (신규 등록 안내)
// ============================================
exports.searchListing = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      await checkAndFinalizeExpiredAuction();

      const {query} = request.data;

      if (!query || typeof query !== "string" || query.trim().length < 1) {
        throw new HttpsError("invalid-argument", "검색어를 입력해주세요.");
      }

      const q = query.trim();

      // ID 형식 체크 (영숫자만이면 ID로 판단)
      const isIdSearch = /^[a-zA-Z0-9]+$/.test(q);

      let listingSnap = null;

      if (isIdSearch) {
        // ID로 먼저 검색 (소문자 정규화)
        const idDoc = await db.collection("listings").doc(q.toLowerCase()).get();
        if (idDoc.exists) {
          listingSnap = idDoc;
        }
      }

      // ID로 못 찾으면 닉네임으로 검색
      if (!listingSnap) {
        const normalized = q.toLowerCase().replace(/\s/g, "");
        const nickQuery = await db.collection("listings")
            .where("normalizedNickname", "==", normalized)
            .limit(1)
            .get();
        if (!nickQuery.empty) {
          listingSnap = nickQuery.docs[0];
        }
      }

      // 매물 없음
      if (!listingSnap) {
        logger.info(`검색 결과 없음: ${q}`);
        return {found: false, query: q, isIdSearch};
      }

      // 매물 있음
      const data = listingSnap.data();
      logger.info(`검색 결과 찾음: ${data.soopId}`);

      const uid = request.auth.uid;
      const immunityUntil = data.immunityUntil || null;
      const pendingRequestId = data.pendingRequestId || null;
      const canRequest = !!data.ownerId &&
        data.ownerId !== uid &&
        !pendingRequestId &&
        (!immunityUntil || Date.now() >= immunityUntil);

      return {
        found: true,
        listing: {
          listingId: listingSnap.id,
          soopId: data.soopId,
          displayName: data.displayName,
          profileImageUrl: data.profileImageUrl,
          currentPrice: data.currentPrice,
          ownerId: data.ownerId,
          ownerName: data.ownerId ? "ab12***" : null,
          isOwnedByMe: data.ownerId === uid,
          totalTradeCount: data.totalTradeCount,
          lastTradedAt: data.lastTradedAt ?
            data.lastTradedAt.toMillis() : null,
          isMosaicked: data.isMosaicked,
          pendingRequestId,
          immunityUntil,
          canRequest,
        },
      };
    },
);


// ============================================
// registerAuction: 경매 등록
// 신규 매물을 대기열에 추가
// ============================================
exports.registerAuction = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      await checkAndFinalizeExpiredAuction();

      const {soopId, displayName, startPrice, profileImageUrl, type: auctionType} = request.data;
      const uid = request.auth.uid;
      const isSelloff = auctionType === "selloff";

      // 공통 입력 검증
      if (!soopId || !/^[a-zA-Z0-9]+$/.test(soopId)) {
        throw new HttpsError("invalid-argument", "유효하지 않은 soop ID입니다.");
      }

      if (!startPrice || startPrice < 50000) {
        throw new HttpsError("invalid-argument", "시작가는 최소 50,000G입니다.");
      }

      // 유저 정보 확인
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "유저 정보를 찾을 수 없습니다.");
      }
      const userData = userSnap.data();
      if (userData.isBanned) {
        throw new HttpsError("permission-denied", "이용이 제한된 계정입니다.");
      }

      const listingId = soopId.toLowerCase();
      const listingRef = db.collection("listings").doc(listingId);

      // ===== Type C: 손절 경매 =====
      if (isSelloff) {
        const listingSnap = await listingRef.get();
        if (!listingSnap.exists || listingSnap.data().ownerId !== uid) {
          throw new HttpsError(
              "permission-denied",
              "본인 소유 매물만 손절 경매를 등록할 수 있습니다.",
          );
        }
        if (listingSnap.data().isLocked) {
          throw new HttpsError(
              "failed-precondition",
              "해당 매물은 이미 경매가 진행 중입니다.",
          );
        }

        // 대기열 크기 체크
        const queueSnap = await rtdb.ref("auction/queue").once("value");
        const queue = queueSnap.val() || {};
        const queueSize = Object.keys(queue).length;
        if (queueSize >= 5) {
          throw new HttpsError("resource-exhausted", "대기열이 가득 찼습니다.");
        }

        // 현재 경매 / 대기열 중복 체크
        const currentSnap = await rtdb.ref("auction/current").once("value");
        const current = currentSnap.val();
        if (current && current.status === "active" && current.listingId === listingId) {
          throw new HttpsError("already-exists", "해당 매물은 현재 경매 중입니다.");
        }
        for (const key of Object.keys(queue)) {
          if (queue[key].listingId === listingId) {
            throw new HttpsError("already-exists", "해당 매물은 이미 대기열에 있습니다.");
          }
        }

        const listingData = listingSnap.data();
        const auctionId = db.collection("_").doc().id;
        await rtdb.ref(`auction/queue/${auctionId}`).set({
          auctionId,
          listingId,
          type: "selloff",
          soopId: listingData.soopId,
          displayName: listingData.displayName,
          profileImageUrl: listingData.profileImageUrl || null,
          registeredBy: uid,
          sellerId: uid,
          requestId: null,
          startPrice,
          queuedAt: Date.now(),
        });

        // 매물 잠금
        await listingRef.update({isLocked: true});

        logger.info(`손절 경매 등록: ${auctionId}, ${listingData.displayName}, 시작가=${startPrice}`);

        // 튜토리얼 보상 체크 (firstTrade + firstSelloff)
        const selloffConfigSnap = await db.collection("system").doc("config").get();
        const selloffConfig = selloffConfigSnap.data();
        let selloffBalanceDelta = 0;
        const selloffTutorialFlags = {};
        const selloffTutorialRewards = [];

        if (!userData.tutorialRewards?.firstTrade) {
          const bonus = selloffConfig?.tutorialRewards?.firstTrade || 10000;
          selloffBalanceDelta += bonus;
          selloffTutorialFlags["tutorialRewards.firstTrade"] = true;
          selloffTutorialRewards.push({type: "firstTrade", amount: bonus});
          logger.info(`튜토리얼 보상(첫 등록): uid=${uid}, ${bonus}G`);
        }
        if (!userData.tutorialRewards?.firstSelloff) {
          const bonus = selloffConfig?.tutorialRewards?.firstSelloff || 5000;
          selloffBalanceDelta += bonus;
          selloffTutorialFlags["tutorialRewards.firstSelloff"] = true;
          selloffTutorialRewards.push({type: "firstSelloff", amount: bonus});
          logger.info(`튜토리얼 보상(첫 손절): uid=${uid}, ${bonus}G`);
        }
        if (selloffBalanceDelta > 0 || Object.keys(selloffTutorialFlags).length > 0) {
          const selloffUpd = {...selloffTutorialFlags};
          if (selloffBalanceDelta > 0) selloffUpd.balance = FieldValue.increment(selloffBalanceDelta);
          await userRef.update(selloffUpd);
        }

        const selloffTutorialReward = selloffTutorialRewards.length > 0 ? selloffTutorialRewards : null;

        if (!current || current.status !== "active") {
          await startNextFromQueue();
          return {success: true, auctionId, status: "started", message: "손절 경매가 시작됐습니다!", tutorialReward: selloffTutorialReward};
        }
        return {success: true, auctionId, status: "queued", queuePosition: queueSize + 1,
          message: `대기열 ${queueSize + 1}번째에 등록됐습니다.`, tutorialReward: selloffTutorialReward};
      }

      // ===== Type A: 신규/보유자 없는 매물 경매 =====
      if (!displayName || typeof displayName !== "string") {
        throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
      }
      if (/\p{Extended_Pictographic}/u.test(displayName)) {
        throw new HttpsError("invalid-argument", "닉네임에 이모지를 사용할 수 없습니다.");
      }

      // 익명 계정: 1시간 재등록 쿨다운
      if (userData.authType === "anonymous" && userData.lastAuctionRegisteredAt) {
        const elapsed = Date.now() - userData.lastAuctionRegisteredAt;
        const cooldownMs = 60 * 60 * 1000;
        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
          throw new HttpsError(
              "resource-exhausted",
              `익명 계정은 경매 등록 후 1시간 뒤 재등록할 수 있습니다. 약 ${remaining}분 후 가능합니다.`,
          );
        }
      }

      // 잔액 체크 (유찰 시 자동 낙찰 대비 startPrice 필요)
      if (userData.balance < startPrice) {
        throw new HttpsError(
            "failed-precondition",
            `잔액이 부족합니다. 현재 잔액: ${userData.balance.toLocaleString()}G`,
        );
      }

      // 보유 한도 체크 (자동 낙찰될 수 있으니 한도 여유 필요)
      if (userData.ownedCount >= userData.ownedLimit) {
        throw new HttpsError(
            "failed-precondition",
            `보유 한도(${userData.ownedLimit}개)를 초과했습니다.`,
        );
      }

      // 이미 보유자 있는 매물은 등록 불가
      const existingListing = await listingRef.get();
      if (existingListing.exists && existingListing.data().ownerId) {
        throw new HttpsError("already-exists", "이미 보유자가 있는 매물입니다.");
      }

      const isNoHolder = !existingListing.exists || !existingListing.data().ownerId;

      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data();
      const basePrice = (config && config.basePrice) || 50000;

      if (isNoHolder && userData.balance < basePrice) {
        throw new HttpsError(
            "failed-precondition",
            `잔액이 부족합니다. 보유자 없는 매물 등록에는 최소 시세 ${basePrice.toLocaleString()}G가 필요합니다. 현재 잔액: ${userData.balance.toLocaleString()}G`,
        );
      }

      // 대기열 크기 체크
      const queueSnap = await rtdb.ref("auction/queue").once("value");
      const queue = queueSnap.val() || {};
      const queueSize = Object.keys(queue).length;
      if (queueSize >= 5) {
        throw new HttpsError("resource-exhausted", "대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요.");
      }

      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();
      if (current && current.status === "active" && current.listingId === listingId) {
        throw new HttpsError("already-exists", "해당 매물은 현재 경매 중입니다.");
      }
      for (const key of Object.keys(queue)) {
        if (queue[key].listingId === listingId) {
          throw new HttpsError("already-exists", "해당 매물은 이미 대기열에 있습니다.");
        }
      }

      const hasPriorityPass = userData.queuePriorityPassExpiresAt &&
        userData.queuePriorityPassExpiresAt > Date.now();
      const auctionId = db.collection("_").doc().id;
      await rtdb.ref(`auction/queue/${auctionId}`).set({
        auctionId,
        listingId,
        type: "new",
        soopId: soopId.toLowerCase(),
        displayName,
        profileImageUrl: profileImageUrl || null,
        registeredBy: uid,
        startPrice,
        queuedAt: hasPriorityPass ? 0 : Date.now(),
      });

      // 잔액 변동 누적 (basePrice 차감 + firstTrade 보상 합산)
      let newBalanceDelta = 0;
      const userUpdate = {};
      const newTutorialRewards = [];

      if (isNoHolder) {
        newBalanceDelta -= basePrice;
        logger.info(`보유자 없는 경매 등록 차감: uid=${uid}, basePrice=${basePrice}`);
      }

      if (!userData.tutorialRewards?.firstTrade) {
        const bonus = config?.tutorialRewards?.firstTrade || 10000;
        newBalanceDelta += bonus;
        userUpdate["tutorialRewards.firstTrade"] = true;
        newTutorialRewards.push({type: "firstTrade", amount: bonus});
        logger.info(`튜토리얼 보상(첫 등록): uid=${uid}, ${bonus}G`);
      }

      if (newBalanceDelta !== 0) {
        userUpdate.balance = FieldValue.increment(newBalanceDelta);
      }
      if (userData.authType === "anonymous") {
        userUpdate.lastAuctionRegisteredAt = Date.now();
      }
      if (Object.keys(userUpdate).length > 0) {
        await userRef.update(userUpdate);
      }

      logger.info(`경매 등록: ${auctionId}, ${displayName}, 시작가=${startPrice}`);

      const newTutorialReward = newTutorialRewards.length > 0 ? newTutorialRewards : null;

      if (!current || current.status !== "active") {
        await startNextFromQueue();
        return {success: true, auctionId, status: "started", message: "경매가 시작됐습니다!", tutorialReward: newTutorialReward};
      }
      return {
        success: true, auctionId, status: "queued", queuePosition: queueSize + 1,
        message: `대기열 ${queueSize + 1}번째에 등록됐습니다.`, tutorialReward: newTutorialReward,
      };
    },
);


// ============================================
// placeBid: 입찰 처리
// 에스크로 방식: 입찰 즉시 잔액 차감
// ============================================
exports.placeBid = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const {bidAmount} = request.data;
      const uid = request.auth.uid;

      if (!bidAmount || typeof bidAmount !== "number" || bidAmount <= 0) {
        throw new HttpsError("invalid-argument", "유효하지 않은 입찰가입니다.");
      }

      // 만료 경매 먼저 정산
      await checkAndFinalizeExpiredAuction();

      // 현재 경매 확인
      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();

      if (!current || current.status !== "active") {
        throw new HttpsError("not-found", "진행 중인 경매가 없습니다.");
      }

      if (Date.now() >= current.endsAt) {
        // 방금 만료된 경우 정산
        await doFinalizeAuction(current);
        throw new HttpsError("deadline-exceeded", "경매가 종료됐습니다.");
      }

      // 자기 매물 입찰 불가
      const listingSnap = await db.collection("listings")
          .doc(current.listingId).get();
      if (listingSnap.exists && listingSnap.data().ownerId === uid) {
        throw new HttpsError("permission-denied", "자기 매물에는 입찰할 수 없습니다.");
      }

      // 입찰가 검증 (현재 최고가 + 최소 1만G 이상)
      const minBid = current.currentPrice + 10000;
      if (bidAmount < minBid) {
        throw new HttpsError(
            "invalid-argument",
            `최소 입찰가는 ${minBid.toLocaleString()}G입니다.`,
        );
      }

      // 유저 정보 + 잔액 체크
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "유저 정보를 찾을 수 없습니다.");
      }
      const userData = userSnap.data();

      if (userData.isBanned) {
        throw new HttpsError("permission-denied", "이용이 제한된 계정입니다.");
      }

      // 보유 한도 체크 (낙찰되면 매물 늘어남)
      if (userData.ownedCount >= userData.ownedLimit) {
        throw new HttpsError(
            "failed-precondition",
            `보유 한도(${userData.ownedLimit}개)를 초과했습니다.`,
        );
      }

      // 에스크로 잔액 체크 (현재 입찰금만큼 있어야 함)
      if (userData.balance < bidAmount) {
        throw new HttpsError(
            "failed-precondition",
            `잔액이 부족합니다. 현재 잔액: ${userData.balance.toLocaleString()}G`,
        );
      }

      // 이전 최고 입찰자에게 환불
      const prevBidderId = current.highestBidderId;
      const prevBidAmount = current.currentPrice;

      // Firestore 트랜잭션으로 잔액 처리
      await db.runTransaction(async (transaction) => {
        // 환불
        if (prevBidderId && prevBidderId !== uid) {
          const prevBidderRef = db.collection("users").doc(prevBidderId);
          transaction.update(prevBidderRef, {
            balance: FieldValue.increment(prevBidAmount),
          });
        }

        // 새 입찰자 잔액 차감
        const userSnap2 = await transaction.get(userRef);
        const balance2 = userSnap2.data().balance;
        if (balance2 < bidAmount) {
          throw new HttpsError("failed-precondition", "잔액이 부족합니다.");
        }
        transaction.update(userRef, {
          balance: FieldValue.increment(-bidAmount),
        });
      });

      // RTDB 경매 상태 갱신
      const now = Date.now();
      const newEndsAt = (current.endsAt - now <= SNIPE_WINDOW_MS) ?
        now + SNIPE_EXTENSION_MS :
        current.endsAt;

      const bidderName = uid.substring(0, 4) + "***";

      await rtdb.ref("auction/current").update({
        currentPrice: bidAmount,
        highestBidderId: uid,
        highestBidderName: bidderName,
        bidCount: (current.bidCount || 0) + 1,
        endsAt: newEndsAt,
      });

      // 입찰 기록 추가
      const bidId = Date.now().toString();
      await rtdb.ref(`auction/bids/${bidId}`).set({
        bidderId: uid,
        bidderName,
        amount: bidAmount,
        bidAt: now,
      });

      // 이전 최고가 + 1만G 이상인지 로그
      logger.info(`입찰: ${uid}, ${bidAmount}G, 경매=${current.auctionId}`);

      const isExtended = newEndsAt > current.endsAt;

      return {
        success: true,
        bidAmount,
        newEndsAt,
        isExtended,
        message: isExtended ?
          `입찰 성공! 스나이핑 방지로 ${SNIPE_EXTENSION_MS / 1000}초 연장됐습니다.` :
          "입찰 성공!",
      };
    },
);


// ============================================
// finalizeAuction: 경매 수동 종료 요청
// 클라이언트가 타이머 만료 후 호출
// ============================================
exports.finalizeAuction = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();

      if (!current || current.status !== "active") {
        throw new HttpsError("not-found", "진행 중인 경매가 없습니다.");
      }

      if (Date.now() < current.endsAt) {
        throw new HttpsError(
            "failed-precondition",
            "경매가 아직 진행 중입니다.",
        );
      }

      const result = await doFinalizeAuction(current);
      return result;
    },
);


// ============================================
// getAuctionState: 현재 경매 상태 조회 (HTTP)
// RTDB 직접 읽기로 대체 가능하지만
// 초기 로드 시 정산 트리거용으로 사용
// ============================================
exports.getAuctionState = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await checkAndFinalizeExpiredAuction();
      await checkAndFinalizeExpiredRequests();

      const currentSnap = await rtdb.ref("auction/current").once("value");
      const queueSnap = await rtdb.ref("auction/queue").once("value");

      const current = currentSnap.val();
      const queueObj = queueSnap.val() || {};
      const queue = Object.values(queueObj)
          .sort((a, b) => a.queuedAt - b.queuedAt);

      return {
        current: current || null,
        queue,
        serverTime: Date.now(),
      };
    },
);


// ============================================
// requestAuction: 보유자 승인 경매 요청 (Type B)
// 매물 보유자에게 경매 요청을 보냄
// ============================================
exports.requestAuction = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      // 익명 계정은 경매 요청 불가
      const authProvider = request.auth.token.firebase.sign_in_provider;
      if (authProvider === "anonymous") {
        throw new HttpsError(
            "permission-denied",
            "경매 요청은 Google 계정에서만 가능합니다. 계정을 전환해주세요.",
        );
      }

      await checkAndFinalizeExpiredAuction();
      await checkAndFinalizeExpiredRequests();

      const {listingId} = request.data;
      const uid = request.auth.uid;

      if (!listingId || typeof listingId !== "string") {
        throw new HttpsError("invalid-argument", "매물 ID가 필요합니다.");
      }

      const listingRef = db.collection("listings").doc(listingId);
      const listingSnap = await listingRef.get();

      if (!listingSnap.exists) {
        throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
      }

      const listing = listingSnap.data();

      if (!listing.ownerId) {
        throw new HttpsError("failed-precondition", "보유자가 없는 매물입니다. 직접 경매를 등록하세요.");
      }

      if (listing.ownerId === uid) {
        throw new HttpsError("permission-denied", "내 매물에는 요청할 수 없습니다.");
      }

      if (listing.pendingRequestId) {
        throw new HttpsError("already-exists", "이미 진행 중인 경매 요청이 있습니다.");
      }

      if (listing.immunityUntil && Date.now() < listing.immunityUntil) {
        const remaining = Math.ceil((listing.immunityUntil - Date.now()) / 60000);
        throw new HttpsError(
            "failed-precondition",
            `유찰 후 면역 기간입니다. 약 ${remaining}분 후 요청 가능합니다.`,
        );
      }

      // 유저 확인
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists || userSnap.data().isBanned) {
        throw new HttpsError("permission-denied", "이용이 제한된 계정입니다.");
      }

      const requestRef = db.collection("auctionRequests").doc();
      const requestId = requestRef.id;
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

      const batch = db.batch();

      batch.set(requestRef, {
        requestId,
        listingId,
        requesterId: uid,
        ownerId: listing.ownerId,
        soopId: listing.soopId,
        displayName: listing.displayName,
        profileImageUrl: listing.profileImageUrl || null,
        status: "pending",
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        respondedAt: null,
        auctionId: null,
        schemaVersion: 1,
      });

      batch.update(listingRef, {pendingRequestId: requestId});

      batch.update(db.collection("users").doc(uid), {
        [`lastAuctionRequests.${listingId}`]: Date.now(),
      });

      await batch.commit();

      logger.info(`경매 요청 생성: requestId=${requestId}, listingId=${listingId}, requester=${uid}`);

      return {success: true, requestId, expiresAt};
    },
);


// ============================================
// respondToAuctionRequest: 경매 요청 승인/거부 (Type B)
// 매물 보유자가 요청에 응답
// ============================================
exports.respondToAuctionRequest = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      await checkAndFinalizeExpiredAuction();
      await checkAndFinalizeExpiredRequests();

      const {requestId, action, startPrice} = request.data;
      const uid = request.auth.uid;

      if (!requestId || typeof requestId !== "string") {
        throw new HttpsError("invalid-argument", "요청 ID가 필요합니다.");
      }

      if (!["approve", "reject"].includes(action)) {
        throw new HttpsError("invalid-argument", "action은 approve 또는 reject여야 합니다.");
      }

      const requestRef = db.collection("auctionRequests").doc(requestId);
      const requestSnap = await requestRef.get();

      if (!requestSnap.exists) {
        throw new HttpsError("not-found", "요청을 찾을 수 없습니다.");
      }

      const req = requestSnap.data();

      if (req.status !== "pending") {
        throw new HttpsError("failed-precondition", "이미 처리된 요청입니다.");
      }

      if (req.ownerId !== uid) {
        throw new HttpsError("permission-denied", "권한이 없습니다.");
      }

      const listingRef = db.collection("listings").doc(req.listingId);
      const listingSnap = await listingRef.get();

      if (!listingSnap.exists) {
        throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
      }

      if (action === "reject") {
        const batch = db.batch();
        batch.update(requestRef, {
          status: "rejected",
          respondedAt: FieldValue.serverTimestamp(),
        });
        batch.update(listingRef, {
          pendingRequestId: null,
          immunityUntil: Date.now() + 24 * 60 * 60 * 1000,
        });
        await batch.commit();
        logger.info(`경매 요청 거부: requestId=${requestId}`);
        return {success: true, action: "rejected"};
      }

      // approve
      const sp = (startPrice && startPrice >= 50000) ?
        startPrice : (listingSnap.data().currentPrice || 50000);

      // 대기열 크기 체크
      const queueSnap = await rtdb.ref("auction/queue").once("value");
      const queue = queueSnap.val() || {};
      const queueSize = Object.keys(queue).length;

      if (queueSize >= 5) {
        throw new HttpsError("resource-exhausted", "대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요.");
      }

      // 현재 경매/대기열 중복 체크
      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();

      if (current && current.status === "active" && current.listingId === req.listingId) {
        throw new HttpsError("already-exists", "해당 매물은 현재 경매 중입니다.");
      }

      for (const key of Object.keys(queue)) {
        if (queue[key].listingId === req.listingId) {
          throw new HttpsError("already-exists", "해당 매물은 이미 대기열에 있습니다.");
        }
      }

      const requesterSnap = await db.collection("users").doc(req.requesterId).get();
      const requesterData = requesterSnap.exists ? requesterSnap.data() : {};
      const requesterHasPriorityPass = requesterData.queuePriorityPassExpiresAt &&
        requesterData.queuePriorityPassExpiresAt > Date.now();
      const auctionId = db.collection("_").doc().id;
      const newQueueItem = {
        auctionId,
        listingId: req.listingId,
        type: "holder",
        soopId: req.soopId,
        displayName: req.displayName,
        profileImageUrl: req.profileImageUrl || null,
        registeredBy: req.requesterId,
        sellerId: uid,
        requestId,
        startPrice: sp,
        queuedAt: requesterHasPriorityPass ? 0 : Date.now(),
      };

      await rtdb.ref(`auction/queue/${auctionId}`).set(newQueueItem);

      const batch = db.batch();
      batch.update(requestRef, {
        status: "approved",
        auctionId,
        respondedAt: FieldValue.serverTimestamp(),
      });
      batch.update(listingRef, {pendingRequestId: null, isLocked: true});
      await batch.commit();

      logger.info(`경매 요청 승인: requestId=${requestId}, auctionId=${auctionId}`);

      if (!current || current.status !== "active") {
        await startNextFromQueue();
        return {success: true, action: "approved", auctionId, status: "started"};
      }

      return {success: true, action: "approved", auctionId, status: "queued"};
    },
);

// ============================================
// 헬퍼: 관리자 권한 체크
// system/admin.adminUids 배열에 UID가 있어야 함
// ============================================
async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const adminSnap = await db.collection("system").doc("admin").get();
  const adminUids = adminSnap.exists ? (adminSnap.data().adminUids || []) : [];
  if (!adminUids.includes(request.auth.uid)) {
    throw new HttpsError("permission-denied", "관리자 권한이 필요합니다.");
  }
}

// ============================================
// adminGetDashboard: 대시보드 데이터
// ============================================
exports.adminGetDashboard = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);

      const [userCountSnap, listingCountSnap, currentSnap, queueSnap, historySnap] =
        await Promise.all([
          db.collection("users").count().get(),
          db.collection("listings").count().get(),
          rtdb.ref("auction/current").once("value"),
          rtdb.ref("auction/queue").once("value"),
          db.collection("auctionHistory").orderBy("endedAt", "desc").limit(10).get(),
        ]);

      const queue = queueSnap.val() || {};
      const history = historySnap.docs.map((d) => {
        const data = d.data();
        return {
          auctionId: data.auctionId,
          displayName: data.displayName,
          type: data.type || "new",
          finalPrice: data.finalPrice,
          isWon: data.isWon,
          bidCount: data.bidCount || 0,
          endedAt: data.endedAt?.toMillis?.() || null,
        };
      });

      return {
        stats: {
          userCount: userCountSnap.data().count,
          listingCount: listingCountSnap.data().count,
          queueSize: Object.keys(queue).length,
        },
        current: currentSnap.val(),
        queue: Object.values(queue).sort((a, b) => a.queuedAt - b.queuedAt),
        recentHistory: history,
      };
    },
);

// ============================================
// adminForceFinalize: 경매 강제 종료
// ============================================
exports.adminForceFinalize = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);

      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();

      if (!current || current.status !== "active") {
        throw new HttpsError("not-found", "진행 중인 경매가 없습니다.");
      }

      const result = await doFinalizeAuction(current);
      logger.info(`관리자 강제 종료: ${current.auctionId} by ${request.auth.uid}`);
      return result;
    },
);

// ============================================
// adminClearQueue: 대기열 전체 삭제
// ============================================
exports.adminClearQueue = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      await rtdb.ref("auction/queue").remove();
      logger.info(`관리자 대기열 초기화 by ${request.auth.uid}`);
      return {success: true};
    },
);

// ============================================
// adminGetUser: 유저 정보 조회
// ============================================
exports.adminGetUser = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const {uid} = request.data;
      if (!uid || typeof uid !== "string") {
        throw new HttpsError("invalid-argument", "UID가 필요합니다.");
      }

      const userSnap = await db.collection("users").doc(uid.trim()).get();
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      }

      const data = userSnap.data();
      const now = Date.now();
      const fmtPass = (v) => (!v ? null : v > now ? `${Math.ceil((v - now) / 86400000)}일 남음` : "만료");
      return {
        uid: userSnap.id,
        authType: data.authType || "anonymous",
        displayName: data.displayName || null,
        email: data.email || null,
        balance: data.balance || 0,
        ownedCount: data.ownedCount || 0,
        ownedLimit: data.ownedLimit || 0,
        ownedListingIds: data.ownedListingIds || [],
        isBanned: data.isBanned || false,
        banReason: data.banReason || null,
        tutorialRewards: data.tutorialRewards || {},
        consecutiveLoginDays: data.consecutiveLoginDays || 0,
        lastDailyRewardAt: data.lastDailyRewardAt?.toMillis?.() || null,
        createdAt: data.createdAt?.toMillis?.() || null,
        lastLoginAt: data.lastLoginAt?.toMillis?.() || null,
        detailViewPass: fmtPass(data.detailViewPassExpiresAt),
        historyViewPass: fmtPass(data.historyViewPassExpiresAt),
        queuePriorityPass: fmtPass(data.queuePriorityPassExpiresAt),
      };
    },
);

// ============================================
// adminBanUser: 유저 정지/해제
// ============================================
exports.adminBanUser = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const {uid, isBanned, banReason} = request.data;
      if (!uid) throw new HttpsError("invalid-argument", "UID가 필요합니다.");

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");

      await userRef.update({
        isBanned: !!isBanned,
        banReason: isBanned ? (banReason || null) : null,
      });

      logger.info(`관리자: 유저 ${isBanned ? "정지" : "해제"} uid=${uid} by ${request.auth.uid}`);
      return {success: true, uid, isBanned: !!isBanned};
    },
);

// ============================================
// adminAdjustBalance: 유저 잔액 조정
// ============================================
exports.adminAdjustBalance = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const {uid, delta} = request.data;
      if (!uid) throw new HttpsError("invalid-argument", "UID가 필요합니다.");
      if (!delta || typeof delta !== "number" || delta === 0) {
        throw new HttpsError("invalid-argument", "0이 아닌 delta 숫자가 필요합니다.");
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");

      await userRef.update({balance: FieldValue.increment(delta)});
      const newSnap = await userRef.get();

      logger.info(`관리자 잔액 조정: uid=${uid}, delta=${delta} by ${request.auth.uid}`);
      return {success: true, uid, delta, newBalance: newSnap.data().balance};
    },
);

// ============================================
// adminGetConfig: 시스템 설정 조회
// ============================================
exports.adminGetConfig = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const configSnap = await db.collection("system").doc("config").get();
      if (!configSnap.exists) throw new HttpsError("not-found", "설정을 찾을 수 없습니다.");
      return configSnap.data();
    },
);

// ============================================
// adminSetConfig: 시스템 설정 저장 (허용된 필드만)
// ============================================
exports.adminSetConfig = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const {updates} = request.data;
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        throw new HttpsError("invalid-argument", "updates 객체가 필요합니다.");
      }

      const allowed = [
        "basePrice", "anonymousBonus", "googleBonus",
        "anonymousOwnedLimit", "googleOwnedLimit",
        "tutorialRewards.firstPurchase", "tutorialRewards.firstTrade",
        "tutorialRewards.firstSelloff", "tutorialRewards.firstForceLiquidation",
        "dailyReward1", "dailyReward3Plus", "dailyRewardBonus7", "dailyRewardBonus30",
      ];
      const filtered = {};
      for (const key of allowed) {
        if (key in updates && typeof updates[key] === "number" && updates[key] >= 0) {
          filtered[key] = updates[key];
        }
      }
      if (Object.keys(filtered).length === 0) {
        throw new HttpsError("invalid-argument", "유효한 업데이트 항목이 없습니다.");
      }

      await db.collection("system").doc("config").update(filtered);
      logger.info(`관리자 config 업데이트 by ${request.auth.uid}`, filtered);
      return {success: true, updated: Object.keys(filtered)};
    },
);

// ============================================
// reportListing: 매물 신고
// ============================================
exports.reportListing = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }
      if (request.auth.token.firebase?.sign_in_provider === "anonymous") {
        throw new HttpsError("permission-denied", "신고는 Google 계정만 가능합니다.");
      }

      const {listingId, reason} = request.data;
      const uid = request.auth.uid;
      const VALID_REASONS = ["inappropriateImage", "profanity", "misinformation", "other"];

      if (!listingId || typeof listingId !== "string") {
        throw new HttpsError("invalid-argument", "매물 ID가 필요합니다.");
      }
      if (!reason || !VALID_REASONS.includes(reason)) {
        throw new HttpsError("invalid-argument", "유효하지 않은 신고 사유입니다.");
      }

      const listingRef = db.collection("listings").doc(listingId);
      const listingSnap = await listingRef.get();
      if (!listingSnap.exists) {
        throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
      }

      const listing = listingSnap.data();
      if (listing.ownerId === uid) {
        throw new HttpsError("permission-denied", "자신의 매물은 신고할 수 없습니다.");
      }

      // 중복 신고 방지 (reportId = listingId_uid)
      const reportRef = db.collection("reports").doc(`${listingId}_${uid}`);
      const reportSnap = await reportRef.get();
      if (reportSnap.exists) {
        throw new HttpsError("already-exists", "이미 신고한 매물입니다.");
      }

      const MOSAIC_THRESHOLD = 10;
      const newCount = (listing.reportCount || 0) + 1;

      const batch = db.batch();
      batch.set(reportRef, {
        listingId,
        reporterId: uid,
        reason,
        createdAt: FieldValue.serverTimestamp(),
      });
      const listingUpdate = {
        reportCount: FieldValue.increment(1),
        [`reportReasons.${reason}`]: FieldValue.increment(1),
      };
      if (newCount >= MOSAIC_THRESHOLD && !listing.isMosaicked) {
        listingUpdate.isMosaicked = true;
        logger.info(`모자이크 자동 적용: listingId=${listingId}, reportCount=${newCount}`);
      }
      batch.update(listingRef, listingUpdate);
      await batch.commit();

      logger.info(`신고: listingId=${listingId}, uid=${uid}, reason=${reason}`);
      return {success: true, isMosaicked: newCount >= MOSAIC_THRESHOLD};
    },
);

// ============================================
// blockListing: 매물 차단 / 해제
// ============================================
exports.blockListing = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const {listingId, block} = request.data;
      const uid = request.auth.uid;

      if (!listingId || typeof listingId !== "string") {
        throw new HttpsError("invalid-argument", "매물 ID가 필요합니다.");
      }

      const isBlock = block !== false;
      const blockUpdate = isBlock ?
        FieldValue.arrayUnion(listingId) :
        FieldValue.arrayRemove(listingId);
      await db.collection("users").doc(uid).update({blockedListingIds: blockUpdate});

      logger.info(`${isBlock ? "차단" : "차단해제"}: listingId=${listingId}, uid=${uid}`);
      return {success: true, blocked: isBlock, listingId};
    },
);

// ============================================
// adminGetReports: 신고된 매물 목록 (관리자)
// ============================================
exports.adminGetReports = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);

      const snap = await db.collection("listings")
          .where("reportCount", ">", 0)
          .orderBy("reportCount", "desc")
          .limit(50)
          .get();

      return snap.docs.map((d) => {
        const data = d.data();
        return {
          listingId: d.id,
          soopId: data.soopId,
          displayName: data.displayName,
          reportCount: data.reportCount || 0,
          reportReasons: data.reportReasons || {},
          isMosaicked: data.isMosaicked || false,
          ownerId: data.ownerId || null,
        };
      });
    },
);

// ============================================
// adminSetMosaic: 모자이크 수동 설정 / 해제 (관리자)
// ============================================
exports.adminSetMosaic = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      await requireAdmin(request);
      const {listingId, isMosaicked} = request.data;

      if (!listingId) throw new HttpsError("invalid-argument", "listingId가 필요합니다.");

      const listingRef = db.collection("listings").doc(listingId);
      if (!(await listingRef.get()).exists) {
        throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
      }

      await listingRef.update({isMosaicked: !!isMosaicked});
      logger.info(`관리자 모자이크 ${isMosaicked ? "적용" : "해제"}: ${listingId} by ${request.auth.uid}`);
      return {success: true, listingId, isMosaicked: !!isMosaicked};
    },
);

// ============================================
// claimDailyReward: 출석 보상 (Google 전용)
// ============================================
function getKSTDateStr(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

exports.claimDailyReward = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data() || {};

      const userRef = db.collection("users").doc(uid);

      return db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
        const user = userSnap.data();

        if (user.isBanned) throw new HttpsError("permission-denied", "정지된 계정입니다.");
        if (user.authType === "anonymous") {
          throw new HttpsError("permission-denied", "Google 계정만 출석 보상을 받을 수 있습니다.");
        }

        const now = new Date();
        const todayKST = getKSTDateStr(now);
        const lastAt = user.lastDailyRewardAt?.toDate?.() || null;
        const lastKST = lastAt ? getKSTDateStr(lastAt) : null;

        if (lastKST === todayKST) {
          throw new HttpsError("already-exists", "오늘 이미 출석 보상을 받으셨습니다.");
        }

        const yesterdayKST = getKSTDateStr(new Date(now.getTime() - 86400000));
        const newStreak = lastKST === yesterdayKST ?
          (user.consecutiveLoginDays || 0) + 1 : 1;

        const base = newStreak <= 2 ?
          (config.dailyReward1 || 5000) :
          (config.dailyReward3Plus || 10000);

        let bonus = 0;
        let specialDay = null;
        if (newStreak % 30 === 0) {
          bonus = config.dailyRewardBonus30 || 100000;
          specialDay = 30;
        } else if (newStreak % 7 === 0) {
          bonus = config.dailyRewardBonus7 || 30000;
          specialDay = 7;
        }
        const totalReward = base + bonus;

        tx.update(userRef, {
          balance: FieldValue.increment(totalReward),
          lastDailyRewardAt: FieldValue.serverTimestamp(),
          consecutiveLoginDays: newStreak,
        });

        logger.info(`출석 보상: uid=${uid}, streak=${newStreak}, reward=${totalReward}G`);
        return {
          reward: totalReward,
          base,
          bonus,
          specialDay,
          newStreak,
          newBalance: user.balance + totalReward,
        };
      });
    },
);

// ============================================
// viewListingDetail: 매물 상세 열람 BM (50,000G)
// ============================================
exports.viewListingDetail = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

      const {listingId} = request.data;
      if (!listingId || typeof listingId !== "string") {
        throw new HttpsError("invalid-argument", "listingId가 필요합니다.");
      }

      const COST = 50000;
      const userRef = db.collection("users").doc(uid);

      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      const userData = userSnap.data();
      if (userData.isBanned) throw new HttpsError("permission-denied", "정지된 계정입니다.");

      // 상세 열람 패스 보유 시 무료
      const hasPass = userData.detailViewPassExpiresAt && userData.detailViewPassExpiresAt > Date.now();
      let newBalance = userData.balance;
      if (!hasPass) {
        if ((userData.balance || 0) < COST) {
          throw new HttpsError(
              "failed-precondition",
              `잔액이 부족합니다. (필요: ${COST.toLocaleString()}G, 보유: ${(userData.balance || 0).toLocaleString()}G)`,
          );
        }
        await userRef.update({balance: FieldValue.increment(-COST)});
        newBalance = userData.balance - COST;
      }

      logger.info(`상세 열람: listingId=${listingId}, uid=${uid}, cost=${hasPass ? 0 : COST}G, pass=${hasPass}`);
      return {success: true, newBalance, passUsed: hasPass};
    },
);

// ============================================
// viewAuctionHistory: 경매 히스토리 열람 BM (50,000G)
// ============================================
exports.viewAuctionHistory = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

      const {listingId} = request.data;
      if (!listingId) throw new HttpsError("invalid-argument", "listingId가 필요합니다.");

      const COST = 50000;
      const userRef = db.collection("users").doc(uid);
      const listingRef = db.collection("listings").doc(listingId);

      const [listingSnap, userSnap] = await Promise.all([listingRef.get(), userRef.get()]);
      if (!listingSnap.exists) throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      const userData = userSnap.data();
      if (userData.isBanned) throw new HttpsError("permission-denied", "정지된 계정입니다.");

      // 히스토리 패스 보유 시 무료
      const hasPass = userData.historyViewPassExpiresAt && userData.historyViewPassExpiresAt > Date.now();
      let newBalance = userData.balance;
      if (!hasPass) {
        if ((userData.balance || 0) < COST) {
          throw new HttpsError(
              "failed-precondition",
              `잔액이 부족합니다. (필요: ${COST.toLocaleString()}G, 보유: ${(userData.balance || 0).toLocaleString()}G)`,
          );
        }
        await userRef.update({balance: FieldValue.increment(-COST)});
        newBalance = userData.balance - COST;
      }

      const historySnap = await db.collection("auctionHistory")
          .where("listingId", "==", listingId)
          .orderBy("endedAt", "desc")
          .get();

      const TYPE_LABEL = {new: "신규", holder: "보유자 승인", selloff: "손절"};
      const history = historySnap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          auctionId: d.auctionId,
          type: d.type,
          typeLabel: TYPE_LABEL[d.type] || d.type,
          startPrice: d.startPrice,
          finalPrice: d.finalPrice,
          isWon: d.isWon,
          bidCount: d.bidCount || 0,
          endedAt: d.endedAt?.toMillis?.() || null,
        };
      });

      const listing = listingSnap.data();
      logger.info(`히스토리 열람: listingId=${listingId}, uid=${uid}, cost=${hasPass ? 0 : COST}G, pass=${hasPass}`);
      return {
        cost: hasPass ? 0 : COST,
        newBalance,
        passUsed: hasPass,
        listing: {
          displayName: listing.displayName,
          soopId: listing.soopId,
        },
        history,
      };
    },
);

// ============================================
// updateUserNickname: 닉네임 변경
// ============================================
exports.updateUserNickname = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

      const uid = request.auth.uid;
      const {nickname} = request.data;

      if (typeof nickname !== "string") {
        throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
      }
      const trimmed = nickname.trim();
      if (trimmed.length < 2 || trimmed.length > 20) {
        throw new HttpsError("invalid-argument", "닉네임은 2~20자여야 합니다.");
      }
      // 이모지 및 특수문자 금지 (허용: 한글, 영문, 숫자, 공백, ._-)
      if (/[^\p{L}\p{N} ._-]/u.test(trimmed)) {
        throw new HttpsError("invalid-argument", "사용할 수 없는 문자가 포함되어 있습니다.");
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      const userData = userSnap.data();
      if (userData.isBanned) throw new HttpsError("permission-denied", "정지된 계정입니다.");

      await userRef.update({displayName: trimmed});
      logger.info(`닉네임 변경: uid=${uid}, nickname=${trimmed}`);
      return {success: true, displayName: trimmed};
    },
);

// ============================================
// purchaseShopItem: 상점 아이템 구매
// ============================================
const SHOP_ITEMS = {
  liquidation_extension: {
    name: "강제청산 기간 연장권",
    price: 100000,
    category: "protection",
    needsTarget: true,
  },
  immunity_extension: {
    name: "면역 연장권",
    price: 50000,
    category: "protection",
    needsTarget: true,
  },
  holding_limit_expansion: {
    name: "보유 한도 +1",
    price: 300000,
    category: "trade",
    googleOnly: true,
  },
  queue_priority_pass: {
    name: "대기열 우선권 패스 (30일)",
    price: 150000,
    category: "trade",
    passField: "queuePriorityPassExpiresAt",
  },
  detail_view_pass: {
    name: "상세 열람 패스 (30일)",
    price: 200000,
    category: "convenience",
    passField: "detailViewPassExpiresAt",
  },
  history_view_pass: {
    name: "히스토리 패스 (30일)",
    price: 200000,
    category: "convenience",
    passField: "historyViewPassExpiresAt",
  },
};
const PASS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

exports.purchaseShopItem = onCall(
    {region: "asia-northeast3"},
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      const uid = request.auth.uid;
      const {itemId, targetListingId} = request.data;

      const item = SHOP_ITEMS[itemId];
      if (!item) throw new HttpsError("not-found", "존재하지 않는 아이템입니다.");

      if (item.googleOnly && request.auth.token.firebase?.sign_in_provider !== "google.com") {
        throw new HttpsError("permission-denied", "Google 계정 전용 아이템입니다.");
      }
      if (item.needsTarget && !targetListingId) {
        throw new HttpsError("invalid-argument", "대상 매물을 선택해주세요.");
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      const user = userSnap.data();
      if (user.isBanned) throw new HttpsError("permission-denied", "정지된 계정입니다.");
      if ((user.balance || 0) < item.price) {
        throw new HttpsError(
            "failed-precondition",
            `잔액이 부족합니다. (필요: ${item.price.toLocaleString()}G, 보유: ${(user.balance || 0).toLocaleString()}G)`,
        );
      }

      const update = {balance: FieldValue.increment(-item.price)};

      if (itemId === "liquidation_extension") {
        const listingRef = db.collection("listings").doc(targetListingId);
        const listingSnap = await listingRef.get();
        if (!listingSnap.exists) throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
        if (listingSnap.data().ownerId !== uid) {
          throw new HttpsError("permission-denied", "내 매물만 사용 가능합니다.");
        }
        const reqId = listingSnap.data().pendingRequestId;
        if (!reqId) throw new HttpsError("failed-precondition", "대기 중인 경매 요청이 없습니다.");
        const reqSnap = await db.collection("auctionRequests").doc(reqId).get();
        if (!reqSnap.exists || reqSnap.data().status !== "pending") {
          throw new HttpsError("failed-precondition", "유효한 경매 요청이 없습니다.");
        }
        const newExpiresAt = (reqSnap.data().expiresAt || Date.now()) + 24 * 60 * 60 * 1000;
        await db.runTransaction(async (tx) => {
          tx.update(userRef, update);
          tx.update(reqSnap.ref, {expiresAt: newExpiresAt});
        });
        logger.info(`강제청산 기간 연장: uid=${uid}, listing=${targetListingId}, newExpiresAt=${newExpiresAt}`);
        return {success: true, newBalance: user.balance - item.price, newExpiresAt};
      }

      if (itemId === "immunity_extension") {
        const listingRef = db.collection("listings").doc(targetListingId);
        const listingSnap = await listingRef.get();
        if (!listingSnap.exists) throw new HttpsError("not-found", "매물을 찾을 수 없습니다.");
        const listing = listingSnap.data();
        if (listing.ownerId !== uid) throw new HttpsError("permission-denied", "내 매물만 사용 가능합니다.");
        if (!listing.immunityUntil || listing.immunityUntil < Date.now()) {
          throw new HttpsError("failed-precondition", "면역 기간이 활성화된 매물이 아닙니다.");
        }
        const newImmunityUntil = listing.immunityUntil + 24 * 60 * 60 * 1000;
        await db.runTransaction(async (tx) => {
          tx.update(userRef, update);
          tx.update(listingRef, {immunityUntil: newImmunityUntil});
        });
        logger.info(`면역 연장: uid=${uid}, listing=${targetListingId}, newImmunityUntil=${newImmunityUntil}`);
        return {success: true, newBalance: user.balance - item.price, newImmunityUntil};
      }

      if (itemId === "holding_limit_expansion") {
        update.ownedLimit = FieldValue.increment(1);
      }

      if (item.passField) {
        const now = Date.now();
        const current = user[item.passField] || 0;
        update[item.passField] = Math.max(current, now) + PASS_DURATION_MS;
      }

      await userRef.update(update);
      logger.info(`상점 구매: uid=${uid}, itemId=${itemId}, price=${item.price}G`);
      return {success: true, newBalance: user.balance - item.price};
    },
);
