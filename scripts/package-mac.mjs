// Packages TraceFox for macOS.
//   SIGN_IDENTITY set        -> signed with the hardened runtime
//   + NOTARY_PROFILE         -> notarized with a stored notarytool profile (your own Mac)
//   + APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID -> notarized with those (GitHub Actions)
//   nothing set              -> unsigned build for testing
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const env = process.env;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const identity = env.SIGN_IDENTITY || '';
const keychain = env.SIGN_KEYCHAIN || '';
const arch = env.ARCH || 'universal';
const platform = env.PLATFORM || 'darwin'; // PLATFORM=linux builds a copy for testing the packaged app off a Mac

// Electron's build-time switches ("fuses"). Without these, any program on the Mac could start
// the signed app as a plain Node.js runtime, or point it at other code, and act with the app's
// identity, which includes its access to the stored API key.
const fuses = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: false,
  [FuseV1Options.RunAsNode]: false,                              // no ELECTRON_RUN_AS_NODE
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,   // no NODE_OPTIONS
  [FuseV1Options.EnableNodeCliInspectArguments]: false,          // no --inspect
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin', // the app's code must match the hash recorded at build time
  [FuseV1Options.OnlyLoadAppFromAsar]: true,                     // code only loads from the app's own archive
  // GrantFileProtocolExtraPrivileges stays on: the pages are files inside the app's archive, and
  // Electron can only load those with it. main.js limits pages to the app's own files instead.
};
const lockFuses = ({ buildPath, platform: p }) => flipFuses(join(buildPath, p === 'darwin' ? 'Electron.app' : 'electron'), fuses);
const entitlements = resolve('build/entitlements.plist');

let notarize = null;
if (identity && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
  notarize = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
} else if (identity && env.NOTARY_PROFILE) {
  notarize = { keychainProfile: env.NOTARY_PROFILE };
}

const paths = await packager({
  dir: '.', name: 'TraceFox', platform, arch, out: 'out', overwrite: true, asar: true,
  afterExtract: [lockFuses],
  icon: 'build/icon.icns', extendInfo: 'build/extend.plist',
  appBundleId: 'app.tracefox.mac', appVersion: pkg.version, buildVersion: pkg.version,
  appCategoryType: 'public.app-category.productivity', appCopyright: '© 2026 Jakob Ehe',
  ignore: [/^\/(test|out|build|scripts|docs|node_modules|\.github)($|\/)/, /^\/(\.gitignore|README\.md|LICENSE\.md|SECURITY\.md)$/],
  ...(identity ? { osxSign: { identity, ...(keychain ? { keychain } : {}), optionsForFile: () => ({ hardenedRuntime: true, entitlements }) } } : {}),
  ...(notarize ? { osxNotarize: notarize } : {}),
});
console.log(paths.join('\n'));
