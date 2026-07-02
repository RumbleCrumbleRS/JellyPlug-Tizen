// JEL-617 boot-phase ring test.
//
// Proves the boot-phase recorder installed at shell IIFE entry:
//   1. creates a per-boot record {ts,nav,ver} and persists it to the
//      localStorage ring "jellyfin.shell.bootPhases" immediately (a boot
//      that dies mid-way still leaves a partial record);
//   2. window.__shellPhase(k) stamps a ms-from-t0 delta once (first mark
//      wins) and rewrites the SAME ring entry (keyed by ts) in place;
//   3. the ring is bounded to 10 entries (oldest shifted out);
//   4. the kill switch localStorage["jellyfin.shell.bootPhasesDisabled"]="1"
//      stops ring WRITES while window.__shellPhases still records in memory;
//   5. the diag seed forwards its __tm() marks into __shellPhase, polls the
//      hash for login/home/selectserver phases, and renders the cn/lg/hm
//      HUD line plus the previous boot's ring record;
//   6. the connect-form path marks the "connect" phase.
//
// The recorder block is extracted verbatim from the shipped source (between
// its JEL-617 breadcrumb and the SERVER_URL_KEY declaration) and executed in
// an isolated vm — asserting the real code path, not a re-implementation.
//
// Run: node packages/shell-tizen/scripts/boot-phase-ring.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const source = fs.readFileSync(SRC, "utf8");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// ---- extract the recorder block ----------------------------------------
const startMark = "// JEL-617: boot-phase ring.";
const endMark = "var SERVER_URL_KEY";
const start = source.indexOf(startMark);
const end = source.indexOf(endMark, start);
if (start === -1 || end === -1) {
  fail("could not locate the JEL-617 recorder block in shell.js");
}
const block = source.slice(start, end);
if (!/try\s*\{/.test(block) || block.indexOf("__shellPhase") === -1) {
  fail("extracted block does not look like the recorder IIFE");
}

// ---- vm harness ----------------------------------------------------------
function makeStore(initial) {
  const backing = Object.assign({}, initial || {});
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(backing, k)
        ? backing[k]
        : null;
    },
    setItem(k, v) {
      backing[k] = String(v);
    },
    _backing: backing,
  };
}

function runRecorder(opts) {
  opts = opts || {};
  let now = opts.now || 100000;
  const sandbox = {
    localStorage: makeStore(opts.seed),
    performance: { timing: { navigationStart: now - (opts.navDelta || 0) } },
    Date: { now: () => now },
    JSON,
    console,
  };
  sandbox.window = sandbox;
  if (opts.t0) sandbox.__shellT0 = opts.t0;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return {
    sandbox,
    ring() {
      return JSON.parse(
        sandbox.localStorage.getItem("jellyfin.shell.bootPhases") || "[]",
      );
    },
    tick(ms) {
      now += ms;
    },
  };
}

// 1. fresh boot: record created + persisted immediately, nav captured.
{
  const h = runRecorder({ navDelta: 1500 });
  const ring = h.ring();
  if (ring.length !== 1) fail(`fresh boot ring length ${ring.length} !== 1`);
  const rec = ring[0];
  if (rec.ts !== 100000) fail(`rec.ts ${rec.ts} !== t0`);
  if (rec.nav !== 1500) fail(`rec.nav ${rec.nav} !== 1500 (navigationStart delta)`);
  if (!rec.ver) fail("rec.ver missing (shell version not recorded)");
  if (!h.sandbox.__shellPhases) fail("window.__shellPhases not exposed");
  if (typeof h.sandbox.__shellPhase !== "function") {
    fail("window.__shellPhase not installed");
  }
}

// 2. phase marks: ms-from-t0, first mark wins, ring rewritten in place.
{
  const h = runRecorder({});
  h.tick(2000);
  h.sandbox.__shellPhase("connect");
  h.tick(3000);
  h.sandbox.__shellPhase("home");
  h.tick(9999);
  h.sandbox.__shellPhase("connect"); // dup — must NOT overwrite
  const ring = h.ring();
  if (ring.length !== 1) fail(`marked boot ring length ${ring.length} !== 1`);
  if (ring[0].connect !== 2000) fail(`connect ${ring[0].connect} !== 2000`);
  if (ring[0].home !== 5000) fail(`home ${ring[0].home} !== 5000`);
}

// 3. ring bound: 10 pre-existing boots + this one → oldest shifted, len 10.
{
  const prior = [];
  for (let i = 0; i < 10; i++) prior.push({ ts: i + 1, nav: 0 });
  const h = runRecorder({
    seed: { "jellyfin.shell.bootPhases": JSON.stringify(prior) },
  });
  const ring = h.ring();
  if (ring.length !== 10) fail(`ring length ${ring.length} !== 10 (bound)`);
  if (ring[0].ts !== 2) fail("oldest entry not shifted out");
  if (ring[9].ts !== 100000) fail("current boot not appended");
}

// 4. corrupt ring JSON is replaced, not fatal.
{
  const h = runRecorder({
    seed: { "jellyfin.shell.bootPhases": "{not json" },
  });
  if (h.ring().length !== 1) fail("corrupt ring not recovered");
}

// 5. kill switch: no LS writes, in-memory record still live.
{
  const h = runRecorder({
    seed: { "jellyfin.shell.bootPhasesDisabled": "1" },
  });
  h.sandbox.__shellPhase("connect");
  if (h.sandbox.localStorage.getItem("jellyfin.shell.bootPhases") !== null) {
    fail("kill switch did not stop ring writes");
  }
  if (!h.sandbox.__shellPhases) fail("kill switch disabled in-memory record");
}

// ---- seed + connect-form source assertions -------------------------------
if (
  !source.includes(
    'window.__shellT[k]=Date.now()-window.__shellT.t0;try{if(window.__shellPhase)window.__shellPhase(k);',
  )
) {
  fail("diag seed __tm() does not forward marks into __shellPhase");
}
if (
  !source.includes('h.indexOf("selectserver")!==-1') ||
  !source.includes('h.indexOf("login")!==-1') ||
  !source.includes('h.indexOf("home")!==-1')
) {
  fail("diag seed hash-route phase poll (login/home/selectserver) missing");
}
if (!source.includes('"t cn="+(T.connect||0)')) {
  fail("diag HUD timing line missing cn/lg/hm phase marks");
}
if (!source.includes('"prev cn="+(p.connect||0)')) {
  fail("diag HUD previous-boot ring line missing");
}
const connectFormAt = source.indexOf("function attachConnectForm");
const connectMarkAt = source.indexOf('window.__shellPhase("connect")', connectFormAt);
if (connectFormAt === -1 || connectMarkAt === -1) {
  fail('attachConnectForm does not mark the "connect" phase');
}

console.log("PASS: boot-phase ring (JEL-617) — recorder, bound, kill switch, seed marks");
