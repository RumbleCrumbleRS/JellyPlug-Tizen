// JEL-42 — live ground-truth verifier for the playback command contract.
//
// The deterministic unit test (packages/shell-tizen/scripts/playback-controls
// .test.cjs) PINS the jellyfin-web KeyName->command mapping. This script
// re-derives that mapping from the LIVE web bundle the server actually serves
// (the exact same JS that runs in a desktop browser AND inside the Tizen
// webview), so we can confirm the pinned contract has not drifted with a
// server upgrade. It needs no media decode — it reads the shipped JS — so it is
// fast and deterministic.
//
// Run:  JELLYFIN_URL=https://host node tooling/tv-validate/playback-controls/verify-command-contract.mjs
// Skips cleanly (exit 0) when JELLYFIN_URL is unset.

const BASE = (process.env.JELLYFIN_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.log("SKIP: JELLYFIN_URL not set — live contract check skipped.");
  process.exit(0);
}

// What the pinned contract claims, KeyName -> { code, command|null }.
const EXPECTED = {
  MediaPlay: { code: 415, command: "play" },
  MediaPlayPause: { code: 10252, command: "playpause" },
  MediaStop: { code: 413, command: "stop" },
  MediaRewind: { code: 412, command: "rewind" },
  MediaFastForward: { code: 417, command: "fastforward" },
  MediaTrackPrevious: { code: 10232, command: "previoustrack" },
  MediaTrackNext: { code: 10233, command: "nexttrack" },
};

const url = BASE + "/web/main.jellyfin.bundle.js";
const res = await fetch(url);
if (!res.ok) {
  console.error("FAIL: could not fetch " + url + " (HTTP " + res.status + ")");
  process.exit(1);
}
const src = await res.text();
console.log("Fetched " + url + " (" + src.length + " bytes)\n");

let failures = 0;
const ok = (n, c, d) => {
  console[c ? "log" : "error"](
    (c ? "OK:   " : "FAIL: ") + n + (!c && d ? "  — " + d : ""),
  );
  if (!c) failures++;
};

// 1. KeyNames keycode -> name table (focus engine reads this off each keydown).
const keyNames = {};
for (const m of src.matchAll(/(\d+):"(Media[A-Za-z]+)"/g))
  keyNames[Number(m[1])] = m[2];
for (const [name, { code }] of Object.entries(EXPECTED)) {
  ok(
    `KeyNames[${code}] === ${name}`,
    keyNames[code] === name,
    "live=" + keyNames[code],
  );
}

// 2. Keyboard command switch: case"<KeyName>":x.handleCommand("<command>").
const cmds = {};
for (const m of src.matchAll(
  /case"(Media[A-Za-z]+)":[a-zA-Z.]+handleCommand\("([a-z]+)"\)/g,
))
  cmds[m[1]] = m[2];
for (const [name, { command }] of Object.entries(EXPECTED)) {
  if (!command) continue;
  ok(
    `${name} -> handleCommand("${command}")`,
    cmds[name] === command,
    "live=" + cmds[name],
  );
}

// 3. Seek-bar position changes route through the same command channel.
ok(
  'Command "Seek" routes to playbackManager.seek(SeekPositionTicks)',
  /"Seek"===[^;]{0,40}seek\([^)]*SeekPositionTicks/.test(src),
);

console.log("");
if (failures) {
  console.error(failures + " live contract check(s) FAILED — bundle drifted.");
  process.exit(1);
}
console.log("Live command contract matches the pinned ground truth.");
