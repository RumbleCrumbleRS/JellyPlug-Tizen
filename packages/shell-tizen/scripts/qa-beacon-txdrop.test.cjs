// JEL-653 verification — qa-beacon.js surfaces pre-lowered drop (JEL-621)
// health so a stale drop is NOTICED, not discovered: every drop miss falls
// back to on-TV Babel silently, the boot just regresses to the 21-42 s
// class. The beacon payload's probe.txDrop must
//   - echo the window.__shellTxDrop {h,m,r,f} counters,
//   - derive stale=1 ONLY for the sustained-miss signature (manifest loaded
//     ok, zero hits, >=5 miss/reject/fail events),
//   - report null when no drop state exists on this boot (modern engine,
//     kill switch, /shell/ absent),
// and the beacon's production gating must stay intact.
//
// Run: node scripts/qa-beacon-txdrop.test.cjs

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BEACON = path.join(__dirname, "..", "src", "qa-beacon.js");
const beaconSrc = fs.readFileSync(BEACON, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Minimal Tizen-webview stand-in: window === global scope (the beacon is a
// window-level IIFE), storage seeded to open the QA gate, an XHR stub that
// captures the JSON payload, timers stubbed so nothing runs behind the
// test's back — postOnce is driven manually via window.__qaBeacon.post().
function runBeacon(opts) {
  opts = opts || {};
  const posts = [];
  const store = Object.assign(
    {
      "jellyfin.qa.overlay": "1",
      "jellyfin.qa.beaconUrl": "http://qa.local/beacon",
    },
    opts.store || {},
  );
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
  sandbox.document = {
    readyState: "complete",
    hidden: false,
    visibilityState: "visible",
    title: "t",
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  sandbox.addEventListener = () => {};
  sandbox.location = { href: "http://server.local/web/index.html" };
  sandbox.navigator = { userAgent: "test-ua" };
  sandbox.setTimeout = () => 0;
  sandbox.setInterval = () => 0;
  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.setRequestHeader = function () {};
  XHR.prototype.send = function (body) {
    posts.push(JSON.parse(body));
    if (this.onloadend) this.onloadend();
  };
  sandbox.XMLHttpRequest = XHR;
  if ("txDrop" in opts) sandbox.__shellTxDrop = opts.txDrop;
  vm.createContext(sandbox);
  vm.runInContext(beaconSrc, sandbox, { filename: "qa-beacon.js" });
  if (sandbox.__qaBeacon) sandbox.__qaBeacon.post();
  return { posts, sandbox };
}

// ---- sustained-miss signature -> stale=1 ---------------------------------
const stale = runBeacon({ txDrop: { ok: true, h: 0, m: 9, r: 1, f: 2 } });
check("beacon posted a payload", stale.posts.length === 1);
const staleTd = stale.posts[0] && stale.posts[0].probe && stale.posts[0].probe.txDrop;
check(
  "counters echoed verbatim",
  staleTd &&
    staleTd.ok === 1 &&
    staleTd.h === 0 &&
    staleTd.m === 9 &&
    staleTd.r === 1 &&
    staleTd.f === 2,
  JSON.stringify(staleTd),
);
check("sustained miss with zero hits flags stale=1", staleTd && staleTd.stale === 1);

// ---- healthy drop: hits present -> stale=0 -------------------------------
const healthy = runBeacon({ txDrop: { ok: true, h: 12, m: 30, r: 0, f: 0 } });
const healthyTd = healthy.posts[0].probe.txDrop;
check(
  "any hit clears the stale verdict even with misses",
  healthyTd && healthyTd.h === 12 && healthyTd.stale === 0,
  JSON.stringify(healthyTd),
);

// ---- transient misses below threshold -> stale=0 -------------------------
const low = runBeacon({ txDrop: { ok: true, h: 0, m: 4, r: 0, f: 0 } });
check(
  "sub-threshold misses stay stale=0 (no flapping on tiny boots)",
  low.posts[0].probe.txDrop && low.posts[0].probe.txDrop.stale === 0,
);

// ---- no drop state this boot -> null -------------------------------------
const absent = runBeacon({});
check(
  "no __shellTxDrop -> probe.txDrop is null",
  absent.posts[0].probe.txDrop === null,
);

// ---- production gating unchanged ------------------------------------------
const gated = runBeacon({ store: { "jellyfin.qa.overlay": null } });
check(
  "overlay gate still keeps the beacon off",
  gated.posts.length === 0 && !gated.sandbox.__qaBeacon,
);

process.exitCode = failures ? 1 : 0;
console.log(failures ? failures + " FAILURE(S)" : "all checks passed");
