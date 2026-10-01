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

function device(server, kinds) {
  const d = { state: C.emptyState(), clock: {}, patches: 0 };
  d.sync = createSync({
    kinds,
    backend: server.client(),
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
  S.write(root, { 'items/ancient': { t: T - 90 * C.DAY_MS, d: true }, 'items/recent': { t: T - C.DAY_MS, d: true } });
  await a.sync.start(PASS);
  await settle(S);
  assert.equal(S.data[root].items.ancient, undefined);
  assert.equal(S.data[root].items.recent.d, true);
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
