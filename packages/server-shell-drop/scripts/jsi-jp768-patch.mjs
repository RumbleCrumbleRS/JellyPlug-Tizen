#!/usr/bin/env node
/*
 * jsi-jp768-patch.mjs — JELA-768: give the library / see-all grid a page
 * cache, so paging BACK does not refetch a page the client already had.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for the `results-filter-bar`
 * snippet. This applies the JELA-768 edits as anchored textual patches against
 * the LIVE entry body, fail-closed on any anchor that does not match exactly
 * once. Pair it with the jsi-channel-deploy snapshot/gate/rollback discipline
 * (JELA-107/108, reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes, and the mechanism behind it
 * ---------------------------------------------------------------------------
 * Read straight out of the shipped module-19 bytes (JELA-765): the pager is a
 * pure re-entry with no memo of any kind —
 *
 *   var rt = function(g){ jpStart = Math.max(0, jpStart+g); jpFoc=!0; be(r,t,l) };
 *
 * and `be()` goes to the network every time: it builds the `/Items` query,
 * mounts an EMPTY grid (`Q(r,l,M([],i),!0)` — the blank flash), then calls
 * `i.getItems(s,d)`. So `Next, Next, Previous, Previous` on a TV remote costs
 * four full 80-item round trips plus four complete 80-card teardown/rebuilds,
 * two of which re-deliver bytes the client held seconds earlier. Walking a
 * grid right/left is the single most repeated interaction on this surface.
 *
 * The module already memoises its two CHEAPER lookups — `p[i]` for the genre
 * chips in `le()`, `Pe[i]` for the collection-type probe in `De()`. The
 * expensive one, the 80-item page itself, is the only fetch on the surface
 * with no cache at all. This patch adds the missing third memo in the same
 * house style.
 *
 * ---------------------------------------------------------------------------
 * The fix: a short-TTL, small-cap, multi-read page store
 * ---------------------------------------------------------------------------
 * Per the JELA-760 selection rule, the mechanism is chosen by the GAP between
 * duplicate reads and the NUMBER of re-reads. Back-paging is seconds-to-tens-
 * of-seconds apart and re-read more than once, which maps to JELA-742/#185's
 * TTL store made multi-read — NOT an in-flight join (#176, the reads are
 * never concurrent), not the <400 ms replay window (#191), not the
 * single-replay case (#192).
 *
 *   PATCH_HELPERS  module-scope store + `jp768*` helpers, installed in front
 *                  of `be()`. Key = `t.kind + "|" + userId + "|" +
 *                  JSON.stringify(d)` — `d` is the finished getItems query
 *                  (StartIndex, Limit, IncludeItemTypes, GenreIds, sort,
 *                  year, search term ... already folded in), so anything
 *                  that changes the request changes the key. TTL 60 s
 *                  (override: `jellyplug.filterbar.pageCacheTtlMs`), cap 5
 *                  pages, LRU on last access.
 *   PATCH_HIT      in `be()`, AFTER the `c=++I` race-counter bump and BEFORE
 *                  the empty mount: on a fresh hit, render straight from the
 *                  store and return. The empty mount is skipped, so a cached
 *                  back-step paints without the blank frame, and the `++I`
 *                  already performed means any stale in-flight response is
 *                  discarded exactly as it is today.
 *   PATCH_STORE    in the getItems success path, store `{items, total}` right
 *                  where the live render happens. Empty pages are NOT stored,
 *                  so the jp595 "search grid empty" special case can never be
 *                  served from cache.
 *   PATCH_INV      `P()` — which already resets `jpStart=0` on every filter
 *                  and route change — drops the whole store.
 *
 * The TTL is what keeps watch-state (played ticks, resume position) from
 * going visibly stale on a back step; this is deliberately NOT a permanent
 * cache. A back step inside 60 s may show a pre-toggle played tick (accepted
 * by the ticket's AC3); outside the TTL it refetches.
 *
 * What a cache hit saves, per step: one `/Items` 80-item round trip (plus its
 * CORS preflight), the sibling count query's window (JELA-767 — independent,
 * composes), and the user-visible blank-grid flash while the response is in
 * flight. The 80-card DOM rebuild still happens — it is synchronous and
 * immediate from the store; removing it too is out of scope here.
 *
 * Dark by default. Nothing changes until `jellyplug.filterbar.pageCache` is
 * `"1"` in localStorage; `jellyplug.filterbar.pageCacheDisabled` is the kill
 * switch reserved for the default-ON flip. Counters on `window.__jpFB768`
 * ({hit,miss,exp,put,ev,inv}) are the ground truth for whether the store
 * fired — read them over CDP; never infer it from request counts
 * (JELA-742/699: a request census cannot attribute, and a frozen counter can
 * invert).
 *
 * Engine floor: the entry is pure ES5 (0 arrows, 0 template literals in the
 * live bytes) and the Q60R engine is M63-class — additions stay ES5.
 *
 * Usage:
 *   node jsi-jp768-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp768-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the page cache. */
export const FLAG_KEY = "jellyplug.filterbar.pageCache";
/** Kill switch, reserved for the default-ON flip. */
export const KILL_KEY = "jellyplug.filterbar.pageCacheDisabled";
/** localStorage override for the TTL, in milliseconds. */
export const TTL_KEY = "jellyplug.filterbar.pageCacheTtlMs";
/** Counter bag on window, read over CDP to attribute behaviour. */
export const COUNTER_KEY = "__jpFB768";
/** Default TTL and page cap. */
export const TTL_MS = 60000;
export const CAP = 5;

/*
 * The store and its helpers, installed at module scope in front of `be()`.
 * All names carry the jp768 suffix — verified against the live body for
 * collisions. `f` is the IIFE's window parameter. Fail-open is the whole
 * contract: a throw in localStorage or JSON.stringify disables the key and
 * the call proceeds on the shipped network path.
 */
export const HELPERS_SRC =
  "/*jp768*/var jpPC768={},jpPCn768=0;" +
  "function jp768Ls(k){try{return f.localStorage?f.localStorage.getItem(k):null}catch(x){return null}}" +
  'function jp768On(){return jp768Ls("' +
  FLAG_KEY +
  '")==="1"&&jp768Ls("' +
  KILL_KEY +
  '")!=="1"}' +
  'function jp768Ttl(){var x=parseInt(jp768Ls("' +
  TTL_KEY +
  '"),10);return x>0?x:' +
  TTL_MS +
  "}" +
  "function jp768Bump(k){try{var c=f." +
  COUNTER_KEY +
  "||(f." +
  COUNTER_KEY +
  "={hit:0,miss:0,exp:0,put:0,ev:0,inv:0});c[k]=(c[k]||0)+1}catch(x){}}" +
  "function jp768Now(){return new Date().getTime()}" +
  'function jp768Key(t,s,d){if(!jp768On())return null;try{return t.kind+"|"+(s||"")+"|"+JSON.stringify(d)}catch(x){return null}}' +
  "function jp768Get(k){if(!k)return null;var x=jpPC768[k];" +
  'if(!x)return jp768Bump("miss"),null;' +
  'if(jp768Now()-x.ts>jp768Ttl())return delete jpPC768[k],jpPCn768--,jp768Bump("exp"),null;' +
  'return x.at=jp768Now(),jp768Bump("hit"),x}' +
  "function jp768Put(k,y,tt){if(!(!k||!y||!y.length)){" +
  "jpPC768[k]||jpPCn768++,jpPC768[k]={items:y,total:tt,ts:jp768Now(),at:jp768Now()},jp768Bump(\"put\");" +
  "if(jpPCn768>" +
  CAP +
  "){var o=null,q=null,z;" +
  "for(z in jpPC768)jpPC768.hasOwnProperty(z)&&(o===null||jpPC768[z].at<o)&&(o=jpPC768[z].at,q=z);" +
  'q&&(delete jpPC768[q],jpPCn768--,jp768Bump("ev"))}}}' +
  'function jp768Inv(){jpPC768={},jpPCn768=0,jp768Bump("inv")}' +
  "/*jp768*/";

// --- results-filter-bar: install the store in front of be() -----------------
export const PATCH_HELPERS = {
  entry: /results-filter-bar/i,
  edits: [
    {
      what: "helpers",
      from: "function be(r,t,l){var i=b();",
      to: HELPERS_SRC + "function be(r,t,l){var i=b();",
    },
  ],
};

// --- results-filter-bar: serve a fresh page from the store ------------------
// The insertion point is AFTER `c=++I` (so a hit invalidates any stale
// in-flight response, exactly as a re-entry does today) and BEFORE
// `Q(r,l,M([],i),!0)` (so a hit never mounts the empty grid — no blank
// flash). `jpK768` is a `var` in `be()`'s scope; the getItems success closure
// below reads it for the store write.
export const PATCH_HIT = {
  entry: /results-filter-bar/i,
  edits: [
    {
      what: "hit",
      from:
        "var rt=function(g){jpStart=Math.max(0,jpStart+g),jpFoc=!0,be(r,t,l)};" +
        "Q(r,l,M([],i),!0),i.getItems(s,d).then(function(m){",
      to:
        "var rt=function(g){jpStart=Math.max(0,jpStart+g),jpFoc=!0,be(r,t,l)};" +
        "/*jp768*/var jpK768=jp768Key(t,s,d),jpE768=jp768Get(jpK768);" +
        "if(jpE768){var jpG768=Le(jpStart,jpE768.items.length,jpE768.total,a.fetchLimit);" +
        "Q(r,l,M(jpE768.items,i,jpG768,rt),!1),jpF(),jpRescue()," +
        'n.log("results-filter-bar: rendered "+jpE768.items.length+" item(s) from page cache [start="+jpStart+"].");' +
        "return}/*jp768*/" +
        "Q(r,l,M([],i),!0),i.getItems(s,d).then(function(m){",
    },
  ],
};

// --- results-filter-bar: store the page where the live render happens -------
// This anchor sits AFTER the jp595 "search grid empty" early return, so an
// empty search page is never stored and that branch can never be served from
// cache. `g.total` is `Le()`'s normalised TotalRecordCount (null when the
// server did not send one — `Le` handles null on the way back out).
export const PATCH_STORE = {
  entry: /results-filter-bar/i,
  edits: [
    {
      what: "store",
      from:
        "Q(r,l,M(y,i,g,rt),!1),jpF(),jpRescue()," +
        'n.log("results-filter-bar: rendered "',
      to:
        "/*jp768*/jp768Put(jpK768,y,g.total),/*jp768*/" +
        "Q(r,l,M(y,i,g,rt),!1),jpF(),jpRescue()," +
        'n.log("results-filter-bar: rendered "',
    },
  ],
};

// --- results-filter-bar: drop the store on any filter or route change -------
// P() is the module's single reset funnel — it already zeroes jpStart for
// every filter flip and route change, so it is exactly the invalidation
// point the ticket names.
export const PATCH_INV = {
  entry: /results-filter-bar/i,
  edits: [
    {
      what: "invalidate",
      from: "function P(g2){/*jp592*/jpStart=0;",
      to: "function P(g2){/*jp592*/jpStart=0;/*jp768*/jp768Inv();/*jp768*/",
    },
  ],
};

export const PATCHES = [PATCH_HELPERS, PATCH_HIT, PATCH_STORE, PATCH_INV];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp768 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The results-filter-bar entry is pure ES5 and the Q60R engine is M63-class,
 * so the additions must stay ES5. Only the regions BETWEEN a marker pair are
 * ours: split on the marker and take the odd segments (the jp681 variant that
 * joins everything after the first marker would attribute unpatched syntax
 * elsewhere in the snippet to this patch).
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp768*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b|\basync\b|\?\.|\?\?|catch\s*\{/.test(added)) {
    throw new Error("jp768 edit introduced non-ES5 syntax");
  }
  if (!added.trim()) {
    throw new Error("jp768: no marked additions found — patch did not apply");
  }
  return added;
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const hit = entries.filter((e) => /results-filter-bar/i.test(e.Name || ""));
  if (hit.length !== 1) {
    throw new Error(
      `jp768: results-filter-bar matched ${hit.length} channel entries (want 1)`,
    );
  }
  const before = hit[0].Script || "";
  let after = before;
  for (const patch of PATCHES) after = applyPatch(after, patch);
  assertEs5Additions(after);
  new vm.Script(after, { filename: `${hit[0].Name}.js` });
  hit[0].Script = after;
  return [{ name: hit[0].Name, delta: after.length - before.length }];
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
  } else if (args.in && args.entry) {
    let body = readFileSync(args.in, "utf8");
    if (!/results-filter-bar/i.test(args.entry)) {
      console.error(`no jp768 patch for entry "${args.entry}"`);
      process.exit(2);
    }
    for (const p of PATCHES) body = applyPatch(body, p);
    assertEs5Additions(body);
    new vm.Script(body, { filename: args.entry });
    writeFileSync(args.out, body);
    console.error(`ok  ${args.entry}`);
  } else {
    console.error("need --config <cfg.json> or --entry <name> --in <body.js>");
    process.exit(2);
  }
  console.error(`wrote ${args.out}`);
}
