// ============================================
// 인증 관련 로직 (익명 로그인 / Google 로그인)
// ============================================

import {
  signInAnonymously,
  signInWithPopup,
  signOut,
  onAuthStateChanged
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
 * Google 로그인 (팝업 방식)
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
 * @param {(user) => void} callback - 유저 객체 또는 null
 * @returns {() => void} 구독 해제 함수
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
