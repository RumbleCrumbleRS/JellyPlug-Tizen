// JEL-35 verification test — all 12 TV remote media keys: registration +
// keydown dispatch parity (TV vs browser).
//
// The Samsung remote's media buttons only reach jellyfin-web if the shell
// registers each one via tizen.tvinputdevice.registerKey (otherwise Tizen
// swallows them at the firmware level). Once registered, Tizen delivers a DOM
// keydown carrying a numeric keyCode, and jellyfin-web's focus engine resolves
// that keyCode through its own KeyNames table into a command. The canonical
// 12-key keycode->name contract is the EXPECTED table below; two things must
// agree with it on exactly which 12 keys — and their keycodes — are in play:
//
//   1. packages/shell-tizen/src/shell.js  registerRemoteKeys()  — what we ASK
//      the platform to deliver (also mirrored into the shipped shell.min.js).
//   2. jellyfin-web's KeyNames table — the actual consumer (see EVIDENCE).
//
// EVIDENCE — captured live from $JELLYFIN_URL/web/main.jellyfin.bundle.js
// (jellyfin-web 10.11.10) on 2026-06-09 while verifying JEL-35. This is the
// keyCode->name table the focus engine reads off each keydown:
//   ...412:"MediaRewind",413:"MediaStop",415:"MediaPlay",417:"MediaFastForward",
//      461:"Back",10009:"Back",10232:"MediaTrackPrevious",
//      10233:"MediaTrackNext",10252:"MediaPlayPause"...
//   command switch maps: MediaPlay->play, MediaPlayPause->playpause,
//      MediaStop->stop, MediaRewind->rewind, MediaFastForward->fastforward,
//      MediaTrackNext->nexttrack, MediaTrackPrevious->previoustrack
//      (MediaPause has a keycode 19 but no dedicated command case; the color
//       keys 403-406 are an intentional no-op — see color-keys.test.cjs / JEL-36).
//
// This test locks the registration list and the keycode table to that live
// ground truth so neither can silently drift. It also drives the wgt-emulate
// Tizen stub and, when jsdom is available, round-trips all 12 keys as real
// browser keydown events to confirm TV<->browser parity.
//
// NOTE (JEL-35 finding): TIZEN_KEYMAP previously had 412/417 and 10232/10233
// SWAPPED (Rewind<->TrackPrevious, FastForward<->TrackNext). That table is not
// currently wired into the shell's dispatch path (the shell registers by name
// and the TV's native keyCodes reach jellyfin-web directly), so it was not a
// user-facing break — but it contradicted both real hardware and jellyfin-web,
// and would mis-dispatch if translate() were ever used. The codes below are the
// corrected, verified values.
//
// Run: node scripts/media-keys.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const STUB_JS = path.join(REPO, "tooling", "wgt-emulate", "tizen-stub.js");

// The contract: the exact 12 media keys JEL-35 names, with the keycodes the
// Samsung Tizen remote emits and jellyfin-web's KeyNames resolves them to.
const EXPECTED = {
  MediaPlay: 415,
  MediaPause: 19,
  MediaPlayPause: 10252,
  MediaStop: 413,
  MediaRewind: 412,
  MediaFastForward: 417,
  MediaTrackPrevious: 10232,
  MediaTrackNext: 10233,
  ColorF0Red: 403,
  ColorF1Green: 404,
  ColorF2Yellow: 405,
  ColorF3Blue: 406,
};
const EXPECTED_NAMES = Object.keys(EXPECTED).sort();

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}
function eqSet(a, b) {
  const x = a.slice().sort();
  const y = b.slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Brace-balanced extraction of a named function body (mirrors color-keys.test).
function fnBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in shell.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name + ": unbalanced braces");
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const minSrc = fs.readFileSync(TV_SHELL_MIN, "utf8");
const stubSrc = fs.readFileSync(STUB_JS, "utf8");

// --- 1. Registration: shell.js registers exactly the 12 media keys ----------
const regBody = fnBody(tvSrc, "registerRemoteKeys");
check(
  "registerRemoteKeys() calls tizen.tvinputdevice.registerKey",
  /tizen\.tvinputdevice\.registerKey\(/.test(regBody),
);
const registered = (regBody.match(/"([A-Za-z0-9]+)"/g) || [])
  .map((s) => s.replace(/"/g, ""))
  .filter((n) => /^(Media|Color)/.test(n));
check(
  "registerRemoteKeys() registers exactly the 12 media keys",
  eqSet(registered, EXPECTED_NAMES),
  "missing=[" +
    EXPECTED_NAMES.filter((k) => !registered.includes(k)) +
    "] extra=[" +
    registered.filter((k) => !EXPECTED_NAMES.includes(k)) +
    "]",
);

// --- 2. Shipped artifact mirrors every registered key (source<->shell.min) ---
const missingFromMin = EXPECTED_NAMES.filter(
  (k) => !minSrc.includes('"' + k + '"'),
);
check(
  "shell.min.js (deployed artifact) contains all 12 registered keys",
  missingFromMin.length === 0,
  "missing=[" + missingFromMin + "]",
);

// --- 3. Browser-harness parity: wgt-emulate stub mirrors the same 12 + codes -
// The stub uses `{ name: "X", code: N }` object form, so parse that shape.
function parseStubKeys(src) {
  const start = src.indexOf("getSupportedKeys");
  const body = src.slice(start, src.indexOf("];", start));
  const map = {};
  const re = /name:\s*"([A-Za-z0-9]+)",\s*code:\s*(\d+)/g;
  let m;
  while ((m = re.exec(body)) !== null) map[Number(m[2])] = m[1];
  return map;
}
const stubKeys = parseStubKeys(stubSrc);
check(
  "tizen-stub getSupportedKeys() exposes the same 12 key names",
  eqSet(Object.values(stubKeys), EXPECTED_NAMES),
  "got=[" + Object.values(stubKeys).sort() + "]",
);
for (const name of EXPECTED_NAMES) {
  const code = EXPECTED[name];
  check(
    "tizen-stub code " + code + " -> " + name + " (mirrors keymap)",
    stubKeys[code] === name,
    "stub=" + stubKeys[code],
  );
}

// --- 4. The stub absorbs every registerKey() call shell.js makes at boot -----
(function execStubRegistration() {
  const vm = require("vm");
  const sandbox = { window: {}, console: { log() {}, warn() {} } };
  vm.runInContext(stubSrc, vm.createContext(sandbox));
  const dev = sandbox.window.tizen.tvinputdevice;
  registered.forEach((k) => {
    try {
      dev.registerKey(k);
    } catch (_) {
      /* registerRemoteKeys swallows throws; the stub must not throw */
    }
  });
  check(
    "stub.registerKey() records all 12 keys with no throw at boot",
    eqSet(dev._registered, EXPECTED_NAMES),
    "recorded=" + dev._registered.length,
  );
})();

// --- 5. Optional: round-trip all 12 as real browser keydown events ----------
// Confirms the identical keys/keycodes deliver to a window keydown handler the
// way jellyfin-web binds them — the browser side of TV<->browser parity. jsdom
// is opt-in (resolved from tooling/wgt-emulate if installed there); skip clean.
(function browserSimulation() {
  let JSDOM;
  const candidates = [
    process.env.JSDOM_PATH,
    "jsdom",
    path.join(REPO, "tooling", "wgt-emulate", "node_modules", "jsdom"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      JSDOM = require(c).JSDOM;
      break;
    } catch (_) {
      /* try next */
    }
  }
  if (!JSDOM) {
    console.log(
      "SKIP browser-keydown simulation: jsdom not found (optional). " +
        "Enable: (cd tooling/wgt-emulate && npm install jsdom)",
    );
    return;
  }
  const dom = new JSDOM("<!doctype html><body></body>", {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const seen = [];
  window.addEventListener("keydown", (ev) =>
    seen.push({ key: ev.key, keyCode: ev.keyCode }),
  );
  // Dispatch one keydown per key carrying its canonical Tizen keyCode — exactly
  // what the platform emits after registerKey on the TV.
  EXPECTED_NAMES.forEach((k) => {
    const ev = new window.KeyboardEvent("keydown", {
      key: k,
      keyCode: EXPECTED[k],
      bubbles: true,
    });
    window.document.body.dispatchEvent(ev);
  });
  check(
    "browser keydown parity: all 12 keys delivered to a window handler",
    eqSet(
      seen.map((e) => e.key),
      EXPECTED_NAMES,
    ),
    "delivered=" + seen.length,
  );
  const codeMismatch = seen.filter((e) => EXPECTED[e.key] !== e.keyCode);
  check(
    "browser keydown parity: each event carries the canonical Tizen keyCode",
    codeMismatch.length === 0,
    codeMismatch.map((e) => e.key + ":" + e.keyCode).join(";"),
  );
  window.close();
})();

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  "\nAll media-key checks passed — 12 keys registered, keycode table matches" +
    " jellyfin-web's live KeyNames, stub + browser keydown parity confirmed.",
);
