// JEL-69 verification — selectServer flow (switch to a different Jellyfin
// server), compared TV-shell vs hosted/browser-shell.
//
// What the issue asks us to prove, identically on TV and browser:
//   1. selectServer() clears the OLD server URL from localStorage;
//   2. the connect screen reappears (next boot has no stored URL);
//   3. entering a NEW server URL and connecting persists + loads it;
//   4. the device id is REUSED — the switch removes ONLY the server URL key and
//      never re-mints localStorage["_deviceId2"];
//   5. all of the above is identical across the two shipped shells.
//
// This is the CI-wired contract guard. The richer, fully narrated end-to-end
// walk (precondition → selectServer → reload → connect → reconnect, under both
// UAs, with deployed-blob checks) lives at
//   tooling/tv-validate/select-server/verify-select-server.mjs   (60/60 PASS)
// and is documented in tooling/tv-validate/select-server/results-JEL-69.md.
//
// Strategy: there is no DOM test runner in this repo, so we run the REAL
// persistence + deviceId functions (lifted verbatim from each shell's source)
// inside a `vm` realm over one shared fake localStorage that holds BOTH keys,
// walking the switch sequence; plus we source-assert the selectServer/bootstrap
// wiring on BOTH shells so they stay in lockstep.
//
// Run: node scripts/select-server.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const HOSTED_SHELL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

const SERVER_URL_KEY = "jellyfin.shell.serverUrl";
const DEVICE_ID_KEY = "_deviceId2";
const OLD_SERVER = "https://old.jellyfin.example";
const NEW_SERVER = "https://new.jellyfin.example";

const UA_TV =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/5.0 TV Safari/537.36";
const UA_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name);
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const hostedSrc = fs.readFileSync(HOSTED_SHELL, "utf8");

// Extract a `function name(...) { ... }` declaration verbatim by brace-matching.
function extractFn(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1)
    throw new Error(label + ": function " + name + " not found");
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
  const m = new RegExp(name + "\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{").exec(
    src,
  );
  if (!m) throw new Error(label + ": method " + name + " not found");
  let i = m.index + m[0].length;
  const bodyStart = i;
  let depth = 1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(bodyStart, i);
}

// Fake localStorage that records device-id writes and removed keys.
function makeStore(seed) {
  const map = new Map(seed ? [...seed] : []);
  const calls = { setDeviceId: 0, removed: [] };
  const ls = {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (k === DEVICE_ID_KEY) calls.setDeviceId++;
      map.set(k, String(v));
    },
    removeItem(k) {
      calls.removed.push(k);
      map.delete(k);
    },
  };
  return {
    ls,
    calls,
    raw: map,
    snapshot() {
      return new Map(map);
    },
  };
}

// Boot a fresh realm (= reload / new app process) over a chosen store + UA.
function bootRealm(src, ua, store, label) {
  const sandbox = {
    navigator: { userAgent: ua },
    localStorage: store.ls,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    Date,
    Math,
    console,
  };
  vm.createContext(sandbox);
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
  return vm.runInContext(code, sandbox);
}

// Run a shell's REAL selectServer() body with spies over a chosen store.
function runSelectServer(src, store, label) {
  const body = extractMethodBody(src, "selectServer", label);
  const sandbox = { localStorage: store.ls, nav: [], cleared: 0, console };
  sandbox.clearServerUrl = function () {
    sandbox.cleared++;
    store.ls.removeItem(SERVER_URL_KEY);
  };
  sandbox.window = {
    location: {
      replace(u) {
        sandbox.nav.push(u);
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext("(function(){" + body + "})();", sandbox);
  return { cleared: sandbox.cleared, nav: sandbox.nav };
}

// --- Behavioural: walk the full switch over one shared store ----------------
function behavioural(src, label, ua) {
  const tag = label + " @ " + (ua === UA_TV ? "TV" : "browser");
  const store = makeStore();

  // State 0: connected to OLD_SERVER, device id minted + persisted.
  let r = bootRealm(src, ua, store, label);
  r.saveServerUrl(OLD_SERVER);
  const deviceId = r.getDeviceId();
  const mintsAfterBoot = store.calls.setDeviceId;
  check(
    tag + ": precondition — old URL + device id both persisted",
    store.raw.get(SERVER_URL_KEY) === OLD_SERVER && !!deviceId,
  );

  // selectServer(): the switch.
  const sel = runSelectServer(src, store, label);
  check(
    tag + ": (1) selectServer() clears the old server URL",
    !store.raw.has(SERVER_URL_KEY) && sel.cleared === 1,
  );
  check(
    tag + ": (4) selectServer() removes ONLY the URL key (device id untouched)",
    store.calls.removed.length === 1 &&
      store.calls.removed[0] === SERVER_URL_KEY &&
      store.raw.get(DEVICE_ID_KEY) === deviceId,
  );
  check(
    tag + ": selectServer() navigates to index.html",
    sel.nav.length === 1 && sel.nav[0] === "index.html",
  );

  // Reload → connect screen.
  r = bootRealm(src, ua, store, label);
  check(
    tag + ': (2) after switch loadServerUrl() is "" → connect screen',
    r.loadServerUrl() === "",
  );
  check(
    tag + ": (4) device id reused after the switch (no re-mint)",
    r.getDeviceId() === deviceId && store.calls.setDeviceId === mintsAfterBoot,
  );

  // Enter NEW server + connect, then reload onto it.
  r.saveServerUrl(NEW_SERVER);
  r = bootRealm(src, ua, store, label);
  check(
    tag + ": (3) new server URL persists → auto-connects next boot",
    r.loadServerUrl() === NEW_SERVER,
  );
  check(
    tag + ": (4) device id still original after reconnecting to new server",
    r.getDeviceId() === deviceId,
  );
}

// --- Source contract: the switch wiring, on both shells ---------------------
function wiring(src, label) {
  const flat = src.replace(/\s+/g, " ");
  check(
    label + ": selectServer() = clearServerUrl() then replace(index.html)",
    /selectServer:\s*function\s*\(\)\s*\{\s*\(?clearServerUrl\(\)/.test(flat) &&
      /window\.location\.replace\("index\.html"\)/.test(flat),
  );
  check(
    label + ": clearServerUrl removes the server URL key only",
    /removeItem\(SERVER_URL_KEY\)/.test(flat),
  );
  check(
    label + ": bootstrap auto-connects a stored URL, else shows connect form",
    /loadRemoteWebClient\(stored\)/.test(flat) &&
      /attachConnectForm\(\)/.test(flat),
  );
  check(
    label + ": connect submit validates then persists the new URL",
    /validateServer\(url\)/.test(flat) && /saveServerUrl\(url\)/.test(flat),
  );
  check(
    label + ": device id is independent of the server URL (no clear() of it)",
    new RegExp(`getItem\\(\\s*"${DEVICE_ID_KEY}"`).test(flat) &&
      !/localStorage\.clear\(\)/.test(flat),
  );
}

console.log("--- behavioural (real functions, full switch, TV + browser) ---");
for (const ua of [UA_TV, UA_BROWSER]) {
  behavioural(tvSrc, "TV shell.js", ua);
  behavioural(hostedSrc, "hosted boot-shell.src.js", ua);
}

console.log("--- wiring (selectServer / bootstrap / connect) ---");
wiring(tvSrc, "TV shell.js");
wiring(hostedSrc, "hosted boot-shell.src.js");

console.log("--- parity (TV vs browser/hosted) ---");
for (const [name, key] of [
  ["server URL", SERVER_URL_KEY],
  ["device id", DEVICE_ID_KEY],
]) {
  check(
    "both shells use the identical " + name + ' key "' + key + '"',
    tvSrc.includes('"' + key + '"') && hostedSrc.includes('"' + key + '"'),
  );
}
const norm = (s) =>
  extractMethodBody(s, "selectServer", "x").replace(/[\s();,]/g, "");
check(
  "selectServer() body is semantically identical across both shells",
  norm(tvSrc) === norm(hostedSrc),
);

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nAll selectServer-switch checks passed.");
