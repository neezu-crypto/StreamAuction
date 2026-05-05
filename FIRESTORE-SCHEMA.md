# Firestore 데이터 구조 명세 (v2)

> StreamAuction MVP의 Firestore 컬렉션 구조 + 보안 규칙 문서

**작성일:** 2026-05-01
**대상 버전:** schemaVersion 2

---

## 컬렉션 구조 개요

```
streamauction (Firestore Database)
├── system/                    # 게임 설정값 (콘솔 직접 수정)
│   └── config                 # 단일 문서
│
├── users/{uid}                # 유저 정보
│
├── listings/{soopId}          # 매물 (스트리머)
│
├── reports/{reportId}         # 매물 신고 (자동 생성 ID)
│
└── transactions/{txId}        # 거래 기록 (Phase 2부터)
```

---

## 1. system/config

게임 시스템 설정값. **Firebase Console에서만 수정**.

```javascript
{
  basePrice: 50000,                  // 신규 매물 가격
  selloffRate: 0.8,                  // 손절 회수율 (시세의 80%)
  tradeFeeRate: 0.1,                 // 거래 수수료 (10%)
  dormantRecoveryRate: 0.7,          // 휴면 회수율 (시세의 70%)

  anonymousBonus: 200000,            // 익명 가입 보너스
  googleBonus: 1000000,              // 구글 가입 보너스 (총 잔액)
  anonymousOwnedLimit: 1,            // 익명 보유 한도
  googleOwnedLimit: 5,               // 구글 보유 한도

  selloffCooldownHours: 24,          // 매물 구매 후 손절 쿨다운
  newUserSelloffBlockHours: 24,      // 신규 가입 후 손절 차단
  offerExpirationHours: 72,          // 거래 제의 만료

  adRewardAmount: 10000,             // 광고 보상
  adRewardDailyLimit: 5,             // 일일 광고 한도
  adCooldownMinutes: 5,              // 광고 쿨다운

  dailyRewards: {                    // 출석 보상
    day1to2: 5000,
    day3plus: 10000,
    day7special: 30000,
    day30special: 100000
  },

  tutorialRewards: {                 // 튜토리얼 보상
    firstPurchase: 10000,
    firstTrade: 30000,
    firstSelloff: 5000,
    firstForceLiquidation: 10000
  },

  reportThreshold: 10,               // 모자이크 임계값 (NEW v2)

  schemaVersion: 1,
  lastUpdatedAt: <timestamp>
}
```

**보안 규칙:**
- read: 누구나 OK
- write: 차단 (콘솔만)

---

## 2. users/{uid}

유저 정보. 문서 ID = Firebase Auth UID.

```javascript
{
  // 식별 정보
  uid: "abc123...",
  authType: "google",                // "anonymous" | "google"
  email: "user@gmail.com",           // 구글만
  displayName: "홍길동",
  photoURL: "https://...",

  // 자산
  balance: 1000000,                  // 보유 G
  ownedListingIds: ["hwt1014", ...], // 보유 매물 ID 배열
  ownedCount: 1,                     // 보유 개수
  ownedLimit: 5,                     // 보유 한도

  // 시간 기록
  createdAt: <timestamp>,
  lastLoginAt: <timestamp>,
  convertedAt: <timestamp>,          // 익명→구글 전환 시각 (구글만)
  lastDailyRewardAt: null,

  // 출석/광고
  consecutiveLoginDays: 1,
  adRewardCountToday: 0,
  adRewardLastAt: null,

  // 튜토리얼 보상 수령 여부
  tutorialRewards: {
    firstPurchase: false,
    firstTrade: false,
    firstSelloff: false,
    firstForceLiquidation: false
  },

  // ===== v2 신규 필드 =====
  blockedListingIds: ["hwt1014"],    // 본인이 차단한 매물 ID 배열
  onboardingStep: 4,                 // 0~4 (튜토리얼 진행)
  // 0: 시작, 1: 첫 검색, 2: 첫 구매, 3: 마이페이지, 4: 완료

  // 상태
  isBanned: false,
  banReason: null,

  schemaVersion: 2
}
```

**보안 규칙:**
- read: 본인만
- write: 차단 (Cloud Functions만)

---

## 3. listings/{soopId}

매물 (스트리머 닉네임/ID). **문서 ID = soop ID** (정규화된 영숫자).

```javascript
{
  // 식별
  soopId: "hwt1014",                 // 영숫자만 (소문자로 정규화)
  displayName: "홍길동",              // 표시용 닉네임 (원본)
  normalizedNickname: "홍길동",       // 검색용 정규화 닉네임 (공백 제거)

  // 프로필 (선택)
  profileImageUrl: "https://stimg.sooplive.com/LOGO/hw/hwt1014/hwt1014.jpg",

  // 소유
  ownerId: "userUid...",             // 보유자 UID (없으면 null)
  ownerName: "익명",                  // 익명화 표시 (BM 도입 전엔 항상 "익명")

  // 시세
  currentPrice: 50000,
  basePrice: 50000,                  // 항상 50000 (변경 없음)
  lastTradedAt: <timestamp>,

  // 통계
  totalTradeCount: 1,                // 누적 거래 횟수
  totalTradeVolume: 50000,           // 누적 거래액
  highestPrice: 50000,
  lowestPrice: 50000,

  // 등록
  createdBy: "userUid...",           // 최초 등록자 (첫 구매자)
  createdAt: <timestamp>,

  // 잠금
  isLocked: false,
  lockReason: null,

  // ===== v2 신규 필드 =====
  reportCount: 0,                    // 누적 신고 수
  isMosaicked: false,                // 모자이크 처리 여부 (reportCount >= 10)
  reportReasons: {                   // 사유별 카운트
    inappropriateImage: 0,
    profanity: 0,
    misinformation: 0,
    other: 0
  },

  schemaVersion: 2
}
```

**보안 규칙:**
- read: 누구나 OK (검색 + 조회 가능)
- write: 차단 (Cloud Functions만)

**소유자 정보 표시 정책 (MVP):**
- 모든 보유자는 익명 표시 (`ownerName: "익명"`)
- 본인 매물인 경우만 본인 화면에서 "내 매물" 표시
- BM 시스템은 Phase 3 도입 시 displayName 노출 옵션 추가

---

## 4. reports/{reportId}

매물 신고 기록. 문서 ID는 자동 생성.

```javascript
{
  reportId: "auto-generated",

  // 대상
  listingId: "hwt1014",              // 신고 대상 매물

  // 신고자 (보유자에게 비공개)
  reporterId: "userUid...",          // 신고자 UID
  reporterAuthType: "google",        // 익명은 신고 불가니까 항상 google

  // 사유
  reason: "inappropriateImage",      // 영문 코드
  // "inappropriateImage" | "profanity" | "misinformation" | "other"
  reasonText: "프로필 이미지가 부적절함",  // 자유 입력 (선택)

  // 상태
  status: "pending",                 // "pending" | "approved" | "rejected"

  // 시간
  createdAt: <timestamp>,
  reviewedAt: null,                  // 운영자 검토 시각
  reviewedBy: null,                  // 운영자 UID

  schemaVersion: 1
}
```

**사유 코드 → 한글 매핑 (관리자 페이지 참고):**

| 영문 코드 | 한글 표시 |
|---|---|
| `inappropriateImage` | 부적절한 프로필 이미지 |
| `profanity` | 비속어/혐오 닉네임 |
| `misinformation` | 잘못된 정보 (실제 스트리머 아님) |
| `other` | 기타 |

**보안 규칙:**
- read: 본인이 신고한 것만 (`resource.data.reporterId == auth.uid`)
- write: 차단 (Cloud Functions만)

**중복 신고 방지:**
- 1인당 1매물 1회만
- Cloud Function `reportListing`에서 검증
- 인덱스: `(listingId, reporterId)` 복합 인덱스로 조회

---

## 5. 인덱스 설정

`firestore.indexes.json`에 다음 복합 인덱스가 정의됨:

| 컬렉션 | 필드 | 용도 |
|---|---|---|
| `listings` | `ownerId` ↑ + `lastTradedAt` ↓ | 본인 보유 매물 목록 |
| `listings` | `isMosaicked` ↑ + `currentPrice` ↓ | 정상 매물 시세 정렬 |
| `listings` | `isMosaicked` ↑ + `lastTradedAt` ↓ | 정상 매물 최근 거래순 |
| `reports` | `listingId` ↑ + `reporterId` ↑ | 중복 신고 검증 |
| `reports` | `status` ↑ + `createdAt` ↓ | 운영자 검토 큐 |

**자동 인덱스 생성:**
- 단일 필드는 자동 생성 (예: `currentPrice` 단독 정렬)
- 복합 인덱스는 위 파일로 명시 필요
- 처음 쿼리 실행 시 콘솔에 "인덱스 생성 필요" 링크 나오면 클릭해서 자동 생성

---

## 6. 데이터 마이그레이션 (v1 → v2)

기존 v1 유저는 다음 필드가 자동으로 추가됨 (`initializeUser` 함수에서 처리):

```javascript
// 기존 유저 로그인 시 자동 마이그레이션
{
  blockedListingIds: [],   // 추가
  onboardingStep: 4,       // 추가 (기존 유저는 튜토리얼 완료 처리)
}
```

`schemaVersion`도 자동 갱신.

---

## 7. 검색 정규화 규칙

**닉네임 정규화 (검색용):**
- 공백 제거
- 대소문자 그대로 (한글은 무관)
- 특수문자 그대로 (이모지만 제거)

**ID 정규화 (문서 ID):**
- 모두 소문자 변환 (대소문자 무관 매칭)
- 영숫자 외 모두 차단 (입력 단계에서 검증)

**검색 흐름:**
```
입력: "hwt1014" 또는 "홍길동"
  ↓
ID 형식 검사 (영숫자만?)
  ↓ Yes               ↓ No
ID로 검색            닉네임으로 검색
listings doc(soopId)  query(normalizedNickname == ...)
  ↓                    ↓
없으면 → 등록 안내
있으면 → 매물 페이지로 이동
```

---

## 8. 주의사항

### 8-1. 비정규화 데이터 동기화

`listings.ownerName`은 비정규화된 데이터(매번 users 안 읽기 위해 복사). 유저가 displayName 바꾸면 보유 매물 모두 갱신 필요.

**MVP:** ownerName 항상 "익명"이므로 동기화 불필요  
**Phase 3 (BM 도입):** Cloud Function `onUpdate` 트리거로 자동 동기화

### 8-2. listings 문서 ID 충돌

같은 soopId가 두 번 등록될 수 없음 (문서 ID 유니크 보장). Cloud Function에서 트랜잭션으로 안전하게 처리.

### 8-3. reportCount 동시성

여러 유저가 동시에 신고 시 카운트 누락 방지. Cloud Function에서 `FieldValue.increment(1)` 사용.

```javascript
transaction.update(listingRef, {
  reportCount: FieldValue.increment(1),
  [`reportReasons.${reason}`]: FieldValue.increment(1)
});
```

### 8-4. 모자이크 자동화

```
reportCount가 10에 도달하는 순간 isMosaicked: true로 자동 설정
↓
이후 신고가 들어와도 isMosaicked는 true 유지
↓
운영자가 검토 후 false로 되돌릴 수 있음 (수동, Firebase Console)
```
