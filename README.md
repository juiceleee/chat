# 둘만의 채팅 (GitHub Pages + Firebase)

친구 한 명과 1:1로 대화하는 웹 채팅입니다. GitHub Pages(정적 호스팅)에 올리고,
메시지 저장/실시간 전달은 **Firebase Firestore**가 담당합니다.
메시지는 **브라우저에서 암호화**되어 저장되므로, Firebase에는 암호문만 남습니다.

- 실시간 채팅 (Firestore 실시간 구독)
- 종단간 암호화 (공유 비밀번호 기반 AES-GCM)
- **단일 방 고정**: 방 이름을 코드에 숨겨 박아두고, 화면엔 이름 + 암호만 입력
- **위장 UI**: "보호된 통합 문서 / 실적_분석.xlsx" 처럼 보이는 스프레드시트(엑셀) 테마
- 서버 코드 불필요 (파일 1개짜리 정적 사이트)

---

## 전체 순서 요약

1. Firebase 프로젝트 만들기 + Firestore 켜기
2. 웹 앱 등록해서 `firebaseConfig` 값 복사
3. `index.html`에 그 값 붙여넣기
4. Firestore 보안 규칙 설정
5. GitHub 저장소 만들고 GitHub Pages로 배포
6. 친구에게 `주소 + 문서 암호` 공유 (방 이름은 코드에 고정돼 있어 공유 불필요)

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
Firebase 콘솔 → **Firestore Database → 규칙** 탭에서 아래로 교체 후 **게시**:

아래 규칙은 **`index.html`에 박아둔 단일 방(`sjchat-private-2026`)만 허용**합니다.
다른 방 이름으로는 읽기/쓰기가 모두 거부되므로 제3자가 새 방을 만들 수 없습니다.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{room}/messages/{msg} {
      // 코드에 고정된 방 하나만 허용
      allow read: if room == 'sjchat-private-2026';
      allow create: if room == 'sjchat-private-2026'
                    && request.resource.data.keys().hasOnly(['sender','iv','ct','createdAt'])
                    && request.resource.data.sender is string
                    && request.resource.data.iv is string
                    && request.resource.data.ct is string
                    && request.resource.data.ct.size() < 20000;
      allow update, delete: if false;
    }
    // 그 외 모든 경로 거부
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

> - 방 이름(`sjchat-private-2026`)은 `index.html`에 고정돼 있고 화면에 노출되지 않습니다.
> - 위 규칙 덕분에 다른 방 이름으로는 아무것도 저장/조회할 수 없습니다.
> - 설령 이 방 이름이 알려져도, 메시지는 공유 암호로 암호화돼 있어 내용은 복호화 불가입니다.
> - 방 이름을 바꾸고 싶으면 `index.html`의 `ROOM_ID`와 이 규칙의 값을 **똑같이** 바꾸세요.

## 5. GitHub Pages로 배포

### 방법 A — 웹에서 (가장 쉬움)
1. GitHub에서 **New repository** 생성 (Public)
2. **Add file → Upload files** 로 `index.html` 업로드 후 커밋
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

방 이름은 `index.html`에 고정돼 있어 따로 공유할 필요가 없습니다.
"작성자"에는 각자 원하는 이름을 넣고, **문서 암호만 동일하게** 입력하면 실시간으로 대화됩니다.

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

브라우저 창 두 개(또는 시크릿 창)를 띄워 같은 방 코드/비밀번호로 입장하면
혼자서도 양쪽 대화를 테스트할 수 있습니다.
