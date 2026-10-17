const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, globalShortcut, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const C = require('./core');
const { createSync, firebaseBackend } = require('./sync');

// FLOATNOTE_DATA_DIR runs a second, independent copy (sync testing, or a dry run
// against a copy of real data). It must be set before anything reads userData,
// and it also scopes the single-instance lock, so two copies can run side by side.
if (process.env.FLOATNOTE_DATA_DIR) {
  fs.mkdirSync(process.env.FLOATNOTE_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.FLOATNOTE_DATA_DIR);
}

const DATA_DIR = app.getPath('userData');
const DATA_PATH = path.join(DATA_DIR, 'floatnote-data.json');
const V1_BACKUP_PATH = path.join(DATA_DIR, 'floatnote-data.v1.json');
const CLOCK_PATH = path.join(DATA_DIR, 'floatnote-clock.json');
const WINDOW_PATH = path.join(DATA_DIR, 'floatnote-window.json');
const SYNC_PATH = path.join(DATA_DIR, 'floatnote-sync.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;
const SYNCED_WRITE_MS = 60 * 60 * 1000;
const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const INBOX_SEEN_PATH = path.join(DATA_DIR, 'inbox-seen.json');

// ---------- files ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return undefined; }
}

// Write to a temp file, then rename over the target, so a crash mid-write can
// never leave a half-written data file.
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse the rename while another process holds the file open.
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

// One copy of the data file per calendar day, the newest BACKUP_KEEP kept.
function dailyBackup() {
  if (!fs.existsSync(DATA_PATH)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, 'floatnote-data-' + C.dateStr(new Date()) + '.json');
  if (fs.existsSync(target)) return;
  fs.copyFileSync(DATA_PATH, target);
  const old = fs.readdirSync(BACKUP_DIR).filter(f => /^floatnote-data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

function newestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return undefined;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const data = readJson(path.join(BACKUP_DIR, f));
    if (data && !C.isV1(data)) return data;
  }
  return undefined;
}

// ---------- state ----------

let state = null;   // the last state the renderer saved (or the loaded one)
let clock = {};     // per-record timestamps, see core.stamp
let lastSync = null; // when sync last succeeded, kept in the clock file

function writeClock() {
  writeJsonAtomic(CLOCK_PATH, C.clockFile(clock, lastSync));
}

function loadState() {
  const exists = fs.existsSync(DATA_PATH);
  const file = C.parseClockFile(readJson(CLOCK_PATH));
  const plan = C.planLoad({
    data: readJson(DATA_PATH),
    exists,
    clock: file,
    v2Ran: fs.existsSync(CLOCK_PATH) || fs.existsSync(V1_BACKUP_PATH),
    backup: newestBackup
  });
  // Unreadable (or a v1 file back after v2 ran): keep the file for inspection.
  if (plan.keepCopy) fs.copyFileSync(DATA_PATH, path.join(DATA_DIR, 'floatnote-data.corrupt-' + Date.now() + '.json'));
  if (plan.source === 'migrate') {
    if (!fs.existsSync(V1_BACKUP_PATH)) fs.copyFileSync(DATA_PATH, V1_BACKUP_PATH);
    state = C.migrateV1(plan.raw, Date.now());
    writeJsonAtomic(DATA_PATH, state);
  } else {
    state = plan.raw === undefined ? C.emptyState() : C.normalizeState(plan.raw);
  }
  clock = file ? file.clock : {};
  lastSync = file ? file.lastSync : null;
  // A recovered state must not out-date or delete what other devices hold.
  if (plan.suspect) C.recoverClock(clock, C.toRecords(state));
  else C.stamp(clock, C.toRecords(state), Date.now());
  writeClock();
  return state;
}

let appliedLoginItem;
function applyLoginItem(prefs) {
  const want = !!(prefs && prefs.launchAtLogin);
  if (!app.isPackaged || appliedLoginItem === want) return;
  app.setLoginItemSettings({ openAtLogin: want });
  appliedLoginItem = want;
}

// seenSeq: the last remote patch the renderer had applied when it saved. Any
// patch after that is re-applied first, so a save already in flight when a
// remote change arrived cannot stamp the old value as newer and push it back.
// Only onto records the renderer left as they were before the patch: one it
// changed is a newer local edit, and this save stamps it.
function saveState(data, seenSeq) {
  state = C.normalizeState(data);
  if (typeof seenSeq === 'number') {
    unseen = unseen.filter(e => e.seq > seenSeq);
    for (const e of unseen) C.applyPatchIfUnchanged(state, e.patch, e.before);
  }
  dailyBackup();
  writeJsonAtomic(DATA_PATH, state);
  const changed = C.stamp(clock, C.toRecords(state), Date.now());
  if (changed.length) writeClock();
  if (sync) sync.push(changed);
  applyLoginItem(state.preferences);
  const wanted = state.preferences.hotkey || C.DEFAULT_PREFS.hotkey;
  if (wanted !== wantedHotkey && !hotkeyPaused) registerHotkey(wanted);
  return changed;
}

// ---------- sync ----------

let sync = null;
let patchSeq = 0;
let unseen = [];   // remote patches sent to the renderer, newer than its last save

function readPassphrase() {
  const c = readJson(SYNC_PATH);
  return c && typeof c.passphrase === 'string' ? c.passphrase.trim() : '';
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// What the settings screen shows. Never includes the passphrase itself.
function info() {
  return {
    sync: sync ? sync.status() : { mode: 'off' },
    configured: !!readPassphrase(),
    hotkey,
    wantedHotkey,
    packaged: app.isPackaged
  };
}

function setupSync() {
  sync = createSync({
    backend: firebaseBackend(),
    clock,
    getRecords: () => C.toRecords(state),
    onRemote: (patch) => {
      const before = C.recordHashes(state, Object.keys(patch));
      C.applyPatch(state, patch);
      writeJsonAtomic(DATA_PATH, state);
      writeClock();
      sendPatch(patch, before);
    },
    getLastSync: () => lastSync,
    onSynced: (t) => {
      // Not on every push: an hour is far inside the tombstone window.
      if (lastSync !== null && t - lastSync < SYNCED_WRITE_MS) return;
      lastSync = t;
      writeClock();
    },
    onStatus: () => send('info', info())
  });
  sync.start(readPassphrase());
  // A start that failed offline retries on its own; waking from sleep is the
  // likeliest moment the network is back.
  if (powerMonitor) powerMonitor.on('resume', () => sync.retryNow());
}

// Hand the renderer a change main made itself, the same way as a remote one:
// it applies the patch only to records it has not edited since.
function sendPatch(patch, before) {
  if (!Object.keys(patch).length) return;
  const seq = ++patchSeq;
  unseen.push({ seq, patch, before });
  send('remote-patch', patch, seq, before);
}

// ---------- inbox: suggestions dropped in by Claude ----------
//
// Any *.json in <data dir>/inbox is read, turned into suggested items or
// "looks done" hints (core.ingestInbox), and deleted. Writers write a .tmp and
// rename it, but a file caught mid-write is retried rather than rejected until
// it is INBOX_SETTLE_MS old. Every file leaves a line in inbox/processed.log;
// one that cannot be used moves to inbox/rejected/ with the reason beside it.
// inbox-seen.json remembers what was suggested, so a later sweep of the same
// mail does not bring back something already kept or dropped.

const INBOX_SETTLE_MS = 10000;
const INBOX_MAX_BYTES = 1024 * 1024;
const INBOX_LOG_MAX_BYTES = 512 * 1024;
let inboxTimer = null;
let inboxRetry = null;

function inboxLog(entry) {
  const file = path.join(INBOX_DIR, 'processed.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > INBOX_LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  } catch (err) { console.warn('FloatNote: inbox log', err.message); }
}

function rejectInboxFile(name, reason) {
  const dir = path.join(INBOX_DIR, 'rejected');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, Date.now() + '-' + name);
    fs.renameSync(path.join(INBOX_DIR, name), target);
    fs.writeFileSync(target + '.why.txt', reason + '\n');
  } catch (err) { console.warn('FloatNote: inbox reject', err.message); }
  inboxLog({ file: name, rejected: reason });
}

function processInbox() {
  if (!state) return;
  let names;
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    names = fs.readdirSync(INBOX_DIR).filter(f => /\.json$/i.test(f)).sort();
  } catch (err) { return; }
  if (!names.length) return;

  const seen = C.pruneSeen(readJson(INBOX_SEEN_PATH) || {}, Date.now());
  const before = C.recordHashes(state, Object.keys(C.toRecords(state)));
  const added = [];
  const direct = [];
  const hinted = [];
  let retry = false;
  for (const name of names) {
    const file = path.join(INBOX_DIR, name);
    let stat, payload;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > INBOX_MAX_BYTES) { rejectInboxFile(name, 'larger than 1 MB'); continue; }
    try {
      // PowerShell writes a byte-order mark; JSON.parse does not accept one.
      payload = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''));
    } catch (err) {
      if (Date.now() - stat.mtimeMs < INBOX_SETTLE_MS) { retry = true; continue; }
      rejectInboxFile(name, 'not valid JSON: ' + err.message);
      continue;
    }
    const r = C.ingestInbox(state, payload, Date.now(), seen);
    added.push(...r.added);
    direct.push(...r.direct);
    hinted.push(...r.hinted);
    try { fs.unlinkSync(file); } catch (err) { console.warn('FloatNote: inbox delete', err.message); }
    inboxLog({ file: name, added: r.added.length, direct: r.direct.length, hinted: r.hinted.length, skipped: r.skipped });
  }
  writeJsonAtomic(INBOX_SEEN_PATH, seen);
  if (retry) { clearTimeout(inboxRetry); inboxRetry = setTimeout(processInbox, INBOX_SETTLE_MS + 500); }
  if (!added.length && !hinted.length) return;

  const records = C.toRecords(state);
  const patch = {};
  const was = {};
  for (const id of new Set([...added, ...hinted])) {
    const p = 'items/' + id;
    patch[p] = records[p];
    if (p in before) was[p] = before[p];
  }
  dailyBackup();
  writeJsonAtomic(DATA_PATH, state);
  const changed = C.stamp(clock, records, Date.now());
  if (changed.length) writeClock();
  if (sync) sync.push(changed);
  sendPatch(patch, was);
  send('inbox', { added: added.length, direct: direct.length, hinted: hinted.length });
}

function scheduleInbox() {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(processInbox, 300);
}

// fs.watch is the fast path; the poll covers the cases it misses (it can stop
// firing after sleep, and is not guaranteed on every filesystem).
function watchInbox() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  try {
    fs.watch(INBOX_DIR, (_type, name) => { if (!name || /\.json$/i.test(name)) scheduleInbox(); })
      .on('error', err => console.warn('FloatNote: inbox watch', err.message));
  } catch (err) { console.warn('FloatNote: inbox watch', err.message); }
  setInterval(processInbox, 60000);
}

// ---------- window ----------

let mainWindow = null;
let tray = null;
let quitting = false;

function savedBounds() {
  const b = readJson(WINDOW_PATH);
  if (!b || typeof b.x !== 'number' || typeof b.width !== 'number') return null;
  // Only reuse the position if it is still on a connected display.
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
  });
  return visible ? b : { width: b.width, height: b.height };
}

let boundsTimer = null;
let compactFrom = null; // full-size bounds while the window is shrunk to Today
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      // In compact mode keep the full size on disk, so leaving compact (or a
      // restart) gets the real window back. Only the position follows.
      if (compactFrom) { b.width = compactFrom.width; b.height = compactFrom.height; }
      writeJsonAtomic(WINDOW_PATH, b);
    }
  }, 500);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const b = savedBounds() || {};
  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width || 460,
    height: b.height || 650,
    minWidth: 300,
    minHeight: 120,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: true,
    show: false,
    backgroundColor: '#0f0f1a',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  lockNavigation(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('moved', rememberBounds);
  mainWindow.on('resized', rememberBounds);

  // Closing hides to the tray; quitting is explicit (tray menu).
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// Links (a to-do's source) open in the browser, never inside FloatNote.
function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------- hotkey capture ----------
//
// A one-line popup from anywhere. It is index.html#capture in a second,
// pre-created window, so it opens instantly. Enter hands the text to the main
// window, which owns the state and does the adding; the popup never saves.

let captureWin = null;
let hotkey = null;

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    width: 560,
    height: 92,
    useContentSize: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  captureWin.loadFile('index.html', { hash: 'capture' });
  lockNavigation(captureWin);
  captureWin.on('blur', () => captureWin.hide());
  captureWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      captureWin.hide();
    }
  });
}

function toggleCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCaptureWindow();
  if (captureWin.isVisible()) return captureWin.hide();
  // Centre on whichever screen the mouse is on, a little above the middle.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = captureWin.getSize();
  captureWin.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height * 0.28));
  captureWin.show();
  captureWin.focus();
  captureWin.webContents.send('capture-show');
}

// Another app can already own the wanted key (the Claude desktop app holds
// Ctrl+Alt+Space). Rather than have no capture key, fall back, and say in the
// tray which key is live.
const HOTKEY_FALLBACKS = ['Ctrl+Alt+N', 'Ctrl+Shift+Alt+Space'];

let wantedHotkey = null;
let hotkeyPaused = false;   // while the settings screen records a new key

function registerHotkey(wanted) {
  if (hotkey) globalShortcut.unregister(hotkey);
  hotkey = null;
  wantedHotkey = wanted;
  for (const accel of [wanted, ...HOTKEY_FALLBACKS.filter(k => k !== wanted)]) {
    let ok = false;
    try { ok = globalShortcut.register(accel, toggleCapture); } catch (e) { ok = false; }
    if (ok) { hotkey = accel; break; }
  }
  if (hotkey !== wanted) console.warn('FloatNote: hotkey ' + wanted + ' is taken; using ' + (hotkey || 'none'));
  updateTray();
  send('info', info());
  return hotkey;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(hotkey ? 'FloatNote (capture: ' + hotkey + ')' : 'FloatNote (no capture hotkey available)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show FloatNote', click: showWindow },
    { label: 'Quick capture', accelerator: hotkey || undefined, registerAccelerator: false, click: toggleCapture },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'build', 'icon.ico'));
  updateTray();
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showWindow();
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    loadState();
    applyLoginItem(state.preferences);
    createWindow();
    createTray();
    createCaptureWindow();
    registerHotkey(state.preferences.hotkey || C.DEFAULT_PREFS.hotkey);
    setupSync();
    watchInbox();
    // Anything that arrived while FloatNote was closed: wait for the window, so
    // the "Claude suggested" note has somewhere to show.
    mainWindow.webContents.once('did-finish-load', () => setTimeout(processInbox, 1500));
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // The tray keeps the app alive with no windows open.
  app.on('window-all-closed', () => {});

  // The renderer debounces saves by 300ms. Before quitting, ask it to flush the
  // pending one, and wait for it (bounded, so a hung renderer cannot block quit).
  let flushed = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (flushed || !mainWindow || mainWindow.isDestroyed()) return;
    e.preventDefault();
    const done = () => {
      if (flushed) return;
      flushed = true;
      app.quit();
    };
    ipcMain.once('flushed', done);
    setTimeout(done, 1500);
    mainWindow.webContents.send('flush');
  });
}

// ---------- IPC ----------

ipcMain.handle('load-data', (event) => {
  // The main window starts from current state, so no earlier patch is unseen.
  if (mainWindow && event.sender === mainWindow.webContents) unseen = [];
  return state || loadState();
});
ipcMain.handle('save-data', (_event, data, seenSeq) => { saveState(data, seenSeq); });
ipcMain.handle('get-info', () => info());

// Firebase keys cannot hold . # $ [ ] /, and the passphrase is part of the key.
// It is also the only thing between the data and anyone who guesses it.
ipcMain.handle('set-passphrase', (_event, raw) => {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (p && p.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
  if (/[.#$\[\]\/]/.test(p)) return { ok: false, error: 'The characters . # $ [ ] / are not allowed.' };
  writeJsonAtomic(SYNC_PATH, { passphrase: p });
  if (sync) sync.start(p);
  send('info', info());
  return { ok: true };
});

ipcMain.on('pause-hotkey', (_e, on) => {
  hotkeyPaused = !!on;
  if (hotkeyPaused) { if (hotkey) globalShortcut.unregister(hotkey); hotkey = null; updateTray(); send('info', info()); }
  else registerHotkey((state && state.preferences.hotkey) || C.DEFAULT_PREFS.hotkey);
});
ipcMain.on('minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('close', () => mainWindow && mainWindow.hide());
ipcMain.on('quit', () => app.quit());

ipcMain.on('capture-submit', (_e, raw) => {
  if (typeof raw === 'string' && raw.trim() && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('captured', raw.slice(0, 2000));
  }
  if (captureWin && !captureWin.isDestroyed()) captureWin.hide();
});
ipcMain.on('capture-hide', () => captureWin && !captureWin.isDestroyed() && captureWin.hide());

// Compact mode: shrink to the height of the Today list, and restore the full
// size on the way out. The renderer reports the height it needs.
ipcMain.on('set-compact', (_e, on, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  if (on) {
    if (!compactFrom) compactFrom = b;
    const h = Math.max(60, Math.min(Math.round(Number(height) || 0), compactFrom.height));
    mainWindow.setMinimumSize(200, 60);
    mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  } else if (compactFrom) {
    mainWindow.setMinimumSize(300, 120);
    mainWindow.setBounds({ x: b.x, y: b.y, width: compactFrom.width, height: compactFrom.height });
    compactFrom = null;
    rememberBounds();
  }
});
