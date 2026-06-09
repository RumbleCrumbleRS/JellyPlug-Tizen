// JEL-82 verification — Tizen system info: device model & firmware NOT reported.
//
// QUESTION (from the ticket): does getSystemInfo() read device info via
// tizen.systeminfo.getPropertyValue('BUILD')? Does deviceName() return the real
// model (not a 'Tizen TV' fallback)? Is the model exposed in QA diagnostics?
//
// ANSWER — established by source + runtime execution (see
// tooling/tv-validate/system-info/results-JEL-82.md):
//
//   The issue's premise is FALSE against the shipped code. The shell does not
//   read the device model or firmware version at all:
//     1. getSystemInfo() queries "DISPLAY" (screen resolution) and never "BUILD".
//        Its only job is to size AppHost.screen(); the result object carries just
//        resolutionWidth/resolutionHeight.
//     2. AppHost.deviceName() returns the fixed constant
//        AppInfo.deviceName === "Samsung Smart TV" on every code path — no model
//        derivation, and there is no "Tizen TV" fallback string anywhere. This is
//        the JEL-89 identity decision, source-guarded by nativeshell-apphost.test.
//     3. __shellDiag carries errors/warns/stats only — no model/firmware field,
//        because nothing collects it.
//   ⇒ The server's Devices dashboard shows the static "Samsung Smart TV" for
//     every TV. (Devices are still distinguished by deviceId; see JEL-67.)
//
// This .cjs locks the SHELL side to source (DISPLAY-only, fixed name, no BUILD).
// The companion .mjs EXECUTES getSystemInfo() in a vm realm against a recording
// tizen.systeminfo double to prove BUILD is never asked even at runtime:
// tooling/tv-validate/system-info/verify-system-info.mjs.
//
// Run: node scripts/system-info.test.cjs
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
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Brace-balanced extraction of a named function body.
function fnBody(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in " + label);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name + ": unbalanced braces in " + label);
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const minSrc = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");

const SHELLS = [
  { label: "shell.js", src: tvSrc },
  { label: "boot-shell.src.js", src: bootSrc },
];

// --- 1. getSystemInfo() reads DISPLAY only — never BUILD/model/firmware -------
for (const { label, src } of SHELLS) {
  const body = fnBody(src, "getSystemInfo", label);
  check(
    `[${label}] getSystemInfo queries "DISPLAY"`,
    /getPropertyValue\(\s*"DISPLAY"/.test(body),
  );
  check(
    `[${label}] getSystemInfo never queries "BUILD" (model/firmware not read)`,
    !/BUILD|MODEL|firmware|buildVersion/i.test(body),
    "the issue's getPropertyValue('BUILD') premise is absent from the code",
  );
  check(
    `[${label}] getSystemInfo result is resolution-only`,
    /resolutionWidth/.test(body) &&
      /resolutionHeight/.test(body) &&
      !/deviceName|model|build/i.test(body),
  );
}

// --- 2. deviceName() is the fixed "Samsung Smart TV" constant -----------------
for (const { label, src } of SHELLS) {
  const appInfoBlock = src.slice(
    src.indexOf("AppInfo"),
    src.indexOf("AppInfo") + 400,
  );
  const nameMatch = appInfoBlock.match(/deviceName:\s*"([^"]+)"/);
  check(
    `[${label}] AppInfo.deviceName === "Samsung Smart TV" (fixed, not the model)`,
    !!nameMatch && nameMatch[1] === "Samsung Smart TV",
    nameMatch ? "got " + JSON.stringify(nameMatch[1]) : "deviceName not found",
  );
  check(
    `[${label}] AppHost.deviceName() returns the cached constant (no model lookup)`,
    /deviceName:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceName/.test(
      src,
    ),
  );
  check(
    `[${label}] no "Tizen TV" fallback string exists`,
    !/"Tizen TV"/.test(src),
  );
}

// --- 3. QA diagnostics expose no model/firmware field -------------------------
for (const { label, src } of SHELLS) {
  const diagInit = src.match(/__shellDiag\s*=\s*\{[\s\S]{0,400}?\}\}/);
  check(
    `[${label}] __shellDiag stats carries no model/firmware/BUILD field`,
    !!diagInit && !/model|firmware|build/i.test(diagInit[0]),
    "the model the issue expected in diagnostics is simply not collected",
  );
}

// --- 4. Deployed artifact mirrors all three facts -----------------------------
check(
  'shell.min.js (deployed) reports the constant "Samsung Smart TV"',
  minSrc.includes("Samsung Smart TV"),
);
check(
  'shell.min.js (deployed) queries "DISPLAY" and never "BUILD"',
  minSrc.includes('getPropertyValue("DISPLAY"') &&
    !/getPropertyValue\(\s*"BUILD"/.test(minSrc),
);
check(
  'shell.min.js (deployed) contains no "Tizen TV" device-name fallback',
  !minSrc.includes('"Tizen TV"'),
);

// --- summary ------------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  "All system-info checks passed (model/firmware not reported; fixed device name — by design, JEL-89).",
);
