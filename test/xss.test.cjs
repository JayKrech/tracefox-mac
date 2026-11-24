// Injection test for the TraceFox page. It fills the workspace and the agents' replies with
// HTML payloads, walks through the views, dialogs and menus, and fails if any payload shows up
// as real markup or runs as script. Needs Playwright (npm install --no-save playwright).
//   text mode: every free-text field is hostile (pasted sources, titles, agent replies)
//   file mode: every value in workspace.json is hostile (a tampered workspace file)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs'), path = require('path');
const PAGE = path.resolve(__dirname, '..', 'app', 'index.html');
const html = fs.readFileSync(PAGE, 'utf8');
const example = JSON.parse(html.match(/<script type="application\/json" id="example">([\s\S]*?)<\/script>/)[1]);

const PAYLOAD = `"'><img src=x onerror="window.__xss=1" data-xss=1><svg onload="window.__xss=1" data-xss=1></svg><script>window.__xss=1</script><a href="javascript:window.__xss=1" data-xss=1>x</a>`;
const KEEP = /^(id|.*Id|.*Ids|status|direction|strength|type|date|deadline|by|kind|stakes|method|effort|band|.*At)$/;
function poison(v, key, all) {
  if (Array.isArray(v)) return v.map(x => poison(x, key, all));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x, k, all)]));
  if (/^(id|.*Id|.*Ids)$/.test(key || '')) return v;
  if (typeof v === 'string') return (all || !KEEP.test(key || '')) ? v + ' ' + PAYLOAD : v;
  if (typeof v === 'number' && all) return PAYLOAD;
  return v;
}
function store(all) {
  const st = {};
  for (const [col, rows] of Object.entries(example)) { st['tf_' + col] = {}; for (const r of rows) st['tf_' + col][r.id] = poison(r, '', all); }
  return st;
}

// Stand-in for preload.js. The agents answer with hostile values in every field.
const BRIDGE = (st, P) => {
  const subs = [], menus = []; window.__menus = menus;
  const changed = c => setTimeout(() => subs.forEach(f => f(c)), 0);
  const ids = p => [...p.matchAll(/^\[([A-Za-z0-9]+)\] /gm)].map(x => x[1]);
  window.tfBridge = {
    host: 'mac',
    dbSnapshot: async c => Object.entries(st[c] || {}).map(([id, data]) => ({ id, data: JSON.parse(JSON.stringify(data)) })),
    dbSet: async (c, id, d) => { (st[c] = st[c] || {})[id] = d; changed(c); return true; },
    dbDelete: async (c, id) => { if (st[c]) delete st[c][id]; changed(c); return true; },
    onDbChanged: f => subs.push(f),
    aiStart: async (id, p) => {
      await new Promise(r => setTimeout(r, 150));
      const b = ids(p);
      if (p.includes('Framer agent')) return { ok: true, json: { beliefs: [{ statement: 'Hostile belief ' + P, loadBearing: P, why: P, test: P, passIf: P }], reuse: [P], metric: P } };
      if (p.includes('Extractor agent')) {
        const src = [...p.matchAll(/=== SOURCE ([A-Za-z0-9]+) \|[^\n]*===\n([\s\S]*?)\n=== END/g)].map(m => ({ id: m[1], text: m[2] }));
        const ev = [];
        src.forEach(s => { const line = s.text.split('\n').find(l => l.includes('data-xss')) || s.text.slice(0, 200); b.slice(0, 2).forEach(bid => ev.push({ beliefId: bid, sourceId: s.id, quote: line, direction: P, strength: P, rationale: P })); });
        return { ok: true, json: { evidence: ev } };
      }
      if (p.includes('Investigator agent')) return { ok: true, json: { plans: b.map(bid => ({ beliefId: bid, step: P, method: P, passIf: P, effort: P, why: P, guide: [P, P] })) } };
      if (p.includes('Scribe agent')) return { ok: true, json: { summary: P, nextSteps: b.slice(0, 3).map(bid => ({ beliefId: bid, step: P })) } };
      return { ok: true, json: { [P]: P } };
    },
    aiAbort: () => {}, hasKey: async () => true, onKeyChanged: () => {}, openSettings: () => {}, onMenu: f => menus.push(f),
  };
};

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, checks = 0;

async function run(browser, mode) {
  const all = mode === 'file';
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(`(${BRIDGE})(${JSON.stringify(store(all))}, ${JSON.stringify(PAYLOAD)})`);
  await page.goto('file://' + PAGE);
  await page.waitForSelector('#side', { timeout: 10000 }); await wait(500);

  const check = async label => {
    checks++;
    const r = await page.evaluate(() => {
      const hit = document.querySelector('[data-xss], img[src="x"]');
      const ran = window.__xss || 0; window.__xss = 0;
      return { ran, markup: hit ? (hit.parentElement || hit).outerHTML.slice(0, 260) : '' };
    }).catch(e => ({ ran: 0, markup: '', err: String(e) }));
    if (r.ran || r.markup) { failures++; console.log(`  FAIL [${mode}] ${label}: ${r.ran ? 'script ran' : 'markup injected'} ${r.markup}`); }
  };
  const step = async (label, fn) => { try { await fn(); } catch (e) { /* this view has no such control */ } await wait(120); await check(label); };
  const esc = async () => { await page.keyboard.press('Escape'); await wait(80); await page.evaluate(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); const m = document.querySelector('#menu'); if (m) m.hidden = true; }); };
  const expand = () => page.evaluate(() => {
    document.querySelectorAll('.bstmt').forEach(b => { const row = b.closest('[aria-expanded]'); if (!row || row.getAttribute('aria-expanded') !== 'true') b.click(); });
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  });

  const routes = ['review', 'sources', 'ledger', 'decisions', 'runs',
    ...example.groups.map(g => 'g-' + g.id), ...example.projects.map(p => 'p-' + p.id), ...example.sources.map(s => 's-' + s.id)];
  for (const h of routes) {
    await step('view #' + h, async () => { await page.evaluate(x => { location.hash = x; }, h); await wait(250); });
    await step('view #' + h + ' expanded', expand);
    // every context menu in this view
    const kinds = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-menu]')].map(e => e.getAttribute('data-menu')))]);
    for (const k of kinds) {
      await step(`context menu ${k} in #${h}`, async () => { await page.click(`[data-menu="${k}"]`, { button: 'right', timeout: 1500 }); });
      await esc();
    }
    // every dialog that only opens (nothing here changes or deletes data)
    for (const a of ['addBelief', 'editBelief', 'addSource', 'editSource', 'addEvidence', 'addContext', 'viewFile', 'newProject', 'newGroup', 'commit', 'openProposals', 'toggleInsp', 'moreBrief', 'moreGroup']) {
      if (!(await page.$(`[data-a=${a}]`))) continue;
      await step(`${a} in #${h}`, async () => { await page.click(`[data-a=${a}]`, { timeout: 1500 }); });
      await esc();
    }
  }

  // agents: replies are hostile in every field
  const pid = example.projects[0].id;
  await page.evaluate(x => { location.hash = 'p-' + x; }, pid); await wait(300);
  const settle = async () => { await page.waitForSelector('.activity', { timeout: 2000 }).catch(() => {}); await page.waitForSelector('.activity', { state: 'detached', timeout: 8000 }).catch(() => {}); await wait(300); };
  const menuItem = async label => { await page.click('#tb [data-a=moreBrief]', { timeout: 1500 }); await page.click(`#menu .mi:text-is("${label}")`, { timeout: 1500 }); };
  await step('Extractor reply', async () => { await page.click('[data-a=findEvidence]', { timeout: 1500 }); await settle(); });
  await step('Extractor reply, all sources', async () => { await menuItem('Rescan All Sources'); await settle(); });
  await step('Framer reply', async () => { await menuItem('Propose Beliefs'); await settle(); });
  await step('Scribe reply', async () => { await page.click('[data-a=draft]', { timeout: 1500 }); await settle(); });
  await step('Investigator reply', async () => { await page.click('#insp [data-a=investigate]', { timeout: 1500 }); await settle(); });
  await esc();
  await step('proposals after agents', async () => { await page.click('[data-a=openProposals]', { timeout: 1500 }); });
  await step('brief after agents, expanded', expand);
  for (const h of ['review', 'ledger', 'runs', 'decisions', 'g-' + example.groups[0].id]) {
    await step('after agents #' + h, async () => { await page.evaluate(x => { location.hash = x; }, h); await wait(250); await expand(); });
  }
  // menu commands from the Mac menu bar
  for (const m of ['newQuestion', 'newProject', 'find', 'review', 'sources', 'ledger', 'decisions']) {
    await step('menu ' + m, async () => { await page.evaluate(x => window.__menus.forEach(f => f(x)), m); await wait(150); });
    await esc();
  }
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
  console.log('\nInjection test');
  for (const mode of ['text', 'file']) { const before = failures; await run(browser, mode); console.log(`  ${failures === before ? 'ok  ' : 'FAIL'} ${mode} mode`); }
  await browser.close();
  console.log(`\n${checks} checks, ${failures} injection${failures === 1 ? '' : 's'} found`);
  process.exit(failures ? 1 : 0);
})();
