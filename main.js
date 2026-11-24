// TraceFox for Mac: a native shell around the TraceFox page.
// Data lives in a JSON file in the app's support folder; agents call the Anthropic API
// with the user's own key, which is encrypted with the macOS Keychain (safeStorage).
'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, safeStorage, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ai = require('./ai');

if (process.env.TF_USER_DATA) app.setPath('userData', process.env.TF_USER_DATA);
app.setName('TraceFox');
const IS_MAC = process.platform === 'darwin';
const FAKE_AI = process.env.TF_FAKE_AI === '1';

/* ---------- files ---------- */
const P = name => path.join(app.getPath('userData'), name);
function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(P(name), 'utf8')); } catch (e) { return fallback; } }
function writeJsonAtomic(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = P(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, P(name));
}

/* ---------- workspace store ---------- */
let db = null;
let saveTimer = null;
const COL = /^tf_[a-z]{1,20}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
function store() {
  if (!db) {
    db = readJson('workspace.json', null);
    if (!db || typeof db !== 'object') db = {};
  }
  return db;
}
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 120); }
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!db) return;
  try { writeJsonAtomic('workspace.json', db); }
  catch (e) { dialog.showErrorBox('TraceFox couldn’t save your workspace', String(e && e.message || e)); }
}
function broadcast(channel, payload) { BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send(channel, payload); }); }

ipcMain.handle('db:snapshot', (_e, col) => {
  if (!COL.test(col)) throw new Error('invalid collection');
  return Object.entries(store()[col] || {}).map(([id, data]) => ({ id, data }));
});
ipcMain.handle('db:set', (_e, col, id, data) => {
  if (!COL.test(col) || !ID.test(id)) throw new Error('invalid path');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid document');
  if (JSON.stringify(data).length > 2 * 1024 * 1024) throw new Error('document too large');
  const s = store(); (s[col] = s[col] || {})[id] = data;
  saveSoon(); broadcast('db:changed', col);
  return true;
});
ipcMain.handle('db:delete', (_e, col, id) => {
  if (!COL.test(col) || !ID.test(id)) throw new Error('invalid path');
  const s = store(); if (s[col]) delete s[col][id];
  saveSoon(); broadcast('db:changed', col);
  return true;
});

/* ---------- settings: API key (Keychain-encrypted) and model ---------- */
const prefs = () => readJson('settings.json', { model: ai.MODELS[0].id });
function setPref(k, v) { const p = prefs(); p[k] = v; writeJsonAtomic('settings.json', p); }
function secureOk() { return safeStorage.isEncryptionAvailable(); }
function getKey() {
  try {
    const buf = fs.readFileSync(P('key.bin'));
    if (secureOk()) return safeStorage.decryptString(buf);
    if (process.env.TF_PLAIN_KEY === '1') return buf.toString('utf8');
  } catch (e) { /* no key */ }
  return '';
}
function saveKey(key) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  if (secureOk()) fs.writeFileSync(P('key.bin'), safeStorage.encryptString(key));
  else if (process.env.TF_PLAIN_KEY === '1') fs.writeFileSync(P('key.bin'), key, 'utf8');
  else throw new Error('Secure storage isn’t available on this computer, so the key can’t be saved.');
}
function removeKey() { try { fs.unlinkSync(P('key.bin')); } catch (e) { /* already gone */ } }
const keyShape = k => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);

ipcMain.handle('key:has', () => FAKE_AI || !!getKey());
ipcMain.handle('settings:state', () => {
  const k = getKey();
  return { hasKey: !!k, keyHint: k ? k.slice(0, 10) + '…' + k.slice(-4) : '', model: prefs().model || ai.MODELS[0].id, models: ai.MODELS, dataPath: app.getPath('userData'), version: app.getVersion(), secure: secureOk() };
});
ipcMain.handle('key:save', async (_e, key) => {
  key = String(key || '').trim();
  if (!keyShape(key)) return { ok: false, error: { code: 'invalid_key', message: 'That doesn’t look like an Anthropic API key. Keys start with “sk-ant-”.' } };
  try { saveKey(key); } catch (e) { return { ok: false, error: { code: 'storage', message: e.message } }; }
  broadcast('key:changed', true);
  return { ok: true };
});
ipcMain.handle('key:test', (_e, key) => ai.testKey({ key: key ? String(key).trim() : getKey() }));
ipcMain.handle('key:remove', () => { removeKey(); broadcast('key:changed', FAKE_AI); return { ok: true }; });
ipcMain.handle('model:set', (_e, id) => { if (ai.MODELS.some(m => m.id === id)) setPref('model', id); return { ok: true }; });
ipcMain.on('data:reveal', () => { flush(); shell.showItemInFolder(P('workspace.json')); });
ipcMain.on('open:keys', () => shell.openExternal('https://console.anthropic.com/settings/keys'));

/* ---------- agents ---------- */
const running = new Map();
ipcMain.on('ai:abort', (_e, id) => { const c = running.get(id); if (c) c.abort(); });
ipcMain.handle('ai:json', async (_e, id, prompt) => {
  const ctl = new AbortController(); running.set(id, ctl);
  try {
    if (FAKE_AI) return { ok: true, json: await fakeAgent(prompt, ctl.signal) };
    const out = await ai.completeJson({ key: getKey(), model: prefs().model, prompt, signal: ctl.signal });
    return { ok: true, json: out.json };
  } catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'error', message: String((e && e.message) || e) } };
  } finally { running.delete(id); }
});

// Test double so the bridge can be exercised without a key or network.
function fakeAgent(prompt, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (prompt.includes('Framer agent')) resolve({ beliefs: [{ statement: 'Admins wait for a colleague to confirm roles before inviting.', loadBearing: true, why: 'Desktop bridge test.', test: 'Interview 5 admins', passIf: '4 of 5 mention roles' }], reuse: [], metric: '' });
      else resolve({});
    }, Number(process.env.TF_FAKE_DELAY || 200));
    signal.addEventListener('abort', () => { clearTimeout(t); reject({ code: 'cancelled', message: 'Stopped' }); }, { once: true });
  });
}

/* ---------- windows ---------- */
let win = null, settingsWin = null;
function bounds() { return readJson('window.json', { width: 1320, height: 860 }); }
function createWindow() {
  const b = bounds();
  win = new BrowserWindow({
    width: b.width || 1320, height: b.height || 860, x: b.x, y: b.y, minWidth: 760, minHeight: 520,
    title: 'TraceFox', show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());
  const keep = () => { if (!win.isMaximized() && !win.isFullScreen()) try { writeJsonAtomic('window.json', win.getBounds()); } catch (e) { /* ignore */ } };
  win.on('resize', debounce(keep, 400)); win.on('move', debounce(keep, 400));
  win.on('closed', () => { win = null; });
  guard(win.webContents);
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 600, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Settings', show: false, parent: undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2a2a2a' : '#ececec',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  guard(settingsWin.webContents);
}
ipcMain.on('settings:open', openSettings);
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });

// Keep the app on its own pages; open web links in the browser.
function guard(wc) {
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

/* ---------- menu ---------- */
const send = a => () => { const w = win || BrowserWindow.getFocusedWindow(); if (w && !w.isDestroyed()) w.webContents.send('menu', a); };
function buildMenu() {
  const t = [
    ...(IS_MAC ? [{ label: 'TraceFox', submenu: [
      { role: 'about', label: 'About TraceFox' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide', label: 'Hide TraceFox' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit', label: 'Quit TraceFox' }] }] : []),
    { label: 'File', submenu: [
      { label: 'New Question…', accelerator: 'CmdOrCtrl+Alt+N', click: send('newQuestion') },
      { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: send('newProject') },
      { type: 'separator' },
      { label: 'Show Data in Finder', click: () => { flush(); shell.showItemInFolder(P('workspace.json')); } },
      { type: 'separator' },
      ...(IS_MAC ? [{ role: 'close' }] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings }, { role: 'quit' }])] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('find') }] },
    { label: 'View', submenu: [
      { label: 'Toggle Sidebar', accelerator: 'Ctrl+Cmd+S', click: send('toggleSidebar') },
      { label: 'Toggle Inspector', accelerator: 'Ctrl+Cmd+I', click: send('toggleInspector') },
      { type: 'separator' },
      { label: 'Review', accelerator: 'CmdOrCtrl+1', click: send('review') },
      { label: 'Sources', accelerator: 'CmdOrCtrl+2', click: send('sources') },
      { label: 'Belief Ledger', accelerator: 'CmdOrCtrl+3', click: send('ledger') },
      { label: 'Decisions', accelerator: 'CmdOrCtrl+4', click: send('decisions') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Get an Anthropic API Key', click: () => shell.openExternal('https://console.anthropic.com/settings/keys') },
      { label: 'TraceFox Website', click: () => shell.openExternal('https://tracefox.app') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

/* ---------- lifecycle ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.setAboutPanelOptions({ applicationName: 'TraceFox', applicationVersion: app.getVersion(), copyright: '© 2026 Jakob Ehe', credits: 'Evidence for every product decision.' });
  app.whenReady().then(() => { buildMenu(); createWindow(); });
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('before-quit', flush);
  app.on('window-all-closed', () => { flush(); if (!IS_MAC) app.quit(); });
}
