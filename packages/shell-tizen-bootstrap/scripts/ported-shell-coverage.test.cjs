// JEL-626 — anchor the boot-shell behavioural coverage that lives in the
// shell-tizen package into THIS package's test suite.
//
// BACKGROUND: boot-shell.src.js mirrors most of shell.js. The issue premise
// was "the mirrored copies are largely untested", but an audit (JEL-626,
// 2026-07-02) showed 31 of 42 shell-tizen tests already execute behavioural
// scenarios against boot-shell.src.js / boot-shell.min.js cross-package, and
// registerRemoteKeys-style mirrored functions are additionally byte-pinned by
// cross-shell-parity.test.cjs (JEL-624). The four high-value areas named by
// JEL-626 — mediabar crashguard, creds vault, JSI snippet channel,
// localStorage quota — are all behaviourally covered against the boot shell
// by their shell-tizen test files.
//
// That coverage has two structural weaknesses this test closes:
//   1. It only runs when the SHELL-TIZEN suite runs. A standalone
//      `pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test` (or an
//      internal-repo pipeline that only tests this package) would gate the
//      boot shell on NONE of the four areas.
//   2. Nothing pins the fact that those tests cover the boot shell. A future
//      edit could drop the boot-shell scenarios from a shell-tizen test and
//      every suite would stay green while the mirror went dark.
//
// WHAT THIS PINS (per ported test):
//   - the shell-tizen test file still exists at its expected path;
//   - it exits 0 when run from this package's suite;
//   - its output still contains at least MIN_BOOT_OK passing assertions
//     labelled with the boot-shell artifact — i.e. the boot-shell scenarios
//     are still present, not just the retail ones.
//
// MIN_BOOT_OK values are the exact per-test boot-shell "OK:" line counts at
// the time of writing. Adding scenarios upstream never fails this test;
// REMOVING boot-shell scenarios does, forcing a conscious update here.
//
// This is deliberately a RUNNER, not a copy: duplicating ~2300 lines of test
// code into this package would drift immediately, and JEL-616 b1 phase 2
// (shell-core extraction) will make the logic — and its tests — shared.
// When that lands, this file and the cross-package reads both retire.
//
// Run: node scripts/ported-shell-coverage.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test

"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SHELL_TIZEN_SCRIPTS = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen",
  "scripts",
);

// test file -> minimum "OK: ...boot-shell..." lines its output must contain.
const PORTED = [
  ["mediabar-crashguard.test.cjs", 29], // JEL-237/238/484 YT-iframe cap-to-zero
  ["creds-guard.test.cjs", 57], // JEL-134 creds vault + restore
  ["jsi-snippet-channel.test.cjs", 16], // JEL-197 JS-Injector snippet channel
  ["localstorage-quota.test.cjs", 40], // JEL-60 quota-safe storage
];

const BOOT_OK_RE = /^OK: .*boot-shell/;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

for (const [file, minBootOk] of PORTED) {
  const abs = path.join(SHELL_TIZEN_SCRIPTS, file);
  const exists = fs.existsSync(abs);
  check(file + ": shell-tizen test file present", exists, abs);
  if (!exists) continue;

  let out = "";
  let exitOk = true;
  try {
    out = execFileSync(process.execPath, [abs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    exitOk = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  check(
    file + ": exits 0 (all scenarios pass)",
    exitOk,
    out
      .split("\n")
      .filter((l) => l.startsWith("FAIL"))
      .join(" | "),
  );

  const bootOk = out.split("\n").filter((l) => BOOT_OK_RE.test(l)).length;
  check(
    file + ": >= " + minBootOk + " boot-shell assertions still present",
    bootOk >= minBootOk,
    "got " + bootOk,
  );
}

if (failures) {
  console.error("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
console.log("\nALL OK");
