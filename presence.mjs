// Presence lives in Realtime Database, independently of the message listener.
// No heartbeat writes: the server removes each connection on disconnect.
export function createPresenceClient({ load, encrypt, decrypt, onChange }) {
  let stopped = false;
  let backend;
  let connected = false;
  let registered = false;
  let generation = 0;
  let revision = 0;
  let members = [];
  const subscriptions = [];
  const owned = new Set();
  const decoded = new Map();
  const emit = status => {
    if (!stopped) onChange({ status, members: status === "online" ? members : [] });
  };
  const publish = () => {
    if (connected && registered) emit(members.some(member => member.isSelf) ? "online" : "connecting");
  };
  const remove = ref => { backend.remove(ref).catch(() => {}); };

  async function start({ roomId, name }) {
    emit("connecting");
    try {
      const [loaded, payload] = await Promise.all([
        load(), encrypt(JSON.stringify({ type: "presence", name: name.slice(0, 80) }))
      ]);
      if (stopped) return;
      backend = loaded;
      const root = backend.ref(`presence/${roomId}`);
      const fail = () => {
        if (stopped) return;
        emit("unavailable");
        stop();
      };
      backend.goOnline();
      subscriptions.push(backend.onValue(root, async snapshot => {
        const version = ++revision;
        const activeKeys = new Set();
        try {
          const entries = await Promise.all(Object.entries(snapshot.val() || {}).map(async ([id, sessions]) => {
            if (!sessions || typeof sessions !== "object") return null;
            for (const value of Object.values(sessions)) {
              if (!value || typeof value.iv !== "string" || typeof value.ct !== "string") continue;
              const cacheKey = `${value.iv}:${value.ct}`;
              activeKeys.add(cacheKey);
              if (!decoded.has(cacheKey)) decoded.set(cacheKey, (async () => {
                try {
                  const info = JSON.parse(await decrypt(value));
                  return info.type === "presence" && typeof info.name === "string" && info.name.trim()
                    ? info.name.slice(0, 80) : null;
                } catch { return null; }
              })());
              const displayName = await decoded.get(cacheKey);
              if (displayName) return { id, name: displayName, isSelf: id === backend.uid };
            }
            return null;
          }));
          if (stopped || version !== revision) return;
          for (const key of decoded.keys()) if (!activeKeys.has(key)) decoded.delete(key);
          members = entries.filter(Boolean).sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name, "ko"));
          publish();
        } catch { fail(); }
      }, fail));
      subscriptions.push(backend.onValue(backend.ref(".info/connected"), async snapshot => {
        const epoch = ++generation;
        connected = snapshot.val() === true;
        registered = false;
        if (!connected) {
          revision++;
          members = [];
          emit("offline");
          return;
        }
        emit("connecting");
        // Remove any previous connection owned by this tab on a reconnect.
        for (const old of owned) remove(old);
        owned.clear();
        const connection = backend.push(backend.ref(`presence/${roomId}/${backend.uid}`));
        owned.add(connection);
        try {
          await backend.onDisconnect(connection).remove();
          if (stopped || !connected || epoch !== generation) return;
          await backend.set(connection, payload);
          if (stopped || !connected || epoch !== generation) return;
          registered = true;
          publish();
        } catch {
          if (!stopped && epoch === generation) fail();
        }
      }, fail));
    } catch {
      if (!stopped) { emit("unavailable"); stop(); }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    revision++;
    for (const unsubscribe of subscriptions) unsubscribe();
    if (backend) {
      // Queue removals first; onDisconnect also covers page exit/network loss.
      for (const ref of owned) remove(ref);
      backend.goOffline();
    }
    owned.clear();
    decoded.clear();
  }
  return { start, stop };
}
