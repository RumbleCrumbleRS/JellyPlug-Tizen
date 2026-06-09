// JEL-31 verification test — Server URL persistence in localStorage across
// sessions, compared TV-shell vs hosted/browser-shell.
//
// What the issue asks us to prove:
//   1. After a successful connect, `jellyfin.shell.serverUrl` is persisted in
//      localStorage and survives across launches ("sessions").
//   2. On next launch the shell skips the connect screen and auto-connects
//      from the stored URL.
//   3. The clearServerUrl path (switching servers) removes the key and falls
//      back to the connect screen. (JEL-63: an *unreachable* saved server does
//      NOT clear the key — it re-shows the connect form with the URL pre-filled
//      so the user can retry the same host.)
//   4. TV shell (shell-tizen/src/shell.js) and hosted/browser shell
//      (shell-tizen-bootstrap/src/boot-shell.src.js) agree on all of the above
//      — same key, same semantics. This is the "Compare" half of the ticket.
//
// Strategy: there is no DOM test runner in this repo, so we (a) run the REAL
// persistence functions, lifted verbatim out of the source, inside a `vm`
// sandbox backed by a fake localStorage — this exercises the actual stored-key
// behaviour across simulated sessions; and (b) source-assert the bootstrap /
// connect-form / selectServer wiring that decides auto-connect vs connect
// screen, on BOTH shells, so the two stay in lockstep.
//
// Run: node scripts/server-url-persistence.test.cjs
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

const EXPECTED_KEY = "jellyfin.shell.serverUrl";

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

// --- Fake localStorage that mimics the browser Storage contract -------------
function makeStore() {
  const map = new Map();
  let throwMode = false;
  const ls = {
    getItem(k) {
      if (throwMode) throw new Error("storage disabled");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwMode) throw new Error("storage disabled");
      map.set(k, String(v));
    },
    removeItem(k) {
      if (throwMode) throw new Error("storage disabled");
      map.delete(k);
    },
  };
  return {
    ls,
    raw: map,
    setThrow(v) {
      throwMode = v;
    },
  };
}

// Build a sandbox that exposes the REAL persistence functions from a shell's
// source. We extract the SERVER_URL_KEY declaration and the three functions
// verbatim and evaluate them against the supplied fake localStorage, so the
// behaviour under test is the shipped code, not a reimplementation.
function loadPersistence(src, label, store) {
  const keyMatch = src.match(/SERVER_URL_KEY\s*=\s*"([^"]+)"/);
  if (!keyMatch) throw new Error(label + ": SERVER_URL_KEY not found");

  function extractFn(name) {
    const start = src.indexOf("function " + name + "(");
    if (start === -1) throw new Error(label + ": " + name + " not found");
    // Walk braces from the first "{" after the signature to find the body end.
    const open = src.indexOf("{", start);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return src.slice(start, i + 1);
  }

  const code =
    'var SERVER_URL_KEY = "' +
    keyMatch[1] +
    '";\n' +
    extractFn("loadServerUrl") +
    "\n" +
    extractFn("saveServerUrl") +
    "\n" +
    extractFn("clearServerUrl") +
    "\n" +
    "globalThis.__p = { loadServerUrl: loadServerUrl, saveServerUrl: saveServerUrl, clearServerUrl: clearServerUrl, KEY: SERVER_URL_KEY };";

  const sandbox = { localStorage: store.ls, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__p;
}

// --- Behavioural: run the real functions across simulated sessions ----------
function behavioural(src, label) {
  // Session 1: fresh launch, user connects to a server.
  const store = makeStore();
  let p = loadPersistence(src, label, store);

  check(label + ": stored key is " + EXPECTED_KEY, p.KEY === EXPECTED_KEY);
  check(
    label + ": cold launch with empty storage returns '' (=> connect screen)",
    p.loadServerUrl() === "",
  );

  p.saveServerUrl("https://demo.jellyfin.org");
  check(
    label + ": saveServerUrl writes the canonical key",
    store.raw.get(EXPECTED_KEY) === "https://demo.jellyfin.org",
  );

  // Session 2: app relaunched. Re-evaluate the functions (new closures) against
  // the SAME backing store — this is exactly what "persist across sessions"
  // means: a brand-new process still sees the value.
  p = loadPersistence(src, label, store);
  check(
    label + ": next launch reads back the persisted URL (=> auto-connect)",
    p.loadServerUrl() === "https://demo.jellyfin.org",
  );

  // Session 3: user switches servers -> clearServerUrl, then relaunch.
  p.clearServerUrl();
  check(
    label + ": clearServerUrl removes the key from storage",
    !store.raw.has(EXPECTED_KEY),
  );
  p = loadPersistence(src, label, store);
  check(
    label + ": after clear, next launch returns '' (=> connect screen again)",
    p.loadServerUrl() === "",
  );

  // Resilience: a throwing/disabled Storage must be swallowed, not crash boot.
  const bad = makeStore();
  const pb = loadPersistence(src, label, bad);
  bad.setThrow(true);
  let threw = false;
  try {
    check(
      label + ": loadServerUrl on broken storage returns ''",
      pb.loadServerUrl() === "",
    );
    pb.saveServerUrl("x");
    pb.clearServerUrl();
  } catch (e) {
    threw = true;
  }
  check(label + ": persistence calls never throw on broken storage", !threw);
}

// --- Source contract: the boot/connect/select wiring around the key ---------
// Normalise whitespace so the same assertions match both the readable TV shell
// and the minifier-friendly comma-sequence style in boot-shell.src.js.
function ns(s) {
  return s.replace(/\s+/g, " ");
}

function wiring(src, label) {
  const flat = ns(src);

  check(
    label + ": bootstrap reads the stored URL via loadServerUrl()",
    /var stored = loadServerUrl\(\)/.test(flat),
  );
  check(
    label + ": stored URL auto-connects via loadRemoteWebClient(stored)",
    /loadRemoteWebClient\(stored\)/.test(flat),
  );
  check(
    label + ": no stored URL falls back to attachConnectForm()",
    /attachConnectForm\(\)/.test(flat),
  );
  check(
    label + ": connect submit persists via saveServerUrl(url) after validate",
    /validateServer\(url\)/.test(flat) && /saveServerUrl\(url\)/.test(flat),
  );
  // JEL-63: an unreachable saved server must NOT clear the key — it shows the
  // connect form (with the saved URL pre-filled for one-press retry) and a
  // network error, keeping the URL so the user can retry the same host. The
  // old behaviour (clearServerUrl() immediately before attachConnectForm() in
  // the boot-failure catch) is the regression this guards against.
  check(
    label + ": unreachable saved server does NOT clear the key in the boot catch",
    !/clearServerUrl\(\)[;,]?\s*attachConnectForm\(\)/.test(flat),
  );
  check(
    label + ": unreachable saved server shows the network error + connect form",
    /loadRemoteWebClient\(stored\)\.catch\(function \(\) \{/.test(flat) &&
      /Could not reach saved server\. Check your network and try again\./.test(
        flat,
      ),
  );
  check(
    label + ": connect form pre-fills the saved URL for retry",
    /var saved = loadServerUrl\(\)/.test(flat),
  );
  check(
    label + ": selectServer() switch clears the stored URL",
    /selectServer: function \(\) \{ \(?clearServerUrl\(\)/.test(flat),
  );
}

console.log("--- behavioural (real functions, simulated sessions) ---");
behavioural(tvSrc, "TV shell.js");
behavioural(hostedSrc, "hosted boot-shell.src.js");

console.log("--- wiring (bootstrap / connect / selectServer) ---");
wiring(tvSrc, "TV shell.js");
wiring(hostedSrc, "hosted boot-shell.src.js");

console.log("--- parity (TV vs browser/hosted) ---");
const tvKey = tvSrc.match(/SERVER_URL_KEY\s*=\s*"([^"]+)"/)[1];
const hostedKey = hostedSrc.match(/SERVER_URL_KEY\s*=\s*"([^"]+)"/)[1];
check(
  "both shells use the identical localStorage key '" + EXPECTED_KEY + "'",
  tvKey === EXPECTED_KEY && hostedKey === EXPECTED_KEY,
);

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nAll server-URL persistence checks passed.");
