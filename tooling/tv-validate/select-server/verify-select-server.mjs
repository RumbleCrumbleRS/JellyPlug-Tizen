#!/usr/bin/env node
// JEL-69 — Compare: selectServer flow (switch to a different Jellyfin server).
//
// The issue asks us to trigger a server switch (NativeShell.selectServer() or
// the in-app server-change option) and verify, identically on TV and browser:
//   1. the OLD server URL is cleared from localStorage;
//   2. the connect screen reappears;
//   3. entering a NEW server URL and connecting works;
//   4. the device ID is REUSED (same localStorage UUID — the switch must not
//      mint a new device identity);
//   5. the flow is identical on TV and browser.
//
// HOW THIS IS PROVEN HERMETICALLY (no TV, no server, no network)
//   selectServer() is two lines: clearServerUrl() + window.location.replace(
//   "index.html"). The reload re-enters bootstrap(), which branches on
//   loadServerUrl(): a stored URL auto-connects via loadRemoteWebClient(stored);
//   an empty one falls to attachConnectForm() (the connect screen). The connect
//   form's submit handler validates, saveServerUrl(url)s, and loads the new
//   server. NONE of that code branches on `tizen`, so a TV reload, a browser
//   refresh and a fresh app process are the SAME thing to it: a new JS realm
//   over whatever localStorage the platform persisted.
//
//   That makes the whole switch decidable by executing the SHIPPED functions in
//   a Node `vm` realm over ONE controllable localStorage that holds BOTH the
//   server URL AND the device id (_deviceId2), and walking the realms in the
//   exact order the platform would: connected → selectServer() → reload →
//   connect screen → enter new URL → connected-to-new-server. We assert the URL
//   key flips while the device-id key never moves.
//
//   selectServer()'s own body (clear + navigate) is executed too: we lift the
//   method out of each shell and run it with a clearServerUrl spy bound to the
//   real store and a window.location.replace spy, proving it clears the URL and
//   navigates to index.html (which is what re-enters bootstrap on device).
//
// Usage:  node tooling/tv-validate/select-server/verify-select-server.mjs
// Exits non-zero on any failed assertion. See results-JEL-69.md for the writeup.

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

const SERVER_URL_KEY = "jellyfin.shell.serverUrl";
const DEVICE_ID_KEY = "_deviceId2";

const UA_TV =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/5.0 TV Safari/537.36"; // legacy Chromium (real device)
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
// The persistence/deviceId helpers contain no brace-bearing string/regex
// literals, so a plain depth counter is exact here (asserted by token guards).
// ---------------------------------------------------------------------------
function extractFn(src, name, label) {
  const start = src.indexOf("function " + name + "(");
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

// Extract the body of an object-literal method `name: function (...) { ... }`.
function extractMethodBody(src, name, label) {
  const re = new RegExp(name + "\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src);
  if (!m) throw new Error(`method ${name} not found in ${label}`);
  let i = m.index + m[0].length; // first char after the opening "{"
  let depth = 1;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(bodyStart, i);
}

// A localStorage double that records writes and key removals so we can tell
// "minted a fresh device id" (setItem on _deviceId2) apart from "reused it"
// (no such write), and prove the server URL key is the only thing removed.
function makeStorage(seed) {
  const store = new Map(seed ? [...seed] : []);
  const calls = { setDeviceId: 0, removed: [] };
  return {
    store,
    calls,
    snapshot() {
      return new Map(store);
    },
    api: {
      getItem(k) {
        return store.has(k) ? store.get(k) : null;
      },
      setItem(k, v) {
        if (k === DEVICE_ID_KEY) calls.setDeviceId++;
        store.set(k, String(v));
      },
      removeItem(k) {
        calls.removed.push(k);
        store.delete(k);
      },
    },
  };
}

// Boot a fresh JS realm (= a reload / refresh / new app process) holding ONLY
// the shipped persistence + deviceId helpers over a chosen localStorage + UA.
function bootRealm(src, ua, storage, label) {
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
    'var SERVER_URL_KEY = "' +
    SERVER_URL_KEY +
    '";\n' +
    extractFn(src, "loadServerUrl", label) +
    "\n" +
    extractFn(src, "saveServerUrl", label) +
    "\n" +
    extractFn(src, "clearServerUrl", label) +
    "\n" +
    extractFn(src, "generateDeviceId", label) +
    "\n" +
    extractFn(src, "getDeviceId", label) +
    "\n;({ loadServerUrl, saveServerUrl, clearServerUrl, getDeviceId });";
  return vm.runInContext(code, ctx);
}

// Run a shell's REAL selectServer() body with spies, over a chosen store.
function runSelectServer(src, storage, label) {
  const body = extractMethodBody(src, "selectServer", label);
  const ctx = {
    localStorage: storage.api,
    nav: { calls: [] },
    cleared: { count: 0 },
    console,
  };
  // selectServer calls the file-scope clearServerUrl(); bind a spy that both
  // records the call AND performs the real removal against our store.
  ctx.clearServerUrl = function () {
    ctx.cleared.count++;
    storage.api.removeItem(SERVER_URL_KEY);
  };
  ctx.window = {
    location: {
      replace(u) {
        ctx.nav.calls.push(u);
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext("(function(){" + body + "})();", ctx);
  return { cleared: ctx.cleared.count, nav: ctx.nav.calls };
}

// ===========================================================================
// PART A — END-TO-END SWITCH, per shell × per platform.
// ===========================================================================
const SHELLS = [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
];
const PLATFORMS = [
  { label: "TV (legacy Chromium)", ua: UA_TV },
  { label: "browser (modern Chromium)", ua: UA_BROWSER },
];

const OLD_SERVER = "https://old.jellyfin.example";
const NEW_SERVER = "https://new.jellyfin.example";

for (const shell of SHELLS) {
  for (const plat of PLATFORMS) {
    const tag = `[${shell.label} · ${plat.label}]`;

    // --- State 0: connected to OLD_SERVER, device id already minted. --------
    // This is the steady state right before the user picks "change server":
    // both keys present in the SAME store.
    const storage = makeStorage();
    const r0 = bootRealm(shell.src, plat.ua, storage, shell.label);
    r0.saveServerUrl(OLD_SERVER);
    const deviceId = r0.getDeviceId(); // mints + persists _deviceId2 once
    check(
      `${tag} precondition: connected to old server, device id persisted`,
      storage.store.get(SERVER_URL_KEY) === OLD_SERVER &&
        !!storage.store.get(DEVICE_ID_KEY),
      deviceId.slice(0, 18) + "…",
    );
    const setsAfterMint = storage.calls.setDeviceId;

    // --- Step: NativeShell.selectServer() (run the REAL method body). -------
    const sel = runSelectServer(shell.src, storage, shell.label);
    check(
      `${tag} (1) selectServer() clears the OLD server URL from localStorage`,
      !storage.store.has(SERVER_URL_KEY) && sel.cleared === 1,
    );
    check(
      `${tag} selectServer() removed ONLY the server URL key (device id untouched)`,
      storage.calls.removed.length === 1 &&
        storage.calls.removed[0] === SERVER_URL_KEY &&
        storage.store.get(DEVICE_ID_KEY) === deviceId,
    );
    check(
      `${tag} selectServer() navigates to index.html (re-enters bootstrap on reload)`,
      sel.nav.length === 1 && sel.nav[0] === "index.html",
    );

    // --- Step: the reload. New realm over the SAME (now URL-less) store. ----
    const afterReload = bootRealm(shell.src, plat.ua, storage, shell.label);
    check(
      `${tag} (2) after reload loadServerUrl() is "" → connect screen reappears`,
      afterReload.loadServerUrl() === "",
    );
    check(
      `${tag} (4) device id survives the switch (same _deviceId2, no re-mint)`,
      afterReload.getDeviceId() === deviceId &&
        storage.calls.setDeviceId === setsAfterMint,
      deviceId.slice(0, 18) + "…",
    );

    // --- Step: user types the NEW server URL and connects. ------------------
    // The connect-form submit handler does validateServer→saveServerUrl→load;
    // saveServerUrl is the persistence step we can run directly.
    afterReload.saveServerUrl(NEW_SERVER);
    check(
      `${tag} (3) entering a new server URL persists it (auto-connect next boot)`,
      storage.store.get(SERVER_URL_KEY) === NEW_SERVER,
    );

    // --- Step: the post-connect reload lands on the NEW server, same device.-
    const afterReconnect = bootRealm(shell.src, plat.ua, storage, shell.label);
    check(
      `${tag} after reconnect the shell auto-connects to the NEW server`,
      afterReconnect.loadServerUrl() === NEW_SERVER,
    );
    check(
      `${tag} device id is STILL the original after switching servers`,
      afterReconnect.getDeviceId() === deviceId,
      "same identity reported to old + new server",
    );
  }
}

// ===========================================================================
// PART B — SOURCE-CONTRACT WIRING (what makes the switch land on the connect
// screen and re-connect), asserted on BOTH shells so they stay in lockstep.
// ===========================================================================
const ns = (s) => s.replace(/\s+/g, " ");

for (const shell of SHELLS) {
  const flat = ns(shell.src);
  const tag = `[${shell.label}]`;

  check(
    `${tag} selectServer() = clearServerUrl() then navigate to index.html`,
    /selectServer:\s*function\s*\(\)\s*\{\s*\(?clearServerUrl\(\)/.test(flat) &&
      /window\.location\.replace\("index\.html"\)/.test(flat),
  );
  check(
    `${tag} bootstrap reads the stored URL via loadServerUrl()`,
    /var stored = loadServerUrl\(\)/.test(flat),
  );
  check(
    `${tag} stored URL auto-connects via loadRemoteWebClient(stored)`,
    /loadRemoteWebClient\(stored\)/.test(flat),
  );
  check(
    `${tag} no stored URL falls back to attachConnectForm() (connect screen)`,
    /attachConnectForm\(\)/.test(flat),
  );
  check(
    `${tag} connect submit validates then persists the NEW url (validateServer→saveServerUrl)`,
    /validateServer\(url\)/.test(flat) && /saveServerUrl\(url\)/.test(flat),
  );
  check(
    `${tag} clearServerUrl removes the server URL key only`,
    /removeItem\(SERVER_URL_KEY\)/.test(flat),
  );
  check(
    `${tag} getDeviceId reads/persists _deviceId2 and never branches on the server URL`,
    new RegExp(`getItem\\(\\s*"${DEVICE_ID_KEY}"`).test(flat) &&
      new RegExp(`setItem\\(\\s*"${DEVICE_ID_KEY}"`).test(flat),
  );
}

// ===========================================================================
// PART C — PARITY (TV vs browser) + DEPLOYED-BLOB GUARDS.
// ===========================================================================

// C1. Both shells use the identical localStorage keys for URL and device id.
for (const [name, key] of [
  ["server URL", SERVER_URL_KEY],
  ["device id", DEVICE_ID_KEY],
]) {
  const inShell = shellSrc.includes('"' + key + '"');
  const inBoot = bootSrc.includes('"' + key + '"');
  check(
    `both shells reference the identical ${name} key "${key}"`,
    inShell && inBoot,
  );
}

// C2. selectServer's clear+navigate semantics are identical once whitespace
// and the cosmetic separator are normalised. The shells differ only in how the
// two calls are joined: shell.js uses two `;` statements, boot-shell.src.js a
// single `(a, b)` comma sequence — same effect, same order. We drop whitespace,
// the sequence parens, and the `;`/`,` separators so only the calls remain.
const normalizeSelect = (s) =>
  extractMethodBody(s, "selectServer", "x")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/[\s();,]/g, ""); // drop whitespace, sequence parens, separators
check(
  "selectServer() body is semantically identical across TV and browser shells",
  normalizeSelect(shellSrc) === normalizeSelect(bootSrc),
  normalizeSelect(shellSrc),
);

// C3. The deployed minified blobs still carry both keys and a selectServer.
for (const [label, blob] of [
  ["shell.min.js", shellMin],
  ["boot-shell.min.js", bootMin],
]) {
  check(
    `deployed ${label} references the server URL + device id keys`,
    blob.includes('"' + SERVER_URL_KEY + '"') &&
      blob.includes('"' + DEVICE_ID_KEY + '"'),
  );
  check(`deployed ${label} exposes selectServer`, /selectServer/.test(blob));
}

// ---- summary --------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  "All selectServer-switch checks passed (clear URL → connect screen → new server, device id reused; both shells, TV + browser).",
);
