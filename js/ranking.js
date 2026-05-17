import {auth, db, functions} from "./firebase-config.js";
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";
import {watchAuthState} from "./auth.js";
import {formatG} from "./auction.js";

const viewRankingFn = httpsCallable(functions, "viewRanking");

const $ = (id) => document.getElementById(id);
const MEDALS = ["🥇", "🥈", "🥉"];
const COST = 50000;

let currentTab = "price";
let rankingData = null;
let blockedIds = [];
let currentBalance = 0;
let isLoading = false;
let hasLoaded = false; // 결제 모달·페이지 초기화 중복 방지

// ===== 인증 상태 감지 =====
watchAuthState(async (user) => {
  if (!user || hasLoaded) return;

  if (user.isAnonymous) {
    hasLoaded = true;
    $("rankingContent").innerHTML = "";
    $("loginRequiredModal").classList.add("show");
    return;
  }

  hasLoaded = true;

  // 구글 유저: Firestore에서 잔액·차단 목록 조회 후 결제 모달 표시
  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) {
      const userData = userSnap.data();
      currentBalance = userData.balance || 0;
      blockedIds = userData.blockedListingIds || [];
      updateAuthArea(user.displayName, currentBalance);

      const preview = $("payBalancePreview");
      if (preview) {
        preview.textContent = `현재 잔액: ${formatG(currentBalance)} → 차감 후: ${formatG(currentBalance - COST)}`;
      }

      if (currentBalance < COST) {
        const payError = $("payError");
        if (payError) {
          payError.textContent = `잔액이 부족합니다. (보유: ${formatG(currentBalance)})`;
          payError.style.display = "";
        }
        const btn = $("btnConfirmPay");
        if (btn) btn.disabled = true;
      }
    }
  } catch (_) {}

  $("payModal").classList.add("show");
});

// ===== 결제 확인 =====
window.confirmViewRanking = async function() {
  if (isLoading) return;
  isLoading = true;

  const btn = $("btnConfirmPay");
  if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }

  try {
    const result = await viewRankingFn();
    const data = result.data;

    currentBalance = data.newBalance;
    rankingData = {
      byPrice: data.byPrice,
      byTrade: data.byTrade,
      byHighest: data.byHighest,
    };

    updateAuthArea(auth.currentUser?.displayName, currentBalance);
    $("payModal").classList.remove("show");
    renderPage();
  } catch (e) {
    const payError = $("payError");
    if (payError) {
      payError.textContent = e.message || "오류가 발생했습니다.";
      payError.style.display = "";
    }
    if (btn) { btn.disabled = false; btn.textContent = "50,000G 차감하고 열람"; }
  } finally {
    isLoading = false;
  }
};

// ===== 탭 전환 =====
window.setTab = function(tab) {
  currentTab = tab;
  document.querySelectorAll(".ranking-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  renderTable();
};

// ===== 새로고침 (무료 재조회) =====
window.refreshRanking = async function() {
  if (isLoading) return;
  isLoading = true;

  const btn = $("btnRefresh");
  if (btn) { btn.disabled = true; btn.textContent = "새로고침 중..."; }

  try {
    const [priceSnap, tradeSnap, highestSnap] = await Promise.all([
      getDocs(query(collection(db, "listings"), where("currentPrice", ">", 0), orderBy("currentPrice", "desc"), limit(50))),
      getDocs(query(collection(db, "listings"), where("totalTradeCount", ">", 0), orderBy("totalTradeCount", "desc"), limit(50))),
      getDocs(query(collection(db, "listings"), where("highestPrice", ">", 0), orderBy("highestPrice", "desc"), limit(50))),
    ]);

    const toItem = (d) => ({
      listingId: d.id,
      soopId: d.data().soopId,
      displayName: d.data().displayName,
      profileImageUrl: d.data().profileImageUrl || null,
      currentPrice: d.data().currentPrice || 0,
      totalTradeCount: d.data().totalTradeCount || 0,
      highestPrice: d.data().highestPrice || 0,
      ownerId: d.data().ownerId || null,
      ownerName: d.data().ownerName || null,
      isMosaicked: d.data().isMosaicked || false,
    });

    rankingData = {
      byPrice: priceSnap.docs.map(toItem),
      byTrade: tradeSnap.docs.map(toItem),
      byHighest: highestSnap.docs.map(toItem),
    };

    renderTable();
  } catch (e) {
    console.error("새로고침 실패:", e);
  } finally {
    isLoading = false;
    if (btn) { btn.disabled = false; btn.textContent = "🔄 새로고침"; }
  }
};

// ===== 페이지 렌더링 =====
function renderPage() {
  const content = $("rankingContent");
  if (!content) return;

  content.innerHTML = `
    <div class="ranking-tabs">
      <button class="ranking-tab active" data-tab="price" onclick="setTab('price')">시세 순위</button>
      <button class="ranking-tab" data-tab="trade" onclick="setTab('trade')">거래 횟수 순위</button>
      <button class="ranking-tab" data-tab="highest" onclick="setTab('highest')">역대 최고가 순위</button>
    </div>
    <div class="ranking-cost-notice">50,000G 차감됨 · 잔액 ${formatG(currentBalance)}</div>
    <div id="rankingTableWrap"></div>
    <div class="ranking-refresh-row">
      <button class="btn-refresh" id="btnRefresh" onclick="refreshRanking()">🔄 새로고침</button>
    </div>
  `;

  renderTable();
}

function renderTable() {
  const wrap = $("rankingTableWrap");
  if (!wrap || !rankingData) return;

  let items = [];
  if (currentTab === "price") items = rankingData.byPrice;
  else if (currentTab === "trade") items = rankingData.byTrade;
  else items = rankingData.byHighest;

  const filtered = items.filter((item) => !blockedIds.includes(item.listingId));

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="ranking-empty">표시할 매물이 없습니다.</div>`;
    return;
  }

  const rows = filtered.map((item, i) => {
    const rank = i + 1;
    const medalHtml = rank <= 3
      ? `<span class="rank-medal">${MEDALS[rank - 1]}</span>`
      : `<span class="rank-number">${rank}</span>`;

    const nameHtml = item.isMosaicked
      ? `<span class="mosaic-text">${escapeHtml(item.displayName)}</span><span class="mosaic-badge">신고됨</span>`
      : escapeHtml(item.displayName);
    const soopIdHtml = item.isMosaicked
      ? `<span class="mosaic-text">@${escapeHtml(item.soopId)}</span>`
      : `@${escapeHtml(item.soopId)}`;

    const img = item.profileImageUrl || "assets/images/default-avatar.svg";
    const owner = item.ownerId ? (item.ownerName || "익명") : "미보유";

    const priceClass = currentTab === "price" ? "highlight" : "";
    const tradeClass = currentTab === "trade" ? "highlight" : "";
    const highestClass = currentTab === "highest" ? "highlight" : "";

    return `
      <tr class="ranking-row" onclick="location.href='listing.html?id=${escapeHtml(item.listingId)}'">
        <td class="col-rank">${medalHtml}</td>
        <td class="col-listing">
          <div class="listing-cell">
            <img class="listing-thumb${item.isMosaicked ? " img-mosaic" : ""}"
              src="${img}" alt="프로필"
              onerror="this.src='assets/images/default-avatar.svg'">
            <div class="listing-info">
              <div class="listing-name">${nameHtml}</div>
              <div class="listing-soop-id">${soopIdHtml}</div>
            </div>
          </div>
        </td>
        <td class="col-price ${priceClass}">${formatG(item.currentPrice)}</td>
        <td class="col-owner">${escapeHtml(owner)}</td>
        <td class="col-highest ${highestClass}">${formatG(item.highestPrice)}</td>
        <td class="col-trade ${tradeClass}">${item.totalTradeCount.toLocaleString()}회</td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `
    <div class="ranking-table-wrap">
      <table class="ranking-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th class="col-listing">매물</th>
            <th class="col-price">현재 시세</th>
            <th class="col-owner">보유자</th>
            <th class="col-highest">역대 최고가</th>
            <th class="col-trade">거래 횟수</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ===== 헤더 잔액 표시 =====
function updateAuthArea(displayName, balance) {
  const authArea = $("authArea");
  if (!authArea) return;
  authArea.innerHTML = `
    <a href="shop.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px"
      onmouseover="this.style.color='#e8e8e8'" onmouseout="this.style.color='#9ba3b4'">🛒 상점</a>
    <a href="my.html" style="font-size:.82rem;color:#9ba3b4;text-decoration:none;padding:4px 10px;border:1px solid #2a2e38;border-radius:6px"
      onmouseover="this.style.color='#e8e8e8'" onmouseout="this.style.color='#9ba3b4'">마이페이지</a>
    <span style="font-size:.85rem;color:#9ba3b4">
      <strong style="color:#f5d142">Google 유저</strong>
      · ${formatG(balance)}
    </span>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}
