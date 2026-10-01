const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  quit: () => ipcRenderer.send('quit'),
  setCompact: (on, height) => ipcRenderer.send('set-compact', on, height),
  // Hotkey popup → main → main window.
  captureSubmit: (raw) => ipcRenderer.send('capture-submit', raw),
  captureHide: () => ipcRenderer.send('capture-hide'),
  onCaptureShow: (callback) => ipcRenderer.on('capture-show', () => callback()),
  onCaptured: (callback) => ipcRenderer.on('captured', (_e, raw) => callback(raw)),
  // Main asks for the pending debounced save before quitting; reply with flushed().
  onFlush: (callback) => ipcRenderer.on('flush', () => callback()),
  flushed: () => ipcRenderer.send('flushed'),
  // Records changed by another device: { path → value | null }.
  onRemotePatch: (callback) => ipcRenderer.on('remote-patch', (_e, patch) => callback(patch))
});
