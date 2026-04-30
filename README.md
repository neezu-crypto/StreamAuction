# StreamAuction

> Trade the Streamers You Love
>
> soop 스트리머 닉네임을 사고파는 경매 게임

## 프로젝트 개요

스트리머 시청자와 스트리머 본인이 자신/타인의 닉네임을 사고팔며 즐기는 경매형 시뮬레이션 게임입니다.

- **플랫폼**: 웹 (PC/모바일 반응형)
- **프론트엔드**: HTML / CSS / JavaScript (Vanilla)
- **백엔드**: Firebase (Authentication, Firestore, Cloud Functions)
- **호스팅**: GitHub Pages

## 핵심 게임 루프

1. 스트리머 닉네임을 검색
2. 미보유 매물은 50,000G에 즉시 구매
3. 보유자가 있는 매물은 거래 제의 → 승인 시 거래 성사
4. 시세 변동을 통해 수익 실현 또는 즉시 손절

## 폴더 구조

```
streamauction/
├── index.html              # 메인 페이지
├── css/
│   └── common.css          # 공통 스타일
├── js/
│   ├── firebase-config.js  # Firebase 초기화
│   ├── auth.js             # 인증 로직
│   └── main.js             # 메인 진입점
├── pages/                  # 페이지별 HTML (추후)
└── assets/                 # 이미지, 아이콘 (추후)
```

## 개발 진행 상황

- [x] Firebase 프로젝트 생성
- [x] Firestore 활성화 + system/config 입력
- [x] API 키 도메인 제한
- [x] 기본 폴더 구조 + 인증 테스트 페이지
- [ ] Firestore 보안 규칙 작성
- [ ] Authentication 활성화
- [ ] 매물 등록/검색 기능
- [ ] 거래 시스템
- [ ] 어뷰징 방어 시스템

자세한 기획은 [기획서](./docs/DESIGN.md) 참고.

## 라이선스

MIT
