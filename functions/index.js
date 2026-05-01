/**
 * StreamAuction Cloud Functions
 * MVP 개발 단계
 */

const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

// Firebase Admin 초기화 (Firestore 등 서버 SDK 사용)
const app = initializeApp();

// Firestore 인스턴스 (DB 이름 streamauction 명시)
const db = getFirestore(app, "streamauction");

// 글로벌 설정: 비용 통제를 위해 동시 실행 인스턴스 제한
setGlobalOptions({
  maxInstances: 10,
  region: "asia-northeast3", // 모든 함수의 기본 리전을 서울로
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
// 호출 시점: 클라이언트가 로그인 직후 호출
// 동작:
//   - users/{uid} 문서가 없으면 → 신규 가입 처리 + 보너스 지급
//   - 이미 있으면 → lastLoginAt만 갱신
//
// 응답:
//   - { isNewUser: true,  balance: 200000, authType: "anonymous", ... }
//   - { isNewUser: false, balance: 350000, authType: "google", ... }
//
// 보안:
//   - request.auth 에서 자동으로 유저 정보 가져옴 (위변조 불가)
//   - balance 등은 서버가 결정 (클라이언트 입력값 무시)
// ============================================
exports.initializeUser = onCall(
    {
      region: "asia-northeast3",
    },
    async (request) => {
      // 인증 체크
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "로그인이 필요합니다.",
        );
      }

      const uid = request.auth.uid;
      const authProvider = request.auth.token.firebase.sign_in_provider;
      // "anonymous" | "google.com" | ...

      const isAnonymous = authProvider === "anonymous";
      const authType = isAnonymous ? "anonymous" : "google";

      logger.info(`initializeUser 호출: uid=${uid}, authType=${authType}`);

      // 시스템 설정 가져오기
      const configSnap = await db.collection("system").doc("config").get();
      if (!configSnap.exists) {
        throw new HttpsError(
            "internal",
            "시스템 설정을 찾을 수 없습니다.",
        );
      }
      const config = configSnap.data();

      // 유저 문서 참조
      const userRef = db.collection("users").doc(uid);

      // 트랜잭션으로 안전하게 처리 (동시 호출 방어)
      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);

        // ===== 케이스 1: 기존 유저 =====
        if (userSnap.exists) {
          const userData = userSnap.data();

          // lastLoginAt 갱신
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

        // 토큰에서 추가 정보 가져오기 (Google 로그인 시)
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
