import assert from "node:assert/strict";
import test from "node:test";
import { createPresenceClient } from "../presence.mjs";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const value = name => ({ iv: "encrypted-iv", ct: JSON.stringify({ type: "presence", name }) });
function fixture(overrides = {}) {
  const listeners = new Map();
  const events = [];
  const states = [];
  let next = 0;
  const backend = {
    uid: "self", ref: path => path, push: path => `${path}/connection-${++next}`,
    onValue(path, callback, fail) { listeners.set(path, { callback, fail }); return () => listeners.delete(path); },
    onDisconnect: path => ({ remove: async () => events.push(["onDisconnect", path]) }),
    set: async (path, data) => { events.push(["set", path, data]); },
    remove: async path => { events.push(["remove", path]); },
    goOnline: () => events.push(["online"]), goOffline: () => events.push(["offline"]),
    ...overrides.backend
  };
  const client = createPresenceClient({
    load: async () => backend, encrypt: async text => ({ iv: "cipher-iv", ct: `encrypted:${text}` }),
    decrypt: async item => item.ct, onChange: state => states.push(state), ...overrides.client
  });
  return {
    client, backend, listeners, events, states,
    start: () => client.start({ roomId: "room-a", name: "나" }),
    async emit(path, data) { await listeners.get(path).callback({ val: () => data }); await tick(); }
  };
}

test("disconnect cleanup is registered before writing encrypted presence, and never writes a heartbeat", async () => {
  const f = fixture();
  await f.start();
  await f.emit(".info/connected", true);
  assert.deepEqual(f.events.map(event => event[0]), ["online", "onDisconnect", "set"]);
  assert.equal(f.events[2][1], "presence/room-a/self/connection-1");
  assert.match(f.events[2][2].ct, /^encrypted:/);
  assert.deepEqual(Object.keys(f.events[2][2]), ["iv", "ct"]);
  assert.equal(f.states.at(-1).status, "connecting");
  await f.emit("presence/room-a", { self: { one: value("나") } });
  assert.equal(f.states.at(-1).status, "online");
  assert.equal(f.states.at(-1).members[0].isSelf, true);
  f.client.stop();
  assert.deepEqual(f.events.slice(-2).map(event => event[0]), ["remove", "offline"]);
  assert.equal(f.listeners.size, 0);
});

test("groups browser tabs by uid, ignores wrong-password/invalid data, preserves identical names from different users", async () => {
  const f = fixture();
  await f.start();
  await f.emit(".info/connected", true);
  await f.emit("presence/room-a", {
    self: { one: value("나"), two: value("나") },
    friend: { one: value("친구") }, another: { one: value("친구") },
    invalid: { one: { iv: "x", ct: "#VALUE!" }, two: { ct: "{}" } },
    wrongType: { one: { iv: "x", ct: '{"type":"message","name":"no"}' } },
    empty: { one: value("") }
  });
  const latest = f.states.at(-1);
  assert.equal(latest.members.length, 3);
  assert.equal(latest.members[0].name, "나");
  f.client.stop();
});

test("offline does not show stale counts, reconnect registers cleanup again and removes only owned connections", async () => {
  const f = fixture();
  await f.start();
  await f.emit(".info/connected", true);
  await f.emit("presence/room-a", { self: { one: value("나") }, friend: { one: value("친구") } });
  await f.emit(".info/connected", false);
  assert.deepEqual(f.states.at(-1), { status: "offline", members: [] });
  await f.emit(".info/connected", true);
  assert.equal(f.states.at(-1).status, "connecting");
  assert.equal(f.events.filter(event => event[0] === "onDisconnect").length, 2);
  await f.emit("presence/room-a", { self: { one: value("나") } });
  assert.equal(f.states.at(-1).members.length, 1);
  f.client.stop();
  assert.ok(f.events.filter(event => event[0] === "remove").every(event => event[1].startsWith("presence/room-a/self/")));
});

test("closing while disconnect registration is pending cannot publish a ghost connection", async () => {
  let release;
  const f = fixture({ backend: { onDisconnect: () => ({ remove: () => new Promise(resolve => { release = resolve; }) }) } });
  await f.start();
  const pending = f.emit(".info/connected", true);
  f.client.stop();
  release();
  await pending;
  assert.equal(f.events.filter(event => event[0] === "set").length, 0);
  assert.equal(f.listeners.size, 0);
});

test("late decryption from a previous snapshot cannot bring back a departed user", async () => {
  let release;
  const f = fixture({ client: { decrypt: item => item.ct === "slow" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(item.ct) } });
  await f.start();
  await f.emit(".info/connected", true);
  const old = f.emit("presence/room-a", { self: { one: value("나") }, left: { one: { iv: "x", ct: "slow" } } });
  await tick();
  await f.emit("presence/room-a", { self: { one: value("나") } });
  release(value("떠난 친구").ct);
  await old;
  assert.deepEqual(f.states.at(-1).members.map(member => member.name), ["나"]);
  f.client.stop();
});

test("late load after closing cannot open a connection; permission errors stop presence cleanly", async () => {
  let release;
  const f = fixture({ client: { load: () => new Promise(resolve => { release = resolve; }) } });
  const opening = f.start();
  f.client.stop();
  release(f.backend);
  await opening;
  assert.equal(f.events.length, 0);
  const g = fixture();
  await g.start();
  g.listeners.get("presence/room-a").fail(new Error("permission denied"));
  assert.equal(g.states.at(-1).status, "unavailable");
  assert.equal(g.listeners.size, 0);
  assert.equal(g.events.at(-1)[0], "offline");
});

test("backend failure is contained within presence", async () => {
  const f = fixture({ client: { load: async () => { throw new Error("offline"); } } });
  await f.start();
  assert.deepEqual(f.states.at(-1), { status: "unavailable", members: [] });
  assert.equal(f.events.length, 0);
});
