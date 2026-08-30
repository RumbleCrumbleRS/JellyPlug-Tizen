#!/usr/bin/env node
/*
 * jsi-jp767-patch.mjs — JELA-767: count the library grid once per filter
 * signature, not once per page step.
 *
 * ###########################################################################
 * # SHELVED 2026-08-30 — AC1 MEASURED NULL. DO NOT ARM, DO NOT DEPLOY.      #
 * ###########################################################################
 * This patcher is correct and tested, and it is deliberately NOT shipped. It
 * was never applied to the live JSI channel; the flag stays dark forever.
 *
 * AC1, interleaved ON/OFF on `/Users/{uid}/Items`, scored on the server's own
 * `x-response-time-ms` MEDIAN, preflight CLEAR either side of every run:
 *
 *   cell                       delta (ON-OFF)   95% CI
 *   all-390  (THE REAL GRID)      +0.12 ms    [-10.28, +8.69]   spans 0
 *   eps-946  rep1                 +5.70 ms    [ +2.97, +7.89]
 *   eps-946  rep2                 +1.61 ms    [ -1.86, +5.29]   spans 0
 *   eps-3058 (7.8x the grid)     +10.43 ms    [ -0.61, +20.20]  spans 0
 *   eps-946  A/A CONTROL          -4.42 ms    [ -9.00, -0.16]   <- FLOOR
 *
 * The A/A control is the whole story. Both arms sent `true`; the responses
 * were byte-identical (TotalRecordCount 946 both sides, same body length) and
 * it still produced -4.42 ms with a CI that EXCLUDES ZERO. So the bootstrap CI
 * under-covers here — the samples are not exchangeable — and rep1's "+5.70 ms,
 * CI disjoint from zero" was floor, not signal. rep2 came back at +1.61 ms and
 * did not replicate it. Harness floor at n=96/arm is +/-5 ms (JELA-690).
 *
 * Best estimate of the true cost, from the size sweep: the COUNT is roughly
 * linear at ~3 ms per 1,000 rows of filtered set. The real grid's default
 * filter (Movie,Series) is 390 rows => ~1 ms per page step. With jp768
 * `filterbar.pageCache` now fleet default-ON (5 pages / 60 s), a 4-Next +
 * 4-Prev session issues 5 fetches, not 9 — the back steps never reach the
 * network. So the ENTIRE realizable prize is ~4 count queries x ~1 ms = ~4 ms
 * per paging session, against levers this programme ships at 1,000-2,000 ms.
 *
 * Per AC1's own stopping rule that is a measured null: the consistency cleanup
 * is not worth a paging regression, and the shipped override is load-bearing
 * (see AC0 below). Kept in-tree as documentation so the next reader who finds
 * the lone `EnableTotalRecordCount=!0` does not "fix" it — deleting that line
 * deletes the Next button on page 1.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-767 edits as anchored textual patches against the LIVE
 * `results-filter-bar` entry body, fail-closed on any anchor that does not
 * match exactly once. Pair it with the jsi-channel-deploy snapshot/gate/
 * rollback discipline (JELA-107/108, reconstructed in JELA-227) to put the
 * result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes, and the mechanism behind it
 * ---------------------------------------------------------------------------
 * Across the whole JSI channel there are ~30 sites that set
 * `EnableTotalRecordCount:false` and exactly ONE that sets it true: the
 * filter grid's single fetch site `be()`, which unconditionally negates the
 * `false` its own three query builders (V/Z/$) just wrote:
 *
 *   d.StartIndex=jpStart,d.EnableTotalRecordCount=!0;
 *
 * Jellyfin runs the total as a second COUNT query over the whole filtered
 * set, so the grid pays it on the initial open AND on every Previous/Next
 * step, in both directions — the pager `rt()` re-enters `be()` each time.
 * Four pages into "Movies" and back is 8 count queries (JELA-765).
 *
 * The override is NOT a bug in itself: `Le()`'s pager math takes its no-total
 * branch only when `TotalRecordCount` is null, and a flag-off response that
 * echoes the page length instead makes `hasNext = (0+80 < 80) = false` and
 * deletes the Next button on page 1. So the total is genuinely needed — once.
 *
 * AC0 CONFIRMED against prod (2026-08-26, re-confirmed 2026-08-30 in every
 * A/B run above): flag-off returns the ECHO shape — the RETURNED PAGE LENGTH,
 * never null and never the real total. `trc@StartIndex=0` read 80 with the
 * flag off against 390 / 946 / 3058 with it on. The hostile case is the real
 * one, the shipped override is load-bearing, and naive deletion breaks paging.
 *
 * ---------------------------------------------------------------------------
 * The fix: cache the total per query signature
 * ---------------------------------------------------------------------------
 * At the fetch site, AFTER the builder output is complete and BEFORE
 * StartIndex is stamped on it, the builder object IS the query signature:
 * every filter dimension (parentId / genre / studio / person / search term /
 * type / year / sort / limit) is a plain own property, so
 * `JSON.stringify([t.kind,d])` keys it exactly. One module-scope slot
 * (`jp767C`) caches the last signature's total:
 *
 *   - signature matches and a numeric total is cached -> send
 *     `EnableTotalRecordCount:false`, and at the response site feed `Le()`
 *     the CACHED total, ignoring the response field entirely (a flag-off
 *     Jellyfin answer may echo the page length — never trust it).
 *   - anything else (first fetch of a signature, restored `jpStart>0` from
 *     the jp592 saved state with a cold cache, filter/route change) -> send
 *     `true` exactly as shipped and cache what comes back.
 *
 * A single slot is deliberate: only one grid is live at a time, and a filter
 * or route change produces a new signature which misses and re-counts once.
 * That is the ticket's contract — exactly one count query per filter
 * signature per page-session — with the label still exact (never "80+") and
 * `hasNext` false only on the genuine last page, including the
 * exact-multiple-of-80 library.
 *
 * WHY NOT `jpStart===0` as the gate (the ticket's sketch): `oe()` restores a
 * saved `jpStart>0` straight from localStorage (jp592), so a session can
 * legitimately open mid-list with a cold cache. The cache-presence gate
 * handles that case by sending the count exactly as shipped; a start-index
 * gate would have sent `false` and rendered a wrong pager.
 *
 * Stale-total window: an item added/removed server-side mid-session shows up
 * in the label only after a filter/route change re-counts. The shipped code
 * refreshes the total every page step; the ticket accepts that trade.
 *
 * Dark by default. Nothing changes until `jellyplug.fb.countOnce` is "1" in
 * localStorage; `jellyplug.fb.countOnceDisabled` is the kill switch reserved
 * for the default-ON flip (JELA-696 pattern: flipping the fix's own flag is
 * the cheapest byte-identical A/B). With the flag dark the patched bytes
 * reproduce shipped behaviour exactly — same request census, same `Le()`
 * inputs. Fail-open everywhere: a throwing localStorage reads as dark.
 *
 * `window.__jpFB767` counts {armed,countOn,countOff,hit,store} so the AC2
 * CDP census can attribute every request (JELA-684: count requests over CDP
 * Network, never Resource Timing).
 *
 * Engine floor: the entry is ES5-styled and the Q60R engine is M63-class
 * (throws on ES2019 bare `catch{` and ES2020+), so every added byte here is
 * plain ES5 — `var`, `function`, string concat. The test enforces it.
 *
 * Usage:
 *   node jsi-jp767-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp767-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms count-once. */
export const FLAG_KEY = "jellyplug.fb.countOnce";
/** Kill switch, reserved for the default-ON flip. */
export const KILL_KEY = "jellyplug.fb.countOnceDisabled";
/** Counter bag on window, read over CDP to attribute the AC2 census. */
export const COUNTER_KEY = "__jpFB767";

/*
 * Module-scope helpers, inserted immediately before `Le()` (module scope, so
 * `f` — the entry's window parameter — is in scope, and `be()` inside the
 * `X()` closure sees them).
 *
 * jp767T(k, m) is the response-site total: k is the signature the REQUEST was
 * sent with (null = dark). Dark reproduces the shipped expression byte-for-
 * byte in behaviour. Armed + cache hit returns the cached total and ignores
 * the response field (the request went out flag-off; its TotalRecordCount is
 * untrusted by design). Armed + miss means the request went out flag-on, so
 * the response total is real: cache it, return it. A malformed total passes
 * through uncached, which leaves `Le()`'s own null/negative guard in charge.
 */
export const HELPERS_SRC =
  "/*jp767*/var jp767C={k:null,v:null};" +
  "function jp767Ls(k){try{return f.localStorage?f.localStorage.getItem(k):null}catch(e){return null}}" +
  'function jp767On(){return jp767Ls("' +
  FLAG_KEY +
  '")==="1"&&jp767Ls("' +
  KILL_KEY +
  '")!=="1"}' +
  "function jp767B(k){try{var c=f." +
  COUNTER_KEY +
  "||(f." +
  COUNTER_KEY +
  "={armed:0,countOn:0,countOff:0,hit:0,store:0});c[k]=(c[k]||0)+1}catch(e){}}" +
  "function jp767T(k,m){var r=m&&m.TotalRecordCount!=null?m.TotalRecordCount:null;" +
  "return k==null?r:" +
  'jp767C.k===k&&typeof jp767C.v=="number"?(jp767B("hit"),jp767C.v):' +
  'typeof r=="number"&&r>=0?(jp767C.k=k,jp767C.v=r,jp767B("store"),r):r}' +
  "/*jp767*/";

export const PATCH = {
  entry: /results-filter-bar/i,
  edits: [
    {
      what: "helpers",
      from: "function Le(n,a,e,u){",
      to: HELPERS_SRC + "function Le(n,a,e,u){",
    },
    {
      // The fetch site. Signature is taken from the pristine builder output
      // (before StartIndex lands on it); the shipped double assignment is
      // kept verbatim so dark mode ships identical bytes down the wire, and
      // the armed cache hit then flips the flag back off.
      what: "fetch:flag",
      from: ",c=++I;d.StartIndex=jpStart,d.EnableTotalRecordCount=!0;",
      to:
        ",c=++I,jp767K=null;" +
        '/*jp767*/jp767On()&&(jp767B("armed"),jp767K=JSON.stringify([t.kind,d]));/*jp767*/' +
        "d.StartIndex=jpStart,d.EnableTotalRecordCount=!0;" +
        "/*jp767*/jp767K!=null&&(" +
        'jp767C.k===jp767K&&typeof jp767C.v=="number"?(d.EnableTotalRecordCount=!1,jp767B("countOff")):jp767B("countOn"));/*jp767*/',
    },
    {
      // The response site: same expression shape, with the total routed
      // through jp767T under the request's own signature capture.
      what: "fetch:total",
      from: "g=Le(jpStart,y.length,m&&m.TotalRecordCount!=null?m.TotalRecordCount:null,a.fetchLimit)",
      to: "g=Le(jpStart,y.length,/*jp767*/jp767T(jp767K,m)/*jp767*/,a.fetchLimit)",
    },
  ],
};

export const PATCHES = [PATCH];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp767 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The results-filter-bar entry is ES5-styled and the Q60R engine is
 * M63-class, so the added regions must stay plain ES5: no arrows, template
 * literals, const/let/class, async/await, optional chaining, nullish
 * coalescing, or ES2019 bare `catch{`. Only the regions BETWEEN a marker
 * pair are ours: split on the marker and take the odd segments, or unpatched
 * syntax elsewhere in the snippet would be attributed to this patch.
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp767*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (
    /=>|`|\b(?:const|let|class|async|await)\b|\?\.|\?\?|catch\s*\{/.test(added)
  ) {
    throw new Error("jp767 edit introduced post-ES5 syntax");
  }
  if (!added.trim()) {
    throw new Error("jp767: no marked additions found — patch did not apply");
  }
  return added;
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp767: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    new vm.Script(after, { filename: `${hit[0].Name}.js` });
    assertEs5Additions(after);
    hit[0].Script = after;
    report.push({ name: hit[0].Name, delta: after.length - before.length });
  }
  return report;
}

function parseArgs(argv) {
  const a = { config: null, out: null, in: null, entry: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--config") a.config = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--in") a.in = argv[++i];
    else if (k === "--entry") a.entry = argv[++i];
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("--out <path> is required");
    process.exit(2);
  }
  if (args.config) {
    const cfg = JSON.parse(readFileSync(args.config, "utf8"));
    for (const r of patchConfig(cfg)) {
      console.error(`ok  ${r.name}  ${r.delta >= 0 ? "+" : ""}${r.delta} B`);
    }
    writeFileSync(args.out, JSON.stringify(cfg, null, 2));
  } else if (args.in) {
    let body = readFileSync(args.in, "utf8");
    for (const patch of PATCHES) {
      if (!args.entry || patch.entry.test(args.entry)) {
        body = applyPatch(body, patch);
      }
    }
    new vm.Script(body, { filename: "patched.js" });
    assertEs5Additions(body);
    writeFileSync(args.out, body);
    console.error(`ok  ${args.out}`);
  } else {
    console.error("--config <cfg.json> or --in <body.js> is required");
    process.exit(2);
  }
}
