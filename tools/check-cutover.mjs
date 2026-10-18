// Hand-check for the 2.2.0 cutover: a desktop that has been syncing on Firebase
// moves to the FloatNote server through Settings, as Daniel will do it, and
// nothing is lost or doubled. Two real Electron windows on scratch data dirs of
// invented to-dos, driven over CDP with real mouse clicks and typed keys.
//
//   node tools/check-cutover.mjs                 local dev server (cd server && npm install)
//   FLOATNOTE_SETUP_KEY=... node tools/check-cutover.mjs https://<staging>
//
// Against a real server it pairs three devices, revokes them at the end and
// tombstones every invented to-do, so paired phones see the fixture come and go.
// Only this run's records are compared, ticked or tombstoned: those with its tag.
// The fixture's notes, preferences and habits are older than the server's, so
// they lose and the server's copy stays; the one shared record the run does
// change is meta/lastDay, set to today by the app's own launch.
// The key is read from the environment and only ever typed into the window.
// --negative deletes the desktop's clock file before the switch: the delete
// check must then fail (a switch that loses the clock forgets what was deleted).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const C = createRequire(import.meta.url)(join(repo, 'core.js'));
// FLOATNOTE_EXE runs a packaged build instead (dist/win-arm64-unpacked/FloatNote.exe).
const ELECTRON = process.env.FLOATNOTE_EXE || join(repo, 'node_modules/electron/dist/electron.exe');
const APP = process.env.FLOATNOTE_EXE ? [] : [repo];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const NEGATIVE = args.includes('--negative');
const remote = args.find(a => /^https:\/\//.test(a));
const work = mkdtempSync(join(tmpdir(), 'fn-cutover-'));
console.log('scratch: ' + work + (remote ? '  server: ' + remote : '  server: local'));

// ---------- the server ----------
let srv = null, URL_, KEY;
if (remote) {
  URL_ = remote.replace(/\/+$/, '');
  KEY = process.env.FLOATNOTE_SETUP_KEY;
  if (!KEY) { console.error('set FLOATNOTE_SETUP_KEY for a real server'); process.exit(2); }
} else {
  const PORT = 8797;
  URL_ = 'http://127.0.0.1:' + PORT;
  KEY = 'invented-' + randomBytes(12).toString('hex');
  srv = spawn(process.execPath, [join(repo, 'server/dev-server.mjs'), String(PORT), join(work, 'server.sqlite')],
    { env: { ...process.env, SETUP_KEY: KEY }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(200); try { await fetch(URL_ + '/api/sync'); break; } catch {} }
}

const DAY = C.DAY_MS, now = Date.now(), T0 = now - 20 * DAY;
const tag = randomBytes(3).toString('hex');
// This run's records: to-dos whose text carries the tag, and the tagged deletes.
const ours = (path, w) => path.startsWith('items/') && (path.includes(tag) || (!!w && !w.d && JSON.parse(w.j).text.includes(tag)));

// A probe device reads what the server holds, the way a phone would.
async function api(method, path, token, body) {
  const res = await fetch(URL_ + path, {
    method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const probe = (await api('POST', '/api/pair', null, { setupKey: KEY, name: 'cutover probe' })).body;
if (!probe.token) throw new Error('the probe could not pair');
const before = new Set(Object.keys((await api('GET', '/api/sync', probe.token)).body.records || {}));
async function serverRecords() {
  const all = (await api('GET', '/api/sync', probe.token)).body.records || {};
  const out = {};
  for (const [k, w] of Object.entries(all)) {
    if (before.has(k)) continue;   // what a real server held already is not ours
    const i = k.indexOf('/');
    out[C.keyToPath(k.slice(0, i), k.slice(i + 1))] = w;
  }
  return out;
}

// ---------- the fixture: a desktop that has been syncing on Firebase ----------
function fixture() {
  const s = C.emptyState();
  s.preferences = Object.assign(s.preferences, { name: 'Tester', onboarded: true });
  s.meta.lastPick = C.dateStr(now);
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const it = C.makeItem({ text: 'Invented to-do ' + tag + ' ' + (i + 1), list: ['today', 'next', 'next', 'waiting', 'later'][i % 5], ctx: i % 3 ? 'work' : 'personal' }, T0 + i * 60000);
    s.items[it.id] = it;
    ids.push(it.id);
  }
  for (const id of ids.slice(30, 36)) C.completeItem(s, id, T0 + DAY);
  s.notes.professional = '<div>Invented note ' + tag + '</div>';
  s.habits.push({ id: 'h_inv' + tag, name: 'Invented habit', createdAt: new Date(T0).toISOString() });
  s.habitLog['h_inv' + tag + ':' + C.dateStr(T0 + DAY)] = true;
  const clock = {};
  C.stamp(clock, C.toRecords(s), T0 + 2 * DAY);
  // Eight to-dos deleted after they had synced: tombstones only.
  for (let i = 0; i < 8; i++) clock['items/i_gone' + tag + i] = { t: T0 + 3 * DAY + i, d: true };
  return { s, clock };
}
const { s: fixState, clock: fixClock } = fixture();
const TOMBS = 8;

function dataDir(name, files) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(v));
  return dir;
}
const dirA = dataDir('desktop', {
  'floatnote-data.json': fixState,
  'floatnote-clock.json': C.clockFile(fixClock, now - 3600000),   // synced an hour ago
  'floatnote-backend.json': { backend: 'firebase' }                 // on Firebase, without a passphrase so nothing reaches it
});
if (NEGATIVE) unlinkSync(join(dirA, 'floatnote-clock.json'));
const fresh = C.emptyState();
fresh.preferences = Object.assign(fresh.preferences, { name: 'Tester', onboarded: true });
fresh.meta.lastPick = C.dateStr(now);
const dirB = dataDir('laptop', { 'floatnote-data.json': fresh });

// ---------- Electron over CDP ----------
const procs = [];
async function launch(dir, port) {
  const env = { ...process.env, FLOATNOTE_DATA_DIR: dir };
  delete env.FLOATNOTE_SYNC;
  const child = spawn(ELECTRON, [...APP, '--remote-debugging-port=' + port], { env, stdio: 'ignore' });
  procs.push(child);
  let page;
  for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page' && !t.url.includes('#capture')); } catch {} }
  if (!page) throw new Error('no window on ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id) pend.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('evaluate: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  const click = async sel => {
    const b = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.offsetParent) return null;
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!b) throw new Error('not visible: ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(90);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(250);
  };
  const type = async (sel, text) => {
    await click(sel);
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.select(); })()`);
    await send('Input.insertText', { text });
  };
  const until = async (expr, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await ev(expr)) return true;
    return false;
  };
  await sleep(1500);
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(work, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  return { ev, click, type, until, shot, errs, ws, child };
}

let fails = 0;
const mine = [];   // device ids this run paired through the windows
const deviceId = dir => JSON.parse(readFileSync(join(dir, 'floatnote-server.json'), 'utf-8')).id;   // the id only, never the token
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails++; };
const status = d => d.ev(`document.getElementById('sync-status').textContent`);
const seg = d => d.ev(`[...document.querySelectorAll('#backend-seg button.on')].map(b => b.dataset.b).join()`);
const visible = (d, sel) => d.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !!e.offsetParent; })()`);
const items = d => d.ev(`Object.values(state.items).filter(i => i.text.includes('${tag}')).map(i => i.id + '|' + i.text + '|' + i.list + '|' + (i.doneAt ? 'done' : '')).sort()`);

try {
  // 1. The desktop as it is today: Firebase, everything local.
  const A = await launch(dirA, 9381);
  await A.click('#btn-settings');
  await sleep(300);
  await A.shot('1-firebase');
  check('desktop starts on Firebase (old)', await seg(A) === 'firebase', await seg(A));
  check('the passphrase box shows, no server address', await visible(A, '#sync-pass') && !(await visible(A, '#sync-url')), null);
  const beforeA = await items(A);
  // What the desktop holds as it switches (launch itself stamps meta/lastDay).
  const deskRecords = await A.ev('FN.toRecords(state)');
  if (remote) for (const k of Object.keys(deskRecords)) if (!ours(k, { t: 0, j: JSON.stringify(deskRecords[k]) })) delete deskRecords[k];
  const LIVE = Object.keys(deskRecords).length;
  check('desktop holds the fixture', beforeA.length === 40, beforeA.length);

  // 2. Choose the server: the address is filled in, the key is typed, Pair.
  await A.click('#backend-seg button[data-b="server"]');
  check('choosing the server shows the address and the setup key box', await seg(A) === 'server' && await visible(A, '#sync-url') && await visible(A, '#sync-pass'), await seg(A));
  check('the address defaults to the production server', /^https:\/\/floatnote\./.test(await A.ev(`document.getElementById('sync-url').value`)), await A.ev(`document.getElementById('sync-url').value`));
  await A.shot('2-server-unpaired');
  check('chosen but not paired: nothing leaves this computer', /^Off/.test(await status(A)), await status(A));
  await A.type('#sync-pass', 'not-the-key-' + tag);
  await A.type('#sync-url', URL_);
  await A.click('#sync-save');
  await sleep(800); await A.shot('2b-wrong-key');
  check('a wrong key is refused in words', await A.until(`document.getElementById('sync-msg').textContent === 'That setup key is not right.'`), await A.ev(`document.getElementById('sync-msg').textContent`));
  await A.type('#sync-pass', KEY);
  await A.click('#sync-save');
  check('the right key pairs and sync comes on', await A.until(`/^On/.test(document.getElementById('sync-status').textContent)`, 20000), await status(A));
  await A.shot('3-server-paired');
  check('once paired the boxes go and Unpair shows', !(await visible(A, '#sync-pass')) && !(await visible(A, '#sync-url')) && await A.ev(`document.getElementById('sync-off').textContent`) === 'Unpair this computer', null);
  mine.push(deviceId(dirA));
  check('the key is not kept anywhere in the data dir', !readFileSync(join(dirA, 'floatnote-server.json'), 'utf-8').includes(KEY) && !readFileSync(join(dirA, 'floatnote-backend.json'), 'utf-8').includes(KEY), null);
  await sleep(1500);

  // 3. The server holds exactly the desktop's records, deletes included.
  let srvRecs = await serverRecords();
  if (remote) srvRecs = Object.fromEntries(Object.entries(srvRecs).filter(([p, w]) => ours(p, w)));
  const liveOnServer = Object.entries(srvRecs).filter(([, w]) => !w.d);
  const tombsOnServer = Object.entries(srvRecs).filter(([, w]) => w.d);
  check('every record reached the server, no more (' + LIVE + ')', liveOnServer.length === LIVE, liveOnServer.length);
  check('every delete reached the server as a tombstone (' + TOMBS + ')', tombsOnServer.length === TOMBS, tombsOnServer.length);
  const mismatched = liveOnServer.filter(([p, w]) => C.stableStringify(JSON.parse(w.j)) !== C.stableStringify(deskRecords[p])).map(([p]) => p);
  check('each record on the server is the desktop\'s copy', mismatched.length === 0, mismatched.slice(0, 5));
  const afterA = await items(A);
  check('the desktop itself is unchanged by the switch', JSON.stringify(afterA) === JSON.stringify(beforeA), afterA.length);

  // 4. A second computer, fresh install: defaults to the server, pairs, gets it all.
  const B = await launch(dirB, 9382);
  await B.click('#btn-settings');
  await sleep(300);
  check('a fresh install starts on the server', await seg(B) === 'server', await seg(B));
  await B.type('#sync-url', URL_);
  await B.type('#sync-pass', KEY);
  await B.click('#sync-save');
  check('the second computer pairs', await B.until(`/^On/.test(document.getElementById('sync-status').textContent)`, 20000), await status(B));
  mine.push(deviceId(dirB));
  await B.until(`Object.values(state.items).filter(i => i.text.includes('${tag}')).length >= 40`);
  const gotB = await items(B);
  check('it holds the same 40 to-dos, none doubled, the done ones done', JSON.stringify(gotB) === JSON.stringify(afterA), gotB.length);
  // On a real server its own newer notes win over the fixture's; either way both
  // computers end on the same copy. (Compared, never printed: they may be real.)
  const notesOf = d => d.ev(`JSON.stringify(state.notes)`);
  check('and the same notes on both', await B.until(`JSON.stringify(state.notes) === ${JSON.stringify(await notesOf(A))}`, 5000), null);
  if (!remote) check('the desktop\'s notes, on the empty server', (await notesOf(B)).includes('Invented note ' + tag), null);
  await B.click('#settings-close');
  await A.click('#settings-close');

  // 5. Both ways, live.
  await B.ev(`(() => { const c = document.getElementById('capture-input'); c.focus(); c.value = 'Invented from the laptop ${tag}'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('added on the laptop, on the desktop within seconds', await A.until(`Object.values(state.items).some(i => i.text === 'Invented from the laptop ${tag}')`, 10000), null);
  const tickId = await A.ev(`todoRows().map(r => r.dataset.id).find(id => !state.items[id].doneAt && state.items[id].text.includes('${tag}'))`);
  await A.click(`.todo-item[data-id="${tickId}"] input[type="checkbox"]`);
  check('ticked on the desktop, done on the laptop', await B.until(`!!(state.items['${tickId}'] || {}).doneAt`, 10000), null);

  // 6. Unpair: the token is gone here and revoked on the server.
  await A.click('#btn-settings');
  await sleep(300);
  await A.click('#sync-off');
  check('Unpair asks for a second click', /^Click again/.test(await A.ev(`document.getElementById('sync-off').textContent`)), null);
  await A.click('#sync-off');
  check('unpaired: sync is off, the boxes are back', await A.until(`/^Off/.test(document.getElementById('sync-status').textContent)`) && await visible(A, '#sync-pass'), await status(A));
  check('the token file is gone', !existsSync(join(dirA, 'floatnote-server.json')), null);
  await sleep(1000);
  const devs = (await api('GET', '/api/devices', probe.token)).body.devices || [];
  const devA = devs.find(d => d.id === mine[0]);
  check('the desktop\'s device is revoked on the server', !!devA && devA.revoked, devA);

  // 7. Back to Firebase, then a restart: the choice and the data stay.
  await A.click('#backend-seg button[data-b="firebase"]');
  check('switching back to Firebase (old)', await seg(A) === 'firebase' && await visible(A, '#sync-pass') && !(await visible(A, '#sync-url')), await seg(A));
  check('Firebase without a passphrase: off', /^Off/.test(await status(A)), await status(A));
  const errsA = A.errs.slice();
  A.ws.close(); A.child.kill(); await sleep(1500);
  const A2 = await launch(dirA, 9383);
  await A2.click('#btn-settings');
  await sleep(300);
  check('after a restart it is still on Firebase (old)', await seg(A2) === 'firebase', await seg(A2));
  check('and holds all 41 to-dos', (await items(A2)).length === 41, (await items(A2)).length);

  check('no page exceptions', errsA.length + B.errs.length + A2.errs.length === 0, errsA.concat(B.errs, A2.errs));
} catch (e) {
  console.log('FAIL ' + e.message);
  fails++;
} finally {
  if (remote) {
    // Leave the real server as it was: tombstone every invented record, revoke the devices.
    try {
      const left = await serverRecords();
      const t = Date.now();
      const writes = {};
      for (const [p, w] of Object.entries(left)) if (!w.d && ours(p, w)) writes[C.pathToKey(p)] = { t, d: true };
      if (Object.keys(writes).length) await api('POST', '/api/sync', probe.token, { writes });
      // Only the devices this run paired; the probe last, since it does the revoking.
      for (const id of mine.concat(probe.id)) await api('DELETE', '/api/devices/' + id, probe.token);
      console.log('cleaned up: ' + Object.keys(writes).length + ' invented to-dos tombstoned, ' + (mine.length + 1) + ' devices revoked');
    } catch (e) { console.log('cleanup failed: ' + e.message); }
  }
  for (const p of procs) { try { p.kill(); } catch {} }
  if (srv) srv.kill();
  await sleep(500);
}
console.log((fails ? fails + ' FAILED' : 'all passed') + '  (screenshots: ' + work + ')');
process.exit(fails ? 1 : 0);
