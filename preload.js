const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  // Sync
  getSyncConfig: () => ipcRenderer.invoke('get-sync-config'),
  setSyncPassphrase: (passphrase) => ipcRenderer.invoke('set-sync-passphrase', passphrase),
  onRemoteUpdate: (callback) => ipcRenderer.on('remote-update', (_event, data) => callback(data))
});
