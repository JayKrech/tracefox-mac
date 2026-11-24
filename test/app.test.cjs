// End-to-end test of the desktop shell: launches the real Electron app (Linux build of the
// same code) and drives it. Run under xvfb-run.
const { _electron: electron } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'test', 'shots'); fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const errors = [];
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-desk-'));

async function launch(env) {
  const appx = await electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [ROOT, '--no-sandbox'], env: Object.assign({}, process.env, { TF_USER_DATA: DATA, TF_PLAIN_KEY: '1' }, env || {}) });
  const page = await appx.firstWindow();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.waitForLoadState('domcontentloaded');
  return { appx, page };
}
const menu = (appx, label) => appx.evaluate(({ Menu }, label) => {
  const find = items => { for (const it of items) { if (it.label === label) return it; if (it.submenu) { const r = find(it.submenu.items); if (r) return r; } } return null; };
  const it = find(Menu.getApplicationMenu().items); if (!it) return false; it.click(); return true;
}, label);

(async () => {
  console.log('\nDesktop app');
  let { appx, page } = await launch();
  await page.waitForSelector('text=No Questions Yet');
  ok((await page.evaluate(() => document.documentElement.classList.contains('desktop'))) && !!(await page.evaluate(() => window.tfBridge && window.tfBridge.host)), 'page runs inside the Mac shell bridge');
  ok((await page.locator('.sb-foot').innerText()).includes('Saved on this Mac') && (await page.locator('.sb-foot').innerText()).includes('Agents need an API key'), 'footer: saved on this Mac, agents need a key');
  ok(await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'), 'page has no Node access (sandboxed)');
  await page.click('text=Load Example Workspace');
  await page.waitForFunction(() => location.hash === '#p-pnw1'); await page.waitForSelector('#bel-b1'); await wait(500);
  const file = path.join(DATA, 'workspace.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(Object.keys(saved.tf_beliefs || {}).length === 7 && Object.keys(saved.tf_sources || {}).length === 6, 'example workspace saved to workspace.json');
  ok((await page.locator('#bel-b1 .band').innerText()).trim() === 'Supported', 'brief renders from native storage');
  await page.screenshot({ path: SHOTS + '/1-brief.png' });

  // agents without a key
  await page.click('#tb [data-a=moreBrief]'); await page.click('#menu .mi:text-is("Propose Beliefs")');
  await wait(400);
  ok((await page.locator('#toast').innerText()).includes('Add your Anthropic API key'), 'agent without a key asks for one');
  const sw = appx.windows().find(w => w !== page) || await appx.waitForEvent('window');
  await sw.waitForSelector('#status'); await wait(200);
  ok((await sw.locator('#status').innerText()).includes('No key saved'), 'Settings window opens');
  await sw.fill('#key', 'not-a-key'); await sw.click('#save'); await wait(300);
  ok((await sw.locator('#msg').innerText()).length > 0 && !(await sw.locator('#dot').getAttribute('class')).includes('on'), 'a malformed key is refused');
  await sw.screenshot({ path: SHOTS + '/2-settings.png' });
  await sw.close();

  // menu commands reach the page
  await menu(appx, 'New Question…'); await page.waitForSelector('dialog[open] form[data-f=project]');
  ok(true, 'File › New Question opens the sheet');
  await page.keyboard.press('Escape'); await wait(150);
  await menu(appx, 'Sources'); await page.waitForFunction(() => location.hash === '#sources');
  ok(true, 'View › Sources navigates');
  await menu(appx, 'Toggle Sidebar'); await wait(150);
  ok(await page.locator('#win.nosb').count() === 1, 'View › Toggle Sidebar hides the sidebar');
  await menu(appx, 'Toggle Sidebar'); await wait(150);
  await appx.close();

  // persistence across restarts
  ({ appx, page } = await launch());
  await page.waitForSelector('.sb-row[data-menu=question]'); await page.goto(page.url().split('#')[0] + '#p-pnw2').catch(() => {});
  await page.waitForSelector('#bel-b5');
  ok((await page.locator('#insp .verdict b').innerText()) === 'Reopen Decision', 'data survives a restart');
  await appx.close();

  // agents through the bridge (test double instead of the network)
  ({ appx, page } = await launch({ TF_FAKE_AI: '1', TF_FAKE_DELAY: '300' }));
  await page.waitForSelector('#bel-b1');
  ok((await page.locator('.sb-foot').innerText()).includes('Agents on, using your API key'), 'footer shows agents on with a key');
  await page.click('#tb [data-a=moreBrief]'); await page.click('#menu .mi:text-is("Propose Beliefs")');
  await page.waitForSelector('.activity'); await page.waitForSelector('.activity', { state: 'detached' }); await wait(300);
  ok(await page.locator('.prow:has-text("confirm roles")').count() === 1, 'Framer result comes back through the bridge');
  await page.evaluate(() => {});
  await appx.evaluate(() => { process.env.TF_FAKE_DELAY = '4000'; });
  await page.click('#tb [data-a=moreBrief]'); await page.click('#menu .mi:text-is("Propose Beliefs")');
  await page.waitForSelector('.activity'); await page.click('.activity [data-a=stop]');
  await page.waitForSelector('.activity', { state: 'detached' }); await wait(200);
  ok((await page.locator('#toast').innerText()).includes('Stopped'), 'Stop aborts the native request');
  await page.screenshot({ path: SHOTS + '/3-agents.png' });
  await appx.close();

  // one-time notice before the first agent run (the test answers it instead of a person)
  fs.rmSync(path.join(DATA, 'settings.json'), { force: true });
  ({ appx, page } = await launch({ TF_FAKE_AI: '1', TF_AGENT_NOTICE: 'decline' }));
  await page.waitForSelector('#bel-b1');
  const before = await page.locator('.prow').count();
  await page.click('#tb [data-a=moreBrief]'); await page.click('#menu .mi:text-is("Propose Beliefs")'); await wait(900);
  const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch (e) { return {}; } };
  ok((await page.locator('.prow').count()) === before && !settings().agentNotice, 'declining the notice sends nothing and proposes nothing');
  await appx.evaluate(() => { process.env.TF_AGENT_NOTICE = 'accept'; });
  await page.click('#tb [data-a=moreBrief]'); await page.click('#menu .mi:text-is("Propose Beliefs")');
  await page.waitForSelector('.activity', { state: 'detached' }); await wait(500);
  ok(settings().agentNotice === true, 'accepting the notice is remembered');
  ok(await appx.evaluate(({ Menu }) => { const all = items => items.flatMap(i => [i.label, ...(i.submenu ? all(i.submenu.items) : [])]); const l = all(Menu.getApplicationMenu().items); return l.includes('Check for Updates…') && l.includes('How TraceFox Protects Your Data'); }), 'menu offers Check for Updates and the data protection page');
  await appx.close();

  // a copy of the workspace per day
  const backups = fs.existsSync(path.join(DATA, 'backups')) ? fs.readdirSync(path.join(DATA, 'backups')) : [];
  ok(backups.length === 1 && /^workspace-\d{4}-\d{2}-\d{2}\.json$/.test(backups[0]) && Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'backups', backups[0]), 'utf8')).tf_beliefs).length === 7, 'a daily backup of the workspace is kept');

  // an unreadable workspace file is kept aside, never overwritten
  const BAD = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-desk-bad-'));
  fs.writeFileSync(path.join(BAD, 'workspace.json'), '{"tf_projects": {"p1": {"question": "Half a fi');
  ({ appx, page } = await launch({ TF_USER_DATA: BAD, TF_NO_DIALOGS: '1' }));
  await page.waitForSelector('text=No Questions Yet');
  await page.click('text=Load Example Workspace'); await page.waitForFunction(() => location.hash === '#p-pnw1'); await wait(500);
  await appx.close();
  const kept = fs.readdirSync(BAD).filter(f => f.startsWith('workspace.unreadable-'));
  ok(kept.length === 1 && fs.readFileSync(path.join(BAD, kept[0]), 'utf8').endsWith('Half a fi') && Object.keys(JSON.parse(fs.readFileSync(path.join(BAD, 'workspace.json'), 'utf8')).tf_beliefs).length === 7, 'an unreadable workspace file is kept aside before a new one is saved');

  // a tampered workspace file: unexpected collections and ids are left out, the original is kept
  const TAMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-desk-tamp-'));
  fs.writeFileSync(path.join(TAMP, 'workspace.json'), '{"tf_groups": {"__proto__": {"polluted": true}, "bad id!": {"name": "x"}}, "evil": {"a": {}}, "tf_sources": []}');
  ({ appx, page } = await launch({ TF_USER_DATA: TAMP, TF_NO_DIALOGS: '1' }));
  await page.waitForSelector('text=No Questions Yet');
  ok(await appx.evaluate(() => ({}).polluted === undefined), 'a tampered file cannot change built-in objects');
  await appx.close();
  ok(fs.readdirSync(TAMP).filter(f => f.startsWith('workspace.unreadable-')).length === 1, 'the tampered file is kept aside for inspection');
  fs.rmSync(BAD, { recursive: true, force: true }); fs.rmSync(TAMP, { recursive: true, force: true });

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) { console.log('\nPage errors:'); [...new Set(errors)].forEach(e => console.log('  ' + e)); }
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); console.log(errors.join('\n')); process.exit(2); });
