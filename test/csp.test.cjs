// Checks that both pages carry the Content-Security-Policy that scripts/update-csp.mjs writes,
// that the policy matches the page's current script, and that nothing in it is loosened.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

(async () => {
  console.log('\nPage policies');
  const { PAGES, policyFor } = await import(path.join(ROOT, 'scripts', 'update-csp.mjs'));
  for (const file of Object.keys(PAGES)) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">\n?/);
    ok(!!m, file + ': has a policy');
    if (!m) continue;
    const csp = m[1];
    ok(csp === policyFor(file, html.replace(m[0], '')), file + ': policy matches the page script (run node scripts/update-csp.mjs)');
    ok(csp.startsWith("default-src 'none'") && /script-src 'sha256-[A-Za-z0-9+/=]+'(;|$)/.test(csp), file + ': one script, by hash, nothing else by default');
    ok(!/unsafe-eval|https?:|\*|script-src[^;]*unsafe-inline/.test(csp), file + ': no eval, no inline scripts, no network sources');
    ok(!/<script[^>]*\ssrc=|\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), file + ': no external scripts or inline handlers in the markup');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
