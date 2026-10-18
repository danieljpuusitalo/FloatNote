// Hand-check: the browser copy of the app on a computer, a wide window and a
// mouse (the phone check covers touch at 390px, the other checks the Electron
// window). Local dev server, headless Edge at 1440x900, invented items typed
// through capture, every click a real mouse event.
//   node tools/check-browser.mjs        (needs: cd server && npm install, and Edge)
// Screenshots go to the scratch dir it prints.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = 1440, H = 900, PORT = 8799, URL_ = 'http://127.0.0.1:' + PORT;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const work = mkdtempSync(join(tmpdir(), 'fn-browser-'));
console.log('scratch: ' + work);

const srv = spawn(process.execPath, [repo + '/server/dev-server.mjs', String(PORT), join(work, 'server.sqlite')],
  { env: { ...process.env, SETUP_KEY: 'invented-' + randomBytes(12).toString('hex') }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { await sleep(200); try { await fetch(URL_ + '/api/sync'); break; } catch {} }
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9373', '--user-data-dir=' + join(work, 'edge'),
  '--no-first-run', '--no-default-browser-check', '--window-size=' + W + ',' + H, 'about:blank'], { stdio: 'ignore' });
let t;
for (let i = 0; i < 40 && !t; i++) { await sleep(500); try { t = (await (await fetch('http://127.0.0.1:9373/json')).json()).find(x => x.type === 'page'); } catch {} }
if (!t) throw new Error('no Edge page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id) pend.get(m.id)?.(m);
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('evaluate: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(work, name + '.png'), Buffer.from(r.result.data, 'base64')); };
// A real press: move, down, a human pause, up. The pause matters: an edit's blur
// runs on the press, and anything it rebuilds before the release eats the click.
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(90);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(200);
};
const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right }; })()`);
const clickOn = async sel => { const b = await box(sel); if (!b) throw new Error('not on the page: ' + sel); await click(b.x, b.y); };

let fails = 0;
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails++; };

await send('Page.navigate', { url: URL_ + '/' });
await sleep(2500);
check('a mouse browser is not taken for touch', await ev(`!matchMedia('(hover: none)').matches && document.documentElement.classList.contains('web')`), null);
await ev(`document.getElementById('onboard-name').value = 'Tester'`);
await clickOn('#onboard-go');
await sleep(500);
await ev(`(() => { state.meta.lastPick = FNCore.dateStr(Date.now()); document.querySelectorAll('.pick-overlay').forEach(o => o.classList.add('hidden')); })()`);
for (const s of ['Invented alpha !', 'Invented bravo fri', 'Invented charlie, a longer line to see how it wraps in the column', 'Invented delta @Mo ~', 'Invented echo #p']) {
  await ev(`(() => { const c = document.getElementById('capture-input'); c.focus(); c.value = ${JSON.stringify(s)};
    c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(150);
}
await ev(`document.activeElement.blur()`);
await sleep(300);
await shot('01-list');

// Layout: a column, not the full screen.
const body = await ev(`(() => { const r = document.body.getBoundingClientRect(); return { left: r.left, width: r.width }; })()`);
check('the app is a centred column', body.width <= 700 && Math.abs(body.left - (W - body.width) / 2) < 2, body);

const dueId = await ev(`Object.values(state.items).find(i => i.text === 'Invented bravo')?.id`);
const row = `.todo-item[data-id="${dueId}"]`;
check('capture parsed the invented due date', !!dueId && await ev(`!!state.items[${JSON.stringify(dueId)}].due`), dueId);

// The bug Daniel hit: click into the text (edit opens), then click the due badge.
await ev(`(() => { window.__picks = 0; const o = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function () { window.__picks++; try { return o.call(this); } catch (e) {} }; })()`);
await clickOn(row + ' .todo-text');
check('one click on the text opens the edit', await ev(`!!document.querySelector(${JSON.stringify(row + ' .todo-edit')})`), null);
await shot('02-editing');
await clickOn(row + ' .badge.due');
check('clicking the due badge while editing opens the date picker', await ev('window.__picks') === 1, await ev('window.__picks'));
check('and the edit closed, text intact', await ev(`!document.querySelector('.todo-edit') && document.querySelector(${JSON.stringify(row + ' .todo-text')})?.textContent === 'Invented bravo'`), null);

// The same for the row's own buttons: edit, then Later.
await clickOn(row + ' .todo-text');
const later = await box(row + ' .todo-actions [data-to="later"]');
check('the row buttons sit next to the text, inside the column', !!later && later.right <= body.left + body.width, later);
if (later) await click(later.x, later.y);
check('clicking Later while editing moves the item', await ev(`state.items[${JSON.stringify(dueId)}].list`) === 'later', await ev(`state.items[${JSON.stringify(dueId)}].list`));

// An edit that changes the text, closed by clicking another row's tick.
const echoId = await ev(`Object.values(state.items).find(i => i.text === 'Invented echo')?.id`);
const alphaId = await ev(`Object.values(state.items).find(i => i.text === 'Invented alpha')?.id`);
await clickOn(`.todo-item[data-id="${echoId}"] .todo-text`);
await ev(`(() => { const i = document.querySelector('.todo-edit'); i.value = 'Invented echo, edited'; })()`);
await clickOn(`.todo-item[data-id="${alphaId}"] input[data-act="tick"]`);
check('the edit is saved when a click elsewhere closes it', await ev(`state.items[${JSON.stringify(echoId)}].text`) === 'Invented echo, edited', await ev(`state.items[${JSON.stringify(echoId)}].text`));
check('and that click ticked the other item', await ev(`FNCore.isDone(state.items[${JSON.stringify(alphaId)}])`), null);
await sleep(300);
check('the list was rebuilt afterwards (no stray edit box)', await ev(`!document.querySelector('.todo-edit') && document.querySelectorAll('#todo-scroll .todo-item').length >= 4`), null);

// The other tabs and settings, for the screenshots.
await clickOn('.tab[data-tab="notes"]'); await sleep(300); await shot('03-notes');
await clickOn('.tab[data-tab="habits"]'); await sleep(300); await shot('04-habits');
await clickOn('.tab[data-tab="todo"]'); await sleep(200);
await clickOn('#btn-settings'); await sleep(300); await shot('05-settings');

check('no page exceptions', errs.length === 0, errs);
console.log(fails ? fails + ' FAILED' : 'all passed', ' (screenshots: ' + work + ')');
ws.close(); edge.kill(); srv.kill(); await sleep(300);
process.exit(fails ? 1 : 0);
