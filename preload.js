const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data, seenSeq) => ipcRenderer.invoke('save-data', data, seenSeq),
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
  onRemotePatch: (callback) => ipcRenderer.on('remote-patch', (_e, patch, seq, before) => callback(patch, seq, before)),
  // Settings: sync status and the live hotkey. The passphrase only ever goes in.
  getInfo: () => ipcRenderer.invoke('get-info'),
  onInfo: (callback) => ipcRenderer.on('info', (_e, info) => callback(info)),
  setPassphrase: (p) => ipcRenderer.invoke('set-passphrase', p),
  pauseHotkey: (on) => ipcRenderer.send('pause-hotkey', on)
});
