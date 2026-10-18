// Hand-check: the phone's copy of the app, by touch, at 390px. A real desktop
// window (Electron, scratch data, invented items and notes) syncs through the
// local dev server; a headless Edge tab emulating a touch phone loads the page the
// server builds, pairs through Settings with the setup key, and works the list by
// tapping. Every tap lands on the element it aims at or the check fails.
//   node tools/check-phone.mjs        (needs: cd server && npm install, and Edge)
// Against a deployed Worker instead of the local server: set FLOATNOTE_CHECK_URL
// and FLOATNOTE_SETUP_KEY (read from a file, never typed into a command line).
// Screenshots go to the scratch dir it prints.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const C = createRequire(import.meta.url)(repo + '/core.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REMOTE = process.env.FLOATNOTE_CHECK_URL;
const PORT = 8798, URL_ = REMOTE ? REMOTE.replace(/\/$/, '') : 'http://127.0.0.1:' + PORT;
const KEY = REMOTE ? process.env.FLOATNOTE_SETUP_KEY : 'invented-' + randomBytes(12).toString('hex');
if (REMOTE && !KEY) throw new Error('FLOATNOTE_CHECK_URL needs FLOATNOTE_SETUP_KEY');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const work = mkdtempSync(join(tmpdir(), 'fn-phone-'));
console.log('scratch: ' + work);

const srv = REMOTE ? null : spawn(process.execPath, [repo + '/server/dev-server.mjs', String(PORT), join(work, 'server.sqlite')], { env: { ...process.env, SETUP_KEY: KEY }, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(150); try { await fetch(URL_ + '/api/sync'); break; } catch {} }
console.log('server: ' + URL_);

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  return { ws, send, ev, errs };
}
async function target(port, pick) {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(pick); if (t) return t; } catch {}
  }
  throw new Error('no page target on ' + port);
}

let fails = 0;
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails++; };
async function until(fn, ms = 8000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; }
const records = p => p.ev(`FNCore.stableStringify(FNCore.toRecords(state))`);
const idOf = (p, text) => p.ev(`Object.values(state.items).find(i => i.text === ${JSON.stringify(text)})?.id`);
const item = (p, id) => p.ev(`state.items[${JSON.stringify(id)}] || null`);

// ---------- the desktop: Electron on invented scratch data ----------
const T0 = Date.now();
const desk = C.emptyState();
desk.meta.lastPick = C.dateStr(T0);
desk.preferences = Object.assign(desk.preferences || {}, { name: 'Tester', onboarded: true });
const TEXTS = ['Invented alpha', 'Invented bravo', 'Invented charlie', 'Invented delta'];
TEXTS.forEach((text, i) => { const it = C.makeItem({ text, list: i === 0 ? 'today' : 'next', ctx: 'work' }, T0 + i); desk.items[it.id] = it; });
desk.notes.professional = '<div>Invented desktop note, must survive the phone joining</div>';
const deskDir = join(work, 'desktop');
execFileSync(process.execPath, [repo + '/tools/pair-device.mjs', URL_, 'Invented desktop'], { env: { ...process.env, FLOATNOTE_SETUP_KEY: KEY, FLOATNOTE_DATA_DIR: deskDir } });
writeFileSync(join(deskDir, 'floatnote-data.json'), JSON.stringify(desk));
// A clock, as a desktop that has synced before has: its records are newer than
// anything an earlier run left on a deployed server. (A device with no clock is
// the t 0 case, covered in test/server.test.js.)
const deskClock = {};
C.stamp(deskClock, C.toRecords(desk), T0);
writeFileSync(join(deskDir, 'floatnote-clock.json'), JSON.stringify(C.clockFile(deskClock, null)));
const electron = spawn(repo + '/node_modules/electron/dist/electron.exe', [repo, '--remote-debugging-port=9371'],
  { env: { ...process.env, FLOATNOTE_DATA_DIR: deskDir, FLOATNOTE_SYNC: 'server' }, stdio: 'ignore' });
const D = await cdp((await target(9371, t => t.type === 'page' && !t.url.includes('#capture'))).webSocketDebuggerUrl);
check('desktop syncs to the server', await until(() => D.ev(`window.api.getInfo().then(i => i.sync.mode === 'on')`)), null);
// A deployed server keeps what earlier runs left. Every test text starts with
// "Invented"; drop those this run did not bring, and the habits, so the counts hold.
const tidy = keep => D.ev(`(() => {
  const keep = new Set(${JSON.stringify(keep)});
  let n = 0;
  for (const i of Object.values(state.items)) if (/^Invented/.test(i.text) && !keep.has(i.id)) { delete state.items[i.id]; n++; }
  const gone = new Set(state.habits.filter(h => /^Invented/.test(h.name)).map(h => h.id));
  state.habits = state.habits.filter(h => !gone.has(h.id));
  for (const k of Object.keys(state.habitLog)) if ([...gone].some(id => k.includes(id))) { delete state.habitLog[k]; n++; }
  if (n || gone.size) changed();
  return n + gone.size;
})()`);
if (REMOTE) { await sleep(1500); console.log('cleared from earlier runs: ' + await tidy(Object.keys(desk.items))); await sleep(2000); }

console.log('--- the desktop page is unchanged');
check('desktop: no web class, hover is available, TOUCH off',
  await D.ev(`!document.documentElement.classList.contains('web') && matchMedia('(hover: hover)').matches && TOUCH === false`), null);
check('desktop: the Due button is hidden (key d stays the way)', await D.ev(`[...document.querySelectorAll('.due-btn')].every(e => getComputedStyle(e).display === 'none')`), null);
const deskRow = await D.ev(`(() => { const r = document.querySelector('.todo-item .todo-text').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
await D.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deskRow.x, y: deskRow.y });
await sleep(150);
check('desktop: hovering a row shows its actions', await D.ev(`getComputedStyle(document.querySelector('.todo-item:hover .todo-actions')).display !== 'none'`), null);
await D.ev(`openSettings()`);
await sleep(200);
check('desktop: settings keep the hotkey, login and keyboard sections', await D.ev(`[...document.querySelectorAll('.desk-only')].length >= 3 && [...document.querySelectorAll('.desk-only')].every(e => getComputedStyle(e).display !== 'none')`), null);
check('desktop: sync passphrase box still shown', await D.ev(`getComputedStyle(document.getElementById('sync-pass').parentElement).display !== 'none'`), null);
await D.ev(`closeSettings()`);
const deskBefore = await records(D);

// ---------- the phone: headless Edge, 390px, touch ----------
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9372', '--user-data-dir=' + join(work, 'edge'), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const P = await cdp((await target(9372, t => t.type === 'page')).webSocketDebuggerUrl);
await P.send('Page.enable');
await P.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await P.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const load = async (path) => { await P.send('Page.navigate', { url: URL_ + path }); await until(() => P.ev(`document.readyState === 'complete' && !!window.api`)); await sleep(600); };
let shot = 0;
const snap = async (name) => { const r = await P.send('Page.captureScreenshot', { format: 'png' }); const f = join(work, String(++shot).padStart(2, '0') + '-' + name + '.png'); writeFileSync(f, Buffer.from(r.result.data, 'base64')); };

// Every tap: scroll it into view, check nothing covers it, then a real touch.
async function tap(sel) {
  const r = await P.ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return { missing: true };
    e.scrollIntoView({ block: 'center' });
    const b = e.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: b.width, h: b.height, hit: !!hit && (hit === e || e.contains(hit)), on: hit ? hit.tagName + '.' + hit.className : null };
  })()`);
  if (r.missing) throw new Error('tap: no ' + sel);
  if (!r.hit) { check('tap reaches ' + sel, false, r.on); return r; }
  await P.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await P.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  return r;
}
const row = id => `.todo-item[data-id="${id}"]`;
const shown = sel => P.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; })()`);

await load('/');
console.log('--- phone, before pairing');
check('phone: web class, (hover: none), TOUCH on', await P.ev(`document.documentElement.classList.contains('web') && matchMedia('(hover: none)').matches && TOUCH === true`), null);
check('phone: viewport is 390 wide and nothing scrolls sideways', await P.ev(`innerWidth === 390 && document.documentElement.scrollWidth <= 390`), await P.ev(`[innerWidth, document.documentElement.scrollWidth]`));
check('phone: no titlebar', !(await shown('.titlebar')), null);
check('phone: the service worker registers', await until(() => P.ev(`navigator.serviceWorker.getRegistration().then(r => !!r)`), 5000), null);
await snap('first-open');
if (await shown('#onboarding')) {
  await tap('#onboard-name');
  await P.send('Input.insertText', { text: 'Invented phone' });
  await tap('#onboard-go');
  check('phone: onboarding closes', !(await shown('#onboarding')), null);
}
check('phone: holds none of the desktop items yet', (await P.ev(`Object.keys(state.items).length`)) === 0, null);

console.log('--- phone pairs through Settings');
await tap('#btn-settings');
await snap('settings-unpaired');
check('phone: settings ask for the setup key', await P.ev(`document.getElementById('sync-pass').placeholder === 'Setup key' && document.getElementById('sync-save').textContent === 'Pair'`),
  await P.ev(`[document.getElementById('sync-pass').placeholder, document.getElementById('sync-save').textContent]`));
check('phone: the sync line says nothing leaves the device', /Nothing leaves this device/.test(await P.ev(`document.getElementById('sync-status').textContent`)), await P.ev(`document.getElementById('sync-status').textContent`));
check('phone: hotkey, login and keyboard sections hidden', await P.ev(`[...document.querySelectorAll('.desk-only')].every(e => getComputedStyle(e).display === 'none')`), null);
check('phone: the settings box fits the screen', await P.ev(`(() => { const b = document.querySelector('#settings-overlay .settings-card').getBoundingClientRect(); return b.left >= 0 && b.right <= 390; })()`), null);
await tap('#sync-pass');
await P.send('Input.insertText', { text: KEY });
await tap('#sync-save');
check('phone: pairs and syncs', await until(() => P.ev(`window.api.getInfo().then(i => i.sync.mode === 'on')`), 10000), await P.ev(`window.api.getInfo().then(i => i.sync)`));
check('phone: receives the desktop items', await until(async () => (await P.ev(`Object.values(state.items).map(i => i.text).sort().join('|')`)) === TEXTS.join('|')), await P.ev(`Object.values(state.items).map(i => i.text)`));
check('phone: settings now read paired, key box gone', await until(() => P.ev(`/Paired with/.test(document.getElementById('sync-note').textContent) && getComputedStyle(document.getElementById('sync-pass').parentElement).display === 'none' && document.getElementById('sync-off').textContent === 'Unpair this device'`)),
  await P.ev(`[document.getElementById('sync-note').textContent, document.getElementById('sync-off').textContent]`));
check('phone: the key is not kept in storage', !(await P.ev(`new Promise(r => { const q = indexedDB.open('floatnote'); q.onsuccess = () => { const db = q.result; const st = db.transaction(db.objectStoreNames[0]).objectStore(db.objectStoreNames[0]); const all = st.getAll(); all.onsuccess = () => r(JSON.stringify(all.result).includes(${JSON.stringify(KEY)})); }; })`)), null);
await snap('settings-paired');

console.log('--- negative control: a fresh phone joining changes nothing on the desktop');
await sleep(3000);
check('desktop records byte-identical after the phone joined', (await records(D)) === deskBefore, null);
check('desktop note intact', await D.ev(`/must survive the phone joining/.test(state.notes.professional)`), await D.ev(`state.notes.professional`));
const recDiff = async () => {
  const d = JSON.parse(await records(D)), p = JSON.parse(await records(P));
  return [...new Set([...Object.keys(d), ...Object.keys(p)])].filter(k => JSON.stringify(d[k]) !== JSON.stringify(p[k]))
    .map(k => k + ' desktop=' + JSON.stringify(d[k]).slice(0, 80) + ' phone=' + JSON.stringify(p[k]).slice(0, 80));
};
check('phone holds the same records as the desktop', (await records(P)) === deskBefore, await recDiff());
await tap('#settings-close');

console.log('--- the list by touch');
const [idA, idB, idC, idD] = await Promise.all(TEXTS.map(t => idOf(P, t)));
await snap('list');
await tap(row(idB) + ' .todo-text');
check('first tap selects the row and shows its actions', await P.ev(`document.querySelector(${JSON.stringify(row(idB))}).classList.contains('sel')`) && await shown(row(idB) + ' .todo-actions'), null);
check('first tap does not start an edit', !(await P.ev(`!!document.querySelector('.todo-edit')`)), null);
check('the action buttons fit inside the screen', await P.ev(`[...document.querySelectorAll(${JSON.stringify(row(idB) + ' .todo-actions .act')})].every(b => { const r = b.getBoundingClientRect(); return r.right <= 390 && r.height >= 28; })`),
  await P.ev(`[...document.querySelectorAll(${JSON.stringify(row(idB) + ' .todo-actions .act')})].map(b => { const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.right), Math.round(r.height)]; })`));
await snap('row-selected');
await tap(row(idB) + ' .todo-text');
check('second tap on the text edits it', await P.ev(`document.activeElement && document.activeElement.className === 'todo-edit'`), null);
await P.ev(`document.activeElement.select()`);
await P.send('Input.insertText', { text: 'Invented bravo, edited on the phone' });
await P.ev(`document.activeElement.blur()`);
check('the edit saves and reaches the desktop', await until(async () => (await item(D, idB))?.text === 'Invented bravo, edited on the phone'), await item(D, idB));

// Wait and Later are offered from Next only, as on the desktop.
for (const [to, label] of [['waiting', 'Wait'], ['next', 'Next'], ['later', 'Later'], ['next', 'Next'], ['today', 'Today']]) {
  if (!(await shown(row(idC)))) await tap('[data-act="toggle-later"]');
  if (!(await P.ev(`document.querySelector(${JSON.stringify(row(idC))}).classList.contains('sel')`))) await tap(row(idC) + ' .todo-text');
  await tap(row(idC) + ` [data-act="move"][data-to="${to}"]`);
  check(`${label} moves it, and the desktop sees it`, await until(async () => (await item(D, idC))?.list === to), [await P.ev(`state.items[${JSON.stringify(idC)}].list`), (await item(D, idC))?.list]);
}

if (!(await P.ev(`document.querySelector(${JSON.stringify(row(idD))}).classList.contains('sel')`))) await tap(row(idD) + ' .todo-text');
check('the Due button shows on touch, with the date input over it', await P.ev(`(() => { const b = document.querySelector(${JSON.stringify(row(idD) + ' .due-btn')}); const i = b && b.querySelector('input[type=date]'); if (!b || !i || getComputedStyle(b).display === 'none') return false; const r1 = b.getBoundingClientRect(), r2 = i.getBoundingClientRect(); return Math.abs(r1.width - r2.width) < 1 && Math.abs(r1.height - r2.height) < 1; })()`), null);
const r = await tap(row(idD) + ' .due-btn input');
check('a tap on Due lands on the date input', r.hit, r.on);
// Headless has no date picker to drive: set what the picker would and send its change.
await P.ev(`(() => { const i = document.querySelector(${JSON.stringify(row(idD) + ' .due-btn input')}); i.value = '2030-01-15'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
check('the chosen date saves and reaches the desktop', await until(async () => (await item(D, idD))?.due === '2030-01-15'), await item(D, idD));
await snap('due-set');

await tap(row(idA) + ' input[type=checkbox]');
check('tick saves and reaches the desktop', await until(async () => !!(await item(D, idA))?.doneAt), await item(D, idA));
if (!(await P.ev(`document.querySelector(${JSON.stringify(row(idD))}).classList.contains('sel')`))) await tap(row(idD) + ' .todo-text');
await tap(row(idD) + ' [data-act="drop"]');
check('drop removes it, and the desktop sees it', await until(async () => { const it = await item(D, idD); return !it || !!it.droppedAt || !!it.doneAt; }), await item(D, idD));

console.log('--- capture and share');
await tap('#capture-input');
await P.send('Input.insertText', { text: 'Invented typed on the phone' });
await P.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await P.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
check('capture from the phone reaches the desktop', !!(await until(() => idOf(D, 'Invented typed on the phone'))), null);
check('capture input is at least 16px (no iOS zoom)', (await P.ev(`parseFloat(getComputedStyle(document.getElementById('capture-input')).fontSize)`)) >= 16, await P.ev(`getComputedStyle(document.getElementById('capture-input')).fontSize`));
await load('/?text=' + encodeURIComponent('Invented shared from another app'));
check('a shared text lands in the capture box to check, not on a list', await until(() => P.ev(`document.getElementById('capture-input').value === 'Invented shared from another app'`)) && !(await idOf(P, 'Invented shared from another app')), await P.ev(`document.getElementById('capture-input').value`));
check('the query is cleared, so a reload does not share it twice', await P.ev(`location.search === ''`), await P.ev(`location.href`));
await snap('shared');

console.log('--- notes and habits');
await tap('.tab[data-tab="notes"]');
check('phone: the desktop note is there', await P.ev(`/must survive the phone joining/.test(document.getElementById('notes-editor').innerHTML)`), null);
await P.ev(`document.getElementById('notes-editor').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }))`);
check('phone: no custom notes menu on a long press (the phone keeps its own)', !(await shown('#notes-context-menu')) || !(await P.ev(`document.getElementById('notes-context-menu').classList.contains('show')`)), null);
await snap('notes');
await tap('.tab[data-tab="habits"]');
await tap('#habit-tab-manage');
const freq = await P.ev(`[...document.getElementById('habit-freq-select').options].map(o => o.value).find(v => v !== 'daily' && v !== '7')`);
await P.ev(`document.getElementById('habit-freq-select').value = ${JSON.stringify(freq)}`);
await tap('#habit-name-input');
await P.send('Input.insertText', { text: 'Invented habit' });
await P.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await P.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await tap('#habit-tab-tracker');
const habitId = await P.ev(`state.habits.find(h => h.name === 'Invented habit')?.id`);
check('phone: a habit can be added (' + freq + ')', !!habitId, await P.ev(`state.habits`));
const sched = () => P.ev(`JSON.stringify([...document.querySelectorAll('.habit-cell[data-habit="${habitId}"]')].map(e => e.dataset.date))`);
const before = await sched();
if (await P.ev(`!!document.querySelector('.habit-drop-target[data-habit="${habitId}"]')`)) {
  await tap(`.habit-drop-target[data-habit="${habitId}"]`);
  check('a tap on an empty day moves a slot there', await until(async () => (await sched()) !== before), [before, await sched()]);
  check('the move reaches the desktop', await until(() => D.ev(`Object.keys(state.habitLog).some(k => k.startsWith('move:${habitId}:'))`)), null);
} else check('a movable habit shows empty days to tap', false, before);
check('habit grid fits the screen', await P.ev(`document.documentElement.scrollWidth <= 390`), await P.ev(`document.documentElement.scrollWidth`));
await snap('habits');

check('no page exceptions on the phone', P.errs.length === 0, P.errs);
check('no page exceptions on the desktop', D.errs.length === 0, D.errs);
if (REMOTE) { await tidy([]); await sleep(2500); }
console.log(fails ? fails + ' FAILED' : 'all passed');
for (const c of [D, P]) c.ws.close();
electron.kill(); edge.kill(); srv?.kill();
await sleep(800);
process.exit(fails ? 1 : 0);
