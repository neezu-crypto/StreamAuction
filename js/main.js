// ============================================
// 메인 진입점
// 현재 단계: 인증 + Firestore 연결 테스트
// ============================================

import { db } from "./firebase-config.js";
import {
  loginAnonymous,
  loginGoogle,
  logout,
  watchAuthState,
  isAnonymousUser,
  isGoogleUser
} from "./auth.js";

import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// ===== DOM 요소 참조 =====
const $ = (id) => document.getElementById(id);
const authStatus = $("authStatus");
const userIdEl = $("userId");
const userTypeEl = $("userType");
const authArea = $("authArea");
const devLog = $("devLog");

const btnAnonymous = $("btnAnonymousLogin");
const btnGoogle = $("btnGoogleLogin");
const btnLogout = $("btnLogout");
const btnTestFirestore = $("btnTestFirestore");

// ===== 로그 헬퍼 =====
function log(message, isError = false) {
  const time = new Date().toLocaleTimeString("ko-KR");
  const prefix = isError ? "❌" : "✅";
  const newLine = `[${time}] ${prefix} ${message}\n`;
  devLog.textContent = newLine + devLog.textContent;
}

// ===== UI 갱신 =====
function updateUI(user) {
  if (user) {
    authStatus.textContent = "로그인됨";
    userIdEl.textContent = user.uid;

    const type = isAnonymousUser(user)
      ? "익명"
      : isGoogleUser(user)
        ? "Google"
        : "기타";
    userTypeEl.textContent = type;

    authArea.innerHTML = `
      <span>${type} 유저</span>
    `;

    // 버튼 상태
    btnAnonymous.disabled = true;
    btnGoogle.disabled = isGoogleUser(user);
    btnLogout.disabled = false;
  } else {
    authStatus.textContent = "로그아웃 상태";
    userIdEl.textContent = "-";
    userTypeEl.textContent = "-";
    authArea.innerHTML = `<span>로그인 필요</span>`;

    btnAnonymous.disabled = false;
    btnGoogle.disabled = false;
    btnLogout.disabled = true;
  }
}

// ===== 인증 상태 구독 =====
watchAuthState((user) => {
  updateUI(user);
  if (user) {
    log(`인증 상태 변경: ${user.uid.substring(0, 8)}... 로그인됨`);
  } else {
    log("인증 상태 변경: 로그아웃됨");
  }
});

// ===== 버튼 핸들러 =====
btnAnonymous.addEventListener("click", async () => {
  log("익명 로그인 시도...");
  try {
    await loginAnonymous();
    log("익명 로그인 성공");
  } catch (e) {
    log(`익명 로그인 실패: ${e.message}`, true);
  }
});

btnGoogle.addEventListener("click", async () => {
  log("Google 로그인 시도...");
  try {
    await loginGoogle();
    log("Google 로그인 성공");
  } catch (e) {
    log(`Google 로그인 실패: ${e.message}`, true);
  }
});

btnLogout.addEventListener("click", async () => {
  log("로그아웃 시도...");
  try {
    await logout();
    log("로그아웃 성공");
  } catch (e) {
    log(`로그아웃 실패: ${e.message}`, true);
  }
});

btnTestFirestore.addEventListener("click", async () => {
  log("Firestore 연결 테스트 (system/config 읽기)...");
  try {
    const configRef = doc(db, "system", "config");
    const configSnap = await getDoc(configRef);

    if (configSnap.exists()) {
      const data = configSnap.data();
      log(`Firestore 연결 성공! basePrice=${data.basePrice}, googleBonus=${data.googleBonus}`);
    } else {
      log("system/config 문서가 존재하지 않습니다", true);
    }
  } catch (e) {
    log(`Firestore 연결 실패: ${e.message}`, true);
  }
});

// ===== 초기 로그 =====
log("앱 초기화 완료. 로그인 또는 Firestore 테스트를 시작하세요.");
