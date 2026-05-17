// ============================================
// my.js - 마이페이지
// ============================================

import {auth, db, functions, rtdb} from "./firebase-config.js";
import {
  doc, getDoc, getDocFromServer, collection, query, where, getDocs,
  addDoc, serverTimestamp, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {ref as dbRef, onValue as dbOnValue} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";
import {watchAuthState, logout, loginGoogle, linkAnonymousToGoogle} from "./auth.js";
import {
  registerAuction, respondToAuctionRequest, updateUserNickname,
  formatG, validateSoopId, validateNickname, getSoopProfileUrl,
} from "./auction.js";

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
const escapeHtml = (s) => {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const toMillis = (v) => {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  return null;
};

// ===== 상태 =====
let currentUserData = null;
let myHoldings = [];
let pendingByListing = {};  // listingId → requestData
let buyHistory = [];
let sellHistory = [];
let activeTab = "all";
let pendingRegisterData = {};
let isRegistering = false;
let isEditingNickname = false;
let auctionWatcherUnsub = null;
let currentAuctionInfo = null; // RTDB auction/current 요약 { status, listingId }

const initializeUserFn = httpsCallable(functions, "initializeUser");
const setVaultListingFn = httpsCallable(functions, "setVaultListing");

// ===== 초기화 =====
watchAuthState(async (user) => {
  if (!user) {
    renderLoginPrompt();
    return;
  }

  try {
    const res = await initializeUserFn();
    currentUserData = res.data;
    recordBalanceHistory(user.uid, currentUserData.balance);
  } catch (e) {
    console.error("initializeUser 실패:", e);
  }

  renderAuthArea();
  await Promise.all([loadHoldings(user.uid), loadTradeHistory(user.uid)]);
  renderAll();
  setupAuctionEndWatcher(user.uid);
});

// ===== 데이터 로드 =====
async function loadHoldings(uid) {
  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    if (!userSnap.exists()) return;

    const ids = userSnap.data().ownedListingIds || [];
    if (ids.length === 0) { myHoldings = []; return; }

    // 대기 중인 경매 요청 조회
    const reqSnap = await getDocs(query(
        collection(db, "auctionRequests"),
        where("ownerId", "==", uid),
        where("status", "==", "pending"),
    ));
    pendingByListing = {};
    reqSnap.forEach((d) => { pendingByListing[d.data().listingId] = d.data(); });

    // 매물 배치 조회 (서버에서 직접 조회해 isLocked 등 최신값 보장)
    const snaps = await Promise.all(ids.map((id) => getDocFromServer(doc(db, "listings", id))));
    myHoldings = snaps
        .filter((s) => s.exists())
        .map((s) => ({id: s.id, ...s.data()}));
  } catch (e) {
    console.error("보유 매물 로드 실패:", e);
  }
}

// RTDB auction/current 감시: 경매 진행 중/대기 중 구분 + 종료 시 홀딩 새로고침
function setupAuctionEndWatcher(uid) {
  if (auctionWatcherUnsub) {
    auctionWatcherUnsub();
    auctionWatcherUnsub = null;
  }
  let prevStatus = null;
  let prevListingId = null;
  let isFirstFire = true;

  auctionWatcherUnsub = dbOnValue(dbRef(rtdb, "auction/current"), async (snap) => {
    const data = snap.val();
    const status = data?.status ?? null;
    const listingId = data?.listingId ?? null;
    currentAuctionInfo = data ? {status, listingId} : null;

    const statusChanged = prevStatus !== status;
    const listingChanged = prevListingId !== listingId;
    const hasLockedHoldings = myHoldings.some((h) => h.isLocked);

    if (isFirstFire) {
      isFirstFire = false;
      // 초기 로드: 잠긴 매물이 있는데 해당 매물이 active 경매가 아니면 서버 재확인
      // (finalizeAuction 직후 Firestore/RTDB 전파 타이밍 차이 보정)
      const hasLockedNotActive = myHoldings.some(
          (h) => h.isLocked && (status !== "active" || listingId !== h.id));
      if (hasLockedNotActive) {
        await loadHoldings(uid);
      }
      renderAll();
      prevStatus = status;
      prevListingId = listingId;
      return;
    }

    // 경매 종료: active → 다른 상태
    if (prevStatus === "active" && status !== "active") {
      await loadHoldings(uid);
    }
    // 대기열 소진으로 RTDB가 null이 됐는데 잠긴 매물이 남아있으면 재확인
    else if (status === null && hasLockedHoldings) {
      await loadHoldings(uid);
    }

    // 상태·대상 매물이 바뀌면 re-render (배지 갱신)
    if (statusChanged || listingChanged) {
      renderAll();
    }

    prevStatus = status;
    prevListingId = listingId;
  });
}

async function loadTradeHistory(uid) {
  try {
    const [buySnap, sellSnap] = await Promise.all([
      getDocs(query(collection(db, "auctionHistory"), where("winnerId", "==", uid))),
      getDocs(query(collection(db, "auctionHistory"), where("sellerId", "==", uid))),
    ]);
    buyHistory = buySnap.docs.map((d) => ({id: d.id, role: "buy", ...d.data()}));
    sellHistory = sellSnap.docs.map((d) => ({id: d.id, role: "sell", ...d.data()}));
  } catch (e) {
    console.error("거래 내역 로드 실패:", e);
  }
}

// ===== 렌더 =====
function renderAll() {
  const container = $("myContent");
  if (!container) return;

  container.innerHTML = `
    ${renderProfileCard()}
    ${renderVault()}
    <div class="my-section">
      <div class="my-section-header">
        <span class="my-section-title">보유 매물</span>
        <span class="my-section-count">${myHoldings.length} / ${currentUserData?.ownedLimit || 0}</span>
      </div>
      ${renderHoldings()}
    </div>
    <div class="my-section">
      <div class="my-section-header">
        <span class="my-section-title">거래 내역</span>
      </div>
      ${renderHistoryTabs()}
      <div id="historyTableWrap">${renderHistoryTable()}</div>
    </div>
    ${currentUserData?.authType === "google" ? `
    <div class="my-section">
      <div class="my-section-header">
        <span class="my-section-title">출석 현황</span>
      </div>
      ${renderAttendance()}
    </div>` : ""}
  `;
}

function renderProfileCard() {
  const ud = currentUserData;
  const user = auth.currentUser;
  if (!ud) return "";

  const isGoogle = ud.authType === "google";
  const avatarSrc = user?.photoURL || "assets/images/default-avatar.svg";
  const displayName = ud.displayName || (isGoogle ? "Google 유저" : "익명 유저");
  const typeLabel = isGoogle ? "Google 유저" : "익명 유저";
  const typeClass = isGoogle ? "google" : "anon";

  return `
    <div class="my-profile-card">
      <img class="my-profile-avatar" src="${escapeHtml(avatarSrc)}"
        onerror="this.src='assets/images/default-avatar.svg'" alt="프로필">
      <div class="my-profile-info">
        ${isEditingNickname ? `
          <div class="my-nickname-edit-row">
            <input class="my-nickname-input" id="nicknameInput"
              value="${escapeHtml(displayName)}" maxlength="20" placeholder="닉네임 (2~20자)">
            <button class="btn-nickname-save" onclick="saveNickname()">저장</button>
            <button class="btn-nickname-cancel" onclick="cancelEditNickname()">취소</button>
          </div>
          <div class="my-nickname-error" id="nicknameError"></div>
        ` : `
          <div class="my-profile-name-row">
            <span class="my-profile-name">${escapeHtml(displayName)}</span>
            <button class="btn-nickname-edit" onclick="startEditNickname()" title="닉네임 변경">✏️</button>
          </div>
        `}
        <span class="my-profile-type ${typeClass}">${typeLabel}</span>
      </div>
      <div class="my-stats-row">
        <div class="my-stat-box my-stat-box--clickable" onclick="openBalanceHistoryModal()" title="최근 7일 잔액 변화 보기">
          <div class="my-stat-label">잔액 <span class="my-stat-hint">↗</span></div>
          <div class="my-stat-value accent">${formatG(ud.balance ?? 0)}</div>
        </div>
        <div class="my-stat-box">
          <div class="my-stat-label">보유</div>
          <div class="my-stat-value">${ud.ownedCount || 0}개</div>
        </div>
        <div class="my-stat-box">
          <div class="my-stat-label">한도</div>
          <div class="my-stat-value">${ud.ownedLimit || 0}개</div>
        </div>
        <div class="my-stat-box">
          <div class="my-stat-label">거래</div>
          <div class="my-stat-value">${buyHistory.length + sellHistory.length}건</div>
        </div>
      </div>
    </div>`;
}

function renderVault() {
  const ud = currentUserData;
  if (!ud) return "";
  const slots = ud.vaultSlots || 0;
  const uid = auth.currentUser?.uid;

  if (slots === 0) {
    return `
      <div class="my-section my-vault-section">
        <div class="my-section-header">
          <span class="my-section-title">🏦 금고</span>
        </div>
        <div class="my-vault-empty">
          금고 슬롯이 없습니다.
          <a href="shop.html" class="my-vault-shop-link">상점에서 구매하기 →</a>
        </div>
      </div>`;
  }

  const vaulted = myHoldings.filter((h) => h.vaultedBy === uid);
  const usedSlots = vaulted.length;
  const freeSlots = slots - usedSlots;

  const slotCards = Array.from({length: slots}, (_, i) => {
    const item = vaulted[i] || null;
    if (item) {
      const img = item.profileImageUrl || "assets/images/default-avatar.svg";
      return `
        <div class="vault-slot vault-slot--filled">
          <img class="vault-slot-img" src="${img}"
            onerror="this.src='assets/images/default-avatar.svg'" alt="프로필">
          <div class="vault-slot-info">
            <div class="vault-slot-name">${escapeHtml(item.displayName)}</div>
            <div class="vault-slot-id">@${escapeHtml(item.soopId)}</div>
            <div class="vault-slot-price">${formatG(item.currentPrice)}</div>
          </div>
          <div class="vault-slot-badge">강제청산 면제</div>
          <button class="btn-vault-out"
            onclick="handleUnvaultListing('${escapeHtml(item.id)}')">인출</button>
        </div>`;
    }
    return `
      <div class="vault-slot vault-slot--empty vault-slot--clickable"
        onclick="openVaultPickerModal()" title="클릭해서 매물 선택">
        <div class="vault-slot-empty-icon">➕</div>
        <div class="vault-slot-empty-text">클릭해서 매물 보관</div>
      </div>`;
  }).join("");

  return `
    <div class="my-section my-vault-section">
      <div class="my-section-header">
        <span class="my-section-title">🏦 금고</span>
        <span class="my-section-count">${usedSlots} / ${slots} 사용 중</span>
      </div>
      <div class="vault-slots-grid">${slotCards}</div>
    </div>`;
}

function renderHoldings() {
  if (myHoldings.length === 0) {
    return `<div class="my-empty">보유 중인 매물이 없어요</div>`;
  }

  const uid = auth.currentUser?.uid;
  const hasVaultSlots = (currentUserData?.vaultSlots || 0) > 0;

  return `<div class="my-holdings-grid">${myHoldings.map((d) => {
    const pending = pendingByListing[d.id];
    const img = d.profileImageUrl || "assets/images/default-avatar.svg";
    const isVaulted = d.vaultedBy === uid;

    const isActiveAuction = d.isLocked &&
      currentAuctionInfo?.status === "active" &&
      currentAuctionInfo?.listingId === d.id;
    const actionBtn = isActiveAuction
      ? `<span class="request-status-badge auction-live">🔴 경매 진행 중</span>`
      : d.isLocked
      ? `<span class="request-status-badge auction-waiting">⏳ 경매 대기 중</span>`
      : `<button class="btn-selloff btn-selloff--small"
           onclick="openSelloffModal('${escapeHtml(d.soopId)}','${escapeHtml(d.displayName)}',${d.currentPrice||50000})">
           손절 등록
         </button>`;

    const vaultBtn = hasVaultSlots && !d.isLocked ? (
      isVaulted
        ? `<button class="btn-vault btn-vault--out"
             onclick="handleUnvaultListing('${escapeHtml(d.id)}')">🔓 인출</button>`
        : `<button class="btn-vault btn-vault--in"
             onclick="handleVaultListing('${escapeHtml(d.id)}')">🏦 금고 보관</button>`
    ) : "";

    const vaultBadge = isVaulted
      ? `<span class="my-vault-badge">🏦 금고 보관 중 · 강제청산 면제</span>` : "";

    const requestRow = pending ? `
      <div class="my-holding-request-row${isVaulted ? " is-vaulted" : ""}">
        <span class="my-request-badge">📨 경매 요청 대기 중</span>
        ${isVaulted ? `<span class="my-vault-exempt-badge">🏦 강제청산 면제</span>` : `
        <div class="my-request-btns">
          <button class="btn-approve"
            onclick="handleApproveRequest('${escapeHtml(pending.requestId)}')">승인</button>
          <button class="btn-reject"
            onclick="handleRejectRequest('${escapeHtml(pending.requestId)}')">거부</button>
        </div>`}
      </div>` : "";

    return `
      <div class="my-holding-card${pending ? " has-request" : ""}${isVaulted ? " is-vaulted" : ""}">
        <img class="my-holding-img" src="${img}"
          onerror="this.src='assets/images/default-avatar.svg'" alt="프로필">
        <div class="my-holding-info">
          <div class="my-holding-name">${escapeHtml(d.displayName)}</div>
          <div class="my-holding-id">@${escapeHtml(d.soopId)}</div>
          ${vaultBadge}
        </div>
        <div class="my-holding-price">
          <div class="my-holding-price-label">현재 시세</div>
          <div class="my-holding-price-value">${formatG(d.currentPrice)}</div>
        </div>
        <div class="my-holding-actions">${actionBtn}${vaultBtn}</div>
        ${requestRow}
      </div>`;
  }).join("")}</div>`;
}

function renderHistoryTabs() {
  const tabs = [
    {key: "all", label: `전체 ${buyHistory.length + sellHistory.length}`},
    {key: "buy",  label: `매수 ${buyHistory.length}`},
    {key: "sell", label: `매도 ${sellHistory.length}`},
  ];
  return `<div class="my-history-tabs">${tabs.map((t) =>
    `<button class="my-tab-btn${activeTab === t.key ? " active" : ""}"
       onclick="switchTab('${t.key}')">${t.label}</button>`
  ).join("")}</div>`;
}

function renderHistoryTable() {
  const TYPE_LABEL = {new: "신규", holder: "보유자 승인", selloff: "손절"};

  let rows = [];
  if (activeTab === "all" || activeTab === "buy") {
    rows = rows.concat(buyHistory.map((h) => ({...h, role: "buy"})));
  }
  if (activeTab === "all" || activeTab === "sell") {
    rows = rows.concat(sellHistory.map((h) => ({...h, role: "sell"})));
  }

  // endedAt 기준 내림차순 정렬
  rows.sort((a, b) => (toMillis(b.endedAt) || 0) - (toMillis(a.endedAt) || 0));

  if (rows.length === 0) {
    return `<div class="my-empty">거래 내역이 없어요</div>`;
  }

  const rowHtml = rows.map((h) => {
    const ms = toMillis(h.endedAt);
    const date = ms ? new Date(ms).toLocaleDateString("ko-KR", {
      year: "2-digit", month: "2-digit", day: "2-digit",
    }) : "-";
    const typeLabel = TYPE_LABEL[h.type] || h.type || "-";
    const roleLabel = h.role === "buy" ? "낙찰" : "매도";
    const roleCls = h.role === "buy" ? "buy" : "sell";
    const price = formatG(h.role === "buy" ? h.finalPrice : Math.floor((h.finalPrice || 0) * 0.95));
    const outcome = h.isWon ? "낙찰" : "유찰";
    const outcomeCls = h.isWon ? "outcome-won" : "outcome-failed";

    return `<tr>
      <td>${date}</td>
      <td>
        <a class="my-listing-link" href="listing.html?id=${escapeHtml(h.listingId)}">${escapeHtml(h.displayName)}</a>
      </td>
      <td><span class="type-chip">${escapeHtml(typeLabel)}</span></td>
      <td><span class="my-role-badge ${roleCls}">${roleLabel}</span></td>
      <td style="font-weight:600;color:#f5d142">${price}</td>
      <td><span class="${outcomeCls}">${outcome}</span></td>
    </tr>`;
  }).join("");

  return `
    <div class="my-history-wrap">
      <table class="my-history-table">
        <thead>
          <tr>
            <th>날짜</th><th>매물</th><th>유형</th><th>역할</th><th>가격</th><th>결과</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>`;
}

function renderAttendance() {
  const ud = currentUserData;
  if (!ud) return "";

  const streak = ud.consecutiveLoginDays || 0;
  const lastMs = ud.lastDailyRewardAt || null;
  const lastDate = lastMs
    ? new Date(lastMs).toLocaleDateString("ko-KR", {month: "long", day: "numeric"})
    : "없음";

  // 다음 마일스톤 계산
  const next7 = 7 - (streak % 7) || 7;
  const next30 = 30 - (streak % 30) || 30;
  const nextMilestone = next7 <= next30 ? {days: next7, bonus: 30000, label: "7일 보너스"} :
    {days: next30, bonus: 100000, label: "30일 보너스"};

  const milestoneTarget = streak % 7 < streak % 30 ? 7 : 30;
  const progressPct = Math.min(((streak % milestoneTarget) / milestoneTarget) * 100, 100);

  return `
    <div class="my-attendance-card">
      <div class="my-attendance-row">
        <div class="my-streak-block">
          <div class="my-streak-num">${streak}</div>
          <div class="my-streak-label">연속 출석</div>
        </div>
        <div class="my-attendance-info">
          <div class="my-attendance-detail">마지막 수령: <strong>${lastDate}</strong></div>
          <div class="my-attendance-detail">내일 보상:
            <strong>${streak >= 2 ? "10,000G" : "5,000G"}</strong>
          </div>
          <div class="my-next-milestone">
            다음 마일스톤: <span>${nextMilestone.days}일 후</span> — ${nextMilestone.label}
            +<span>${(nextMilestone.bonus).toLocaleString()}G</span>
          </div>
          <div class="my-progress-bar">
            <div class="my-progress-fill" style="width:${progressPct.toFixed(1)}%"></div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderLoginPrompt() {
  const container = $("myContent");
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center;padding:60px;color:#9ba3b4">
      <p style="margin-bottom:16px">마이페이지를 이용하려면 로그인이 필요합니다.</p>
      <a class="btn-primary" href="index.html" style="display:inline-block;padding:10px 24px">메인으로 이동</a>
    </div>`;
}

// ===== 잔액 히스토리 기록 =====
async function recordBalanceHistory(uid, newBalance) {
  if (typeof newBalance !== "number") return;
  try {
    const histRef = collection(db, "users", uid, "balanceHistory");
    const lastSnap = await getDocs(query(histRef, orderBy("at", "desc"), limit(1)));
    const lastBalance = lastSnap.empty ? null : lastSnap.docs[0].data().balance;
    if (lastBalance === newBalance) return; // 변동 없으면 기록 안 함
    await addDoc(histRef, {
      balance: newBalance,
      delta: lastBalance !== null ? newBalance - lastBalance : 0,
      at: serverTimestamp(),
    });
  } catch (e) {
    console.error("잔액 히스토리 기록 실패:", e);
  }
}

// ===== 잔액 변화 모달 =====
let _bhData = null; // 모달 열릴 때 한 번만 계산

const _toKSTDateKey = (ms) => {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
const _toKSTDateLabel = (key) => {
  const [, m, d] = key.split("-");
  return `${parseInt(m)}월 ${parseInt(d)}일`;
};
const _toKSTTime = (ms) => {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const _fmtDelta = (v) => `${v >= 0 ? "+" : ""}${formatG(v)}`;
const _deltaClass = (v) => v > 0 ? "pos" : v < 0 ? "neg" : "";

window.openBalanceHistoryModal = function() {
  const body = $("balanceHistoryBody");
  if (!body) return;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // 7일 내 거래 이벤트 생성
  const events = [];
  buyHistory.forEach((h) => {
    const at = toMillis(h.endedAt);
    if (!at || at < sevenDaysAgo) return;
    events.push({at, delta: -h.finalPrice, name: h.displayName, type: "buy"});
  });
  sellHistory.forEach((h) => {
    const at = toMillis(h.endedAt);
    if (!at || at < sevenDaysAgo) return;
    events.push({at, delta: Math.floor(h.finalPrice * 0.95), name: h.displayName, type: "sell"});
  });
  events.sort((a, b) => b.at - a.at);

  // 날짜별 이벤트 그룹
  const groups = {};
  events.forEach((e) => {
    const key = _toKSTDateKey(e.at);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  // 최근 7일 날짜 키 목록 (오늘 포함, 내림차순)
  const dayKeys = Array.from({length: 7}, (_, i) => {
    return _toKSTDateKey(now - i * 24 * 60 * 60 * 1000);
  });

  // 일별 순변화
  const dailyNet = dayKeys.map((key) => ({
    key,
    net: (groups[key] || []).reduce((s, e) => s + e.delta, 0),
  }));

  const totalNet = events.reduce((s, e) => s + e.delta, 0);

  _bhData = {events, groups, dayKeys, dailyNet, totalNet};

  body.innerHTML = `
    <div class="bh-tabs">
      <button class="bh-tab is-active" id="bhTab-transactions" onclick="switchBalanceTab('transactions')">지출/획득 내역</button>
      <button class="bh-tab" id="bhTab-summary" onclick="switchBalanceTab('summary')">총 잔액 변화</button>
    </div>
    <div id="bhTabContent"></div>`;

  _renderBalanceTab("transactions");
  $("balanceHistoryModal")?.classList.add("show");
};

async function _renderBalanceTab(tab) {
  const content = $("bhTabContent");
  if (!content || !_bhData) return;
  const {events, groups, dayKeys} = _bhData;

  if (tab === "transactions") {
    if (events.length === 0) {
      content.innerHTML = `<p class="balance-history-empty">최근 7일간 거래 내역이 없습니다.</p>`;
      return;
    }
    const usedKeys = dayKeys.filter((k) => groups[k]?.length);
    content.innerHTML = usedKeys.map((key) => {
      const items = groups[key].map((e) => `
        <div class="balance-history-item">
          <span class="balance-history-icon">${e.type === "sell" ? "💰" : "🛒"}</span>
          <span class="balance-history-name">${e.type === "sell" ? "판매" : "매입"} — ${escapeHtml(e.name)}</span>
          <span class="balance-history-time">${_toKSTTime(e.at)}</span>
          <span class="balance-history-delta ${_deltaClass(e.delta)}">${_fmtDelta(e.delta)}</span>
        </div>`).join("");
      return `<div class="balance-history-group">
        <div class="balance-history-date">${_toKSTDateLabel(key)}</div>
        ${items}
      </div>`;
    }).join("");

  } else {
    // 총 잔액 변화 탭 — Firestore balanceHistory 로드
    content.innerHTML = `<p class="bh-loading">불러오는 중...</p>`;
    const uid = auth.currentUser?.uid;
    if (!uid) { content.innerHTML = `<p class="balance-history-empty">로그인이 필요합니다.</p>`; return; }

    let entries = [];
    try {
      const histRef = collection(db, "users", uid, "balanceHistory");
      const snap = await getDocs(query(histRef, orderBy("at", "desc"), limit(200)));
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      entries = snap.docs
          .map((d) => {
            const data = d.data();
            return {...data, atMs: data.at?.toMillis?.() ?? 0};
          })
          .filter((e) => e.atMs >= sevenDaysAgo)
          .sort((a, b) => a.atMs - b.atMs); // 오래된 순
    } catch (e) {
      content.innerHTML = `<p class="balance-history-empty">불러오기 실패: ${e.message}</p>`;
      return;
    }

    if (entries.length === 0) {
      content.innerHTML = `<p class="balance-history-empty">최근 7일간 잔액 변화 기록이 없습니다.<br><small style="color:#4b5563">마이페이지 방문 시 자동으로 기록됩니다.</small></p>`;
      return;
    }

    // 순변화: 마지막 잔액 - (첫 번째 잔액 - 첫 번째 delta)
    const startBalance = entries[0].balance - (entries[0].delta ?? 0);
    const endBalance = entries[entries.length - 1].balance;
    const netChange = endBalance - startBalance;

    // 날짜별 그룹 (내림차순 표시)
    const histGroups = {};
    const histGroupOrder = [];
    [...entries].reverse().forEach((e) => {
      const key = _toKSTDateKey(e.atMs);
      if (!histGroups[key]) { histGroups[key] = []; histGroupOrder.push(key); }
      histGroups[key].push(e);
    });

    const listHtml = histGroupOrder.map((key) => {
      const rows = histGroups[key].map((e) => {
        const hasDelta = e.delta !== 0;
        return `
          <div class="bh-hist-item">
            <span class="bh-hist-time">${_toKSTTime(e.atMs)}</span>
            <span class="bh-hist-delta ${hasDelta ? _deltaClass(e.delta) : "zero"}">
              ${hasDelta ? _fmtDelta(e.delta) : "기록 시작"}
            </span>
            <span class="bh-hist-balance">${formatG(e.balance)}</span>
          </div>`;
      }).join("");
      return `<div class="balance-history-group">
        <div class="balance-history-date">${_toKSTDateLabel(key)}</div>
        ${rows}
      </div>`;
    }).join("");

    content.innerHTML = `
      <div class="bh-net-summary">
        <div>
          <div class="bh-net-label">7일 순변화</div>
          <div class="bh-net-value ${_deltaClass(netChange)}">${_fmtDelta(netChange)}</div>
        </div>
        <div style="text-align:right">
          <div class="bh-net-label">현재 잔액</div>
          <div class="bh-net-value">${formatG(endBalance)}</div>
        </div>
      </div>
      <div class="bh-hist-header">
        <span>시간</span><span>변화</span><span style="text-align:right">잔액</span>
      </div>
      <div class="balance-history-list">${listHtml}</div>`;
  }
}

window.switchBalanceTab = async function(tab) {
  ["transactions", "summary"].forEach((t) => {
    const btn = $(`bhTab-${t}`);
    if (btn) btn.classList.toggle("is-active", t === tab);
  });
  await _renderBalanceTab(tab);
};

window.closeBalanceHistoryModal = function() {
  $("balanceHistoryModal")?.classList.remove("show");
  _bhData = null;
};

function renderAuthArea() {
  const area = $("authArea");
  if (!area || !currentUserData) return;
  const name = currentUserData.displayName ||
    (currentUserData.authType === "anonymous" ? "익명 유저" : "유저");
  area.innerHTML = `
    <span class="auth-info">
      <strong>${escapeHtml(name)}</strong>
      <span style="color:#9ba3b4;font-size:.88rem">${formatG(currentUserData.balance ?? 0)}</span>
    </span>
    <a class="btn-secondary" href="shop.html" style="padding:5px 12px;font-size:.82rem">🛒 상점</a>
    ${currentUserData.authType === "anonymous"
      ? `<button onclick="handleGoogleLogin()" class="btn-primary" style="font-size:.82rem;padding:5px 12px">Google 로그인</button>`
      : `<button onclick="handleLogout()" class="btn-logout-header">로그아웃</button>`}`;
}

window.handleLogout = async function() {
  try {
    await logout();
    location.href = "index.html";
  } catch (e) {
    alert(`로그아웃 실패: ${e.message}`);
  }
};

window.handleGoogleLogin = async function() {
  try {
    const result = await linkAnonymousToGoogle();
    if (result.status !== "linked") await loginGoogle();
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") {
      alert(`로그인 실패: ${e.message}`);
    }
  }
};

// ===== 탭 전환 =====
window.switchTab = function(tab) {
  activeTab = tab;
  const wrap = $("historyTableWrap");
  if (wrap) wrap.innerHTML = renderHistoryTable();

  // 탭 버튼 active 갱신
  document.querySelectorAll(".my-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.textContent.startsWith(
        tab === "all" ? "전체" : tab === "buy" ? "매수" : "매도",
    ));
  });
};

// ===== 손절 경매 모달 =====
window.openSelloffModal = function(soopId, displayName, currentPrice) {
  const modal = $("registerModal");
  if (!modal) return;

  const soopInput = $("regSoopId");
  const nickInput = $("regNickname");
  const priceInput = $("regStartPrice");

  if (soopInput) { soopInput.value = soopId; soopInput.disabled = true; }
  if (nickInput) { nickInput.value = displayName; nickInput.disabled = true; }
  if (priceInput) priceInput.value = currentPrice || 50000;

  clearRegisterErrors();
  const img = $("registerProfileImg");
  const nameEl = $("registerName");
  const idEl = $("registerSoopId");
  if (nameEl) nameEl.textContent = displayName;
  if (idEl) idEl.textContent = `@${soopId}`;
  if (img && /^[a-zA-Z0-9]+$/.test(soopId)) {
    img.src = getSoopProfileUrl(soopId);
    img.style.display = "";
  }

  pendingRegisterData = {isSelloff: true, soopId, displayName};
  modal.classList.add("show");
};

window.closeRegisterModal = function() {
  const modal = $("registerModal");
  if (!modal) return;
  modal.classList.remove("show");
  const soopInput = $("regSoopId");
  const nickInput = $("regNickname");
  if (soopInput) soopInput.disabled = false;
  if (nickInput) nickInput.disabled = false;
};

function clearRegisterErrors() {
  ["regSoopIdError", "regNicknameError", "regStartPriceError"].forEach((id) => setText(id, ""));
}

window.updateProfilePreview = function() {};  // my.html에서는 soopId 고정

window.handleRegisterAuction = async function() {
  if (isRegistering) return;
  clearRegisterErrors();

  const soopId = $("regSoopId")?.value?.trim();
  const displayName = $("regNickname")?.value?.trim();
  const startPrice = parseInt($("regStartPrice")?.value || 0);

  if (!startPrice || startPrice < 50000) {
    setText("regStartPriceError", "시작가는 최소 50,000G입니다.");
    return;
  }
  if (currentUserData && currentUserData.balance < startPrice) {
    setText("regStartPriceError", `잔액 부족: 현재 ${formatG(currentUserData.balance)}`);
    return;
  }

  isRegistering = true;
  const btn = $("registerBtn");
  if (btn) { btn.disabled = true; btn.textContent = "등록 중..."; }

  try {
    const result = await registerAuction({
      soopId: soopId.toLowerCase(),
      displayName,
      startPrice,
      profileImageUrl: getSoopProfileUrl(soopId),
      type: "selloff",
    });

    closeRegisterModal();
    const msg = result.status === "started" ?
      "경매가 시작됐습니다! 🎉" : `대기열 ${result.queuePosition}번째에 등록됐습니다.`;
    alert(msg);

    // 데이터 새로고침
    await loadHoldings(auth.currentUser.uid);
    renderAll();
  } catch (e) {
    setText("regStartPriceError", e.message || "등록에 실패했습니다.");
  } finally {
    isRegistering = false;
    if (btn) { btn.disabled = false; btn.textContent = "경매 등록"; }
  }
};

// ===== 경매 요청 승인/거부 =====
window.handleApproveRequest = async function(requestId) {
  if (!confirm("경매 요청을 승인하시겠습니까?")) return;
  try {
    const result = await respondToAuctionRequest({requestId, action: "approve"});
    alert(result.status === "started" ? "경매가 시작됐습니다!" : "대기열에 등록됐습니다.");
    await loadHoldings(auth.currentUser.uid);
    renderAll();
  } catch (e) {
    alert(`승인 실패: ${e.message}`);
  }
};

window.handleRejectRequest = async function(requestId) {
  if (!confirm("경매 요청을 거부하시겠습니까?\n24시간 면역 기간이 설정됩니다.")) return;
  try {
    await respondToAuctionRequest({requestId, action: "reject"});
    await loadHoldings(auth.currentUser.uid);
    renderAll();
  } catch (e) {
    alert(`거부 실패: ${e.message}`);
  }
};

// ===== 닉네임 변경 =====
window.startEditNickname = function() {
  isEditingNickname = true;
  renderAll();
  const input = $("nicknameInput");
  if (input) { input.focus(); input.select(); }
};

window.cancelEditNickname = function() {
  isEditingNickname = false;
  renderAll();
};

window.saveNickname = async function() {
  const input = $("nicknameInput");
  const errEl = $("nicknameError");
  if (!input) return;

  const nickname = input.value.trim();
  if (nickname.length < 2 || nickname.length > 20) {
    if (errEl) errEl.textContent = "닉네임은 2~20자여야 합니다.";
    return;
  }

  const saveBtn = document.querySelector(".btn-nickname-save");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "저장 중..."; }

  try {
    const result = await updateUserNickname(nickname);
    currentUserData = {...currentUserData, displayName: result.displayName};
    isEditingNickname = false;
    renderAll();
    renderAuthArea();
  } catch (e) {
    if (errEl) errEl.textContent = e.message || "변경에 실패했습니다.";
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "저장"; }
  }
};

// ===== 금고 =====
window.openVaultPickerModal = function() {
  const uid = auth.currentUser?.uid;
  const available = myHoldings.filter((h) => h.vaultedBy !== uid && !h.isLocked);
  const list = $("vaultPickerList");
  if (!list) return;

  if (available.length === 0) {
    list.innerHTML = `
      <div class="vault-picker-empty">
        보관 가능한 매물이 없습니다.<br>
        경매 진행 중이 아닌 매물만 금고에 보관할 수 있습니다.
      </div>`;
  } else {
    list.innerHTML = `<div class="vault-picker-list">${available.map((h) => {
      const img = h.profileImageUrl || "assets/images/default-avatar.svg";
      return `
        <div class="vault-picker-item" onclick="pickVaultItem('${escapeHtml(h.id)}')">
          <img class="vault-picker-img" src="${img}"
            onerror="this.src='assets/images/default-avatar.svg'" alt="">
          <div class="vault-picker-info">
            <div class="vault-picker-name">${escapeHtml(h.displayName)}</div>
            <div class="vault-picker-id">@${escapeHtml(h.soopId)}</div>
            <div class="vault-picker-price">${formatG(h.currentPrice)}</div>
          </div>
          <span class="vault-picker-arrow">→</span>
        </div>`;
    }).join("")}</div>`;
  }

  $("vaultPickerModal")?.classList.add("show");
};

window.closeVaultPickerModal = function() {
  $("vaultPickerModal")?.classList.remove("show");
};

window.pickVaultItem = async function(listingId) {
  closeVaultPickerModal();
  await window.handleVaultListing(listingId);
};

window.handleVaultListing = async function(listingId) {
  try {
    await setVaultListingFn({listingId, action: "vault"});
    const holding = myHoldings.find((h) => h.id === listingId);
    if (holding) holding.vaultedBy = auth.currentUser?.uid;
    renderAll();
  } catch (e) {
    alert(`금고 보관 실패: ${e.message}`);
  }
};

window.handleUnvaultListing = async function(listingId) {
  try {
    await setVaultListingFn({listingId, action: "unvault"});
    const holding = myHoldings.find((h) => h.id === listingId);
    if (holding) holding.vaultedBy = null;
    renderAll();
  } catch (e) {
    alert(`인출 실패: ${e.message}`);
  }
};
