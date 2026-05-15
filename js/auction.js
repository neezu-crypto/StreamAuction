// ============================================
// auction.js - 경매 클라이언트 모듈
// RTDB 실시간 구독 + Cloud Function 호출
// ============================================

import {rtdb, functions} from "./firebase-config.js";
import {ref, onValue, off} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-functions.js";

// ===== 상태 =====
let auctionListener = null;
let queueListener = null;
let bidsListener = null;
let timerInterval = null;
let onAuctionUpdateCallback = null;
let onQueueUpdateCallback = null;
let onBidsUpdateCallback = null;
let onTimerCallback = null;

// ===== Cloud Functions 참조 =====
const searchListingFn = httpsCallable(functions, "searchListing");
const registerAuctionFn = httpsCallable(functions, "registerAuction");
const placeBidFn = httpsCallable(functions, "placeBid");
const finalizeAuctionFn = httpsCallable(functions, "finalizeAuction");
const getAuctionStateFn = httpsCallable(functions, "getAuctionState");
const requestAuctionFn = httpsCallable(functions, "requestAuction");
const respondToAuctionRequestFn = httpsCallable(functions, "respondToAuctionRequest");
const reportListingFn = httpsCallable(functions, "reportListing");
const blockListingFn = httpsCallable(functions, "blockListing");
const viewAuctionHistoryFn = httpsCallable(functions, "viewAuctionHistory");

// ===== 실시간 구독 시작 =====
export function subscribeAuction({
  onAuctionUpdate,
  onQueueUpdate,
  onBidsUpdate,
  onTimer,
}) {
  onAuctionUpdateCallback = onAuctionUpdate;
  onQueueUpdateCallback = onQueueUpdate;
  onBidsUpdateCallback = onBidsUpdate;
  onTimerCallback = onTimer;

  // 현재 경매 구독
  const currentRef = ref(rtdb, "auction/current");
  auctionListener = onValue(currentRef, (snap) => {
    const data = snap.val();
    onAuctionUpdateCallback && onAuctionUpdateCallback(data);
    updateTimer(data);
  });

  // 대기열 구독
  const queueRef = ref(rtdb, "auction/queue");
  queueListener = onValue(queueRef, (snap) => {
    const obj = snap.val() || {};
    const arr = Object.values(obj).sort((a, b) => a.queuedAt - b.queuedAt);
    onQueueUpdateCallback && onQueueUpdateCallback(arr);
  });

  // 입찰 기록 구독 (최근 20건)
  const bidsRef = ref(rtdb, "auction/bids");
  bidsListener = onValue(bidsRef, (snap) => {
    const obj = snap.val() || {};
    const arr = Object.values(obj).sort((a, b) => b.bidAt - a.bidAt).slice(0, 20);
    onBidsUpdateCallback && onBidsUpdateCallback(arr);
  });
}

// ===== 구독 해제 =====
export function unsubscribeAuction() {
  if (auctionListener) {
    off(ref(rtdb, "auction/current"));
    auctionListener = null;
  }
  if (queueListener) {
    off(ref(rtdb, "auction/queue"));
    queueListener = null;
  }
  if (bidsListener) {
    off(ref(rtdb, "auction/bids"));
    bidsListener = null;
  }
  clearInterval(timerInterval);
  timerInterval = null;
}

// ===== 타이머 관리 =====
function updateTimer(auctionData) {
  clearInterval(timerInterval);
  timerInterval = null;

  if (!auctionData || auctionData.status !== "active") {
    onTimerCallback && onTimerCallback(null);
    return;
  }

  const tick = async () => {
    const remaining = auctionData.endsAt - Date.now();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      onTimerCallback && onTimerCallback(0);
      // 경매 종료 트리거
      try {
        await finalizeAuctionFn();
      } catch (e) {
        // 이미 종료됐거나 다른 클라이언트가 처리한 경우 무시
        console.log("finalizeAuction:", e.message);
      }
    } else {
      onTimerCallback && onTimerCallback(remaining);
    }
  };

  tick();
  timerInterval = setInterval(tick, 500);
}

// ===== 타이머 포맷 =====
export function formatTimeRemaining(ms) {
  if (ms === null || ms === undefined) return "--:--";
  if (ms <= 0) return "00:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const min = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const sec = (totalSeconds % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

// ===== 화폐 포맷 =====
export function formatG(amount) {
  if (amount === null || amount === undefined) return "-";
  return amount.toLocaleString("ko-KR") + "G";
}

// ===== 매물 검색 =====
export async function searchListing(query) {
  const result = await searchListingFn({query});
  return result.data;
}

// ===== 경매 등록 =====
export async function registerAuction({soopId, displayName, startPrice, profileImageUrl, type}) {
  const result = await registerAuctionFn({soopId, displayName, startPrice, profileImageUrl, type});
  return result.data;
}

// ===== 입찰 =====
export async function placeBid(bidAmount) {
  const result = await placeBidFn({bidAmount});
  return result.data;
}

// ===== 경매 요청 (Type B) =====
export async function requestAuction(listingId) {
  const result = await requestAuctionFn({listingId});
  return result.data;
}

// ===== 경매 요청 응답 (Type B) =====
export async function respondToAuctionRequest({requestId, action, startPrice}) {
  const result = await respondToAuctionRequestFn({requestId, action, startPrice});
  return result.data;
}

// ===== 입력 검증 헬퍼 =====
export function validateSoopId(id) {
  if (!id || id.trim().length === 0) return "soop ID를 입력해주세요.";
  if (!/^[a-zA-Z0-9]+$/.test(id.trim())) return "soop ID는 영문과 숫자만 가능합니다.";
  return null;
}

export function validateNickname(nickname) {
  if (!nickname || nickname.trim().length === 0) return "닉네임을 입력해주세요.";
  if (/\p{Extended_Pictographic}/u.test(nickname)) return "이모지는 사용할 수 없습니다.";
  if (nickname.trim().length > 50) return "닉네임이 너무 깁니다.";
  return null;
}

// ===== soop 프로필 이미지 URL 생성 =====
export function getSoopProfileUrl(soopId) {
  if (!soopId) return null;
  const id = soopId.toLowerCase();
  const prefix = id.substring(0, 2);
  return `https://stimg.sooplive.co.kr/LOGO/${prefix}/${id}/${id}.jpg`;
}

// ===== 초기 상태 로드 (만료 경매 정산 포함) =====
export async function loadInitialState() {
  const result = await getAuctionStateFn();
  return result.data;
}

// ===== 매물 신고 =====
export async function reportListing({listingId, reason}) {
  const result = await reportListingFn({listingId, reason});
  return result.data;
}

// ===== 매물 차단 / 해제 =====
export async function blockListing({listingId, block}) {
  const result = await blockListingFn({listingId, block});
  return result.data;
}

// ===== 경매 히스토리 열람 (50,000G) =====
export async function viewAuctionHistory(listingId) {
  const result = await viewAuctionHistoryFn({listingId});
  return result.data;
}
