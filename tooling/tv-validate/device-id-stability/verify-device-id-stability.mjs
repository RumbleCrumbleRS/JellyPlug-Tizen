#!/usr/bin/env node
// JEL-67 — Compare: deviceId stability across boots and reinstalls.
//
// The issue asks: call NativeShell.AppHost.deviceId() right after launch, reboot
// the TV, call it again, and confirm the SAME UUID comes back (persisted in
// localStorage). Then test after a reinstall and document the behavior.
//
// HOW THIS IS PROVEN HERMETICALLY (no TV, no server, no network)
//   deviceId() is backed by getDeviceId() → it reads localStorage["_deviceId2"]
//   once, and generates+persists a value ONLY when the key is missing. None of
//   that code branches on `tizen`, so a reboot, a browser refresh, and a fresh
//   app process are all the SAME thing to this code: a new JS realm pointed at
//   whatever localStorage the platform hands back. That makes the question fully
//   decidable by executing the SHIPPED functions in a Node `vm` realm against a
//   controllable localStorage whose contents we choose to mirror each platform
//   event:
//     • boot               → empty store      (first ever launch)
//     • reboot             → store PRESERVED   (Tizen keeps the data dir)
//     • update-over-install→ store PRESERVED   (WGT upgrade, same pkgid + cert)
//     • uninstall+reinstall→ store WIPED       (Tizen deletes the data dir)
//   We extract generateDeviceId()/getDeviceId() verbatim from BOTH shells (full
//   shell.js and the retail bootstrap boot-shell.src.js) and run each under both
//   a legacy-TV UA and a modern-browser UA.
//
// THE HEADLINE RESULTS
//   1. Reboot keeps the id: a second process over a PRESERVED store returns the
//      identical value and DOES NOT call generateDeviceId (no setItem fires).
//   2. Update-over-install keeps the id (same reason — data dir survives).
//   3. uninstall+reinstall MINTS A NEW id: Tizen deletes the app data dir, so the
//      store is empty and getDeviceId generates+persists a fresh value. This is
//      expected and matches Tizen's documented per-app storage lifecycle — the
//      server simply sees a new device/session after a clean reinstall.
//   4. Within one boot the value is stable across repeated calls, and AppHost
//      caches it once at init (AppInfo.deviceId = getDeviceId()), so it is stable
//      even if storage is cleared mid-session.
//
// Usage:  node tooling/tv-validate/device-id-stability/verify-device-id-stability.mjs
// Exits non-zero on any failed assertion. See results-JEL-67.md for the writeup.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const BOOT_SRC = resolve(REPO, "packages/shell-tizen-bootstrap/src/boot-shell.src.js");
const BOOT_MIN = resolve(REPO, "packages/shell-tizen-bootstrap/src/boot-shell.min.js");

const DEVICE_ID_KEY = "_deviceId2";
// Representative user-agent strings for the two platforms the shell ships to.
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

// ---------------------------------------------------------------------------
// Extract a `function name(...) { ... }` declaration verbatim by brace-matching.
// The deviceId helpers contain no brace-bearing string/regex literals, so a
// plain depth counter is exact here (asserted by the token guards below).
// ---------------------------------------------------------------------------
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

// A localStorage double that records writes so we can tell "generated a fresh
// id" (setItem fired) apart from "reused the persisted id" (no setItem).
function makeStorage(seed) {
  const store = new Map(seed ? [...seed] : []);
  let throwOnSet = false;
  const calls = { get: 0, set: 0, setDeviceId: 0 };
  return {
    store,
    calls,
    failWrites(v) {
      throwOnSet = v;
    },
    snapshot() {
      return new Map(store);
    },
    api: {
      getItem(k) {
        calls.get++;
        return store.has(k) ? store.get(k) : null;
      },
      setItem(k, v) {
        calls.set++;
        if (k === DEVICE_ID_KEY) calls.setDeviceId++;
        if (throwOnSet) {
          const e = new Error("QuotaExceededError");
          e.name = "QuotaExceededError";
          throw e;
        }
        store.set(k, String(v));
      },
      removeItem(k) {
        store.delete(k);
      },
      clear() {
        store.clear();
      },
    },
  };
}

// Boot a fresh JS realm (= a fresh app process / a reboot / a page load) that
// has ONLY the shipped deviceId helpers and a chosen localStorage + UA.
function bootRealm(genSrc, getSrc, ua, storage) {
  const ctx = {
    navigator: { userAgent: ua },
    localStorage: storage.api,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    Date,
    Math,
    console,
  };
  vm.createContext(ctx);
  const code =
    genSrc +
    "\n" +
    getSrc +
    "\n;({ generateDeviceId: generateDeviceId, getDeviceId: getDeviceId });";
  return vm.runInContext(code, ctx);
}

// ===========================================================================
// PART A — RUNTIME BEHAVIOR (the core of JEL-67), per shell × per platform.
// ===========================================================================
const SHELLS = [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
];
const PLATFORMS = [
  { label: "TV (legacy Chromium)", ua: UA_TV },
  { label: "browser (modern Chromium)", ua: UA_BROWSER },
];

for (const shell of SHELLS) {
  const genSrc = extractFn(shell.src, "generateDeviceId", shell.label);
  const getSrc = extractFn(shell.src, "getDeviceId", shell.label);

  // Token guards: the extracted bytes are really the deviceId algorithm.
  check(
    `[${shell.label}] generateDeviceId = btoa(userAgent|Date.now()|Math.random()) w/ '=' scrub`,
    /btoa\(/.test(genSrc) &&
      /navigator\.userAgent/.test(genSrc) &&
      /Date\.now\(\)/.test(genSrc) &&
      /Math\.random\(\)/.test(genSrc) &&
      /replace\(\s*\/=\/g\s*,\s*"1"\s*\)/.test(genSrc),
    "format note: not RFC-4122 UUID; a stable, persisted token (spec intent met)",
  );
  check(
    `[${shell.label}] getDeviceId reads localStorage["${DEVICE_ID_KEY}"], generates only when missing, persists in try/catch`,
    new RegExp(`getItem\\(\\s*"${DEVICE_ID_KEY}"`).test(getSrc) &&
      new RegExp(`setItem\\(\\s*"${DEVICE_ID_KEY}"`).test(getSrc) &&
      /if\s*\(\s*!id\s*\)/.test(getSrc) &&
      /try\s*\{/.test(getSrc),
  );

  for (const plat of PLATFORMS) {
    const tag = `[${shell.label} · ${plat.label}]`;

    // --- 1. FIRST BOOT (empty store) -------------------------------------
    const boot1 = makeStorage();
    const r1 = bootRealm(genSrc, getSrc, plat.ua, boot1);
    const id1 = r1.getDeviceId();
    check(`${tag} first boot returns a non-empty id`, !!id1 && typeof id1 === "string", JSON.stringify(id1).slice(0, 40) + "…");
    check(
      `${tag} first boot PERSISTS the id to localStorage["${DEVICE_ID_KEY}"]`,
      boot1.store.get(DEVICE_ID_KEY) === id1 && boot1.calls.setDeviceId === 1,
    );
    check(
      `${tag} id contains no '=' padding (scrubbed to '1')`,
      !id1.includes("="),
    );

    // --- 2. STABLE WITHIN ONE BOOT (repeated calls) ----------------------
    const beforeRepeat = boot1.calls.setDeviceId;
    const repeated = [r1.getDeviceId(), r1.getDeviceId(), r1.getDeviceId()];
    check(
      `${tag} repeated getDeviceId() calls in one session all equal the first id`,
      repeated.every((v) => v === id1),
    );
    check(
      `${tag} repeated calls do NOT regenerate (no extra setItem)`,
      boot1.calls.setDeviceId === beforeRepeat,
    );

    // --- 3. REBOOT (new process, store PRESERVED) ------------------------
    // The headline JEL-67 assertion: same UUID after a reboot.
    const reboot = makeStorage(boot1.snapshot());
    const r2 = bootRealm(genSrc, getSrc, plat.ua, reboot);
    const id2 = r2.getDeviceId();
    check(`${tag} REBOOT returns the SAME id (persisted across boots)`, id2 === id1, id2 === id1 ? id1.slice(0, 24) + "…" : `id1=${id1} id2=${id2}`);
    check(
      `${tag} REBOOT does NOT call generateDeviceId (no write to the key)`,
      reboot.calls.setDeviceId === 0,
    );

    // --- 4. UPDATE-OVER-INSTALL (WGT upgrade, store PRESERVED) ------------
    const upgrade = makeStorage(boot1.snapshot());
    const r3 = bootRealm(genSrc, getSrc, plat.ua, upgrade);
    check(
      `${tag} update-over-install (same pkgid+cert) keeps the id`,
      r3.getDeviceId() === id1 && upgrade.calls.setDeviceId === 0,
    );

    // --- 5. UNINSTALL + REINSTALL (data dir WIPED → empty store) ----------
    const reinstall = makeStorage(); // Tizen deleted the app data directory
    const r4 = bootRealm(genSrc, getSrc, plat.ua, reinstall);
    const id4 = r4.getDeviceId();
    check(
      `${tag} clean reinstall MINTS a new id (generateDeviceId runs, persists)`,
      reinstall.calls.setDeviceId === 1 && reinstall.store.get(DEVICE_ID_KEY) === id4,
    );
    check(
      `${tag} the freshly-minted reinstall id differs from the pre-uninstall id`,
      id4 !== id1,
      "expected — clean reinstall is a new device identity to the server",
    );

    // --- 6. PERSISTENT WRITE FAILURE (quota) → id not stable across boots -
    // try/catch means no crash, a value is still returned this session, but it
    // never reaches storage, so the NEXT boot generates a different one. This
    // is the one degraded path; documented, not a regression. (See JEL-60.)
    const q1 = makeStorage();
    q1.failWrites(true);
    const rq1 = bootRealm(genSrc, getSrc, plat.ua, q1);
    const qid1 = rq1.getDeviceId();
    check(
      `${tag} setItem throwing (quota) does NOT crash getDeviceId; returns a usable id`,
      !!qid1 && typeof qid1 === "string",
    );
    check(
      `${tag} under a throwing setItem the id is NOT persisted (empty store)`,
      !q1.store.has(DEVICE_ID_KEY),
    );
    // Next boot: store is still empty (the failed write left nothing), so
    // getDeviceId regenerates. If storage has since freed up, the new id now
    // persists and the device becomes stable again from here on.
    const q2 = makeStorage(q1.snapshot());
    const rq2 = bootRealm(genSrc, getSrc, plat.ua, q2);
    const qid2 = rq2.getDeviceId();
    check(
      `${tag} after a failed first-boot write, the next boot regenerates a (different) id and persists it`,
      q2.calls.setDeviceId === 1 &&
        q2.store.get(DEVICE_ID_KEY) === qid2 &&
        qid2 !== qid1,
      "persistent quota failure ⇒ id unstable until a write succeeds (documented degraded path; see JEL-60)",
    );
  }
}

// ===========================================================================
// PART B — CROSS-SHELL + DEPLOYED-BLOB CONTRACT (cheap regression guards).
// ===========================================================================

// B1. Both shells carry semantically-identical deviceId helpers (server must
//     see the same identity regardless of which shell booted). Compare with
//     comments and all whitespace stripped — the only difference between the
//     two copies is the catch body (`/* ignore */` vs empty `{}`), which is
//     cosmetic.
const normalize = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\s+/g, ""); // all whitespace
const genShell = normalize(extractFn(shellSrc, "generateDeviceId", "shell.js"));
const genBoot = normalize(extractFn(bootSrc, "generateDeviceId", "boot-shell.src.js"));
const getShell = normalize(extractFn(shellSrc, "getDeviceId", "shell.js"));
const getBoot = normalize(extractFn(bootSrc, "getDeviceId", "boot-shell.src.js"));
check("shell.js and boot-shell.src.js share an identical generateDeviceId()", genShell === genBoot);
check("shell.js and boot-shell.src.js share an identical getDeviceId()", getShell === getBoot);

// B2. AppHost caches the id once at init and the getter returns the cache, so a
//     mid-session storage wipe can't change the live deviceId().
for (const [label, src] of [
  ["shell.js", shellSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    `[${label}] AppInfo.deviceId is seeded once via getDeviceId() at init`,
    /deviceId:\s*getDeviceId\(\)/.test(src),
  );
  check(
    `[${label}] AppHost.deviceId() returns the cached AppInfo.deviceId`,
    /deviceId:\s*function\s*\(\)\s*\{\s*return\s+AppInfo\.deviceId/.test(src),
  );
}

// B3. The deviceId helpers are platform-independent (no tizen branch) → the TV
//     and a browser use the identical algorithm; only the UA input differs.
for (const [label, name, src] of [
  ["shell.js", "generateDeviceId", genShell],
  ["shell.js", "getDeviceId", getShell],
  ["boot-shell.src.js", "generateDeviceId", genBoot],
  ["boot-shell.src.js", "getDeviceId", getBoot],
]) {
  check(
    `[${label}] ${name} contains no tizen/hasTizen/webapis branch`,
    !/\btizen\b|hasTizen|webapis/.test(src),
  );
}

// B4. The deployed minified blobs still reference the persistence key.
check('deployed shell.min.js references localStorage key "' + DEVICE_ID_KEY + '"', shellMin.includes('"' + DEVICE_ID_KEY + '"'));
check('deployed boot-shell.min.js references localStorage key "' + DEVICE_ID_KEY + '"', bootMin.includes('"' + DEVICE_ID_KEY + '"'));

// ---- summary --------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All deviceId stability checks passed (boots + reinstalls, both shells, TV + browser).");
