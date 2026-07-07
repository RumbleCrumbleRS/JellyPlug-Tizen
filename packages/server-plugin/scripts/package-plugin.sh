#!/usr/bin/env bash
# Package Jellyfin.Plugin.JellyPlugShell into a Jellyfin plugin zip + emit the
# plugin-repository manifest entry (versions[] element) for plugin-repo/manifest.json.
#
# usage: package-plugin.sh [output_dir]     (default: packages/server-plugin/dist)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$HERE/../Jellyfin.Plugin.JellyPlugShell"
OUT="${1:-$HERE/../dist}"
VERSION="$(grep -oE '<Version>[0-9.]+</Version>' "$PROJ/Jellyfin.Plugin.JellyPlugShell.csproj" | grep -oE '[0-9.]+')"
TARGET_ABI="10.11.0.0"
GUID="6f97e5aa-cf2f-4b48-8b73-6be92f4b7d31"

mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

dotnet publish "$PROJ" -c Release -o "$STAGE/publish" >/dev/null

# Plugin payload: our assembly + non-framework deps (Jint + its parser).
cp "$STAGE/publish/Jellyfin.Plugin.JellyPlugShell.dll" "$STAGE/"
cp "$STAGE/publish/Jint.dll" "$STAGE/"
cp "$STAGE/publish/Acornima.dll" "$STAGE/"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STAGE/meta.json" <<EOF
{
  "guid": "$GUID",
  "name": "JellyPlug Shell",
  "description": "Serves the JellyPlug hosted TV shell (/shell/) plus the pre-lowered transpile drop, and rebuilds the drop in-process on a scheduled task.",
  "overview": "Makes every JellyPlug Tizen TV fast: hosts the shell self-update channel and the tx-drop straight from the Jellyfin server. No SSH, no filesystem access, no cron.",
  "owner": "RumbleCrumbleRS",
  "category": "General",
  "version": "$VERSION",
  "changelog": "",
  "targetAbi": "$TARGET_ABI",
  "timestamp": "$TIMESTAMP",
  "status": "Active",
  "autoUpdate": true,
  "imagePath": ""
}
EOF

ZIP="$OUT/jellyplug-shell_$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && python3 -m zipfile -c "$ZIP" Jellyfin.Plugin.JellyPlugShell.dll Jint.dll Acornima.dll meta.json)

MD5="$(md5sum "$ZIP" | cut -d' ' -f1)"
cat > "$OUT/manifest-version-entry.json" <<EOF
{
  "version": "$VERSION",
  "changelog": "See https://github.com/RumbleCrumbleRS/JellyPlug-Tizen/releases/tag/server-plugin-v$VERSION",
  "targetAbi": "$TARGET_ABI",
  "sourceUrl": "https://github.com/RumbleCrumbleRS/JellyPlug-Tizen/releases/download/server-plugin-v$VERSION/jellyplug-shell_$VERSION.zip",
  "checksum": "$MD5",
  "timestamp": "$TIMESTAMP"
}
EOF

echo "zip=$ZIP"
echo "md5=$MD5"
echo "version-entry=$OUT/manifest-version-entry.json"
