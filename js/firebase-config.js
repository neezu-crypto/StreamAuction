// ============================================
// Firebase 설정 및 초기화
// ============================================
//
// 주의: 이 파일에 들어가는 apiKey 등은 클라이언트 공개 값입니다.
// 진짜 보안은 Firebase 콘솔의 "보안 규칙"과 Google Cloud의 "API 키 도메인 제한"에서 확보됩니다.
// 따라서 이 파일은 GitHub Public 레포에 올라가도 문제없습니다.
// ============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-analytics.js";

// Firebase 프로젝트 설정
const firebaseConfig = {
  apiKey: "AIzaSyCpnVq7UqSYmEQhUc5svtRBKH57A7JDhR4",
  authDomain: "streamauction-a0b39.firebaseapp.com",
  databaseURL: "https://streamauction-a0b39-default-rtdb.firebaseio.com",
  projectId: "streamauction-a0b39",
  storageBucket: "streamauction-a0b39.firebasestorage.app",
  messagingSenderId: "68551970742",
  appId: "1:68551970742:web:f91773280dd6d7bfb8bb17",
  measurementId: "G-FBDXMY5BGS"
};

// Firebase 초기화
const app = initializeApp(firebaseConfig);

// 서비스 인스턴스 export
export const auth = getAuth(app);

// Firestore: 영속 데이터 (유저, 매물, 신고, 히스토리)
export const db = getFirestore(app, "streamauction");

// Realtime Database: 실시간 데이터 (경매 진행, 입찰, 대기열)
export const rtdb = getDatabase(app);

// Cloud Functions: 서울 리전 명시 (함수와 일치해야 함)
export const functions = getFunctions(app, "asia-northeast3");

export const googleProvider = new GoogleAuthProvider();

// Analytics는 환경에 따라 실패할 수 있어 안전하게 처리
let analytics = null;
try {
  analytics = getAnalytics(app);
} catch (e) {
  console.warn("Analytics 초기화 건너뜀:", e.message);
}
export { analytics };

// 디버깅용
console.log("Firebase 초기화 완료:", firebaseConfig.projectId, "/ Firestore: streamauction / RTDB: connected / Region: asia-northeast3");
