// ============================================
// shop.js - 상점 페이지
// ============================================

import {auth, db} from "./firebase-config.js";
import {doc, getDoc} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {watchAuthState} from "./auth.js";
import {purchaseShopItem, formatG} from "./auction.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};

// ===== 아이템 정의 =====
const SHOP_ITEMS = [
  {
    id: "liquidation_extension",
    icon: "🛡️",
    name: "강제청산 기간 연장권",
    cat: "protection",
    catLabel: "보호",
    price: 100000,
    priceLabel: "100,000G / 24h",
    desc: "보유 매물 1개의 강제청산 회신 기한을 24시간 연장합니다. 중복 구매로 누적 연장 가능.",
    needsTarget: true,
    targetType: "pendingRequest",
  },
  {
    id: "immunity_extension",
    icon: "🔰",
    name: "면역 연장권",
    cat: "protection",
    catLabel: "보호",
    price: 50000,
    priceLabel: "50,000G",
    desc: "유찰 후 면역 기간 중인 내 매물 1개의 면역을 24시간 연장합니다.",
    needsTarget: true,
    targetType: "immunity",
  },
  {
    id: "holding_limit_expansion",
    icon: "📦",
    name: "보유 한도 +1",
    cat: "trade",
    catLabel: "거래",
    price: 300000,
    priceLabel: "300,000G",
    desc: "계정 보유 매물 한도를 1칸 영구 확장합니다. Google 계정 전용.",
    needsTarget: false,
    googleOnly: true,
  },
  {
    id: "queue_priority_pass",
    icon: "⚡",
    name: "대기열 우선권 패스",
    cat: "trade",
    catLabel: "거래",
    price: 150000,
    priceLabel: "150,000G / 30일",
    desc: "30일간 등록하는 모든 경매를 대기열 맨 앞으로 이동합니다.",
    needsTarget: false,
    passField: "queuePriorityPassExpiresAt",
  },
  {
    id: "detail_view_pass",
    icon: "🔍",
    name: "상세 열람 패스",
    cat: "convenience",
    catLabel: "편의",
    price: 200000,
    priceLabel: "200,000G / 30일",
    desc: "30일간 모든 매물 상세 페이지를 무제한 열람합니다. (건당 50,000G 절약)",
    needsTarget: false,
    passField: "detailViewPassExpiresAt",
  },
  {
    id: "history_view_pass",
    icon: "📜",
    name: "히스토리 패스",
    cat: "convenience",
    catLabel: "편의",
    price: 200000,
    priceLabel: "200,000G / 30일",
    desc: "30일간 모든 경매 히스토리를 무제한 열람합니다. (건당 50,000G 절약)",
    needsTarget: false,
    passField: "historyViewPassExpiresAt",
  },
];

// ===== 상태 =====
let currentUserData = null;
let myHoldings = [];
let activeCategory = "all";
let pendingPurchase = null;
let isPurchasing = false;

// ===== 초기화 =====
watchAuthState(async (user) => {
  if (!user) {
    renderAuthArea();
    renderLoginPrompt();
    return;
  }
  await loadUserData(user.uid);
  renderAuthArea();
  renderShop();
});

async function loadUserData(uid) {
  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    if (!userSnap.exists()) return;
    currentUserData = userSnap.data();

    const ids = currentUserData.ownedListingIds || [];
    if (ids.length > 0) {
      const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, "listings", id))));
      myHoldings = snaps.filter((s) => s.exists()).map((s) => ({id: s.id, ...s.data()}));
    } else {
      myHoldings = [];
    }
  } catch (e) {
    console.error("유저 데이터 로드 실패:", e);
  }
}

// ===== 카테고리 필터 =====
window.setCategory = function(cat) {
  activeCategory = cat;
  document.querySelectorAll(".shop-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.cat === cat);
  });
  renderShop();
};

// ===== 렌더 =====
function renderShop() {
  const container = $("shopContent");
  if (!container) return;

  const filtered = activeCategory === "all"
    ? SHOP_ITEMS
    : SHOP_ITEMS.filter((it) => it.cat === activeCategory);

  container.innerHTML = `<div class="shop-grid">${filtered.map(renderCard).join("")}</div>`;
}

function renderCard(item) {
  const balance = currentUserData?.balance ?? 0;
  const canAfford = balance >= item.price;

  const isGoogle = currentUserData?.authType === "google";
  const disabled = !currentUserData || (item.googleOnly && !isGoogle);

  // 패스 보유 여부
  let ownedBadge = "";
  if (item.passField && currentUserData?.[item.passField]) {
    const exp = currentUserData[item.passField];
    if (exp > Date.now()) {
      const days = Math.ceil((exp - Date.now()) / (1000 * 60 * 60 * 24));
      ownedBadge = `
        <div>
          <div class="shop-owned-badge">✅ 보유 중</div>
          <div class="shop-owned-exp">만료 ${days}일 후 · 재구매 시 연장</div>
        </div>`;
    }
  }

  const btnLabel = !currentUserData ? "로그인 필요"
    : (item.googleOnly && !isGoogle) ? "Google 전용"
    : !canAfford ? "잔액 부족"
    : "구매";
  const btnCls = (!canAfford || disabled) ? "btn-shop-buy insufficient" : "btn-shop-buy";
  const btnDisabled = (!canAfford || disabled) ? "disabled" : "";

  return `
    <div class="shop-card${ownedBadge ? " owned" : ""}">
      <div class="shop-card-top">
        <div class="shop-card-icon">${item.icon}</div>
        <div class="shop-card-info">
          <div class="shop-card-name">${escapeHtml(item.name)}</div>
          <span class="shop-card-cat ${item.cat}">${item.catLabel}</span>
        </div>
      </div>
      <div class="shop-card-desc">${escapeHtml(item.desc)}</div>
      <div class="shop-card-footer">
        <div>
          <div class="shop-card-price">${item.priceLabel}</div>
          ${ownedBadge}
        </div>
        <button class="${btnCls}" ${btnDisabled}
          onclick="openPurchaseModal('${item.id}')">${btnLabel}</button>
      </div>
    </div>`;
}

// ===== 구매 모달 =====
window.openPurchaseModal = function(itemId) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item || !currentUserData) return;

  pendingPurchase = {item, targetListingId: null};

  const preview = $("purchasePreview");
  if (preview) {
    preview.innerHTML = `
      <div class="purchase-item-icon">${item.icon}</div>
      <div>
        <div class="purchase-item-name">${escapeHtml(item.name)}</div>
        <div class="purchase-item-effect">${escapeHtml(item.desc)}</div>
      </div>`;
  }

  // 대상 매물 선택 필드
  const targetWrap = $("targetListingWrap");
  const targetSelect = $("targetListingSelect");
  if (item.needsTarget && targetWrap && targetSelect) {
    targetWrap.style.display = "block";
    const eligible = myHoldings.filter((h) => {
      if (item.targetType === "pendingRequest") return !!h.pendingRequestId;
      if (item.targetType === "immunity") return h.immunityUntil && h.immunityUntil > Date.now();
      return false;
    });
    if (eligible.length === 0) {
      targetSelect.innerHTML = `<option value="">해당 조건의 매물 없음</option>`;
    } else {
      targetSelect.innerHTML = eligible.map((h) =>
        `<option value="${escapeHtml(h.id)}">${escapeHtml(h.displayName)} (@${escapeHtml(h.soopId)})</option>`
      ).join("");
      pendingPurchase.targetListingId = eligible[0].id;
    }
    targetSelect.onchange = () => {
      pendingPurchase.targetListingId = targetSelect.value || null;
      updatePurchaseBalancePreview();
    };
  } else if (targetWrap) {
    targetWrap.style.display = "none";
  }

  setText("purchaseModalTitle", item.name + " 구매");
  setText("targetListingError", "");
  updatePurchaseBalancePreview();
  $("purchaseModal")?.classList.add("show");
};

function updatePurchaseBalancePreview() {
  const item = pendingPurchase?.item;
  if (!item || !currentUserData) return;
  const after = (currentUserData.balance || 0) - item.price;
  setText("purchaseCostValue", `-${formatG(item.price)}`);
  setText("purchaseAfterBalance", formatG(Math.max(after, 0)));
}

window.closePurchaseModal = function() {
  $("purchaseModal")?.classList.remove("show");
  pendingPurchase = null;
};

window.confirmPurchase = async function() {
  if (isPurchasing || !pendingPurchase) return;
  const {item, targetListingId} = pendingPurchase;

  if (item.needsTarget && !targetListingId) {
    setText("targetListingError", "대상 매물을 선택해주세요.");
    return;
  }

  isPurchasing = true;
  const btn = $("purchaseConfirmBtn");
  if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }

  try {
    const result = await purchaseShopItem(item.id, targetListingId);
    // 전체 유저 데이터 재로드 (패스 만료일·한도 등 반영)
    await loadUserData(auth.currentUser.uid);
    if (currentUserData) currentUserData.balance = result.newBalance;
    closePurchaseModal();
    showToast(`${item.name} 구매 완료! 잔액: ${formatG(result.newBalance)}`);
    renderShop();
    renderAuthArea();
  } catch (e) {
    setText("targetListingError", e.message || "구매에 실패했습니다.");
  } finally {
    isPurchasing = false;
    if (btn) { btn.disabled = false; btn.textContent = "구매 확인"; }
  }
};

// ===== Auth Area =====
function renderAuthArea() {
  const area = $("authArea");
  if (!area) return;
  const user = auth.currentUser;
  if (!user) {
    area.innerHTML = `<a class="btn-login" href="index.html">로그인</a>`;
    return;
  }
  const name = currentUserData?.displayName || "유저";
  area.innerHTML = `
    <span class="auth-info">
      <strong>${escapeHtml(name)}</strong>
      <span style="color:#9ba3b4;font-size:.88rem">${formatG(currentUserData?.balance ?? 0)}</span>
    </span>
    <a class="btn-secondary" href="my.html" style="padding:5px 12px;font-size:.82rem">마이페이지</a>`;
}

function renderLoginPrompt() {
  const container = $("shopContent");
  if (!container) return;
  container.innerHTML = `
    <div class="shop-login-prompt">
      <p style="margin-bottom:16px">상점을 이용하려면 로그인이 필요합니다.</p>
      <a class="btn-primary" href="index.html" style="display:inline-block;padding:10px 24px">메인으로 이동</a>
    </div>`;
}

// ===== 토스트 =====
function showToast(msg) {
  const container = $("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
