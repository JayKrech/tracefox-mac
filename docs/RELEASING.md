# Releasing TraceFox for Mac

The download is built by GitHub, not on your own Mac. When you push a version tag, the **Release** workflow builds one app for Apple silicon and Intel, signs it with your Developer ID, has Apple notarize it, and attaches `TraceFox.dmg` to a GitHub release.

The website and the README link to

```
https://github.com/JayKrech/tracefox-mac/releases/latest/download/TraceFox.dmg
```

which always points to the newest release. The link only works while the repository is public.

## One-time setup

You need a paid Apple Developer membership. All four values below go into the repository under **Settings › Secrets and variables › Actions › New repository secret**. Nobody can read a secret back once it is saved, not even you.

### 1. The Developer ID certificate

1. Create a **Developer ID Application** certificate at <https://developer.apple.com/account/resources/certificates/add> (only the Account Holder can) and install it in your login keychain.
2. Double-click `scripts/export-certificate.command`. It asks for your Mac password, copies only the Developer ID certificate and its key from the keychain, and puts the result on the clipboard.
3. Save it as the secret `MACOS_CERTIFICATE_P12_BASE64`.

The export uses the fixed password `tracefox`. That is deliberate: the certificate is only ever stored as an encrypted GitHub secret, and one value to paste is far less error-prone than two that must match.

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
