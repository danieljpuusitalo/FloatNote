// Hand-check: two real FloatNote windows (scratch data, invented items) syncing through the
// local dev server: add, edit, tick, untick, delete, then the server goes away,
// both edit, it comes back, and they converge. Two passes: races are intermittent.
//   node tools/check-server-sync.mjs        (needs: cd server && npm install)
// Against a deployed Worker: set FLOATNOTE_CHECK_URL and FLOATNOTE_SETUP_KEY. A
// deployed server cannot be stopped from here, so that run skips the offline part.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const C = createRequire(import.meta.url)(repo + '/core.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REMOTE = process.env.FLOATNOTE_CHECK_URL;
const PORT = 8799, URL_ = REMOTE ? REMOTE.replace(/\/$/, '') : 'http://127.0.0.1:' + PORT;
const KEY = REMOTE ? process.env.FLOATNOTE_SETUP_KEY : 'invented-' + randomBytes(12).toString('hex');
if (REMOTE && !KEY) throw new Error('FLOATNOTE_CHECK_URL needs FLOATNOTE_SETUP_KEY');
const work = mkdtempSync(join(tmpdir(), 'fn-two-'));
const dbFile = join(work, 'server.sqlite');

let srv;
async function startServer() {
  if (REMOTE) return;
  srv = spawn(process.execPath, [repo + '/server/dev-server.mjs', String(PORT), dbFile], { env: { ...process.env, SETUP_KEY: KEY }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(150); try { await fetch(URL_ + '/api/sync'); return; } catch {} }
  throw new Error('server did not start');
}
async function stopServer() { if (REMOTE) return; srv.kill(); await new Promise(r => srv.once('exit', r)); }

function dataDir(name) {
  const dir = join(work, name);
  const s = C.emptyState();
  s.meta.lastPick = C.dateStr(Date.now());
  s.preferences = Object.assign(s.preferences || {}, { name: 'Tester', onboarded: true });
  execFileSync(process.execPath, [repo + '/tools/pair-device.mjs', URL_, 'Invented ' + name], { env: { ...process.env, FLOATNOTE_SETUP_KEY: KEY, FLOATNOTE_DATA_DIR: dir } });
  writeFileSync(join(dir, 'floatnote-data.json'), JSON.stringify(s));
  return dir;
}

async function launch(name, port) {
  const dir = dataDir(name);
  const child = spawn(repo + '/node_modules/electron/dist/electron.exe', [repo, '--remote-debugging-port=' + port],
    { env: { ...process.env, FLOATNOTE_DATA_DIR: dir, FLOATNOTE_SYNC: 'server' }, stdio: 'ignore' });
  let page;
  for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page' && !t.url.includes('#capture')); } catch {} }
  if (!page) throw new Error(name + ': no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) pend.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text); });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable', {});
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { name, child, ws, ev, errs, dir };
}

let fails = 0;
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails++; };
const texts = w => w.ev(`JSON.stringify(Object.values(state.items).map(i => i.text + (i.doneAt ? ' [done]' : '')).sort())`);
const mode = w => w.ev(`window.api.getInfo().then(i => i.sync.mode)`);
async function until(fn, ms = 8000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; }
const idOf = (w, text) => w.ev(`Object.values(state.items).find(i => i.text === ${JSON.stringify(text)})?.id`);

await startServer();
const A = await launch('A', 9361), B = await launch('B', 9362);
await sleep(2500);

for (let pass = 1; pass <= 2; pass++) {
  console.log('--- pass ' + pass);
  check('both report sync on', (await until(async () => (await mode(A)) === 'on' && (await mode(B)) === 'on')) === true, [await mode(A), await mode(B)]);
  const t1 = `Invented ${pass}: alpha from A`;
  await A.ev(`addFromCapture(${JSON.stringify(t1)}, false)`);
  check('add on A reaches B', !!(await until(() => idOf(B, t1))), await texts(B));
  const id1 = await idOf(B, t1);
  const t1b = t1 + ', edited on B';
  await B.ev(`state.items[${JSON.stringify(id1)}].text = ${JSON.stringify(t1b)}; state.items[${JSON.stringify(id1)}].updatedAt = Date.now(); changed()`);
  check('edit on B reaches A', !!(await until(() => idOf(A, t1b))), await texts(A));
  await A.ev(`state.items[${JSON.stringify(id1)}].doneAt = Date.now(); changed()`);
  check('tick on A reaches B', await until(() => B.ev(`!!state.items[${JSON.stringify(id1)}].doneAt`)), await texts(B));
  await B.ev(`state.items[${JSON.stringify(id1)}].doneAt = null; changed()`);
  check('untick on B reaches A', await until(() => A.ev(`!state.items[${JSON.stringify(id1)}].doneAt`)), await texts(A));
  await A.ev(`delete state.items[${JSON.stringify(id1)}]; changed()`);
  check('delete on A reaches B', await until(() => B.ev(`!state.items[${JSON.stringify(id1)}]`)), await texts(B));

  // The server goes away. Both edit. It comes back.
  if (REMOTE) { console.log('skip the server going away: it is deployed'); continue; }
  await stopServer();
  check('both read offline, not error', (await until(async () => (await mode(A)) === 'offline' && (await mode(B)) === 'offline', 10000)) === true, [await mode(A), await mode(B)]);
  const ta = `Invented ${pass}: written on A offline`, tb = `Invented ${pass}: written on B offline`;
  await A.ev(`addFromCapture(${JSON.stringify(ta)}, false)`);
  await B.ev(`addFromCapture(${JSON.stringify(tb)}, false)`);
  await sleep(1500);
  check('negative control: nothing crosses while the server is down', !(await idOf(B, ta)) && !(await idOf(A, tb)), [await texts(A), await texts(B)]);
  check('still offline after an edit, not error', (await mode(A)) === 'offline' && (await mode(B)) === 'offline', [await mode(A), await mode(B)]);
  await startServer();
  const conv = await until(async () => (await texts(A)) === (await texts(B)) && !!(await idOf(A, tb)) && !!(await idOf(B, ta)), 70000);
  check('after reconnect both hold both offline edits', !!conv, [await texts(A), await texts(B)]);
  check('both back on', (await until(async () => (await mode(A)) === 'on' && (await mode(B)) === 'on')) === true, [await mode(A), await mode(B)]);
  const recs = w => w.ev(`FNCore.stableStringify(Object.entries(FNCore.toRecords(state)).filter(([k]) => k.startsWith('items/')).sort((x, y) => x[0] < y[0] ? -1 : 1))`);
  const ra = await recs(A), rb = await recs(B);
  check('item records identical on both, and not empty', ra === rb && ra.length > 20, [ra && ra.length, rb && rb.length]);
}
check('no page exceptions', A.errs.length + B.errs.length === 0, [A.errs, B.errs]);

console.log(fails ? fails + ' FAILED' : 'all passed');
for (const w of [A, B]) { w.ws.close(); w.child.kill(); }
await stopServer(); await sleep(800);
process.exit(fails ? 1 : 0);
