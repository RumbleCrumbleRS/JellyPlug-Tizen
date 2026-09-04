#!/usr/bin/env node
/*
 * jsi-jp859-patch.mjs — JELA-859: stop hydrating 349 movies to render 10.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-859 edit as anchored textual patches against the LIVE
 * `top10-badges` body, fail-closed on any anchor that does not match exactly
 * once. Pair it with the JELA-107/108 snapshot/gate/rollback discipline to put
 * the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What costs 52 KB
 * ---------------------------------------------------------------------------
 * The candidate query returns the WHOLE Movie library (349 items on prod;
 * `Limit=500` is not truncating), fully hydrated with `ImageTags`,
 * `ImageBlurHashes` and `UserData` — and then throws almost all of it away:
 *
 *     getItems(user, B(cfg))            349 items, 52,265 B compressed
 *       -> w(resp, candidateLimit)      map to {id,name,serverId,imageTag,critic,us,wide}
 *       -> z(items, day, 40, 10)        seeded shuffle -> slice(0,40)
 *                                       -> rank by CriticRating -> take 10
 *
 * `z()` reads exactly two things: the ARRAY ORDER (the Fisher-Yates shuffle is
 * seeded by the dayStamp, not by item content) and `critic`. `name`,
 * `serverId`, `imageTag`, `us` and `wide` are display fields — they are only
 * ever read for the <=10 items that survive `z()`.
 *
 * So the selection can be computed from a query that carries neither images
 * nor user data, and the survivors re-hydrated by id. That is the JELA-830
 * id-union shape: cheap wide list, then one `?Ids=` hydrate.
 *
 * ---------------------------------------------------------------------------
 * Why this cannot move the rendered Top 10 (AC2)
 * ---------------------------------------------------------------------------
 * Structurally: `jpHyd859` runs AFTER `z()` and only ever writes display
 * fields onto the already-selected array, in place, in order. It cannot add,
 * drop or reorder an entry — the selection is a pure function of the lean
 * response, and the hydrate is a pure function of the selection.
 *
 * Empirically: `EnableImages=false&EnableUserData=false` changes neither the
 * row order (`SortBy=SortName`) nor `CriticRating`, and jp465's
 * `homeExcludedFilter` filters on `Id` alone. Replaying the module's own
 * `parseItems`+`selectDailyTop` exports over both live responses gives
 * byte-identical id lists for 400 consecutive dayStamps — see
 * `docs/jela859-top10-idsplit.md`.
 *
 * ---------------------------------------------------------------------------
 * Measured on prod (Limit=500, compressed, 3 reps)
 * ---------------------------------------------------------------------------
 *   shipped candidate query                52,265 B
 *   lean candidate query                   19,669 B   (-62.4%)
 *   + `?Ids=` hydrate of the 10 survivors   1,964 B
 *   ------------------------------------------------
 *   total                                  21,633 B   (-58.6%)
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here
 * ---------------------------------------------------------------------------
 * - Lowering `candidateLimit`. It is the daily ROTATION UNIVERSE, not an
 *   oversized buffer: `z()` shuffles the whole list before slicing, so a lower
 *   limit truncates to the alphabetically-first N and permanently excludes
 *   late-alphabet titles. See `docs/top10-candidate-pool.md`.
 * - Touching `jellyplug.top10.leanfields` / `.sharepool`. Both are already
 *   armed fleet-wide (`jpOn754` is fail-open since jp838) and leanfields buys
 *   491 B, 0.9%.
 *
 * The patch is dark by default: `jellyplug.top10.idsplit` is OPT-IN, so with
 * the key unset `jpLean859` returns its query untouched and `jpHyd859` returns
 * its selection synchronously — the shipped code path runs verbatim.
 *
 * Usage:
 *   node jsi-jp859-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp859-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

export const SPLIT_FLAG = "jellyplug.top10.idsplit";

/*
 * Injected at IIFE scope directly after the jp754 helpers, so `jpFlds754` (for
 * the hydrate's Fields) and `w` (the item mapper) are both in scope. `g` is
 * the window binding of the outer IIFE.
 *
 * jpHyd859 returns the selection SYNCHRONOUSLY when it has nothing to do (flag
 * off, empty selection, no ApiClient, getItems threw or returned a non-thenable)
 * and a promise otherwise. Every call site either returns it from a `.then()`
 * callback or hands it to a Promise `resolve`, both of which accept either.
 *
 * A rejected hydrate is NOT caught: a failed pool must stay a failed row so
 * jp473's retry latch sees it, and so the day cache is never written with null
 * image tags. A hydrate that succeeds but omits an id (deleted between the two
 * calls) leaves that entry's lean values in place.
 */
const HELPERS_SRC =
  "/*jp859*/" +
  'var jpF859="' +
  SPLIT_FLAG +
  '";' +
  'function jpOn859(){try{var l9=g.localStorage;return!!(l9&&l9.getItem(jpF859)==="1")}catch(e){return!1}}' +
  "function jpLean859(q){if(q&&jpOn859()){q.EnableImages=!1;q.EnableUserData=!1}return q}" +
  "function jpHyd859(ap,ui,sl,ty){" +
  'if(!jpOn859()||!sl||!sl.length||!ap||typeof ap.getItems!="function")return sl;' +
  "var id=[],i;" +
  "for(i=0;i<sl.length;i++){if(!sl[i]||!sl[i].id)return sl;id.push(sl[i].id)}" +
  'var q={Ids:id.join(","),Limit:id.length,Fields:jpFlds754(ty),' +
  'EnableImageTypes:"Primary",ImageTypeLimit:1,EnableTotalRecordCount:!1},p=null;' +
  "try{p=ap.getItems(ui,q)}catch(e0){return sl}" +
  'if(!p||typeof p.then!="function")return sl;' +
  "return p.then(function(rs){" +
  "var fu=w(rs,id.length),by={},j;" +
  "for(j=0;j<fu.length;j++)by[fu[j].id]=fu[j];" +
  "for(j=0;j<sl.length;j++){var h=by[sl[j].id];if(h){" +
  "sl[j].name=h.name;sl[j].serverId=h.serverId;sl[j].imageTag=h.imageTag;" +
  "sl[j].us=h.us;sl[j].wide=h.wide}}" +
  "return sl})}" +
  "/*jp859*/";

export const PATCH_IDSPLIT = {
  entry: /top10-badges/i,
  edits: [
    // 1. the helpers, parked after the jp754 block and ahead of the defaults.
    {
      what: "helpers",
      from:
        "s&&s.k===jpKey754(d,u,t)&&(jpFlight754=null)}" +
        '/*jp754*/var b={enabled:!0,title:"Top 10 Today"',
      to:
        "s&&s.k===jpKey754(d,u,t)&&(jpFlight754=null)}" +
        HELPERS_SRC +
        '/*jp754*/var b={enabled:!0,title:"Top 10 Today"',
    },
    // 2. B() — drop the per-item image + user-data payload from the candidate
    //    query. Both call sites (`ie` and `Ue`) build their query through B(),
    //    and `Ue` only ever mutates Fields / Limit / IncludeItemTypes
    //    afterwards, so one wrap covers both.
    {
      what: "leanquery:open",
      from: "function B(r){return{SortBy:r.sortBy,",
      to: "function B(r){return/*jp859*/jpLean859(/*jp859*/{SortBy:r.sortBy,",
    },
    {
      what: "leanquery:close",
      from: "ImageTypeLimit:1,EnableTotalRecordCount:!1}}function w(r,l){",
      to: "ImageTypeLimit:1,EnableTotalRecordCount:!1/*jp859*/})/*jp859*/}function w(r,l){",
    },
    // 3. ie() / JellyPlugTop10.rankedTopForType — the detail-badge consumer.
    //    `r` is the ApiClient, `y` the user id; `m.includeItemTypes` has
    //    already been overridden with the caller's type by this point.
    {
      what: "rankedtop",
      from:
        "var jpP754=jpW465(r.getItems(y,B(m))).then(function(h){" +
        "var I=w(h,m.candidateLimit);return z(I,l,m.poolSize,m.limit)});",
      to:
        "var jpP754=jpW465(r.getItems(y,B(m))).then(function(h){" +
        "var I=w(h,m.candidateLimit);return/*jp859*/jpHyd859(r,y,/*jp859*/" +
        "z(I,l,m.poolSize,m.limit)/*jp859*/,m.includeItemTypes)/*jp859*/});",
    },
    // 4. Ue()'s no-Promise fallback (engines without a global Promise).
    {
      what: "rowfetch:nopromise",
      from:
        "if(!g.Promise)return jpW465(e.getItems(n,B(l))).then(function(u){" +
        "var i=w(u,l.candidateLimit);return z(i,a,l.poolSize,l.limit)});",
      to:
        "if(!g.Promise)return jpW465(e.getItems(n,B(l))).then(function(u){" +
        "var i=w(u,l.candidateLimit);return/*jp859*/jpHyd859(e,n,/*jp859*/" +
        "z(i,a,l.poolSize,l.limit)/*jp859*/,l.includeItemTypes)/*jp859*/});",
    },
    // 5. Ue()'s main path — the boot fetch. `q0.IncludeItemTypes` is the
    //    EFFECTIVE type set (jp512's homeItemTypes may have overridden it), so
    //    the hydrate's Fields decision matches the query that produced `sl`.
    //    Resolving with a thenable adopts it, so `n0` takes either return.
    {
      what: "rowfetch:main",
      from:
        "n0(z(w(u,/*jp672*/jpN672&&q0.Limit>l.candidateLimit?q0.Limit:" +
        "/*jp672*/l.candidateLimit),a,l.poolSize,l.limit))",
      to:
        "n0(/*jp859*/jpHyd859(e,n,/*jp859*/" +
        "z(w(u,/*jp672*/jpN672&&q0.Limit>l.candidateLimit?q0.Limit:" +
        "/*jp672*/l.candidateLimit),a,l.poolSize,l.limit)" +
        "/*jp859*/,q0.IncludeItemTypes)/*jp859*/)",
    },
  ],
};

export const PATCHES = [PATCH_IDSPLIT];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp859 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp859*/");
  if (parts.length % 2 !== 1) {
    throw new Error("jp859 markers are unbalanced");
  }
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp859 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp859: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp859 patch for entry "${args.entry}"`);
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
