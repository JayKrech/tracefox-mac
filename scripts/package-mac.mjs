// Packages TraceFox for macOS.
//   SIGN_IDENTITY set        -> signed with the hardened runtime
//   + NOTARY_PROFILE         -> notarized with a stored notarytool profile (your own Mac)
//   + APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID -> notarized with those (GitHub Actions)
//   nothing set              -> unsigned build for testing
import { packager } from '@electron/packager';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const identity = env.SIGN_IDENTITY || '';
const keychain = env.SIGN_KEYCHAIN || '';
const arch = env.ARCH || 'universal';
const entitlements = resolve('build/entitlements.plist');

let notarize = null;
if (identity && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
  notarize = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
} else if (identity && env.NOTARY_PROFILE) {
  notarize = { keychainProfile: env.NOTARY_PROFILE };
}

const paths = await packager({
  dir: '.', name: 'TraceFox', platform: 'darwin', arch, out: 'out', overwrite: true, asar: true,
  icon: 'build/icon.icns', extendInfo: 'build/extend.plist',
  appBundleId: 'app.tracefox.mac', appVersion: pkg.version, buildVersion: pkg.version,
  appCategoryType: 'public.app-category.productivity', appCopyright: '© 2026 Jakob Ehe',
  ignore: [/^\/(test|out|build|scripts|docs|node_modules|\.github)($|\/)/, /^\/(\.gitignore|README\.md|LICENSE\.md)$/],
  ...(identity ? { osxSign: { identity, ...(keychain ? { keychain } : {}), optionsForFile: () => ({ hardenedRuntime: true, entitlements }) } } : {}),
  ...(notarize ? { osxNotarize: notarize } : {}),
});
console.log(paths.join('\n'));
