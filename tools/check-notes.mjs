// Hand-check: the Notes editor's formatting (Ctrl+L, Ctrl+Shift+L, Ctrl+H, the
// right-click menu, the markdown shortcuts) in a real window on scratch data with
// invented text, driven over CDP with real key events.
//   node tools/check-notes.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const C = createRequire(import.meta.url)(repo + '/core.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'fn-notes-'));
const s = C.emptyState();
s.meta.lastPick = C.dateStr(Date.now());
s.preferences = Object.assign(s.preferences || {}, { name: 'Tester', onboarded: true });
writeFileSync(join(dir, 'floatnote-data.json'), JSON.stringify(s));

const port = 9371;
const child = spawn(repo + '/node_modules/electron/dist/electron.exe', [repo, '--remote-debugging-port=' + port],
  { env: { ...process.env, FLOATNOTE_DATA_DIR: dir }, stdio: 'ignore' });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page' && !t.url.includes('#capture')); } catch {} }
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) pend.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails); });
const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable', {});
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const key = async (k, code, vk, mods) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(80);
};
const CTRL = 2, SHIFT = 8;
let fails = 0;
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails++; };

await sleep(1500);
await ev(`document.querySelector('.tab[data-tab="notes"]').click()`);
await sleep(300);
// Lines: 0 plain, 1 plain, 2 heading, 3 plain
const setDoc = html => ev(`(() => { const ed = document.getElementById('notes-editor'); ed.innerHTML = ${JSON.stringify(html)}; ed.focus(); })()`);
const select = (a, b) => ev(`(() => { const ed = document.getElementById('notes-editor'); const r = document.createRange();
  r.setStart(ed.children[${a}].firstChild || ed.children[${a}], 0); const e = ed.children[${b}]; r.setEnd(e.firstChild || e, 1);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
const caret = i => ev(`(() => { const ed = document.getElementById('notes-editor'); const r = document.createRange(); r.selectNodeContents(ed.children[${i}]); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
const shape = () => ev(`[...document.getElementById('notes-editor').children].map(c => c.className + ':' + c.textContent)`);

const BASE = '<div>Invented one</div><div>Invented two</div><div class="note-heading">Head<span class="section-delete" contenteditable="false">\u00d7</span></div><div>Invented three</div>';

// Ctrl+L over lines 0..2: two bullets, heading untouched
await setDoc(BASE); await select(0, 2); await key('l', 'KeyL', 76, CTRL);
let sh = await shape();
check('Ctrl+L bullets the selected lines, skips the heading', sh[0] === 'note-bullet:Invented one' && sh[1] === 'note-bullet:Invented two' && sh[2].startsWith('note-heading:') && sh[3] === ':Invented three', sh);
check('Ctrl+L saved into state.notes', (await ev(`state.notes[activeNotesCategory]`)).includes('note-bullet'), null);
await select(0, 1); await key('l', 'KeyL', 76, CTRL);
sh = await shape();
check('Ctrl+L again on all-bullets unbullets', sh[0] === ':Invented one' && sh[1] === ':Invented two', sh);

// Ctrl+Shift+L on line 3
await setDoc(BASE); await caret(3); await key('L', 'KeyL', 76, CTRL | SHIFT);
sh = await shape();
const inSpan = await ev(`!!getSelection().anchorNode && !!(getSelection().anchorNode.nodeType === 3 ? getSelection().anchorNode.parentElement : getSelection().anchorNode).closest('.check-text')`);
check('Ctrl+Shift+L makes a checklist line', sh[3] === 'note-checklist:Invented three' && await ev(`!!document.querySelector('#notes-editor .note-checklist > input.check-box + span.check-text')`), sh);
check('caret lands in the checklist text', inSpan, null);
await key('L', 'KeyL', 76, CTRL | SHIFT);
sh = await shape();
check('Ctrl+Shift+L again back to plain, text kept', sh[3] === ':Invented three', sh);
await caret(2); await key('L', 'KeyL', 76, CTRL | SHIFT);
sh = await shape();
check('Ctrl+Shift+L leaves a heading alone', sh[2].startsWith('note-heading:Head'), sh);

// Context menu
const menu = async action => {
  await ev(`document.getElementById('notes-editor').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 80 }))`);
  await ev(`document.querySelector('.notes-context-menu-item[data-action="${action}"]').click()`);
  await sleep(80);
};
await setDoc(BASE); await select(0, 1); await menu('bullet');
sh = await shape();
check('menu Bullet bullets the selection', sh[0] === 'note-bullet:Invented one' && sh[1] === 'note-bullet:Invented two', sh);
await caret(3); await menu('checklist');
sh = await shape();
check('menu Checklist makes a checklist line', sh[3] === 'note-checklist:Invented three', sh);
await caret(3); await menu('checklist');
sh = await shape();
check('menu Checklist again back to plain', sh[3] === ':Invented three', sh);
await caret(3); await menu('title');
sh = await shape();
check('menu Title makes a title with its delete button', sh[3] === 'note-title:Invented three\u00d7' && await ev(`!!document.querySelector('#notes-editor .note-title > .section-delete')`), sh);
await caret(1); await menu('numbered');
sh = await shape();
check('menu Numbered still works', sh[1] === 'note-numbered:Invented two', sh);

// Markdown shortcuts and Ctrl+H
await setDoc('<div><br></div>'); await caret(0);
await send('Input.insertText', { text: '## ' }); await sleep(100);
await send('Input.insertText', { text: 'Agenda' }); await sleep(100);
sh = await shape();
check('typing "## " makes a heading with its delete button', sh[0] === 'note-heading:Agenda\u00d7' || sh[0] === 'note-heading:\u00d7Agenda' || sh[0].startsWith('note-heading:'), sh);
await setDoc('<div><br></div>'); await caret(0);
await send('Input.insertText', { text: '[] ' }); await sleep(100);
await send('Input.insertText', { text: 'Buy invented milk' }); await sleep(100);
sh = await shape();
check('typing "[] " makes a checklist line, typing continues in it', sh[0] === 'note-checklist:Buy invented milk', sh);
await key('Enter', 'Enter', 13, 0);
sh = await shape();
check('Enter on a checklist line makes a fresh checklist line', sh.length === 2 && sh[1] === 'note-checklist:', sh);
await setDoc('<div>Invented heading text</div>');
await ev(`(() => { const t = document.getElementById('notes-editor').children[0].firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 8); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
await key('h', 'KeyH', 72, CTRL);
check('Ctrl+H makes a heading with its delete button', await ev(`!!document.querySelector('#notes-editor .note-heading > .section-delete') && document.querySelector('#notes-editor .note-heading').textContent === 'Invented\u00d7'`), await shape());

check('no page exceptions', errs.length === 0, errs.map(e => e.exception?.description || e.text));
console.log(fails ? fails + ' FAILED' : 'all passed', ' (scratch: ' + dir + ')');
ws.close(); child.kill(); await sleep(500);
process.exit(fails ? 1 : 0);
