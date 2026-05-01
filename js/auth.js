// ============================================
// 인증 관련 로직
// ============================================

import {
  signInAnonymously,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  linkWithPopup
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

import { auth, googleProvider } from "./firebase-config.js";

/**
 * 익명 로그인
 */
export async function loginAnonymous() {
  try {
    const result = await signInAnonymously(auth);
    console.log("익명 로그인 성공:", result.user.uid);
    return result.user;
  } catch (error) {
    console.error("익명 로그인 실패:", error);
    throw error;
  }
}

/**
 * Google 로그인 (팝업 방식, 신규 또는 기존 Google 계정)
 */
export async function loginGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    console.log("Google 로그인 성공:", result.user.uid);
    return result.user;
  } catch (error) {
    console.error("Google 로그인 실패:", error);
    throw error;
  }
}

/**
 * 익명 계정을 Google 계정에 연결 (자산 승계)
 *
 * 결과 종류:
 *   - "linked": 익명 → Google 자산 승계 성공
 *   - "switched": Google 계정이 이미 사용 중 → 단순 로그인 (자산 폐기)
 *   - "error": 그 외 에러
 *
 * @returns {{ status: "linked"|"switched", user: User }}
 */
export async function linkAnonymousToGoogle() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error("로그인된 유저가 없습니다.");
  }

  if (!currentUser.isAnonymous) {
    throw new Error("익명 유저만 Google 계정에 연결할 수 있습니다.");
  }

  try {
    // 익명 계정을 Google 계정과 연결 시도
    const result = await linkWithPopup(currentUser, googleProvider);
    console.log("Google 계정 연결 성공 (자산 승계):", result.user.uid);
    return { status: "linked", user: result.user };
  } catch (error) {
    console.warn("Google 연결 실패:", error.code, error.message);

    // 케이스 1: 이미 다른 계정에서 사용 중인 Google 계정
    if (error.code === "auth/credential-already-in-use" ||
        error.code === "auth/email-already-in-use" ||
        error.code === "auth/account-exists-with-different-credential") {

      console.log("이미 사용 중인 Google 계정 → 단순 로그인으로 전환");

      // 익명 데이터는 폐기하고 기존 Google 계정으로 로그인
      // (이것도 어뷰징 방지: 익명 자산을 다른 계정에 합치지 않음)
      const result = await signInWithPopup(auth, googleProvider);
      console.log("기존 Google 계정으로 로그인:", result.user.uid);
      return { status: "switched", user: result.user };
    }

    // 케이스 2: 팝업 닫음 등
    throw error;
  }
}

/**
 * 로그아웃
 */
export async function logout() {
  try {
    await signOut(auth);
    console.log("로그아웃 완료");
  } catch (error) {
    console.error("로그아웃 실패:", error);
    throw error;
  }
}

/**
 * 인증 상태 변화 구독
 */
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * 현재 유저가 익명인지 확인
 */
export function isAnonymousUser(user) {
  return user && user.isAnonymous;
}

/**
 * 현재 유저가 Google 로그인 사용자인지 확인
 */
export function isGoogleUser(user) {
  if (!user) return false;
  return user.providerData.some(p => p.providerId === "google.com");
}
