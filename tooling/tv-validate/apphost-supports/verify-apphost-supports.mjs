#!/usr/bin/env node
// JEL-46 — Compare: NativeShell.AppHost.supports() — feature flag parity.
//
// Goal: verify NativeShell.AppHost.supports(cmd) returns the correct true/false
// for every feature jellyfin-web can query, and that the TV shell's answers do
// not make a feature GATE diverge from the browser in a way that breaks the TV.
//
// How jellyfin-web's apphost actually works (decoded from the deployed bundle,
// main.jellyfin.bundle.js on the test server):
//
//   supports: function (e) {
//     return window.NativeShell
//       ? window.NativeShell.AppHost.supports(e)   // <-- inside our TV shell
//       : -1 !== S.indexOf(e.toLowerCase());        // <-- plain browser
//   }
//
// So when running inside our NativeShell, appHost.supports() defers ENTIRELY to
// NativeShell.AppHost.supports() — our hard-coded SupportedFeatures list fully
// REPLACES the browser's computed `S` array. There is no merge. That is exactly
// why this parity check matters: our list is the single source of truth for
// every feature gate on the TV.
//
// This harness needs no network. It encodes two ground-truth snapshots taken
// from the LIVE deployed jellyfin-web (provenance + re-extract commands in
// results-JEL-46.md), and reads the TV list straight from the shell sources so
// the test fails if the shell list drifts:
//
//   1. APP_FEATURES   — the complete AppFeature enum (every cmd string the web
//                       client knows), from bundle module 97339.
//   2. browserTizen() — the decoded browser `S` builder evaluated for a Tizen
//                       TV (i.A.tizen === true), i.e. what jellyfin-web's OWN
//                       browser apphost would report on a Tizen TV web browser.
//   3. CONSUMERS      — which features are actually queried via appHost.supports
//                       in the reachable bundles, and what each gate does.
//
// Exit non-zero if: the two shell lists disagree, a shell lists an unknown cmd
// that is not a known/intentional legacy string, or a CONSUMED feature gate
// diverges from the Tizen-browser baseline in a way not on the allow-list.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

let failures = 0;
const fail = (m) => {
  failures++;
  console.log("  ✗ " + m);
};
const ok = (m) => console.log("  ✓ " + m);

// ---------------------------------------------------------------------------
// 1. Read the TV shell's SupportedFeatures straight from the sources of record.
// ---------------------------------------------------------------------------
function extractSupportedFeatures(file) {
  const src = readFileSync(join(REPO, file), "utf8");
  const m = src.match(/SupportedFeatures\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("SupportedFeatures not found in " + file);
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["'],?$/g, "").replace(/["']/g, ""))
    .filter(Boolean);
}

const SHELL_SRC = "packages/shell-tizen/src/shell.js";
const BOOT_SRC = "packages/shell-tizen-bootstrap/src/boot-shell.src.js";
const tvFeatures = extractSupportedFeatures(SHELL_SRC);
const bootFeatures = extractSupportedFeatures(BOOT_SRC);

// The TV implementation, mirrored exactly from shell.js:
//   supports: cmd => !!cmd && SupportedFeatures.indexOf(String(cmd).toLowerCase()) !== -1
const tvSet = new Set(tvFeatures.map((f) => f.toLowerCase()));
const tvSupports = (cmd) => !!cmd && tvSet.has(String(cmd).toLowerCase());

console.log("\n== Shell-internal consistency ==");
if (JSON.stringify(tvFeatures) === JSON.stringify(bootFeatures)) {
  ok(`shell.js and boot-shell.src.js list the same ${tvFeatures.length} features`);
} else {
  fail("shell.js and boot-shell.src.js SupportedFeatures lists differ");
}
// shell.min.js is a release artifact — assert it carries the same list.
const min = readFileSync(join(REPO, "packages/shell-tizen/src/shell.min.js"), "utf8");
if (tvFeatures.every((f) => min.includes(`"${f}"`))) {
  ok("shell.min.js carries every source feature string");
} else {
  fail("shell.min.js is out of sync with shell.js SupportedFeatures");
}

// ---------------------------------------------------------------------------
// 2. Ground truth from the deployed jellyfin-web (see results-JEL-46.md §Provenance).
// ---------------------------------------------------------------------------

// 2a. Complete AppFeature enum — every cmd string jellyfin-web can ask about.
// Bundle module 97339 (verbatim values).
const APP_FEATURES = {
  CastMenuHashChange: "castmenuhashchange",
  Chromecast: "chromecast",
  ClientSettings: "clientsettings",
  DisplayLanguage: "displaylanguage",
  DisplayMode: "displaymode",
  DownloadManagement: "downloadmanagement",
  Exit: "exit",
  ExitMenu: "exitmenu",
  ExternalLinks: "externallinks",
  ExternalPlayerIntent: "externalplayerintent",
  FileDownload: "filedownload",
  FileInput: "fileinput",
  Fullscreen: "fullscreenchange",
  HtmlAudioAutoplay: "htmlaudioautoplay",
  HtmlVideoAutoplay: "htmlvideoautoplay",
  MultiServer: "multiserver",
  NativeBluRayPlayback: "nativeblurayplayback",
  NativeDvdPlayback: "nativedvdplayback",
  NativeIsoPlayback: "nativeisoplayback",
  PhysicalVolumeControl: "physicalvolumecontrol",
  RemoteAudio: "remoteaudio",
  RemoteControl: "remotecontrol",
  RemoteVideo: "remotevideo",
  Screensaver: "screensaver",
  Sharing: "sharing",
  SubtitleAppearance: "subtitleappearancesettings",
  SubtitleBurnIn: "subtitleburnsettings",
  TargetBlank: "targetblank",
};
const ALL_CMDS = Object.values(APP_FEATURES);

// 2b. Decoded browser `S` builder, evaluated for a Tizen TV. This is what
// jellyfin-web's OWN browser apphost reports when run as a plain web page on a
// Samsung Tizen TV browser (the closest apples-to-apples "browser version").
// env flags for a Tizen TV: tv=true, tizen=true; everything else false.
function browserTizenFeatures() {
  const env = {
    tv: true,
    tizen: true,
    operaTv: false,
    orsay: false,
    web0s: false,
    edgeUwp: false,
    xboxOne: false,
    ps4: false,
    mobile: false,
    ipad: false,
    chrome: false,
    edgeChromium: false,
    firefox: false,
    edge: false,
  };
  const navShare = false; // TV browser exposes no navigator.share
  const cueSupported = true; // modern Tizen Chromium supports ::cue styling
  const multiServerConfigured = true; // depends on server config.json; assume on
  const F = APP_FEATURES;
  const h = [];
  if (navShare) h.push(F.Sharing);
  if (!(env.edgeUwp || env.tv || env.xboxOne || env.ps4)) h.push(F.FileDownload);
  if (env.operaTv || env.tizen || env.orsay || env.web0s) h.push(F.Exit);
  if (!(env.operaTv || env.tizen || env.orsay || env.web0s || env.ps4)) h.push(F.ExternalLinks);
  if (env.edgeUwp || env.tizen || env.web0s || env.orsay || env.operaTv || env.ps4 || env.xboxOne || !env.mobile) {
    h.push(F.HtmlAudioAutoplay);
    h.push(F.HtmlVideoAutoplay);
  }
  if (!env.tv) h.push(F.Fullscreen); // builder: if(tv) return false
  if (env.tv || env.xboxOne || env.ps4 || env.mobile || env.ipad) h.push(F.PhysicalVolumeControl);
  if (!(env.tv || env.xboxOne || env.ps4)) h.push(F.RemoteControl);
  if (!(env.operaTv || env.tizen || env.orsay || env.web0s || env.edgeUwp)) h.push(F.RemoteVideo);
  h.push(F.DisplayLanguage);
  h.push(F.DisplayMode);
  h.push(F.TargetBlank);
  h.push(F.Screensaver);
  if (multiServerConfigured) h.push(F.MultiServer);
  if (!env.orsay && (env.firefox || env.ps4 || env.edge || cueSupported)) h.push(F.SubtitleAppearance);
  if (!env.orsay) h.push(F.SubtitleBurnIn);
  if (!(env.tv || env.ps4 || env.xboxOne)) h.push(F.FileInput);
  if (env.chrome || env.edgeChromium) h.push(F.Chromecast);
  return new Set(h);
}
const browserSet = browserTizenFeatures();
const browserSupports = (cmd) => browserSet.has(String(cmd).toLowerCase());

// 2c. Features actually QUERIED via appHost.supports() in the reachable bundles,
// and what each gate controls. (cmds not listed here are declared in the enum
// but never consumed in the crawled bundles -> the answer is inert today.)
// `consumed: false` means: no appHost.supports() call site was found in the
// eagerly-reachable bundles; the flag may still be read by a deeper route chunk.
const CONSUMERS = {
  exit: { consumed: true, gate: "app exit pathway (NativeShell.AppHost.exit -> tizen exit)" },
  exitmenu: { consumed: true, gate: "renders the 'Exit' item in the user menu drawer" },
  multiserver: { consumed: true, gate: "shows 'Select Server' / multi-server switching" },
  externallinks: { consumed: true, gate: "renders external project/info links (jellyfin.org, GitHub)" },
  targetblank: { consumed: true, gate: "open links in a new tab vs same window" },
  sharing: { consumed: true, gate: "Share button (navigator.share)" },
  fullscreenchange: { consumed: true, gate: "fullscreen toggle button" },
  physicalvolumecontrol: { consumed: true, gate: "hides on-screen volume slider (hardware controls volume)" },
  remoteaudio: { consumed: true, gate: "remote/cast audio playback target" },
  remotecontrol: { consumed: true, gate: "cast/remote-control sender, 'play on another device'" },
  remotevideo: { consumed: true, gate: "play items where IsRemote===true (blocks them when false)" },
  castmenuhashchange: { consumed: true, gate: "cast menu hash-change routing" },
  clientsettings: { consumed: true, gate: "client-settings UI" },
  downloadmanagement: { consumed: true, gate: "downloads management UI" },
  // declared in enum, no appHost.supports() consumer found in reachable bundles:
  displaymode: { consumed: false, gate: "desktop window display-mode setting (no caller in reachable bundles; irrelevant to a fullscreen TV)" },
  displaylanguage: { consumed: false, gate: "display-language selection (read elsewhere, not via appHost.supports here)" },
  screensaver: { consumed: false, gate: "screensaver behavior" },
  htmlaudioautoplay: { consumed: false, gate: "audio autoplay policy" },
  htmlvideoautoplay: { consumed: false, gate: "video autoplay policy" },
  subtitleappearancesettings: { consumed: false, gate: "subtitle appearance settings page" },
  subtitleburnsettings: { consumed: false, gate: "subtitle burn-in settings" },
};

// Intentional / accepted divergences between TV shell and the Tizen-browser
// baseline. Each must have a documented reason; anything else is a failure.
const ALLOWED_DIVERGENCES = {
  exitmenu:
    "TV intentionally reports true so jellyfin-web shows an in-app Exit item — " +
    "a TV has no browser chrome to close the app. Beneficial, not a bug.",
  multiserver:
    "TV hard-codes true; the shell implements selectServer() (clear stored URL + " +
    "reload to connect screen). Browser baseline is config-gated, so 'true' is a " +
    "superset, never a regression.",
};

// Legacy strings the TV list carries that no current AppFeature enum value
// matches. They are never queried, so they are inert — but flagged as stale.
const KNOWN_LEGACY = {
  externallinkdisplay: "old name; current jellyfin-web queries 'externallinks' (TV correctly reports false for that).",
  otherapppromotions: "no AppFeature enum entry in current jellyfin-web; never queried.",
};

// ---------------------------------------------------------------------------
// 3. Per-command comparison.
// ---------------------------------------------------------------------------
console.log("\n== supports(cmd): TV shell vs Tizen-browser baseline ==");
console.log(
  "  " +
    "cmd".padEnd(24) +
    "TV".padEnd(6) +
    "browser".padEnd(9) +
    "consumed".padEnd(10) +
    "gate",
);
const divergences = [];
for (const cmd of ALL_CMDS) {
  const tv = tvSupports(cmd);
  const br = browserSupports(cmd);
  const info = CONSUMERS[cmd] || { consumed: false, gate: "(declared, no known gate)" };
  const mark = tv === br ? " " : "Δ";
  console.log(
    `  ${mark} ` +
      cmd.padEnd(22) +
      String(tv).padEnd(6) +
      String(br).padEnd(9) +
      String(info.consumed).padEnd(10) +
      info.gate,
  );
  if (tv !== br) divergences.push({ cmd, tv, br, info });
}

// ---------------------------------------------------------------------------
// 4. Assertions.
// ---------------------------------------------------------------------------
console.log("\n== Divergence review ==");
for (const d of divergences) {
  const allowed = ALLOWED_DIVERGENCES[d.cmd];
  if (allowed) {
    ok(`${d.cmd}: TV=${d.tv} browser=${d.br} — intentional. ${allowed}`);
  } else if (!d.info.consumed) {
    ok(`${d.cmd}: TV=${d.tv} browser=${d.br} — flag not consumed by any gate, inert. ${d.info.gate}`);
  } else {
    fail(`${d.cmd}: TV=${d.tv} browser=${d.br} — CONSUMED gate diverges with no documented reason (gate: ${d.info.gate})`);
  }
}
if (!divergences.length) ok("no divergences at all");

console.log("\n== Stale / unknown strings in the TV list ==");
for (const f of tvFeatures) {
  const lc = f.toLowerCase();
  const isEnum = ALL_CMDS.includes(lc);
  if (isEnum) continue;
  if (KNOWN_LEGACY[lc]) {
    ok(`'${f}' is a known-inert legacy string: ${KNOWN_LEGACY[lc]}`);
  } else {
    fail(`'${f}' is not a current AppFeature and is not a documented legacy string`);
  }
}

console.log("\n== Spot checks called out in JEL-46 ==");
const spot = (cmd, expTv, why) => {
  const got = tvSupports(cmd);
  if (got === expTv) ok(`supports('${cmd}') === ${expTv} on TV — ${why}`);
  else fail(`supports('${cmd}') === ${got} on TV, expected ${expTv}`);
};
spot("exit", true, "TV must be able to exit the app (tizen.application exit)");
spot("displaymode", false, "no consumer in reachable bundles; browser pushes it but nothing gates on it");
spot("remotevideo", false, "matches jellyfin-web's own Tizen baseline (both block IsRemote video) — consistent");

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED — supports() parity verified; only intentional/inert divergences.\n"
    : `\n${failures} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
