// ============================================
// listing.js - 매물 상세 페이지
// ============================================

import {auth, db, functions} from "./firebase-config.js";
import {
  doc, getDoc,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";
import {watchAuthState, logout} from "./auth.js";
import {
  registerAuction, requestAuction, respondToAuctionRequest,
  reportListing, blockListing, viewAuctionHistory, viewListingDetail,
  formatG, validateSoopId, validateNickname, getSoopProfileUrl,
} from "./auction.js";

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

// ===== 상태 =====
let currentUserData = null;
let currentListing = null;
let pendingRequest = null;
let pendingReportListingId = null;
let pendingReportListingName = null;
let pendingRegisterData = {};
let isRegistering = false;
let isPaid = false;  // 50,000G 상세 열람 여부

// ===== CF 참조 =====
const initializeUserFn = httpsCallable(functions, "initializeUser");

// ===== URL 파라미터 =====
const listingId = new URLSearchParams(location.search).get("id");
if (!listingId) location.replace("index.html");

// ===== 초기화 =====
async function init() {
  // 매물 먼저 로드 (비로그인도 볼 수 있음)
  await loadListing();

  watchAuthState(async (user) => {
    if (user) {
      try {
        const res = await initializeUserFn();
        currentUserData = res.data;
      } catch (e) {
        console.error("initializeUser 실패:", e);
        currentUserData = null;
      }
    } else {
      currentUserData = null;
    }
    renderAuthArea();
    renderView();
  });
}

// ===== 매물 로드 =====
async function loadListing() {
  try {
    const snap = await getDoc(doc(db, "listings", listingId));
    if (snap.exists()) {
      currentListing = {id: snap.id, ...snap.data()};
      document.title = `${currentListing.displayName} - StreamAuction`;
    } else {
      currentListing = null;
    }
  } catch (e) {
    console.error("매물 로드 실패:", e);
    currentListing = null;
  }
}

// ===== 매물 새로고침 (isPaid 유지) =====
async function refreshListing() {
  await loadListing();
  pendingRequest = null;
  if (isPaid) await loadPendingRequest();
  isPaid ? renderDetail() : renderView();
}

// ===== 뷰 라우터 (게이트 or 상세) =====
function renderView() {
  if (!isPaid) {
    renderGate();
  } else {
    renderDetail();
  }
}

// ===== 게이트 화면 =====
function renderGate() {
  const container = $("listingContent");
  if (!container) return;

  if (!currentListing) {
    container.innerHTML = `<div class="listing-error">매물을 찾을 수 없습니다.<br><a href="index.html" style="color:#f5d142">메인으로 돌아가기</a></div>`;
    return;
  }

  const listing = currentListing;
  const COST = 50000;
  const balance = currentUserData?.balance ?? 0;
  const imgSrc = listing.profileImageUrl || "assets/images/default-avatar.svg";
  const imgClass = listing.isMosaicked ? "listing-hero-img img-mosaic" : "listing-hero-img";

  let actionHtml;
  if (!currentUserData) {
    actionHtml = `<p class="gate-notice">로그인 후 이용할 수 있습니다</p>`;
  } else if (balance < COST) {
    actionHtml = `<p class="gate-notice">잔액 부족 · 보유 ${formatG(balance)} / 필요 ${formatG(COST)}</p>`;
  } else {
    actionHtml = `
      <button class="btn-pay-gate" id="btnPayGate" onclick="handlePayToView()">
        상세 정보 확인하기 · <span class="gate-cost-badge">50,000G</span>
      </button>
      <p class="gate-balance-hint">내 잔액: ${formatG(balance)}</p>`;
  }

  container.innerHTML = `
    <div class="listing-card">
      <div class="listing-hero">
        <div class="listing-hero-img-wrap">
          <img class="${imgClass}" src="${imgSrc}" alt="프로필"
            onerror="this.src='assets/images/default-avatar.svg'">
          ${listing.isMosaicked ? `<div class="listing-mosaic-label">신고됨</div>` : ""}
        </div>
        <div class="listing-hero-info">
          <div class="listing-hero-name">${escapeHtml(listing.displayName)}</div>
          <div class="listing-hero-id">@${escapeHtml(listing.soopId)}</div>
        </div>
      </div>
      <div class="listing-gate">
        <div class="gate-lock">🔒</div>
        <div class="gate-title">상세 정보 열람</div>
        <div class="gate-desc">시세 통계, 거래 기록, 액션 버튼을 확인하려면<br><strong>50,000G</strong>가 필요합니다</div>
        ${actionHtml}
      </div>
    </div>`;
}

// ===== pendingRequest 로드 =====
async function loadPendingRequest() {
  if (!currentListing?.pendingRequestId || !auth.currentUser) return;
  const uid = auth.currentUser.uid;
  // 보유자거나 요청자인 경우에만 읽기 가능
  if (currentListing.ownerId !== uid) return;
  try {
    const snap = await getDoc(doc(db, "auctionRequests", currentListing.pendingRequestId));
    if (snap.exists()) {
      pendingRequest = {id: snap.id, ...snap.data()};
    }
  } catch (e) {
    // 권한 없으면 무시
  }
}

// ===== 헤더 인증 영역 =====
function renderAuthArea() {
  const area = $("authArea");
  if (!area) return;

  if (!currentUserData) {
    area.innerHTML = `<span class="auth-info" style="color:#9ba3b4;font-size:.9rem">비로그인</span>`;
    return;
  }

  const name = currentUserData.displayName || (currentUserData.authType === "anonymous" ? "익명 유저" : "유저");
  area.innerHTML = `
    <a href="my.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px">마이페이지</a>
    <span class="auth-info">
      <strong>${escapeHtml(name)}</strong>
      <span style="color:#9ba3b4;font-size:.88rem">${formatG(currentUserData.balance ?? 0)}</span>
    </span>`;
}

// ===== 상세 열람 결제 =====
window.handlePayToView = async function() {
  const btn = $("btnPayGate");
  if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
  try {
    const result = await viewListingDetail(listingId);
    if (currentUserData) currentUserData.balance = result.newBalance;
    isPaid = true;
    renderAuthArea();
    await renderDetail();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `상세 정보 확인하기 · <span class="gate-cost-badge">50,000G</span>`;
    }
    alert(`열람 실패: ${e.message}`);
  }
};

// ===== 메인 렌더 =====
async function renderDetail() {
  const container = $("listingContent");
  if (!container) return;

  if (!currentListing) {
    container.innerHTML = `<div class="listing-error">매물을 찾을 수 없습니다.<br><a href="index.html" style="color:#f5d142">메인으로 돌아가기</a></div>`;
    return;
  }

  const listing = currentListing;
  const uid = auth.currentUser?.uid;
  const isOwnedByMe = !!(listing.ownerId && listing.ownerId === uid);
  const isAnonymous = currentUserData?.authType === "anonymous";

  // pendingRequest 로드 (보유자인 경우)
  if (isOwnedByMe && listing.pendingRequestId && !pendingRequest) {
    await loadPendingRequest();
  }

  // 차단 여부
  const isBlocked = (currentUserData?.blockedListingIds || []).includes(listing.id);
  if (isBlocked) {
    container.innerHTML = `
      <div class="listing-card">
        <div class="listing-blocked">
          <div class="listing-blocked-icon">🚫</div>
          <div class="listing-blocked-msg">차단한 매물입니다</div>
          <div class="listing-blocked-name">${escapeHtml(listing.displayName)}</div>
          <button class="btn-secondary" onclick="handleBlockListing('${escapeHtml(listing.id)}', false)">차단 해제</button>
        </div>
      </div>`;
    return;
  }

  // ── 1. 히어로 섹션 ──
  const imgClass = listing.isMosaicked ? "listing-hero-img img-mosaic" : "listing-hero-img";
  const imgSrc = listing.profileImageUrl || "assets/images/default-avatar.svg";
  const mosaicLabel = listing.isMosaicked ? `<div class="listing-mosaic-label">신고됨</div>` : "";
  const liveBadge = listing.isLocked ? `<span class="listing-live-badge">🔴 경매 진행 중</span>` : "";

  const heroHtml = `
    <div class="listing-hero">
      <div class="listing-hero-img-wrap">
        <img class="${imgClass}" src="${imgSrc}" alt="프로필"
          onerror="this.src='assets/images/default-avatar.svg'">
        ${mosaicLabel}
      </div>
      <div class="listing-hero-info">
        <div class="listing-hero-name">${escapeHtml(listing.displayName)}</div>
        <div class="listing-hero-id">@${escapeHtml(listing.soopId)}</div>
      </div>
      ${liveBadge}
    </div>`;

  // ── 2. 스탯 섹션 ──
  const tradeCount = listing.totalTradeCount || 0;
  const hasHistory = tradeCount > 0;

  const statsHtml = `
    <div class="listing-stats">
      <div class="listing-stat">
        <div class="listing-stat-label">현재 시세</div>
        <div class="listing-stat-value accent">${formatG(listing.currentPrice)}</div>
      </div>
      <div class="listing-stat">
        <div class="listing-stat-label">역대 최고가</div>
        <div class="listing-stat-value up">${hasHistory ? formatG(listing.highestPrice) : "-"}</div>
      </div>
      <div class="listing-stat">
        <div class="listing-stat-label">역대 최저가</div>
        <div class="listing-stat-value down">${hasHistory ? formatG(listing.lowestPrice) : "-"}</div>
      </div>
      <div class="listing-stat">
        <div class="listing-stat-label">총 거래량</div>
        <div class="listing-stat-value">${hasHistory ? formatG(listing.totalTradeVolume || 0) : "-"}</div>
      </div>
      <div class="listing-stat">
        <div class="listing-stat-label">거래 횟수</div>
        <div class="listing-stat-value">${tradeCount}회</div>
      </div>
      <div class="listing-stat">
        <div class="listing-stat-label">마지막 거래</div>
        <div class="listing-stat-value muted">${hasHistory ? formatRelTime(toMillis(listing.lastTradedAt)) : "-"}</div>
      </div>
    </div>`;

  // ── 3. 경매 진행 중 배너 ──
  const liveBannerHtml = listing.isLocked ? `
    <div class="listing-live-banner">
      <span class="listing-live-banner-text">🔴 지금 경매가 진행 중입니다 — 메인 페이지에서 입찰하세요</span>
      <a class="btn-go-main" href="index.html">입찰하러 가기 →</a>
    </div>` : "";

  // ── 4. 액션 섹션 ──
  let ownerBadge = "";
  let actionBtns = "";

  if (isOwnedByMe) {
    ownerBadge = `<span class="listing-owner-badge is-mine">내 매물</span>`;
    if (!listing.isLocked) {
      if (pendingRequest) {
        // 경매 요청 승인/거부
        actionBtns = `
          <div class="listing-pending-request">
            <span class="listing-pending-request-text">📨 경매 요청이 들어왔습니다</span>
            <div class="listing-pending-actions">
              <button class="btn-primary" onclick="handleApproveRequest('${escapeHtml(pendingRequest.id)}')">승인</button>
              <button class="btn-secondary" onclick="handleRejectRequest('${escapeHtml(pendingRequest.id)}')">거부</button>
            </div>
          </div>`;
      } else {
        actionBtns = `
          <button class="btn-selloff"
            onclick="openRegisterModal('${escapeHtml(listing.soopId)}','${escapeHtml(listing.displayName)}',true,${listing.currentPrice||50000})">
            손절 경매 등록
          </button>`;
      }
    }
  } else if (!listing.ownerId) {
    ownerBadge = `<span class="listing-owner-badge no-owner">주인 없음</span>`;
    if (!listing.isLocked) {
      actionBtns = `
        <button class="btn-primary"
          onclick="openRegisterModal('${escapeHtml(listing.soopId)}','${escapeHtml(listing.displayName)}')">
          경매 등록
        </button>`;
    }
  } else {
    ownerBadge = `<span class="listing-owner-badge has-owner">보유자 있음</span>`;
    if (!listing.isLocked && uid) {
      if (isAnonymous) {
        actionBtns = `<span class="request-status-badge">경매 요청은 Google 계정만 가능합니다</span>`;
      } else if (listing.pendingRequestId) {
        actionBtns = `<span class="request-status-badge">요청 접수됨 · 보유자 응답 대기 중</span>`;
      } else if (listing.immunityUntil && Date.now() < listing.immunityUntil) {
        const mins = Math.ceil((listing.immunityUntil - Date.now()) / 60000);
        actionBtns = `<span class="request-status-badge immunity">유찰 면역 중 (${mins}분 후 요청 가능)</span>`;
      } else {
        actionBtns = `
          <button class="btn-request"
            onclick="handleRequestAuction('${escapeHtml(listing.id)}')">
            경매 요청 보내기
          </button>`;
      }
    }
  }

  const actionsHtml = `
    <div class="listing-actions-section">
      ${ownerBadge}
      ${actionBtns}
    </div>`;

  // ── 5. 히스토리 행 ──
  const historyHtml = `
    <div class="listing-history-section">
      <div class="history-row">
        <button class="btn-history"
          onclick="handleViewHistory('${escapeHtml(listing.id)}','${escapeHtml(listing.displayName)}')">
          경매 히스토리 열람 <span class="history-cost">50,000G</span>
        </button>
      </div>
    </div>`;

  // ── 6. 신고/차단 ──
  const reportHtml = !isOwnedByMe ? `
    <div class="listing-report-section">
      <button class="btn-block-listing" onclick="handleBlockListing('${escapeHtml(listing.id)}', true)">차단</button>
      <button class="btn-report-listing" onclick="openReportModal('${escapeHtml(listing.id)}','${escapeHtml(listing.displayName)}')">신고</button>
    </div>` : "";

  // ── 7. 메타 ──
  const createdMs = toMillis(listing.createdAt);
  const metaHtml = createdMs ? `
    <div class="listing-meta">등록일 ${new Date(createdMs).toLocaleDateString("ko-KR")}</div>` : "";

  container.innerHTML = `
    <div class="listing-card">
      ${heroHtml}
      ${statsHtml}
      ${liveBannerHtml}
      ${actionsHtml}
      ${historyHtml}
      ${reportHtml}
      ${metaHtml}
    </div>`;
}

// ===== 유틸 =====
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

function toMillis(val) {
  if (!val) return null;
  if (typeof val === "number") return val;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (val.seconds) return val.seconds * 1000;
  return null;
}

function formatRelTime(ms) {
  if (!ms) return "-";
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return "방금 전";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전`;
  return new Date(ms).toLocaleDateString("ko-KR");
}

function renderBalance() {
  renderAuthArea();
}

// ===== 경매 등록 모달 =====
window.openRegisterModal = function(soopId = "", displayName = "", isSelloff = false, currentPrice = null) {
  if (!currentUserData) { alert("로그인이 필요합니다."); return; }
  const modal = $("registerModal");
  if (!modal) return;

  const soopInput = $("regSoopId");
  const nickInput = $("regNickname");
  const priceInput = $("regStartPrice");
  const titleEl = modal.querySelector(".modal-header h2");
  const noticeList = $("registerNoticeList");

  if (soopInput) { soopInput.value = soopId; soopInput.disabled = isSelloff; }
  if (nickInput) { nickInput.value = displayName; nickInput.disabled = isSelloff; }
  if (priceInput) priceInput.value = isSelloff && currentPrice ? currentPrice : 50000;
  if (titleEl) titleEl.textContent = isSelloff ? "손절 경매 등록" : "경매 등록";
  if (noticeList) {
    noticeList.innerHTML = isSelloff ? `
      <li>낙찰 시 낙찰가의 <strong>95%</strong>가 즉시 지급됩니다 (수수료 5%)</li>
      <li>유찰 시 경매가 취소되고 <strong>매물은 그대로 유지</strong>됩니다</li>
      <li>등록 후 취소는 불가합니다</li>` : `
      <li>유찰 시 시작가로 자동 낙찰됩니다</li>
      <li>잔액에서 시작가가 차감될 수 있습니다</li>
      <li>등록 후 취소는 불가합니다</li>`;
  }

  clearRegisterErrors();
  updateProfilePreview();
  pendingRegisterData = {isSelloff};
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

window.handleRegisterAuction = async function() {
  if (isRegistering) return;
  clearRegisterErrors();

  const soopId = $("regSoopId")?.value?.trim();
  const displayName = $("regNickname")?.value?.trim();
  const startPrice = parseInt($("regStartPrice")?.value || 0);

  let hasError = false;
  const soopIdErr = validateSoopId(soopId);
  if (soopIdErr) { setText("regSoopIdError", soopIdErr); hasError = true; }
  const nickErr = validateNickname(displayName);
  if (nickErr) { setText("regNicknameError", nickErr); hasError = true; }
  if (!startPrice || startPrice < 50000) {
    setText("regStartPriceError", "시작가는 최소 50,000G입니다.");
    hasError = true;
  }
  if (hasError) return;

  if (currentUserData && currentUserData.balance < startPrice) {
    setText("regStartPriceError", `잔액 부족: 현재 ${formatG(currentUserData.balance)}`);
    return;
  }
  if (currentUserData && currentUserData.ownedCount >= currentUserData.ownedLimit) {
    setText("regNicknameError", `보유 한도 초과 (${currentUserData.ownedLimit}개 한도)`);
    return;
  }

  isRegistering = true;
  const btn = $("registerBtn");
  if (btn) { btn.disabled = true; btn.textContent = "등록 중..."; }

  try {
    const isSelloff = pendingRegisterData?.isSelloff;
    const result = await registerAuction({
      soopId: soopId.toLowerCase(),
      displayName,
      startPrice,
      profileImageUrl: getSoopProfileUrl(soopId),
      type: isSelloff ? "selloff" : "new",
    });

    closeRegisterModal();
    const msg = result.status === "started" ?
      "경매가 시작됐습니다! 🎉" :
      `대기열 ${result.queuePosition}번째에 등록됐습니다.`;
    alert(msg);
    await refreshListing();
  } catch (e) {
    if (e.message.includes("재등록")) {
      setText("regSoopIdError", e.message);
    } else if (e.message.includes("한도")) {
      setText("regNicknameError", e.message);
    } else {
      setText("regStartPriceError", e.message || "등록에 실패했습니다.");
    }
  } finally {
    isRegistering = false;
    if (btn) { btn.disabled = false; btn.textContent = "경매 등록"; }
  }
};

// ===== 경매 요청 =====
window.handleRequestAuction = async function(lid) {
  try {
    await requestAuction(lid);
    await refreshListing();
  } catch (e) {
    alert(`경매 요청 실패: ${e.message}`);
  }
};

window.handleApproveRequest = async function(requestId) {
  if (!confirm("경매 요청을 승인하시겠습니까?\n경매가 대기열에 등록됩니다.")) return;
  try {
    const result = await respondToAuctionRequest({requestId, action: "approve"});
    alert(result.status === "started" ? "경매가 시작됐습니다!" : "대기열에 등록됐습니다.");
    pendingRequest = null;
    await refreshListing();
  } catch (e) {
    alert(`승인 실패: ${e.message}`);
  }
};

window.handleRejectRequest = async function(requestId) {
  if (!confirm("경매 요청을 거부하시겠습니까?\n24시간 면역 기간이 설정됩니다.")) return;
  try {
    await respondToAuctionRequest({requestId, action: "reject"});
    pendingRequest = null;
    await refreshListing();
  } catch (e) {
    alert(`거부 실패: ${e.message}`);
  }
};

// ===== 신고 모달 =====
window.openReportModal = function(lid, displayName) {
  if (currentUserData?.authType === "anonymous") {
    alert("신고는 Google 계정만 가능합니다.\n구글 로그인 후 이용해주세요.");
    return;
  }
  pendingReportListingId = lid;
  pendingReportListingName = displayName;
  const modal = $("reportModal");
  if (!modal) return;
  setText("reportTargetName", `"${displayName}" 을(를) 신고하는 이유를 선택해주세요.`);
  document.querySelectorAll("input[name=\"reportReason\"]").forEach((r) => { r.checked = false; });
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
  const reason = document.querySelector("input[name=\"reportReason\"]:checked")?.value;
  if (!reason) { setText("reportError", "신고 사유를 선택해주세요."); return; }
  if (!pendingReportListingId) return;

  const btn = $("reportSubmitBtn");
  if (btn) { btn.disabled = true; btn.textContent = "제출 중..."; }

  try {
    await reportListing({listingId: pendingReportListingId, reason});
    closeReportModal();
    alert("신고가 접수됐습니다. 검토 후 조치하겠습니다.");
  } catch (e) {
    setText("reportError", e.message.includes("이미") ? "이미 신고한 매물입니다." : e.message);
    if (btn) { btn.disabled = false; btn.textContent = "신고 제출"; }
  }
};

// ===== 차단 / 해제 =====
window.handleBlockListing = async function(lid, block) {
  if (!currentUserData) { alert("로그인이 필요합니다."); return; }
  const label = block ? "차단" : "차단 해제";
  if (!confirm(`이 매물을 ${label}하시겠습니까?`)) return;
  try {
    await blockListing({listingId: lid, block});
    if (currentUserData) {
      if (!currentUserData.blockedListingIds) currentUserData.blockedListingIds = [];
      if (block) {
        currentUserData.blockedListingIds.push(lid);
      } else {
        currentUserData.blockedListingIds = currentUserData.blockedListingIds.filter((id) => id !== lid);
      }
    }
    renderDetail();
  } catch (e) {
    alert(`${label} 실패: ${e.message}`);
  }
};

// ===== 경매 히스토리 열람 =====
window.handleViewHistory = async function(lid, displayName) {
  if (!currentUserData) { alert("로그인이 필요합니다."); return; }
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
    const result = await viewAuctionHistory(lid);
    if (currentUserData) currentUserData.balance = result.newBalance;
    renderBalance();

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
          <thead><tr><th>날짜</th><th>유형</th><th>시작가</th><th>최종가</th><th>입찰 수</th><th>결과</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    body.innerHTML = `<p class="history-error">${escapeHtml(e.message)}</p>`;
  }
};

window.closeHistoryModal = function() {
  const modal = $("historyModal");
  if (modal) modal.classList.remove("show");
};

// ===== 시작 =====
init();
