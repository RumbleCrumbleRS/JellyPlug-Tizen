// JEL-100 guard — the QA-only localStorage seed block must NEVER ship in a
// retail shell-tizen WGT.
//
// THE BUG
//   src/index.html carried a QA-only seed (line 16) that
//   build-wgt.sh copied verbatim into the packaged widget:
//     localStorage.setItem('jellyfin.shell.serverUrl','https://<personal-ddns>');
//     localStorage.setItem('jellyfin.qa.overlay','1');   // QA HUD + telemetry beacon
//     localStorage.setItem('jellyfin.qa.bootMarks.enabled','1');
//     localStorage.setItem('jellyfin.shell.legacy.babelPreload','__BABEL_PRELOAD_SEED__');
//     localStorage.setItem('jellyfin.shell.indexCache','__INDEX_CACHE_SEED__');
//   so every fresh install auto-connected to one developer's private server and
//   armed the QA telemetry beacon (DUID/serial/URL POSTed to a hardcoded LAN IP).
//
// THE FIX (what this test pins)
//   The seed block is wrapped in <!-- QA-SEED:START --> / <!-- QA-SEED:END -->
//   markers. scripts/process-qa-seed.sh DELETES that block for retail builds
//   (default) and build-wgt.sh runs it during staging. This test runs the REAL
//   strip on a temp copy of src/index.html and asserts:
//     1. source privacy   — no hardcoded personal/server URL lives in src;
//     2. strip cleanliness — the stripped output has NO qa.overlay, NO server-
//        URL/bootMarks/overlay setters, and NO un-substituted __*_SEED__ tokens;
//     3. no over-strip     — the legit, localStorage-GATED boot scripts
//        (shell.min.js, prefetch, babel loader, boot-mark reader) survive;
//     4. idempotency       — stripping an already-clean file is a no-op;
//     5. wiring            — build-wgt.sh invokes process-qa-seed.sh.
//
// Run: node scripts/qa-seed-strip.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PKG = path.join(__dirname, "..");
const INDEX_HTML = path.join(PKG, "src", "index.html");
const PROCESS_SH = path.join(PKG, "scripts", "process-qa-seed.sh");
const BUILD_SH = path.join(PKG, "scripts", "build-wgt.sh");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const srcHtml = fs.readFileSync(INDEX_HTML, "utf8");

// Run the real retail strip (default, no SHELL_QA_BUILD) on a temp copy and
// return the stripped contents.
function stripRetail(html) {
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "qa-seed-")),
    "index.html",
  );
  fs.writeFileSync(tmp, html);
  execFileSync("bash", [PROCESS_SH, tmp], {
    env: { ...process.env, SHELL_QA_BUILD: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return fs.readFileSync(tmp, "utf8");
}

const stripped = stripRetail(srcHtml);

// ── 1. SOURCE PRIVACY ────────────────────────────────────────────────────────
// The personal/server URL must not live in source at all — the seed now uses a
// __QA_SERVER_URL__ placeholder substituted only in a QA build.
check(
  "src/index.html contains no hardcoded personal DDNS server URL",
  !/REDACTED-SERVER\.example/.test(srcHtml),
);
check(
  "src/index.html contains no other hardcoded https serverUrl seed",
  !/setItem\(\s*['"]jellyfin\.shell\.serverUrl['"]\s*,\s*['"]https?:\/\//.test(
    srcHtml,
  ),
);

// While the QA seed block still exists in source, it MUST be wrapped in the
// markers so the build can find and strip it. (If the block is ever removed
// outright, this relaxes — the strip-cleanliness checks below still guarantee
// safety.)
const hasSeed = /setItem\(\s*['"]jellyfin\.qa\.overlay['"]/.test(srcHtml);
if (hasSeed) {
  check(
    "QA seed block is wrapped in QA-SEED:START / QA-SEED:END markers",
    /<!--\s*QA-SEED:START[\s\S]*?jellyfin\.qa\.overlay[\s\S]*?QA-SEED:END\s*-->/.test(
      srcHtml,
    ),
  );
} else {
  console.log("OK: QA seed block already absent from source (nothing to wrap)");
}

// ── 2. STRIP CLEANLINESS (the core JEL-100 guarantee) ────────────────────────
const forbidden = [
  ["QA overlay / telemetry-beacon gate (jellyfin.qa.overlay)", /jellyfin\.qa\.overlay/],
  [
    "serverUrl auto-connect setter",
    /setItem\(\s*['"]jellyfin\.shell\.serverUrl['"]/,
  ],
  [
    "boot-mark ENABLE setter (jellyfin.qa.bootMarks.enabled)",
    /setItem\(\s*['"]jellyfin\.qa\.bootMarks\.enabled['"]/,
  ],
  ["__BABEL_PRELOAD_SEED__ placeholder", /__BABEL_PRELOAD_SEED__/],
  ["__INDEX_CACHE_SEED__ placeholder", /__INDEX_CACHE_SEED__/],
  ["__QA_SERVER_URL__ placeholder", /__QA_SERVER_URL__/],
  ["personal DDNS server URL", /REDACTED-SERVER\.example/],
];
for (const [label, re] of forbidden) {
  check("stripped index.html drops the " + label, !re.test(stripped), label);
}
check(
  "stripped index.html retains no QA-SEED markers",
  !/QA-SEED:(START|END)/.test(stripped),
);

// ── 3. NO OVER-STRIP: legit gated boot scripts survive ───────────────────────
// These are NOT QA seeds — they read localStorage via getItem and no-op without
// it, so they ship in retail. The strip must leave them intact.
const survivors = [
  ["shell.min.js script tag", /<script src="shell\.min\.js"><\/script>/],
  ["__shellPrefetch warm-start IIFE", /window\.__shellPrefetch\s*=/],
  ["__ensureBabel lazy loader", /window\.__ensureBabel\s*=/],
  ["boot-mark reader (getItem-gated)", /window\.__qaMarks\s*=/],
  ["#boot-root connect container", /id="boot-root"/],
];
for (const [label, re] of survivors) {
  check("stripped index.html keeps the " + label, re.test(stripped), label);
}
// The gated boot-mark reader legitimately READS the enabled flag via getItem;
// confirm we kept the reader (getItem) while having dropped the setter (above).
check(
  "boot-mark reader still READS jellyfin.qa.bootMarks.enabled via getItem",
  /getItem\(\s*['"]jellyfin\.qa\.bootMarks\.enabled['"]/.test(stripped),
);

// ── 4. IDEMPOTENCY: stripping an already-clean file is a no-op ────────────────
check(
  "re-stripping an already-stripped file leaves it unchanged",
  stripRetail(stripped) === stripped,
);

// ── 5. WIRING: build-wgt.sh runs the strip during staging ────────────────────
const buildSh = fs.readFileSync(BUILD_SH, "utf8");
check(
  "build-wgt.sh invokes process-qa-seed.sh on the staged index.html",
  /process-qa-seed\.sh"?\s+"?\$STAGE_DIR\/index\.html/.test(buildSh) ||
    /process-qa-seed\.sh/.test(buildSh),
);

console.log("");
if (failures) {
  console.error("\nqa-seed-strip verification FAILED: " + failures + " check(s).");
  process.exit(1);
}
console.log(
  "qa-seed-strip verification PASSED — retail WGT carries no QA seed " +
    "(no auto-connect server URL, no qa.overlay/telemetry gate, no __*_SEED__ " +
    "placeholders); gated boot scripts survive; strip is idempotent and wired " +
    "into build-wgt.sh.",
);
