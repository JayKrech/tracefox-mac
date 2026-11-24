# Releasing TraceFox for Mac

The download is built by GitHub, not on your own Mac. When you push a version tag, the **Release** workflow builds one app for Apple silicon and Intel, signs it with your Developer ID, has Apple notarize it, and attaches `TraceFox.dmg` to a GitHub release.

The website and the README link to

```
https://github.com/JayKrech/tracefox-mac/releases/latest/download/TraceFox.dmg
```

which always points to the newest release. The link only works while the repository is public.

## One-time setup

You need a paid Apple Developer membership. All five values below go into the repository under **Settings › Secrets and variables › Actions › New repository secret**. Nobody can read a secret back once it is saved, not even you.

### 1. The Developer ID certificate

1. If you do not have one yet: in Xcode, open **Settings › Accounts**, select your team, choose **Manage Certificates**, then **+ › Developer ID Application**. Only the Account Holder of the team can create it.
2. Open **Keychain Access**, choose the **login** keychain and **My Certificates**. Find **Developer ID Application: Your Name (TEAMID)**.
3. Right-click it, choose **Export**, save it as `DeveloperID.p12` on your Desktop and give it a password.
4. Copy the file as text:
   ```sh
   base64 -i ~/Desktop/DeveloperID.p12 | pbcopy
   ```
5. Save two secrets:
   - `MACOS_CERTIFICATE_P12_BASE64`: paste from the clipboard
   - `MACOS_CERTIFICATE_PASSWORD`: the password from step 3
6. Delete `DeveloperID.p12` from your Desktop.

### 2. Notarization

1. At <https://account.apple.com>, open **Sign-In and Security › App-Specific Passwords** and create one named "TraceFox notarization".
2. Find your Team ID at <https://developer.apple.com/account> under **Membership details**.
3. Save three secrets:
   - `APPLE_ID`: the email address of your Apple Developer account
   - `APPLE_TEAM_ID`: the ten-character Team ID
   - `APPLE_APP_SPECIFIC_PASSWORD`: the password from step 1

## Try it before the first release

Open **Actions › Release › Run workflow**. This builds the disk image without publishing anything. When the run has finished, download **TraceFox-dmg** from the run page.

- With the secrets set, this is the same signed and notarized image a release would get. Open it on a Mac: it should start without a warning.
- Without the secrets, the image is signed ad hoc, for testing only.

## Release a version

```sh
npm version 1.0.1        # sets the version, commits, and creates the tag v1.0.1
git push --follow-tags
```

For the very first release the version is already `1.0.0`, so only the tag is needed:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow stops if the tag does not match the version in `package.json`, or if the signing secrets are missing. When the run has finished, the release appears under **Releases** with `TraceFox.dmg` attached.

## Build a release on your own Mac instead

`npm run release:mac` does the same on your Mac. The one-time setup for that is described at the top of `scripts/release-mac.sh`.
