/*
 * JELA-30 (WS-C/C3): opt-in boot-ring diag beacon.
 *
 * The shell posts the persisted JEL-617 bootPhases ring (last 10 boots) +
 * this boot's __shellTx* counters to the server-plugin's POST /shell/diag so
 * boot health is readable off a fielded TV without an sdb/CDP session. This
 * test extracts the SHIPPED diagBeaconPostBody()/injectDiagBeaconPost() out
 * of the shell source and drives the beacon through stubbed
 * window/localStorage/XHR + a virtual clock, pinning:
 *   - OPT-IN: inert (no interval, no XHR, nothing on window) unless
 *     localStorage['jellyfin.shell.diagBeacon'] === '1'
 *   - egress/redaction (JEL-139, WS-F): payload carries ONLY
 *     {id, ring, tx, ver} — the opaque [0-9a-z] device id, the numeric ring
 *     records, numeric tx counters, the shell version; the server URL is the
 *     POST TARGET only and never appears in the body, nor do credentials
 *   - opaque id: fnv1a-base36 of a random seed, persisted at
 *     jellyfin.shell.diagId, matches ^[0-9a-z]{6,24}$, reused across boots
 *   - send discipline: one POST per boot, fired once home/card lands or at
 *     the 60 s cap; armed latch makes a re-injected copy a no-op; no ring ->
 *     no POST; Content-Type text/plain (CORS simple request), no preflight
 *   - both written-document injection sites present (DOMParser path call +
 *     string fast-path splice) and the test chain runs this file
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");

function extractFn(name) {
  const marker = "function " + name + "(";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + SRC);
  let i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const bodyFnSrc = extractFn("diagBeaconPostBody");
const body = new Function(bodyFnSrc + "; return diagBeaconPostBody();")();

// ---- static contract checks -------------------------------------------------
assert(
  body.indexOf("</script") === -1,
  "diagBeaconPostBody must not contain a </script> literal",
);
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf('"jellyfin.shell.diagBeacon"') !== -1,
  "opt-in localStorage gate missing",
);
assert(body.indexOf("/shell/diag") !== -1, "POST target /shell/diag missing");
assert(
  body.indexOf("text/plain") !== -1,
  "Content-Type text/plain (CORS simple request) missing",
);
assert(
  body.indexOf("__shellDiagBeaconArmed") !== -1,
  "armed latch missing (re-injection would double-post)",
);
// The device id must never come from platform identity APIs.
for (const forbidden of ["webapis", "tizen", "duid", "getDuid", "systeminfo"]) {
  assert(
    body.toLowerCase().indexOf(forbidden.toLowerCase()) === -1,
    "beacon body must not touch platform identity: " + forbidden,
  );
}

// Both written-document injection sites.
assert(
  text.indexOf("injectDiagBeaconPost(doc);") !== -1,
  "DOMParser-path injection site missing",
);
assert(
  /instantHomeTag \+\s*diagBeaconTag;/.test(text),
  "string fast-path splice missing",
);

// Test chain includes this file.
const pkg = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
assert(
  pkg.indexOf("diag-beacon.test.cjs") !== -1,
  "diag-beacon.test.cjs missing from the npm test chain",
);

// ---- behavioural: stubbed env + virtual clock --------------------------------
function makeEnv(ls, win) {
  const store = new Map(Object.entries(ls || {}));
  const clock = { now: 100000 };
  function FakeDate() {}
  FakeDate.prototype.valueOf = function () {
    return clock.now;
  };
  const intervals = [];
  const env = {
    window: win || {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    store,
    clock,
    intervals,
    xhrs: [],
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length;
    },
    clearInterval: (id) => {
      if (intervals[id - 1]) intervals[id - 1].cleared = true;
    },
    FakeDate,
    tick(advanceMs) {
      clock.now += advanceMs;
      for (const iv of intervals) if (!iv.cleared) iv.fn();
    },
    run() {
      new Function(
        "window",
        "localStorage",
        "XMLHttpRequest",
        "setInterval",
        "clearInterval",
        "Date",
        body,
      )(
        env.window,
        env.localStorage,
        XHR,
        env.setInterval,
        env.clearInterval,
        env.FakeDate,
      );
    },
  };
  function XHR() {
    this.headers = {};
    env.xhrs.push(this);
  }
  XHR.prototype.open = function (m, u) {
    this.method = m;
    this.url = u;
  };
  XHR.prototype.setRequestHeader = function (k, v) {
    this.headers[k.toLowerCase()] = v;
  };
  XHR.prototype.send = function (b) {
    this.body = b;
  };
  return env;
}

const RING = [
  {
    ts: 1719990000000,
    nav: 1400,
    connect: 800,
    dcl: 3000,
    home: 9000,
    card: 9200,
    ver: "1.0.75",
  },
  { ts: 1720000000000, nav: 1500, connect: 900, dcl: 3100, ver: "1.0.75" },
];
const SERVER = "https://tv-owner-server.example:8096/";
const LS_ON = {
  "jellyfin.shell.diagBeacon": "1",
  "jellyfin.shell.serverUrl": SERVER,
  "jellyfin.shell.bootPhases": JSON.stringify(RING),
  jellyfin_credentials: JSON.stringify({
    Servers: [{ AccessToken: "seekrit-token-0123", UserId: "user-guid-1" }],
  }),
};
const WIN = () => ({
  __shellPhases: {
    ts: 1720000000000,
    nav: 1500,
    ver: "1.0.75",
    home: 9100,
    card: 9300,
  },
  __shellTxSkipCount: 56,
  __shellTxDoCount: 1,
  __shellTxDrop: { ok: { base: "x" }, h: 0, m: 1, r: 0, f: 0 },
});

// 1. Default OFF: no flag -> completely inert.
{
  const env = makeEnv({ "jellyfin.shell.serverUrl": SERVER }, WIN());
  env.run();
  assert.strictEqual(env.intervals.length, 0, "opt-out must not arm any timer");
  assert.strictEqual(env.xhrs.length, 0, "opt-out must not touch the network");
  assert.ok(!env.window.__shellDiagBeaconArmed, "opt-out must not latch");
}

// 2. Opt-in happy path: home mark present -> one clean POST.
{
  const env = makeEnv(LS_ON, WIN());
  env.run();
  assert.strictEqual(env.intervals.length, 1, "expected the 3 s poll");
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 1, "expected exactly one POST");
  const x = env.xhrs[0];
  assert.strictEqual(x.method, "POST");
  assert.strictEqual(
    x.url,
    "https://tv-owner-server.example:8096/shell/diag",
    "POST target must be <serverUrl>/shell/diag (trailing slash stripped)",
  );
  assert.strictEqual(x.headers["content-type"], "text/plain");

  const p = JSON.parse(x.body);
  // Whitelist of top-level payload keys — nothing else may ride along.
  assert.deepStrictEqual(Object.keys(p).sort(), ["id", "ring", "tx", "ver"]);
  assert.ok(/^[0-9a-z]{6,24}$/.test(p.id), "id must be opaque base36: " + p.id);
  assert.deepStrictEqual(p.ring, RING, "ring must be the persisted bootPhases");
  assert.deepStrictEqual(p.tx, {
    skip: 56,
    done: 1,
    drop: { ok: 1, h: 0, m: 1, r: 0, f: 0 },
  });
  assert.strictEqual(p.ver, "1.0.75");
  // Egress audit: the server URL is the TARGET, never the payload; no creds.
  for (const leak of [
    "tv-owner-server",
    "8096",
    "seekrit",
    "user-guid",
    "AccessToken",
    "serverUrl",
  ]) {
    assert.ok(
      x.body.indexOf(leak) === -1,
      "EGRESS LEAK: beacon body contains '" + leak + "'",
    );
  }
  // Opaque id persisted for reuse across boots.
  assert.strictEqual(env.store.get("jellyfin.shell.diagId"), p.id);

  // One-shot: further ticks post nothing.
  env.tick(3000);
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 1, "beacon must POST once per boot");

  // Re-injection (document.write re-runs the body): armed latch no-ops.
  env.run();
  assert.strictEqual(env.intervals.length, 1, "re-injection must not re-arm");
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 1, "re-injection must not re-post");
}

// 3. Persisted id is reused verbatim.
{
  const env = makeEnv(
    Object.assign({}, LS_ON, { "jellyfin.shell.diagId": "abc123xyz" }),
    WIN(),
  );
  env.run();
  env.tick(3000);
  assert.strictEqual(JSON.parse(env.xhrs[0].body).id, "abc123xyz");
}

// 4. No home/card mark yet: waits, then fires at the 60 s cap.
{
  const win = WIN();
  delete win.__shellPhases.home;
  delete win.__shellPhases.card;
  const env = makeEnv(LS_ON, win);
  env.run();
  for (let t = 0; t < 57000; t += 3000) env.tick(3000);
  assert.strictEqual(env.xhrs.length, 0, "must not post before home/card/cap");
  env.tick(3000);
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 1, "60 s cap must flush the beacon");
}

// 5. No persisted ring -> nothing to report, no POST.
{
  const ls = Object.assign({}, LS_ON);
  delete ls["jellyfin.shell.bootPhases"];
  const env = makeEnv(ls, WIN());
  env.run();
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 0, "empty ring must not POST");
}

// 6. No saved server URL -> no target, no POST.
{
  const ls = Object.assign({}, LS_ON);
  delete ls["jellyfin.shell.serverUrl"];
  const env = makeEnv(ls, WIN());
  env.run();
  env.tick(3000);
  assert.strictEqual(env.xhrs.length, 0, "no serverUrl must not POST");
}

console.log("diag-beacon.test.cjs OK");
