const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(app.getPath('userData'), 'floatnote-data.json');

const DEFAULT_STATE = {
  notes: { professional: '', personal: '' },
  checklist: { professional: [], personal: [] },
  completionLog: [],
  preferences: null,
  habits: [],
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
}

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

ipcMain.handle('load-data', () => loadData());
ipcMain.handle('save-data', (_event, data) => saveData(data));
ipcMain.on('minimize', () => mainWindow.minimize());
ipcMain.on('close', () => mainWindow.close());
