// Sync v2 against an in-memory server: several devices, events delivered
// asynchronously like the network does. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core');
const { createSync } = require('../sync');

const clone = v => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

function fakeServer() {
  const data = {};        // root → kind → key → wire
  let listeners = [];     // { root, kind, cb }
  let inflight = 0;
  let deny = false;
  const deliver = (fn) => { inflight++; setImmediate(() => { inflight--; fn(); }); };
  const node = (root, kind) => ((data[root] = data[root] || {})[kind] = data[root][kind] || {});

  function write(root, map) {
    for (const [k, w] of Object.entries(map)) {
      const i = k.indexOf('/');
      const kind = k.slice(0, i), key = k.slice(i + 1);
      if (w === null) { delete node(root, kind)[key]; continue; }
      node(root, kind)[key] = clone(w);
      for (const l of listeners) if (l.root === root && l.kind === kind) deliver(() => l.cb(key, clone(w)));
    }
  }

  return {
    data,
    write,
    denyAll() { deny = true; },
    get inflight() { return inflight; },
    client() {
      return {
        async connect() {},
        async get(root) { if (deny) throw new Error('PERMISSION_DENIED'); return clone(data[root] || {}); },
        async update(root, map) { if (deny) throw new Error('PERMISSION_DENIED'); write(root, map); },
        listen(root, kind, cb) {
          const l = { root, kind, cb };
          listeners.push(l);
          for (const [key, w] of Object.entries(node(root, kind))) deliver(() => l.cb(key, clone(w)));
          return () => { listeners = listeners.filter(x => x !== l); };
        },
        onConnected(cb) { deliver(() => cb(true)); return () => {}; }
      };
    }
  };
}

let T = Date.parse('2026-01-10T09:00:00Z');
const tick = () => (T += 1000);

function device(server, kinds, init) {
  const d = { state: C.emptyState(), clock: {}, patches: 0, lastSync: null, timers: [] };
  if (init) Object.assign(d, init);
  d.sync = createSync({
    kinds,
    backend: (init && init.backend) || server.client(),
    getLastSync: () => d.lastSync,
    onSynced: (t) => { d.lastSync = t; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; d.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    clock: d.clock,
    getRecords: () => C.toRecords(d.state),
    onRemote: (p) => { d.patches++; C.applyPatch(d.state, p); },
    now: () => T
  });
  // What main.saveState does: stamp what changed, push it.
  d.edit = (fn) => { fn(d.state); return d.sync.push(C.stamp(d.clock, C.toRecords(d.state), tick())); };
  d.add = (text) => {
    const it = C.makeItem({ text, list: 'next', ctx: 'work' }, tick());
    return d.edit(s => { s.items[it.id] = it; }).then(() => it.id);
  };
  return d;
}

async function settle(server) {
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setImmediate(r));
    if (server.inflight === 0) { await new Promise(r => setImmediate(r)); if (server.inflight === 0) return; }
  }
  throw new Error('server never settled');
}

const synced = s => C.stableStringify(C.toRecords(s));
const PASS = 'test-pass';

test('different items edited on two devices: both keep both', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const ia = await a.add('Alpha task');
  const ib = await b.add('Bravo task');
  await settle(S);
  assert.ok(a.state.items[ib] && b.state.items[ia]);
  assert.equal(synced(a.state), synced(b.state));
});

test('same item edited on both: the newer edit wins everywhere', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const id = await a.add('Shared task');
  await settle(S);
  await a.edit(s => { s.items[id].text = 'edited on A'; });
  await b.edit(s => { s.items[id].text = 'edited on B, later'; });
  await settle(S);
  assert.equal(a.state.items[id].text, 'edited on B, later');
  assert.equal(synced(a.state), synced(b.state));
});

test('delete on one device beats an older edit on the other', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const id = await a.add('Doomed task');
  await settle(S);
  await b.edit(s => { s.items[id].text = 'edited first'; });
  await a.edit(s => { delete s.items[id]; });
  await settle(S);
  assert.equal(a.state.items[id], undefined);
  assert.equal(b.state.items[id], undefined);
  assert.equal(S.data[`sync/${PASS}-v2`].items[id].d, true, 'travels as a tombstone');
});

test('an unticked habit stays unticked on the other device', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  await a.edit(s => { s.habitLog['h1_2026-01-10'] = true; });
  await settle(S);
  assert.equal(b.state.habitLog['h1_2026-01-10'], true);
  await a.edit(s => { delete s.habitLog['h1_2026-01-10']; });
  await settle(S);
  assert.equal(b.state.habitLog['h1_2026-01-10'], undefined);
});

test('work done before sync starts is pushed, and remote work is pulled', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS);
  const ia = await a.add('Remote task');
  await settle(S);
  const ib = await b.add('Offline task');           // b not syncing yet
  await b.edit(s => { s.notes.personal = '<p>offline note</p>'; });
  await b.sync.start(PASS);
  await settle(S);
  assert.ok(b.state.items[ia] && a.state.items[ib]);
  assert.equal(a.state.notes.personal, '<p>offline note</p>');
  assert.equal(synced(a.state), synced(b.state));
});

test('a stale copy written to the server is overwritten by the newer one', async () => {
  const S = fakeServer(), a = device(S);
  await a.sync.start(PASS);
  const id = await a.add('Fresh task');
  await settle(S);
  const fresh = clone(S.data[`sync/${PASS}-v2`].items[id]);
  S.write(`sync/${PASS}-v2`, { ['items/' + id]: { j: JSON.stringify({ id, text: 'stale' }), t: fresh.t - 5000 } });
  await settle(S);
  assert.equal(a.state.items[id].text, 'Fresh task');
  assert.deepEqual(S.data[`sync/${PASS}-v2`].items[id], fresh);
});

test('old tombstones are purged locally and on the server', async () => {
  const S = fakeServer(), a = device(S);
  const root = `sync/${PASS}-v2`;
  S.write(root, { 'items/ancient': { t: T - 400 * C.DAY_MS, d: true }, 'items/recent': { t: T - 90 * C.DAY_MS, d: true } });
  await a.sync.start(PASS);
  await settle(S);
  assert.equal(S.data[root].items.ancient, undefined);
  assert.equal(S.data[root].items.recent.d, true, 'a 90-day-old tombstone is kept');
  assert.equal(a.clock['items/ancient'], undefined);
});

test('keys Firebase forbids survive the round trip', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  await a.edit(s => { s.meta['odd.key/with#chars'] = 'x'; });
  await settle(S);
  assert.equal(b.state.meta['odd.key/with#chars'], 'x');
});

test('negative control: a device that never syncs does not converge', async () => {
  const S = fakeServer(), a = device(S), c = device(S);
  await a.sync.start(PASS);
  await a.add('Only on A');
  await settle(S);
  assert.notEqual(synced(a.state), synced(c.state));
});

test('a refused read or write shows as an error, not as synced', async () => {
  const S = fakeServer(), a = device(S);
  S.denyAll();
  await a.sync.start(PASS);
  assert.equal(a.sync.status().mode, 'error');
  assert.match(a.sync.status().error, /PERMISSION_DENIED/);
});

test('after stop, remote changes are ignored', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  await settle(S);
  b.sync.stop();
  const id = await a.add('After stop');
  await settle(S);
  assert.equal(b.state.items[id], undefined);
  assert.equal(b.sync.status().mode, 'off');
});

test('a different passphrase is a different space', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start('other-pass');
  await a.add('Private to A');
  await settle(S);
  assert.equal(Object.keys(b.state.items).length, 0);
});

test('a device limited to items neither sends nor takes notes', async () => {
  const server = fakeServer();
  const laptop = device(server);
  const phone = device(server, ['items', 'completions']);
  await laptop.edit(s => { s.notes.professional = '<div>invented note</div>'; });
  await laptop.sync.start(PASS);
  await phone.sync.start(PASS);
  await phone.edit(s => { s.notes.professional = ''; });
  const id = await phone.add('Captured on the phone');
  await settle(server);
  assert.ok(laptop.state.items[id], 'items travel');
  assert.equal(laptop.state.notes.professional, '<div>invented note</div>', 'the phone did not clobber the note');
  assert.equal(phone.state.notes.professional, '', 'and did not receive it');
});

// ---------- launch recovery (C1, C2): a suspect state must not delete or out-date ----------

const ROOT = `sync/${PASS}-v2`;
const live = (s) => Object.values(s.items).map(i => i.text).sort();
const tombstones = (S) => Object.entries(S.data[ROOT].items).filter(([, w]) => w.d).map(([k]) => k);

// A and B synced three items, then A stops. relaunch() builds A the way main
// does: the old clock and the given state, with recoverClock (the fix) or
// stamp (what main did before).
async function twoDevicesWithThree() {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const ids = [];
  for (const t of ['Invented one', 'Invented two', 'Invented three']) ids.push(await a.add(t));
  await settle(S);
  a.sync.stop();
  return { S, a, b, ids };
}

function relaunch(S, oldClock, state, recover) {
  const clock = clone(oldClock);
  const records = C.toRecords(state);
  if (recover) C.recoverClock(clock, records); else C.stamp(clock, records, tick());
  return device(S, undefined, { state, clock });
}

test('recovered state (older backup): nothing is deleted remotely, the rest comes back, local-only is pushed', async () => {
  const { S, a, b, ids } = await twoDevicesWithThree();
  // The backup has the first two items and one that only ever lived in it.
  const backup = C.emptyState();
  backup.items[ids[0]] = clone(a.state.items[ids[0]]);
  backup.items[ids[1]] = clone(a.state.items[ids[1]]);
  const only = C.makeItem({ text: 'Invented backup-only', list: 'next', ctx: 'work' }, tick());
  backup.items[only.id] = only;
  const a2 = relaunch(S, a.clock, backup, true);
  await a2.sync.start(PASS);
  await settle(S);
  assert.deepEqual(tombstones(S), [], 'no tombstones reached the server');
  assert.deepEqual(live(b.state), ['Invented backup-only', 'Invented one', 'Invented three', 'Invented two']);
  assert.deepEqual(live(a2.state), live(b.state), 'the lost item came back');
});

test('recovered empty state: the remote copy comes back, nothing is deleted', async () => {
  const { S, a, b } = await twoDevicesWithThree();
  const a2 = relaunch(S, a.clock, C.emptyState(), true);
  await a2.sync.start(PASS);
  await settle(S);
  assert.deepEqual(tombstones(S), []);
  assert.equal(live(b.state).length, 3);
  assert.equal(live(a2.state).length, 3);
});

test('recovered state: a newer remote edit beats the older backup copy', async () => {
  const { S, a, b, ids } = await twoDevicesWithThree();
  const old = clone(a.state);
  await b.edit(s => { s.items[ids[0]].text = 'Invented one, edited'; });
  await settle(S);
  const a2 = relaunch(S, a.clock, old, true);
  await a2.sync.start(PASS);
  await settle(S);
  assert.equal(a2.state.items[ids[0]].text, 'Invented one, edited');
  assert.equal(b.state.items[ids[0]].text, 'Invented one, edited');
});

test('negative control: stamping the recovered state deletes the remote copy', async () => {
  const { S, a, b } = await twoDevicesWithThree();
  const a2 = relaunch(S, a.clock, C.emptyState(), false);
  await a2.sync.start(PASS);
  await settle(S);
  assert.equal(tombstones(S).length, 3);
  assert.equal(live(b.state).length, 0);
});

test('lost clock, intact data: remote edits and deletes win, local-only work is pushed', async () => {
  const { S, a, b, ids } = await twoDevicesWithThree();
  await b.edit(s => { s.items[ids[0]].text = 'Invented one, edited'; delete s.items[ids[1]]; });
  await settle(S);
  const local = clone(a.state);
  const offline = C.makeItem({ text: 'Invented offline', list: 'next', ctx: 'work' }, tick());
  local.items[offline.id] = offline;
  const a2 = relaunch(S, {}, local, true);       // the clock file is gone
  await a2.sync.start(PASS);
  await settle(S);
  assert.deepEqual(live(a2.state), ['Invented offline', 'Invented one, edited', 'Invented three']);
  assert.deepEqual(live(a2.state), live(b.state));
  assert.deepEqual(tombstones(S), [ids[1]], 'only the real delete is a tombstone');
});

test('negative control: stamping with a lost clock overwrites the remote edit and resurrects the delete', async () => {
  const { S, a, b, ids } = await twoDevicesWithThree();
  await b.edit(s => { s.items[ids[0]].text = 'Invented one, edited'; delete s.items[ids[1]]; });
  await settle(S);
  const a2 = relaunch(S, {}, clone(a.state), false);
  await a2.sync.start(PASS);
  await settle(S);
  assert.equal(b.state.items[ids[0]].text, 'Invented one');
  assert.ok(b.state.items[ids[1]]);
});

test('first sync of a freshly migrated state still reaches an empty remote', async () => {
  const S = fakeServer();
  const state = C.migrateV1({ checklist: { professional: [{ text: 'Invented v1 task' }], personal: [] } }, T);
  const clock = {};
  C.stamp(clock, C.toRecords(state), tick());      // planLoad says suspect: false for a migration
  const a = device(S, undefined, { state, clock }), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  await settle(S);
  assert.deepEqual(live(b.state), ['Invented v1 task']);
});

// ---------- a failed start is retried (C4) ----------

function flakyBackend(S, failures) {
  const b = S.client();
  b.connect = async () => { if (failures > 0) { failures--; throw new Error('network-request-failed'); } };
  return b;
}
const liveTimers = (d) => d.timers.filter(t => t.live);

// Fire the pending retry timer and let the attempt finish.
async function fireRetry(S, d) {
  const t = liveTimers(d)[0];
  t.live = false;
  t.fn();
  await settle(S);
  return t.ms;
}

test('a start that fails offline retries with backoff and then catches up', async () => {
  const S = fakeServer(), b = device(S);
  await b.sync.start(PASS);
  await b.add('Invented remote');
  await settle(S);
  const a = device(S, undefined, { backend: flakyBackend(S, 3) });
  await a.sync.start(PASS);
  assert.equal(a.sync.status().mode, 'error');
  const delays = [];
  for (let i = 0; i < 3; i++) delays.push(await fireRetry(S, a));
  assert.deepEqual(delays, [5000, 10000, 20000]);
  assert.equal(a.sync.status().mode, 'on');
  assert.equal(liveTimers(a).length, 0, 'no retry left once started');
  assert.deepEqual(live(a.state), ['Invented remote']);
});

test('retry delay is capped at a few minutes', async () => {
  const S = fakeServer();
  const a = device(S, undefined, { backend: flakyBackend(S, 100) });
  await a.sync.start(PASS);
  let last = 0;
  for (let i = 0; i < 12; i++) last = await fireRetry(S, a);
  assert.equal(last, 300000);
});

test('retryNow (wake from sleep) starts at once, and does nothing once started', async () => {
  const S = fakeServer();
  const a = device(S, undefined, { backend: flakyBackend(S, 1) });
  await a.sync.start(PASS);
  assert.equal(a.sync.status().mode, 'error');
  await a.sync.retryNow();
  assert.equal(a.sync.status().mode, 'on');
  assert.equal(liveTimers(a).length, 0, 'the pending timer was cancelled');
  const timers = a.timers.length;
  await a.sync.retryNow();
  assert.equal(a.timers.length, timers);
});

test('stop cancels a pending retry and turns retryNow off', async () => {
  const S = fakeServer();
  const a = device(S, undefined, { backend: flakyBackend(S, 5) });
  await a.sync.start(PASS);
  a.sync.stop();
  assert.equal(liveTimers(a).length, 0);
  await a.sync.retryNow();
  assert.equal(a.sync.status().mode, 'off');
});

// ---------- a long-dormant device (C5) ----------

test('a device dormant past the tombstone horizon does not resurrect what was deleted meanwhile', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const gone = await a.add('Invented deleted while away');
  const kept = await a.add('Invented kept');
  await settle(S);
  a.sync.stop();
  // While A sleeps B deletes one item, and the tombstone is purged a year on.
  await b.edit(s => { delete s.items[gone]; });
  await settle(S);
  assert.equal(S.data[ROOT].items[gone].d, true);
  S.write(ROOT, { ['items/' + C.encodeKey(gone)]: null });
  T += 400 * C.DAY_MS;
  // A edited another item after its last sync: that one must survive.
  await a.edit(s => { s.items[kept].text = 'Invented kept, edited offline'; });
  await a.sync.start(PASS);
  await settle(S);
  assert.equal(a.state.items[gone], undefined, 'the deleted item is not pushed back');
  assert.equal(b.state.items[gone], undefined);
  assert.equal(S.data[ROOT].items[gone], undefined);
  assert.equal(b.state.items[kept].text, 'Invented kept, edited offline');
});

test('negative control: a device that synced recently still pushes what the server lacks', async () => {
  const S = fakeServer(), a = device(S), b = device(S);
  await a.sync.start(PASS); await b.sync.start(PASS);
  const id = await a.add('Invented unsynced');
  await settle(S);
  a.sync.stop();
  S.write(ROOT, { ['items/' + C.encodeKey(id)]: null });
  T += 30 * C.DAY_MS;
  await a.sync.start(PASS);
  await settle(S);
  assert.ok(S.data[ROOT].items[id], 'not dormant: the record is pushed back');
});

test('lastSync is reported as sync succeeds', async () => {
  const S = fakeServer(), a = device(S);
  await a.sync.start(PASS);
  await settle(S);
  assert.equal(a.lastSync, T);
});

test('a refused push after start is retried, and sync comes back on', async () => {
  const S = fakeServer(), b = device(S);
  await b.sync.start(PASS);
  const backend = S.client();
  let refuse = 1;
  const update = backend.update;
  backend.update = async (root, map) => { if (refuse > 0) { refuse--; throw new Error('network-request-failed'); } return update(root, map); };
  const a = device(S, undefined, { backend });
  await a.sync.start(PASS);
  await settle(S);
  assert.equal(a.sync.status().mode, 'on');
  await a.add('Invented while the network blipped');
  assert.equal(a.sync.status().mode, 'error');
  assert.equal(liveTimers(a).length, 1, 'a retry is scheduled');
  await fireRetry(S, a);
  assert.equal(a.sync.status().mode, 'on');
  assert.deepEqual(live(b.state), ['Invented while the network blipped']);
});

test('negative control: without the retry firing, the refused edit never arrives', async () => {
  const S = fakeServer(), b = device(S);
  await b.sync.start(PASS);
  const backend = S.client();
  const update = backend.update;
  let refuse = 1;
  backend.update = async (root, map) => { if (refuse > 0) { refuse--; throw new Error('network-request-failed'); } return update(root, map); };
  const a = device(S, undefined, { backend });
  await a.sync.start(PASS);
  await a.add('Invented and stuck');
  await settle(S);
  assert.deepEqual(live(b.state), []);
});
