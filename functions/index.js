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
// 헬퍼: 만료된 경매 요청 자동 처리
// ============================================
async function checkAndFinalizeExpiredRequests() {
  const now = Date.now();
  const expired = await db.collection("auctionRequests")
      .where("status", "==", "pending")
      .where("expiresAt", "<=", now)
      .get();

  if (expired.empty) return;

  const batch = db.batch();
  expired.docs.forEach((docSnap) => {
    const data = docSnap.data();
    batch.update(docSnap.ref, {
      status: "expired",
      respondedAt: FieldValue.serverTimestamp(),
    });
    const listingRef = db.collection("listings").doc(data.listingId);
    batch.update(listingRef, {pendingRequestId: null});
  });
  await batch.commit();
  logger.info(`만료된 경매 요청 ${expired.size}건 처리`);
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

  const isHolder = type === "holder";
  const isWon = bidCount > 0 && !!highestBidderId;
  const finalPrice = isWon ? currentPrice : startPrice;
  // Type A 유찰: 등록자 자동 낙찰 / Type B 유찰: 승자 없음
  const winnerId = isWon ? highestBidderId : (isHolder ? null : registeredBy);

  logger.info(`경매 정산: ${auctionId}, type=${type}, 낙찰=${isWon}, 낙찰자=${winnerId}, 가격=${finalPrice}`);

  const configSnap = await db.collection("system").doc("config").get();
  const config = configSnap.data();
  const batch = db.batch();

  const listingRef = db.collection("listings").doc(listingId);
  const listingSnap = await listingRef.get();
  const existingData = listingSnap.exists ? listingSnap.data() : {};
  const now = FieldValue.serverTimestamp();

  // 1. listings 업데이트
  if (isHolder) {
    if (isWon) {
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
      // 유찰: 소유권 유지, 면역 기간 24시간 설정
      batch.update(listingRef, {
        pendingRequestId: null,
        isLocked: false,
        immunityUntil: Date.now() + 24 * 60 * 60 * 1000,
      });
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
    if (isWon && sellerId) {
      // 낙찰: 판매자에게 낙찰가의 (1-FEE_RATE) 지급 + 소유 해제
      const sellerPayout = Math.floor(finalPrice * (1 - FEE_RATE));
      const sellerRef = db.collection("users").doc(sellerId);
      batch.update(sellerRef, {
        balance: FieldValue.increment(sellerPayout),
        ownedListingIds: FieldValue.arrayRemove(listingId),
        ownedCount: FieldValue.increment(-1),
      });
      logger.info(`판매자 정산: uid=${sellerId}, amount=${sellerPayout}`);
    }
    // 유찰: 잔액 변동 없음
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
      status: isWon ? "completed" : "failed",
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
    isWon,
    bidCount: bidCount || 0,
    startedAt: new Date(startedAt),
    endedAt: now,
    schemaVersion: 1,
  });

  // 6. 튜토리얼 보상 체크 (실제 입찰 낙찰만)
  if (isWon && highestBidderId) {
    const winnerRef = db.collection("users").doc(highestBidderId);
    const winnerSnap = await winnerRef.get();
    const winnerData = winnerSnap.data();
    if (winnerData && !winnerData.tutorialRewards?.firstPurchase) {
      const tutorialBonus = config.tutorialRewards?.firstPurchase || 10000;
      batch.update(winnerRef, {
        "balance": FieldValue.increment(tutorialBonus),
        "tutorialRewards.firstPurchase": true,
      });
      logger.info(`튜토리얼 보상 지급: ${highestBidderId}, ${tutorialBonus}G`);
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

  // 대기열 첫 번째 항목 가져오기 (key 기준 정렬)
  const keys = Object.keys(queue).sort();
  const nextKey = keys[0];
  const next = queue[nextKey];

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

      const {soopId, displayName, startPrice, profileImageUrl} = request.data;
      const uid = request.auth.uid;

      // 입력 검증
      if (!soopId || !/^[a-zA-Z0-9]+$/.test(soopId)) {
        throw new HttpsError("invalid-argument", "유효하지 않은 soop ID입니다.");
      }

      if (!displayName || typeof displayName !== "string") {
        throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
      }

      // 이모지 차단
      if (/\p{Extended_Pictographic}/u.test(displayName)) {
        throw new HttpsError("invalid-argument", "닉네임에 이모지를 사용할 수 없습니다.");
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

      // 이미 매물 있으면 등록 불가
      const listingId = soopId.toLowerCase();
      const existingListing = await db.collection("listings").doc(listingId).get();
      if (existingListing.exists && existingListing.data().ownerId) {
        throw new HttpsError(
            "already-exists",
            "이미 보유자가 있는 매물입니다.",
        );
      }

      // 보유자 없는 매물 여부 확인 (등록 시 최소 시세 차감 대상)
      const isNoHolder = !existingListing.exists || !existingListing.data().ownerId;

      // 최소 시세(basePrice) 로드
      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data();
      const basePrice = (config && config.basePrice) || 50000;

      // 보유자 없는 경매 등록 시 basePrice 차감을 위한 잔액 체크
      if (isNoHolder && userData.balance < basePrice) {
        throw new HttpsError(
            "failed-precondition",
            `잔액이 부족합니다. 보유자 없는 매물 등록에는 최소 시세 ${basePrice.toLocaleString()}G가 필요합니다. 현재 잔액: ${userData.balance.toLocaleString()}G`,
        );
      }

      // 대기열 크기 체크 (최대 5개)
      const queueSnap = await rtdb.ref("auction/queue").once("value");
      const queue = queueSnap.val() || {};
      const queueSize = Object.keys(queue).length;

      if (queueSize >= 5) {
        throw new HttpsError(
            "resource-exhausted",
            "대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요.",
        );
      }

      // 현재 경매에 이미 같은 매물이 있는지 체크
      const currentSnap = await rtdb.ref("auction/current").once("value");
      const current = currentSnap.val();
      if (current && current.status === "active" &&
          current.listingId === listingId) {
        throw new HttpsError(
            "already-exists",
            "해당 매물은 현재 경매 중입니다.",
        );
      }

      // 대기열에도 같은 매물 있는지 체크
      for (const key of Object.keys(queue)) {
        if (queue[key].listingId === listingId) {
          throw new HttpsError(
              "already-exists",
              "해당 매물은 이미 대기열에 있습니다.",
          );
        }
      }

      // 대기열에 추가
      const auctionId = db.collection("_").doc().id; // 유니크 ID 생성
      const newQueueItem = {
        auctionId,
        listingId,
        type: "new",
        soopId: soopId.toLowerCase(),
        displayName,
        profileImageUrl: profileImageUrl || null,
        registeredBy: uid,
        startPrice,
        queuedAt: Date.now(),
      };

      await rtdb.ref(`auction/queue/${auctionId}`).set(newQueueItem);

      // 유저 문서 업데이트: 보유자 없는 경우 잔액 차감 + 익명 쿨다운 기록
      const userUpdate = {};
      if (isNoHolder) {
        userUpdate.balance = FieldValue.increment(-basePrice);
      }
      if (userData.authType === "anonymous") {
        userUpdate.lastAuctionRegisteredAt = Date.now();
      }
      if (Object.keys(userUpdate).length > 0) {
        await userRef.update(userUpdate);
      }
      if (isNoHolder) {
        logger.info(`보유자 없는 경매 등록 차감: uid=${uid}, basePrice=${basePrice}`);
      }

      logger.info(`경매 등록: ${auctionId}, ${displayName}, 시작가=${startPrice}`);

      // 현재 경매가 없으면 즉시 시작
      if (!current || current.status !== "active") {
        await startNextFromQueue();
        return {
          success: true,
          auctionId,
          status: "started",
          message: "경매가 시작됐습니다!",
        };
      }

      return {
        success: true,
        auctionId,
        status: "queued",
        queuePosition: queueSize + 1,
        message: `대기열 ${queueSize + 1}번째에 등록됐습니다.`,
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
        queuedAt: Date.now(),
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
