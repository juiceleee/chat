import assert from "node:assert/strict";
import { pbkdf2Sync, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import\s+[\s\S]*?\s+from\s+"[^"]+";/g, "");
// 실제 운영 암호를 테스트 파일에 남기지 않고 별도 테스트 암호를 주입합니다.
const configPattern = /const ADDITIONAL_ROOMS = (\[[\s\S]*?\]);/;
const testRooms = JSON.parse(script.match(configPattern)[1]);
testRooms[0].passwordHash = pbkdf2Sync("second-test-password", "chat-room-routing:chatting-99de3", 100000, 32, "sha256").toString("hex");
const testScript = script.replace(configPattern, `const ADDITIONAL_ROOMS = ${JSON.stringify(testRooms)};`);
const legacyRoomId = "sjchat-private-2026";
const secondRoomId = `${legacyRoomId}-2`;

function element() {
  return {
    style: {}, value: "", children: [], disabled: false, hidden: false, attributes: {}, events: {},
    scrollTop: 0, scrollHeight: 100, firstElementChild: {},
    set innerHTML(value) { this.markup = value; this.children = []; },
    get innerHTML() { return this.markup || ""; },
    appendChild(child) { this.children.push(child); },
    contains(target) { return target === this || this.children.some(child => child.contains(target)); },
    getBoundingClientRect() { return { left: 100, right: 290 }; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    addEventListener(name, handler) { this.events[name] = handler; },
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  };
}

function storage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
}

function createApp(source = testScript) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const subscriptions = [];
  const writes = [];
  const alerts = [];
  const downloads = [];
  const objectUrls = [];
  const revokedUrls = [];
  const notifications = [];
  const presenceClients = [];
  const timers = new Map();
  const windowEvents = {};
  const documentEvents = {};
  let nextTimer = 0;
  let permissionRequests = 0;
  let windowFocusCalls = 0;
  class MockNotification {
    static permission = "granted";
    static async requestPermission() { permissionRequests++; return this.permission; }
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
    close() { this.closed = true; }
  }
  for (const id of ["stickerPanel", "stickerToggle", "stickerPreview", "notificationToast", "presencePanel"]) get(id).hidden = true;
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, btoa, atob, crypto: webcrypto, innerWidth: 500,
    Notification: MockNotification,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, handler) => { windowEvents[name] = handler; },
    focus() { windowFocusCalls++; },
    fetch: async (url, options) => {
      downloads.push({ url, options });
      return { ok: true, blob: async () => new Blob(["sticker-fixture"], { type: "image/webp" }) };
    },
    URL: {
      createObjectURL: blob => {
        const url = `blob:sticker-preview-${objectUrls.length + 1}`;
        objectUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL: url => revokedUrls.push(url)
    },
    document: { getElementById: get, querySelector: get, createElement: element,
      title: "Excel", visibilityState: "visible", hasFocus: () => true,
      addEventListener: (name, handler) => { documentEvents[name] = handler; } },
    sessionStorage: storage(), localStorage: storage(),
    alert: message => alerts.push(message),
    initializeApp: () => ({}), getFirestore: () => ({}),
    createPresenceClient: options => {
      const client = { options, stopped: false,
        start(book) { this.book = book; options.onChange({ status: "connecting", members: [] }); },
        stop() { this.stopped = true; } };
      presenceClients.push(client);
      return client;
    },
    collection: (_db, ...path) => path.join("/"),
    query: (path, ...constraints) => ({ path, constraints }),
    orderBy: (...args) => args, limitToLast: count => ({ limitToLast: count }),
    serverTimestamp: () => "server-timestamp",
    onSnapshot: (query, options, next, error) => {
      const subscription = { query, options, next, error, closed: false };
      subscriptions.push(subscription);
      return () => { subscription.closed = true; };
    },
    addDoc: async (path, data) => { writes.push({ path, data }); }
  });
  vm.runInContext(source, context);
  return {
    context, get, subscriptions, writes, alerts, downloads, objectUrls, revokedUrls,
    notifications, timers, windowEvents, documentEvents, presenceClients,
    get permissionRequests() { return permissionRequests; },
    get windowFocusCalls() { return windowFocusCalls; },
    run: code => vm.runInContext(code, context),
    async open(password, name = "테스트 사용자") {
      get("name").value = name;
      get("pass").value = password;
      await vm.runInContext("openBook()", context);
    },
    async send(text) {
      get("text").value = text;
      await vm.runInContext("addRow()", context);
    }
  };
}

function snapshot(data, options = {}) {
  return { metadata: { fromCache: !!options.fromCache }, docChanges: () => data ? [{
    type: options.type || "added",
    doc: { id: options.id || `${data.iv}:${data.ct}`, metadata: { hasPendingWrites: !!options.pending }, data: () => data }
  }] : [] };
}

test("접속 목록은 같은 방의 암호화 이름을 표시하고 닫기·방 전환·페이지 복귀를 처리", async () => {
  const app = createApp();
  await app.open("old-pass");
  const original = app.presenceClients[0];
  assert.equal(original.book.roomId, legacyRoomId);
  const encrypted = await original.options.encrypt("접속 이름");
  assert.notEqual(encrypted.ct, "접속 이름");
  assert.equal(await original.options.decrypt(encrypted), "접속 이름");
  original.options.onChange({ status: "online", members: [
    { name: "나", isSelf: true }, { name: "<img onerror=alert(1)>", isSelf: false }
  ] });
  assert.equal(app.get("presenceToggle").textContent, "접속 2");
  assert.equal(app.get("presenceList").children[1].children[0].textContent, "<img onerror=alert(1)>");
  assert.equal(app.get("presenceList").children[1].children[0].innerHTML, "");
  app.get("presenceToggle").events.click();
  assert.equal(app.get("presencePanel").hidden, false);
  app.get("presencePanel").getBoundingClientRect = () => ({ left: -40, right: 150 });
  app.windowEvents.resize();
  assert.equal(app.get("presencePanel").style.transform, "translateX(52px)");
  app.documentEvents.keydown({ key: "Escape" });
  assert.equal(app.get("presencePanel").hidden, true);
  app.get("presenceToggle").events.click();
  app.documentEvents.click({ target: app.get("text") });
  assert.equal(app.get("presencePanel").hidden, true);
  original.options.onChange({ status: "unavailable", members: [] });
  assert.equal(app.get("presenceToggle").textContent, "접속 —");
  assert.equal(app.subscriptions[0].closed, false);
  assert.equal(app.writes.length, 0);
  app.run("closeBook()");
  assert.equal(original.stopped, true);
  await app.open("second-test-password");
  original.options.onChange({ status: "online", members: [{ name: "이전 방" }] });
  assert.equal(app.get("presenceToggle").textContent, "접속 …");
  assert.equal(app.presenceClients[1].book.roomId, secondRoomId);
  app.windowEvents.pagehide();
  assert.equal(app.presenceClients[1].stopped, true);
  app.windowEvents.pageshow({ persisted: true });
  assert.equal(app.presenceClients.length, 3);
  assert.equal(app.presenceClients[2].book.roomId, secondRoomId);
});

async function incomingMessage(app, text = "비공개 대화 내용", sender = "친구", time = Date.now()) {
  const encrypted = await app.run(`encryptText(currentBook.key, ${JSON.stringify(text)})`);
  return { ...encrypted, sender, createdAt: { toMillis: () => time, toDate: () => new Date(time) } };
}

async function enableLiveNotifications(app) {
  await app.get("notificationsToggle").events.click();
  app.run("clearNotifications()");
  await app.subscriptions.at(-1).next(snapshot(null));
}

test("알림은 기본 꺼짐, 방별 설정 저장, 직접 켤 때만 권한 요청, 추가 Firebase 요청 없음", async () => {
  const app = createApp();
  app.context.Notification.permission = "default";
  await app.open("old-pass");
  assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "false");
  assert.equal(app.permissionRequests, 0);
  await app.get("notificationsToggle").events.click();
  assert.equal(app.permissionRequests, 1);
  assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "true");
  assert.equal(app.context.localStorage.getItem(`chatNotifications:${legacyRoomId}`), "on");
  assert.equal(app.writes.length, 0);
  assert.equal(app.subscriptions.length, 1);
  assert.equal(app.subscriptions[0].options.includeMetadataChanges, true);
  assert.equal(app.subscriptions[0].query.constraints[1].limitToLast, 1000);
  app.run("closeBook()");
  await app.open("second-test-password");
  assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "false");
  app.run("closeBook()");
  await app.open("old-pass");
  assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "true");
  assert.equal(app.permissionRequests, 1);
  await app.get("notificationsToggle").events.click();
  assert.equal(app.context.localStorage.getItem(`chatNotifications:${legacyRoomId}`), "off");
  assert.equal(app.get("notificationToast").hidden, true);
});

test("알림 켜기에서 권한을 직접 요청하고 허용·차단·미결정을 구분해 안내", async () => {
  for (const result of ["granted", "denied", "default"]) {
    const app = createApp();
    app.context.Notification.permission = "default";
    let completePermission;
    app.context.Notification.requestPermission = () => new Promise(resolve => {
      completePermission = () => {
        app.context.Notification.permission = result;
        resolve(result);
      };
    });
    await app.open("old-pass");
    assert.equal(completePermission, undefined);
    const enabling = app.get("notificationsToggle").events.click();
    assert.equal(typeof completePermission, "function");
    assert.match(app.get("notificationToastText").textContent, /‘허용’을 눌러/);
    completePermission();
    await enabling;
    const notice = app.get("notificationToastText").textContent;
    if (result === "granted") assert.match(notice, /컴퓨터 배너 알림을 켰습니다/);
    if (result === "denied") assert.match(notice, /차단되어.*사이트 설정/);
    if (result === "default") assert.match(notice, /아직 허용되지 않았습니다/);
    assert.equal(app.writes.length, 0);
    assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "true");
  }
  const blocked = createApp();
  blocked.context.Notification.permission = "denied";
  await blocked.open("old-pass");
  await blocked.get("notificationsToggle").events.click();
  assert.equal(blocked.permissionRequests, 0);
  assert.match(blocked.get("notificationToastText").textContent, /차단되어/);
});

test("과거 기록은 조용히 읽고 채팅창이 활성 상태여도 새 글·이모티콘은 시스템 배너만 표시", async () => {
  const app = createApp();
  await app.open("second-test-password");
  await app.get("notificationsToggle").events.click();
  app.run("clearNotifications()");
  const next = app.subscriptions[0].next;
  const cached = await incomingMessage(app, "캐시 기록");
  await next(snapshot(cached, { fromCache: true }));
  await next(snapshot(null)); // 캐시와 서버 내용이 같아 metadata만 바뀐 경우
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications.length, 0);
  for (const text of ["새로운 글", "\u001e201"]) {
    const before = app.notifications.length;
    await next(snapshot(await incomingMessage(app, text)));
    assert.equal(app.get("notificationToast").hidden, true);
    assert.equal(app.notifications.length, before + 1);
    assert.equal(app.notifications.at(-1).options.body, "친구님의 새 메시지가 있습니다.");
    assert.equal(app.notifications.at(-1).options.silent, true);
    assert.equal(app.context.document.title, "Excel");
    app.run("clearNotifications()");
  }
  assert.match(app.get("rows").children.at(-1).innerHTML, /sticker-message/);
  app.run("closeBook()");
  await app.open("second-test-password");
  await app.subscriptions[1].next(snapshot(await incomingMessage(app, "서버의 과거 기록")));
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications.length, 2);
});

test("백그라운드 배너는 무음·본문 비공개이며 클릭하면 해당 창·최신 행·입력칸으로 이동", async () => {
  const app = createApp();
  await app.open("old-pass", "같은 이름");
  await enableLiveNotifications(app);
  app.context.document.visibilityState = "hidden";
  // 다른 사용자가 같은 표시 이름을 써도 내 전송으로 오인하지 않습니다.
  await app.subscriptions[0].next(snapshot(await incomingMessage(app, "비공개 본문", "같은 이름")));
  const notification = app.notifications[0];
  assert.equal(notification.options.silent, true);
  assert.equal(notification.options.body, "같은 이름님의 새 메시지가 있습니다.");
  assert.doesNotMatch(JSON.stringify(notification.options), /비공개 본문/);
  assert.equal(app.context.document.title, "● 새 메시지 · Excel");
  assert.equal(app.get("notificationToast").hidden, true);
  app.get(".grid").scrollTop = 0;
  const before = app.get("text").focusCalls;
  notification.onclick({ preventDefault() { assert.fail("활성 방은 브라우저 기본 포커스 동작 유지"); } });
  assert.equal(app.windowFocusCalls, 1);
  assert.equal(app.get("text").focusCalls, before + 1);
  assert.equal(app.get(".grid").scrollTop, app.get(".grid").scrollHeight);
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.context.document.title, "Excel");
  assert.equal(notification.closed, true);
  assert.equal(app.timers.size, 0);
});

test("시스템 알림 차단 시 대체 화면 배너 클릭·닫기·자동 숨김 및 초안 유지", async () => {
  const app = createApp();
  app.context.Notification.permission = "denied";
  await app.open("old-pass");
  await enableLiveNotifications(app);
  app.get("text").value = "작성 중인 초안";
  const next = app.subscriptions[0].next;
  await next(snapshot(await incomingMessage(app)));
  app.windowEvents.focus();
  app.documentEvents.visibilitychange();
  assert.equal(app.get("notificationToast").hidden, false);
  const before = app.get("text").focusCalls;
  app.get("notificationOpen").events.click();
  assert.equal(app.get("text").focusCalls, before + 1);
  assert.equal(app.get("text").value, "작성 중인 초안");
  assert.equal(app.get("notificationToast").hidden, true);
  await next(snapshot(await incomingMessage(app)));
  app.get("notificationDismiss").events.click();
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.get("text").focusCalls, before + 1);
  await next(snapshot(await incomingMessage(app)));
  for (const timer of app.timers.values()) timer();
  assert.equal(app.get("notificationToast").hidden, true);
});

test("내 메시지·중복 수신·오래된 재접속·복호화 실패·알림 끈 상태는 배너 제외", async () => {
  const app = createApp();
  await app.open("old-pass");
  await enableLiveNotifications(app);
  const next = app.subscriptions[0].next;
  await app.send("내가 보낸 글");
  const own = { ...app.writes[0].data, createdAt: { toMillis: () => Date.now() } };
  await next(snapshot(own, { pending: true }));
  await next(snapshot(own, { type: "modified" }));
  await next(snapshot(own, { id: "own-server-echo" }));
  await next(snapshot(await incomingMessage(app, "오래된 기록", "친구", Date.now() - 300000)));
  await next(snapshot({ ...await incomingMessage(app), ct: "invalid" }));
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications.length, 0);
  const fresh = await incomingMessage(app);
  await next(snapshot(fresh));
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications.length, 1);
  app.run("clearNotifications()");
  const rowCount = app.get("rows").children.length;
  await next(snapshot(fresh));
  assert.equal(app.get("rows").children.length, rowCount);
  assert.equal(app.get("notificationToast").hidden, true);
  await app.get("notificationsToggle").events.click();
  await next(snapshot(await incomingMessage(app)));
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications.length, 1);
});

test("권한 거부·미지원·시스템 배너 생성 실패 시에도 화면 배너와 채팅 유지", async () => {
  for (const mode of ["denied", "missing", "throws"]) {
    const app = createApp();
    if (mode === "denied") app.context.Notification.permission = "denied";
    if (mode === "missing") app.context.Notification = undefined;
    if (mode === "throws") app.context.Notification = class {
      static permission = "granted";
      constructor() { throw new Error("unsupported"); }
    };
    await app.open("old-pass");
    await enableLiveNotifications(app);
    app.context.document.hasFocus = () => false;
    await app.subscriptions[0].next(snapshot(await incomingMessage(app)));
    assert.equal(app.get("notificationToast").hidden, false);
    assert.equal(app.get("notificationToastText").textContent, "친구님의 새 메시지가 있습니다.");
    assert.equal(app.notifications.length, 0);
    assert.equal(app.alerts.length, 0);
    assert.equal(app.run("currentBook.roomId"), legacyRoomId);
  }
});

test("다른 앱을 보는 동안 시스템 알림 생성으로 창 안 배너를 숨겨도 탭 제목은 유지", async () => {
  const app = createApp();
  await app.open("old-pass");
  await enableLiveNotifications(app);
  // 채팅 탭이 선택되어 있어도 다른 앱으로 포커스가 이동한 상태입니다.
  app.context.document.hasFocus = () => false;
  app.run('showNotificationToast("이전 안내")');
  await app.subscriptions[0].next(snapshot(await incomingMessage(app)));
  assert.equal(app.notifications.length, 1);
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.timers.size, 0);
  assert.equal(app.context.document.title, "● 새 메시지 · Excel");
  app.context.document.hasFocus = () => true;
  app.windowEvents.focus();
  assert.equal(app.context.document.title, "Excel");
  assert.equal(app.notifications[0].closed, true);
});

test("시스템 알림의 비동기 실패만 화면 배너로 대체하고 오래된 오류는 무시", async () => {
  const app = createApp();
  await app.open("old-pass");
  await enableLiveNotifications(app);
  app.context.document.visibilityState = "hidden";
  const next = app.subscriptions[0].next;
  await next(snapshot(await incomingMessage(app)));
  const first = app.notifications[0];
  first.onerror();
  assert.equal(app.get("notificationToast").hidden, false);
  assert.equal(app.context.document.title, "● 새 메시지 · Excel");
  await next(snapshot(await incomingMessage(app)));
  assert.equal(app.get("notificationToast").hidden, true);
  first.onerror();
  assert.equal(app.get("notificationToast").hidden, true);
  await app.get("notificationsToggle").events.click();
  app.notifications[1].onerror();
  assert.equal(app.get("notificationToast").hidden, true);
  app.run("closeBook()");
  await app.open("second-test-password");
  first.onerror();
  assert.equal(app.get("notificationToast").hidden, true);
});

test("복호화 중 알림을 끄거나 방을 닫으면 늦은 배너를 표시하지 않음", async () => {
  const app = createApp();
  await app.open("old-pass");
  await enableLiveNotifications(app);
  const encrypted = await incomingMessage(app);
  app.run("decryptText = () => new Promise(resolve => { globalThis.releaseDecrypt = resolve; })");
  const pending = app.subscriptions[0].next(snapshot(encrypted));
  await Promise.resolve();
  await app.get("notificationsToggle").events.click();
  app.context.releaseDecrypt("새 대화");
  await pending;
  assert.equal(app.get("notificationToast").hidden, true);
  await app.get("notificationsToggle").events.click();
  app.run("clearNotifications()");
  const afterClose = app.subscriptions[0].next(snapshot(encrypted, { id: "second-message" }));
  await Promise.resolve();
  app.run("closeBook()");
  await app.open("second-test-password");
  app.context.releaseDecrypt("이전 방 메시지");
  await afterClose;
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.get("rows").children.length, 0);
});

test("권한 응답이 늦거나 다른 탭에서 알림을 꺼도 배너가 다시 나타나지 않음", async () => {
  const app = createApp();
  app.context.Notification.permission = "default";
  let resolvePermission;
  app.context.Notification.requestPermission = () => new Promise(resolve => { resolvePermission = resolve; });
  await app.open("old-pass");
  const pending = app.get("notificationsToggle").events.click();
  await app.get("notificationsToggle").events.click();
  resolvePermission("denied");
  await pending;
  assert.equal(app.get("notificationToast").hidden, true);
  app.context.Notification.permission = "granted";
  await enableLiveNotifications(app);
  app.context.document.visibilityState = "hidden";
  await app.subscriptions[0].next(snapshot(await incomingMessage(app)));
  app.windowEvents.storage({ key: `chatNotifications:${legacyRoomId}`, newValue: "off" });
  assert.equal(app.get("notificationsToggle").attributes["aria-checked"], "false");
  assert.equal(app.get("notificationToast").hidden, true);
  assert.equal(app.notifications[0].closed, true);
});

test("이전 방의 시스템 배너는 닫고, 늦게 눌러도 새 방 입력칸을 건드리지 않음", async () => {
  const app = createApp();
  await app.open("old-pass");
  await enableLiveNotifications(app);
  app.context.document.visibilityState = "hidden";
  await app.subscriptions[0].next(snapshot(await incomingMessage(app)));
  const oldNotification = app.notifications[0];
  app.run("closeBook()");
  assert.equal(oldNotification.closed, true);
  await app.open("second-test-password");
  const before = app.get("text").focusCalls;
  let prevented = false;
  oldNotification.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.windowFocusCalls, 0);
  assert.equal(app.get("text").focusCalls, before);
});

test("기존 암호는 기존 경로, 등록 암호는 두 번째 방, 세 번째 방은 비활성", async () => {
  const app = createApp();
  assert.equal(await app.run('resolveRoomId("기존-테스트-암호")'), legacyRoomId);
  assert.equal(await app.run('resolveRoomId("second-test-password")'), secondRoomId);
  assert.equal(await app.run('resolveRoomId("나중에-정할-암호")'), legacyRoomId);
  assert.equal(app.run("ADDITIONAL_ROOMS.length"), 2);
  assert.equal(app.run("ADDITIONAL_ROOMS[1].passwordHash"), "");
});

test("기존 코드의 키로 암호화한 과거 메시지를 그대로 복호화", async () => {
  const pass = "legacy-fixture-password";
  // 기존 코드와 동일한 PBKDF2 salt, 반복 횟수 및 AES-GCM으로 독립 생성합니다.
  const key = await webcrypto.subtle.importKey(
    "raw", pbkdf2Sync(pass, `chat-salt:${legacyRoomId}`, 100000, 32, "sha256"),
    "AES-GCM", false, ["encrypt"]
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("보존할 예전 대화"));
  const app = createApp();
  await app.open(pass);
  assert.equal(app.subscriptions[0].query.path, `rooms/${legacyRoomId}/messages`);
  await app.subscriptions[0].next(snapshot({
    sender: "기존 사용자", iv: Buffer.from(iv).toString("base64"), ct: Buffer.from(ct).toString("base64")
  }));
  assert.match(app.get("rows").children[1].innerHTML, /보존할 예전 대화/);
  assert.doesNotMatch(app.get("rows").children[1].innerHTML, /#VALUE!/);
});

test("같은 추가 암호로 입장한 두 사용자는 같은 방에서 대화", async () => {
  const alice = createApp();
  const bob = createApp();
  await Promise.all([alice.open("second-test-password", "Alice"), bob.open("second-test-password", "Bob")]);
  assert.equal(alice.subscriptions[0].query.path, `rooms/${secondRoomId}/messages`);
  assert.equal(bob.subscriptions[0].query.path, alice.subscriptions[0].query.path);
  await alice.send("새 방의 메시지");
  const message = alice.writes[0];
  assert.equal(message.path, `rooms/${secondRoomId}/messages`);
  assert.equal(message.data.sender, "Alice");
  assert.equal(message.data.createdAt, "server-timestamp");
  assert.notEqual(message.data.ct, "새 방의 메시지");
  await bob.subscriptions[0].next(snapshot(message.data));
  assert.match(bob.get("rows").children[1].innerHTML, /새 방의 메시지/);
});

test("방별 키가 분리되고 기존 방에서 보낸 메시지는 기존 경로에 저장", async () => {
  const app = createApp();
  await app.open("기존-테스트-암호");
  await app.send("기존 방 메시지");
  assert.equal(app.writes[0].path, `rooms/${legacyRoomId}/messages`);
  assert.equal(await app.run(`(async () => {
    const oldKey = await deriveKey("same-password", ROOM_ID);
    const newKey = await deriveKey("same-password", ADDITIONAL_ROOMS[0].id);
    const encrypted = await encryptText(oldKey, "분리 확인");
    return decryptText(newKey, encrypted.iv, encrypted.ct);
  })()`), "#VALUE!");
});

test("닫은 뒤 이전 방의 복호화가 끝나도 새 방 화면에 섞이지 않음", async () => {
  const app = createApp();
  await app.open("old-pass");
  app.run("decryptText = () => new Promise(resolve => { globalThis.releaseDecrypt = resolve; })");
  const oldSubscription = app.subscriptions[0];
  const pending = oldSubscription.next(snapshot({ sender: "old", iv: "", ct: "" }));
  await Promise.resolve();
  assert.equal(typeof app.context.releaseDecrypt, "function");
  app.get("text").value = "이전 방 초안";
  app.run("closeBook()");
  assert.equal(oldSubscription.closed, true);
  assert.equal(app.get("text").value, "");
  assert.equal(app.get("pass").value, "");
  await app.open("second-test-password");
  app.context.releaseDecrypt("늦게 도착한 이전 대화");
  await pending;
  assert.equal(app.get("rows").children.length, 0);
  oldSubscription.error(new Error("late failure"));
  assert.equal(app.run("currentBook.roomId"), secondRoomId);
  assert.equal(app.alerts.length, 0);
});

test("암호화 도중 방을 바꾸면 전송을 취소하여 다른 방으로 보내지 않음", async () => {
  const app = createApp();
  await app.open("old-pass");
  app.run("encryptText = () => new Promise(resolve => { globalThis.releaseEncrypt = resolve; })");
  const pending = app.send("이전 방에만 보낼 메시지");
  app.run("closeBook()");
  await app.open("second-test-password");
  app.context.releaseEncrypt({ iv: "iv", ct: "ct" });
  await pending;
  assert.equal(app.writes.length, 0);
});

test("중복 입장은 구독 하나만 만들고 구독 권한 오류 후 재입장 가능", async () => {
  const app = createApp();
  await Promise.all([app.open("second-test-password"), app.open("second-test-password")]);
  assert.equal(app.subscriptions.length, 1);
  assert.equal(app.get("enter").disabled, false);
  app.subscriptions[0].error(new Error("permission-denied"));
  assert.equal(app.run("currentBook"), null);
  assert.equal(app.get("login").style.display, "block");
  assert.equal(app.subscriptions[0].closed, true);
  assert.equal(app.alerts.length, 1);
  await app.open("old-pass");
  assert.equal(app.subscriptions[1].query.path, `rooms/${legacyRoomId}/messages`);
});

test("전송 오류 시 초안을 복구하고 닫힌 방에서는 전송하지 않음", async () => {
  const app = createApp();
  await app.open("second-test-password");
  app.context.addDoc = async () => { throw new Error("permission-denied"); };
  await app.send("실패한 메시지");
  assert.equal(app.get("text").value, "실패한 메시지");
  assert.equal(app.alerts.length, 1);
  app.run("closeBook()");
  await app.send("닫힌 방 메시지");
  assert.equal(app.writes.length, 0);
});

test("세 번째 암호를 나중에 등록해도 기존 두 방 연결 유지", async () => {
  const app = createApp();
  const hash = pbkdf2Sync("third-test-password", "chat-room-routing:chatting-99de3", 100000, 32, "sha256").toString("hex");
  app.run(`ADDITIONAL_ROOMS[1].passwordHash = "${hash}"`);
  assert.equal(await app.run('resolveRoomId("third-test-password")'), `${legacyRoomId}-3`);
  assert.equal(await app.run('resolveRoomId("second-test-password")'), secondRoomId);
  assert.equal(await app.run('resolveRoomId("old-pass")'), legacyRoomId);
});

test("방별 묶음만 표시하고 방 전환 시 선택을 초기화하며 미리보기에 Firebase 요청 없음", async () => {
  const app = createApp();
  await app.open("old-pass");
  assert.equal(app.get("stickerToggle").hidden, false);
  assert.deepEqual(app.get("stickerTabs").children.map(button => button.value), ["3", "4", "5"]);
  app.run('toggleStickerPicker(); selectSticker("201")');
  await app.run("sendSticker()");
  assert.equal(app.get("stickerPanel").hidden, false);
  assert.equal(app.get("stickerGrid").children.length, 32);
  assert.equal(app.get("stickerGrid").children[0].children[0].src, "assets/stickers/bear-in-love-ver-3/01.png");
  assert.equal(app.get("stickerSend").disabled, true);
  assert.equal(app.writes.length, 0);
  app.run("closeBook()");
  await app.open("second-test-password");
  assert.equal(app.get("stickerToggle").hidden, false);
  assert.deepEqual(app.get("stickerTabs").children.map(button => button.value), ["2", "1"]);
  app.get("stickerToggle").events.click();
  assert.equal(app.get("stickerGrid").children.length, 24);
  assert.equal(app.get("stickerSend").disabled, true);
  app.get("stickerGrid").children[0].events.click();
  assert.equal(app.get("stickerPreview").src, "assets/stickers/wonni-2/01.webp");
  assert.equal(app.get("stickerSend").disabled, false);
  assert.equal(app.writes.length, 0);
  assert.equal(app.subscriptions.length, 2);
  const [firstTab, secondTab] = app.get("stickerTabs").children;
  assert.equal(firstTab.attributes.role, "tab");
  assert.equal(firstTab.children[0].src, "assets/stickers/wonni-2/01.webp");
  assert.equal(firstTab.attributes["aria-selected"], "true");
  firstTab.events.click();
  assert.equal(app.get("stickerSend").disabled, false);
  secondTab.events.click();
  assert.equal(firstTab.attributes["aria-selected"], "false");
  assert.equal(secondTab.attributes["aria-selected"], "true");
  assert.equal(secondTab.tabIndex, 0);
  assert.equal(firstTab.tabIndex, -1);
  assert.equal(app.get("stickerGrid").attributes["aria-labelledby"], secondTab.id);
  assert.equal(app.get("stickerPackName").textContent, "리센느 X 안원잘부 시즌1");
  assert.equal(app.get("stickerGrid").children.length, 24);
  assert.equal(app.get("stickerGrid").children[23].children[0].src, "assets/stickers/wonni-s1/24.webp");
  assert.equal(app.get("stickerSend").disabled, true);
  assert.equal(app.get("stickerPreview").hidden, true);
  const key = key => ({ key, preventDefault() {} });
  secondTab.events.keydown(key("ArrowRight"));
  assert.equal(firstTab.attributes["aria-selected"], "true");
  firstTab.events.keydown(key("End"));
  assert.equal(secondTab.attributes["aria-selected"], "true");
  secondTab.events.keydown(key("Home"));
  assert.equal(firstTab.attributes["aria-selected"], "true");
  assert.equal(app.writes.length, 0);
  assert.equal(app.subscriptions.length, 2);
  app.run("closeBook()");
  assert.equal(app.get("stickerPanel").hidden, true);
  assert.equal(app.get("stickerToggle").hidden, true);
  assert.equal(app.get("stickerGrid").children.length, 0);
  await app.open("old-pass");
  assert.deepEqual(app.get("stickerTabs").children.map(button => button.value), ["3", "4", "5"]);
  assert.equal(app.run("activeStickerPack"), "3");
  assert.equal(app.run("selectedSticker"), null);
});

test("두 방의 136개 ID와 PNG/WebP 파일이 유효하고 기존 48개 ID 유지", async () => {
  const app = createApp();
  const catalog = app.run("Array.from(STICKERS.values())");
  assert.equal(catalog.length, 136);
  assert.equal(catalog.filter(sticker => sticker.roomId === legacyRoomId).length, 88);
  assert.equal(catalog.filter(sticker => sticker.roomId === secondRoomId).length, 48);
  for (const sticker of catalog) {
    assert.match(sticker.id, /^[1-5](0[1-9]|[12][0-9]|3[0-2])$/);
    const image = await readFile(new URL(`../${sticker.src}`, import.meta.url));
    if (sticker.src.endsWith(".png")) {
      assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    } else {
      assert.equal(image.toString("ascii", 0, 4), "RIFF");
      assert.equal(image.toString("ascii", 8, 12), "WEBP");
    }
    if (sticker.roomId === secondRoomId) {
      assert.match(sticker.id, /^[12](0[1-9]|1[0-9]|2[0-4])$/);
      const folder = sticker.id[0] === "2" ? "wonni-2" : "wonni-s1";
      assert.equal(sticker.src, `assets/stickers/${folder}/${sticker.id.slice(1)}.webp`);
    }
  }
});

test("이미지 대신 4바이트 코드만 암호화하여 한 문서에 저장하고 다른 사용자가 표시", async () => {
  const alice = createApp();
  const bob = createApp();
  await Promise.all([alice.open("second-test-password"), bob.open("second-test-password")]);
  alice.get("text").value = "작성 중인 초안";
  alice.run('toggleStickerPicker(); selectSticker("201")');
  await alice.get("stickerSend").events.click();
  assert.equal(alice.writes.length, 1);
  const { path, data } = alice.writes[0];
  assert.equal(path, `rooms/${secondRoomId}/messages`);
  assert.deepEqual(Object.keys(data).sort(), ["createdAt", "ct", "iv", "sender"]);
  assert.equal(data.ct.length, 28);
  assert.equal(data.iv.length, 16);
  const plaintext = await alice.run(`decryptText(currentBook.key, "${data.iv}", "${data.ct}")`);
  assert.equal(plaintext, "\u001e201");
  assert.equal(Buffer.byteLength(plaintext), 4);
  assert.equal(alice.get("text").value, "작성 중인 초안");
  assert.equal(alice.get("stickerPanel").hidden, true);
  await bob.subscriptions[0].next(snapshot(data));
  assert.match(bob.get("rows").children[1].innerHTML, /class="sticker-message" src="assets\/stickers\/wonni-2\/01.webp"/);
});

test("등록되지 않은 ID·임의 HTML·다른 방의 이모티콘은 이미지로 해석하지 않음", async () => {
  const app = createApp();
  await app.open("second-test-password");
  for (const text of ["\u001e999", "\u001e201 extra", "\u001ehttps://example.com/image.webp", '<img src=x onerror="alert(1)">']) {
    app.run(`renderRow("sender", ${JSON.stringify(text)})`);
    assert.doesNotMatch(app.get("rows").children.at(-1).innerHTML, /<img/);
  }
  assert.match(app.get("rows").children.at(-1).innerHTML, /&lt;img/);
  app.run("closeBook()");
  await app.open("old-pass");
  app.run('renderRow("sender", STICKER_PREFIX + "201")');
  assert.doesNotMatch(app.get("rows").children.at(-1).innerHTML, /<img/);
  const hash = pbkdf2Sync("third-test-password", "chat-room-routing:chatting-99de3", 100000, 32, "sha256").toString("hex");
  app.run(`closeBook(); ADDITIONAL_ROOMS[1].passwordHash = "${hash}"`);
  await app.open("third-test-password");
  assert.equal(app.get("stickerToggle").hidden, true);
  app.run('toggleStickerPicker(); selectSticker("201")');
  await app.run("sendSticker()");
  assert.equal(app.writes.length, 0);
});

test("기존 방에서 세 묶음을 짧은 암호문으로 전송하고 같은 방에서만 표시·재생", async () => {
  const alice = createApp();
  const bob = createApp();
  const otherRoom = createApp();
  await Promise.all([alice.open("old-pass"), bob.open("old-pass"), otherRoom.open("second-test-password")]);
  for (const [id, folder, ext] of [
    ["332", "bear-in-love-ver-3", "png"],
    ["432", "rabbit-in-love-ver-3", "png"],
    ["524", "bear-and-rabbit-are-in-love", "webp"]
  ]) {
    alice.run("toggleStickerPicker()");
    alice.get("stickerTabs").children.find(button => button.value === id[0]).events.click();
    assert.equal(alice.get("stickerGrid").children.length, id[0] === "5" ? 24 : 32);
    alice.get("stickerGrid").children.at(-1).events.click();
    await alice.get("stickerSend").events.click();
    const { path, data } = alice.writes.at(-1);
    assert.equal(path, `rooms/${legacyRoomId}/messages`);
    assert.equal(data.ct.length, 28);
    assert.equal(await alice.run(`decryptText(currentBook.key, "${data.iv}", "${data.ct}")`), `\u001e${id}`);
    await bob.subscriptions[0].next(snapshot(data));
    const markup = bob.get("rows").children.at(-1).innerHTML;
    assert.ok(markup.includes(`assets/stickers/${folder}/${id.slice(1)}.${ext}`));
    assert.match(markup, /width="80" height="80"/);
    assert.equal(markup.includes('class="sticker-replay"'), ext === "webp");
    otherRoom.run(`renderRow("sender", STICKER_PREFIX + "${id}")`);
    assert.doesNotMatch(otherRoom.get("rows").children.at(-1).innerHTML, /<img/);
  }
  bob.context.replayImage = { src: "original.webp" };
  await bob.run('replaySticker(replayImage, STICKERS.get("524"))');
  assert.match(bob.context.replayImage.src, /^blob:/);
  await bob.run('replaySticker(replayImage, STICKERS.get("332"))');
  assert.equal(bob.downloads.length, 1);
  assert.equal(bob.writes.length, 0);
  assert.equal(alice.writes.length, 3);
});

test("다른 방의 묶음·ID를 지정해도 선택·전송·재생할 수 없음", async () => {
  const app = createApp();
  for (const [pass, forbiddenPack, forbiddenId] of [["old-pass", "2", "201"], ["second-test-password", "5", "501"]]) {
    await app.open(pass);
    app.run("toggleStickerPicker()");
    const activePack = app.run("activeStickerPack");
    const firstImage = app.get("stickerGrid").children[0].children[0].src;
    app.run(`showStickerPack("${forbiddenPack}")`);
    assert.equal(app.run("activeStickerPack"), activePack);
    assert.equal(app.get("stickerGrid").children[0].children[0].src, firstImage);
    app.run(`selectSticker("${forbiddenId}")`);
    assert.equal(app.run("selectedSticker"), null);
    app.run(`selectedSticker = STICKERS.get("${forbiddenId}")`);
    await app.run("sendSticker()");
    app.context.replayImage = { src: "unchanged.webp" };
    await app.run(`replaySticker(replayImage, STICKERS.get("${forbiddenId}"))`);
    assert.equal(app.context.replayImage.src, "unchanged.webp");
    assert.equal(app.downloads.length, 0);
    assert.equal(app.writes.length, 0);
    app.run("closeBook()");
  }
});

test("이모티콘 전송 실패 후 선택을 유지하여 재시도하며 중복 클릭은 한 번만 전송", async () => {
  const app = createApp();
  await app.open("second-test-password");
  const originalAddDoc = app.context.addDoc;
  app.context.addDoc = async () => { throw new Error("offline"); };
  app.run('toggleStickerPicker(); selectSticker("124")');
  await app.run("sendSticker()");
  assert.equal(app.alerts.length, 1);
  assert.equal(app.get("stickerPanel").hidden, false);
  assert.equal(app.get("stickerSend").disabled, false);
  assert.equal(app.run("selectedSticker.id"), "124");
  app.context.addDoc = originalAddDoc;
  await Promise.all([app.run("sendSticker()"), app.run("sendSticker()")]);
  assert.equal(app.writes.length, 1);
});

test("이모티콘 암호화 중 방을 닫으면 저장을 취소하고 다음 세션 선택을 보존", async () => {
  const app = createApp();
  await app.open("second-test-password");
  app.run('toggleStickerPicker(); selectSticker("201"); encryptText = () => new Promise(resolve => { globalThis.releaseEncrypt = resolve; })');
  const pending = app.run("sendSticker()");
  app.run("closeBook()");
  await app.open("second-test-password");
  app.run('toggleStickerPicker(); selectSticker("224")');
  app.context.releaseEncrypt({ iv: "iv", ct: "ct" });
  await pending;
  assert.equal(app.writes.length, 0);
  assert.equal(app.run("selectedSticker.id"), "224");
  assert.equal(app.get("stickerPanel").hidden, false);
  assert.equal(app.get("stickerSend").disabled, false);
});

test("다시 재생은 이미지 파일을 재사용하고 매번 새 로컬 URL로 시작하며 Firebase 요청 없음", async () => {
  const app = createApp();
  await app.open("second-test-password");
  app.context.replayImage = { src: "assets/stickers/wonni-2/01.webp" };
  await app.run('replaySticker(replayImage, STICKERS.get("201"))');
  const firstUrl = app.context.replayImage.src;
  await app.run('replaySticker(replayImage, STICKERS.get("201"))');
  const secondUrl = app.context.replayImage.src;
  assert.notEqual(firstUrl, secondUrl);
  assert.equal(app.downloads.length, 1);
  assert.equal(app.downloads[0].url, "assets/stickers/wonni-2/01.webp");
  assert.equal(app.downloads[0].options.cache, "force-cache");
  assert.equal(app.objectUrls[0].blob, app.objectUrls[1].blob);
  assert.deepEqual(app.revokedUrls, [firstUrl]);
  assert.equal(app.writes.length, 0);
  assert.equal(app.subscriptions.length, 1);
  app.run("closeBook()");
  assert.deepEqual(app.revokedUrls, [firstUrl, secondUrl]);
  assert.equal(app.run("stickerBlobs.size"), 0);
  await app.open("old-pass");
  await app.run('replaySticker(replayImage, STICKERS.get("201"))');
  assert.equal(app.downloads.length, 1);
});

test("연속 재생 클릭은 마지막 요청만 적용하고 방을 닫으면 늦은 재생을 취소", async () => {
  const app = createApp();
  await app.open("second-test-password");
  let finishDownload;
  app.context.fetch = () => new Promise(resolve => { finishDownload = resolve; });
  app.context.replayImage = { src: "original.webp" };
  const first = app.run('replaySticker(replayImage, STICKERS.get("201"))');
  const second = app.run('replaySticker(replayImage, STICKERS.get("201"))');
  finishDownload({ ok: true, blob: async () => new Blob(["fixture"]) });
  await Promise.all([first, second]);
  assert.equal(app.objectUrls.length, 1);
  const late = app.run('replaySticker(replayImage, STICKERS.get("202"))');
  app.run("closeBook()");
  finishDownload({ ok: true, blob: async () => new Blob(["fixture"]) });
  await late;
  assert.equal(app.objectUrls.length, 1);
  assert.equal(app.alerts.length, 0);
});

test("재생 파일 다운로드 실패 시 원래 이미지를 유지하고 다시 클릭하여 재시도 가능", async () => {
  const app = createApp();
  await app.open("second-test-password");
  const originalFetch = app.context.fetch;
  app.context.fetch = async () => ({ ok: false });
  app.context.replayImage = { src: "original.webp" };
  await app.run('replaySticker(replayImage, STICKERS.get("201"))');
  assert.equal(app.context.replayImage.src, "original.webp");
  assert.equal(app.alerts.length, 1);
  assert.equal(app.run("stickerBlobs.size"), 0);
  app.context.fetch = originalFetch;
  await app.run('replaySticker(replayImage, STICKERS.get("201"))');
  assert.match(app.context.replayImage.src, /^blob:/);
  assert.equal(app.writes.length, 0);
});
