#!/usr/bin/env node
/*
 * tx-bundle-cap.test.cjs — JELA-833 guard for POST /shell/tx-bundle.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring is source-pinned.
 *
 * Two defects are locked down here, both from JELA-824:
 *
 *   1. `const int MaxIds = 200` against a tx manifest already holding 192
 *      entries — 96% of the cap — and past it the handler did
 *      `ids = ids[..MaxIds]` and answered 200 OK with a SHORT map. That is
 *      undetectable on the client: a hash missing from the map is exactly how
 *      the server says "I don't have that body", so the client would have
 *      quietly fallen back to per-body GETs forever and nobody would have seen
 *      the cap bind. The cap must be derived from the drop and the overflow
 *      must be an explicit 413.
 *
 *   2. AC3: the bundle carries `no-store` (its id set varies per client and
 *      per boot) while the per-body route keeps `immutable` (content-addressed
 *      by the fnv1a of the SOURCE text). If those two ever swap, JELA-824's
 *      85-97x per-boot byte regression comes straight back — the whole reason
 *      the union was catastrophic rather than merely wasteful is that the
 *      bundle is re-paid on every single boot.
 *
 * Also pinned: the server's batch floor stays in lockstep with the shell's
 * TXB_MAX, so a client batching at its documented size can never 413.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..", "..", "..");
const CTRL = path.join(
  __dirname,
  "..",
  "Jellyfin.Plugin.JellyPlugShell",
  "Controllers",
  "ShellController.cs",
);
const DROPSVC = path.join(
  __dirname,
  "..",
  "Jellyfin.Plugin.JellyPlugShell",
  "ShellDropService.cs",
);
const SHELL = path.join(ROOT, "packages", "shell-tizen", "src", "shell.js");

const ctrl = fs.readFileSync(CTRL, "utf8");
const dropsvc = fs.readFileSync(DROPSVC, "utf8");
const shell = fs.readFileSync(SHELL, "utf8");

function bodyOf(text, signature, file) {
  const start = text.indexOf(signature);
  assert(start !== -1, "could not find " + signature + " in " + file);
  const i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces in " + signature);
}

const handler = bodyOf(
  ctrl,
  "public async Task<IActionResult> PostTxBundle()",
  CTRL,
);

// ---------------------------------------------------------------- 1. the cap
assert(
  !/const int MaxIds = \d+/.test(handler),
  "JELA-833: the hard-coded MaxIds literal is back — derive the cap from the drop",
);
assert(
  /_drop\.TxBodyCount\(\)/.test(handler),
  "JELA-833: the cap must be derived from ShellDropService.TxBodyCount()",
);
assert(
  /Math\.Max\(published, ClientBatchMax\)/.test(handler),
  "JELA-833: the derived cap must be floored at the client's batch size",
);
console.log("OK: the id cap is derived from the drop, not a literal");

// ------------------------------------------------- 2. overflow is EXPLICIT
assert(
  !/ids\[\.\.maxIds\]/.test(handler) && !/ids\[\.\.MaxIds\]/.test(handler),
  "JELA-833: silent truncation is back — an over-cap request must 413, " +
    "because a short map is indistinguishable from a complete one on the client",
);
assert(
  /if \(ids\.Length > maxIds\)[\s\S]{0,400}?Status413PayloadTooLarge/.test(
    handler,
  ),
  "JELA-833: an over-cap id list must return an explicit 413",
);
console.log("OK: over-cap requests 413 instead of truncating silently");

// ------------------------------------------- 3. TxBodyCount is real + bounded
const count = bodyOf(dropsvc, "public int TxBodyCount()", DROPSVC);
assert(
  /LastWriteTimeUtc/.test(count) && /_txCount/.test(count),
  "JELA-833: TxBodyCount must cache against the tx dir's mtime, not rescan per request",
);
assert(
  /return 0;/.test(count) && /catch/.test(count),
  "JELA-833: TxBodyCount must fail closed to 0 when the drop is absent/unreadable",
);
console.log("OK: TxBodyCount is mtime-cached and fails closed");

// ------------------------------------------------------- 4. AC3 cache policy
assert(
  /Response\.Headers\.CacheControl = "no-store";/.test(handler),
  "AC3: the bundle must stay no-store — its id set varies per client and per boot",
);
assert(
  /Response\.Headers\.Vary = HeaderNames\.Origin;/.test(handler),
  "AC3: the bundle must carry Vary: Origin (M63 cache-mode collision)",
);
const perBody = bodyOf(
  ctrl,
  "public IActionResult GetTxBody([FromRoute] string hash)",
  CTRL,
);
assert(
  /"public, max-age=31536000, immutable"/.test(perBody),
  "AC3: the per-body route must stay immutable — it is the cacheable fallback " +
    "that makes a sub-TXB_MIN batch cheaper than a bundle POST",
);
assert(
  !/immutable/.test(handler),
  "AC3: the bundle must never be marked immutable",
);
console.log("OK: no-store + Vary: Origin on the bundle, immutable on per-body");

// --------------------------------------------- 5. lockstep with the shell
const mBatch = /private const int ClientBatchMax = (\d+);/.exec(ctrl);
assert(mBatch, "JELA-833: ClientBatchMax is missing from ShellController");
const mTxb = /var TXB_MAX = (\d+);/.exec(shell);
assert(mTxb, "JELA-833: TXB_MAX is missing from shell.js");
assert.strictEqual(
  Number(mBatch[1]),
  Number(mTxb[1]),
  "JELA-833: ClientBatchMax (" +
    mBatch[1] +
    ") drifted from the shell's TXB_MAX (" +
    mTxb[1] +
    ") — a well-behaved client would start getting 413s",
);
console.log(
  "OK: ClientBatchMax is in lockstep with the shell's TXB_MAX (" +
    mTxb[1] +
    ")",
);

// ------------------------ 6. per-hash validation survives the partial id sets
assert(
  /HashRe\.IsMatch\(hash\)/.test(handler),
  "JELA-833: per-hash regex validation must stay (forecloses path traversal)",
);
console.log("OK: per-hash validation retained");

console.log("tx-bundle-cap: all checks passed");
