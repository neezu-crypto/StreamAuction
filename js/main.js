// ============================================
// 메인 진입점
// 동작:
//   1. 페이지 로드 시 인증 상태 확인
//   2. 비로그인 → 자동 익명 로그인
//   3. 로그인 직후 → initializeUser 호출
//   4. 신규 유저면 환영 모달 표시
// ============================================

import { auth, db, functions } from "./firebase-config.js";
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
import {
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";

// ===== DOM 요소 참조 =====
const $ = (id) => document.getElementById(id);

// 개발 패널
const authStatus = $("authStatus");
const userIdEl = $("userId");
const userTypeEl = $("userType");
const authArea = $("authArea");
const devLog = $("devLog");
const balanceEl = $("balance");

const btnAnonymous = $("btnAnonymousLogin");
const btnGoogle = $("btnGoogleLogin");
const btnLogout = $("btnLogout");
const btnTestFirestore = $("btnTestFirestore");

// 환영 모달
const welcomeModal = $("welcomeModal");
const welcomeTitle = $("welcomeTitle");
const welcomeMessage = $("welcomeMessage");
const welcomeBonus = $("welcomeBonus");
const welcomeAction = $("welcomeAction");
const btnWelcomeClose = $("btnWelcomeClose");
const btnWelcomeUpgrade = $("btnWelcomeUpgrade");

// ===== 상태 =====
let currentUserData = null; // 현재 유저 데이터 (initializeUser 결과)
let isProcessingLogin = false; // 중복 호출 방지

// ===== 로그 헬퍼 =====
function log(message, isError = false) {
  const time = new Date().toLocaleTimeString("ko-KR");
  const prefix = isError ? "❌" : "✅";
  const newLine = `[${time}] ${prefix} ${message}\n`;
  if (devLog) devLog.textContent = newLine + devLog.textContent;
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// ===== 화폐 표시 헬퍼 =====
function formatG(amount) {
  return amount.toLocaleString("ko-KR") + "G";
}

// ===== UI 갱신 =====
function updateUI(user, userData) {
  if (user && userData) {
    authStatus.textContent = "로그인됨";
    userIdEl.textContent = user.uid.substring(0, 12) + "...";
    userTypeEl.textContent = userData.authType === "anonymous" ? "익명 (체험판)" : "Google";
    if (balanceEl) balanceEl.textContent = formatG(userData.balance);

    const typeLabel = userData.authType === "anonymous" ? "익명 유저" : "Google 유저";
    authArea.innerHTML = `
      <span class="auth-info">
        <strong>${typeLabel}</strong> · ${formatG(userData.balance)}
      </span>
    `;

    btnAnonymous.disabled = true;
    btnGoogle.disabled = userData.authType === "google";
    btnLogout.disabled = false;
  } else if (user) {
    // 인증은 됐지만 userData 아직 안 받은 상태
    authStatus.textContent = "초기화 중...";
    userIdEl.textContent = user.uid.substring(0, 12) + "...";
    userTypeEl.textContent = "확인 중";
    if (balanceEl) balanceEl.textContent = "-";
    authArea.innerHTML = `<span class="loading">초기화 중...</span>`;
  } else {
    authStatus.textContent = "로그아웃 상태";
    userIdEl.textContent = "-";
    userTypeEl.textContent = "-";
    if (balanceEl) balanceEl.textContent = "-";
    authArea.innerHTML = `<span class="loading">로그인 중...</span>`;

    btnAnonymous.disabled = false;
    btnGoogle.disabled = false;
    btnLogout.disabled = true;
  }
}

// ===== 환영 모달 표시 =====
function showWelcomeModal(userData) {
  if (!welcomeModal) return;

  if (userData.authType === "anonymous") {
    welcomeTitle.textContent = "환영합니다! 🎉";
    welcomeMessage.innerHTML = `
      체험판 모드로 시작했어요. <br>
      매물 1개를 보유하고 거래를 경험해보세요.
    `;
    welcomeBonus.textContent = formatG(userData.balance);
    welcomeAction.innerHTML = `
      <p class="welcome-tip">
        💡 더 많은 매물을 보유하고 다른 유저와 거래하려면<br>
        <strong>Google 계정으로 전환</strong>하세요.
      </p>
    `;
    btnWelcomeUpgrade.style.display = "inline-block";
  } else {
    welcomeTitle.textContent = "StreamAuction에 오신 것을 환영합니다! 🎉";
    welcomeMessage.innerHTML = `
      ${userData.displayName || "플레이어"}님, 가입을 축하드려요.<br>
      스트리머 매물을 사고팔며 자산을 키워보세요!
    `;
    welcomeBonus.textContent = formatG(userData.balance);
    welcomeAction.innerHTML = `
      <p class="welcome-tip">
        🎮 최대 ${userData.ownedLimit}개 매물 보유 가능
      </p>
    `;
    btnWelcomeUpgrade.style.display = "none";
  }

  welcomeModal.classList.add("show");
}

function hideWelcomeModal() {
  if (welcomeModal) welcomeModal.classList.remove("show");
}

// ===== 핵심: 유저 초기화 =====
async function processUserLogin(user) {
  if (isProcessingLogin) {
    log("이미 처리 중...");
    return;
  }
  isProcessingLogin = true;

  try {
    log(`유저 초기화 시작: ${user.uid.substring(0, 8)}...`);
    updateUI(user, null);

    // Cloud Function 호출
    const initializeUser = httpsCallable(functions, "initializeUser");
    const result = await initializeUser();
    const userData = result.data;

    currentUserData = userData;
    log(`초기화 완료: ${userData.isNewUser ? "신규 가입" : "기존 유저"}, balance=${formatG(userData.balance)}`);

    // UI 갱신
    updateUI(user, userData);

    // 신규 유저면 환영 모달
    if (userData.isNewUser) {
      log("환영 모달 표시");
      showWelcomeModal(userData);
    }
  } catch (error) {
    log(`유저 초기화 실패: ${error.message}`, true);
    console.error("initializeUser 에러:", error);
  } finally {
    isProcessingLogin = false;
  }
}

// ===== 인증 상태 구독 =====
watchAuthState(async (user) => {
  if (user) {
    log(`인증 감지: ${user.uid.substring(0, 8)}...`);
    await processUserLogin(user);
  } else {
    log("인증 상태: 로그아웃");
    currentUserData = null;
    updateUI(null, null);

    // 자동 익명 로그인
    log("자동 익명 로그인 시도...");
    try {
      await loginAnonymous();
      // loginAnonymous 성공 시 watchAuthState가 다시 트리거됨
    } catch (e) {
      log(`자동 익명 로그인 실패: ${e.message}`, true);
    }
  }
});

// ===== 버튼 핸들러 =====
btnAnonymous.addEventListener("click", async () => {
  log("익명 로그인 시도...");
  try {
    await loginAnonymous();
  } catch (e) {
    log(`익명 로그인 실패: ${e.message}`, true);
  }
});

btnGoogle.addEventListener("click", async () => {
  log("Google 로그인 시도...");
  try {
    await loginGoogle();
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user") {
      log("로그인 팝업 닫힘 (취소)");
    } else {
      log(`Google 로그인 실패: ${e.message}`, true);
    }
  }
});

btnLogout.addEventListener("click", async () => {
  log("로그아웃 시도...");
  try {
    await logout();
    // 로그아웃 후 자동으로 익명 로그인됨 (watchAuthState 참고)
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
      log(`Firestore OK: basePrice=${data.basePrice}, googleBonus=${data.googleBonus}`);
    } else {
      log("system/config 문서가 존재하지 않습니다", true);
    }
  } catch (e) {
    log(`Firestore 연결 실패: ${e.message}`, true);
  }
});

// 환영 모달 닫기
if (btnWelcomeClose) {
  btnWelcomeClose.addEventListener("click", hideWelcomeModal);
}

// 환영 모달 → Google 전환 버튼
if (btnWelcomeUpgrade) {
  btnWelcomeUpgrade.addEventListener("click", async () => {
    hideWelcomeModal();
    log("Google 로그인으로 전환 시도...");
    try {
      await loginGoogle();
    } catch (e) {
      log(`Google 전환 실패: ${e.message}`, true);
    }
  });
}

// ===== 초기 로그 =====
log("앱 초기화 완료");
