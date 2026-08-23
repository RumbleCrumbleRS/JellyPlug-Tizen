#!/usr/bin/env node
/*
 * jsi-jp682-patch.mjs — JELA-682 ask #2: persist the genre name->id map.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-682 edits as anchored textual patches against the LIVE
 * entry bodies, fail-closed on any anchor that does not match exactly once.
 * Pair it with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline
 * (JELA-107/108, reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * Every JellyPlug genre row costs TWO serial round trips: `/Genres?SearchTerm=`
 * to turn the configured genre NAME into its id, then `/Users/{id}/Items?
 * ...&Genres=` for the row content. Measured on the virtual Tizen 5.0 rig
 * (JELA-680, n=4 cold boots): 16 name lookups per boot, 8 of them landing
 * inside the pre-firstCard window, where JELA-434's concurrency curve puts
 * every query in flight at roughly 2.4x its solo latency.
 *
 * Genre ids are stable per server. The lookup is therefore pure boot tax from
 * the second boot onwards, and the fix is to remember the answer:
 *
 *   PATCH_STORE   (tizen-compat)  install `JellyPlug.genreIdCache`, a
 *                                 localStorage-backed {name -> {id,name}} map
 *                                 bound to one server id.
 *   PATCH_ROWS    (genre-rows)    consult the store before dispatching
 *                                 getGenres; fill it from the response.
 *   PATCH_SEE_ALL (row-see-all)   the same, for the second module that
 *                                 resolves the same names (see JELA-683).
 *
 * tizen-compat owns the store because it loads first and already carries the
 * `JellyPlug` namespace, so both consumers can assume it exists; each consumer
 * still null-guards, so a partial deploy degrades to shipped behaviour rather
 * than throwing.
 *
 * Harness result (request counts, which are immune to the machine-load
 * confound that invalidated the JELA-680 timing arms): `/Genres?SearchTerm=`
 * lookups per cold boot 16 -> 0, with the card count unchanged at 185.
 *
 * ---------------------------------------------------------------------------
 * Scope, and what is deliberately NOT here
 * ---------------------------------------------------------------------------
 * Ask #1 of JELA-682 (take below-the-fold genre rows off the first-paint path)
 * is the same change as JELA-681 seen from the row side and lands in
 * jsi-jp681-patch.mjs; there is no second implementation of it here. Ask #3
 * (stop resolving each genre name twice) is JELA-683. The two patch scripts
 * touch disjoint regions of tizen-compat and genre-rows and may be applied in
 * either order; each is independently fail-closed.
 *
 * Dark by default. Nothing changes until `jellyplug.genres.idcache` is `"1"`
 * in localStorage. With the flag off the store object is built but every entry
 * point resolves to null and the shipped code path runs verbatim.
 *
 * FIRST-BOOT CAVEAT: a genuinely first-ever boot on a new server has an empty
 * map and pays the full lookup cost on the way through. This is a steady-state
 * lever — it helps every boot after the first, which is every boot a real TV
 * makes.
 *
 * Usage:
 *   node jsi-jp682-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp682-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage key holding the persisted map. */
export const STORE_KEY = "jellyplug.genreIds";
/** localStorage flag that arms the whole patch. */
export const FLAG_KEY = "jellyplug.genres.idcache";
/** Bumping this discards every previously persisted map. */
export const STORE_VERSION = 2;
/** Entries older than this are re-resolved (a renamed genre must not stick). */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * The store, as it is injected into tizen-compat. `s` is window and `n` is the
 * JellyPlug namespace in that snippet's IIFE.
 *
 * Two rules worth stating because they are what make a stale id impossible to
 * ship:
 *   - the map is bound to exactly one server id; the moment a different id is
 *     seen the whole map is dropped, never merged;
 *   - a missing/unknown server id neither reads nor writes, so a boot that has
 *     not resolved its server yet can never wipe a good map.
 * Negative results are not cached: a name that resolves to nothing today may
 * resolve tomorrow, and remembering "no" would hide the row forever.
 */
export const GENRE_CACHE_SRC =
  "(function(){" +
  'var K="' +
  STORE_KEY +
  '",F="' +
  FLAG_KEY +
  '",V=' +
  STORE_VERSION +
  ",A=" +
  MAX_AGE_MS +
  ",st=null;" +
  'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}' +
  "function load(){" +
  "if(st)return st;" +
  'try{st=JSON.parse(s.localStorage.getItem(K)||"null")}catch(e){st=null}' +
  "if(!st||st.v!==V||!st.m||typeof st.m!=\"object\")st={v:V,sid:null,m:{}};" +
  "return st}" +
  "function save(){try{s.localStorage.setItem(K,JSON.stringify(st))}catch(e){}}" +
  "function bind(sid){" +
  'var k=sid==null?"":String(sid);' +
  "if(!k)return null;" +
  "var c=load();" +
  "if(c.sid!==k){st={v:V,sid:k,m:{}};save()}" +
  "return st}" +
  "return{" +
  "on:on," +
  "get:function(sid,name){" +
  "if(!on()||name==null)return null;" +
  "var c=bind(sid);if(!c)return null;" +
  "var e=c.m[String(name).toLowerCase()];" +
  'if(!e||!e.v||e.v.id==null||typeof e.t!="number")return null;' +
  "if(new Date().getTime()-e.t>A)return null;" +
  'return{id:String(e.v.id),name:String(e.v.name==null?"":e.v.name)}},' +
  "put:function(sid,name,val){" +
  "if(!on()||name==null||!val||val.id==null)return;" +
  "var c=bind(sid);if(!c)return;" +
  "c.m[String(name).toLowerCase()]={t:new Date().getTime()," +
  'v:{id:String(val.id),name:String(val.name==null?"":val.name)}};' +
  "save()}}})()";

// --- tizen-compat: install the shared store on the JellyPlug namespace -------
export const PATCH_STORE = {
  entry: /tizen-compat/i,
  edits: [
    {
      what: "store",
      from: "var B=M(),Y=[];for(var Q in B.disabled)",
      to:
        "/*jp682*/n.genreIdCache=" +
        GENRE_CACHE_SRC +
        ";/*jp682*/" +
        "var B=M(),Y=[];for(var Q in B.disabled)",
    },
  ],
};

// --- genre-rows: consult the store, then fill it -----------------------------
// In this snippet `d` is window, `n` is the JellyPlug util namespace, `e` is
// the ApiClient, `i` is the genre name and `a` is its lowercased memo key.
export const PATCH_ROWS = {
  entry: /genre-rows/i,
  edits: [
    {
      what: "rows:lookup",
      from: 'if(p[a])return p[a];var u=n.safe("genre-rows.uid2"',
      to:
        "if(p[a])return p[a];" +
        "/*jp682*/var jpC682=(d.JellyPlug&&d.JellyPlug.genreIdCache)||null;" +
        "if(jpC682&&!jpC682.on())jpC682=null;" +
        'var jpS682=jpC682?n.safe("genre-rows.sid682",function(){' +
        'return typeof e.serverId=="function"?e.serverId():null},null):null,' +
        "jpH682=jpC682?jpC682.get(jpS682,i):null;" +
        "if(jpH682&&d.Promise){p[a]=d.Promise.resolve(jpH682);return p[a]}/*jp682*/" +
        'var u=n.safe("genre-rows.uid2"',
    },
    {
      what: "rows:fill",
      from:
        '(p[a]=l.then(function(c){var h=c&&c.Items&&typeof c.Items.length=="number"?c.Items:[];' +
        "return K(h,i)},function(){return null}),p[a])",
      to:
        '(p[a]=l.then(function(c){var h=c&&c.Items&&typeof c.Items.length=="number"?c.Items:[];' +
        "/*jp682*/var jpR682=K(h,i);" +
        'if(jpC682)n.safe("genre-rows.put682",function(){jpC682.put(jpS682,i,jpR682)});' +
        "return jpR682;/*jp682*/" +
        "},function(){return null}),p[a])",
    },
  ],
};

// --- row-see-all: the same two edits, different local names ------------------
// Here `u` is window, `t` is the util namespace, `e` is the ApiClient, `n` is
// the genre name (NOT the namespace) and `s` is its lowercased memo key.
export const PATCH_SEE_ALL = {
  entry: /row-see-all/i,
  edits: [
    {
      what: "seeall:lookup",
      from: 'if(m[s])return m[s];var f=t.safe("row-see-all.uid"',
      to:
        "if(m[s])return m[s];" +
        "/*jp682*/var jpC682=(u.JellyPlug&&u.JellyPlug.genreIdCache)||null;" +
        "if(jpC682&&!jpC682.on())jpC682=null;" +
        'var jpS682=jpC682?t.safe("row-see-all.sid682",function(){' +
        'return typeof e.serverId=="function"?e.serverId():null},null):null,' +
        "jpH682=jpC682?jpC682.get(jpS682,n):null;" +
        "if(jpH682&&u.Promise){m[s]=u.Promise.resolve(jpH682);return m[s]}/*jp682*/" +
        'var f=t.safe("row-see-all.uid"',
    },
    {
      what: "seeall:fill",
      from:
        '(m[s]=l.then(function(i){var d=i&&i.Items&&typeof i.Items.length=="number"?i.Items:[];' +
        "return E(d,n)},function(){return null}),m[s])",
      to:
        '(m[s]=l.then(function(i){var d=i&&i.Items&&typeof i.Items.length=="number"?i.Items:[];' +
        "/*jp682*/var jpR682=E(d,n);" +
        'if(jpC682)t.safe("row-see-all.put682",function(){jpC682.put(jpS682,n,jpR682)});' +
        "return jpR682;/*jp682*/" +
        "},function(){return null}),m[s])",
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
        `jp682 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp682*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp682 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp682: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp682 patch for entry "${args.entry}"`);
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
