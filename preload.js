const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  quit: () => ipcRenderer.send('quit'),
  // Main asks for the pending debounced save before quitting; reply with flushed().
  onFlush: (callback) => ipcRenderer.on('flush', () => callback()),
  flushed: () => ipcRenderer.send('flushed'),
  // Records changed by another device: { path → value | null }.
  onRemotePatch: (callback) => ipcRenderer.on('remote-patch', (_e, patch) => callback(patch))
});
