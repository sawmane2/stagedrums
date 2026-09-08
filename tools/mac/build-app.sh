#!/bin/bash
# Build StageDrums.app in the drum-daw folder. Safe to re-run; it replaces the bundle.
set -e
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
APP="$ROOT/StageDrums.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp tools/mac/Info.plist "$APP/Contents/Info.plist"
cp tools/mac/launcher.sh "$APP/Contents/MacOS/StageDrums"
chmod +x "$APP/Contents/MacOS/StageDrums"

# icon: render icon.svg at the sizes macOS wants, if the tools are there
if command -v sips >/dev/null && command -v iconutil >/dev/null && [ -f icon.svg ]; then
  TMP=$(mktemp -d); ICO="$TMP/StageDrums.iconset"; mkdir -p "$ICO"
  if command -v rsvg-convert >/dev/null; then RENDER() { rsvg-convert -w "$1" -h "$1" icon.svg -o "$2"; }
  elif command -v qlmanage >/dev/null; then RENDER() { qlmanage -t -s "$1" -o "$TMP" icon.svg >/dev/null 2>&1 && mv "$TMP/icon.svg.png" "$2"; }
  else RENDER() { return 1; }; fi
  ok=1
  for s in 16 32 64 128 256 512 1024; do RENDER "$s" "$ICO/icon_${s}x${s}.png" 2>/dev/null || ok=0; done
  if [ "$ok" = 1 ]; then
    cp "$ICO/icon_32x32.png"   "$ICO/icon_16x16@2x.png"  2>/dev/null || true
    cp "$ICO/icon_64x64.png"   "$ICO/icon_32x32@2x.png"  2>/dev/null || true
    cp "$ICO/icon_256x256.png" "$ICO/icon_128x128@2x.png" 2>/dev/null || true
    cp "$ICO/icon_512x512.png" "$ICO/icon_256x256@2x.png" 2>/dev/null || true
    cp "$ICO/icon_1024x1024.png" "$ICO/icon_512x512@2x.png" 2>/dev/null || true
    rm -f "$ICO/icon_64x64.png" "$ICO/icon_1024x1024.png"
    iconutil -c icns "$ICO" -o "$APP/Contents/Resources/StageDrums.icns" 2>/dev/null || true
  fi
  rm -rf "$TMP"
fi

# clear the quarantine flag so the first double-click doesn't get blocked
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
touch "$APP"   # make Finder notice the new bundle
echo "Built $APP"
