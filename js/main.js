// ============================================
// 메인 진입점
// 동작:
//   1. 페이지 로드 시 인증 상태 확인
//   2. 비로그인 → 자동 익명 로그인
//   3. 로그인 직후 → initializeUser 호출
//   4. 신규 유저면 환영 모달 표시
//   5. 익명 → Google 전환 시 자산 승계 + 보너스
// ============================================

import { auth, db, functions } from "./firebase-config.js";
import {
  loginAnonymous,
  loginGoogle,
  linkAnonymousToGoogle,
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
let currentUserData = null;
let isProcessingLogin = false;
let isConverting = false; // 전환 처리 중 플래그 (initializeUser 중복 호출 방지)

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

// ===== 화폐 표시 =====
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

// ===== 환영 모달 =====
function showWelcomeModal(userData, options = {}) {
  if (!welcomeModal) return;

  const { isConversion = false, conversionBonus = 0 } = options;

  if (isConversion) {
    // 익명 → Google 전환 성공
    welcomeTitle.textContent = "Google 계정 연동 완료! 🎉";
    welcomeMessage.innerHTML = `
      ${userData.displayName || "플레이어"}님, 환영합니다.<br>
      익명 자산이 그대로 유지되었고, 전환 보너스가 지급됐어요.
    `;
    welcomeBonus.textContent = formatG(userData.balance);
    welcomeAction.innerHTML = `
      <p class="welcome-tip">
        🎁 전환 보너스: <strong>+${formatG(conversionBonus)}</strong><br>
        🎮 보유 한도가 <strong>${userData.ownedLimit}개</strong>로 확장됐어요
      </p>
    `;
    btnWelcomeUpgrade.style.display = "none";
  } else if (userData.authType === "anonymous") {
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
  if (isProcessingLogin || isConverting) {
    log("이미 처리 중이라 건너뜀");
    return;
  }
  isProcessingLogin = true;

  try {
    log(`유저 초기화 시작: ${user.uid.substring(0, 8)}...`);
    updateUI(user, null);

    const initializeUser = httpsCallable(functions, "initializeUser");
    const result = await initializeUser();
    const userData = result.data;

    currentUserData = userData;
    log(`초기화 완료: ${userData.isNewUser ? "신규 가입" : "기존 유저"}, balance=${formatG(userData.balance)}`);

    updateUI(user, userData);

    if (userData.isNewUser) {
      log("환영 모달 표시 (신규 가입)");
      showWelcomeModal(userData);
    }
  } catch (error) {
    log(`유저 초기화 실패: ${error.message}`, true);
    console.error("initializeUser 에러:", error);
  } finally {
    isProcessingLogin = false;
  }
}

// ===== 익명 → Google 전환 =====
async function handleConvertToGoogle() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    log("로그인된 유저가 없습니다", true);
    return;
  }

  if (!currentUser.isAnonymous) {
    log("이미 Google 계정입니다");
    return;
  }

  isConverting = true;
  hideWelcomeModal();

  try {
    log("Google 계정 연결 시도...");

    // 1단계: 익명 계정에 Google 계정 연결
    const linkResult = await linkAnonymousToGoogle();

    if (linkResult.status === "linked") {
      // 자산 승계 케이스
      log("Google 계정 연결 성공, 서버에 전환 처리 요청...");

      // 2단계: Cloud Function으로 authType 변경 + 보너스 지급
      const convertFn = httpsCallable(functions, "convertAnonymousToGoogle");
      const result = await convertFn();
      const userData = result.data;

      log(`전환 완료! balance=${formatG(userData.balance)}, 보너스=+${formatG(userData.conversionBonus)}`);

      currentUserData = userData;
      updateUI(currentUser, userData);

      // 전환 환영 모달
      showWelcomeModal(userData, {
        isConversion: true,
        conversionBonus: userData.conversionBonus,
      });
    } else if (linkResult.status === "switched") {
      // 이미 사용 중인 Google 계정 → 단순 로그인 (익명 자산 폐기)
      log("이미 사용 중인 Google 계정으로 로그인됨 (이전 익명 자산은 폐기)");
      // watchAuthState가 다시 트리거되어 processUserLogin이 호출됨
      // 별도 처리 불필요
    }
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user") {
      log("Google 로그인 팝업 닫힘 (취소)");
    } else if (error.code === "auth/cancelled-popup-request") {
      log("팝업 요청 취소됨");
    } else {
      log(`Google 전환 실패: ${error.message}`, true);
      console.error(error);
    }
  } finally {
    isConverting = false;
  }
}

// ===== 인증 상태 구독 =====
watchAuthState(async (user) => {
  // 전환 처리 중이면 자동 처리 안 함 (handleConvertToGoogle이 직접 처리)
  if (isConverting) {
    log("전환 처리 중 (인증 상태 변경 무시)");
    return;
  }

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
  // 헤더의 Google 버튼은 익명 유저면 전환, 아니면 단순 로그인
  if (auth.currentUser && auth.currentUser.isAnonymous) {
    await handleConvertToGoogle();
  } else {
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
  }
});

btnLogout.addEventListener("click", async () => {
  log("로그아웃 시도...");
  try {
    await logout();
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

// 환영 모달 핸들러
if (btnWelcomeClose) {
  btnWelcomeClose.addEventListener("click", hideWelcomeModal);
}

if (btnWelcomeUpgrade) {
  btnWelcomeUpgrade.addEventListener("click", handleConvertToGoogle);
}

// ===== 초기 로그 =====
log("앱 초기화 완료");
