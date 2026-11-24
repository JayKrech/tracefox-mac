// Bridge between the TraceFox page and the Mac app. The page builds its runtime on top of this.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tfBridge', {
  host: 'mac',
  dbSnapshot: col => ipcRenderer.invoke('db:snapshot', String(col)),
  dbSet: (col, id, data) => ipcRenderer.invoke('db:set', String(col), String(id), data),
  dbDelete: (col, id) => ipcRenderer.invoke('db:delete', String(col), String(id)),
  onDbChanged: fn => { ipcRenderer.on('db:changed', (_e, col) => fn(col)); },
  aiStart: (id, prompt) => ipcRenderer.invoke('ai:json', String(id), String(prompt)),
  aiAbort: id => ipcRenderer.send('ai:abort', String(id)),
  hasKey: () => ipcRenderer.invoke('key:has'),
  onKeyChanged: fn => { ipcRenderer.on('key:changed', (_e, v) => fn(!!v)); },
  openSettings: () => ipcRenderer.send('settings:open'),
  onMenu: fn => { ipcRenderer.on('menu', (_e, a) => fn(String(a))); },
});
