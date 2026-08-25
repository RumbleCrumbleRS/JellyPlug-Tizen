#!/usr/bin/env node
/*
 * jsi-jp716-patch.mjs — JELA-716 (local half of JELA-715): defer the vendored
 * media-bar library scan off the boot path, and stop the recovery entry from
 * re-linking (or re-scripting) the CDN chain the shell rewrote away.
 *
 * The code our M63 fleet actually RUNS is the es2017 vendored copy of
 * slideshowpure.js inside JSI entry `mediabar-tizen5-rescue` (JELA-115) — the
 * CDN copy is parse-dead there (13 optional-chaining sites). Both entries
 * live only on the JS-Injector channel (the jellyplug-theme source repo is
 * gone — the channel IS the source of truth, JELA-227), so these are anchored
 * textual patches against the LIVE bodies, fail-closed on any anchor that
 * does not match exactly once. Pair with snapshot/rollback discipline like
 * jsi-jp710-patch.mjs.
 *
 * ---------------------------------------------------------------------------
 * PATCH_RESCUE (mediabar-tizen5-rescue, flag `jellyplug.mediabar.deferscan`)
 * ---------------------------------------------------------------------------
 * JELA-715 measured the hero's `/Items?...Recursive=true&sortBy=Random...`
 * full-library scan landing BEFORE firstCard (scan GET 2,604 ms server-side
 * on the JELA-706 capture; 2.1 s server CPU) — the slideshow initializes on
 * a 2 s login poll with no home-render coordination. Boot latency tracks
 * in-flight REQUEST COUNT (boot-concurrency-queueing), so the fix holds the
 * DATA fetch, not the DOM: #slides-container creation stays eager (the
 * plugin's .bar-loading overlay waits on it, and the JELA-286 teardown rule
 * depends on it), while loadSlideshowData awaits a gate that resolves when a
 * `.card` exists (shell paint gate when available, 250 ms poll fallback),
 * with a bounded fail-open (`jellyplug.mediabar.deferscanMaxMs`, default
 * 20000) so an empty or cardless home still gets its hero, plus an optional
 * post-card settle delay (`jellyplug.mediabar.deferscanDelayMs`, default 0).
 * Flag-dark: opt in with localStorage["jellyplug.mediabar.deferscan"]="1".
 * Diag (the ON arm must prove the lever fired, perf-protocol rule 4):
 * window.__jpMB716 = {on,held,fired,waitMs}.
 *
 * Holding inside loadSlideshowData (after isLoading=!0) covers both callers
 * (slidesInit and the WebConfig handler's initSlideshowData) and also holds
 * the list.txt probe that precedes the Random fallback — both are pre-paint
 * requests today. This is a LOCAL EDIT vs upstream — keep it when
 * regenerating (docs/jela115-mediabar-tizen5-rescue.md), like JELA-117/120/
 * 257/286/315/318/437/449/488/536/537/575.
 *
 * ---------------------------------------------------------------------------
 * PATCH_RECOVERY (`JellyPlug — media-bar`, the index.html recovery script)
 * ---------------------------------------------------------------------------
 * The recovery XHR-fetches /web/index.html, extracts the media-bar tags and
 * re-appends any that are "missing". Two defects:
 *
 *   1. Its stylesheet dedupe (fn E) compares the RAW extracted href against
 *      the DOM's resolved link hrefs. Since JELA-710 the shell repoints the
 *      written <link> at /shell/fonts/mediabar-slideshowpure.css, so the raw
 *      jsdelivr href can NEVER match — whenever the recovery delivers, it
 *      appends a second, jsdelivr-fetching stylesheet link. E now (a) maps a
 *      jsdelivr slideshowpure href to the self-hosted URL first (same kill
 *      switch as the shell rewrite: jellyfin.shell.selfFontsDisabled), (b)
 *      dedupes on the CURRENT document (var s is captured at channel time —
 *      this engine's document.open() handoff can leave it stale) by resolved
 *      href OR by stylesheet filename, and (c) latches once per window
 *      (__JP_MEDIABAR_CSS_LINKED__).
 *   2. Its asset walk re-appends the CDN slideshowpure.js <script>. On a
 *      parse-dead engine with the JELA-115 rescue installed that fetch can
 *      never produce a hero — skip it there (capable engines keep the
 *      shipped re-delivery; it is their actual recovery mechanism).
 *
 * Kill switch for both recovery edits:
 * localStorage["jellyplug.mediabar.jp716Off"]="1" (css repoint additionally
 * honours jellyfin.shell.selfFontsDisabled, matching jsi-jp710-patch.mjs).
 *
 * NOTE this entry is NOT the rescue: it runs on every engine, so additions
 * here are ES5. The rescue entry is es2017 (async/await already shipped) —
 * additions there are asserted against ES2020+ instead (jela762 precedent).
 *
 * Usage:
 *   node jsi-jp716-patch.mjs --config <live-cfg.json> --out <patched.json>
 *   node jsi-jp716-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

export const FLAG_KEY = "jellyplug.mediabar.deferscan";
export const MAX_MS_KEY = "jellyplug.mediabar.deferscanMaxMs";
export const DELAY_MS_KEY = "jellyplug.mediabar.deferscanDelayMs";
export const RECOVERY_OFF_KEY = "jellyplug.mediabar.jp716Off";
export const FONTS_OFF_KEY = "jellyfin.shell.selfFontsDisabled";
export const LOCAL_MEDIABAR_URL = "/shell/fonts/mediabar-slideshowpure.css";

// --- mediabar-tizen5-rescue: hold the library scan until a .card exists -----
export const PATCH_RESCUE = {
  entry: /mediabar-tizen5-rescue/i,
  edits: [
    {
      what: "defer-helpers",
      from: "window.__JP_MEDIABAR_TIZEN5_RESCUE__ = true;",
      to:
        "window.__JP_MEDIABAR_TIZEN5_RESCUE__ = true;\n" +
        '/*jp716*/var jp716Get=function(n,d){try{var v=window.localStorage?window.localStorage.getItem(n):null;return v===null||v===""?d:v}catch(e){return d}};' +
        "var jp716Defer=function(){" +
        'try{if(jp716Get("jellyplug.mediabar.deferscan","0")!=="1")return Promise.resolve();' +
        'var st=window.__jpMB716||(window.__jpMB716={on:1,held:0,fired:"",waitMs:0});' +
        'var max=parseInt(jp716Get("jellyplug.mediabar.deferscanMaxMs","20000"),10);if(!(max>0))max=2e4;' +
        'var post=parseInt(jp716Get("jellyplug.mediabar.deferscanDelayMs","0"),10);if(!(post>=0))post=0;' +
        "var t0=+new Date();" +
        'var hasCard=function(){try{return!!(window.document&&window.document.querySelector&&window.document.querySelector(".card"))}catch(e){return!1}};' +
        "var after=function(res,why){st.fired=why;st.waitMs=+new Date()-t0;if(post>0){setTimeout(res,post)}else{res()}};" +
        'if(hasCard())return new Promise(function(res){after(res,"immediate")});' +
        "st.held++;" +
        "return new Promise(function(res){" +
        "var done=!1;" +
        "var fin=function(why){if(done)return;done=!0;if(iv){clearInterval(iv)}after(res,why)};" +
        'var iv=setInterval(function(){if(hasCard()){fin("card")}else if(+new Date()-t0>=max){fin("timeout")}},250);' +
        'try{var g=window.__shellPaintGate;if(g&&typeof g.onPaint==="function"){g.onPaint(function(){fin("paint")})}}catch(e){}' +
        "})}catch(e){return Promise.resolve()}};/*jp716*/",
    },
    {
      what: "defer-hold",
      from: "async loadSlideshowData(){try{STATE.slideshow.isLoading=!0;let e=await ApiUtils.fetchItemIdsFromList();",
      to: "async loadSlideshowData(){try{STATE.slideshow.isLoading=!0;/*jp716*/await jp716Defer();/*jp716*/let e=await ApiUtils.fetchItemIdsFromList();",
    },
  ],
};

// --- media-bar recovery: dedupe/repoint the css, skip the dead CDN script ---
export const PATCH_RECOVERY = {
  entry: /^JellyPlug — media-bar$/,
  edits: [
    {
      what: "recovery-helpers",
      from: '(function(a){"use strict";var s=a.document;',
      to:
        '(function(a){"use strict";var s=a.document;' +
        "/*jp716*/function jp716Doc(){try{return a.document||s}catch(e){return s}}" +
        'function jp716Off(){try{return!!(a.localStorage&&a.localStorage.getItem("jellyplug.mediabar.jp716Off")==="1")}catch(e){return!1}}' +
        'function jp716Dead(){try{new Function("void 0?"+".x");return!1}catch(e){return!0}}' +
        "function jp716Css(u){try{if(jp716Off())return u;" +
        'if(a.localStorage&&a.localStorage.getItem("jellyfin.shell.selfFontsDisabled")==="1")return u;' +
        "if(!/cdn\\.jsdelivr\\.net\\/[^\"' ]*slideshowpure[^\"' ]*\\.css/i.test(String(u)))return u;" +
        "var e=a.ApiClient,v=e&&e.serverAddress?String(e.serverAddress()).replace(/\\/+$/,\"\"):\"\";" +
        'if(!v)return u;return v+"/shell/fonts/mediabar-slideshowpure.css"}catch(e2){return u}}' +
        "function jp716SkipJs(u){if(jp716Off())return!1;return!!(jp716Dead()&&a.__JP_MEDIABAR_TIZEN5_RESCUE__&&/slideshowpure[^\"']*\\.js/i.test(String(u)))}/*jp716*/",
    },
    {
      what: "recovery-css-dedupe",
      from: 'function E(e,r){for(var i=c(e),t=s.querySelectorAll(\'link[rel="stylesheet"]\'),n=0;n<t.length;n++)if(t[n].href===i)return;var l=s.createElement("link");l.rel="stylesheet",l.href=i,l.setAttribute("data-jellyplug-mediabar","css"),p().appendChild(l),r&&r.log("media-bar: linked "+i)}',
      to:
        "function E(e,r){/*jp716*/var d=jp716Doc(),i=c(jp716Css(e));" +
        "if(a.__JP_MEDIABAR_CSS_LINKED__)return;" +
        "var t=d.querySelectorAll('link[rel=\"stylesheet\"]');" +
        "for(var n=0;n<t.length;n++){var h=t[n].href||t[n].getAttribute(\"href\")||\"\";" +
        "if(h===i||/(^|\\/)(mediabar-)?slideshowpure\\.css([?#]|$)/i.test(h)){a.__JP_MEDIABAR_CSS_LINKED__=!0;return}}" +
        'var l=d.createElement("link");l.rel="stylesheet",l.href=i,l.setAttribute("data-jellyplug-mediabar","css"),' +
        "(d.head||d.getElementsByTagName(\"head\")[0]||d.documentElement).appendChild(l)," +
        "a.__JP_MEDIABAR_CSS_LINKED__=!0," +
        'r&&r.log("media-bar: linked "+i)/*jp716*/}',
    },
    {
      what: "recovery-skip-dead-js",
      from: 'if(n.type==="external"){var l=c(n.src),u=s.createElement("script");',
      to: 'if(n.type==="external"){/*jp716*/if(jp716SkipJs(n.src)){r&&r.log("media-bar: skipped parse-dead CDN script "+n.src),t();return}/*jp716*/var l=c(n.src),u=s.createElement("script");',
    },
  ],
};

export const PATCHES = [PATCH_RESCUE, PATCH_RECOVERY];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp716 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The rescue entry is es2017 (it already ships async/await, templates,
 * arrows) and the recovery must stay runnable on every engine. Either way
 * nothing we ADD may introduce ES2020+ syntax — the vendored copy runs
 * exactly on the engines that cannot parse it (jela762 precedent; the
 * "void 0?"+".x" parse-probe string is split so this source stays clean).
 * The added regions sit between paired jp716 block-comment markers; they
 * object-literal-free plain statements, so each region parses standalone.
 */
export function assertNoModernAdditions(body) {
  const parts = body.split("/*jp716*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/\?\.|\?\?|catch\s*\{/.test(added)) {
    throw new Error("jp716 edit introduced ES2020+ syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp716: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    assertNoModernAdditions(after);
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
      console.error(`no jp716 patch targets entry "${args.entry}"`);
      process.exit(2);
    }
    const body = readFileSync(args.in, "utf8");
    const after = applyPatch(body, patch);
    assertNoModernAdditions(after);
    new vm.Script(after, { filename: `${args.entry}.js` });
    writeFileSync(args.out, after);
    console.error(
      `ok  ${args.entry}  ${after.length - body.length >= 0 ? "+" : ""}${after.length - body.length} B`,
    );
  } else {
    console.error("need --config <cfg.json> or --entry <name> --in <body.js>");
    process.exit(2);
  }
}
