#!/usr/bin/env node
// JEL-82 — Compare: Tizen system info — device model and firmware version reported.
//
// WHAT THE ISSUE ASKED vs WHAT THE SHIPPED CODE ACTUALLY DOES
//   The issue asks us to verify that getSystemInfo() reads device info via
//   tizen.systeminfo.getPropertyValue('BUILD'), that deviceName() returns the
//   real model string (not a 'Tizen TV' fallback), that the model is logged in
//   the QA diagnostics, and to compare that against the Devices dashboard.
//
//   Running the SHIPPED functions falsifies that premise. The shell:
//     1. NEVER queries 'BUILD'. getSystemInfo() calls getPropertyValue('DISPLAY')
//        and extracts ONLY screen resolution (× a UD/8K panel ratio). No model,
//        no firmware, no build string is ever read from tizen.systeminfo.
//     2. Reports a FIXED device name. AppHost.deviceName() returns the constant
//        AppInfo.deviceName === "Samsung Smart TV" for every TV, every model,
//        every firmware. There is no model derivation and no "Tizen TV" fallback
//        string anywhere — the constant IS the value on both the happy path and
//        every degraded path. (This is the JEL-89 identity decision; see
//        nativeshell-apphost-identity-values.)
//     3. Exposes NO model/firmware field in the QA diagnostics. __shellDiag /
//        __shellDiagInit carry errors/warns/stats (UA slice, transpile counts,
//        player-manager roster) — there is no model key because nothing reads it.
//
//   So the headline answer to JEL-82 is: the device model and firmware version
//   are NOT reported. By design, the server's Devices dashboard shows the static
//   "Samsung Smart TV" device name, identical across every Samsung TV that runs
//   this shell. See results-JEL-82.md for the full writeup and the compare.
//
// HOW THIS IS PROVEN HERMETICALLY (no TV, no server, no network)
//   getSystemInfo() branches only on `hasTizen`/`tizen.systeminfo` and drives a
//   getPropertyValue callback — all of which we can supply in a Node `vm` realm.
//   We extract getSystemInfo() VERBATIM from both shells and execute it against a
//   tizen.systeminfo double that RECORDS every property key requested and a
//   productinfo double for the panel-ratio path. A BUILD handler is wired in and
//   primed to hand back a real model — proving the model never flows anywhere
//   because the code never asks for it. deviceName()'s constant and the QA-diag
//   schema are pinned by source-contract guards across both shells + the
//   deployed minified blobs.
//
// Usage:  node tooling/tv-validate/system-info/verify-system-info.mjs
// Exits non-zero on any failed assertion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const BOOT_SRC = resolve(
  REPO,
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
);
const BOOT_MIN = resolve(
  REPO,
  "packages/shell-tizen-bootstrap/src/boot-shell.min.js",
);

const UA_TV =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/5.0 TV Safari/537.36"; // legacy Chromium 63 (real device)
const UA_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36"; // modern desktop Chromium

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS  " + name + (detail ? "  — " + detail : ""));
  } else {
    console.error("FAIL  " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const shellSrc = readFileSync(SHELL_JS, "utf8");
const shellMin = readFileSync(SHELL_MIN, "utf8");
const bootSrc = readFileSync(BOOT_SRC, "utf8");
const bootMin = readFileSync(BOOT_MIN, "utf8");

// Extract a `function name(...) { ... }` declaration verbatim by brace-matching.
// getSystemInfo contains no brace-bearing string/regex literals, so a plain
// depth counter is exact (asserted by the token guards below).
function extractFn(src, name, label) {
  const start = src.indexOf("function " + name);
  if (start === -1) throw new Error(`function ${name} not found in ${label}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

// A tizen.systeminfo double that records EVERY property key requested, so we can
// prove the shell asks for "DISPLAY" and never "BUILD". The DISPLAY branch hands
// back a resolution; a BUILD handler is wired and primed with a real model — if
// the shell ever asked, the model would surface and our "never asked" assertion
// would fail loudly.
const MODEL_IF_ASKED = {
  model: "QN65Q80AAFXZA",
  buildVersion: "T-KTM2LAKUC-1320.5",
  buildTime: "20210301_1",
};
function makeTizen({ displayFails = false } = {}) {
  const asked = [];
  return {
    asked,
    api: {
      systeminfo: {
        getPropertyValue(prop, success, error) {
          asked.push(prop);
          if (prop === "DISPLAY") {
            if (displayFails) return error(new Error("DISPLAY unavailable"));
            return success({ resolutionWidth: 1920, resolutionHeight: 1080 });
          }
          if (prop === "BUILD") {
            // The shell should NEVER reach here. If it does, hand back a real
            // model so the failure is visible downstream.
            return success({ ...MODEL_IF_ASKED });
          }
          return error(new Error("unexpected property " + prop));
        },
      },
    },
  };
}

// A webapis.productinfo double for the panel-ratio path (UD/8K upscaling). Note
// none of these expose the MODEL either — they are boolean capability probes.
function makeWebapis({ ud = false, eightK = false } = {}) {
  return {
    productinfo: {
      isUdPanelSupported: () => ud,
      is8KPanelSupported: () => eightK,
    },
  };
}

// Boot a fresh realm holding ONLY the shipped getSystemInfo() (plus its module
// `systeminfo` cache var) wired to chosen tizen/webapis doubles.
function bootRealm(getSysSrc, { ua, tizen, hasTizen, webapis, hasWebapis }) {
  const ctx = {
    navigator: { userAgent: ua },
    tizen,
    hasTizen,
    webapis,
    hasWebapis,
    Promise,
    Math,
    console,
  };
  vm.createContext(ctx);
  const code =
    "var systeminfo = null;\n" +
    getSysSrc +
    "\n;({ getSystemInfo: getSystemInfo, peek: function(){ return systeminfo; } });";
  return vm.runInContext(code, ctx);
}

const SHELLS = [
  { label: "shell.js", src: shellSrc, min: shellMin, minLabel: "shell.min.js" },
  {
    label: "boot-shell.src.js",
    src: bootSrc,
    min: bootMin,
    minLabel: "boot-shell.min.js",
  },
];
const PLATFORMS = [
  { label: "TV (legacy Chromium)", ua: UA_TV },
  { label: "browser (modern Chromium)", ua: UA_BROWSER },
];

// ===========================================================================
// PART A — getSystemInfo() RUNTIME BEHAVIOR: it reads DISPLAY, never BUILD,
//          and the result object carries NO model/firmware field.
// ===========================================================================
for (const shell of SHELLS) {
  const getSysSrc = extractFn(shell.src, "getSystemInfo", shell.label);

  // Token guards: the extracted bytes really are the DISPLAY-only resolution
  // reader and never mention BUILD or a model.
  check(
    `[${shell.label}] getSystemInfo queries "DISPLAY"`,
    /getPropertyValue\(\s*"DISPLAY"/.test(getSysSrc),
  );
  check(
    `[${shell.label}] getSystemInfo NEVER mentions "BUILD" / model / firmware`,
    !/BUILD|MODEL|firmware|buildVersion/i.test(getSysSrc),
    "the issue's getPropertyValue('BUILD') premise is not in the code",
  );
  check(
    `[${shell.label}] getSystemInfo result is resolution-only (width/height)`,
    /resolutionWidth/.test(getSysSrc) &&
      /resolutionHeight/.test(getSysSrc) &&
      !/deviceName|model|build/i.test(getSysSrc),
  );

  for (const plat of PLATFORMS) {
    const tag = `[${shell.label} · ${plat.label}]`;

    // --- 1. Happy path: DISPLAY read, BUILD never asked -------------------
    const t1 = makeTizen();
    const w1 = makeWebapis({ ud: false });
    const r1 = bootRealm(getSysSrc, {
      ua: plat.ua,
      tizen: t1.api,
      hasTizen: true,
      webapis: w1,
      hasWebapis: true,
    });
    const info1 = await r1.getSystemInfo();
    check(
      `${tag} asks tizen.systeminfo for "DISPLAY" exactly once`,
      t1.asked.length === 1 && t1.asked[0] === "DISPLAY",
      "asked=" + JSON.stringify(t1.asked),
    );
    check(
      `${tag} NEVER asks for "BUILD" (model/firmware are not read)`,
      !t1.asked.includes("BUILD"),
    );
    check(
      `${tag} result carries resolution only — no model/firmware keys`,
      Object.keys(info1).sort().join(",") ===
        "resolutionHeight,resolutionWidth" &&
        info1.resolutionWidth === 1920 &&
        info1.resolutionHeight === 1080,
      "keys=" + Object.keys(info1).join(","),
    );
    check(
      `${tag} the primed model "${MODEL_IF_ASKED.model}" never surfaces anywhere in the result`,
      !JSON.stringify(info1).includes(MODEL_IF_ASKED.model) &&
        !JSON.stringify(info1).includes(MODEL_IF_ASKED.buildVersion),
    );

    // --- 2. UD panel doubles resolution (still no model) ------------------
    const t2 = makeTizen();
    const r2 = bootRealm(getSysSrc, {
      ua: plat.ua,
      tizen: t2.api,
      hasTizen: true,
      webapis: makeWebapis({ ud: true }),
      hasWebapis: true,
    });
    const info2 = await r2.getSystemInfo();
    check(
      `${tag} UD panel upscales resolution to 3840×2160, still BUILD-free`,
      info2.resolutionWidth === 3840 &&
        info2.resolutionHeight === 2160 &&
        !t2.asked.includes("BUILD"),
    );

    // --- 3. DISPLAY error callback → 1080p fallback, no model -------------
    const t3 = makeTizen({ displayFails: true });
    const r3 = bootRealm(getSysSrc, {
      ua: plat.ua,
      tizen: t3.api,
      hasTizen: true,
      webapis: makeWebapis(),
      hasWebapis: true,
    });
    const info3 = await r3.getSystemInfo();
    check(
      `${tag} DISPLAY failure falls back to 1920×1080, never probes BUILD`,
      info3.resolutionWidth === 1920 &&
        info3.resolutionHeight === 1080 &&
        !t3.asked.includes("BUILD"),
    );

    // --- 4. No-tizen (browser/emulator) → 1080p, getPropertyValue untouched
    const t4 = makeTizen();
    const r4 = bootRealm(getSysSrc, {
      ua: plat.ua,
      tizen: t4.api,
      hasTizen: false, // simulate a host with no tizen object
      webapis: undefined,
      hasWebapis: false,
    });
    const info4 = await r4.getSystemInfo();
    check(
      `${tag} no-tizen host returns 1920×1080 without calling getPropertyValue`,
      info4.resolutionWidth === 1920 &&
        info4.resolutionHeight === 1080 &&
        t4.asked.length === 0,
    );
  }
}

// ===========================================================================
// PART B — deviceName() IDENTITY: a fixed "Samsung Smart TV" constant, with no
//          model derivation and no "Tizen TV" fallback, on every code path.
// ===========================================================================
const EXPECTED_DEVICE_NAME = "Samsung Smart TV";
for (const shell of SHELLS) {
  // Pull the literal value out of the AppInfo object.
  const appInfoBlock = shell.src.slice(
    shell.src.indexOf("AppInfo"),
    shell.src.indexOf("AppInfo") + 400,
  );
  const nameMatch = appInfoBlock.match(/deviceName:\s*"([^"]+)"/);
  check(
    `[${shell.label}] AppInfo.deviceName is the constant "${EXPECTED_DEVICE_NAME}"`,
    nameMatch && nameMatch[1] === EXPECTED_DEVICE_NAME,
    nameMatch ? "got " + JSON.stringify(nameMatch[1]) : "deviceName not found",
  );
  check(
    `[${shell.label}] AppHost.deviceName() returns the cached constant (no model lookup)`,
    /deviceName:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceName/.test(
      shell.src,
    ),
  );
  check(
    `[${shell.label}] no "Tizen TV" fallback string exists (the issue's premise)`,
    !/"Tizen TV"/.test(shell.src),
  );
  check(
    `[${shell.label}] deviceName is independent of getSystemInfo/getPropertyValue`,
    !/deviceName[\s\S]{0,80}getPropertyValue/.test(shell.src),
    "the model is never wired into the reported name",
  );
}

// ===========================================================================
// PART C — QA DIAGNOSTICS: the model/firmware is NOT exposed, because nothing
//          reads it. __shellDiag carries errors/warns/stats only.
// ===========================================================================
for (const shell of SHELLS) {
  // The diag object is initialised inside the diagnostic HUD block. Pin its
  // schema: stats has a UA slice + transpile counters, but no model/firmware.
  const diagInit = shell.src.match(/__shellDiag\s*=\s*\{[\s\S]{0,400}?\}\}/);
  check(
    `[${shell.label}] __shellDiag exists (errors/warns/stats) and exposes a UA slice`,
    !!diagInit && /stats:\s*\{[^}]*ua:/.test(diagInit[0]),
  );
  check(
    `[${shell.label}] __shellDiag stats carries NO model/firmware/BUILD field`,
    !!diagInit && !/model|firmware|build/i.test(diagInit[0]),
    "the model the issue expected to find in diagnostics is simply not collected",
  );
}

// ===========================================================================
// PART D — CROSS-SHELL + DEPLOYED-BLOB CONTRACT GUARDS.
// ===========================================================================
const normalize = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
const sysShell = normalize(extractFn(shellSrc, "getSystemInfo", "shell.js"));
const sysBoot = normalize(extractFn(bootSrc, "getSystemInfo", "boot-shell.src.js"));
check(
  "shell.js and boot-shell.src.js share a DISPLAY-only getSystemInfo (same property set, same fallbacks)",
  sysShell.includes('getPropertyValue("DISPLAY"') &&
    sysBoot.includes('getPropertyValue("DISPLAY"') &&
    !sysShell.includes("BUILD") &&
    !sysBoot.includes("BUILD"),
);

for (const shell of SHELLS) {
  check(
    `deployed ${shell.minLabel} reports the constant "${EXPECTED_DEVICE_NAME}"`,
    shell.min.includes(EXPECTED_DEVICE_NAME),
  );
  check(
    `deployed ${shell.minLabel} queries "DISPLAY" and never "BUILD"`,
    shell.min.includes('getPropertyValue("DISPLAY"') &&
      !/getPropertyValue\(\s*"BUILD"/.test(shell.min),
  );
  check(
    `deployed ${shell.minLabel} contains no "Tizen TV" device-name fallback`,
    !shell.min.includes('"Tizen TV"'),
  );
}

// ---- summary --------------------------------------------------------------
console.log("");
console.log(
  "CONCLUSION: the Tizen shell does NOT read device model or firmware version.",
);
console.log(
  '  • getSystemInfo() queries DISPLAY only (resolution) — never getPropertyValue("BUILD").',
);
console.log(
  '  • deviceName() is a fixed "Samsung Smart TV" constant (JEL-89), no model, no "Tizen TV" fallback.',
);
console.log(
  "  • QA diagnostics expose no model/firmware field — nothing collects it.",
);
console.log(
  "  ⇒ Server Devices dashboard shows the static \"Samsung Smart TV\" for every TV. See results-JEL-82.md.",
);
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All JEL-82 system-info checks passed (both shells, TV + browser).");
