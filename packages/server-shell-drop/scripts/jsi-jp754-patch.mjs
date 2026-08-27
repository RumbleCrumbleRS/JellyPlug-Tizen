#!/usr/bin/env node
/*
 * jsi-jp754-patch.mjs — JELA-754: stop pulling the Top 10 candidate pool twice.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-754 edits as anchored textual patches against the LIVE
 * `top10-badges` body, fail-closed on any anchor that does not match exactly
 * once. Pair it with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline
 * (JELA-107/108, reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * Where the second fetch comes from
 * ---------------------------------------------------------------------------
 * `top10-badges` has TWO consumers of the same candidate query and they do not
 * know about each other:
 *
 *   1. the row itself — `we()` -> `Me()` -> `Ue()`, memoised in the run-closure
 *      latch `T`/`pe` (keyed dayStamp:userId), fires once at boot;
 *   2. the module-scope export `JellyPlugTop10.rankedTopForType` (`ie`), which
 *      `detail-top10-rank` calls to work out "#3 in Movies Today". `ie` has no
 *      latch of its own and never looks at the `jp:top10:` day cache — it goes
 *      straight to `ApiClient.getItems`. detail-top10-rank memoises the promise
 *      per (type|dayStamp), so it costs exactly ONE extra query per session,
 *      on the first detail page opened.
 *
 * That is the measured "exactly twice per session, byte-identical URLs, second
 * one changes nothing": boot is the row, the nav is the detail badge. The
 * `jp:top10:` value is unchanged across the pair because `ie` only reads — it
 * never writes the cache.
 *
 * PATCH_SHARE therefore does not add a cache; it adds the missing single-flight
 * that both call sites can see. `jpFlight754` is a one-slot registry keyed on
 * `dayStamp|userId|IncludeItemTypes`, holding a BOX (`{p:promise}`) rather than
 * the promise itself, because `Ue` has to register from inside the `jpTy512`
 * callback — which can run synchronously — before its own promise object
 * exists. A consumer that reads the box early sees `p === null`, misses, and
 * fetches: the failure mode is the shipped behaviour, never a wrong answer.
 * Rejections de-register, so a failed pool is never replayed to the other
 * consumer.
 *
 * The key includes the EFFECTIVE `IncludeItemTypes`, not the configured one:
 * `Ue` lets jp512's `homeItemTypes` override the row's type set, and `ie` is
 * called with the detail item's own Type. A "Series" rank badge must not be
 * answered from a "Movie" pool, so a type mismatch simply misses.
 *
 * ---------------------------------------------------------------------------
 * PATCH_FIELDS — `PrimaryImageAspectRatio` is dead weight on a Movie chart
 * ---------------------------------------------------------------------------
 * `B()` asks for `Fields=PrimaryImageAspectRatio,CriticRating`. The only reader
 * of that field is jp671's `jpWide671()`, which returns `!1` immediately unless
 * the item's Type is one of Video / MusicVideo / Episode. The shipped chart is
 * `includeItemTypes:"Movie"`, so every byte of it is parsed and thrown away.
 *
 * `jpFlds754()` keeps the field only when the query's type list actually
 * contains a wide-capable type, so an Episode or Video chart is unaffected.
 * Measured against the live library (348 Movies): 287,730 B -> 272,183 B,
 * -15,547 B (-5.4%), with `slimItems(selectDailyTop(...))` byte-identical
 * between the two responses (0 of 348 items had `wide === true` either way).
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here: lowering `candidateLimit`
 * ---------------------------------------------------------------------------
 * The ticket's AC2 asks for `candidateLimit <= poolSize`. Measured, that is a
 * feature regression, not a saving, and it contradicts the ticket's own AC4.
 *
 * `selectDailyTop(items, day, poolSize, limit)` seeded-shuffles the WHOLE
 * candidate array with a seed derived from the dayStamp, slices `poolSize`
 * (default 40 — the ticket's 200 is the clamp ceiling, not the default), then
 * ranks that slice by CriticRating and keeps `limit` (10). The candidate list
 * is therefore the daily ROTATION UNIVERSE, not an oversized buffer: every
 * candidate is reachable on some day, and shrinking it shrinks the library the
 * row can ever show.
 *
 * Replaying the module's own exports over the live pool (348 Movies, so
 * `Limit=500` is not even truncating — it returns the entire Movie library):
 *
 *   candidateLimit  today's top 10 vs shipped   distinct titles over 365 days
 *   500 (shipped)   —                           138
 *   200             0 / 10 ids in common        80
 *    40 (=poolSize) 0 / 10 ids in common        12
 *
 * So AC2 is answered with evidence rather than code: the ranking does need the
 * larger pool, and the wire win the ticket expected from it is bought instead
 * by PATCH_SHARE (a whole 288 KB fetch removed) plus PATCH_FIELDS (-5.4% of
 * the one that remains).
 *
 * Both patches are dark by default:
 *   `jellyplug.top10.sharepool`  — the single-flight (AC1)
 *   `jellyplug.top10.leanfields` — the Fields trim (AC3)
 * With both flags unset every helper resolves to the shipped value and the
 * shipped code path runs verbatim.
 *
 * Usage:
 *   node jsi-jp754-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp754-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

export const SHARE_FLAG = "jellyplug.top10.sharepool";
export const FIELDS_FLAG = "jellyplug.top10.leanfields";
export const SHIPPED_FIELDS = "PrimaryImageAspectRatio,CriticRating";
export const LEAN_FIELDS = "CriticRating";

/*
 * Shared helpers, injected at IIFE scope just ahead of the `b` defaults so they
 * sit after jp671's `jpWideTy671` table (which `jpFlds754` consults) and ahead
 * of every call site. `g` is the window binding of the outer IIFE.
 */
const HELPERS_SRC =
  "/*jp754*/" +
  'function jpOn754(f){try{return!!(g.localStorage&&g.localStorage.getItem(f)==="1")}catch(e){return!1}}' +
  "function jpFlds754(ty){" +
  'if(!jpOn754("' +
  FIELDS_FLAG +
  '"))return"' +
  SHIPPED_FIELDS +
  '";' +
  'for(var a=String(ty==null?"":ty).split(","),i=0;i<a.length;i++)' +
  'if(Object.prototype.hasOwnProperty.call(jpWideTy671,a[i].replace(/^\\s+|\\s+$/g,"")))return"' +
  SHIPPED_FIELDS +
  '";' +
  'return"' +
  LEAN_FIELDS +
  '"}' +
  "var jpFlight754=null;" +
  'function jpKey754(d,u,t){return String(d)+"|"+String(u==null?"":u)+"|"+String(t==null?"":t)}' +
  "function jpGet754(d,u,t){" +
  'if(!jpOn754("' +
  SHARE_FLAG +
  '"))return null;' +
  "var s=jpFlight754;" +
  "return s&&s.k===jpKey754(d,u,t)&&s.b&&s.b.p?s.b.p:null}" +
  "function jpPut754(d,u,t,b){" +
  'if(!jpOn754("' +
  SHARE_FLAG +
  '"))return;' +
  "jpFlight754={k:jpKey754(d,u,t),b:b}}" +
  "function jpDrop754(d,u,t){" +
  "var s=jpFlight754;" +
  "s&&s.k===jpKey754(d,u,t)&&(jpFlight754=null)}" +
  "/*jp754*/";

export const PATCH_SHARE = {
  entry: /top10-badges/i,
  edits: [
    // 1. the helpers themselves.
    {
      what: "helpers",
      from: '/*jp671*/var b={enabled:!0,title:"Top 10 Today"',
      to: '/*jp671*/' + HELPERS_SRC + 'var b={enabled:!0,title:"Top 10 Today"',
    },
    // 2. B(): ask for PrimaryImageAspectRatio only when something reads it.
    {
      what: "fields",
      from:
        "Limit:r.candidateLimit,Fields:\"" +
        SHIPPED_FIELDS +
        '",EnableImageTypes:"Primary"',
      to:
        "Limit:r.candidateLimit,/*jp754*/Fields:jpFlds754(r.includeItemTypes)," +
        '/*jp754*/EnableImageTypes:"Primary"',
    },
    // 3. ie() / JellyPlugTop10.rankedTopForType — the detail-badge consumer.
    //    `r` is the ApiClient, `l` the dayStamp, `m` the resolved config and
    //    `y` the user id.
    {
      what: "rankedtop",
      from:
        "return y?jpW465(r.getItems(y,B(m))).then(function(h){" +
        "var I=w(h,m.candidateLimit);return z(I,l,m.poolSize,m.limit)})" +
        ':E("no session yet (pre-auth); skipping fetch")',
      to:
        "return y?/*jp754*/function(){" +
        "var jpT754=m.includeItemTypes,jpH754=jpGet754(l,y,jpT754);" +
        "if(jpH754)return jpH754;" +
        "var jpB754={p:null};jpPut754(l,y,jpT754,jpB754);" +
        "var jpP754=jpW465(r.getItems(y,B(m))).then(function(h){" +
        "var I=w(h,m.candidateLimit);return z(I,l,m.poolSize,m.limit)});" +
        "jpB754.p=jpP754;" +
        'try{jpP754["catch"](function(){jpDrop754(l,y,jpT754)})}catch(e754){}' +
        "return jpP754}()/*jp754*/" +
        ':E("no session yet (pre-auth); skipping fetch")',
    },
    // 4. Ue() — the row consumer. `e` is the ApiClient, `n` the user id, `a`
    //    the dayStamp and `l` the resolved config. The registration has to
    //    happen inside the jpTy512 callback because that is where the
    //    effective IncludeItemTypes is known; jpTy512 may call back
    //    synchronously, so the box is filled after the constructor returns.
    {
      what: "rowfetch",
      from:
        "return new g.Promise(function(n0,n1){jpTy512(function(T0){" +
        "var q0=B(l);T0&&(q0.IncludeItemTypes=T0);" +
        "var p0=null;try{p0=jpW465(e.getItems(n,q0))}catch(e2){}",
      to:
        "/*jp754*/var jpB754={p:null},jpR754=null;var jpP754=/*jp754*/" +
        "new g.Promise(function(n0,n1){jpTy512(function(T0){" +
        "var q0=B(l);T0&&(q0.IncludeItemTypes=T0);" +
        "/*jp754*/q0.Fields=jpFlds754(q0.IncludeItemTypes);" +
        "jpR754=[a,n,q0.IncludeItemTypes];" +
        "var jpH754=jpGet754(a,n,q0.IncludeItemTypes);" +
        "if(jpH754){jpH754.then(n0,n1);return}" +
        "jpPut754(a,n,q0.IncludeItemTypes,jpB754);/*jp754*/" +
        "var p0=null;try{p0=jpW465(e.getItems(n,q0))}catch(e2){}",
    },
    {
      what: "rowfetch:tail",
      from:
        'n1("no item query path (jp512)")})})}/*jp512*/var T=null,pe=null,jpEmpty=null,',
      to:
        'n1("no item query path (jp512)")})})' +
        "/*jp754*/;jpB754.p=jpP754;" +
        'try{jpP754["catch"](function(){' +
        "jpR754&&jpDrop754(jpR754[0],jpR754[1],jpR754[2])})}catch(e754){}" +
        "return jpP754/*jp754*/" +
        "}/*jp512*/var T=null,pe=null,jpEmpty=null,",
    },
  ],
};

export const PATCHES = [PATCH_SHARE];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp754 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp754*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp754 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp754: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp754 patch for entry "${args.entry}"`);
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
