/**
 * StreamAuction Cloud Functions
 * MVP 개발 단계 - Step 1: 매물 시스템 기반 구축
 */

const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

// Firebase Admin 초기화
const app = initializeApp();
const db = getFirestore(app, "streamauction");

// 글로벌 설정
setGlobalOptions({
  maxInstances: 10,
  region: "asia-northeast3",
});


// ============================================
// helloWorld: 테스트용 함수
// ============================================
exports.helloWorld = onRequest(
    {
      region: "asia-northeast3",
      invoker: "public",
    },
    (request, response) => {
      logger.info("Hello logs!", {structuredData: true});
      response.send("Hello from StreamAuction Cloud Functions! 🎉");
    },
);


// ============================================
// initializeUser: 유저 가입 처리
// ============================================
//
// v2 변경사항:
// - blockedListingIds 필드 추가 (개인 차단 매물 목록)
// - onboardingStep 필드 추가 (튜토리얼 진행 단계)
// ============================================
exports.initializeUser = onCall(
    {
      region: "asia-northeast3",
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;
      const isAnonymous = authProvider === "anonymous";
      const authType = isAnonymous ? "anonymous" : "google";

      logger.info(`initializeUser: uid=${uid}, authType=${authType}`);

      const configSnap = await db.collection("system").doc("config").get();
      if (!configSnap.exists) {
        throw new HttpsError("internal", "시스템 설정을 찾을 수 없습니다.");
      }
      const config = configSnap.data();

      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);

        // ===== 케이스 1: 기존 유저 =====
        if (userSnap.exists) {
          const userData = userSnap.data();

          // 기존 유저 마이그레이션: blockedListingIds, onboardingStep 없으면 추가
          const updates = {
            lastLoginAt: FieldValue.serverTimestamp(),
          };
          if (userData.blockedListingIds === undefined) {
            updates.blockedListingIds = [];
          }
          if (userData.onboardingStep === undefined) {
            updates.onboardingStep = 4; // 기존 유저는 튜토리얼 완료 처리
          }

          transaction.update(userRef, updates);

          logger.info(`기존 유저 로그인: uid=${uid}`);

          return {
            isNewUser: false,
            uid: uid,
            authType: userData.authType,
            balance: userData.balance,
            ownedCount: userData.ownedCount || 0,
            ownedLimit: userData.ownedLimit,
            displayName: userData.displayName || null,
            blockedListingIds: userData.blockedListingIds || [],
            onboardingStep: userData.onboardingStep || 4,
          };
        }

        // ===== 케이스 2: 신규 유저 =====
        const balance = isAnonymous ?
          config.anonymousBonus :
          config.googleBonus;
        const ownedLimit = isAnonymous ?
          config.anonymousOwnedLimit :
          config.googleOwnedLimit;

        const email = request.auth.token.email || null;
        const displayName = request.auth.token.name || null;
        const photoURL = request.auth.token.picture || null;

        const newUser = {
          uid: uid,
          authType: authType,
          email: email,
          displayName: displayName,
          photoURL: photoURL,

          balance: balance,
          ownedListingIds: [],
          ownedCount: 0,
          ownedLimit: ownedLimit,

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

          // v2 신규 필드
          blockedListingIds: [], // 본인이 차단한 매물 ID 배열
          onboardingStep: 0, // 0: 시작, 1: 첫 검색, 2: 첫 구매, 3: 마이페이지, 4: 완료

          isBanned: false,
          banReason: null,

          schemaVersion: 2, // v1 → v2로 스키마 버전 갱신
        };

        transaction.set(userRef, newUser);

        logger.info(
            `신규 유저 가입: uid=${uid}, authType=${authType}, ` +
        `bonus=${balance}G`,
        );

        return {
          isNewUser: true,
          uid: uid,
          authType: authType,
          balance: balance,
          ownedCount: 0,
          ownedLimit: ownedLimit,
          displayName: displayName,
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
    {
      region: "asia-northeast3",
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
      }

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;

      logger.info(
          `convertAnonymousToGoogle: uid=${uid}, provider=${authProvider}`,
      );

      if (authProvider !== "google.com") {
        throw new HttpsError(
            "failed-precondition",
            "Google 로그인이 필요합니다.",
        );
      }

      const configSnap = await db.collection("system").doc("config").get();
      const config = configSnap.data();

      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);

        if (!userSnap.exists) {
          throw new HttpsError(
              "not-found",
              "유저 데이터를 찾을 수 없습니다.",
          );
        }

        const userData = userSnap.data();

        if (userData.authType === "google") {
          throw new HttpsError(
              "already-exists",
              "이미 Google 계정으로 전환된 유저입니다.",
          );
        }

        if (userData.authType !== "anonymous") {
          throw new HttpsError(
              "failed-precondition",
              "익명 계정만 전환 가능합니다.",
          );
        }

        const conversionBonus = config.googleBonus - config.anonymousBonus;
        const newBalance = userData.balance + conversionBonus;

        const email = request.auth.token.email || userData.email;
        const displayName = request.auth.token.name || userData.displayName;
        const photoURL = request.auth.token.picture || userData.photoURL;

        transaction.update(userRef, {
          authType: "google",
          email: email,
          displayName: displayName,
          photoURL: photoURL,
          balance: newBalance,
          ownedLimit: config.googleOwnedLimit,
          convertedAt: FieldValue.serverTimestamp(),
          lastLoginAt: FieldValue.serverTimestamp(),
        });

        logger.info(
            `Google 전환 완료: uid=${uid}, balance ${userData.balance}G ` +
        `→ ${newBalance}G (+${conversionBonus}G 보너스)`,
        );

        return {
          success: true,
          uid: uid,
          authType: "google",
          balance: newBalance,
          conversionBonus: conversionBonus,
          ownedCount: userData.ownedCount || 0,
          ownedLimit: config.googleOwnedLimit,
          displayName: displayName,
        };
      });

      return result;
    },
);


// ============================================
// 매물 시스템 함수 골격 (Step 2에서 구현)
// ============================================

// TODO: searchListing - 매물 검색 (닉네임 또는 ID로)
// TODO: createAndBuyListing - 신규 매물 등록 + 첫 구매 (5만G)
// TODO: blockListing - 매물 차단 (개인용)
// TODO: unblockListing - 매물 차단 해제
// TODO: reportListing - 매물 신고 (구글 유저만)
// TODO: updateOnboardingStep - 온보딩 단계 갱신
