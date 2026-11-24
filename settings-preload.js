'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tfSettings', {
  state: () => ipcRenderer.invoke('settings:state'),
  saveKey: key => ipcRenderer.invoke('key:save', String(key || '')),
  testKey: key => ipcRenderer.invoke('key:test', key == null ? null : String(key)),
  removeKey: () => ipcRenderer.invoke('key:remove'),
  setModel: id => ipcRenderer.invoke('model:set', String(id)),
  revealData: () => ipcRenderer.send('data:reveal'),
  openKeys: () => ipcRenderer.send('open:keys'),
  close: () => ipcRenderer.send('settings:close'),
});
