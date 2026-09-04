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

// JELA-879: `hsb` (the INSTALLED BOOTSTRAP version, read by the shell out of
// window.__hsbState.version) is the second whitelisted string. It MUST go
// through the same SanitizeVer extractor as `ver` — a plain copy would open a
// free-form string channel straight into the store, and the shell's value comes
// from the widget document, which is exactly the code we cannot update.
assert.ok(
  /root\.TryGetProperty\("hsb", out var hsbEl\)[\s\S]{0,160}SanitizeVer\(hsbEl\.GetString\(\)\)/.test(
    svc,
  ),
  "hsb must be extracted with SanitizeVer, not copied",
);
// Absent/unusable -> the key is not written (AC2: not null, not "").
assert.ok(
  /if \(topHsb\.Length > 0\)\s*\{\s*line\["hsb"\] = topHsb;/.test(svc),
  "hsb must only be stored when it sanitizes to something",
);
// Surfaced on the read side, and omitted from the JSON when null.
assert.ok(
  /\[JsonIgnore\(Condition = JsonIgnoreCondition\.WhenWritingNull\)\]\s*public string\? Hsb \{ get; set; \}/.test(
    svc,
  ),
  "DiagDeviceEntry.Hsb missing or not null-omitting",
);
assert.ok(
  /Hsb = line\.TryGetProperty\("hsb", out var hb\)/.test(svc),
  "BuildReport does not read hsb onto the device entry",
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
  for (const k of ["skip", "done", "ch", "cm", "jc"]) {
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
  // JELA-879: the installed bootstrap version goes through the SAME extractor
  // as ver — same shape (dotted numeric widget version), same egress guard.
  const hsb = sanitizeVer(root.hsb);
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
    // AC2: absent/unusable -> the key is not written at all, so a device on a
    // bootstrap that does not expose __hsbState never reads back as one that
    // reported an empty version.
    if (hsb) line.hsb = hsb;
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
  hsb: EMAIL, // JELA-879: same treatment as ver -> extracts to nothing
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
    ch: 120,
    cm: 4,
    jc: 1,
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
// JELA-879: an email-shaped hsb has no leading digit -> nothing extracted ->
// the key is absent, NOT null and NOT "".
assert.ok(!("hsb" in line), "email-shaped hsb must be dropped, not emptied");
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
  {
    skip: 56,
    done: 1,
    ch: 120,
    cm: 4,
    jc: 1,
    drop: { ok: 1, h: 0, m: 1, r: 0, f: 0 },
  },
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

// ---- 3. JELA-879: the bootstrap-version field ------------------------------
// AC1: a well-formed bootstrap version survives onto the stored line, so
// GET /shell/diag/report can report a per-device bootstrap version.
// AC2: a device whose bootstrap does not expose __hsbState carries NO hsb key.
// AC3: a hostile / overlong hsb is rejected exactly the way SanitizeVer rejects
// a hostile ver — proven here, by running the sanitizer, not by inspection.
{
  const base = { id: "abc123xyz", ring: [{ ts: 1720000000000 }] };
  const hsbOf = (v) => ingest(Object.assign({}, base, { hsb: v }))[0];

  // AC1: the two versions actually installed on hardware today.
  assert.strictEqual(hsbOf("2.0.19").hsb, "2.0.19", "clean hsb must survive");
  assert.strictEqual(hsbOf("2.0.20").hsb, "2.0.20");
  // Pre-release suffix, same grammar the shell version uses.
  assert.strictEqual(hsbOf("2.0.26-rc1").hsb, "2.0.26-rc1");

  // AC2: absent / non-string / empty -> the KEY IS ABSENT. An old bootstrap
  // that never sets window.__hsbState must not poison the ring with a
  // sentinel that a later reader mistakes for a real version.
  for (const [label, payload] of [
    ["absent", base],
    ["undefined", Object.assign({}, base, { hsb: undefined })],
    ["null", Object.assign({}, base, { hsb: null })],
    ["empty string", Object.assign({}, base, { hsb: "" })],
    ["number", Object.assign({}, base, { hsb: 2.02 })],
    ["object", Object.assign({}, base, { hsb: { version: "2.0.19" } })],
    ["array", Object.assign({}, base, { hsb: ["2.0.19"] })],
    ["boolean", Object.assign({}, base, { hsb: true })],
  ]) {
    const l = ingest(payload)[0];
    assert.ok(
      !("hsb" in l),
      "AC2: hsb key must be ABSENT for " + label + ": " + JSON.stringify(l),
    );
  }

  // AC3: hostile strings. Anything without a leading dotted-numeric run
  // extracts to nothing; anything with one keeps ONLY that run.
  for (const hostileHsb of [
    SERVER_URL,
    EMAIL,
    TOKEN, // hex token starting with a letter
    "javascript:alert(1)",
    "<img src=x onerror=alert(1)>",
    "'; DROP TABLE rings;--",
    "../../../../etc/passwd",
    " ",
    "  2.0.19", // leading whitespace defeats the ^ anchor -> nothing
    "v2.0.19", // a "v" prefix is not a version by this grammar
    "\n2.0.19",
    "-1",
    "NaN",
    "Infinity",
  ]) {
    const l = ingest(Object.assign({}, base, { hsb: hostileHsb }));
    assert.ok(
      !("hsb" in l[0]),
      "AC3: hostile hsb survived: " +
        JSON.stringify(hostileHsb) +
        " -> " +
        JSON.stringify(l[0]),
    );
  }

  // Junk APPENDED to a real version: the leading version is kept, the tail is
  // gone. This is the extraction-not-stripping property that makes a dotted
  // hostname unable to ride along.
  assert.strictEqual(hsbOf("2.0.19" + SERVER_URL).hsb, "2.0.19");
  assert.strictEqual(hsbOf("2.0.19 " + EMAIL).hsb, "2.0.19");
  assert.strictEqual(hsbOf("2.0.19<script>alert(1)").hsb, "2.0.19");
  assert.ok(
    !JSON.stringify(hsbOf("2.0.19" + SERVER_URL)).includes("example"),
    "REDACTION LEAK: hsb tail survived",
  );

  // Overlong: capped at MaxVerLen (24), the same cap ver gets. A digit run
  // long enough to be a payload cannot become one.
  const giant = "1." + "2".repeat(5000);
  assert.strictEqual(hsbOf(giant).hsb.length, 24, "overlong hsb not capped");
  assert.strictEqual(hsbOf(giant).hsb, giant.slice(0, 24));
  assert.strictEqual(
    hsbOf("9".repeat(10000)).hsb.length,
    24,
    "overlong all-digit hsb not capped",
  );

  // hsb must not leak into the ring record — the ring whitelist is unchanged.
  const withRingHsb = ingest(
    Object.assign({}, base, {
      hsb: "2.0.19",
      ring: [{ ts: 1720000000000, hsb: "2.0.19" }],
    }),
  )[0];
  assert.ok(
    !("hsb" in withRingHsb.ring),
    "hsb must not become a ring field: " + JSON.stringify(withRingHsb.ring),
  );
  assert.strictEqual(withRingHsb.hsb, "2.0.19", "top-level hsb still stored");

  // An hsb alone cannot buy attribution: the id/ring guards still rule.
  assert.strictEqual(
    ingest({ hsb: "2.0.19", ring: [{ ts: 1 }] }),
    null,
    "hsb must not substitute for the opaque id",
  );
}

console.log("diag-ingest.test.cjs OK");
