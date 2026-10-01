const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const C = require('./core');

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
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;

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
    if (data) return data;
  }
  return undefined;
}

// ---------- state ----------

let state = null;   // the last state the renderer saved (or the loaded one)
let clock = {};     // per-record timestamps, see core.stamp

function loadState() {
  let raw = readJson(DATA_PATH);
  if (raw === undefined && fs.existsSync(DATA_PATH)) {
    // Unreadable: keep the broken file for inspection and fall back to a backup.
    fs.copyFileSync(DATA_PATH, path.join(DATA_DIR, 'floatnote-data.corrupt-' + Date.now() + '.json'));
    raw = newestBackup();
  }
  if (raw === undefined) {
    state = C.emptyState();
  } else if (C.isV1(raw)) {
    if (!fs.existsSync(V1_BACKUP_PATH) && fs.existsSync(DATA_PATH)) fs.copyFileSync(DATA_PATH, V1_BACKUP_PATH);
    state = C.migrateV1(raw, Date.now());
    writeJsonAtomic(DATA_PATH, state);
  } else {
    state = C.normalizeState(raw);
  }
  clock = readJson(CLOCK_PATH) || {};
  C.stamp(clock, C.toRecords(state), Date.now());
  writeJsonAtomic(CLOCK_PATH, clock);
  return state;
}

let appliedLoginItem;
function applyLoginItem(prefs) {
  const want = !!(prefs && prefs.launchAtLogin);
  if (!app.isPackaged || appliedLoginItem === want) return;
  app.setLoginItemSettings({ openAtLogin: want });
  appliedLoginItem = want;
}

function saveState(data) {
  state = C.normalizeState(data);
  dailyBackup();
  writeJsonAtomic(DATA_PATH, state);
  const changed = C.stamp(clock, C.toRecords(state), Date.now());
  if (changed.length) writeJsonAtomic(CLOCK_PATH, clock);
  applyLoginItem(state.preferences);
  return changed;
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

function registerHotkey(wanted) {
  if (hotkey) globalShortcut.unregister(hotkey);
  hotkey = null;
  for (const accel of [wanted, ...HOTKEY_FALLBACKS.filter(k => k !== wanted)]) {
    let ok = false;
    try { ok = globalShortcut.register(accel, toggleCapture); } catch (e) { ok = false; }
    if (ok) { hotkey = accel; break; }
  }
  if (hotkey !== wanted) console.warn('FloatNote: hotkey ' + wanted + ' is taken; using ' + (hotkey || 'none'));
  updateTray();
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

ipcMain.handle('load-data', () => state || loadState());
ipcMain.handle('save-data', (_event, data) => { saveState(data); });
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
