const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(app.getPath('userData'), 'floatnote-data.json');
const SYNC_CONFIG_PATH = path.join(app.getPath('userData'), 'floatnote-sync.json');

const DEFAULT_STATE = {
  notes: { professional: '', personal: '' },
  _notesLastEdit: { professional: 0, personal: 0 },
  checklist: { professional: [], personal: [] },
  _deletedChecklist: [],
  completionLog: [],
  preferences: null,
  habits: [],
  _deletedHabits: [],
  habitLog: {}
};

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    if (Array.isArray(data.checklist)) {
      return {
        notes: { professional: data.notes || '', personal: '' },
        checklist: { professional: data.checklist, personal: [] },
        completionLog: data.completionLog || []
      };
    }
    return { ...DEFAULT_STATE, ...data };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  pushToFirebase(data);
}

// --- Firebase Sync ---
const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { getDatabase, ref, set, onValue } = require('firebase/database');

const firebaseConfig = {
  apiKey: "AIzaSyC1GVm6VsEkMjTJ3Dm3ntMSEejtC_AdnPU",
  authDomain: "floatnote-app.firebaseapp.com",
  databaseURL: "https://floatnote-app-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "floatnote-app",
  storageBucket: "floatnote-app.firebasestorage.app",
  messagingSenderId: "212035028924",
  appId: "1:212035028924:web:3d4ff5da274a0758db0db9"
};

let firebaseApp = null;
let dbRef = null;
let isRemoteUpdate = false;
let lastPushedJson = '';

// --- Merge helpers ---
function itemKey(i) { return i.text + '|' + (i.addedAt || ''); }

function mergeChecklistArrays(local, remote, deletedKeys) {
  if (!local || !local.length) local = [];
  if (!remote || !remote.length) remote = [];
  const merged = [];
  const seen = new Set();
  // Process local items first
  local.forEach(item => {
    const key = itemKey(item);
    if (deletedKeys && deletedKeys.has(key)) return; // soft-deleted
    seen.add(key);
    merged.push({ ...item });
  });
  // Merge remote items
  remote.forEach(item => {
    const key = itemKey(item);
    if (deletedKeys && deletedKeys.has(key)) return; // soft-deleted
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ ...item });
    } else {
      // Merge done status using doneAt timestamp
      const idx = merged.findIndex(i => itemKey(i) === key);
      if (idx >= 0) {
        const localDoneAt = merged[idx].doneAt || 0;
        const remoteDoneAt = item.doneAt || 0;
        if (remoteDoneAt > localDoneAt) {
          merged[idx].done = item.done;
          merged[idx].doneAt = item.doneAt;
        }
        // Merge priority/deadline using updatedAt
        const localUpd = merged[idx].updatedAt || 0;
        const remoteUpd = item.updatedAt || 0;
        if (remoteUpd > localUpd) {
          merged[idx].priority = item.priority;
          merged[idx].deadline = item.deadline;
          merged[idx].updatedAt = item.updatedAt;
        }
      }
    }
  });
  return merged;
}

function mergeNote(local, remote, localTs, remoteTs) {
  if (!local && !remote) return '';
  if (!local) return remote;
  if (!remote) return local;
  // Use timestamps if available, fall back to keeping longer
  if (localTs && remoteTs) return remoteTs >= localTs ? remote : local;
  return remote.length >= local.length ? remote : local;
}

function mergeObjects(local, remote) {
  return { ...(local || {}), ...(remote || {}) };
}

function mergeHabits(local, remote, deletedIds) {
  if (!local || !local.length) local = [];
  if (!remote || !remote.length) remote = [];
  const merged = [];
  const seen = new Set();
  // Process local habits
  local.forEach(h => {
    if (deletedIds && deletedIds.has(h.id)) return;
    seen.add(h.id);
    merged.push({ ...h });
  });
  // Merge remote habits
  remote.forEach(h => {
    if (deletedIds && deletedIds.has(h.id)) return;
    if (!seen.has(h.id)) {
      seen.add(h.id);
      merged.push({ ...h });
    } else {
      // Update if remote is newer
      const idx = merged.findIndex(m => m.id === h.id);
      if (idx >= 0) {
        const localUpd = merged[idx].updatedAt || 0;
        const remoteUpd = h.updatedAt || 0;
        if (remoteUpd > localUpd) {
          merged[idx] = { ...h };
        }
      }
    }
  });
  return merged;
}

function mergeCompletionLog(local, remote) {
  if (!local || !local.length) return remote || [];
  if (!remote || !remote.length) return local || [];
  const merged = [...local];
  const keys = new Set(local.map(e => e.date + '|' + e.category));
  remote.forEach(e => {
    const key = e.date + '|' + e.category;
    if (!keys.has(key)) {
      merged.push(e);
      keys.add(key);
    }
  });
  return merged;
}

function mergePreferences(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local || null;
  return { ...local, ...remote };
}

function mergeState(local, remote) {
  const localNoteTs = local._notesLastEdit || {};
  const remoteNoteTs = remote._notesLastEdit || {};
  // Build deleted sets from both sides
  const deletedChecklist = new Set([
    ...(local._deletedChecklist || []),
    ...(remote._deletedChecklist || [])
  ]);
  const deletedHabits = new Set([
    ...(local._deletedHabits || []),
    ...(remote._deletedHabits || [])
  ]);

  return {
    notes: {
      professional: mergeNote(
        local.notes && local.notes.professional,
        remote.notes && remote.notes.professional,
        localNoteTs.professional, remoteNoteTs.professional),
      personal: mergeNote(
        local.notes && local.notes.personal,
        remote.notes && remote.notes.personal,
        localNoteTs.personal, remoteNoteTs.personal)
    },
    _notesLastEdit: {
      professional: Math.max(localNoteTs.professional || 0, remoteNoteTs.professional || 0),
      personal: Math.max(localNoteTs.personal || 0, remoteNoteTs.personal || 0)
    },
    checklist: {
      professional: mergeChecklistArrays(
        local.checklist && local.checklist.professional,
        remote.checklist && remote.checklist.professional,
        deletedChecklist),
      personal: mergeChecklistArrays(
        local.checklist && local.checklist.personal,
        remote.checklist && remote.checklist.personal,
        deletedChecklist)
    },
    _deletedChecklist: [...deletedChecklist],
    completionLog: mergeCompletionLog(local.completionLog, remote.completionLog),
    preferences: mergePreferences(local.preferences, remote.preferences),
    habits: mergeHabits(local.habits, remote.habits, deletedHabits),
    _deletedHabits: [...deletedHabits],
    habitLog: mergeObjects(local.habitLog, remote.habitLog),
    dashboardConfig: remote.dashboardConfig || local.dashboardConfig
  };
}

function loadSyncConfig() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSyncConfig(config) {
  fs.writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function initFirebaseSync() {
  const config = loadSyncConfig();
  if (!config.passphrase) return;

  try {
    firebaseApp = initializeApp(firebaseConfig);
    const auth = getAuth(firebaseApp);

    signInAnonymously(auth).then(() => {
      console.log('[FloatNote Sync] Signed in anonymously');
      const db = getDatabase(firebaseApp);
      dbRef = ref(db, 'sync/' + config.passphrase);

      let firstConnect = true;

      onValue(dbRef, (snapshot) => {
        const remote = snapshot.val();

        let localData = {};
        try { localData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')); } catch {}

        // First connect: always merge with remote (or push local if remote empty)
        if (firstConnect) {
          firstConnect = false;
          if (!remote || !remote._meta) {
            pushToFirebase(localData);
            return;
          }
          // Merge local with remote on first connect
          console.log('[FloatNote Sync] First connect — merging with remote');
          isRemoteUpdate = true;
          const merged = mergeState(localData, remote);
          const toSave = { ...merged, _meta: { lastModified: Date.now(), lastDevice: 'electron' } };
          fs.writeFileSync(DATA_PATH, JSON.stringify(toSave, null, 2));
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('remote-update', merged);
          }
          pushToFirebase(toSave);
          isRemoteUpdate = false;
          return;
        }

        if (!remote || !remote._meta) return;

        // Skip if this is our own push echoing back
        if (isRemoteUpdate) return;
        const remoteJson = JSON.stringify(remote);
        if (remoteJson === lastPushedJson) return;

        // Only apply if remote is from a different device
        if (remote._meta.lastDevice === 'electron') return;

        console.log('[FloatNote Sync] Merging remote state from', remote._meta.lastDevice);
        isRemoteUpdate = true;

        // Merge instead of replace
        const merged = mergeState(localData, remote);
        const toSave = { ...merged, _meta: { lastModified: Date.now(), lastDevice: 'electron' } };
        fs.writeFileSync(DATA_PATH, JSON.stringify(toSave, null, 2));

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('remote-update', merged);
        }
        isRemoteUpdate = false;
      });
    }).catch(err => {
      console.error('[FloatNote Sync] Auth error:', err);
    });
  } catch (err) {
    console.error('[FloatNote Sync] Init error:', err);
  }
}

function pushToFirebase(data) {
  if (!dbRef || isRemoteUpdate) return;

  const now = Date.now();
  const payload = {
    notes: data.notes || {},
    _notesLastEdit: data._notesLastEdit || {},
    checklist: data.checklist || {},
    _deletedChecklist: data._deletedChecklist || [],
    completionLog: data.completionLog || [],
    preferences: data.preferences || null,
    habits: data.habits || [],
    _deletedHabits: data._deletedHabits || [],
    habitLog: data.habitLog || {},
    dashboardConfig: data.dashboardConfig || null,
    _meta: {
      lastModified: now,
      lastDevice: 'electron'
    }
  };

  lastPushedJson = JSON.stringify(payload);

  const pushAttempt = (retries) => {
    set(dbRef, payload).catch(err => {
      console.error('[FloatNote Sync] Push error:', err);
      if (retries > 0) {
        setTimeout(() => pushAttempt(retries - 1), 2000);
      }
    });
  };
  pushAttempt(2);
}

// --- IPC: Sync config ---
ipcMain.handle('get-sync-config', () => loadSyncConfig());
ipcMain.handle('set-sync-passphrase', (_event, passphrase) => {
  const config = { passphrase };
  saveSyncConfig(config);
  initFirebaseSync();
  return config;
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 650,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow();
  initFirebaseSync();
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('load-data', () => loadData());
ipcMain.handle('save-data', (_event, data) => saveData(data));
ipcMain.on('minimize', () => mainWindow.minimize());
ipcMain.on('close', () => mainWindow.close());
