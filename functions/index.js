/**
 * StreamAuction Cloud Functions
 * MVP 개발 단계
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
exports.initializeUser = onCall(
    {
      region: "asia-northeast3",
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "로그인이 필요합니다.",
        );
      }

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;
      const isAnonymous = authProvider === "anonymous";
      const authType = isAnonymous ? "anonymous" : "google";

      logger.info(`initializeUser: uid=${uid}, authType=${authType}`);

      // 시스템 설정 가져오기
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
          transaction.update(userRef, {
            lastLoginAt: FieldValue.serverTimestamp(),
          });

          logger.info(`기존 유저 로그인: uid=${uid}`);

          return {
            isNewUser: false,
            uid: uid,
            authType: userData.authType,
            balance: userData.balance,
            ownedCount: userData.ownedCount || 0,
            ownedLimit: userData.ownedLimit,
            displayName: userData.displayName || null,
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

          isBanned: false,
          banReason: null,

          schemaVersion: 1,
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
        };
      });

      return result;
    },
);


// ============================================
// convertAnonymousToGoogle: 익명 → Google 전환 처리
// ============================================
//
// 호출 시점: 클라이언트에서 linkWithCredential 성공 직후 호출
//
// 동작:
//   - 현재 유저가 anonymous였는데 google로 전환됐는지 확인
//   - users 문서의 authType, ownedLimit 등 갱신
//   - 전환 보너스 지급 (config.googleBonus - config.anonymousBonus)
//
// 보안:
//   - request.auth에서 직접 uid/authProvider 확인 (위변조 불가)
//   - 이미 전환된 계정은 거부 (중복 보너스 방지)
//   - authType 검증으로 잘못된 호출 차단
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

      // 현재 토큰이 google.com이어야 (linkWithCredential 후라야 정상)
      if (authProvider !== "google.com") {
        throw new HttpsError(
            "failed-precondition",
            "Google 로그인이 필요합니다.",
        );
      }

      // 시스템 설정
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

        // 이미 google 유저면 거부 (중복 보너스 방지)
        if (userData.authType === "google") {
          throw new HttpsError(
              "already-exists",
              "이미 Google 계정으로 전환된 유저입니다.",
          );
        }

        // 익명이 아니면 거부
        if (userData.authType !== "anonymous") {
          throw new HttpsError(
              "failed-precondition",
              "익명 계정만 전환 가능합니다.",
          );
        }

        // 전환 보너스 계산
        // 익명 200,000G + 보너스 800,000G = 총 1,000,000G 만큼 채워줌
        const conversionBonus = config.googleBonus - config.anonymousBonus;
        const newBalance = userData.balance + conversionBonus;

        // 토큰에서 Google 정보 가져오기
        const email = request.auth.token.email || userData.email;
        const displayName = request.auth.token.name || userData.displayName;
        const photoURL = request.auth.token.picture || userData.photoURL;

        // 업데이트
        transaction.update(userRef, {
          authType: "google",
          email: email,
          displayName: displayName,
          photoURL: photoURL,
          balance: newBalance,
          ownedLimit: config.googleOwnedLimit, // 1 → 5
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
