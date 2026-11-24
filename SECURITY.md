# Security

## Reporting a problem

Please report security problems privately, not in a public issue: open the **Security** tab of this repository and choose **Report a vulnerability**. You will get an answer there.

## How TraceFox protects your data

**What stays on your Mac**

- Your workspace is one file, `~/Library/Application Support/TraceFox/workspace.json`, readable only by your macOS user account. It is not encrypted beyond what macOS does for your disk (FileVault).
- TraceFox keeps a copy of the workspace for each of the last 7 days you opened it, in the `backups` folder next to it. If the workspace file cannot be read, it is copied aside untouched before anything new is saved.
- Your Anthropic API key is encrypted with the macOS Keychain. The app's pages never receive the key; only the app's main process reads it, to sign requests to Anthropic.

**What leaves your Mac**

- Only requests to `api.anthropic.com`, made when you run an agent or check your key. An agent run sends the question, its beliefs, and the sources and context files that agent needs. Anthropic's terms for API data apply to that content. Before the first agent run, TraceFox says this once and asks you to confirm.
- Nothing else: no analytics, no crash reports, no update checks.

**How the app is locked down**

- The pages run in Chromium's sandbox, without access to Node.js, and can only call a short list of functions (`preload.js`). The main process checks which window each call comes from.
- The pages have no network access at all. A Content-Security-Policy allows exactly one script per page, identified by its hash, so text from a source or from an agent cannot run as code. The main process also cancels any network request a page attempts.
- Text from your sources and from the agents is always shown as text. `test/xss.test.cjs` fills every field and every agent reply with hostile markup and checks that none of it is rendered.
- Windows cannot navigate away from the app's own pages. Web links open in your browser, and only `https` links.
- The packaged app cannot be started as a plain Node.js runtime, with a debugger, or with other code than its own archive (Electron fuses), and its code is checked against a hash recorded at build time.
- Releases are built by GitHub Actions from this repository, never on a personal computer, and each comes with a SHA-256 checksum. The build starts the packaged app in a self-test before it is published.
- Version 1.0.0 is signed ad hoc and not yet notarized by Apple, so macOS asks once before the first launch (System Settings › Privacy & Security › Open Anyway). Notarized releases will follow.

## Limits you should know

- **Agents read what you give them.** A source can contain text that tries to steer an agent ("ignore your instructions…"). The agents are told to treat sources as material, their quotes are checked word for word against the source, and nothing they propose counts until you accept it. TraceFox flags sources and context files with typical phrases of this kind, but it cannot catch every wording. Still, read proposals before accepting them.
- **No automatic updates.** TraceFox does not check for new versions, because that would be a second connection. **TraceFox › Check for Updates…** opens this repository's releases page in your browser; compare it with the version under About TraceFox. You can also watch the repository's releases to hear about security fixes.
- **Builds you make yourself** with `npm run dmg` are signed ad hoc, not notarized.
- Anyone who can use your macOS account can read your workspace file.
