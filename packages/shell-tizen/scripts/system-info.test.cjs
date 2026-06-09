// JEL-82 / JEL-90 verification — Tizen system info & device-name model read.
//
// HISTORY: JEL-82 originally found the shell read NO device model — deviceName
// was the fixed constant "Samsung Smart TV" — and locked that contract here
// "while the JEL-89 identity decision was pending." JEL-89 then ADOPTED the
// JEL-45 spec, and JEL-90 implemented it. This guard is updated to the NEW
// contract; the JEL-82 finding is superseded.
//
// CURRENT CONTRACT (JEL-90), established by source (see
// tooling/tv-validate/system-info/results-JEL-82.md + nativeshell-apphost.test):
//
//   1. getSystemInfo() STILL queries "DISPLAY" only and NEVER "BUILD". Its sole
//      job is to size AppHost.screen(); the result object carries just
//      resolutionWidth/resolutionHeight. The model read is deliberately a
//      SEPARATE init step (resolveDeviceName), so screen() stays resolution-only.
//   2. The shell NOW reads the TV model: resolveDeviceName() calls
//      tizen.systeminfo.getPropertyValue("BUILD", ...) -> info.model, with a
//      try/catch + error-callback fallback to the "Tizen TV" constant, and runs
//      in parallel with getSystemInfo() before AppHost.init() resolves.
//   3. AppInfo.deviceName defaults to the "Tizen TV" fallback; AppHost.deviceName()
//      returns the cached AppInfo.deviceName (populated at init). On a real TV the
//      server's Devices dashboard now shows the panel model (e.g. "UN65MU8000").
//   4. __shellDiag still carries errors/warns/stats only — no model/firmware field.
//
// DEPLOYED BLOBS: boot-shell.min.js (the on-TV retail bootstrap) is rebuilt from
// source and carries the BUILD model read (CI src==min guard). shell.min.js (the
// hosted/WGT shell, rebuilt only at release cuts) currently carries the updated
// identity STRING ("Tizen TV") via a surgical update; its model-read LOGIC lands
// at the next hosted-drop rebuild (a full build_shell_min.py rebuild presently
// overflows the 102400-byte cap due to pre-existing drift — tracked separately).
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
const BOOT_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
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
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

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

// --- 2. deviceName defaults to the "Tizen TV" fallback; the model is read -----
//        from tizen.systeminfo "BUILD" in a SEPARATE init step (JEL-90).
for (const { label, src } of SHELLS) {
  const appInfoBlock = src.slice(
    src.indexOf("AppInfo"),
    src.indexOf("AppInfo") + 400,
  );
  const nameMatch = appInfoBlock.match(/deviceName:\s*"([^"]+)"/);
  check(
    `[${label}] AppInfo.deviceName defaults to the "Tizen TV" fallback`,
    !!nameMatch && nameMatch[1] === "Tizen TV",
    nameMatch ? "got " + JSON.stringify(nameMatch[1]) : "deviceName not found",
  );
  check(
    `[${label}] AppHost.deviceName() returns the cached AppInfo.deviceName (populated at init)`,
    /deviceName:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceName/.test(
      src,
    ),
  );
  check(
    `[${label}] reads the TV model via tizen.systeminfo "BUILD" -> info.model`,
    /getPropertyValue\(\s*\n?\s*"BUILD"/.test(src) && /\.model\b/.test(src),
    'expected a getPropertyValue("BUILD") read feeding info.model',
  );
  check(
    `[${label}] "Tizen TV" fallback string is present`,
    /"Tizen TV"/.test(src),
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

// --- 4. Deployed artifacts -----------------------------------------------------
// boot-shell.min.js is the on-TV retail bootstrap: a full rebuild from source,
// so it carries the "Tizen TV" fallback AND the BUILD model read.
check(
  'boot-shell.min.js (retail) reports the "Tizen TV" fallback',
  bootMin.includes('"Tizen TV"'),
);
check(
  'boot-shell.min.js (retail) reads the TV model via "BUILD"',
  /getPropertyValue\(\s*"BUILD"/.test(bootMin) && /\.model\b/.test(bootMin),
);
check(
  'boot-shell.min.js (retail) no longer reports the old "Samsung Smart TV" constant',
  !bootMin.includes("Samsung Smart TV"),
);

// shell.min.js (hosted/WGT shell) is rebuilt only at release cuts. Its identity
// STRING has been surgically updated to the "Tizen TV" fallback; the model-read
// LOGIC lands at the next hosted-drop rebuild (a full build_shell_min.py rebuild
// currently overflows the 102400-byte cap — pre-existing drift, tracked apart).
// So we assert the string is mirrored and getSystemInfo stays DISPLAY-only, but
// do NOT yet require the BUILD read in this blob.
check(
  'shell.min.js (deployed) reports the "Tizen TV" fallback',
  minSrc.includes('"Tizen TV"'),
);
check(
  'shell.min.js (deployed) no longer reports the old "Samsung Smart TV" constant',
  !minSrc.includes("Samsung Smart TV"),
);
check(
  'shell.min.js (deployed) getSystemInfo still queries "DISPLAY" (screen sizing intact)',
  minSrc.includes('getPropertyValue("DISPLAY"'),
);

// --- summary ------------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  'All system-info checks passed (screen sizing is DISPLAY-only; deviceName now reads the TV model via BUILD with a "Tizen TV" fallback — JEL-89/JEL-90).',
);
