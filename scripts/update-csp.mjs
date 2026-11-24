// Writes the Content-Security-Policy of the two pages. Each page may run exactly one script:
// its own, identified by its SHA-256 hash. Anything injected into a page cannot run, and a
// page cannot load anything from the network. Run this after changing either page:
//   node scripts/update-csp.mjs          (test/csp.test.cjs fails when it was forgotten)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PAGES = {
  'app/index.html': h => `default-src 'none'; script-src ${h}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
  'settings.html': h => `default-src 'none'; script-src ${h}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'`,
};
const META = /<meta http-equiv="Content-Security-Policy" content="[^"]*">\n?/;

export function policyFor(file, html) {
  const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m => !/type="application\/json"/.test(m[1] || ''));
  if (scripts.some(m => /\ssrc=/.test(m[1] || ''))) throw new Error(file + ': external scripts are not allowed');
  const hashes = scripts.map(m => `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`).join(' ');
  return PAGES[file](hashes);
}

if (process.argv[1] && process.argv[1].endsWith('update-csp.mjs')) {
  for (const file of Object.keys(PAGES)) {
    let html = readFileSync(file, 'utf8').replace(META, '');
    const tag = `<meta http-equiv="Content-Security-Policy" content="${policyFor(file, html)}">\n`;
    if (!html.includes('<meta charset="utf-8">\n')) throw new Error(file + ': charset tag not found');
    html = html.replace('<meta charset="utf-8">\n', '<meta charset="utf-8">\n' + tag);
    writeFileSync(file, html);
    console.log(file + ': policy written');
  }
}
