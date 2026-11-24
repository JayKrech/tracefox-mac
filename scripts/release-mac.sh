#!/bin/bash
# Builds the signed, notarized TraceFox disk image (.dmg) that people can download.
# Runs on a Mac with Xcode Command Line Tools and Node.js 22.12 or newer, and on GitHub Actions
# (see .github/workflows/release.yml and docs/RELEASING.md).
#
# On your own Mac, one-time setup:
#   1. Create a "Developer ID Application" certificate
#      (Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application).
#   2. Create an app-specific password at account.apple.com, then store it for notarization:
#      xcrun notarytool store-credentials tracefox-notary \
#        --apple-id you@example.com --team-id YOURTEAMID --password xxxx-xxxx-xxxx-xxxx
# Then:  npm run release:mac
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
KEYCHAIN="${SIGN_KEYCHAIN:-}"

# Developer ID certificate: from SIGN_IDENTITY, or the first one found in the keychain.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  IDENTITY="$SIGN_IDENTITY"
elif [ -n "$KEYCHAIN" ]; then
  IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/Developer ID Application/{print $2; exit}')
else
  IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')
fi
if [ -z "$IDENTITY" ]; then
  echo "No 'Developer ID Application' certificate found. See the setup notes at the top of this script." >&2
  exit 1
fi
echo "Signing as: $IDENTITY"

# Notarization credentials: Apple ID values from the environment (GitHub Actions),
# otherwise a profile stored in the keychain (your own Mac).
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  export NOTARY_PROFILE="${NOTARY_PROFILE:-tracefox-notary}"
  NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
fi

npm ci
rm -rf out

# One app for Apple silicon and Intel, signed with the hardened runtime, notarized and stapled.
SIGN_IDENTITY="$IDENTITY" ARCH=universal node scripts/package-mac.mjs

APP="out/TraceFox-darwin-universal/TraceFox.app"
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
# Gatekeeper's own verdict. Informational, because build machines can have Gatekeeper switched off.
spctl --assess --type execute --verbose "$APP" || echo "Note: spctl did not accept the app on this machine."

# Disk image with the usual drag-to-Applications layout.
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="out/TraceFox-$VERSION.dmg"
hdiutil create -volname "TraceFox" -srcfolder "$STAGE" -ov -format ULMO "$DMG"
rm -rf "$STAGE"

if [ -n "$KEYCHAIN" ]; then
  codesign --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp "$DMG"
else
  codesign --sign "$IDENTITY" --timestamp "$DMG"
fi
xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG" || echo "Note: spctl did not accept the disk image on this machine."

echo
echo "Ready to upload: $DMG"
shasum -a 256 "$DMG"
