// Sync v2, main process only.
//
// Every record (see core.toRecords) is its own node:
//   sync/<passphrase>-v2/<kind>/<encoded key> = { j: JSON text, t } | { t, d: true }
// Newest t wins per record (core.applyRemote), so two devices editing different
// items never overwrite each other, and deletes travel as tombstones.
//
// The backend is injected: main.js passes a thin wrapper over the Firebase SDK,
// the tests pass an in-memory fake. Shape:
//   connect() → Promise                       sign in
//   get(root) → Promise<{kind: {key: wire}}>  one read of everything
//   update(root, {'kind/key': wire|null})     multi-path write, null removes
//   listen(root, kind, cb(key, wire)) → off   child added + changed
//   onConnected(cb(bool)) → off
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

function createSync(opts) {
  const { backend, clock, getRecords, onRemote, onStatus } = opts;
  const now = opts.now || Date.now;
  // The record kinds this device sends and receives. The phone page shows only
  // items, so it syncs only items and completions and cannot clobber notes.
  const kinds = opts.kinds || C.RECORD_KINDS;
  const synced = (path) => kinds.includes(path.slice(0, path.indexOf('/')));

  let gen = 0;          // bumped by start/stop; callbacks from an older run are ignored
  let root = null;      // set once the first reconcile is done
  let unsubs = [];
  let pending = null;   // remote records decided but not yet handed to onRemote
  let status = { mode: 'off', lastSync: null, error: null };

  function setStatus(s) {
    status = Object.assign({}, status, s);
    if (onStatus) onStatus(status);
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
      (err) => { if (myGen === gen) setStatus({ mode: 'error', error: message(err) }); }
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

  async function start(passphrase) {
    stop();
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
      if (status.mode !== 'error') setStatus({ mode: 'on', lastSync: now() });
      unsubs.push(backend.onConnected((up) => {
        if (myGen === gen && status.mode !== 'error') setStatus({ mode: up ? 'on' : 'offline' });
      }));
    } catch (err) {
      if (myGen === gen) {
        root = null;
        setStatus({ mode: 'error', error: message(err) });
      }
    }
  }

  function stop() {
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

return { createSync, firebaseBackend, rootFor, FIREBASE_CONFIG };
});
