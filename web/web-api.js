// window.api in the browser. The phone runs the same index.html as the desktop,
// served by the FloatNote server (server/), and this file is what preload.js and
// main.js are to the desktop: it keeps the state and the clock (in IndexedDB),
// runs sync.js against the server (httpBackend), and hands the page remote
// changes through the same patch window. No UI. Loaded after core.js and sync.js;
// the served copy of index.html adds both (server/build-public.mjs).
//
// A browser that has never synced stamps nothing: until its first reconcile it
// has no opinion on any record, so every copy the server holds wins, and a fresh
// phone cannot push its empty notes over the desktop's. The first reconcile then
// stamps whatever it holds that the server did not give it (items added before
// pairing), and from there it saves like main does.
//
// Desktop-only calls (window, hotkey, capture popup, drop folder) are no-ops. The
// decisions log is the desktop's (docs/INTAKE.md); from here it is not kept yet.
(function () {
  'use strict';
  const C = window.FNCore;
  const S = window.FNSync;
  const FIRST_SYNC_WAIT_MS = 8000;      // a paired, never-synced browser waits this long for the server before showing anything
  const SYNCED_WRITE_MS = 60 * 60 * 1000;
  const RESYNC_AFTER_HIDDEN_MS = 30 * 1000;

  document.documentElement.classList.add('web');

  // ---------- IndexedDB: one key-value store ----------

  let dbp = null;
  function db() {
    return dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('floatnote', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  async function getKeys(keys) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readonly');
      const st = tx.objectStore('kv');
      const out = {};
      for (const k of keys) { const r = st.get(k); r.onsuccess = () => { out[k] = r.result; }; }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  }

  // One transaction, so the state and the clock on disk always belong together.
  async function putKeys(map) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      const st = tx.objectStore('kv');
      for (const [k, v] of Object.entries(map)) { if (v === undefined) st.delete(k); else st.put(v, k); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Writes the current state and clock. Calls while a write is queued share it;
  // the returned promise settles once what was current at the call is stored.
  let chain = Promise.resolve();
  let queued = null;
  function persist() {
    if (queued) return queued;
    queued = chain = chain.then(() => {
      queued = null;
      return putKeys({ state, clock: C.clockFile(clock, lastSync) });
    }).catch(err => console.warn('FloatNote: could not store', err));
    return queued;
  }

  // ---------- state ----------

  let state = C.emptyState();
  let clock = {};
  let lastSync = null;   // null: this browser has never synced (see the top)
  let device = null;     // { token, id, name }, from pairing
  let sync = null;
  let unseen = [];       // remote patches sent to the page, newer than its last save
  let patchSeq = 0;
  let hiddenAt = 0;
  const shared = [];     // text shared to the app (manifest share_target), for the page

  const handlers = {};
  function emit(name, ...args) {
    for (const cb of handlers[name] || []) {
      try { cb(...args); } catch (err) { console.error('FloatNote:', name, err); }
    }
  }
  const on = name => cb => { (handlers[name] = handlers[name] || []).push(cb); };

  function info() {
    return {
      sync: sync ? sync.status() : { mode: 'off' },
      configured: !!device,
      hotkey: null,
      wantedHotkey: null,
      packaged: true,
      web: true
    };
  }

  // The page gets copies: it edits its state in place, and a shared object
  // would change this side's state before a save says so.
  function sendPatch(patch, before) {
    if (!Object.keys(patch).length) return;
    const seq = ++patchSeq;
    unseen.push({ seq, patch, before });
    emit('remote-patch', structuredClone(patch), seq, before);
  }

  function onSynced(t) {
    const first = lastSync === null;
    if (!first && t - lastSync < SYNCED_WRITE_MS) return;
    lastSync = t;
    if (first) {
      const changed = C.stamp(clock, C.toRecords(state), Date.now());
      const s = sync;
      if (changed.length) queueMicrotask(() => { if (s === sync) s.push(changed); });
    }
    persist();
  }

  function startSync() {
    if (sync) sync.stop();
    sync = null;
    if (device) {
      sync = S.createSync({
        backend: S.httpBackend(location.origin, device.token),
        clock,
        getRecords: () => C.toRecords(state),
        onRemote: (patch) => {
          const before = C.recordHashes(state, Object.keys(patch));
          C.applyPatch(state, patch);
          persist();
          sendPatch(patch, before);
        },
        getLastSync: () => lastSync,
        onSynced,
        onStatus: () => { emit('info', info()); settleFirst(); }
      });
      // httpBackend ignores the root; any non-empty one turns sync on.
      sync.start('server');
    }
    emit('info', info());
  }

  // ---------- the first sync of a paired browser ----------

  let firstWaiters = [];
  function settleFirst() {
    const mode = sync ? sync.status().mode : 'off';
    if (sync && (mode === 'off' || mode === 'connecting')) return;
    const w = firstWaiters;
    firstWaiters = [];
    w.forEach(fn => fn());
  }
  function firstSync() {
    return new Promise(resolve => {
      const t = setTimeout(resolve, FIRST_SYNC_WAIT_MS);
      firstWaiters.push(() => { clearTimeout(t); resolve(); });
      settleFirst();
    });
  }

  // ---------- boot ----------

  function takeShared() {
    const q = new URLSearchParams(location.search);
    const parts = [];
    for (const k of ['title', 'text', 'url']) {
      const v = (q.get(k) || '').trim();
      if (v && !parts.some(p => p.includes(v))) parts.push(v);
    }
    if (parts.length) shared.push(parts.join(' '));
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  }

  async function boot() {
    takeShared();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
    const got = await getKeys(['state', 'clock', 'device']);
    const file = C.parseClockFile(got.clock);
    const plan = C.planLoad({ data: got.state, exists: got.state !== undefined, clock: file, v2Ran: !!file, backup: () => undefined });
    state = plan.raw === undefined ? C.emptyState() : C.normalizeState(plan.raw);
    clock = file ? file.clock : {};
    lastSync = file ? file.lastSync : null;
    if (lastSync === null) clock = {};
    else if (plan.suspect) C.recoverClock(clock, C.toRecords(state));
    else C.stamp(clock, C.toRecords(state), Date.now());
    device = got.device && typeof got.device.token === 'string' ? got.device : null;
    await persist();
    startSync();
    if (device && lastSync === null) await firstSync();
  }

  const ready = boot().catch(err => {
    // No IndexedDB (a private window, storage blocked): run in memory, unsynced.
    console.warn('FloatNote: storage unavailable, nothing will be kept', err);
  });

  // ---------- pairing (Settings > Sync takes the server's setup key) ----------

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Browser';
  }

  async function pair(key) {
    let res;
    try {
      res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupKey: key, name: deviceName() })
      });
    } catch (e) {
      return { ok: false, error: 'No connection to the server. Try again when online.' };
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) return { ok: false, error: 'That setup key is not right.' };
    if (res.status !== 201 || typeof body.token !== 'string') return { ok: false, error: 'Pairing failed: ' + (body.error || 'HTTP ' + res.status) };
    device = { token: body.token, id: body.id, name: body.name };
    await putKeys({ device });
    startSync();
    return { ok: true };
  }

  // Turning sync off forgets this browser's token and revokes it on the server.
  // The state and clock stay, so pairing again picks up where it left off.
  async function unpair() {
    const old = device;
    device = null;
    startSync();
    await putKeys({ device: undefined });
    if (old) {
      fetch('/api/devices/' + encodeURIComponent(old.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + old.token } })
        .catch(() => { /* offline: the token is gone here, which is what matters */ });
    }
    return { ok: true };
  }

  // ---------- leaving and coming back ----------

  // The page saves 300 ms after a change; leaving must not lose that.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      emit('flush');
    } else if (sync && hiddenAt && Date.now() - hiddenAt > RESYNC_AFTER_HIDDEN_MS) {
      // A phone freezes a page in the background and its socket dies quietly.
      // A fresh run reconciles at once instead of waiting for the ping to notice.
      sync.start('server');
    }
  });
  window.addEventListener('pagehide', () => emit('flush'));
  window.addEventListener('online', () => { if (sync) sync.retryNow(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('FloatNote: service worker', err));
  }

  const noop = () => {};

  window.api = {
    web: true,
    loadData: async () => {
      await ready;
      unseen = [];
      if (shared.length) setTimeout(() => shared.splice(0).forEach(raw => emit('captured', raw)), 0);
      return structuredClone(state);
    },
    saveData: async (data, seenSeq) => {
      await ready;
      ({ state, unseen } = C.commitSave(structuredClone(data), seenSeq, unseen));
      const changed = lastSync === null ? [] : C.stamp(clock, C.toRecords(state), Date.now());
      const stored = persist();
      if (sync && changed.length) sync.push(changed);
      await stored;
    },
    getInfo: async () => { await ready; return info(); },
    onInfo: on('info'),
    onRemotePatch: on('remote-patch'),
    onFlush: on('flush'),
    onCaptured: on('captured'),
    flushed: noop,
    setPassphrase: async (key) => {
      await ready;
      key = String(key || '').trim();
      return key ? pair(key) : unpair();
    },
    logDecisions: noop,
    minimize: noop,
    close: noop,
    setCompact: noop,
    captureSubmit: noop,
    captureHide: noop,
    onCaptureShow: noop,
    onInbox: noop,
    pauseHotkey: noop
  };
})();
