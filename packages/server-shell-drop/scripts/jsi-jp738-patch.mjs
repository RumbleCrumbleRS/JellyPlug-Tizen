#!/usr/bin/env node
/*
 * jsi-jp738-patch.mjs — JELA-738: resolve every genre name from ONE bulk read.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-738 edit as anchored textual patches against the LIVE entry
 * bodies, fail-closed on any anchor that does not match exactly once. Pair it
 * with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline (JELA-107/108,
 * reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * Each JellyPlug genre row turns its configured genre NAME into an id with its
 * own `/Genres?SearchTerm=<name>&Limit=12&userId=<id>` call. Eight of them fire
 * concurrently near the end of the boot, each behind its own CORS preflight,
 * and they are the LAST wave to land before the home reaches its final card
 * count (JELA-736, capture b1: GETs end 8,684-8,960 ms, settle 9,005 ms).
 *
 * Measured server cost, interleaved, n=5 each, box quiet (JELA-692 CLEAR):
 *
 *   8 x /Genres?SearchTerm=...&Limit=12   781.5 ms total   ~4.3 KB   (8 bodies)
 *   1 x /Genres?Limit=200                  98.2 ms         11,155 B  (28 genres)
 *   1 x the same + EnableImages=false&EnableTotalRecordCount=false
 *                                          71.5 ms          5,914 B
 *
 * The cost is FLAT per call and independent of the search term — the server
 * pays ~95-100 ms whether it returns one genre or all 28. The library has 28
 * genres, so one unfiltered read is a strict superset of all eight answers at
 * an eighth of the CPU, and the row code needs only `Name` and `Id`.
 *
 *   PATCH_STORE   (tizen-compat)  install `JellyPlug.genreBulk`: one in-flight,
 *                                 in-memory `/Genres` promise per user id.
 *   PATCH_ROWS    (genre-rows)    take the bulk response instead of dispatching
 *                                 a per-name SearchTerm query.
 *   PATCH_SEE_ALL (row-see-all)   the same, for the second module that resolves
 *                                 the same names (JELA-683). It shares the ONE
 *                                 promise, so the double-resolve collapses too.
 *
 * The edit is deliberately confined to the request itself. Both modules already
 * map the response with a local exact-name matcher (`K` in genre-rows, `E` in
 * row-see-all) that scans `Items` for the name it asked for, so handing those
 * matchers the full genre list instead of a filtered one needs no other change:
 * the same {id,name} comes out. That is why this is smaller than the JELA-682
 * localStorage cache (PR #159) — no persistence, no TTL, no server-GUID
 * binding, no staleness window — and why it works on a COLD boot, which the
 * persisted cache cannot.
 *
 * ---------------------------------------------------------------------------
 * Failure modes, and why a row can never go missing
 * ---------------------------------------------------------------------------
 * `Limit` is a real limit, so a library with more genres than BULK_LIMIT would
 * hand the matchers a truncated list and could silently lose a row. Every path
 * that is not "a complete list came back" therefore falls back to the shipped
 * per-name query:
 *   - the bulk request throws, rejects, or returns a non-promise;
 *   - the response has no usable `Items` array;
 *   - `Items.length >= BULK_LIMIT`, i.e. the list may be truncated.
 * A fallback boot costs exactly what today's boot costs; it is never worse.
 *
 * Dark by default. Nothing changes until `jellyplug.genres.bulkread` is `"1"`
 * in localStorage. With the flag off the store object is built but `get()`
 * returns null at the call site and the shipped code path runs verbatim.
 *
 * Composes with jsi-jp682-patch.mjs in EITHER order — the two scripts touch
 * disjoint regions (jp682 wraps the memo check and the response mapping; jp738
 * replaces the request between them) and each is independently fail-closed.
 * With both flags on and a warm jp682 map, jp682 short-circuits first and no
 * `/Genres` request is made at all.
 *
 * Usage:
 *   node jsi-jp738-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp738-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the whole patch. */
export const FLAG_KEY = "jellyplug.genres.bulkread";
/**
 * Ceiling on the one read. 28 genres live today; 200 keeps the response small
 * enough to stay cheap while leaving room for a library to grow ~7x before the
 * truncation fallback starts firing.
 */
export const BULK_LIMIT = 200;

/*
 * The store, as it is injected into tizen-compat. `s` is window and `n` is the
 * JellyPlug namespace in that snippet's IIFE.
 *
 * `get` returns a promise for a /Genres RESPONSE, not for an id — the caller
 * already knows how to pull its own name out of a response, and keeping that
 * shape is what lets the call-site edit be a single expression swap.
 *
 * Returning null (rather than throwing, or resolving to null) is the signal to
 * the call site that it should do exactly what it does today.
 *
 * The ticket also asked for `Fields=`. It is NOT here: the apiclient's URL
 * builder drops empty-string params, so `Fields=""` never reaches the wire —
 * confirmed against the emitted URL on the rig, which is
 * `/Genres?Limit=200&EnableImages=false&EnableTotalRecordCount=false&userId=`.
 * That request still returns the trimmed 5,914-byte body, so the halving the
 * ticket measured comes from EnableImages + EnableTotalRecordCount alone.
 */
export const GENRE_BULK_SRC =
  "(function(){" +
  'var F="' +
  FLAG_KEY +
  '",L=' +
  BULK_LIMIT +
  ",pend=null,key=null;" +
  'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}' +
  // The shipped request, used verbatim as the fallback.
  "function one(api,uid,name){" +
  "try{return api.getGenres(uid,{SearchTerm:String(name),Limit:12})}catch(e){return null}}" +
  "function get(api,uid,name){" +
  'if(!on()||!api||typeof api.getGenres!="function")return null;' +
  'var k=uid==null?"":String(uid);' +
  "if(key!==k){key=k;pend=null}" +
  "if(!pend){" +
  "var p=null;" +
  "try{p=api.getGenres(uid,{Limit:L,EnableImages:!1,EnableTotalRecordCount:!1})}catch(e){p=null}" +
  'if(!p||typeof p.then!="function")return null;' +
  "pend=p}" +
  "return pend.then(function(r){" +
  'var it=r&&r.Items&&typeof r.Items.length=="number"?r.Items:null;' +
  "if(it&&it.length<L)return r;" +
  "return one(api,uid,name)" +
  "},function(){pend=null;return one(api,uid,name)})}" +
  "return{on:on,get:get,limit:L}})()";

// --- tizen-compat: install the shared reader on the JellyPlug namespace ------
export const PATCH_STORE = {
  entry: /tizen-compat/i,
  edits: [
    {
      what: "store",
      from: "var B=M(),Y=[];for(var Q in B.disabled)",
      to:
        "/*jp738*/n.genreBulk=" +
        GENRE_BULK_SRC +
        ";/*jp738*/" +
        "var B=M(),Y=[];for(var Q in B.disabled)",
    },
  ],
};

// --- genre-rows: take the bulk response instead of a per-name query ---------
// In this snippet `d` is window, `n` is the JellyPlug util namespace, `e` is
// the ApiClient, `u` is the user id and `i` is the genre name.
export const PATCH_ROWS = {
  entry: /genre-rows/i,
  edits: [
    {
      what: "rows:request",
      from:
        'l=n.safe("genre-rows.getGenres",function(){' +
        "return e.getGenres(u,{SearchTerm:i,Limit:12})},null)",
      to:
        'l=n.safe("genre-rows.getGenres",function(){' +
        "/*jp738*/var jpB738=(d.JellyPlug&&d.JellyPlug.genreBulk)||null," +
        "jpP738=jpB738?jpB738.get(e,u,i):null;" +
        "if(jpP738)return jpP738;/*jp738*/" +
        "return e.getGenres(u,{SearchTerm:i,Limit:12})},null)",
    },
  ],
};

// --- row-see-all: the same edit, different local names ----------------------
// Here `u` is window, `t` is the util namespace, `e` is the ApiClient, `f` is
// the user id and `n` is the genre NAME (not the namespace).
export const PATCH_SEE_ALL = {
  entry: /row-see-all/i,
  edits: [
    {
      what: "seeall:request",
      from:
        'l=t.safe("row-see-all.getGenres",function(){' +
        "return e.getGenres(f,{SearchTerm:n,Limit:12})},null)",
      to:
        'l=t.safe("row-see-all.getGenres",function(){' +
        "/*jp738*/var jpB738=(u.JellyPlug&&u.JellyPlug.genreBulk)||null," +
        "jpP738=jpB738?jpB738.get(e,f,n):null;" +
        "if(jpP738)return jpP738;/*jp738*/" +
        "return e.getGenres(f,{SearchTerm:n,Limit:12})},null)",
    },
  ],
};

export const PATCHES = [PATCH_STORE, PATCH_ROWS, PATCH_SEE_ALL];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp738 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The snippets ship to a Chromium-63/V8-6.3 engine, so our additions are ES5.
 * Only the regions BETWEEN a marker pair are ours: split on the marker and
 * take the odd segments, or an unpatched `let` elsewhere in the snippet would
 * be attributed to this patch.
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp738*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp738 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp738: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    assertEs5Additions(after);
    new vm.Script(after, { filename: `${hit[0].Name}.js` });
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
  } else if (args.in && args.entry) {
    const patch = PATCHES.find((p) => p.entry.test(args.entry));
    if (!patch) {
      console.error(`no jp738 patch for entry "${args.entry}"`);
      process.exit(2);
    }
    const body = applyPatch(readFileSync(args.in, "utf8"), patch);
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
