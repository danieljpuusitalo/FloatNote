// The FloatNote server (server-core.js) on its own, its SQLite store against
// node:sqlite, and sync.js + httpBackend end to end against it over a fake
// network: devices that go offline, sockets that drop or go silent, a broadcast
// that never arrives, a clock that runs behind. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core');
const S = require('../server-core');
const { createSync, httpBackend } = require('../sync');

const SETUP = 'invented-setup-key-0123456789';
let T = Date.parse('2026-03-02T09:00:00Z');
const tick = () => (T += 1000);
const wire = (text, t) => ({ j: JSON.stringify({ text }), t });

// ---------- server-core ----------

test('server kinds are the record kinds sync.js sends', () => {
  assert.deepEqual(S.KINDS, C.RECORD_KINDS);
});

test('newest t wins per path; an older write is answered with the kept copy', () => {
  const st = S.memoryStore();
  let r = S.applyWrites(st, { 'items/a': wire('first', 100) });
  assert.deepEqual(r, { from: 0, seq: 1, applied: { 'items/a': wire('first', 100) }, stale: {} });
  r = S.applyWrites(st, { 'items/a': wire('older', 50) });
  assert.deepEqual(r.applied, {});
  assert.deepEqual(r.stale, { 'items/a': wire('first', 100) });
  r = S.applyWrites(st, { 'items/a': wire('same ms', 100) });
  assert.deepEqual([r.applied, r.stale, r.seq], [{}, {}, 1], 'a tie keeps the stored copy and says nothing');
  r = S.applyWrites(st, { 'items/a': wire('newer', 200) });
  assert.deepEqual([r.from, r.seq], [1, 2]);
  assert.equal(st.get('items/a').wire.j, JSON.stringify({ text: 'newer' }));
});

test('a purge removes a tombstone, never a live record', () => {
  const st = S.memoryStore();
  S.applyWrites(st, { 'items/dead': { t: 10, d: true }, 'items/live': wire('kept', 10) });
  S.applyWrites(st, { 'items/dead': null, 'items/live': null });
  assert.equal(st.get('items/dead'), undefined);
  assert.equal(st.get('items/live').wire.t, 10);
});

test('records since a sequence number are only the later writes', () => {
  const st = S.memoryStore();
  S.applyWrites(st, { 'items/a': wire('a', 1), 'items/b': wire('b', 1) });
  S.applyWrites(st, { 'items/c': wire('c', 2) });
  assert.deepEqual(Object.keys(S.records(st, 2).records), ['items/c']);
  assert.deepEqual(Object.keys(S.records(st).records).sort(), ['items/a', 'items/b', 'items/c']);
  assert.equal(S.records(st, 3).seq, 3);
});

test('malformed paths and records are refused', () => {
  assert.equal(S.validPath('items/x'), true);
  for (const p of ['secrets/x', 'items/', '/x', 'items', 'items/' + 'x'.repeat(400), 42]) assert.equal(S.validPath(p), false, String(p));
  assert.equal(S.cleanWire({ t: -1, j: '{}' }), undefined);
  assert.deepEqual(S.cleanWire({ t: 0, j: '{}' }), { j: '{}', t: 0 }, 'recoverClock stamps t 0');
  assert.equal(S.cleanWire({ t: 5 }), undefined);
  assert.equal(S.cleanWire({ t: 5, j: 'x'.repeat(S.MAX_VALUE + 1) }), undefined);
  assert.deepEqual(S.cleanWire({ t: 5, d: true, j: 'dropped' }), { t: 5, d: true });
  assert.deepEqual(S.cleanWire({ t: 5, j: '{}', extra: 1 }), { j: '{}', t: 5 });
});

// ---------- SQLite store ----------

function sqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return S.sqlStore((sql, ...params) => {
    const st = db.prepare(sql);
    return /^\s*(SELECT)/i.test(sql) ? st.all(...params) : (st.run(...params), []);
  });
}

function script(st, poison) {
  const out = [];
  out.push(S.applyWrites(st, { 'items/a': wire('a', 10), 'items/b': { t: 10, d: true }, 'notes/x.y': wire('n', 10) }));
  out.push(S.applyWrites(st, { 'items/a': wire(poison ? 'POISON' : 'a2', 20), 'items/b': null }));
  out.push(S.applyWrites(st, { 'items/a': wire('old', 15) }));
  st.putDevice('h1', { id: 'd1', name: 'n' });
  out.push(S.records(st), S.records(st, 1), st.device('h1'), st.devices());
  return JSON.stringify(out);
}

test('the SQLite store behaves exactly like the in-memory one', () => {
  assert.equal(script(sqliteStore()), script(S.memoryStore()));
});

test('negative control: the parity check sees a different input', () => {
  assert.notEqual(script(sqliteStore(), true), script(S.memoryStore()));
});

// ---------- requests and devices ----------

const req = (method, path, opts) => Object.assign({ method, path, query: {}, headers: {}, body: undefined }, opts);
const authed = (token, o) => Object.assign({ headers: { authorization: 'Bearer ' + token } }, o);

test('pairing needs the setup key; the token is stored only as its hash', async () => {
  const store = S.memoryStore();
  const ctx = { store, now: T, setupKey: SETUP };
  assert.equal((await S.handle(req('POST', '/api/pair', { body: { setupKey: 'wrong' } }), ctx)).status, 403);
  assert.equal((await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP } }), { store, now: T })).status, 503);
  const r = await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP, name: 'Invented laptop' } }), ctx);
  assert.equal(r.status, 201);
  assert.match(r.json.token, /^fn_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(store.devices()).includes(r.json.token));
  const ok = await S.handle(req('GET', '/api/sync', authed(r.json.token)), ctx);
  assert.equal(ok.status, 200);
});

test('no token, a wrong token or a revoked one is refused', async () => {
  const store = S.memoryStore();
  const ctx = { store, now: T, setupKey: SETUP };
  const a = (await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP, name: 'A' } }), ctx)).json;
  const b = (await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP, name: 'B' } }), ctx)).json;
  assert.equal((await S.handle(req('GET', '/api/sync'), ctx)).status, 401);
  assert.equal((await S.handle(req('GET', '/api/sync', authed('fn_invented')), ctx)).status, 401);
  const list = (await S.handle(req('GET', '/api/devices', authed(a.token)), ctx)).json.devices;
  assert.deepEqual(list.map(d => [d.name, d.current]), [['A', true], ['B', false]]);
  assert.ok(!JSON.stringify(list).includes(b.token));
  const del = await S.handle(req('DELETE', '/api/devices/' + b.id, authed(a.token)), ctx);
  assert.deepEqual([del.status, del.closeDevice], [200, b.id]);
  assert.equal((await S.handle(req('GET', '/api/sync', authed(b.token)), ctx)).status, 401);
  assert.equal((await S.handle(req('GET', '/api/sync', authed(a.token)), ctx)).status, 200);
});

test('a write is checked whole before any of it is stored', async () => {
  const store = S.memoryStore();
  const ctx = { store, now: T, setupKey: SETUP };
  const { token } = (await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP } }), ctx)).json;
  const r = await S.handle(req('POST', '/api/sync', authed(token, { body: { writes: { 'items/ok': wire('ok', 5), 'bogus/x': wire('no', 5) } } })), ctx);
  assert.equal(r.status, 400);
  assert.equal(store.get('items/ok'), undefined);
  const w = await S.handle(req('POST', '/api/sync', authed(token, { body: { writes: { 'items/ok': wire('ok', 5) } } })), ctx);
  assert.deepEqual(w.broadcast, { type: 'records', from: 0, seq: 1, records: { 'items/ok': wire('ok', 5) } });
});

test('the socket token is read from the protocol header only when it says floatnote', () => {
  assert.equal(S.socketToken({ 'sec-websocket-protocol': 'floatnote, fn_abc' }), 'fn_abc');
  assert.equal(S.socketToken({ 'sec-websocket-protocol': 'chat, fn_abc' }), '');
  assert.equal(S.socketToken({}), '');
});

test('a broadcast too large for one socket message goes out as a notice', () => {
  const small = { type: 'records', from: 0, seq: 1, records: { 'items/a': wire('a', 1) } };
  assert.equal(S.frame(small), JSON.stringify(small));
  const big = { type: 'records', from: 4, seq: 5, records: { 'notes/n': { j: JSON.stringify('é'.repeat(500 * 1024)), t: 1 } } };
  assert.deepEqual(JSON.parse(S.frame(big)), { type: 'changed', seq: 5 }, 'counted in bytes, not characters');
});

// ---------- end to end: sync.js + httpBackend + server ----------

function cloud() {
  const store = S.memoryStore();
  let inflight = 0;
  let sockets = [];
  const later = (fn) => { inflight++; setImmediate(() => { inflight--; fn(); }); };

  // One device's view of the network.
  function link(token) {
    const net = { offline: false, muted: 0, deaf: false, sockets: [] };

    net.fetch = async (url, o) => {
      if (net.offline) throw new TypeError('fetch failed');
      const u = new URL(url);
      const headers = {};
      for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
      inflight++;
      try {
        await new Promise(r => setImmediate(r));
        const res = await S.handle({ method: o.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body: o.body ? JSON.parse(o.body) : undefined }, { store, now: T, setupKey: SETUP });
        if (res.broadcast) for (const s of sockets) later(() => s.receive(S.frame(res.broadcast)));
        if (res.closeDevice) for (const s of sockets.filter(x => x.device === res.closeDevice)) s.serverClose();
        return { ok: res.status < 300, status: res.status, json: async () => res.json };
      } finally { inflight--; }
    };

    net.WebSocket = class {
      constructor(url, protocols) {
        this.url = url;
        inflight++;
        S.authenticate(store, protocols[1], T).then(d => {
          setImmediate(() => {
            inflight--;
            if (!d || net.offline) { if (this.onclose) this.onclose({}); return; }
            this.device = d.id;
            this.open = true;
            sockets.push(this);
            net.sockets.push(this);
            if (this.onopen) this.onopen({});
          });
        });
      }
      receive(data) {
        if (!this.open) return;
        if (net.muted > 0) { net.muted--; return; }
        if (this.onmessage) this.onmessage({ data });
      }
      send(m) { if (m === 'ping' && !net.deaf) later(() => this.receive('pong')); }
      close() { this.open = false; sockets = sockets.filter(s => s !== this); net.sockets = net.sockets.filter(s => s !== this); }
      serverClose() { this.close(); if (this.onclose) this.onclose({}); }
    };

    // The network drops: requests fail and every socket closes.
    net.cut = () => { net.offline = true; for (const s of net.sockets.slice()) s.serverClose(); };
    net.restore = () => { net.offline = false; };
    return net;
  }

  return { store, link, get inflight() { return inflight; }, get sockets() { return sockets; } };
}

async function pairToken(cl, name) {
  return (await S.handle(req('POST', '/api/pair', { body: { setupKey: SETUP, name } }), { store: cl.store, now: T, setupKey: SETUP })).json;
}

async function device(cl, name, skew) {
  const { token, id } = await pairToken(cl, name);
  const net = cl.link(token);
  const d = { state: C.emptyState(), clock: {}, lastSync: null, timers: [], net, id, skew: skew || 0, nowB: () => T };
  const timer = (fn, ms) => { const t = { fn, ms, live: true }; d.timers.push(t); return t; };
  const clear = (t) => { t.live = false; };
  d.backend = httpBackend('https://floatnote.invented.test/', token, {
    fetch: net.fetch, WebSocket: net.WebSocket, setTimer: timer, clearTimer: clear, now: () => d.nowB()
  });
  d.sync = createSync({
    backend: d.backend,
    clock: d.clock,
    getRecords: () => C.toRecords(d.state),
    onRemote: (p) => C.applyPatch(d.state, p),
    getLastSync: () => d.lastSync,
    onSynced: (t) => { d.lastSync = t; },
    setTimer: timer,
    clearTimer: clear,
    now: () => T + d.skew
  });
  d.edit = (fn) => { fn(d.state); return d.sync.push(C.stamp(d.clock, C.toRecords(d.state), tick() + d.skew)); };
  d.add = (text) => {
    const it = C.makeItem({ text, list: 'next', ctx: 'work' }, tick() + d.skew);
    return d.edit(s => { s.items[it.id] = it; }).then(() => it.id);
  };
  // Fire the live timers of one length (5000 = sync retry, 1000 = socket reconnect, 30000 = ping).
  d.fire = async (cl, ms) => {
    const due = d.timers.filter(t => t.live && t.ms === ms);
    for (const t of due) { t.live = false; t.fn(); }
    await settle(cl);
    return due.length;
  };
  return d;
}

// The budget is time, not event-loop turns: inflight also counts the token hash
// in S.authenticate, which runs on the threadpool, and under a parallel test run
// 200 turns can pass (in about 3ms) before one hash finishes.
async function settle(cl) {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    await new Promise(r => setImmediate(r));
    if (cl.inflight === 0) {
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      if (cl.inflight === 0) return;
    }
  }
  throw new Error('network never settled');
}

const texts = s => Object.values(s.items).filter(i => !i.doneAt).map(i => i.text).sort();
const same = (a, b) => assert.equal(C.stableStringify(C.toRecords(a.state)), C.stableStringify(C.toRecords(b.state)));

test('e2e: two devices converge on adds, edits and deletes', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  assert.equal(a.sync.status().mode, 'on');
  const ia = await a.add('Invented alpha');
  const ib = await b.add('Invented bravo');
  await settle(cl);
  assert.deepEqual(texts(a.state), ['Invented alpha', 'Invented bravo']);
  same(a, b);
  await a.edit(s => { s.items[ib].text = 'bravo, edited on A'; });
  await b.edit(s => { s.items[ib].text = 'bravo, edited later on B'; });
  await a.edit(s => { delete s.items[ia]; });
  await settle(cl);
  assert.deepEqual(texts(a.state), ['bravo, edited later on B']);
  same(a, b);
  assert.equal(cl.store.get('items/' + ia).wire.d, true, 'the delete travels as a tombstone');
});

test('e2e: keys Firebase forbids are stored raw on the server and round-trip', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await a.edit(s => { s.meta['odd.key/with#chars%2E'] = 'x'; });
  await settle(cl);
  assert.ok(cl.store.get('meta/odd.key/with#chars%2E'));
  assert.equal(b.state.meta['odd.key/with#chars%2E'], 'x');
});

test('e2e: work done before connecting is pushed, and the server copy is pulled', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server');
  await a.add('Invented on the server');
  await settle(cl);
  await b.add('Invented offline first');
  await b.sync.start('server');
  await settle(cl);
  assert.deepEqual(texts(a.state), ['Invented offline first', 'Invented on the server']);
  same(a, b);
});

test('e2e: a device with a recovered clock (t 0) is accepted, and its copy loses', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server');
  const id = await a.add('Invented, stamped on A');
  await settle(cl);
  // B holds an older copy of the same item and a meta key, with no clock: what a
  // device has after its clock file is lost.
  b.state.items[id] = Object.assign({}, a.state.items[id], { text: 'Invented, B unknown age' });
  b.state.meta.inventedOnB = 'Invented from B';
  C.recoverClock(b.clock, C.toRecords(b.state));
  await b.sync.start('server');
  await settle(cl);
  assert.equal(b.sync.status().mode, 'on', String(b.sync.status().error));
  assert.equal(b.state.items[id].text, 'Invented, stamped on A');
  assert.equal(a.state.meta.inventedOnB, 'Invented from B', 'a t 0 record with no rival still travels');
});

test('e2e: offline reads as offline, not error, and coming back reconciles both ways', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  const id = await a.add('Invented shared');
  await settle(cl);

  a.net.cut();
  await settle(cl);
  await a.add('Invented on the train');
  assert.deepEqual(a.sync.status(), Object.assign({}, a.sync.status(), { mode: 'offline', error: null }));
  await b.edit(s => { s.items[id].text = 'shared, edited on B meanwhile'; });
  await settle(cl);
  assert.deepEqual(texts(b.state), ['shared, edited on B meanwhile']);

  a.net.restore();
  assert.equal(await a.fire(cl, 1000), 1, 'the socket reconnect was scheduled');
  assert.equal(a.sync.status().mode, 'on');
  assert.deepEqual(texts(a.state), ['Invented on the train', 'shared, edited on B meanwhile']);
  same(a, b);
});

test('negative control: still cut off, the offline edit does not arrive', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  a.net.cut();
  await a.add('Invented and stuck');
  await a.fire(cl, 1000);
  await a.fire(cl, 5000);
  assert.deepEqual(texts(b.state), []);
  assert.equal(a.sync.status().mode, 'offline');
});

test('e2e: a dropped socket catches up on reconnect', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  for (const s of a.net.sockets.slice()) s.serverClose();
  await b.add('Invented while A had no socket');
  await b.add('Invented, second');
  await settle(cl);
  assert.deepEqual(texts(a.state), [], 'nothing arrives without the socket');
  await a.fire(cl, 1000);
  assert.deepEqual(texts(a.state), ['Invented while A had no socket', 'Invented, second']);
});

test('e2e: a lost broadcast is noticed at the next one, and both arrive', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  a.net.muted = 1;
  await b.add('Invented, broadcast lost');
  await settle(cl);
  assert.deepEqual(texts(a.state), [], 'the lost broadcast really is lost');
  await b.add('Invented, next broadcast');
  await settle(cl);
  assert.deepEqual(texts(a.state), ['Invented, broadcast lost', 'Invented, next broadcast']);
});

test('e2e: a change too large for a socket message still arrives', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  await a.edit(s => { s.meta.invented = 'x'.repeat(950 * 1024); });
  await settle(cl);
  assert.equal((b.state.meta.invented || '').length, 950 * 1024);
});

test('e2e: a device whose clock runs behind adopts the newer copy instead of winning', async () => {
  const cl = cloud(), a = await device(cl, 'A', -3600e3), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  const id = await b.add('Invented, B');
  await settle(cl);
  a.net.muted = 99;   // A hears nothing more, so only the write answer can tell it
  await b.edit(s => { s.items[id].text = 'Invented, B edited'; });
  await settle(cl);
  await a.edit(s => { s.items[id].text = 'Invented, A an hour slow'; });
  await settle(cl);
  assert.equal(cl.store.get('items/' + id).wire.j.includes('B edited'), true, 'the server kept the newest');
  assert.equal(a.state.items[id].text, 'Invented, B edited', 'A took the copy the server answered with');
});

test('e2e: a silent socket is closed after the pings go unanswered, then reopened', async () => {
  const cl = cloud(), a = await device(cl, 'A');
  await a.sync.start('server');
  await settle(cl);
  a.net.deaf = true;
  const t0 = T;
  a.nowB = () => t0 + 40e3;
  await a.fire(cl, 30000);
  assert.equal(a.net.sockets.length, 1, 'one missed pong is not yet dead');
  a.nowB = () => t0 + 80e3;
  await a.fire(cl, 30000);
  assert.equal(a.net.sockets.length, 0, 'closed as dead');
  assert.equal(a.sync.status().mode, 'offline');
  a.net.deaf = false;
  await a.fire(cl, 1000);
  assert.equal(a.net.sockets.length, 1);
  assert.equal(a.sync.status().mode, 'on');
});

test('e2e: a revoked device shows an error, not offline, and its socket is closed', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  assert.equal(cl.sockets.length, 2);
  S.revoke(cl.store, b.id);
  // what DELETE /api/devices/<id> does to the open socket
  for (const s of cl.sockets.filter(x => x.device === b.id)) s.serverClose();
  await settle(cl);
  await b.add('Invented after revoke');
  await settle(cl);
  assert.equal(b.sync.status().mode, 'error');
  assert.equal(b.sync.status().error, 'unauthorized');
  assert.deepEqual(texts(a.state), []);
});

test('e2e: stop closes the socket and remote changes are ignored', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  await a.sync.start('server'); await b.sync.start('server');
  await settle(cl);
  b.sync.stop();
  await settle(cl);
  assert.equal(b.net.sockets.length, 0);
  await a.add('Invented after stop');
  await settle(cl);
  assert.deepEqual(texts(b.state), []);
});

test('e2e: a first push larger than one request goes in chunks', async () => {
  const cl = cloud(), a = await device(cl, 'A'), b = await device(cl, 'B');
  for (let i = 0; i < 1500; i++) a.state.habitLog['h1_' + C.addDays('2020-01-01', i)] = true;
  C.stamp(a.clock, C.toRecords(a.state), tick());
  await a.sync.start('server');
  await b.sync.start('server');
  await settle(cl);
  assert.equal(Object.keys(b.state.habitLog).length, 1500);
  assert.equal(cl.store.seq() >= 1500, true);
});
