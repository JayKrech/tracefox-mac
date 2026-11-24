#!/bin/bash
# Builds TraceFox-<version>.dmg on a Mac without an Apple Developer account.
# The app is signed "ad hoc": it runs on this Mac, and on other Macs after
# right-click > Open (or System Settings > Privacy & Security > Open Anyway).
# For a download that opens without warnings, use: npm run release:mac
#
# Needs Node.js 22.12 or newer. Everything it prints also goes to build.log.
set -o pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
OUT_DIR="${TF_OUT_DIR:-$PROJECT}"
LOG="$OUT_DIR/build.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

fail() { echo; echo "BUILD FAILED: $1"; exit 1; }

echo "TraceFox DMG build, $(date)"

[ "$(uname -s)" = "Darwin" ] || fail "This script has to run on macOS."

node_ok() {
  command -v node >/dev/null 2>&1 && node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
}
# Use the Node that is already on the PATH. If it is missing or too old, look in the
# Homebrew locations, then in nvm.
if ! node_ok; then export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; fi
if ! node_ok; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; fi
  if command -v nvm >/dev/null 2>&1; then
    for v in 24 23 22; do nvm use "$v" >/dev/null 2>&1 && node_ok && break; done
  fi
fi
if ! node_ok; then
  have="none"; command -v node >/dev/null 2>&1 && have="$(node -v)"
  fail "Node.js 22.12 or newer is needed (found: $have). Install it with 'nvm install 22' or from https://nodejs.org, then run this again."
fi
set -u
echo "Node $(node -v), npm $(npm -v), $(uname -m)"

VERSION=$(node -p "require('./package.json').version")

echo; echo "== 1/4 Installing build tools (about 200 MB, from npm)"
npm ci || fail "npm ci did not finish. Check the internet connection and run this again."

echo; echo "== 2/4 Packaging the app"
rm -rf out
ARCH_BUILT=universal
ARCH=universal node scripts/package-mac.mjs || true
if [ ! -d "out/TraceFox-darwin-universal/TraceFox.app" ]; then
  # The Apple silicon + Intel merge needs Xcode Command Line Tools. Without them, build for this Mac only.
  case "$(uname -m)" in arm64) ARCH_BUILT=arm64 ;; *) ARCH_BUILT=x64 ;; esac
  echo; echo "Universal build did not work. Building for this Mac only ($ARCH_BUILT)."
  rm -rf out
  ARCH=$ARCH_BUILT node scripts/package-mac.mjs || fail "Packaging did not finish."
fi
APP="out/TraceFox-darwin-$ARCH_BUILT/TraceFox.app"
[ -d "$APP" ] || fail "Packaging finished, but $APP is missing."

echo; echo "== 3/4 Signing (ad hoc)"
codesign --force --deep --sign - "$APP" || fail "codesign did not finish."
codesign --verify --deep --strict "$APP" || fail "The signature did not verify."

echo; echo "== 4/4 Creating the disk image"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/" || fail "Could not copy the app."
ln -s /Applications "$STAGE/Applications"
NAME="TraceFox-$VERSION.dmg"
[ "$ARCH_BUILT" = "universal" ] || NAME="TraceFox-$VERSION-$ARCH_BUILT.dmg"
DMG="out/$NAME"
hdiutil create -volname "TraceFox" -srcfolder "$STAGE" -ov -format ULMO "$DMG" || fail "hdiutil did not finish."
rm -rf "$STAGE"
hdiutil verify "$DMG" >/dev/null || fail "The disk image did not verify."

FINAL="$DMG"
if [ "$OUT_DIR" != "$PROJECT" ]; then cp -f "$DMG" "$OUT_DIR/$NAME" && FINAL="$OUT_DIR/$NAME"; fi

echo
echo "BUILD OK: $FINAL ($(du -h "$FINAL" | cut -f1), $ARCH_BUILT)"
open -R "$FINAL" 2>/dev/null || true
