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
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    addEventListener(name, handler) { this.events[name] = handler; }, focus() {}
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
  for (const id of ["stickerPanel", "stickerToggle", "stickerPreview"]) get(id).hidden = true;
  const context = vm.createContext({
    TextEncoder, TextDecoder, Uint8Array, btoa, atob, crypto: webcrypto,
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
    document: { getElementById: get, querySelector: get, createElement: element },
    sessionStorage: storage(), localStorage: storage(),
    alert: message => alerts.push(message),
    initializeApp: () => ({}), getFirestore: () => ({}),
    collection: (_db, ...path) => path.join("/"),
    query: (path, ...constraints) => ({ path, constraints }),
    orderBy: (...args) => args, limit: count => count,
    serverTimestamp: () => "server-timestamp",
    onSnapshot: (query, next, error) => {
      const subscription = { query, next, error, closed: false };
      subscriptions.push(subscription);
      return () => { subscription.closed = true; };
    },
    addDoc: async (path, data) => { writes.push({ path, data }); }
  });
  vm.runInContext(source, context);
  return {
    context, get, subscriptions, writes, alerts, downloads, objectUrls, revokedUrls,
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

function snapshot(data) {
  return { docChanges: () => [{ type: "added", doc: { data: () => data } }] };
}

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
  assert.deepEqual(app.get("stickerPack").children.map(option => option.value), ["3", "4", "5"]);
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
  assert.deepEqual(app.get("stickerPack").children.map(option => option.value), ["2", "1"]);
  app.get("stickerToggle").events.click();
  assert.equal(app.get("stickerGrid").children.length, 24);
  assert.equal(app.get("stickerSend").disabled, true);
  app.get("stickerGrid").children[0].events.click();
  assert.equal(app.get("stickerPreview").src, "assets/stickers/wonni-2/01.webp");
  assert.equal(app.get("stickerSend").disabled, false);
  assert.equal(app.writes.length, 0);
  assert.equal(app.subscriptions.length, 2);
  app.get("stickerPack").value = "1";
  app.get("stickerPack").events.change();
  assert.equal(app.get("stickerGrid").children.length, 24);
  assert.equal(app.get("stickerGrid").children[23].children[0].src, "assets/stickers/wonni-s1/24.webp");
  assert.equal(app.get("stickerSend").disabled, true);
  app.run("closeBook()");
  assert.equal(app.get("stickerPanel").hidden, true);
  assert.equal(app.get("stickerToggle").hidden, true);
  assert.equal(app.get("stickerGrid").children.length, 0);
  await app.open("old-pass");
  assert.deepEqual(app.get("stickerPack").children.map(option => option.value), ["3", "4", "5"]);
  assert.equal(app.get("stickerPack").value, "3");
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
    alice.get("stickerPack").value = id[0];
    alice.get("stickerPack").events.change();
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
    app.get("stickerPack").value = forbiddenPack;
    app.get("stickerPack").events.change();
    assert.equal(app.get("stickerGrid").children.length, 0);
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
