// ============================================
// admin.js - StreamAuction 관리자 페이지
// ============================================

import {auth, functions} from './firebase-config.js';
import {
  onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider,
} from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js';
import {httpsCallable} from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js';

// ===== CF 참조 =====
const adminGetDashboardFn = httpsCallable(functions, 'adminGetDashboard');
const adminForceFinalizeFn = httpsCallable(functions, 'adminForceFinalize');
const adminClearQueueFn = httpsCallable(functions, 'adminClearQueue');
const adminGetUserFn = httpsCallable(functions, 'adminGetUser');
const adminBanUserFn = httpsCallable(functions, 'adminBanUser');
const adminAdjustBalanceFn = httpsCallable(functions, 'adminAdjustBalance');
const adminGetConfigFn = httpsCallable(functions, 'adminGetConfig');
const adminSetConfigFn = httpsCallable(functions, 'adminSetConfig');

// ===== 상태 =====
let selectedUser = null;

// ===== DOM 헬퍼 =====
const $ = (id) => document.getElementById(id);
function show(id) { const el = $(id); if (el) el.style.display = ''; }
function hide(id) { const el = $(id); if (el) el.style.display = 'none'; }
function formatG(n) { return (n ?? 0).toLocaleString('ko-KR') + 'G'; }
function formatDate(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

const TYPE_LABEL = {new: 'A', holder: 'B', selloff: 'C'};

// ===== 인증 =====
onAuthStateChanged(auth, async (user) => {
  hide('screenLoading');
  if (!user || user.isAnonymous) {
    hide('screenAdmin');
    hide('screenDenied');
    show('screenLogin');
    $('adminAuthArea').innerHTML = '';
    return;
  }
  $('adminAuthArea').innerHTML = `
    <span style="font-size:.85rem;color:#9ba3b4;margin-right:10px">${user.displayName || user.email || user.uid.substring(0, 8)}</span>
    <button class="btn-sm btn-ghost" onclick="handleAdminLogout()">로그아웃</button>
  `;
  await tryLoadAdmin();
});

async function tryLoadAdmin() {
  try {
    const result = await adminGetDashboardFn();
    show('screenAdmin');
    renderDashboard(result.data);
  } catch (e) {
    const msg = e.code === 'functions/permission-denied'
      ? '관리자 권한이 없습니다.<br>Firestore <code>system/admin.adminUids</code>에 UID를 추가하세요.'
      : `오류: ${e.message}`;
    $('deniedMessage').innerHTML = msg;
    show('screenDenied');
  }
}

window.handleAdminLogin = async function() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') alert(`로그인 실패: ${e.message}`);
  }
};

window.handleAdminLogout = async function() {
  await signOut(auth);
};

// ===== 탭 전환 =====
window.switchTab = function(tab) {
  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.style.display = pane.id === `tab-${tab}` ? '' : 'none';
  });
  if (tab === 'auction') refreshAuctionTab();
  if (tab === 'config') loadConfig();
  if (tab === 'reports') loadReports();
};

// ===== 대시보드 =====
function renderDashboard(data) {
  const {stats, current, recentHistory} = data;

  $('statsRow').innerHTML = [
    ['총 유저', stats.userCount.toLocaleString() + '명'],
    ['총 매물', stats.listingCount.toLocaleString() + '개'],
    ['대기열', stats.queueSize + '개'],
  ].map(([label, val]) => `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${val}</div>
    </div>`).join('');

  $('dashCurrentAuction').innerHTML = buildCurrentAuctionHtml(current);

  if (!recentHistory?.length) {
    $('dashHistory').innerHTML = `<p class="empty-msg">기록 없음</p>`;
  } else {
    $('dashHistory').innerHTML = `
      <table class="admin-table">
        <thead><tr><th>닉네임</th><th>유형</th><th>낙찰가</th><th>결과</th><th>입찰</th><th>종료</th></tr></thead>
        <tbody>${recentHistory.map((h) => `
          <tr>
            <td>${h.displayName}</td>
            <td><span class="type-tag type-${h.type}">${TYPE_LABEL[h.type] || h.type}</span></td>
            <td>${formatG(h.finalPrice)}</td>
            <td>${h.isWon ? '✅ 낙찰' : '❌ 유찰'}</td>
            <td>${h.bidCount}</td>
            <td>${formatDate(h.endedAt)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }
}

window.refreshDashboard = async function() {
  try {
    const result = await adminGetDashboardFn();
    renderDashboard(result.data);
  } catch (e) {
    alert(`오류: ${e.message}`);
  }
};

function buildCurrentAuctionHtml(current) {
  if (!current || current.status !== 'active') {
    return `<p class="empty-msg">진행 중인 경매 없음</p>`;
  }
  const remaining = Math.max(0, current.endsAt - Date.now());
  const min = String(Math.floor(remaining / 60000)).padStart(2, '0');
  const sec = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
  return `
    <dl class="info-list">
      <div class="info-row"><dt>매물</dt><dd>${current.displayName} <span class="mono">(${current.soopId})</span></dd></div>
      <div class="info-row"><dt>유형</dt><dd>${{new: 'A — 신규', holder: 'B — 보유자', selloff: 'C — 손절'}[current.type] || current.type}</dd></div>
      <div class="info-row"><dt>현재가</dt><dd>${formatG(current.currentPrice)}</dd></div>
      <div class="info-row"><dt>입찰 수</dt><dd>${current.bidCount}</dd></div>
      <div class="info-row"><dt>남은 시간</dt><dd class="timer-val">${min}:${sec}</dd></div>
    </dl>`;
}

// ===== 경매 제어 =====
window.refreshAuctionTab = async function() {
  try {
    const result = await adminGetDashboardFn();
    const {current, queue} = result.data;
    $('auctionCurrentCard').innerHTML = buildCurrentAuctionHtml(current);
    $('btnForceFinalize').disabled = !current || current.status !== 'active';

    if (!queue?.length) {
      $('auctionQueueCard').innerHTML = `<p class="empty-msg">대기 중인 경매 없음</p>`;
    } else {
      $('auctionQueueCard').innerHTML = `
        <dl class="info-list">
          ${queue.map((q, i) => `
            <div class="info-row">
              <dt>${i + 1}번</dt>
              <dd>${q.displayName} · ${formatG(q.startPrice)} · <span class="type-tag type-${q.type}">${TYPE_LABEL[q.type] || q.type}</span></dd>
            </div>`).join('')}
        </dl>`;
    }
    $('btnClearQueue').disabled = !queue?.length;
  } catch (e) {
    alert(`오류: ${e.message}`);
  }
};

window.handleForceFinalize = async function() {
  if (!confirm('현재 경매를 강제 종료하시겠습니까?\n낙찰/유찰 처리가 즉시 실행됩니다.')) return;
  const btn = $('btnForceFinalize');
  btn.disabled = true;
  btn.textContent = '처리 중...';
  try {
    await adminForceFinalizeFn();
    alert('경매가 강제 종료됐습니다.');
    await refreshAuctionTab();
  } catch (e) {
    alert(`실패: ${e.message}`);
  } finally {
    btn.textContent = '강제 종료';
  }
};

window.handleClearQueue = async function() {
  if (!confirm('대기열을 전부 비우시겠습니까?\n등록된 경매가 모두 삭제됩니다.')) return;
  try {
    await adminClearQueueFn();
    alert('대기열이 초기화됐습니다.');
    await refreshAuctionTab();
  } catch (e) {
    alert(`실패: ${e.message}`);
  }
};

// ===== 유저 관리 =====
window.handleUserSearch = async function() {
  const uid = $('userUidInput')?.value?.trim();
  const errEl = $('userSearchError');
  errEl.style.display = 'none';
  $('userDetailCard').style.display = 'none';

  if (!uid) {
    errEl.textContent = 'UID를 입력하세요';
    errEl.style.display = '';
    return;
  }
  try {
    const result = await adminGetUserFn({uid});
    selectedUser = result.data;
    renderUserDetail(selectedUser);
    $('userDetailCard').style.display = '';
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
};

function renderUserDetail(user) {
  const tutChips = [
    {key: 'firstTrade', label: '첫 등록'},
    {key: 'firstPurchase', label: '첫 낙찰'},
    {key: 'firstSelloff', label: '첫 손절'},
    {key: 'firstForceLiquidation', label: '강제청산'},
  ].map((t) => {
    const done = !!user.tutorialRewards?.[t.key];
    return `<span class="tut-chip${done ? ' done' : ''}">${done ? '✅' : '⭕'} ${t.label}</span>`;
  }).join('');

  $('userDetailContent').innerHTML = `
    <dl class="info-list">
      <div class="info-row"><dt>UID</dt><dd class="mono">${user.uid}</dd></div>
      <div class="info-row"><dt>계정 유형</dt><dd>${user.authType === 'google' ? '🟢 Google' : '⚪ 익명'}</dd></div>
      <div class="info-row"><dt>이름</dt><dd>${user.displayName || '-'}</dd></div>
      <div class="info-row"><dt>이메일</dt><dd>${user.email || '-'}</dd></div>
      <div class="info-row"><dt>잔액</dt><dd>${formatG(user.balance)}</dd></div>
      <div class="info-row"><dt>보유</dt><dd>${user.ownedCount} / ${user.ownedLimit}개</dd></div>
      <div class="info-row"><dt>가입일</dt><dd>${formatDate(user.createdAt)}</dd></div>
      <div class="info-row"><dt>최근 접속</dt><dd>${formatDate(user.lastLoginAt)}</dd></div>
      <div class="info-row"><dt>연속 출석</dt><dd>${user.consecutiveLoginDays || 0}일째 · 마지막 ${user.lastDailyRewardAt ? formatDate(user.lastDailyRewardAt) : "없음"}</dd></div>
      <div class="info-row"><dt>상세 열람 패스</dt><dd>${user.detailViewPass || "없음"}</dd></div>
      <div class="info-row"><dt>히스토리 패스</dt><dd>${user.historyViewPass || "없음"}</dd></div>
      <div class="info-row"><dt>우선권 패스</dt><dd>${user.queuePriorityPass || "없음"}</dd></div>
      <div class="info-row"><dt>튜토리얼</dt><dd class="tut-chips">${tutChips}</dd></div>
      <div class="info-row"><dt>상태</dt><dd style="color:${user.isBanned ? '#ef4444' : '#22c55e'}">
        ${user.isBanned ? `🚫 정지됨${user.banReason ? ` · ${user.banReason}` : ''}` : '✅ 정상'}
      </dd></div>
    </dl>`;

  $('balanceDeltaInput').value = '';
  $('balanceResult').style.display = 'none';

  $('banArea').innerHTML = user.isBanned
    ? `<button class="btn-sm btn-primary" onclick="handleToggleBan(false)">정지 해제</button>`
    : `<div class="search-row">
        <input type="text" id="banReasonInput" class="admin-input" placeholder="정지 사유 (선택)">
        <button class="btn-sm btn-danger" onclick="handleToggleBan(true)">계정 정지</button>
       </div>`;
}

window.handleAdjustBalance = async function() {
  if (!selectedUser) return;
  const delta = Number($('balanceDeltaInput')?.value);
  const resultEl = $('balanceResult');
  if (!delta) {
    resultEl.textContent = '0이 아닌 값을 입력하세요';
    resultEl.className = 'msg-error';
    resultEl.style.display = '';
    return;
  }
  try {
    const result = await adminAdjustBalanceFn({uid: selectedUser.uid, delta});
    selectedUser.balance = result.data.newBalance;
    resultEl.textContent = `완료 · 새 잔액: ${formatG(result.data.newBalance)}`;
    resultEl.className = 'msg-ok';
    resultEl.style.display = '';
    renderUserDetail(selectedUser);
  } catch (e) {
    resultEl.textContent = `실패: ${e.message}`;
    resultEl.className = 'msg-error';
    resultEl.style.display = '';
  }
};

window.handleToggleBan = async function(shouldBan) {
  if (!selectedUser) return;
  const reason = shouldBan ? ($('banReasonInput')?.value?.trim() || null) : null;
  const msg = shouldBan
    ? `${selectedUser.uid}\n를 정지하시겠습니까?`
    : `${selectedUser.uid}\n 정지를 해제하시겠습니까?`;
  if (!confirm(msg)) return;
  try {
    await adminBanUserFn({uid: selectedUser.uid, isBanned: shouldBan, banReason: reason});
    selectedUser.isBanned = shouldBan;
    selectedUser.banReason = reason;
    renderUserDetail(selectedUser);
  } catch (e) {
    alert(`실패: ${e.message}`);
  }
};

// ===== 시스템 설정 =====
const CONFIG_GROUPS = [
  {
    title: '기본 경제 값',
    fields: [
      {key: 'basePrice', label: '기본 시세 (basePrice)', unit: 'G'},
      {key: 'anonymousBonus', label: '익명 시작 자산', unit: 'G'},
      {key: 'googleBonus', label: 'Google 시작 자산', unit: 'G'},
      {key: 'anonymousOwnedLimit', label: '익명 보유 한도', unit: '개'},
      {key: 'googleOwnedLimit', label: 'Google 보유 한도', unit: '개'},
    ],
  },
  {
    title: '튜토리얼 보상',
    fields: [
      {key: 'tutorialRewards.firstTrade', label: '첫 경매 등록', unit: 'G'},
      {key: 'tutorialRewards.firstPurchase', label: '첫 낙찰', unit: 'G'},
      {key: 'tutorialRewards.firstSelloff', label: '첫 손절 경매', unit: 'G'},
      {key: 'tutorialRewards.firstForceLiquidation', label: '첫 강제청산', unit: 'G'},
    ],
  },
  {
    title: '출석 보상',
    fields: [
      {key: 'dailyReward1', label: '출석 1~2일', unit: 'G'},
      {key: 'dailyReward3Plus', label: '출석 3일+', unit: 'G'},
      {key: 'dailyRewardBonus7', label: '7일 특별 보너스', unit: 'G'},
      {key: 'dailyRewardBonus30', label: '30일 특별 보너스', unit: 'G'},
    ],
  },
];

window.loadConfig = async function loadConfig() {
  $('configForm').innerHTML = `<p class="empty-msg">로딩 중...</p>`;
  try {
    const result = await adminGetConfigFn();
    renderConfigForm(result.data);
  } catch (e) {
    $('configForm').innerHTML = `<p class="msg-error">${e.message}</p>`;
  }
}

function renderConfigForm(config) {
  $('configForm').innerHTML = CONFIG_GROUPS.map(({title, fields}) => `
    <div class="config-group">
      <div class="config-group-title">${title}</div>
      ${fields.map(({key, label, unit}) => {
        const parts = key.split('.');
        const val = parts.length === 2 ? (config[parts[0]]?.[parts[1]] ?? '') : (config[key] ?? '');
        return `
          <div class="config-row">
            <label class="config-label">${label}</label>
            <div class="config-input-wrap">
              <input type="number" class="admin-input" data-key="${key}" value="${val}" min="0" step="1000">
              <span class="config-unit">${unit}</span>
            </div>
          </div>`;
      }).join('')}
    </div>`).join('');
}

window.handleSaveConfig = async function() {
  const inputs = document.querySelectorAll('#configForm input[data-key]');
  const updates = {};
  inputs.forEach((input) => {
    const val = parseFloat(input.value);
    if (!isNaN(val)) updates[input.dataset.key] = val;
  });

  const resultEl = $('configResult');
  const btn = $('btnSaveConfig');
  btn.disabled = true;
  btn.textContent = '저장 중...';

  try {
    const result = await adminSetConfigFn({updates});
    resultEl.textContent = `저장 완료 · ${result.data.updated.length}개 필드 업데이트됨`;
    resultEl.className = 'msg-ok';
    resultEl.style.display = '';
  } catch (e) {
    resultEl.textContent = `저장 실패: ${e.message}`;
    resultEl.className = 'msg-error';
    resultEl.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '설정 저장';
  }
};

// ===== 신고 관리 =====
const adminGetReportsFn = httpsCallable(functions, "adminGetReports");
const adminSetMosaicFn = httpsCallable(functions, "adminSetMosaic");

window.loadReports = async function loadReports() {
  $("reportsContent").innerHTML = `<p class="empty-msg">로딩 중...</p>`;
  try {
    const result = await adminGetReportsFn();
    renderReports(result.data);
  } catch (e) {
    $("reportsContent").innerHTML = `<p class="msg-error">${e.message}</p>`;
  }
}

function renderReports(reports) {
  if (!reports || reports.length === 0) {
    $("reportsContent").innerHTML = `<p class="empty-msg">신고된 매물 없음</p>`;
    return;
  }
  const REASON_LABEL = {
    inappropriateImage: "부적절 이미지",
    profanity: "욕설/비방",
    misinformation: "허위 정보",
    other: "기타",
  };
  $("reportsContent").innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>닉네임</th><th>ID</th><th>신고 수</th><th>사유 분류</th><th>보유자</th><th>모자이크</th><th>조치</th></tr>
      </thead>
      <tbody>
        ${reports.map((r) => {
          const reasons = Object.entries(r.reportReasons || {})
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${REASON_LABEL[k] || k}(${v})`)
              .join(", ") || "-";
          return `
            <tr id="report-row-${r.listingId}">
              <td>${r.displayName}</td>
              <td class="mono">${r.soopId}</td>
              <td><strong style="color:#f87171">${r.reportCount}</strong></td>
              <td style="font-size:.78rem;color:#9ba3b4">${reasons}</td>
              <td class="mono" style="font-size:.75rem">${r.ownerId ? r.ownerId.substring(0, 8) + "…" : "없음"}</td>
              <td>${r.isMosaicked ? `<span style="color:#f87171;font-weight:600">적용중</span>` : `<span style="color:#22c55e">없음</span>`}</td>
              <td>
                ${r.isMosaicked
                  ? `<button class="btn-sm btn-primary" onclick="handleSetMosaic('${r.listingId}', false, this)">해제</button>`
                  : `<button class="btn-sm btn-danger" onclick="handleSetMosaic('${r.listingId}', true, this)">모자이크</button>`
                }
              </td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

window.handleSetMosaic = async function(listingId, isMosaicked, btn) {
  const label = isMosaicked ? "모자이크 적용" : "모자이크 해제";
  if (!confirm(`${listingId} — ${label}하시겠습니까?`)) return;
  btn.disabled = true;
  btn.textContent = "처리 중...";
  try {
    await adminSetMosaicFn({listingId, isMosaicked});
    await loadReports();
  } catch (e) {
    alert(`실패: ${e.message}`);
    btn.disabled = false;
    btn.textContent = label;
  }
};
