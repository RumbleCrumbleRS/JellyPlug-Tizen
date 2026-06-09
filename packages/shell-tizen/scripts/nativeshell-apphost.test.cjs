// JEL-45 verification — NativeShell.AppHost API values (TV vs browser).
//
// Goal: prove every NativeShell.AppHost property the Tizen shell hands to
// jellyfin-web returns a CORRECT and PLATFORM-STABLE value, and pin the five
// properties named in JEL-45 to the live source so they cannot silently drift:
//   (1) appName()          — client name reported to the server (Sessions API)
//   (2) deviceId()         — stable id persisted in localStorage
//   (3) deviceName()       — device name reported to the server
//   (4) getDefaultLayout() — must be "tv"
//   (5) appVersion         — intentionally ABSENT (jellyfin-web falls back to
//                            its bundled web-client version; see JEL-12)
//
// WHY "TV vs browser" REDUCES TO A SOURCE CHECK
//   The shell defines window.NativeShell.AppHost the same way regardless of
//   platform. appName/deviceName/getDefaultLayout are constants and deviceId is
//   a localStorage value — NONE of them branch on `tizen`. So the TV and a
//   desktop browser running the same shell return IDENTICAL values for all four
//   by construction. The only AppHost member that differs by platform is
//   screen(): real panel resolution on the TV vs the 1920x1080 fallback in a
//   browser (getSystemInfo()). That asymmetry is intentional and is asserted
//   below. Locking the four constants to source is therefore a complete parity
//   proof for the JEL-45 properties.
//
// TWO SHELLS, ONE CONTRACT
//   The retail artifact that actually boots on the TV is the BOOTSTRAP
//   (boot-shell.src.js / .min.js), and the full shell (shell.js / .min.js)
//   carries its own copy of the same NativeShell. Both must agree, or the
//   server would see different identities depending on which shell loaded.
//   This test cross-checks the two source-of-record files and their deployed
//   minified blobs.
//
// SPEC ADOPTION (JEL-89 decision, implemented JEL-90)
//   JEL-45's description states appName() should be "Jellyfin for Tizen" and
//   deviceName() should be the TV model from tizen.systeminfo (fallback
//   "Tizen TV"). Changing these alters server-reported IDENTITY on a deployed
//   retail build, so it was routed to the CEO as a product decision (JEL-89).
//   JEL-89 ADOPTED the spec values; JEL-90 implemented them in both shells
//   (appName = "Jellyfin for Tizen", deviceName = BUILD model w/ "Tizen TV"
//   fallback). Part B below therefore now enforces these as HARD contract
//   checks rather than informational divergences.
//   See tooling/tv-validate/nativeshell-apphost/results-JEL-45.md
//
// Run: node scripts/nativeshell-apphost.test.cjs
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

// JEL-45 stated contract (from the issue description).
const SPEC = {
  appName: "Jellyfin for Tizen",
  // deviceName: TV model from tizen.systeminfo, else "Tizen TV".
  deviceNameFallback: "Tizen TV",
  layout: "tv",
};
const DEVICE_ID_KEY = "_deviceId2";

let failures = 0;
let divergences = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}
function diverge(name, detail) {
  console.warn("DIVERGENCE: " + name + (detail ? "  — " + detail : ""));
  divergences++;
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

// --- Extract the AppInfo {deviceName, appName} literal from a source file. ----
// AppInfo holds the two string values the AppHost getters return verbatim:
//   var AppInfo = { deviceId: getDeviceId(), deviceName: "...", appName: "..." }
function appInfo(src, label) {
  const i = src.indexOf("AppInfo");
  if (i === -1) throw new Error("AppInfo not found in " + label);
  const slice = src.slice(i, i + 240);
  const dn = slice.match(/deviceName:\s*"([^"]*)"/);
  const an = slice.match(/appName:\s*"([^"]*)"/);
  if (!dn || !an)
    throw new Error("could not parse deviceName/appName in " + label);
  return { deviceName: dn[1], appName: an[1] };
}

const tv = appInfo(tvSrc, "shell.js");
const boot = appInfo(bootSrc, "boot-shell.src.js");

console.log("");
console.log("Resolved AppHost identity values:");
console.log(
  "  shell.js        appName=%j deviceName=%j",
  tv.appName,
  tv.deviceName,
);
console.log(
  "  boot-shell.src  appName=%j deviceName=%j",
  boot.appName,
  boot.deviceName,
);
console.log("");

// ============================================================================
// PART A — CONTRACT (must hold; failures exit non-zero)
// ============================================================================

// A1. getDefaultLayout() === "tv" in both shells (JEL-45 item 4).
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    "getDefaultLayout() returns " +
      JSON.stringify(SPEC.layout) +
      " in " +
      label,
    new RegExp(
      'getDefaultLayout:\\s*function\\s*\\(\\)\\s*\\{\\s*return\\s*"' +
        SPEC.layout +
        '"',
    ).test(src),
  );
}

// A2. appVersion is intentionally ABSENT from AppHost (JEL-45 item 5).
// jellyfin-web falls back to its bundled web-client version when absent.
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
]) {
  check(
    "appVersion is NOT defined as an AppHost property in " + label,
    !/appVersion\s*:/.test(src),
    "found an `appVersion:` property",
  );
}

// A3. deviceId() is persisted in localStorage under a fixed key and is stable
//     (JEL-45 item 2). It is read once, generated+stored only when missing, so
//     repeated calls return the same value for the life of the install.
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    "deviceId reads localStorage[" +
      JSON.stringify(DEVICE_ID_KEY) +
      "] in " +
      label,
    new RegExp('localStorage\\.getItem\\(\\s*"' + DEVICE_ID_KEY + '"').test(
      src,
    ),
  );
  check(
    "deviceId persists to localStorage[" +
      JSON.stringify(DEVICE_ID_KEY) +
      "] only when missing in " +
      label,
    new RegExp('localStorage\\.setItem\\(\\s*"' + DEVICE_ID_KEY + '"').test(
      src,
    ),
  );
  check(
    "deviceId() returns the cached AppInfo.deviceId (stable across calls) in " +
      label,
    /deviceId:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceId/.test(src),
  );
}
// The deployed blobs must carry the same persistence key.
for (const [label, src] of [
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
]) {
  check(
    "deployed " +
      label +
      " references localStorage key " +
      JSON.stringify(DEVICE_ID_KEY),
    src.includes('"' + DEVICE_ID_KEY + '"'),
  );
}

// A4. screen() — the ONE property that legitimately differs TV vs browser.
//     Backed by getSystemInfo(), which reads tizen.systeminfo on the TV and
//     falls back to 1920x1080 when `tizen` is absent (i.e. in a browser).
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    "getSystemInfo() falls back to 1920x1080 when tizen is unavailable (browser) in " +
      label,
    /resolutionWidth:\s*1920/.test(src) && /resolutionHeight:\s*1080/.test(src),
  );
  check(
    "getSystemInfo() reads tizen.systeminfo DISPLAY on the TV in " + label,
    /tizen\.systeminfo\.getPropertyValue\(\s*\n?\s*"DISPLAY"/.test(src) ||
      /getPropertyValue\(\s*"DISPLAY"/.test(src),
  );
}

// A5. The two shells AGREE on the identity values, and the deployed blobs
//     mirror their source-of-record. A mismatch would mean the server sees a
//     different identity depending on which shell booted.
check(
  "shell.js and boot-shell.src.js agree on appName",
  tv.appName === boot.appName,
  "shell=" +
    JSON.stringify(tv.appName) +
    " boot=" +
    JSON.stringify(boot.appName),
);
check(
  "shell.js and boot-shell.src.js agree on deviceName",
  tv.deviceName === boot.deviceName,
  "shell=" +
    JSON.stringify(tv.deviceName) +
    " boot=" +
    JSON.stringify(boot.deviceName),
);
check(
  "shell.min.js mirrors shell.js identity values",
  tvMin.includes('"' + tv.appName + '"') &&
    tvMin.includes('"' + tv.deviceName + '"'),
);
check(
  "boot-shell.min.js mirrors boot-shell.src.js identity values",
  bootMin.includes('"' + boot.appName + '"') &&
    bootMin.includes('"' + boot.deviceName + '"'),
);

// A6. appName()/deviceName() are constants (no `tizen` branch) -> identical on
//     TV and browser. Confirm the getters just return the cached AppInfo value.
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    "appName() returns the platform-independent AppInfo.appName in " + label,
    /appName:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.appName/.test(src),
  );
  check(
    "deviceName() returns the platform-independent AppInfo.deviceName in " +
      label,
    /deviceName:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceName/.test(
      src,
    ),
  );
}

// ============================================================================
// PART B — JEL-45 SPEC CONTRACT (must hold; failures exit non-zero)
// ============================================================================
// JEL-89 decided to ADOPT the JEL-45 spec values for both identity properties,
// implemented in JEL-90. appName and deviceName are therefore now hard contract
// checks (previously informational divergences while the decision was pending).
console.log("");
console.log("JEL-45 spec contract (JEL-89/JEL-90 adopted values):");

// (1) appName — must be the spec value in both shells (A5 already asserts the
//     two shells agree, so checking tv covers boot too).
check(
  "appName() matches JEL-45 spec " + JSON.stringify(SPEC.appName),
  tv.appName === SPEC.appName,
  "actual=" + JSON.stringify(tv.appName),
);

// (3) deviceName — spec wants the model read from tizen.systeminfo with a
//     "Tizen TV" fallback. Assert BOTH that the AppInfo default is the spec
//     fallback string AND that each source-of-record actually reads a model
//     property (so the constant can't silently replace the model lookup).
const readsModelTv =
  /system\/model_name|getCapability\([^)]*model|MODEL|\.model\b/.test(tvSrc);
const readsModelBoot =
  /system\/model_name|getCapability\([^)]*model|MODEL|\.model\b/.test(bootSrc);
check(
  "deviceName() default matches JEL-45 spec fallback " +
    JSON.stringify(SPEC.deviceNameFallback),
  tv.deviceName === SPEC.deviceNameFallback,
  "actual=" + JSON.stringify(tv.deviceName),
);
check(
  "shell.js reads the TV model from systeminfo (deviceName source)",
  readsModelTv,
  "no model property read found in shell.js",
);
check(
  "boot-shell.src.js reads the TV model from systeminfo (deviceName source)",
  readsModelBoot,
  "no model property read found in boot-shell.src.js",
);

// (2) deviceId — spec says "stable UUID persisted in localStorage". Shipped id
//     is a stable, persisted base64 token (userAgent|timestamp|random), NOT an
//     RFC-4122 UUID. Intent (stable + persisted) is met; format differs. This
//     is a NOTE, not a divergence — the value's job is stable uniqueness.
const usesBtoa = /btoa\(/.test(tvSrc);
console.log(
  "  NOTE: deviceId() is a stable, persisted token (" +
    (usesBtoa ? "btoa(userAgent|Date.now()|Math.random())" : "generated") +
    "), not RFC-4122 UUID format. Stability + persistence (spec intent) hold.",
);

// (4) layout and (5) appVersion are covered as hard contract asserts above and
//     match the spec exactly.
check(
  "getDefaultLayout() spec value " +
    JSON.stringify(SPEC.layout) +
    " is locked (Part A)",
  true,
);
check("appVersion absence (spec item 5) is locked (Part A)", true);

// --- summary ----------------------------------------------------------------
console.log("");
if (divergences) {
  console.warn(
    divergences +
      " spec divergence(s) found — these are product/identity decisions, see " +
      "tooling/tv-validate/nativeshell-apphost/results-JEL-45.md",
  );
}
if (failures) {
  console.error(failures + " contract check(s) FAILED");
  process.exit(1);
}
console.log("All NativeShell.AppHost contract checks passed.");
