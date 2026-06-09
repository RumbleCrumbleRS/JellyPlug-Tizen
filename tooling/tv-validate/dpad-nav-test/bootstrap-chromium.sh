#!/usr/bin/env bash
# Bootstrap a real headless Chrome-for-Testing in a no-root / no-browser sandbox
# and launch it with the DevTools protocol on :9222, for the JEL-33 D-pad /
# body-focus-rescue browser verification (dpad-test.mjs).
#
# Proven on Debian 13 trixie, uid 1000, no root. Everything lands under WORK
# (default /tmp/dpadval) and is throwaway. Re-run is idempotent-ish (it will
# re-download if WORK was cleared).
#
# Usage:  ./bootstrap-chromium.sh            # bootstrap + launch on :9222
#         WORK=/tmp/foo ./bootstrap-chromium.sh
set -euo pipefail
WORK="${WORK:-/tmp/dpadval}"
PORT="${PORT:-9222}"
mkdir -p "$WORK"
cd "$WORK"

if [ ! -x "$WORK/chrome-headless-shell-linux64/chrome-headless-shell" ]; then
  echo "== downloading chrome-headless-shell =="
  VER="$(curl -sSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["channels"]["Stable"]["version"])')"
  curl -sSL -o chs.zip "https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-headless-shell-linux64.zip"
  python3 - <<'PY'
import zipfile,os
z=zipfile.ZipFile('chs.zip')
for i in z.infolist():
    z.extract(i,'.')
    m=i.external_attr>>16
    if m: os.chmod(i.filename,m)
PY
fi
BIN="$WORK/chrome-headless-shell-linux64/chrome-headless-shell"
SYS="$WORK/sysroot"

if [ ! -d "$SYS/usr/lib/x86_64-linux-gnu" ]; then
  echo "== resolving + downloading shared-lib closure via a local apt prefix =="
  R="$WORK/aptroot"
  mkdir -p "$R/var/lib/apt/lists/partial" "$R/var/cache/apt/archives/partial" "$R/var/lib/dpkg" "$WORK/debs" "$SYS"
  : > "$R/var/lib/dpkg/status"
  cat > "$R/sources.list" <<EOF
deb [trusted=yes] http://deb.debian.org/debian trixie main
deb [trusted=yes] http://deb.debian.org/debian trixie-updates main
deb [trusted=yes] http://deb.debian.org/debian-security trixie-security main
EOF
  APTOPT="-o Dir::State=$R/var/lib/apt -o Dir::State::status=$R/var/lib/dpkg/status -o Dir::Cache=$R/var/cache/apt -o Dir::Etc::sourcelist=$R/sources.list -o Dir::Etc::sourceparts=/dev/null -o Dir::Etc::preferences=/dev/null -o Dir::Etc::preferencesparts=/dev/null -o APT::Architecture=amd64"
  apt-get $APTOPT update
  ROOTS="libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 libxkbcommon0 libasound2t64 libatspi2.0-0t64 libpango-1.0-0 libcairo2 libcups2t64 libexpat1 fontconfig libfontconfig1 libdrm2 fonts-dejavu-core"
  apt-cache $APTOPT depends --recurse --no-recommends --no-suggests --no-conflicts \
    --no-breaks --no-replaces --no-enhances $ROOTS 2>/dev/null \
    | grep -v '^\s' | grep -v '<' | sort -u > "$WORK/closure.txt"
  ( cd "$WORK/debs" && apt-get $APTOPT download $(cat "$WORK/closure.txt") )
  for d in "$WORK"/debs/*.deb; do dpkg-deb -x "$d" "$SYS"; done
fi

echo "== fontconfig =="
mkdir -p "$WORK/run/home" "$WORK/run/cache" "$WORK/run/fccache" "$WORK/run/profile"
cat > "$WORK/run/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$SYS/usr/share/fonts</dir>
  <cachedir>$WORK/run/fccache</cachedir>
  <include ignore_missing="yes">$SYS/etc/fonts/conf.d</include>
</fontconfig>
EOF
export LD_LIBRARY_PATH="$SYS/usr/lib/x86_64-linux-gnu:$SYS/lib/x86_64-linux-gnu:$SYS/usr/lib"
export FONTCONFIG_FILE="$WORK/run/fonts.conf"
export HOME="$WORK/run/home" XDG_CACHE_HOME="$WORK/run/cache"
"$SYS/usr/bin/fc-cache" -f >/dev/null 2>&1 || true

echo "== launching chrome on :$PORT =="
pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true
sleep 1
nohup "$BIN" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port="$PORT" --user-data-dir="$WORK/run/profile" \
  --window-size=1280,720 about:blank > "$WORK/run/chrome.log" 2>&1 &
sleep 3
curl -s "http://127.0.0.1:$PORT/json/version" | python3 -c 'import sys,json;print("ready:",json.load(sys.stdin)["Browser"])'
echo "LD_LIBRARY_PATH / FONTCONFIG_FILE / HOME / XDG_CACHE_HOME exported above for this shell."
echo "Now run: node dpad-test.mjs"
