// Sync v2, main process only.
//
// Every record (see core.toRecords) is its own node:
//   sync/<passphrase>-v2/<kind>/<encoded key> = { j: JSON text, t } | { t, d: true }
// Newest t wins per record (core.applyRemote), so two devices editing different
// items never overwrite each other, and deletes travel as tombstones.
//
// The backend is injected: main.js passes firebaseBackend() or httpBackend()
// (the FloatNote server, server/), the tests pass in-memory fakes. Shape:
//   connect() → Promise                       sign in
//   get(root) → Promise<{kind: {key: wire}}>  one read of everything
//   update(root, {'kind/key': wire|null})     multi-path write, null removes
//   listen(root, kind, cb(key, wire)) → off   child added + changed
//   onConnected(cb(bool)) → off
// A rejected update or get whose error has offline: true means the network, not
// the server: the status reads offline instead of error, and the retry is the same.
//
// Loaded by main.js (require) and by FloatNote-web (<script>, as window.FNSync,
// after core.js), which supplies its own backend over the Firebase web SDK.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.FNSync = factory(root.FNCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

function rootFor(passphrase) {
  return 'sync/' + passphrase + '-v2';
}

function message(err) {
  return (err && (err.message || err.code)) || String(err);
}

function failed(err) {
  return err && err.offline ? { mode: 'offline', error: null } : { mode: 'error', error: message(err) };
}

// A failed start is retried after RETRY_MIN_MS, doubling up to RETRY_MAX_MS.
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function createSync(opts) {
  const { backend, clock, getRecords, onRemote, onStatus } = opts;
  const now = opts.now || Date.now;
  // lastSync is when this device last synced for real: getLastSync reads it and
  // onSynced reports it, so main can keep it on disk. Timers are injectable.
  const getLastSync = opts.getLastSync || (() => null);
  const onSynced = opts.onSynced || (() => {});
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
  // The record kinds this device sends and receives. The phone page shows only
  // items, so it syncs only items and completions and cannot clobber notes.
  const kinds = opts.kinds || C.RECORD_KINDS;
  const synced = (path) => kinds.includes(path.slice(0, path.indexOf('/')));

  let gen = 0;          // bumped by start/stop; callbacks from an older run are ignored
  let root = null;      // set once the first reconcile is done
  let unsubs = [];
  let pending = null;   // remote records decided but not yet handed to onRemote
  let status = { mode: 'off', lastSync: null, error: null };
  let wanted = null;    // the passphrase to keep trying with after a failed start
  let retryTimer = null;
  let retryDelay = RETRY_MIN_MS;

  function setStatus(s) {
    status = Object.assign({}, status, s);
    if (s.lastSync) onSynced(s.lastSync);
    if (onStatus) onStatus(status);
  }

  function cancelRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    cancelRetry();
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimer(() => { retryTimer = null; if (wanted) run(wanted); }, delay);
  }

  function push(paths) {
    paths = paths.filter(synced);
    if (!root || !paths.length) return Promise.resolve();
    const records = getRecords();
    const map = {};
    for (const p of paths) map[C.pathToKey(p)] = C.toWire(clock, records, p);
    const myGen = gen;
    return Promise.resolve(backend.update(root, map)).then(
      () => { if (myGen === gen) setStatus({ lastSync: now(), error: null }); },
      (err) => {
        if (myGen !== gen) return;
        setStatus(failed(err));
        // A refused write is not queued anywhere, so nothing would ever re-send
        // it. A fresh run reconciles: it pushes whatever the server lacks.
        if (wanted && retryTimer === null) scheduleRetry();
      }
    );
  }

  // Hand decided records over in one batch. A server message delivers its child
  // events synchronously, so a microtask collects them all, and no local save
  // (an IPC task) can land between the clock moving and the state catching up.
  function flush() {
    const patch = pending;
    pending = null;
    if (patch) {
      onRemote(patch);
      setStatus({ lastSync: now() });
    }
  }

  function incoming(myGen, path, wire) {
    if (myGen !== gen) return;
    const r = C.applyRemote(clock, path, wire);
    if (r) {
      if (!pending) { pending = {}; queueMicrotask(flush); }
      pending[path] = r.value;
    } else if (C.localIsNewer(clock, path, wire)) {
      // The server holds an older copy than ours (it keeps the last write, not
      // the newest). Re-push, so every device converges on the newest.
      push([path]);
    }
  }

  function start(passphrase) {
    retryDelay = RETRY_MIN_MS;
    return run(passphrase);
  }

  // Try again now, if sync is wanted and not running: the machine woke up or the
  // network came back. A no-op once a start has got through.
  function retryNow() {
    if (!wanted || (root && status.mode !== 'error' && retryTimer === null)) return Promise.resolve();
    retryDelay = RETRY_MIN_MS;
    return run(wanted);
  }

  async function run(passphrase) {
    teardown();
    wanted = passphrase || null;
    const myGen = gen;
    if (!passphrase) return;
    setStatus({ mode: 'connecting', error: null });
    try {
      await backend.connect();
      if (myGen !== gen) return;
      const r = rootFor(passphrase);
      const snap = (await backend.get(r)) || {};
      if (myGen !== gen) return;

      const remote = {};
      for (const kind of kinds) {
        for (const [key, wire] of Object.entries(snap[kind] || {})) remote[C.keyToPath(kind, key)] = wire;
      }
      const patch = {};
      for (const path of C.adoptRemoteWhenDormant(clock, remote, getLastSync(), now(), synced)) patch[path] = null;
      for (const [path, wire] of Object.entries(remote)) {
        const d = C.applyRemote(clock, path, wire);
        if (d) patch[path] = d.value;
      }
      const purged = C.purgeTombstones(clock, now());
      if (Object.keys(patch).length || purged.length) onRemote(patch);

      root = r;
      await push(C.newerThanRemote(clock, remote).concat(purged.filter(p => p in remote)));
      if (myGen !== gen) return;

      for (const kind of kinds) {
        unsubs.push(backend.listen(root, kind, (key, wire) => incoming(myGen, C.keyToPath(kind, key), wire)));
      }
      if (status.mode !== 'error') { setStatus({ mode: 'on', lastSync: now() }); retryDelay = RETRY_MIN_MS; }
      let wasUp = null;
      unsubs.push(backend.onConnected((up) => {
        if (myGen !== gen) return;
        // Back online (offline before, not merely the first report) with a refused
        // push waiting: reconcile now, not at the timer.
        const back = up && wasUp === false;
        wasUp = up;
        if (back && retryTimer !== null) { retryNow(); return; }
        if (status.mode !== 'error') setStatus({ mode: up ? 'on' : 'offline' });
      }));
    } catch (err) {
      if (myGen === gen) {
        root = null;
        setStatus(failed(err));
        scheduleRetry();
      }
    }
  }

  function stop() {
    wanted = null;
    teardown();
  }

  function teardown() {
    cancelRetry();
    gen++;
    for (const off of unsubs) { try { off(); } catch (e) { /* already gone */ } }
    unsubs = [];
    root = null;
    pending = null;
    setStatus({ mode: 'off', error: null });
  }

  return {
    start,
    stop,
    retryNow,
    push,
    status: () => status
  };
}

// The real backend: the Firebase SDK, loaded only when sync is first used.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC1GVm6VsEkMjTJ3Dm3ntMSEejtC_AdnPU',
  authDomain: 'floatnote-app.firebaseapp.com',
  databaseURL: 'https://floatnote-app-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'floatnote-app',
  storageBucket: 'floatnote-app.firebasestorage.app',
  messagingSenderId: '212035028924',
  appId: '1:212035028924:web:3d4ff5da274a0758db0db9'
};

function firebaseBackend() {
  let fb = null;
  let db = null;
  const sdk = () => fb || (fb = {
    app: require('firebase/app'),
    auth: require('firebase/auth'),
    db: require('firebase/database')
  });
  return {
    async connect() {
      const { app, auth, db: d } = sdk();
      const fbApp = app.getApps()[0] || app.initializeApp(FIREBASE_CONFIG);
      await auth.signInAnonymously(auth.getAuth(fbApp));
      db = d.getDatabase(fbApp);
    },
    async get(root) {
      const { db: d } = sdk();
      return (await d.get(d.ref(db, root))).val();
    },
    update(root, map) {
      const { db: d } = sdk();
      return d.update(d.ref(db, root), map);
    },
    listen(root, kind, cb) {
      const { db: d } = sdk();
      const r = d.ref(db, root + '/' + kind);
      const offs = [
        d.onChildAdded(r, s => cb(s.key, s.val())),
        d.onChildChanged(r, s => cb(s.key, s.val()))
      ];
      return () => offs.forEach(off => off());
    },
    onConnected(cb) {
      const { db: d } = sdk();
      return d.onValue(d.ref(db, '.info/connected'), s => cb(!!s.val()));
    }
  };
}

// The FloatNote server (server/, logic in server-core.js): one Durable Object
// holding the same records. Writes are HTTP POSTs that resolve on the server's
// ack. Changes arrive over a WebSocket; each broadcast carries the sequence
// numbers it spans, and a gap, a reconnect or a new listener fetches everything
// after the last number seen, so nothing written while this device was away is
// missed. The server keeps the newest t, and answers an older write with the
// copy it kept, which is delivered here like any other change.
//
// Keys: sync.js speaks Firebase-encoded keys; the server stores raw paths.
// opts: { fetch, WebSocket, setTimer, clearTimer, now } for tests.
const CHUNK = 1000;
const PING_MS = 30 * 1000;
const DEAD_MS = 75 * 1000;
const WS_MIN_MS = 1000;
const WS_MAX_MS = 60 * 1000;

function httpBackend(url, token, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((u, o) => fetch(u, o));
  const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
  const now = opts.now || Date.now;
  const base = String(url).replace(/\/+$/, '');

  let lastSeq = 0;        // the highest sequence number delivered to listeners
  let listeners = [];     // { kind, cb }
  let connCbs = [];
  let up = null;          // null until the socket has opened or failed once
  let ws = null;
  let wsTimer = null;
  let wsDelay = WS_MIN_MS;
  let pingTimer = null;
  let lastHeard = 0;
  let catching = null;
  let catchAgain = false;

  async function call(method, path, body) {
    let res;
    try {
      res = await doFetch(base + path, {
        method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      const e = new Error('offline: ' + message(err));
      e.offline = true;
      throw e;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const e = new Error((json && json.error) || 'HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  function setUp(v) {
    if (up === v) return;
    up = v;
    for (const cb of connCbs.slice()) cb(v);
  }

  function split(path) {
    const i = path.indexOf('/');
    return [path.slice(0, i), C.encodeKey(path.slice(i + 1))];
  }

  // Hand records to the listeners. Nothing listening: drop them and leave
  // lastSeq alone, so the next catch-up fetches them again.
  function deliver(recs, seq) {
    if (!listeners.length) return;
    for (const [path, wire] of Object.entries(recs || {})) {
      const [kind, key] = split(path);
      for (const l of listeners.slice()) if (l.kind === kind) l.cb(key, wire);
    }
    if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq;
  }

  function catchUp() {
    if (catching) { catchAgain = true; return catching; }
    catching = call('GET', '/api/sync?since=' + lastSeq)
      .then(r => { if (r) deliver(r.records, r.seq); }, () => { /* the next reconnect tries again */ })
      .then(() => {
        catching = null;
        if (catchAgain) { catchAgain = false; return catchUp(); }
      });
    return catching;
  }

  function onMessage(data) {
    lastHeard = now();
    if (data === 'pong') return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (m && m.type === 'changed') {     // too large for a socket message
      if (m.seq > lastSeq) catchUp();
      return;
    }
    if (!m || m.type !== 'records') return;
    if (m.from > lastSeq) catchUp();       // missed a broadcast: fetch the gap
    else deliver(m.records, m.seq);
  }

  function dropSocket(sock, retry) {
    if (sock && ws !== sock) return;
    ws = null;
    if (pingTimer !== null) { clearTimer(pingTimer); pingTimer = null; }
    if (sock) { try { sock.close(); } catch (e) { /* already closed */ } }
    setUp(false);
    if (retry && listeners.length && wsTimer === null) {
      wsTimer = setTimer(() => { wsTimer = null; openSocket(); }, wsDelay);
      wsDelay = Math.min(wsDelay * 2, WS_MAX_MS);
    }
  }

  // No answer to the pings: the socket is dead (sleep, a network change) even
  // if it has not said so. Close it and reconnect.
  function ping(sock) {
    pingTimer = setTimer(() => {
      pingTimer = null;
      if (ws !== sock) return;
      if (now() - lastHeard > DEAD_MS) { dropSocket(sock, true); return; }
      try { sock.send('ping'); } catch (e) { /* close follows */ }
      ping(sock);
    }, PING_MS);
  }

  function openSocket() {
    if (ws || !WS || !listeners.length) return;
    let sock;
    try {
      sock = new WS(base.replace(/^http/, 'ws') + '/api/ws', ['floatnote', token]);
    } catch (e) {
      dropSocket(null, true);
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsDelay = WS_MIN_MS;
      lastHeard = now();
      ping(sock);
      setUp(true);
      catchUp();
    };
    sock.onmessage = (e) => { if (ws === sock) onMessage(typeof e.data === 'string' ? e.data : String(e.data)); };
    sock.onclose = () => dropSocket(sock, true);
    sock.onerror = () => dropSocket(sock, true);
  }

  function closeSocket() {
    if (wsTimer !== null) { clearTimer(wsTimer); wsTimer = null; }
    if (ws) dropSocket(ws, false);
    up = null;
  }

  return {
    async connect() {},

    async get() {
      const r = await call('GET', '/api/sync');
      lastSeq = r.seq || 0;
      const out = {};
      for (const [path, wire] of Object.entries(r.records || {})) {
        const [kind, key] = split(path);
        (out[kind] = out[kind] || {})[key] = wire;
      }
      return out;
    },

    async update(root, map) {
      const writes = Object.entries(map).map(([k, w]) => {
        const i = k.indexOf('/');
        return [C.keyToPath(k.slice(0, i), k.slice(i + 1)), w];
      });
      for (let i = 0; i < writes.length; i += CHUNK) {
        const r = await call('POST', '/api/sync', { writes: Object.fromEntries(writes.slice(i, i + CHUNK)) });
        if (r && r.stale) deliver(r.stale);
      }
    },

    listen(root, kind, cb) {
      const l = { kind, cb };
      listeners.push(l);
      openSocket();
      // Whatever changed between the snapshot and now.
      queueMicrotask(() => { if (listeners.includes(l)) catchUp(); });
      return () => {
        listeners = listeners.filter(x => x !== l);
        if (!listeners.length) closeSocket();
      };
    },

    onConnected(cb) {
      connCbs.push(cb);
      if (up !== null) queueMicrotask(() => { if (connCbs.includes(cb)) cb(up); });
      return () => { connCbs = connCbs.filter(x => x !== cb); };
    }
  };
}

return { createSync, firebaseBackend, httpBackend, rootFor, FIREBASE_CONFIG };
});
