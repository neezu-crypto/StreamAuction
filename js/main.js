// ============================================
// main.js - StreamAuction 메인 진입점
// 인증 + 경매 시스템 통합
// ============================================

import {auth, db, functions, rtdb} from "./firebase-config.js";
import {
  ref as dbRef, onValue as dbOnValue, set as dbSet, remove as dbRemove, onDisconnect,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";
import {
  doc, getDoc, collection, query, where, getDocs,
  addDoc, serverTimestamp, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {
  loginAnonymous, loginGoogle, linkAnonymousToGoogle,
  logout, watchAuthState,
} from "./auth.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";
import {
  subscribeAuction, unsubscribeAuction,
  searchListing, registerAuction, placeBid,
  requestAuction, respondToAuctionRequest,
  reportListing, blockListing, viewAuctionHistory, claimDailyReward,
  skipCooldown,
  formatG, formatTimeRemaining,
  validateSoopId, validateNickname,
  getSoopProfileUrl, loadInitialState,
} from "./auction.js";

// ===== DOM 참조 =====
const $ = (id) => document.getElementById(id);

// ===== 상태 =====
let currentUserData = null;
let currentAuction = null;
let isProcessingLogin = false;
let isConverting = false;
let isBidding = false;
let isRegistering = false;
let isSearching = false;
let pendingRegisterData = null;
let pendingReportListingId = null;
let pendingReportListingName = null;

// ===== 접속자 집계 / 접속 제한 =====
let isAccessGated = false;
let presenceUid = null;
let presenceConnectedUnsub = null;
let presenceVersion = 0;

function showAccessGateModal() {
  $("accessGateModal")?.classList.add("show");
}

function clearPresence() {
  if (presenceUid) dbRemove(dbRef(rtdb, `presence/${presenceUid}`));
  if (presenceConnectedUnsub) presenceConnectedUnsub();
  presenceUid = null;
  presenceConnectedUnsub = null;
  presenceVersion++;
}

function setupPresence(uid) {
  if (presenceUid === uid) return;
  clearPresence();
  presenceUid = uid;
  presenceVersion++;
  const myVersion = presenceVersion;
  presenceConnectedUnsub = dbOnValue(dbRef(rtdb, ".info/connected"), (snap) => {
    if (myVersion !== presenceVersion) return; // stale 콜백 무시
    if (snap.val() !== true) return;
    const presRef = dbRef(rtdb, `presence/${uid}`);
    onDisconnect(presRef).remove();
    dbSet(presRef, { t: Date.now() });
  });
}

function watchOnlineCount() {
  dbOnValue(dbRef(rtdb, "presence"), (snap) => {
    const count = snap.exists() ? snap.size : 0;
    const el = document.getElementById("onlineCount");
    if (el) el.textContent = `접속 중: ${count.toLocaleString("ko-KR")}명`;
    const banner = document.getElementById("bannerOnlineCount");
    if (banner) banner.textContent = count.toLocaleString("ko-KR");
  });
}

watchOnlineCount();

// ===== Cloud Functions =====
const initializeUserFn = httpsCallable(functions, "initializeUser");
const convertAnonymousToGoogleFn = httpsCallable(functions, "convertAnonymousToGoogle");
const endSessionFn = httpsCallable(functions, "endSession");
const getActiveAdsFn = httpsCallable(functions, "getActiveAds");
const purchaseAdFn = httpsCallable(functions, "purchaseAd");
const claimAdRewardFn = httpsCallable(functions, "claimAdReward");

// ===== 잔액 히스토리 기록 =====
async function recordBalanceHistory(uid, newBalance) {
  if (typeof newBalance !== "number") return;
  try {
    const histRef = collection(db, "users", uid, "balanceHistory");
    const lastSnap = await getDocs(query(histRef, orderBy("at", "desc"), limit(1)));
    const lastBalance = lastSnap.empty ? null : lastSnap.docs[0].data().balance;
    if (lastBalance === newBalance) return;
    await addDoc(histRef, {
      balance: newBalance,
      delta: lastBalance !== null ? newBalance - lastBalance : 0,
      at: serverTimestamp(),
    });
  } catch (e) {
    console.error("잔액 히스토리 기록 실패:", e);
  }
}

// ===== 로그 =====
function log(msg, isError = false) {
  const time = new Date().toLocaleTimeString("ko-KR");
  const line = `[${time}] ${isError ? "❌" : "✅"} ${msg}\n`;
  const devLog = $("devLog");
  if (devLog) devLog.textContent = line + devLog.textContent;
  isError ? console.error(msg) : console.log(msg);
}

// ===== UI 유틸 =====
function show(id) { const el = $(id); if (el) el.style.display = ""; }
function hide(id) { const el = $(id); if (el) el.style.display = "none"; }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

function formatRequestExpiry(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "⚠️ 기한 만료";
  const h = Math.floor(remaining / (1000 * 60 * 60));
  const m = Math.ceil((remaining % (1000 * 60 * 60)) / (1000 * 60));
  if (h > 0) return `⏱ ${h}시간 ${m}분 남음`;
  return `⏱ ${m}분 남음`;
}

// ===== 튜토리얼 섹션 렌더링 =====
// ===== 출석 보상 헬퍼 =====
function getKSTDateStr(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function calcNextMilestone(streak) {
  const milestones = [7, 14, 21, 28, 30, 37, 44, 51, 58, 60];
  for (const m of milestones) {
    if (streak < m) return m;
  }
  return Math.ceil((streak + 1) / 30) * 30;
}

function renderDailyRewardSection(userData) {
  const section = $("dailyRewardSection");
  if (!section) return;

  if (!userData) {
    section.innerHTML = "";
    return;
  }

  const isGoogle = userData.authType === "google";
  if (!isGoogle) {
    section.innerHTML = `
      <div class="daily-reward-card daily-reward-anonymous">
        <div class="daily-reward-icon">🗓️</div>
        <div>
          <div class="daily-reward-title">매일 출석 보상</div>
          <div class="daily-reward-sub">Google 계정으로 전환하면 매일 최대 <strong>10,000G+보너스</strong>를 받을 수 있어요!</div>
        </div>
      </div>`;
    return;
  }

  const streak = userData.consecutiveLoginDays || 0;
  const lastAtMs = userData.lastDailyRewardAt || null;
  const todayKST = getKSTDateStr(new Date());
  const lastKST = lastAtMs ? getKSTDateStr(new Date(lastAtMs)) : null;
  const claimedToday = lastKST === todayKST;

  const nextMilestone = calcNextMilestone(streak);
  const milestoneType = nextMilestone % 30 === 0 ? 30 : 7;
  const milestoneBonus = milestoneType === 30 ? 100000 : 30000;
  const daysLeft = nextMilestone - streak;

  const baseReward = streak < 2 ? 5000 : 10000;
  const todayIsSpecial = streak > 0 && (streak % 30 === 0 || streak % 7 === 0);

  // 7일 주기 진행바 (30일 달성 시 30 기준)
  const barTotal = milestoneType === 30 ? 30 : 7;
  const barFill = streak % barTotal;
  const barPct = Math.round((barFill / barTotal) * 100);

  const btnHtml = claimedToday
    ? `<div class="daily-claimed-badge">✅ 오늘 출석 완료</div>`
    : `<button class="btn-daily-claim" onclick="handleClaimDailyReward()">출석 체크하기</button>`;

  section.innerHTML = `
    <div class="daily-reward-card">
      <div class="daily-reward-top">
        <div class="daily-reward-streak">
          <span class="daily-streak-num">${streak}</span>
          <span class="daily-streak-label">일 연속</span>
        </div>
        <div class="daily-reward-info">
          <div class="daily-reward-title">오늘의 보상 <strong class="daily-reward-amount">${baseReward.toLocaleString()}G${todayIsSpecial && !claimedToday ? ` + ${milestoneBonus.toLocaleString()}G 보너스!` : ""}</strong></div>
          <div class="daily-reward-sub">${daysLeft}일 후 ${milestoneBonus.toLocaleString()}G 특별 보상 (${nextMilestone}일 달성)</div>
          <div class="daily-progress-bar">
            <div class="daily-progress-fill" style="width:${barPct}%"></div>
          </div>
          <div class="daily-progress-label">${barFill} / ${barTotal}일</div>
        </div>
        <div class="daily-reward-action">${btnHtml}</div>
      </div>
    </div>`;
}

const TUTORIAL_ITEMS = [
  {
    key: "firstTrade",
    title: "첫 경매 등록",
    desc: "스트리머를 검색해 경매를 등록해보세요",
    reward: 10000,
    cta: {label: "검색하기", fn: "focusSearch()"},
  },
  {
    key: "firstPurchase",
    title: "첫 낙찰",
    desc: "진행 중인 경매에 입찰해 낙찰을 받아보세요",
    reward: 30000,
    cta: null,
  },
  {
    key: "firstSelloff",
    title: "첫 손절 경매",
    desc: "보유 매물을 손절 경매로 등록해보세요",
    reward: 5000,
    cta: null,
  },
  {
    key: "firstForceLiquidation",
    title: "강제청산 보상",
    desc: "경매 요청에 24시간 미응답 시 자동 지급됩니다",
    reward: 10000,
    cta: null,
  },
];

function renderTutorialSection(userData) {
  const section = $("tutorialSection");
  if (!section) return;

  if (!userData) {
    section.innerHTML = "";
    return;
  }

  const rewards = userData.tutorialRewards || {};
  const doneItems = TUTORIAL_ITEMS.filter((it) => rewards[it.key]);
  const currentItem = TUTORIAL_ITEMS.find((it) => !rewards[it.key]);
  const doneCount = doneItems.length;
  const total = TUTORIAL_ITEMS.length;
  const allDone = doneCount === total;

  const doneChipsHtml = doneItems.length > 0 ? `
    <div class="tut-done-chips">
      ${doneItems.map((it) => `<span class="tut-step-chip">✅ ${it.title}</span>`).join("")}
    </div>` : "";

  let bodyHtml;
  if (allDone) {
    const totalReward = TUTORIAL_ITEMS.reduce((s, it) => s + it.reward, 0);
    bodyHtml = `
      <div class="tut-complete-card">
        <div class="tut-complete-icon">🎉</div>
        <div class="tut-complete-text">모든 튜토리얼 완료!</div>
        <div class="tut-complete-sub">총 ${totalReward.toLocaleString("ko-KR")}G 획득</div>
      </div>`;
  } else {
    const stepNum = doneCount + 1;
    const ctaHtml = currentItem.cta
      ? `<button class="tutorial-cta" onclick="${currentItem.cta.fn}">${currentItem.cta.label}</button>`
      : "";
    bodyHtml = `
      <div class="tut-current-card">
        <div class="tut-step-label">STEP ${stepNum} <span class="tut-step-total">/ ${total}</span></div>
        <div class="tut-current-title">${currentItem.title}</div>
        <div class="tut-current-desc">${currentItem.desc}</div>
        <div class="tut-current-footer">
          <span class="tut-current-reward">+${currentItem.reward.toLocaleString("ko-KR")}G</span>
          ${ctaHtml}
        </div>
      </div>`;
  }

  section.innerHTML = `
    <div class="tutorial-section-header">
      <h2 class="section-title">튜토리얼 보상</h2>
      <span class="tutorial-progress-badge${allDone ? " all-done" : ""}">${doneCount} / ${total}</span>
    </div>
    ${doneChipsHtml}
    ${bodyHtml}`;
}

// ===== 튜토리얼 토스트 =====
const TUTORIAL_REWARD_LABELS = {
  firstTrade: "첫 경매 등록",
  firstSelloff: "첫 손절 경매",
  firstPurchase: "첫 낙찰",
  firstForceLiquidation: "첫 강제청산",
};

function showTutorialToast(rewards) {
  const container = $("tutorialToastContainer");
  if (!container || !rewards) return;
  const list = Array.isArray(rewards) ? rewards : [rewards];
  list.forEach((reward, idx) => {
    setTimeout(() => {
      const label = TUTORIAL_REWARD_LABELS[reward.type] || reward.type;
      const toast = document.createElement("div");
      toast.className = "tutorial-toast";
      toast.innerHTML = `튜토리얼 달성! <strong>${label}</strong> · +<strong>${reward.amount.toLocaleString("ko-KR")}G</strong>`;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3100);
    }, idx * 400);
  });
}

// ===== 인증 UI 갱신 =====
function updateAuthUI(user, userData) {
  const authArea = $("authArea");
  if (!authArea) return;

  if (user && userData) {
    setText("authStatus", "로그인됨");
    setText("userId", user.uid.substring(0, 8) + "...");
    setText("userType", userData.authType === "anonymous" ? "익명" : "Google");
    setText("balance", formatG(userData.balance));

    const typeLabel = userData.authType === "anonymous" ? "익명 유저" : "Google 유저";
    authArea.innerHTML = `
      <a href="ranking.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px;transition:color .15s"
        onmouseover="this.style.color='#e8e8e8'" onmouseout="this.style.color='#9ba3b4'">📊 랭킹</a>
      <a href="shop.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px;transition:color .15s"
        onmouseover="this.style.color='#e8e8e8'" onmouseout="this.style.color='#9ba3b4'">🛒 상점</a>
      <a href="my.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px;transition:color .15s"
        onmouseover="this.style.color='#e8e8e8'" onmouseout="this.style.color='#9ba3b4'">마이페이지</a>
      <span style="font-size:.85rem;color:#9ba3b4">
        <strong style="color:#f5d142">${typeLabel}</strong>
        · ${formatG(userData.balance)}
      </span>
      ${userData.authType === "anonymous"
        ? `<button onclick="handleGoogleLogin()" class="btn-primary" style="font-size:.82rem;padding:5px 12px">Google 로그인</button>`
        : `<button onclick="handleLogout()" class="btn-logout-header">로그아웃</button>`}
    `;
  } else {
    setText("authStatus", "-");
    setText("userId", "-");
    setText("userType", "-");
    setText("balance", "-");
    authArea.innerHTML = `<span style="color:#6b7280;font-size:.85rem">로그인 중...</span>`;
  }
}

// ===== 내 보유 매물 실시간 구독 =====
let holdingsUnsub = null;

function watchMyHoldings(uid) {
  if (holdingsUnsub) { holdingsUnsub(); holdingsUnsub = null; }
  if (!uid) { loadMyHoldings(null); return; }
  let prevIdsJson = null;
  holdingsUnsub = onSnapshot(doc(db, "users", uid), (snap) => {
    if (!snap.exists()) return;
    const ids = snap.data().ownedListingIds || [];
    const idsJson = JSON.stringify([...ids].sort());
    if (idsJson === prevIdsJson) return;
    prevIdsJson = idsJson;
    loadMyHoldings(uid);
  });
}

// ===== 내 보유 매물 로드 =====
async function loadMyHoldings(uid) {
  const section = $("holdingsSection");
  const list = $("holdingsList");
  if (!section || !list) return;

  if (!uid) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";

  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    if (!userSnap.exists()) return;

    const userData = userSnap.data();
    const ids = userData.ownedListingIds || [];
    const limit = userData.ownedLimit || 0;

    setText("holdingsCount", `${ids.length} / ${limit}`);

    if (ids.length === 0) {
      list.innerHTML = `<div class="holdings-empty">보유 중인 매물이 없어요</div>`;
      return;
    }

    // 내 매물에 대한 대기 중인 경매 요청 조회
    const reqQuery = query(
        collection(db, "auctionRequests"),
        where("ownerId", "==", uid),
        where("status", "==", "pending"),
    );
    const reqSnap = await getDocs(reqQuery);
    const pendingByListing = {};
    reqSnap.forEach((d) => {
      pendingByListing[d.data().listingId] = d.data();
    });

    const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, "listings", id))));
    list.innerHTML = snaps.map((snap) => {
      if (!snap.exists()) return "";
      const d = snap.data();
      const listingId = snap.id;
      const img = d.profileImageUrl || "assets/images/default-avatar.svg";
      const pending = pendingByListing[listingId];

      const isUrgent = pending && (pending.expiresAt - Date.now()) < 2 * 60 * 60 * 1000;
      const requestBanner = pending ? `
        <div class="holding-request-banner${isUrgent ? " is-urgent" : ""}">
          <div class="request-badge-row">
            <span class="request-badge">📨 경매 요청 대기 중</span>
            <span class="request-expires">${formatRequestExpiry(pending.expiresAt)}</span>
          </div>
          <div class="request-warning">
            ⚠️ 제한시간 내 미회신 시 <strong>강제청산</strong> — 매물 소유권 박탈, 현재 시세가 잔액으로 환급됩니다
          </div>
          <div class="request-actions">
            <button class="btn-approve" onclick="event.stopPropagation();handleApproveRequest('${pending.requestId}')">승인</button>
            <button class="btn-reject" onclick="event.stopPropagation();handleRejectRequest('${pending.requestId}')">거부</button>
          </div>
        </div>` : "";

      const selloffBtn = !d.isLocked ? `
        <button class="btn-selloff btn-selloff--small"
          onclick="event.stopPropagation();openRegisterModal('${d.soopId}','${escapeHtml(d.displayName)}',true,${d.currentPrice||50000})">
          손절 등록
        </button>` : `<span class="request-status-badge">경매 진행 중</span>`;

      return `
        <div class="holding-card${pending ? " holding-card--has-request" : ""}${isUrgent ? " is-urgent-card" : ""}" onclick="searchByHolding('${d.soopId}')">
          <img class="holding-img" src="${img}"
            onerror="this.src='assets/images/default-avatar.svg'" alt="프로필">
          <div class="holding-info">
            <div class="holding-name">${d.displayName}</div>
            <div class="holding-id">${d.soopId}</div>
          </div>
          <div class="holding-price">
            <div class="holding-price-label">현재 시세</div>
            <div class="holding-price-value">${formatG(d.currentPrice)}</div>
            ${selloffBtn}
          </div>
          ${requestBanner}
        </div>`;
    }).join("");
  } catch (e) {
    log(`보유 매물 로드 실패: ${e.message}`, true);
  }
}

// ===== 유저 초기화 =====
async function processUserLogin(user) {
  if (isProcessingLogin) return;
  isProcessingLogin = true;

  try {
    log(`유저 초기화: ${user.uid.substring(0, 8)}...`);
    updateAuthUI(user, null);

    // initializeUserFn의 stale session 정리가 정확히 동작하도록
    // CF 호출 전에 이전 유저 presence를 먼저 제거
    if (presenceUid && presenceUid !== user.uid) {
      clearPresence();
    }

    let result;
    try {
      result = await initializeUserFn();
    } catch (e) {
      // 서버사이드 접속 제한 — 클라이언트 위변조로 우회 불가
      if (e.code === "functions/resource-exhausted") {
        isAccessGated = true;
        showAccessGateModal();
        log(`접속 제한: 최대 인원 초과`, true);
        return;
      }
      throw e;
    }

    const userData = result.data;
    currentUserData = userData;
    recordBalanceHistory(user.uid, userData.balance);

    log(`초기화 완료: ${userData.isNewUser ? "신규" : "기존"}, ${formatG(userData.balance)}`);
    updateAuthUI(user, userData);

    if (userData.isNewUser) {
      showWelcomeModal(userData);
    }

    // 보유 매물 실시간 구독
    watchMyHoldings(user.uid);

    // 보상 센터 렌더링 (모달 내부)
    renderDailyRewardSection(userData);
    renderTutorialSection(userData);
    updateRewardBtn(userData);

    // 입찰 UI 갱신
    updateBidUI();

    // 접속자 집계
    setupPresence(user.uid);

    // 초기 경매 상태 로드 (만료 경매 정산 트리거 포함)
    loadInitialState().catch((e) => log(`초기 상태 로드 실패: ${e.message}`, true));
  } catch (e) {
    log(`초기화 실패: ${e.message}`, true);
  } finally {
    isProcessingLogin = false;
  }
}

// ===== 인증 상태 구독 =====
watchAuthState(async (user) => {
  if (isConverting) return;

  if (user) {
    log(`인증 감지: ${user.uid.substring(0, 8)}...`);
    await processUserLogin(user);
  } else {
    log("로그아웃 상태, 자동 익명 로그인...");
    currentUserData = null;
    updateAuthUI(null, null);
    watchMyHoldings(null);
    renderDailyRewardSection(null);
    renderTutorialSection(null);
    updateRewardBtn(null);
    try {
      await loginAnonymous();
    } catch (e) {
      log(`익명 로그인 실패: ${e.message}`, true);
    }
  }
});

// ===== Google 전환 =====
async function handleConvertToGoogle() {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.isAnonymous) return;

  isConverting = true;
  hideWelcomeModal();

  try {
    log("Google 계정 연결 시도...");
    const linkResult = await linkAnonymousToGoogle();

    if (linkResult.status === "linked") {
      log("연결 성공, 서버에 전환 요청...");
      const result = await convertAnonymousToGoogleFn();
      const userData = result.data;
      currentUserData = userData;
      updateAuthUI(currentUser, userData);
      showWelcomeModal(userData, {isConversion: true, conversionBonus: userData.conversionBonus});
    } else {
      isConverting = false;
      await processUserLogin(linkResult.user);
    }
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") {
      log(`전환 실패: ${e.message}`, true);
    }
  } finally {
    isConverting = false;
  }
}

// ===== 환영 모달 =====
function showWelcomeModal(userData, options = {}) {
  const {isConversion = false, conversionBonus = 0} = options;
  const modal = $("welcomeModal");
  if (!modal) return;

  if (isConversion) {
    setText("welcomeTitle", "Google 연동 완료! 🎉");
    $("welcomeMessage").innerHTML = `자산이 승계됐고, 전환 보너스가 지급됐어요.`;
    setText("welcomeBonus", formatG(userData.balance));
    $("welcomeAction").innerHTML = `<p class="welcome-tip">🎁 전환 보너스: <strong>+${formatG(conversionBonus)}</strong><br>🎮 보유 한도 <strong>${userData.ownedLimit}개</strong>로 확장</p>`;
    hide("btnWelcomeUpgrade");
  } else if (userData.authType === "anonymous") {
    setText("welcomeTitle", "환영합니다! 🎉");
    $("welcomeMessage").innerHTML = `체험판 모드로 시작했어요.<br>경매에 참여해보세요!`;
    setText("welcomeBonus", formatG(userData.balance));
    $("welcomeAction").innerHTML = `<p class="welcome-tip">💡 Google 계정으로 전환 시 <strong>800,000G 보너스</strong> + 보유 한도 5개</p>`;
    show("btnWelcomeUpgrade");
  } else {
    setText("welcomeTitle", "StreamAuction에 오신 것을 환영합니다! 🎉");
    $("welcomeMessage").innerHTML = `${userData.displayName || "플레이어"}님, 스트리머 경매에 참여해보세요!`;
    setText("welcomeBonus", formatG(userData.balance));
    $("welcomeAction").innerHTML = `<p class="welcome-tip">🎮 최대 ${userData.ownedLimit}개 매물 보유 가능</p>`;
    hide("btnWelcomeUpgrade");
  }

  modal.classList.add("show");
}

function hideWelcomeModal() {
  const modal = $("welcomeModal");
  if (modal) modal.classList.remove("show");
}

// ===== 경매 UI 갱신 =====
function onAuctionUpdate(auction) {
  currentAuction = auction;

  const empty = $("auctionEmpty");
  const card = $("auctionCard");
  const completed = $("auctionCompleted");

  if (!auction) {
    // 경매 없음
    if (empty) empty.style.display = "";
    if (card) card.style.display = "none";
    if (completed) completed.style.display = "none";
    return;
  }

  if (auction.status === "completed" || auction.status === "cooldown") {
    if (empty) empty.style.display = "none";
    if (card) card.style.display = "none";
    if (completed) completed.style.display = "";
    const info = $("completedInfo");
    if (info) {
      const winner = auction.winnerId ?
        auction.winnerId.substring(0, 4) + "***" : "유찰";
      info.textContent = `${formatG(auction.finalPrice)}에 낙찰 · 낙찰자: ${winner}`;
    }
    const countdown = $("completedCountdown");
    if (countdown) {
      countdown.textContent = auction.status === "cooldown"
        ? "다음 경매 준비 중..."
        : "잠시 후 다음 경매가 시작됩니다...";
    }
    const skipBtn = $("btnSkipCooldown");
    if (skipBtn) {
      skipBtn.style.display = (auction.status === "cooldown" && currentUserData) ? "" : "none";
    }
    setText("skipCooldownError", "");
    return;
  }

  if (auction.status === "active") {
    // 경매 진행 중
    if (empty) empty.style.display = "none";
    if (completed) completed.style.display = "none";
    if (card) card.style.display = "";

    // 프로필 이미지
    const img = $("auctionProfileImg");
    if (img) {
      if (auction.profileImageUrl) {
        img.src = auction.profileImageUrl;
      } else {
        img.src = "assets/images/default-avatar.svg";
      }
    }

    setText("auctionName", auction.displayName || "-");
    setText("auctionId", auction.soopId || "-");
    setText("auctionCurrentPrice", formatG(auction.currentPrice));
    setText("auctionBidCount", (auction.bidCount || 0) + "회");

    updateBidUI();
  }
}

function onQueueUpdate(queue) {
  const section = $("queueSection");
  const list = $("queueList");
  if (!section || !list) return;

  if (!queue || queue.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  list.innerHTML = queue.map((item, i) => `
    <div class="queue-item${item.isPriority ? " queue-item--priority" : ""}">
      <div class="queue-item-left">
        <span class="queue-number">${i + 1}</span>
        <div>
          <div class="queue-name">
            ${escapeHtml(item.displayName)}
            ${item.isPriority ? `<span class="queue-priority-badge">⚡ 우선</span>` : ""}
          </div>
          <div class="queue-id">${item.soopId}</div>
        </div>
      </div>
      <div class="queue-price">시작가 ${formatG(item.startPrice)}</div>
    </div>
  `).join("");
}

function onBidsUpdate(bids) {
  const list = $("bidsList");
  if (!list) return;

  if (!bids || bids.length === 0) {
    list.innerHTML = `<div class="bids-empty">입찰이 없습니다</div>`;
    return;
  }

  list.innerHTML = bids.map((bid, i) => `
    <div class="bid-item">
      <span class="bid-item-name">${escapeHtml(bid.bidderName || "익명")}</span>
      <div>
        <span class="bid-item-amount">${formatG(bid.amount)}</span>
        <span class="bid-item-time">${formatBidTime(bid.bidAt)}</span>
      </div>
    </div>
  `).join("");
}

function onTimer(ms) {
  if (currentAuction?.status === "cooldown") {
    const countdown = $("completedCountdown");
    if (countdown && ms !== null) {
      countdown.textContent = ms <= 0
        ? "다음 경매를 준비하는 중..."
        : `다음 경매까지 ${formatTimeRemaining(ms)}`;
    }
    return;
  }

  const timerEl = $("auctionTimer");
  if (!timerEl) return;

  const formatted = formatTimeRemaining(ms);
  timerEl.textContent = formatted;

  // 30초 이하일 때 긴급 표시
  if (ms !== null && ms <= 30000) {
    timerEl.classList.add("urgent");
  } else {
    timerEl.classList.remove("urgent");
  }
}

// ===== 입찰 UI 갱신 =====
function updateBidUI() {
  const bidSection = $("bidSection");
  const bidInput = $("bidInput");
  const bidHint = $("bidHint");

  if (!bidSection) return;

  if (!currentAuction || currentAuction.status !== "active") {
    bidSection.style.display = "none";
    return;
  }

  bidSection.style.display = "";

  const minBid = (currentAuction.currentPrice || 50000) + 10000;
  if (bidInput) {
    bidInput.min = minBid;
    bidInput.placeholder = `${minBid.toLocaleString()}G 이상`;
  }
  if (bidHint) {
    bidHint.textContent = `최소 입찰가: ${formatG(minBid)}`;
  }

  // 자기 매물이면 입찰 불가 (ownerCheck는 서버에서도 하지만 UI에서도)
  const isOwnAuction = currentAuction.registeredBy === auth.currentUser?.uid;
  const bidBtn = $("bidBtn");
  if (bidBtn) {
    if (isOwnAuction) {
      bidBtn.disabled = true;
      bidBtn.textContent = "본인 등록 경매";
    } else {
      bidBtn.disabled = false;
      bidBtn.textContent = "입찰하기";
    }
  }
}

// ===== 빠른 입찰 버튼 =====
window.setQuickBid = function(multiplier) {
  const input = $("bidInput");
  if (!input || !currentAuction) return;
  const current = currentAuction.currentPrice || 50000;
  const amount = current + (multiplier * 10000);
  input.value = amount;
};

// ===== 입찰 처리 =====
window.handleBid = async function() {
  if (isBidding) return;

  const bidError = $("bidError");
  if (bidError) bidError.style.display = "none";

  const input = $("bidInput");
  const amount = parseInt(input?.value || 0);

  if (!amount || amount <= 0) {
    showBidError("입찰가를 입력해주세요.");
    return;
  }

  if (!currentAuction) {
    showBidError("진행 중인 경매가 없습니다.");
    return;
  }

  const minBid = currentAuction.currentPrice + 10000;
  if (amount < minBid) {
    showBidError(`최소 ${formatG(minBid)} 이상 입찰해주세요.`);
    return;
  }

  if (currentUserData && currentUserData.balance < amount) {
    showBidError(`잔액이 부족합니다. 현재 잔액: ${formatG(currentUserData.balance)}`);
    return;
  }

  isBidding = true;
  const bidBtn = $("bidBtn");
  if (bidBtn) {
    bidBtn.disabled = true;
    bidBtn.textContent = "입찰 처리 중...";
  }

  try {
    const result = await placeBid(amount);
    log(`입찰 성공: ${formatG(amount)} · ${result.message}`);

    // 잔액 차감 반영 (서버에서 실제 처리됐지만 UI 즉시 반영)
    if (currentUserData) {
      currentUserData.balance -= amount;
      updateAuthUI(auth.currentUser, currentUserData);
    }

    if (input) input.value = "";
    if (result.isExtended) {
      log("스나이핑 방지: 15초 연장!");
    }
  } catch (e) {
    log(`입찰 실패: ${e.message}`, true);
    showBidError(e.message || "입찰에 실패했습니다.");
    // 잔액 복원
    if (currentUserData) {
      try {
        const r = await initializeUserFn();
        currentUserData = r.data;
        updateAuthUI(auth.currentUser, currentUserData);
      } catch (_) {}
    }
  } finally {
    isBidding = false;
    if (bidBtn) {
      bidBtn.disabled = false;
      bidBtn.textContent = "입찰하기";
    }
  }
};

function showBidError(msg) {
  const el = $("bidError");
  if (el) {
    el.textContent = msg;
    el.style.display = "";
  }
}

// ===== 검색 처리 =====
window.handleSearch = async function() {
  if (isSearching) return;

  const input = $("searchInput");
  const query = input?.value?.trim();
  if (!query) return;

  isSearching = true;
  const searchBtn = $("searchBtn");
  if (searchBtn) {
    searchBtn.disabled = true;
    searchBtn.textContent = "검색 중...";
  }

  const resultDiv = $("searchResult");
  if (resultDiv) {
    resultDiv.style.display = "";
    resultDiv.innerHTML = `<div style="padding:20px;text-align:center;color:#9ba3b4">검색 중...</div>`;
  }

  try {
    const result = await searchListing(query);

    if (result.found) {
      showSearchFoundResult(result.listing, query);
    } else {
      showSearchNewListing(query, result.isIdSearch);
    }
  } catch (e) {
    log(`검색 실패: ${e.message}`, true);
    if (resultDiv) {
      resultDiv.innerHTML = `<div style="padding:20px;text-align:center;color:#f87171">검색 오류: ${escapeHtml(e.message)}</div>`;
    }
  } finally {
    isSearching = false;
    if (searchBtn) {
      searchBtn.disabled = false;
      searchBtn.textContent = "검색";
    }
  }
};

function showSearchFoundResult(listing, query) {
  const resultDiv = $("searchResult");
  if (!resultDiv) return;

  // 차단된 매물이면 블러 화면
  const isBlocked = (currentUserData?.blockedListingIds || []).includes(listing.listingId);
  if (isBlocked) {
    resultDiv.innerHTML = `
      <div class="search-result-blocked">
        <div class="blocked-icon">🚫</div>
        <div class="blocked-msg">차단한 매물입니다</div>
        <div class="blocked-name">${escapeHtml(listing.displayName)}</div>
        <button class="btn-secondary" onclick="handleBlockListing('${escapeHtml(listing.listingId)}', false)">차단 해제</button>
      </div>`;
    return;
  }

  const ownerText = listing.isOwnedByMe ?
    "내 매물" : (listing.ownerId ? "보유자 있음" : "주인 없음");

  const isAnonymous = currentUserData?.authType === "anonymous";
  let requestBtn = "";
  if (!listing.isOwnedByMe && listing.ownerId) {
    if (isAnonymous) {
      requestBtn = `<span class="request-status-badge">경매 요청은 Google 계정만 가능합니다</span>`;
    } else if (listing.pendingRequestId) {
      requestBtn = `<span class="request-status-badge">요청 접수됨 · 보유자 응답 대기 중</span>`;
    } else if (listing.immunityUntil && Date.now() < listing.immunityUntil) {
      const mins = Math.ceil((listing.immunityUntil - Date.now()) / 60000);
      requestBtn = `<span class="request-status-badge immunity">유찰 면역 중 (${mins}분 후 요청 가능)</span>`;
    } else {
      requestBtn = `
        <button class="btn-request" onclick="handleRequestAuction('${escapeHtml(listing.listingId)}')">
          경매 요청 보내기
        </button>`;
    }
  }

  // 모자이크 여부에 따라 이미지 처리
  const imgClass = listing.isMosaicked ? "search-profile-img img-mosaic" : "search-profile-img";
  const imgSrc = listing.profileImageUrl || "";

  // 신고/차단 버튼 (임시 숨김)
  const reportBlockHtml = "";

  resultDiv.innerHTML = `
    <div class="search-result-found">
      <div class="search-listing-profile">
        <div class="search-profile-wrap">
          <img class="${imgClass}"
            src="${imgSrc}"
            onerror="this.src='assets/images/default-avatar.svg'"
            alt="프로필">
          ${listing.isMosaicked ? `<div class="mosaic-label">신고됨</div>` : ""}
        </div>
        <div>
          <div class="search-listing-name">${escapeHtml(listing.displayName)}</div>
          <div class="search-listing-id">${escapeHtml(listing.soopId)}</div>
        </div>
      </div>

      <div class="search-listing-stats">
        <div class="search-stat">
          <div class="search-stat-label">현재 시세</div>
          <div class="search-stat-value">${formatG(listing.currentPrice)}</div>
        </div>
        <div class="search-stat">
          <div class="search-stat-label">보유 현황</div>
          <div class="search-stat-value">${ownerText}</div>
        </div>
        <div class="search-stat">
          <div class="search-stat-label">거래 횟수</div>
          <div class="search-stat-value">${listing.totalTradeCount}회</div>
        </div>
      </div>

      <div class="search-actions">
        ${!listing.isOwnedByMe && !listing.ownerId ? `
          <button class="btn-primary" onclick="openRegisterModal('${escapeHtml(listing.soopId)}', '${escapeHtml(listing.displayName)}')">
            경매 등록
          </button>` : ""}
        ${listing.isOwnedByMe ? `
          <button class="btn-selloff" onclick="openRegisterModal('${escapeHtml(listing.soopId)}', '${escapeHtml(listing.displayName)}', true, ${listing.currentPrice || 50000})">
            손절 경매 등록
          </button>` : ""}
        ${requestBtn}
      </div>
      <div class="search-detail-history-row">
        <a class="btn-detail" href="listing.html?id=${escapeHtml(listing.listingId)}">상세 페이지 <span class="detail-cost">50,000G</span></a>
        <button class="btn-history" onclick="handleViewHistory('${escapeHtml(listing.listingId)}', '${escapeHtml(listing.displayName)}')">
          경매 히스토리 열람 <span class="history-cost">50,000G</span>
        </button>
      </div>
      ${reportBlockHtml}
    </div>
  `;
}

function showSearchNewListing(query, isIdSearch) {
  const resultDiv = $("searchResult");
  if (!resultDiv) return;

  const typeText = isIdSearch ? "ID" : "닉네임";
  const previewUrl = isIdSearch ? getSoopProfileUrl(query) : null;

  resultDiv.innerHTML = `
    <div class="search-new-listing">
      <h3>매물이 없어요</h3>
      <p>${typeText} "${escapeHtml(query)}"와 일치하는 매물이 없습니다.<br>직접 경매를 등록해보세요!</p>
      <button class="btn-primary" onclick="openRegisterModal('${escapeHtml(isIdSearch ? query : "")}', '${escapeHtml(!isIdSearch ? query : "")}')">
        이 스트리머로 경매 등록
      </button>
    </div>
  `;
}

// ===== 경매 등록 모달 =====
window.openRegisterModal = function(soopId = "", displayName = "", isSelloff = false, currentPrice = null) {
  const modal = $("registerModal");
  if (!modal) return;

  const soopInput = $("regSoopId");
  const nickInput = $("regNickname");
  const priceInput = $("regStartPrice");
  const noticeEl = modal.querySelector(".register-notice ul");
  const modalTitle = modal.querySelector(".modal-header h2");

  if (soopInput) {
    soopInput.value = soopId;
    soopInput.disabled = isSelloff;
  }
  if (nickInput) {
    nickInput.value = displayName;
    nickInput.disabled = isSelloff;
  }
  if (priceInput) {
    priceInput.value = isSelloff && currentPrice ? currentPrice : 50000;
  }

  if (modalTitle) {
    modalTitle.textContent = isSelloff ? "손절 경매 등록" : "경매 등록";
  }

  if (noticeEl) {
    if (isSelloff) {
      noticeEl.innerHTML = `
        <li>낙찰 시 낙찰가의 <strong>100%</strong>가 즉시 지급됩니다</li>
        <li>유찰 시 경매가 취소되고 <strong>매물은 그대로 유지</strong>됩니다</li>
        <li>등록 후 취소는 불가합니다</li>`;
    } else {
      noticeEl.innerHTML = `
        <li>유찰 시 시작가로 자동 낙찰됩니다</li>
        <li>잔액에서 시작가가 차감될 수 있습니다</li>
        <li>등록 후 취소는 불가합니다</li>`;
    }
  }

  clearRegisterErrors();
  updateProfilePreview();

  modal.classList.add("show");
  pendingRegisterData = {isSelloff};
};

window.closeRegisterModal = function() {
  const modal = $("registerModal");
  if (!modal) return;
  modal.classList.remove("show");
  // 비활성화된 입력 필드 복원
  const soopInput = $("regSoopId");
  const nickInput = $("regNickname");
  if (soopInput) soopInput.disabled = false;
  if (nickInput) nickInput.disabled = false;
};

function clearRegisterErrors() {
  ["regSoopIdError", "regNicknameError", "regStartPriceError"].forEach((id) => {
    setText(id, "");
  });
}

window.updateProfilePreview = function() {
  const soopId = $("regSoopId")?.value?.trim();
  const nickname = $("regNickname")?.value?.trim();

  const img = $("registerProfileImg");
  const nameEl = $("registerName");
  const idEl = $("registerSoopId");

  if (nameEl) nameEl.textContent = nickname || "닉네임";
  if (idEl) idEl.textContent = soopId ? `@${soopId}` : "@soop-id";

  if (img && soopId && /^[a-zA-Z0-9]+$/.test(soopId)) {
    img.src = getSoopProfileUrl(soopId);
    img.style.display = "";
  } else if (img) {
    img.style.display = "none";
  }
};

// ===== 경매 등록 처리 =====
window.handleRegisterAuction = async function() {
  if (isRegistering) return;

  clearRegisterErrors();

  const soopId = $("regSoopId")?.value?.trim();
  const displayName = $("regNickname")?.value?.trim();
  const startPrice = parseInt($("regStartPrice")?.value || 0);

  // 클라이언트 검증
  let hasError = false;

  const soopIdErr = validateSoopId(soopId);
  if (soopIdErr) {
    setText("regSoopIdError", soopIdErr);
    hasError = true;
  }

  const nickErr = validateNickname(displayName);
  if (nickErr) {
    setText("regNicknameError", nickErr);
    hasError = true;
  }

  if (!startPrice || startPrice < 50000) {
    setText("regStartPriceError", "시작가는 최소 50,000G입니다.");
    hasError = true;
  }

  if (hasError) return;

  // 잔액 체크
  if (currentUserData && currentUserData.balance < startPrice) {
    setText("regStartPriceError",
        `잔액 부족: 현재 ${formatG(currentUserData.balance)}`);
    return;
  }

  // 보유 한도 체크
  if (currentUserData && currentUserData.ownedCount >= currentUserData.ownedLimit) {
    setText("regNicknameError",
        `보유 한도 초과 (${currentUserData.ownedLimit}개 한도)`);
    return;
  }

  isRegistering = true;
  const btn = $("registerBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "등록 중...";
  }

  try {
    const isSelloff = pendingRegisterData?.isSelloff;
    const result = await registerAuction({
      soopId: soopId.toLowerCase(),
      displayName,
      startPrice,
      type: isSelloff ? "selloff" : "new",
    });

    log(`경매 등록 성공: ${displayName}, ${formatG(startPrice)}, 상태=${result.status}`);
    closeRegisterModal();
    if (isSelloff) loadMyHoldings(auth.currentUser?.uid);

    // 결과 메시지
    const msg = result.status === "started" ?
      "경매가 시작됐습니다! 🎉" :
      `대기열 ${result.queuePosition}번째에 등록됐습니다.`;
    log(msg);

    if (result.tutorialReward) {
      showTutorialToast(result.tutorialReward);
      result.tutorialReward.forEach((r) => {
        if (currentUserData) {
          if (!currentUserData.tutorialRewards) currentUserData.tutorialRewards = {};
          currentUserData.tutorialRewards[r.type] = true;
        }
      });
      renderTutorialSection(currentUserData);
    }
  } catch (e) {
    log(`경매 등록 실패: ${e.message}`, true);
    // 에러 메시지 표시
    if (e.message.includes("재등록")) {
      setText("regSoopIdError", e.message);
    } else if (e.message.includes("한도")) {
      setText("regNicknameError", e.message);
    } else {
      setText("regStartPriceError", e.message || "등록에 실패했습니다.");
    }
  } finally {
    isRegistering = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "경매 등록";
    }
  }
};

// ===== 경매 요청 (Type B) =====
window.handleRequestAuction = async function(listingId) {
  try {
    const result = await requestAuction(listingId);
    log(`경매 요청 전송 완료: requestId=${result.requestId}`);
    // 검색 결과 새로고침
    handleSearch();
  } catch (e) {
    log(`경매 요청 실패: ${e.message}`, true);
    alert(`경매 요청 실패: ${e.message}`);
  }
};

window.handleApproveRequest = async function(requestId) {
  if (!confirm("경매 요청을 승인하시겠습니까?\n경매가 대기열에 등록됩니다.")) return;
  try {
    const result = await respondToAuctionRequest({requestId, action: "approve"});
    log(`경매 요청 승인: ${result.status === "started" ? "경매 시작" : "대기열 등록"}`);
    loadMyHoldings(auth.currentUser?.uid);
  } catch (e) {
    log(`승인 실패: ${e.message}`, true);
    alert(`승인 실패: ${e.message}`);
  }
};

window.handleRejectRequest = async function(requestId) {
  if (!confirm("경매 요청을 거부하시겠습니까?\n24시간 면역 기간이 설정됩니다.")) return;
  try {
    await respondToAuctionRequest({requestId, action: "reject"});
    log("경매 요청 거부 완료");
    loadMyHoldings(auth.currentUser?.uid);
  } catch (e) {
    log(`거부 실패: ${e.message}`, true);
    alert(`거부 실패: ${e.message}`);
  }
};

// ===== 보유 매물 클릭 검색 =====
window.searchByHolding = function(soopId) {
  const input = $("searchInput");
  if (input) {
    input.value = soopId;
    input.scrollIntoView({behavior: "smooth", block: "center"});
  }
  handleSearch();
};

// ===== 검색 포커스 =====
window.focusSearch = function() {
  closeRewardModal();
  const input = $("searchInput");
  if (input) {
    input.focus();
    input.scrollIntoView({behavior: "smooth", block: "center"});
  }
};

// ===== 버튼 핸들러 (개발 패널) =====
window.handleGoogleLogin = async function() {
  if (auth.currentUser?.isAnonymous) {
    await handleConvertToGoogle();
  } else {
    try {
      await loginGoogle();
    } catch (e) {
      log(`구글 로그인 실패: ${e.message}`, true);
    }
  }
};

window.handleLogout = async function() {
  try {
    unsubscribeAuction();
    // 서버 세션 제거 — 슬롯을 즉시 반환해 다른 유저가 접속 가능하도록
    try { await endSessionFn(); } catch (_) {}
    clearPresence();
    await logout();
    log("로그아웃 완료");
  } catch (e) {
    log(`로그아웃 실패: ${e.message}`, true);
  }
};

let isSkippingCooldown = false;
window.handleSkipCooldown = async function() {
  if (isSkippingCooldown) return;
  isSkippingCooldown = true;
  const btn = $("btnSkipCooldown");
  if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
  setText("skipCooldownError", "");
  try {
    const result = await skipCooldown();
    if (currentUserData) currentUserData.balance = result.newBalance;
    if (auth.currentUser) recordBalanceHistory(auth.currentUser.uid, result.newBalance);
    updateAuthUI(auth.currentUser, currentUserData);
    btn.style.display = "none";
  } catch (e) {
    setText("skipCooldownError", e.message || "처리 중 오류가 발생했습니다.");
  } finally {
    isSkippingCooldown = false;
    if (btn) { btn.disabled = false; btn.textContent = "⚡ 대기시간 건너뛰기 (50,000G)"; }
  }
};

// ===== 이벤트 바인딩 =====
const btnWelcomeClose = $("btnWelcomeClose");
const btnWelcomeUpgrade = $("btnWelcomeUpgrade");

if (btnWelcomeClose) {
  btnWelcomeClose.addEventListener("click", hideWelcomeModal);
}

if (btnWelcomeUpgrade) {
  btnWelcomeUpgrade.addEventListener("click", handleConvertToGoogle);
}

// ===== 경매 실시간 구독 시작 =====
subscribeAuction({
  onAuctionUpdate,
  onQueueUpdate,
  onBidsUpdate,
  onTimer,
});

log("앱 초기화 완료");

// ===== 유틸 =====
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

function formatBidTime(timestamp) {
  if (!timestamp) return "";
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  return `${Math.floor(diff / 3600)}시간 전`;
}

// ===== 신고 모달 =====
window.openReportModal = function(listingId, displayName) {
  if (currentUserData?.authType === "anonymous") {
    alert("신고는 Google 계정만 가능합니다.\n구글 로그인 후 이용해주세요.");
    return;
  }
  pendingReportListingId = listingId;
  pendingReportListingName = displayName;
  const modal = $("reportModal");
  if (!modal) return;
  setText("reportTargetName", `"${displayName}" 을(를) 신고하는 이유를 선택해주세요.`);
  document.querySelectorAll('input[name="reportReason"]').forEach((r) => { r.checked = false; });
  setText("reportError", "");
  modal.classList.add("show");
};

window.closeReportModal = function() {
  const modal = $("reportModal");
  if (modal) modal.classList.remove("show");
  pendingReportListingId = null;
  pendingReportListingName = null;
};

window.handleSubmitReport = async function() {
  const reason = document.querySelector('input[name="reportReason"]:checked')?.value;
  if (!reason) {
    setText("reportError", "신고 사유를 선택해주세요.");
    return;
  }
  if (!pendingReportListingId) return;

  const btn = $("reportSubmitBtn");
  if (btn) { btn.disabled = true; btn.textContent = "제출 중..."; }

  try {
    await reportListing({listingId: pendingReportListingId, reason});
    closeReportModal();
    log(`신고 완료: ${pendingReportListingName}`);
    alert("신고가 접수됐습니다. 검토 후 조치하겠습니다.");
  } catch (e) {
    setText("reportError", e.message.includes("이미") ? "이미 신고한 매물입니다." : e.message);
    if (btn) { btn.disabled = false; btn.textContent = "신고 제출"; }
  }
};

// ===== 차단 / 해제 =====
window.handleBlockListing = async function(listingId, block) {
  const label = block ? "차단" : "차단 해제";
  if (!confirm(`이 매물을 ${label}하시겠습니까?`)) return;
  try {
    await blockListing({listingId, block});
    if (currentUserData) {
      if (!currentUserData.blockedListingIds) currentUserData.blockedListingIds = [];
      if (block) {
        currentUserData.blockedListingIds.push(listingId);
      } else {
        currentUserData.blockedListingIds = currentUserData.blockedListingIds.filter((id) => id !== listingId);
      }
    }
    log(`${label} 완료: ${listingId}`);
    // 검색 결과 새로고침
    handleSearch();
  } catch (e) {
    log(`${label} 실패: ${e.message}`, true);
    alert(`${label} 실패: ${e.message}`);
  }
};

// ===== 경매 히스토리 열람 =====
window.handleViewHistory = async function(listingId, displayName) {
  if (!currentUserData) {
    alert("로그인이 필요합니다.");
    return;
  }
  const balance = currentUserData.balance ?? 0;
  const COST = 50000;
  if (balance < COST) {
    alert(`잔액이 부족합니다.\n필요: ${COST.toLocaleString()}G / 보유: ${balance.toLocaleString()}G`);
    return;
  }
  if (!confirm(`"${displayName}" 경매 히스토리를 열람합니다.\n${COST.toLocaleString()}G가 차감됩니다. 계속하시겠습니까?`)) return;

  const modal = $("historyModal");
  const body = $("historyModalBody");
  const title = $("historyModalTitle");
  if (!modal) return;
  title.textContent = `${displayName} — 경매 히스토리`;
  body.innerHTML = `<p class="history-loading">불러오는 중...</p>`;
  modal.classList.add("show");

  try {
    const result = await viewAuctionHistory(listingId);
    if (currentUserData) currentUserData.balance = result.newBalance;
    updateAuthUI(auth.currentUser, currentUserData);

    if (!result.history || result.history.length === 0) {
      body.innerHTML = `<p class="history-empty">경매 기록이 없습니다.</p>`;
      return;
    }

    const rows = result.history.map((h) => {
      const date = h.endedAt ? new Date(h.endedAt).toLocaleDateString("ko-KR", {
        year: "2-digit", month: "2-digit", day: "2-digit",
      }) : "-";
      const outcome = h.isWon ? "낙찰" : "유찰";
      const outcomeClass = h.isWon ? "outcome-won" : "outcome-failed";
      return `<tr>
        <td>${date}</td>
        <td><span class="type-chip">${escapeHtml(h.typeLabel)}</span></td>
        <td>${formatG(h.startPrice)}</td>
        <td class="price-final">${formatG(h.finalPrice)}</td>
        <td>${h.bidCount}회</td>
        <td><span class="${outcomeClass}">${outcome}</span></td>
      </tr>`;
    }).join("");

    body.innerHTML = `
      <p class="history-cost-notice">${COST.toLocaleString()}G 차감됨 · 잔액 ${result.newBalance.toLocaleString()}G</p>
      <div class="history-table-wrap">
        <table class="history-table">
          <thead>
            <tr><th>날짜</th><th>유형</th><th>시작가</th><th>최종가</th><th>입찰 수</th><th>결과</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    body.innerHTML = `<p class="history-error">${escapeHtml(e.message)}</p>`;
    log(`히스토리 열람 실패: ${e.message}`, true);
  }
};

// ===== 보상 센터 모달 =====
function updateRewardBtn(userData) {
  const btn = $("btnRewardCenter");
  if (!btn) return;
  if (!userData) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "";

  // 오늘 출석 미수령 + Google 계정이면 점 표시
  const isGoogle = userData.authType === "google";
  const lastAtMs = userData.lastDailyRewardAt || null;
  const claimedToday = lastAtMs && getKSTDateStr(new Date(lastAtMs)) === getKSTDateStr(new Date());
  const hasDot = isGoogle && !claimedToday;
  btn.classList.toggle("has-dot", hasDot);
}

window.openRewardModal = function() {
  $("rewardModal").classList.add("show");
  window.switchRewardTab("daily");
};

window.closeRewardModal = function() {
  $("rewardModal").classList.remove("show");
};

// ===== 출석 체크 핸들러 =====
window.handleClaimDailyReward = async function() {
  const btn = document.querySelector(".btn-daily-claim");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "처리 중...";
  }
  try {
    const result = await claimDailyReward();
    if (currentUserData) {
      currentUserData.balance = result.newBalance;
      currentUserData.consecutiveLoginDays = result.newStreak;
      currentUserData.lastDailyRewardAt = Date.now();
    }
    if (auth.currentUser) recordBalanceHistory(auth.currentUser.uid, result.newBalance);
    updateAuthUI(auth.currentUser, currentUserData);
    renderDailyRewardSection(currentUserData);
    updateRewardBtn(currentUserData);

    let msg = `+${result.base.toLocaleString()}G 획득!`;
    if (result.bonus > 0) {
      msg += ` +${result.bonus.toLocaleString()}G ${result.specialDay}일 보너스!`;
    }
    msg += ` (${result.newStreak}일 연속)`;
    showToast(msg);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "출석 체크하기";
    }
    if (e.code === "already-exists") {
      renderDailyRewardSection(currentUserData);
    } else {
      alert(`출석 보상 실패: ${e.message}`);
    }
  }
};

function showToast(message) {
  const container = $("tutorialToastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "tutorial-toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3100);
}

window.closeHistoryModal = function() {
  const modal = $("historyModal");
  if (modal) modal.classList.remove("show");
};

// ===== 보상 센터 탭 전환 =====
window.switchRewardTab = function(tab) {
  $("rewardTabDaily").style.display = tab === "daily" ? "" : "none";
  $("rewardTabAd").style.display = tab === "ad" ? "" : "none";
  document.querySelectorAll(".reward-tab-btn").forEach((btn, i) => {
    btn.classList.toggle("active", (i === 0 && tab === "daily") || (i === 1 && tab === "ad"));
  });
  if (tab === "ad") renderAdRewardSection();
};

// ===== 광고 보상 탭 렌더링 =====
function msToRemaining(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

async function renderAdRewardSection() {
  const section = $("adRewardSection");
  if (!section) return;
  section.innerHTML = `<p class="bh-loading">광고 목록 불러오는 중...</p>`;

  const isGoogle = currentUserData?.authType === "google";

  try {
    const res = await getActiveAdsFn();
    const {ads, todayCount} = res.data;
    ads.sort((a, b) => a.expiresAt - b.expiresAt);
    const now = Date.now();
    const activeAds = ads.filter(ad => ad.expiresAt > now);

    let html = `<div class="ad-reward-header">
      <span class="ad-today-count">오늘 보상: <strong>${todayCount} / 3</strong>개 완료</span>
      ${isGoogle ? `<button class="btn-ad-register" onclick="openAdPurchaseModal()">+ 광고 신청</button>` : ""}
    </div>`;

    if (activeAds.length === 0) {
      html += `<div class="ad-empty">현재 진행 중인 광고가 없습니다.<br>${isGoogle ? "광고를 직접 신청해보세요!" : ""}</div>`;
    } else {
      activeAds.forEach((ad) => {
        const imgSrc = `https://stimg.sooplive.co.kr/LOGO/${ad.soopId.slice(0, 2)}/${ad.soopId}/${ad.soopId}.jpg`;
        const remaining = msToRemaining(ad.expiresAt - now);
        const claimed = ad.claimedToday;
        const isOwn = ad.isOwn;
        html += `
          <div class="ad-card${claimed ? " claimed" : ""}${isOwn ? " own-ad" : ""}">
            <img class="ad-card-img" src="${imgSrc}" alt="" onerror="this.style.background='#374151';this.src=''">
            <div class="ad-card-body">
              <div class="ad-card-name">${escapeHtml(ad.displayName)}${isOwn ? `<span class="ad-own-badge">내 광고</span>` : ""}</div>
              <div class="ad-card-id">${ad.soopId}</div>
              <div class="ad-card-expires">종료까지 ${remaining}</div>
            </div>
            <div class="ad-card-actions">
              <span class="ad-card-reward ${claimed ? "claimed-text" : ""}">${claimed ? "오늘 수령 완료 ✅" : "+10,000G"}</span>
              <button class="btn-ad-visit" onclick="handleAdVisit('${ad.adId}','${ad.soopId}')"
                ${claimed || isOwn ? "disabled" : ""}>${isOwn ? "본인 광고" : "방송국 방문 →"}</button>
            </div>
          </div>`;
      });
    }
    section.innerHTML = html;
  } catch (e) {
    section.innerHTML = `<p class="bh-loading">광고 목록을 불러오지 못했습니다.<br>${e.message}</p>`;
  }
}

window.handleAdVisit = async function(adId, soopId) {
  const btn = document.querySelector(`.btn-ad-visit[onclick*="${adId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
  try {
    const res = await claimAdRewardFn({adId});
    const {newBalance, todayCount} = res.data;
    if (currentUserData) currentUserData.balance = newBalance;
    updateAuthUI(auth.currentUser, currentUserData);
    if (auth.currentUser) recordBalanceHistory(auth.currentUser.uid, newBalance);
    window.open(`https://www.sooplive.com/station/${soopId}`, "_blank");
    showToast(`+5,000G 획득! (오늘 ${todayCount}/3개)`);
    renderAdRewardSection();
  } catch (e) {
    if (e.code === "already-exists") {
      showToast("이 광고는 오늘 이미 수령했습니다.");
      renderAdRewardSection();
      window.open(`https://www.sooplive.com/station/${soopId}`, "_blank");
    } else if (e.code === "functions/resource-exhausted") {
      showToast("오늘 보상 한도(5개)에 도달했습니다.");
      if (btn) { btn.disabled = false; btn.textContent = "방송국 방문 →"; }
    } else {
      alert(`보상 수령 실패: ${e.message}`);
      if (btn) { btn.disabled = false; btn.textContent = "방송국 방문 →"; }
    }
  }
};

// ===== 광고 신청 모달 =====
window.openAdPurchaseModal = function() {
  if (!currentUserData) return;
  const modal = $("adPurchaseModal");
  if (!modal) return;
  $("adDisplayName").value = "";
  $("adSoopId").value = "";
  $("adDurationDays").value = "1";
  $("adConsentCheck").checked = false;
  $("btnAdPurchaseConfirm").disabled = true;
  $("adPurchaseError").style.display = "none";
  $("adProfilePreview").style.display = "none";
  updateAdCostPreview();
  modal.classList.add("show");

  $("adSoopId").addEventListener("input", onAdSoopIdInput);
  $("adDurationDays").addEventListener("input", updateAdCostPreview);
  $("adConsentCheck").addEventListener("change", updateAdConfirmBtn);
};

window.closeAdPurchaseModal = function() {
  const modal = $("adPurchaseModal");
  if (modal) modal.classList.remove("show");
};

function onAdSoopIdInput() {
  const soopId = $("adSoopId").value.trim().toLowerCase();
  const preview = $("adProfilePreview");
  if (!soopId) { preview.style.display = "none"; return; }
  const imgSrc = `https://stimg.sooplive.co.kr/LOGO/${soopId.slice(0, 2)}/${soopId}/${soopId}.jpg`;
  $("adProfileImg").src = imgSrc;
  $("adProfileImg").onerror = () => { $("adProfileImg").src = ""; };
  $("adProfileName").textContent = $("adDisplayName").value.trim() || soopId;
  $("adProfileUrl").textContent = `sooplive.com/station/${soopId}`;
  preview.style.display = "flex";
  updateAdConfirmBtn();
}

function updateAdCostPreview() {
  const days = parseInt($("adDurationDays")?.value) || 1;
  const cost = days * 200000;
  const balance = currentUserData?.balance || 0;
  const el = $("adCostPreview");
  if (el) el.textContent = `총 비용: ${days}일 × 200,000G = ${cost.toLocaleString("ko-KR")}G`;
  const balEl = $("adBalancePreview");
  if (balEl) {
    if (balance >= cost) {
      balEl.textContent = `잔액: ${formatG(balance)} → ${formatG(balance - cost)}`;
    } else {
      balEl.textContent = `잔액 부족 (${formatG(balance)})`;
      balEl.style.color = "#f87171";
    }
  }
  updateAdConfirmBtn();
}

function updateAdConfirmBtn() {
  const soopId = $("adSoopId")?.value.trim();
  const name = $("adDisplayName")?.value.trim();
  const days = parseInt($("adDurationDays")?.value) || 0;
  const consent = $("adConsentCheck")?.checked;
  const balance = currentUserData?.balance || 0;
  const cost = days * 200000;
  const valid = name && /^[a-zA-Z0-9]{1,20}$/.test(soopId) && days >= 1 && days <= 7 && consent && balance >= cost;
  const btn = $("btnAdPurchaseConfirm");
  if (btn) btn.disabled = !valid;
}

window.handleAdPurchase = async function() {
  const displayName = $("adDisplayName").value.trim();
  const soopId = $("adSoopId").value.trim().toLowerCase();
  const durationDays = parseInt($("adDurationDays").value);
  const consentAgreed = $("adConsentCheck").checked;
  const errEl = $("adPurchaseError");
  const btn = $("btnAdPurchaseConfirm");

  btn.disabled = true;
  btn.textContent = "처리 중...";
  errEl.style.display = "none";

  try {
    const res = await purchaseAdFn({displayName, soopId, durationDays, consentAgreed});
    const {newBalance} = res.data;
    if (currentUserData) currentUserData.balance = newBalance;
    updateAuthUI(auth.currentUser, currentUserData);
    if (auth.currentUser) recordBalanceHistory(auth.currentUser.uid, newBalance);
    closeAdPurchaseModal();
    showToast(`광고 등록 완료! ${durationDays}일간 노출됩니다.`);
    renderAdRewardSection();
  } catch (e) {
    errEl.textContent = e.message || "광고 등록에 실패했습니다.";
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "광고 등록";
  }
};
