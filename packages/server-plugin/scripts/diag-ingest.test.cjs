#!/usr/bin/env node
/*
 * diag-ingest.test.cjs — JELA-30 (WS-C/C3) guard for the boot-ring diag
 * ingest. The C# plugin isn't compiled in this repo's node CI (only the
 * release workflow builds it), so — like lockstep.test.cjs — this test pins
 * the SECURITY-CRITICAL contract two ways:
 *
 *   1. Source pins: the whitelist field lists, the two redaction extractors
 *      (longest [0-9a-z] run for the id, leading dotted-numeric match for the
 *      ver), the body-size cap, the anonymous-POST / admin-only-report
 *      authorization split, and the operator kill switch must all be present
 *      in the C# exactly as designed. If someone loosens the sanitizer (e.g.
 *      swaps extraction back to character stripping), this fails.
 *
 *   2. Behavioural mirror: a faithful JS re-implementation of the sanitizer
 *      is fed a deliberately hostile payload (server URL, access token, email,
 *      DUID, giant string, NaN, nested junk) and we PROVE the output carries
 *      only whitelisted numeric + opaque fields — no URL, no PII, nothing a
 *      redaction audit (WS-F, folded into this issue) would flag.
 *
 * Run: node packages/server-plugin/scripts/diag-ingest.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const svc = fs.readFileSync(path.join(ROOT, "DiagIngestService.cs"), "utf8");
const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);
const cfg = fs.readFileSync(path.join(ROOT, "PluginConfiguration.cs"), "utf8");
const reg = fs.readFileSync(
  path.join(ROOT, "PluginServiceRegistrator.cs"),
  "utf8",
);

// ---- 1. source-pin the contract --------------------------------------------

// The exact whitelist of numeric ring fields (mirrored by the JS below).
const RING_NUM_FIELDS = [
  "ts",
  "nav",
  "connect",
  "dcl",
  "api",
  "login",
  "home",
  "card",
  "snap",
];
for (const f of RING_NUM_FIELDS) {
  assert.ok(
    new RegExp('"' + f + '"').test(svc),
    "ring whitelist field missing in C#: " + f,
  );
}
// The RingNumFields array literal, in order.
assert.ok(
  svc.includes(
    '"ts", "nav", "connect", "dcl", "api", "login", "home", "card", "snap"',
  ),
  "RingNumFields array literal drifted from the pinned whitelist",
);

// The two redaction extractors. These are the load-bearing egress guard:
// id keeps only the longest [0-9a-z] run; ver keeps only a LEADING
// dotted-numeric version match. Extraction (not character stripping) is
// deliberate — stripping "https://home.example.org" leaves a dotted hostname
// that still leaks; extraction leaves nothing.
assert.ok(
  svc.includes('new("[0-9a-z]+"'),
  "opaque-id run-extraction regex [0-9a-z]+ missing/changed",
);
assert.ok(
  svc.includes('new("^[0-9]+(\\\\.[0-9]+)*(-[0-9A-Za-z]+)?"'),
  "leading-version match regex missing/changed",
);

// Ring records with no timestamp are dropped; free-form spreads never happen.
assert.ok(
  svc.includes("return null; // a ring record with no boot timestamp"),
  "ts-required guard missing",
);
assert.ok(
  /finite number|IsNaN|IsInfinity/.test(svc),
  "numeric coercion must reject NaN/Infinity",
);

// Bounded store.
assert.ok(
  /DiagMaxRings/.test(svc) && /DiagMaxRings/.test(cfg),
  "DiagMaxRings cap missing",
);
assert.ok(
  /DiagMaxRings\s*{\s*get;\s*set;\s*}\s*=\s*5000;/.test(cfg),
  "DiagMaxRings default 5000 missing",
);

// Controller: anonymous ingest, admin-only report, body cap.
assert.ok(
  /\[HttpPost\("diag"\)\]/.test(ctrl),
  "POST /shell/diag route missing",
);
assert.ok(
  /\[HttpGet\("diag\/report"\)\]/.test(ctrl),
  "GET /shell/diag/report route missing",
);
// The report — and ONLY the report — is elevation-gated.
const reportIdx = ctrl.indexOf('[HttpGet("diag/report")]');
const reportSlice = ctrl.slice(reportIdx, reportIdx + 220);
assert.ok(
  /\[Authorize\(Policy = "RequiresElevation"\)\]/.test(reportSlice),
  "diag report must be [Authorize(Policy=RequiresElevation)]",
);
const postIdx = ctrl.indexOf('[HttpPost("diag")]');
const postSlice = ctrl.slice(postIdx, ctrl.indexOf("public", postIdx));
assert.ok(
  !/\[Authorize/.test(postSlice),
  "POST /shell/diag must stay anonymous (a TV posts before login)",
);
assert.ok(/MaxDiagBodyBytes/.test(ctrl), "body-size cap missing");
assert.ok(/StatusCode\(413\)/.test(ctrl), "over-cap body must 413");
assert.ok(
  /DisableDiagIngest/.test(ctrl) && /DisableDiagIngest/.test(cfg),
  "operator ingest kill switch missing",
);

// Service is registered for DI.
assert.ok(
  /AddSingleton<DiagIngestService>\(\)/.test(reg),
  "DiagIngestService not registered",
);

// ---- 2. behavioural mirror of the sanitizer --------------------------------
// Faithful JS port of DiagIngestService.CleanRing / CleanTx / SanitizeId/Ver.

function sanitizeId(v) {
  if (typeof v !== "string" || !v) return "";
  const runs = v.match(/[0-9a-z]+/g) || [];
  let best = "";
  for (const r of runs) if (r.length > best.length) best = r;
  return best.slice(0, 24);
}
function sanitizeVer(v) {
  if (typeof v !== "string" || !v) return "";
  const m = v.match(/^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z]+)?/);
  return m ? m[0].slice(0, 24) : "";
}
function num(v) {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  return v;
}
function cleanRing(rec) {
  if (!rec || typeof rec !== "object") return null;
  const out = {};
  for (const f of RING_NUM_FIELDS) {
    const n = num(rec[f]);
    if (n !== undefined) out[f] = n;
  }
  if (!("ts" in out)) return null;
  const ver = sanitizeVer(rec.ver);
  if (ver) out.ver = ver;
  return out;
}
function cleanTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  const out = {};
  for (const k of ["skip", "done"]) {
    const n = num(tx[k]);
    if (n !== undefined) out[k] = n;
  }
  if (tx.drop && typeof tx.drop === "object") {
    const d = {};
    for (const k of ["ok", "h", "m", "r", "f"]) {
      const n = num(tx.drop[k]);
      if (n !== undefined) d[k] = n;
    }
    if (Object.keys(d).length) out.drop = d;
  }
  return Object.keys(out).length ? out : null;
}
function ingest(root) {
  if (!root || typeof root !== "object") return null;
  const id = sanitizeId(root.id);
  if (!id) return null;
  const ver = sanitizeVer(root.ver);
  const tx = cleanTx(root.tx);
  if (!Array.isArray(root.ring)) return null;
  const rings = [];
  for (const r of root.ring.slice(0, 20)) {
    const c = cleanRing(r);
    if (c) rings.push(c);
  }
  if (!rings.length) return null;
  return rings.map((ring) => {
    const line = { id, rcv: 0, ring };
    if (ver) line.ver = ver;
    if (tx) line.tx = tx;
    return line;
  });
}

// A hostile beacon: every field a redaction audit cares about, in every slot.
const SERVER_URL = "https://home.tvowner-dynhost.example:8096/jellyfin";
const TOKEN = "e0d9a3f1c2b74e6a8f0d1c2b3a4e5f60";
const EMAIL = "operator@example.com";
const DUID = "AAABBBCCCDDDEEE1234567890";
const hostile = {
  id: DUID + " http://x", // longest [0-9a-z] run = the digit tail
  ver: SERVER_URL, // no leading digit -> extracts to nothing, dropped
  serverUrl: SERVER_URL, // non-whitelisted -> dropped entirely
  url: SERVER_URL,
  token: TOKEN,
  email: EMAIL,
  ua: "Mozilla/5.0 (SmartTV) ...",
  ring: [
    {
      ts: 1720000000000,
      nav: 1500,
      home: 9100,
      card: 9300,
      // hostile extras on a ring record:
      url: SERVER_URL,
      accessToken: TOKEN,
      title: "My Library — " + EMAIL,
      ver: "1.0.75" + SERVER_URL, // leading version extracted, junk gone
      evil: { nested: SERVER_URL },
      nanField: NaN,
      infField: Infinity,
    },
    { nav: 5 }, // no ts -> dropped
    "not-an-object", // dropped
  ],
  tx: {
    skip: 56,
    done: 1,
    drop: { ok: 1, h: 0, m: 1, r: 0, f: 0, secret: TOKEN },
    leak: SERVER_URL,
  },
};

const out = ingest(hostile);
assert.ok(
  Array.isArray(out) && out.length === 1,
  "expected exactly one clean ring",
);
const serialized = JSON.stringify(out);

// The redaction contract: NONE of the sensitive strings survive anywhere.
for (const needle of [
  "http",
  "://",
  "dynhost",
  "example",
  TOKEN,
  EMAIL,
  "Mozilla",
  "@",
  "/jellyfin",
  "title",
  "accessToken",
  "serverUrl",
  "evil",
  "leak",
  "secret",
]) {
  assert.ok(
    !serialized.includes(needle),
    "REDACTION LEAK: sanitized output contains '" + needle + "': " + serialized,
  );
}

const line = out[0];
// id reduced to its longest [0-9a-z] run (DUID uppercase + "http"/"x" gone).
assert.strictEqual(line.id, "1234567890", "id not reduced to longest run");
// top-level ver was a URL -> extracts to nothing -> field entirely absent.
assert.ok(!("ver" in line), "URL-shaped top-level ver must be dropped");
// Ring keeps ONLY whitelisted numeric fields + a cleaned ver.
const allowedRingKeys = new Set([...RING_NUM_FIELDS, "ver"]);
for (const k of Object.keys(line.ring)) {
  assert.ok(allowedRingKeys.has(k), "unexpected ring key survived: " + k);
}
assert.strictEqual(line.ring.ts, 1720000000000);
assert.strictEqual(line.ring.home, 9100);
assert.ok(
  !("nanField" in line.ring) && !("infField" in line.ring),
  "NaN/Inf leaked",
);
assert.strictEqual(
  line.ring.ver,
  "1.0.75",
  "ver junk not stripped to clean version",
);
// tx keeps only numeric counters.
assert.deepStrictEqual(
  line.tx,
  { skip: 56, done: 1, drop: { ok: 1, h: 0, m: 1, r: 0, f: 0 } },
  "tx not reduced to numeric counters",
);

// Opt-in / attribution guards.
assert.strictEqual(
  ingest({ ring: [{ ts: 1 }] }),
  null,
  "payload with no id accepted",
);
assert.strictEqual(
  ingest({ id: "abc" }),
  null,
  "payload with no ring array accepted",
);
assert.strictEqual(
  ingest({ id: "!!!", ring: [{ ts: 1 }] }),
  null,
  "id that sanitizes to empty must be rejected",
);

console.log("diag-ingest.test.cjs OK");
