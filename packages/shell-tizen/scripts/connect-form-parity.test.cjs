// JEL-314 retail connect-form parity test.
//
// Proves the RETAIL shell connect-form server probe (shell.js
// `validateServer`) carries the same two JEL-85 fixes that landed in the
// bootstrap shell (boot-shell.src.js). The retail connect form is a live
// path: bootstrap() calls attachConnectForm()+showError() when a saved
// server is unreachable at boot (JEL-63 recovery UX), and its submit handler
// calls this same validateServer.
//
//   1. fetch timeout — the /System/Info/Public probe is wrapped in a 5s
//      bounded timeout so a black-hole host (firewalled IP, no RST) typed
//      into the boot-failure recovery form shows an error instead of hanging
//      forever. The retail path must reject within the same 5s budget.
//   2. Version required — the probe response is rejected unless BOTH `Id` and
//      `Version` are present. A pathological `{Id:...}`-only endpoint must
//      fail on the retail form too (parity with the bootstrap).
//
// The test extracts the *shipped* `validateServer` + `withBootTimeout` (and
// their timeout constants) straight from src/shell.js and runs them in an
// isolated vm with an injected fetch + controllable timers — so it asserts
// the real code path, not a re-implementation.
//
// Run: node packages/shell-tizen/scripts/connect-form-parity.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const source = fs.readFileSync(SRC, "utf8");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// Extract a `function NAME(...) { ... }` declaration by brace-matching from the
// declaration keyword, skipping braces that appear inside string literals.
function extractFunction(src, name) {
  const start = src.indexOf("function " + name);
  if (start === -1) fail(`could not locate function ${name} in shell.js`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  fail(`unterminated function ${name} in shell.js`);
}

function extractConst(src, name) {
  const m = new RegExp("var " + name + "\\s*=\\s*([0-9]+)\\s*;").exec(src);
  if (!m) fail(`could not locate const ${name} in shell.js`);
  return Number(m[1]);
}

const BOOT_FETCH_TIMEOUT_MS = extractConst(source, "BOOT_FETCH_TIMEOUT_MS");
const CONNECT_FETCH_TIMEOUT_MS = extractConst(source, "CONNECT_FETCH_TIMEOUT_MS");

// Parity assertion #0: the connect budget must equal the bootstrap's 5000ms.
if (CONNECT_FETCH_TIMEOUT_MS !== 5000) {
  fail(
    `CONNECT_FETCH_TIMEOUT_MS is ${CONNECT_FETCH_TIMEOUT_MS}, expected 5000 ` +
      `(must mirror boot-shell.src.js connect-form budget)`,
  );
}

// Build a tiny module from the shipped function bodies + constants. We inject a
// controllable `setTimeout` so the timeout test is deterministic (no real wait).
const harness = `
  var BOOT_FETCH_TIMEOUT_MS = ${BOOT_FETCH_TIMEOUT_MS};
  var CONNECT_FETCH_TIMEOUT_MS = ${CONNECT_FETCH_TIMEOUT_MS};
  ${extractFunction(source, "withBootTimeout")}
  ${extractFunction(source, "validateServer")}
  globalThis.__validateServer = validateServer;
`;

// Controllable timers: record scheduled callbacks so the test can fire them.
const pendingTimers = [];
const sandbox = {
  fetch: null, // set per-case
  setTimeout: (cb, ms) => {
    const id = pendingTimers.length;
    pendingTimers.push({ cb, ms });
    return id;
  },
  clearTimeout: (id) => {
    if (typeof id === "number" && pendingTimers[id]) pendingTimers[id] = null;
  },
  Promise,
  Error,
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(harness, sandbox);
const validateServer = sandbox.__validateServer;

function fireTimer(ms) {
  const t = pendingTimers.find((t) => t && t.ms === ms);
  if (!t) fail(`expected a pending timer for ${ms}ms but none was scheduled`);
  t.cb();
}

async function run() {
  // ---- Case 1: missing Version must reject (parity gap fix) ----
  sandbox.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ Id: "abc-no-version" }),
    });
  let rejected = false;
  await validateServer("http://srv").then(
    () => {},
    (e) => {
      rejected = true;
      if (!/Not a Jellyfin server/.test(e.message))
        fail(`missing-Version rejected with wrong message: ${e.message}`);
    },
  );
  if (!rejected) fail("response with Id but no Version was accepted (parity gap)");
  console.log("OK 1: probe with Id but no Version → rejected");

  // ---- Case 2: Id + Version resolves (genuine Jellyfin) ----
  sandbox.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ Id: "abc", Version: "10.10.0" }),
    });
  const info = await validateServer("http://srv");
  if (!info || info.Id !== "abc" || info.Version !== "10.10.0")
    fail("valid Id+Version probe did not return the info object");
  console.log("OK 2: probe with Id + Version → resolved with info");

  // ---- Case 3: non-2xx still rejects (no regression) ----
  sandbox.fetch = () => Promise.resolve({ ok: false, status: 404 });
  let httpRejected = false;
  await validateServer("http://srv").then(
    () => {},
    (e) => {
      httpRejected = true;
      if (!/HTTP 404/.test(e.message))
        fail(`non-ok rejected with wrong message: ${e.message}`);
    },
  );
  if (!httpRejected) fail("non-2xx response was accepted");
  console.log("OK 3: non-2xx response → rejected (HTTP <status>)");

  // ---- Case 4: black-hole host rejects on the 5s timeout (UX-hang fix) ----
  pendingTimers.length = 0;
  sandbox.fetch = () => new Promise(() => {}); // never settles — firewalled IP, no RST
  let timedOut = false;
  const probe = validateServer("http://black-hole").then(
    () => {},
    (e) => {
      timedOut = true;
      if (!/Timed out reaching server \(connect\)/.test(e.message))
        fail(`timeout rejected with wrong message: ${e.message}`);
    },
  );
  // The connect probe must have armed a 5000ms timer (not the 15000ms boot one).
  if (!pendingTimers.some((t) => t && t.ms === 5000))
    fail("connect probe did not arm a 5000ms timeout");
  if (pendingTimers.some((t) => t && t.ms === BOOT_FETCH_TIMEOUT_MS))
    fail("connect probe armed the 15000ms boot timeout instead of 5000ms");
  fireTimer(5000);
  await probe;
  if (!timedOut) fail("black-hole host did not reject on the 5s timeout (hang)");
  console.log("OK 4: black-hole host → rejected on 5000ms timeout (no hang)");

  // ---- Case 5: withBootTimeout default budget is still 15000ms (boot path) ----
  // Guards that parameterizing the helper didn't change the boot default.
  if (BOOT_FETCH_TIMEOUT_MS !== 15000)
    fail(`boot timeout default changed to ${BOOT_FETCH_TIMEOUT_MS}, expected 15000`);
  console.log("OK 5: boot path default timeout unchanged (15000ms)");

  console.log("\nALL CONNECT-FORM PARITY CHECKS PASS");
}

run().catch((e) => fail(e && e.stack ? e.stack : String(e)));
