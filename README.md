# 둘만의 채팅 (GitHub Pages + Firebase)

비밀번호에 따라 최대 3개 방으로 연결되는 웹 채팅입니다. GitHub Pages(정적 호스팅)에 올리고,
메시지 저장/실시간 전달은 **Firebase Firestore**가 담당합니다.
메시지는 **브라우저에서 암호화**되어 저장되므로, Firebase에는 암호문만 남습니다.

- 실시간 채팅 (Firestore 실시간 구독)
- 종단간 암호화 (공유 비밀번호 기반 AES-GCM)
- **최대 3개 방**: 이름 + 암호만 입력하면 해당 방으로 자동 연결 (현재 기존 방 + 추가 방 1개 활성)
- **위장 UI**: "보호된 통합 문서 / 실적_분석.xlsx" 처럼 보이는 스프레드시트(엑셀) 테마
- 두 번째 방 전용 움직이는 이모티콘 48개
- 서버 코드 불필요 (`index.html` + `assets/`로 실행되는 정적 사이트)

## 방 연결 방식과 기존 대화 보존

| 방 | 입장 방식 | 상태 |
| --- | --- | --- |
| 기존 방 (`sjchat-private-2026`) | 기존에 쓰던 암호 | 유지 |
| 두 번째 방 (`sjchat-private-2026-2`) | 미리 정한 두 번째 암호 | 설정 완료 |
| 세 번째 방 (`sjchat-private-2026-3`) | 나중에 암호 설정 | 비활성 |

추가 방에 등록된 암호만 해당 방으로 연결하고, 그 외 암호는 기존 방으로 연결합니다.
기존 방은 원래부터 암호를 등록·검증하지 않고 암호화 키로만 사용했으므로, 이 동작을 유지합니다.
따라서 기존 방에 잘못된 암호를 입력하면 이전처럼 메시지가 `#VALUE!`로 표시됩니다.
추가 방의 암호는 **기존 방 암호 및 다른 추가 방 암호와 다른 값**을 사용해야 합니다.

기존 방의 ID, PBKDF2 salt/반복 횟수, AES-GCM 방식은 유지합니다.
이전 메시지를 이동·삭제·재암호화하지 않으며, 기존 암호로 그대로 읽을 수 있습니다.
방마다 메시지 저장 경로와 암호화 키가 분리됩니다.

### 나중에 세 번째 방 활성화

Node.js 20 이상이 설치된 로컬 터미널에서 실행하고 암호를 두 번 입력하세요.
암호를 명령어 인수로 전달하지 않으며, 파일에는 PBKDF2 검증값만 저장합니다.

```bash
node scripts/configure-room.mjs 3
```

이 명령은 `index.html`의 해당 방 설정과 `firestore.rules`의 허용 목록을 수정합니다.
변경한 HTML을 배포하고, 아래 4번 절차로 Firestore 규칙도 게시해야 활성화됩니다.
두 번째 방도 `node scripts/configure-room.mjs 2`로 설정할 수 있지만,
사용 중인 방의 암호를 바꾸면 이전 암호로 암호화된 대화는 새 암호로 읽을 수 없습니다.

사이트 배포에는 `index.html`과 `assets/`가 필요하고, Firebase에는 `firestore.rules`를 적용합니다.
Firestore 규칙이 기존 단일 방 설정인 상태에서는 두 번째 방에 접근할 수 없습니다.

### 두 번째 방 이모티콘

입력창 옆 **☺** → 묶음/이모티콘 선택 → **보내기**로 전송합니다.
기존 방과 세 번째 방에는 이 기능이 표시되지 않습니다.

- 제작자의 사용 허가에 따라 [리센느 X 안원잘부 2](https://e.kakao.com/t/helloiamwoninicetomeetyou-2),
  [시즌1](https://e.kakao.com/t/helloiamwoninicetomeetyou-s1)의 공개 움직이는 미리보기 WebP를 각각 24개 사용합니다.
- 이미지는 `assets/stickers/`에서 GitHub Pages로 제공하며 Firebase Storage를 사용하지 않습니다.
  선택창을 열었을 때 해당 묶음을 만들고, 이미지는 지연 로딩합니다.
- Firestore에는 구분자 1바이트 + ID 3바이트만 기존 AES-GCM으로 암호화해 저장합니다.
  `ct`는 Base64 28자, `iv`는 16자이며 발신자/시간 및 Firestore 문서·색인 크기는 별도입니다.
  이미지나 URL, 카탈로그를 Firestore에 저장하지 않습니다.
- 선택과 미리보기에는 Firestore 요청이 없고, 전송 1회는 기존 메시지처럼 문서 1회 쓰기입니다.
  수신·기록 조회의 읽기 사용량과 기존 기록 보관 정책은 동일합니다.
- 이미지는 정적 공개 파일입니다. 방 제한은 채팅 화면의 선택·표시에 적용됩니다.

---

## 전체 순서 요약

1. Firebase 프로젝트 만들기 + Firestore 켜기
2. 웹 앱 등록해서 `firebaseConfig` 값 복사
3. `index.html`에 그 값 붙여넣기
4. Firestore 보안 규칙 설정
5. GitHub 저장소 만들고 GitHub Pages로 배포
6. 친구에게 `주소 + 해당 방의 문서 암호` 공유 (방 이름은 공유 불필요)

---

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 → **프로젝트 추가**
2. 이름 아무거나 (예: `my-chat`), Google 애널리틱스는 꺼도 됩니다.
3. 왼쪽 메뉴 **빌드 → Firestore Database** → **데이터베이스 만들기**
   - 위치는 아무거나(예: `asia-northeast3` 서울)
   - **테스트 모드로 시작** 선택 (나중에 아래 4번에서 규칙을 바꿉니다)

## 2. 웹 앱 등록 & 설정값 복사

1. 프로젝트 개요(홈) 화면에서 **`</>` (웹) 아이콘** 클릭
2. 앱 닉네임 입력 후 등록 (Hosting 체크는 안 해도 됨)
3. 보여주는 `firebaseConfig` 객체를 복사합니다. 이렇게 생겼어요:

```js
const firebaseConfig = {
  apiKey: "AIzaSy........",
  authDomain: "my-chat-xxxx.firebaseapp.com",
  projectId: "my-chat-xxxx",
  storageBucket: "my-chat-xxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:1234:web:abcd..."
};
```

> 참고: `apiKey`는 비밀번호가 아니라 프로젝트 식별용 공개 키입니다.
> 정적 사이트에 노출되는 게 정상이며, 실제 접근 제어는 아래 **보안 규칙**이 담당합니다.

## 3. index.html에 값 붙여넣기

`index.html`에서 아래 부분을 찾아 방금 복사한 값으로 교체하세요.

```js
// 1) 여기에 본인의 Firebase 프로젝트 설정을 붙여넣으세요.
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  ...
};
```

## 4. Firestore 보안 규칙 설정 (중요)

테스트 모드는 30일 뒤 막히고 아무나 접근 가능하므로 규칙을 바꿉니다.
Firebase 콘솔 → **Firestore Database → 규칙** 탭에서
[`firestore.rules`](firestore.rules)의 전체 내용으로 교체 후 **게시**하세요.

현재 규칙은 **기존 방과 두 번째 방만 허용**합니다. 미사용 세 번째 방 및 다른 경로는 거부합니다.
이후 세 번째 방 암호를 설정하면 설정 스크립트가 허용 목록에 세 번째 방을 추가합니다.
이 파일을 GitHub에 올리는 것만으로 Firebase 규칙이 자동 배포되지는 않습니다.

> - 이 규칙은 방 개수/경로를 제한합니다. 사용자 인증이나 비밀번호 검증을 수행하지는 않습니다.
> - 허용된 방 경로를 알면 암호문 읽기/추가가 가능합니다. 내용 암호화는 브라우저에서 수행합니다.
> - 비밀번호 원문은 소스에 저장하지 않습니다. 추가 방 연결용 PBKDF2 검증값은 공개됩니다.
> - 기존 대화를 계속 읽으려면 `ROOM_ID`와 기존 방 암호를 유지하세요.

## 5. GitHub Pages로 배포

### 방법 A — 웹에서 (가장 쉬움)
1. GitHub에서 **New repository** 생성 (Public)
2. **Add file → Upload files** 로 `index.html`과 `assets/` 폴더 업로드 후 커밋
3. 저장소 **Settings → Pages**
4. **Source: Deploy from a branch**, Branch: `main` / `/root` 선택 후 Save
5. 1~2분 뒤 `https://<사용자명>.github.io/<저장소명>/` 주소가 생깁니다.

### 방법 B — 터미널에서

```bash
cd /Users/seungjo2/Documents/chat
git init
git add .
git commit -m "채팅 사이트"
git branch -M main
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git push -u origin main
```

푸시 후 저장소 Settings → Pages에서 위와 동일하게 설정합니다.

## 6. 친구와 공유

친구에게 아래 2가지만 알려주세요:
- 사이트 주소 (`https://juiceleee.github.io/chat/`)
- **문서 암호** (둘이 똑같이 입력, 이게 다르면 메시지가 안 풀립니다)

방 이름은 따로 공유할 필요가 없습니다.
"사용자"에는 각자 원하는 이름을 넣고, **해당 방의 문서 암호를 동일하게** 입력하면 실시간으로 대화됩니다.
다른 방으로 바꾸려면 **닫기**를 누르고 다른 방의 암호로 다시 여세요.

> UI는 "보호된 통합 문서 → 실적_분석.xlsx" 처럼 보이도록 스프레드시트로 위장돼 있습니다.
> 열/행 머리글(A B C, 1 2 3)과 셀 격자, 수식 표시줄이 있어 곁눈질로는 엑셀 작업처럼 보이고,
> 대화는 표의 한 행(행번호 · 사용자 · 내용 · 시간)으로 채워집니다.

---

## EY 회사 노트북 관련 참고

- `github.io`는 열리는 걸 확인했으니 사이트 자체는 뜹니다.
- 다만 채팅은 Firebase 서버와 통신하므로 아래 도메인이 열려 있어야 합니다:
  - `*.googleapis.com`, `firestore.googleapis.com`
  - `*.gstatic.com` (Firebase SDK 로딩)
- 만약 친구 쪽에서 로그인 후 메시지가 안 오간다면 회사 방화벽이 위 도메인을
  막았을 가능성이 큽니다. 이 경우 브라우저 개발자도구(F12)의 Network/Console 탭에
  차단(blocked) 에러가 뜨는지 확인해 보세요.
- 구글 도메인이 막혀 있다면, 대안으로 **GitHub API를 백엔드처럼 쓰는 방식**으로
  바꿀 수 있습니다 (github.com 도메인만 사용). 필요하면 그 버전도 만들어 드릴게요.

## 로컬에서 먼저 테스트

```bash
cd /Users/seungjo2/Documents/chat
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 열기
```

브라우저 창 두 개(또는 시크릿 창)를 띄워 같은 비밀번호로 입장하면
혼자서도 양쪽 대화를 테스트할 수 있습니다. 기존 방과 추가 방 사이에는 메시지가 전달되지 않습니다.

자동 검증(실제 Firebase 데이터를 읽거나 쓰지 않음):

```bash
node --test tests/chat.test.mjs
```
