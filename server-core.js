// The FloatNote server's logic, pure: the Durable Object in server/ supplies the
// store (SQLite) and the sockets, the tests supply a Map. Nothing here touches
// Cloudflare, Electron or the DOM.
//
// It holds the same records sync.js exchanges, one row per path:
//   path = '<kind>/<raw key>'   wire = { j: JSON text, t } | { t, d: true }
// and keeps the NEWEST t per path (Firebase kept the last write). An older write
// is answered with the copy the server kept, so the writer adopts it at once.
// Every accepted write gets the next sequence number; a device that missed
// broadcasts asks for everything after the last one it saw.
//
// Devices authenticate with a bearer token, stored only as its SHA-256. The
// first device is paired with the SETUP_KEY secret.
'use strict';

const KINDS = ['items', 'completions', 'notes', 'habits', 'habitLog', 'meta'];
const MAX_PATH = 300;
const MAX_VALUE = 1 << 20;        // one record's JSON text (a SQLite row allows 2 MB)
const MAX_WRITES = 2000;          // per request; the client sends in chunks of 1000
const SEEN_EVERY_MS = 60 * 60 * 1000;

function validPath(p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return false;
  const i = p.indexOf('/');
  return i > 0 && i < p.length - 1 && KINDS.includes(p.slice(0, i));
}

// A clean copy of a wire record, null for a purge, undefined when malformed.
// t 0 is legitimate: core.recoverClock gives records of unknown age t 0, so they
// lose to any stamped copy.
function cleanWire(w) {
  if (w === null) return null;
  if (!w || typeof w !== 'object' || !Number.isFinite(w.t) || w.t < 0) return undefined;
  if (w.d === true) return { t: w.t, d: true };
  if (typeof w.j !== 'string' || w.j.length > MAX_VALUE) return undefined;
  return { j: w.j, t: w.t };
}

// ---------- records ----------

// writes: { path: wire | null }. null removes the row, and only a tombstone:
// devices purge tombstones past their horizon, never live records.
// Returns { from, seq, applied: {path: wire}, stale: {path: wire} }.
function applyWrites(store, writes) {
  const from = store.seq();
  let seq = from;
  const applied = {};
  const stale = {};
  for (const [path, w] of Object.entries(writes)) {
    const cur = store.get(path);
    if (w === null) {
      if (cur && cur.wire.d) store.del(path);
      continue;
    }
    if (cur && cur.wire.t >= w.t) {
      // A tie keeps the stored copy. Equal t is the writer's own echo, a same-ms
      // clash, or two devices with recovered (t 0) clocks; for the last two the
      // writer is answered with the kept copy, which wins a tie on the device.
      if (cur.wire.t > w.t || cur.wire.j !== w.j || !cur.wire.d !== !w.d) stale[path] = cur.wire;
      continue;
    }
    seq++;
    store.put(path, w, seq);
    applied[path] = w;
  }
  if (seq !== from) store.setSeq(seq);
  return { from, seq, applied, stale };
}

// Everything, or only rows written after `since`.
function records(store, since) {
  const out = {};
  for (const [path, row] of store.rows(since || 0)) out[path] = row.wire;
  return { seq: store.seq(), records: out };
}

// The socket message for a broadcast. A Workers WebSocket message is at most
// 1 MiB, so a larger change goes out as a notice and devices fetch it over HTTP.
const MAX_FRAME = 900 * 1024;
function frame(broadcast) {
  const m = JSON.stringify(broadcast);
  if (new TextEncoder().encode(m).length <= MAX_FRAME) return m;
  return JSON.stringify({ type: 'changed', seq: broadcast.seq });
}

// ---------- devices ----------

function hex(buf) {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function randomToken(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compares digests, so the time taken says nothing about the key.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function pair(store, name, now) {
  const token = 'fn_' + randomToken(32);
  const device = {
    id: randomToken(9),
    name: String(name || 'device').slice(0, 60),
    created: now,
    lastSeen: now,
    revoked: false
  };
  store.putDevice(await sha256(token), device);
  return { token, device };
}

// The device a token belongs to, or null. Touches lastSeen at most hourly.
async function authenticate(store, token, now) {
  if (typeof token !== 'string' || !token.startsWith('fn_') || token.length > 100) return null;
  const hash = await sha256(token);
  const d = store.device(hash);
  if (!d || d.revoked) return null;
  if (now - d.lastSeen > SEEN_EVERY_MS) store.putDevice(hash, Object.assign({}, d, { lastSeen: now }));
  return d;
}

function revoke(store, id) {
  for (const [hash, d] of store.devices()) {
    if (d.id === id) {
      store.putDevice(hash, Object.assign({}, d, { revoked: true }));
      return true;
    }
  }
  return false;
}

// ---------- requests ----------

function bearer(headers) {
  const h = headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// The token rides in Sec-WebSocket-Protocol, since a browser cannot set headers
// on a WebSocket: 'floatnote, <token>'.
function socketToken(headers) {
  const parts = String(headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  return parts[0] === 'floatnote' ? parts[1] || '' : '';
}

const reply = (status, json, extra) => Object.assign({ status, json }, extra);
const fail = (status, error) => reply(status, { error });

// req: { method, path, query: {k: v}, headers: {lowercase: v}, body: parsed JSON }
// ctx: { store, now, setupKey, transaction?(fn) }
// Returns { status, json, broadcast?, closeDevice? } for the Durable Object to act on.
async function handle(req, ctx) {
  const { store, now } = ctx;
  const tx = ctx.transaction || (fn => fn());
  const { method, path } = req;

  if (path === '/api/pair' && method === 'POST') {
    const body = req.body || {};
    if (!ctx.setupKey) return fail(503, 'pairing is not set up');
    if (typeof body.setupKey !== 'string' || !(await sameSecret(body.setupKey, ctx.setupKey))) {
      return fail(403, 'wrong setup key');
    }
    const { token, device } = await pair(store, body.name, now);
    return reply(201, { token, id: device.id, name: device.name });
  }

  const device = await authenticate(store, bearer(req.headers), now);
  if (!device) return fail(401, 'unauthorized');

  if (path === '/api/sync' && method === 'GET') {
    const since = Number(req.query.since || 0);
    if (!Number.isInteger(since) || since < 0) return fail(400, 'bad since');
    return reply(200, records(store, since));
  }

  if (path === '/api/sync' && method === 'POST') {
    const writes = req.body && req.body.writes;
    if (!writes || typeof writes !== 'object' || Array.isArray(writes)) return fail(400, 'no writes');
    const entries = Object.entries(writes);
    if (entries.length > MAX_WRITES) return fail(413, 'too many writes');
    const clean = {};
    for (const [p, w] of entries) {
      const c = cleanWire(w);
      if (!validPath(p) || c === undefined) return fail(400, 'bad record: ' + String(p).slice(0, 80));
      clean[p] = c;
    }
    const r = tx(() => applyWrites(store, clean));
    const out = reply(200, { seq: r.seq, stale: r.stale });
    if (Object.keys(r.applied).length) out.broadcast = { type: 'records', from: r.from, seq: r.seq, records: r.applied };
    return out;
  }

  if (path === '/api/devices' && method === 'GET') {
    const list = [];
    for (const [, d] of store.devices()) list.push(Object.assign({ current: d.id === device.id }, d));
    list.sort((a, b) => a.created - b.created);
    return reply(200, { devices: list });
  }

  const m = /^\/api\/devices\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (m && method === 'DELETE') {
    if (!tx(() => revoke(store, m[1]))) return fail(404, 'no such device');
    return reply(200, { ok: true }, { closeDevice: m[1] });
  }

  return fail(404, 'not found');
}

// ---------- stores ----------

// In memory, for tests.
function memoryStore() {
  const rows = new Map();
  const devs = new Map();
  let seq = 0;
  return {
    get: p => rows.get(p),
    put: (p, wire, s) => { rows.set(p, { wire, seq: s }); },
    del: p => { rows.delete(p); },
    rows: since => [...rows].filter(([, r]) => r.seq > since).sort((a, b) => a[1].seq - b[1].seq),
    seq: () => seq,
    setSeq: s => { seq = s; },
    device: h => devs.get(h),
    putDevice: (h, d) => { devs.set(h, d); },
    devices: () => [...devs]
  };
}

// Over SQLite. exec(sql, ...params) returns an array of row objects: the Durable
// Object passes ctx.storage.sql.exec(...).toArray(), the tests node:sqlite.
function sqlStore(exec) {
  exec('CREATE TABLE IF NOT EXISTS records (path TEXT PRIMARY KEY, wire TEXT NOT NULL, seq INTEGER NOT NULL)');
  exec('CREATE INDEX IF NOT EXISTS records_seq ON records (seq)');
  exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  exec('CREATE TABLE IF NOT EXISTS devices (hash TEXT PRIMARY KEY, rec TEXT NOT NULL)');
  const one = (rows) => rows[0];
  return {
    get(p) {
      const r = one(exec('SELECT wire, seq FROM records WHERE path = ?', p));
      return r ? { wire: JSON.parse(r.wire), seq: r.seq } : undefined;
    },
    put(p, wire, s) {
      exec('INSERT INTO records (path, wire, seq) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET wire = excluded.wire, seq = excluded.seq',
        p, JSON.stringify(wire), s);
    },
    del(p) { exec('DELETE FROM records WHERE path = ?', p); },
    rows(since) {
      return exec('SELECT path, wire, seq FROM records WHERE seq > ? ORDER BY seq', since)
        .map(r => [r.path, { wire: JSON.parse(r.wire), seq: r.seq }]);
    },
    seq() {
      const r = one(exec("SELECT v FROM meta WHERE k = 'seq'"));
      return r ? Number(r.v) : 0;
    },
    setSeq(s) {
      exec("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(s));
    },
    device(h) {
      const r = one(exec('SELECT rec FROM devices WHERE hash = ?', h));
      return r ? JSON.parse(r.rec) : undefined;
    },
    putDevice(h, d) {
      exec('INSERT INTO devices (hash, rec) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET rec = excluded.rec', h, JSON.stringify(d));
    },
    devices() {
      return exec('SELECT hash, rec FROM devices').map(r => [r.hash, JSON.parse(r.rec)]);
    }
  };
}

module.exports = {
  KINDS, MAX_WRITES, MAX_VALUE,
  validPath, cleanWire, applyWrites, records, frame,
  sha256, pair, authenticate, revoke, socketToken, handle,
  memoryStore, sqlStore
};
