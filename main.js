// TraceFox for Mac: a native shell around the TraceFox page.
// Data lives in a JSON file in the app's support folder; agents call the Anthropic API
// with the user's own key, which is encrypted with the macOS Keychain (safeStorage).
'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, safeStorage, nativeTheme, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const ai = require('./ai');

// Test switches. They only work when the app is run from source, never in the packaged app.
const DEV = !app.isPackaged;
const TEST = DEV ? process.env : {};
if (TEST.TF_USER_DATA) app.setPath('userData', TEST.TF_USER_DATA);
app.setName('TraceFox');
const IS_MAC = process.platform === 'darwin';
const FAKE_AI = TEST.TF_FAKE_AI === '1';
const PLAIN_KEY = TEST.TF_PLAIN_KEY === '1';

// "TraceFox --self-test" starts the app on an empty, temporary workspace, checks that the page
// loaded, can reach its storage and cannot reach the network, prints the result and quits.
// The build uses it to check the packaged app. It never touches the real workspace or the key.
const SELF_TEST = process.argv.includes('--self-test');
if (SELF_TEST) app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tracefox-selftest-')));

// The packaged app does not start with a debugging port open.
if (!DEV && process.argv.some(a => /^--(remote-debugging|inspect)/.test(a))) app.exit(1);

/* ---------- who is calling ---------- */
// Each window may only use its own channels. A request counts as coming from a page when
// it was sent by that page's own file, loaded from inside the app.
const APP_DIR = __dirname.normalize('NFC');
const PAGE_FILE = path.join(APP_DIR, 'app', 'index.html');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.html');
function fileOf(url) { try { const u = new URL(String(url)); if (u.protocol !== 'file:') return ''; u.hash = ''; u.search = ''; return fileURLToPath(u).normalize('NFC'); } catch (e) { return ''; } }
const fromPage = e => !!e.senderFrame && fileOf(e.senderFrame.url) === PAGE_FILE;
const fromSettings = e => !!e.senderFrame && fileOf(e.senderFrame.url) === SETTINGS_FILE;
function handle(channel, allowed, fn) { ipcMain.handle(channel, (e, ...args) => { if (!allowed(e)) throw new Error('not allowed'); return fn(e, ...args); }); }
function listen(channel, allowed, fn) { ipcMain.on(channel, (e, ...args) => { if (allowed(e)) fn(e, ...args); }); }

/* ---------- files ---------- */
const P = name => path.join(app.getPath('userData'), name);
function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(P(name), 'utf8')); } catch (e) { return fallback; } }
function writeJsonAtomic(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = P(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, P(name));
}

/* ---------- workspace store ---------- */
let db = null;
let saveTimer = null;
const COL = /^tf_[a-z]{1,20}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const okId = id => typeof id === 'string' && ID.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
const isDoc = d => !!d && typeof d === 'object' && !Array.isArray(d);
// Reads the workspace file and keeps only what has the expected shape, so a damaged or
// tampered file cannot hand the page unexpected collections or ids.
function store() {
  if (!db) {
    const raw = readJson('workspace.json', null);
    db = Object.create(null);
    if (isDoc(raw)) for (const col of Object.keys(raw)) {
      if (!COL.test(col) || !isDoc(raw[col])) continue;
      const docs = db[col] = Object.create(null);
      for (const id of Object.keys(raw[col])) if (okId(id) && isDoc(raw[col][id])) docs[id] = raw[col][id];
    }
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

let snapshots = 0;
handle('db:snapshot', fromPage, (_e, col) => {
  if (typeof col !== 'string' || !COL.test(col)) throw new Error('invalid collection');
  snapshots++;
  return Object.entries(store()[col] || {}).map(([id, data]) => ({ id, data }));
});
handle('db:set', fromPage, (_e, col, id, data) => {
  if (typeof col !== 'string' || !COL.test(col) || !okId(id)) throw new Error('invalid path');
  if (!isDoc(data)) throw new Error('invalid document');
  if (JSON.stringify(data).length > 2 * 1024 * 1024) throw new Error('document too large');
  const s = store(); (s[col] = s[col] || Object.create(null))[id] = data;
  saveSoon(); broadcast('db:changed', col);
  return true;
});
handle('db:delete', fromPage, (_e, col, id) => {
  if (typeof col !== 'string' || !COL.test(col) || !okId(id)) throw new Error('invalid path');
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
    if (PLAIN_KEY) return buf.toString('utf8');
  } catch (e) { /* no key */ }
  return '';
}
function saveKey(key) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  if (secureOk()) fs.writeFileSync(P('key.bin'), safeStorage.encryptString(key), { mode: 0o600 });
  else if (PLAIN_KEY) fs.writeFileSync(P('key.bin'), key, { encoding: 'utf8', mode: 0o600 });
  else throw new Error('Secure storage isn’t available on this computer, so the key can’t be saved.');
  try { fs.chmodSync(P('key.bin'), 0o600); } catch (e) { /* best effort */ }
}
function removeKey() { try { fs.unlinkSync(P('key.bin')); } catch (e) { /* already gone */ } }
const keyShape = k => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);

handle('key:has', fromPage, () => FAKE_AI || !!getKey());
handle('settings:state', fromSettings, () => {
  const k = getKey();
  return { hasKey: !!k, keyHint: k ? k.slice(0, 10) + '…' + k.slice(-4) : '', model: prefs().model || ai.MODELS[0].id, models: ai.MODELS, dataPath: app.getPath('userData'), version: app.getVersion(), secure: secureOk() };
});
handle('key:save', fromSettings, async (_e, key) => {
  key = String(key || '').trim();
  if (!keyShape(key)) return { ok: false, error: { code: 'invalid_key', message: 'That doesn’t look like an Anthropic API key. Keys start with “sk-ant-”.' } };
  try { saveKey(key); } catch (e) { return { ok: false, error: { code: 'storage', message: e.message } }; }
  broadcast('key:changed', true);
  return { ok: true };
});
handle('key:test', fromSettings, (_e, key) => ai.testKey({ key: key ? String(key).trim() : getKey() }));
handle('key:remove', fromSettings, () => { removeKey(); broadcast('key:changed', FAKE_AI); return { ok: true }; });
handle('model:set', fromSettings, (_e, id) => { if (ai.MODELS.some(m => m.id === id)) setPref('model', id); return { ok: true }; });
listen('data:reveal', fromSettings, () => { flush(); shell.showItemInFolder(P('workspace.json')); });
listen('open:keys', fromSettings, () => shell.openExternal('https://console.anthropic.com/settings/keys'));

/* ---------- agents ---------- */
const running = new Map();
listen('ai:abort', fromPage, (_e, id) => { const c = running.get(id); if (c) c.abort(); });
handle('ai:json', fromPage, async (_e, id, prompt) => {
  if (typeof id !== 'string' || typeof prompt !== 'string') throw new Error('invalid request');
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
    }, Number(TEST.TF_FAKE_DELAY || 200));
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: true },
  });
  win.loadFile(PAGE_FILE);
  win.once('ready-to-show', () => win.show());
  const keep = () => { if (!win.isMaximized() && !win.isFullScreen()) try { writeJsonAtomic('window.json', win.getBounds()); } catch (e) { /* ignore */ } };
  win.on('resize', debounce(keep, 400)); win.on('move', debounce(keep, 400));
  win.on('closed', () => { win = null; });
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 600, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Settings', show: false, parent: undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2a2a2a' : '#ececec',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false },
  });
  settingsWin.loadFile(SETTINGS_FILE);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}
listen('settings:open', fromPage, openSettings);
listen('settings:close', fromSettings, () => { if (settingsWin) settingsWin.close(); });

// Each window stays on the page it was opened with. Web links open in the browser, and only
// https links; nothing else on the computer can be opened from a page.
function openLink(url) { try { if (new URL(String(url)).protocol === 'https:') shell.openExternal(String(url)); } catch (e) { /* not a link */ } }
function guard(wc) {
  wc.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  const stay = (e, url) => { const f = fileOf(url); if (f && f === fileOf(wc.getURL())) return; e.preventDefault(); openLink(url); };
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  wc.on('will-attach-webview', e => e.preventDefault());
}

// The pages themselves get no network access and no device permissions. Requests to Anthropic
// are made by this process (ai.js), never by a page.
function lockDown() {
  const ses = session.defaultSession;
  const ownFile = url => { const f = fileOf(url); return !!f && f.startsWith(APP_DIR + path.sep); };
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !(ownFile(details.url) || /^(devtools|data|blob):/i.test(details.url)) }));
  // The only permission a page gets is copying text to the clipboard (the Copy commands).
  const mayCopy = (wc, permission) => permission === 'clipboard-sanitized-write' && !!wc && fileOf(wc.getURL()) === PAGE_FILE;
  ses.setPermissionRequestHandler((wc, permission, done) => done(mayCopy(wc, permission)));
  ses.setPermissionCheckHandler((wc, permission) => mayCopy(wc, permission));
  app.on('web-contents-created', (_e, wc) => guard(wc));
}
async function selfTest() {
  const out = {};
  const finish = () => { const ok = Object.values(out).every(v => v === true); console.log('SELF-TEST ' + (ok ? 'OK' : 'FAILED') + ' ' + JSON.stringify(out)); try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch (e) { /* temp folder */ } app.exit(ok ? 0 : 1); };
  setTimeout(() => { out.timeout = false; finish(); }, 30000);
  try {
    await new Promise(r => win.webContents.once('did-finish-load', r));
    for (let i = 0; i < 100 && snapshots < 1; i++) await new Promise(r => setTimeout(r, 100));
    const js = code => win.webContents.executeJavaScript(code, true);
    out.pageLoaded = fileOf(win.webContents.getURL()) === PAGE_FILE;
    out.storageReached = snapshots > 0 && (await js('window.tfBridge.dbSnapshot("tf_projects").then(r => Array.isArray(r), () => false)')) === true;
    out.bridgeAsExpected = (await js('Object.keys(window.tfBridge).sort().join(",")')) === 'aiAbort,aiStart,dbDelete,dbSet,dbSnapshot,hasKey,host,onDbChanged,onKeyChanged,onMenu,openSettings';
    out.noKeyOnFreshStart = (await js('window.tfBridge.hasKey()')) === false;
    out.noNodeInPage = (await js('typeof require === "undefined" && typeof process === "undefined"')) === true;
    out.networkBlocked = (await js('fetch("https://example.com/", { mode: "no-cors" }).then(() => false, () => true)')) === true;
    out.imageBlocked = (await js('new Promise(r => { const i = new Image(); i.onload = () => r(false); i.onerror = () => r(true); i.src = "https://example.com/x.png"; setTimeout(() => r(true), 4000); })')) === true;
    out.inlineScriptBlocked = (await js('new Promise(r => { window.__t = 0; const d = document.createElement("div"); d.innerHTML = "<img src=x onerror=\\"window.__t=1\\">"; document.body.appendChild(d); setTimeout(() => { d.remove(); r(window.__t === 0); }, 600); })')) === true;
    out.settingsClosedToPage = (await js('typeof window.tfSettings === "undefined"')) === true;
  } catch (e) { out.error = String(e && e.message || e); }
  finish();
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
  app.whenReady().then(() => { lockDown(); buildMenu(); createWindow(); if (SELF_TEST) selfTest(); });
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('before-quit', flush);
  app.on('window-all-closed', () => { flush(); if (!IS_MAC) app.quit(); });
}
