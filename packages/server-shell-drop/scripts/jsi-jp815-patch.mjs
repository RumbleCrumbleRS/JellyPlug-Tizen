#!/usr/bin/env node
/*
 * jsi-jp815-patch.mjs — JELA-815: gate below-the-fold row FETCH on visibility.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-815 edits as anchored textual patches against the LIVE
 * entry bodies, fail-closed on any anchor that does not match exactly once.
 * Pair it with the JELA-107/108 snapshot/gate/rollback discipline
 * (reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * JELA-813 measured the thing ten prior perf runs had skipped: what it costs to
 * SCROLL the home screen. Walking it top to bottom is **33 requests, 17 real,
 * and every one of the 17 is the JELA-762 media-bar rotation** — a ~15 s timer
 * that fires whether you scroll or not. Zero requests are attributable to row
 * hydration, because the entire home is already built at boot:
 *
 *   - 17 sections, 258 cards, **0 of them on screen** when the boot finishes;
 *   - 16 of 17 sections below the fold, and the one section inside the 540 px
 *     viewport renders 0 cards;
 *   - 76 requests / 263,586 B of home-row traffic paid at boot, each one
 *     cross-origin and therefore each one buying a CORS preflight too.
 *
 * The genre block is the deepest and largest single contributor: 14 candidate
 * queries fired in one burst (28 requests with preflights, ~96 KB), landing at
 * document y = 3,437 px and below. That is 6.4 viewports down on the 540 px rig
 * and still ~3.2 viewports down on a 1080p panel. A user who never scrolls
 * never sees one pixel of it.
 *
 * So: do not fetch a genre row until the viewport is approaching where it will
 * land. JELA-813 is what makes this safe rather than a cost shuffle — scroll
 * time is ~free today, so moving work into it is not moving it onto a hot path.
 *
 * ---------------------------------------------------------------------------
 * Why the gate is NOT an IntersectionObserver
 * ---------------------------------------------------------------------------
 * The ticket suggested IntersectionObserver. It cannot work here: a genre row's
 * DOM node does not exist until its items have arrived, so there is nothing to
 * observe. The observable proxy is the bottom edge of the home content that
 * HAS been built, which is exactly where the deferred rows will be appended
 * (genre rows carry rank 51+ and `style.order`, so they are always last).
 *
 *   PATCH_GATE (tizen-compat)  install `JellyPlug.rowViewGate`, a shared
 *                              hold/release gate driven by that edge.
 *   PATCH_ROWS (genre-rows)    wrap the 14-candidate fetch burst in a hold.
 *
 * tizen-compat owns the gate because it loads first and already carries the
 * `JellyPlug` namespace (the JELA-682 `genreIdCache` and the JELA-745
 * `rowPrefetch` live there for the same reason). The consumer null-guards, so
 * a partial deploy degrades to shipped behaviour rather than throwing.
 *
 * The release condition is two ANDed terms, and both are load-bearing:
 *
 *   1. **the user has scrolled at all.** Without this the gate false-opens
 *      during boot: at t+5 s the home is two sections tall, so its bottom edge
 *      is trivially within a lookahead of the viewport and the burst fires
 *      anyway. Scroll is detected three ways (`pageYOffset`, the scrolling
 *      element's `scrollTop`, and a drop in the first section's viewport-
 *      relative top) because JELA-813 proved `.page.homePage` reports
 *      `scrollHeight` 6450 > `clientHeight` 540 while `overflow-y: visible`
 *      makes it ignore `scrollTop` writes entirely — a probe keyed to any ONE
 *      mechanism reports a FALSE NULL. `getBoundingClientRect()` moves under
 *      all three mechanisms including a CSS transform.
 *   2. **the built home's bottom edge is within one lookahead of the viewport
 *      bottom**, where lookahead is `max(2 x innerHeight, 1080)`. Two
 *      screenfuls, floored at 1080 px, so a 1080p panel — which shows ~2
 *      sections, not 1 — gets the same relative lookahead the 854x540 rig does.
 *
 * FAIL-OPEN BELT: after `MAX_POLLS` polls (~10 minutes of a home that is never
 * scrolled) the gate releases anyway. A geometry probe that silently breaks on
 * some future layout must cost a late fetch, never a permanently missing row.
 *
 * ---------------------------------------------------------------------------
 * Scope, and what is deliberately NOT here
 * ---------------------------------------------------------------------------
 * Only genre-rows is gated. The other below-the-fold producers (my-list,
 * watch-it-again, top-picks, the taste-profile burst) render into sections with
 * ranks that place them in the MIDDLE of the home, so deferring them makes a
 * new row appear above the user's current scroll position and shifts the
 * content under them. Genre rows have no such problem — they are always last.
 * Solving mid-list insertion is a separate piece of work.
 *
 * Also not here: the 14-candidates-for-8-rows over-fetch found while reading
 * this entry (`F()` selects the first `O`=8 qualifying candidates, so on a
 * healthy library the last 6 queries are fetched and discarded every boot).
 * That is a win independent of scrolling and JELA-816 already ships it as
 * `jp816`; the two compose — jp816 shrinks the burst, jp815 moves what is left
 * off the boot path.
 *
 * ORDERING vs jp816. Both patches edit the genre-rows fan-out, and jp816's
 * `rows:fanout-open` anchor is a SUBSTRING of this patch's `rows:hold` anchor.
 * Apply **jp815 first**: jp815's replacement re-emits the fan-out verbatim, so
 * jp816 still matches afterwards, but jp816 rewrites the tail of jp815's
 * anchor, so the reverse order cannot match. Both directions fail CLOSED with a
 * named anchor error — the wrong order is a confusing message, never a silent
 * corruption. Asserted in the test; on the live channel jp815 is already
 * applied, so jp816 lands on top cleanly.
 *
 * Dark by default. Nothing changes until `jellyplug.rows.viewgate` is `"1"` in
 * localStorage. With the flag off `hold()` invokes its callback synchronously
 * and the shipped code path runs verbatim — which is exactly the AC4
 * differential.
 *
 * Usage:
 *   node jsi-jp815-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp815-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the whole patch. `"0"`/absent = shipped path. */
export const FLAG_KEY = "jellyplug.rows.viewgate";
/** Gate poll cadence, ms. */
export const POLL_MS = 750;
/** Fail-open belt: release unconditionally after this many polls (~10 min). */
export const MAX_POLLS = 800;
/** Lookahead floor, px — sized for a 1080p panel, not the 540 px rig. */
export const LOOKAHEAD_MIN_PX = 1080;

/*
 * The gate, as it is injected into tizen-compat. `s` is window and `n` is the
 * JellyPlug namespace in that snippet's IIFE.
 *
 * Everything is viewport-relative on purpose (JELA-813): `getBoundingClientRect`
 * is the only position signal that moves whether the app scrolls by `scrollTop`,
 * by window scroll, or by a CSS transform on a slider.
 *
 * Genre rows are excluded from the measured set. Including them would make the
 * gate self-referential — the first released row extends the content bottom,
 * which is the very edge the gate is watching.
 */
export const VIEW_GATE_SRC =
  "(function(){" +
  'var F="' +
  FLAG_KEY +
  '",P=' +
  POLL_MS +
  ",MX=" +
  MAX_POLLS +
  ",LK=" +
  LOOKAHEAD_MIN_PX +
  ";" +
  "var Q=[],H=null,mxT=null,scr=0,fired=0,polls=0,opened=0,why=null;" +
  'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}' +
  'function vh(){var h=s.innerHeight;return typeof h=="number"&&h>0?h:540}' +
  "function look(){var v=2*vh();return v<LK?LK:v}" +
  // Bottom-most and top-most viewport-relative edges of the NON-genre home
  // sections. Zero-height nodes are skipped: a reaped or not-yet-filled
  // section would otherwise pin the bottom edge at the top of the page.
  "function geo(){" +
  "var dc=s.document;if(!dc||!dc.querySelectorAll)return null;" +
  'var l=dc.querySelectorAll(".verticalSection"),b=null,t=null,i,e,r,cn,cnt=0;' +
  "for(i=0;i<l.length;i++){e=l[i];" +
  'cn=e&&e.className!=null?String(e.className):"";' +
  'if(cn.indexOf("jp-genre-row")!==-1)continue;' +
  "if(!e.getBoundingClientRect)continue;" +
  "r=e.getBoundingClientRect();if(!r||!(r.height>0))continue;" +
  "cnt++;" +
  "if(b===null||r.bottom>b)b=r.bottom;" +
  "if(t===null||r.top<t)t=r.top}" +
  "if(b===null)return null;return{b:b,t:t,n:cnt}}" +
  // Three independent scroll signals. Any one of them is enough; none of them
  // can be assumed present (JELA-813 trap: .page.homePage ignores scrollTop).
  "function scrolled(g){" +
  "try{if(s.pageYOffset>0)return 1}catch(e){}" +
  "try{var se=s.document.scrollingElement||s.document.documentElement;" +
  "if(se&&se.scrollTop>0)return 1}catch(e2){}" +
  "if(g&&g.t!=null){if(mxT===null||g.t>mxT)mxT=g.t;" +
  "if(mxT-g.t>vh()/2)return 1}" +
  "return 0}" +
  "function ready(){" +
  "var g=geo();if(!g)return 0;" +
  "if(!scr&&scrolled(g))scr=1;" +
  "if(!scr)return 0;" +
  'if(g.b<=vh()+look()){why="near";return 1}' +
  "return 0}" +
  "function flush(w){" +
  "opened=1;why=why||w;H=null;" +
  "var q=Q;Q=[];" +
  "for(var i=0;i<q.length;i++){fired++;try{q[i]()}catch(e){}}}" +
  "function tick(){H=null;if(!Q.length)return;" +
  'if(!on()){flush("disarmed");return}' +
  'if(++polls>=MX){flush("belt");return}' +
  "if(ready()){flush(null);return}" +
  "sched()}" +
  "function sched(){if(H!==null)return;" +
  "try{H=(s.setTimeout||setTimeout)(tick,P)}catch(e){H=null}}" +
  // Contract: hold() ALWAYS ends up calling fn exactly once. It returns true
  // only when the call was actually deferred, which is what the counters and
  // the AC assertions read.
  "function hold(k,fn){" +
  'if(typeof fn!="function")return!1;' +
  "if(!on()||opened){try{fn()}catch(e){}return!1}" +
  "Q.push(fn);sched();return!0}" +
  "function stats(){return{flag:on(),held:Q.length,fired:fired,polls:polls," +
  "opened:opened,scrolled:scr,why:why,vh:vh(),look:look(),geo:geo()}}" +
  "return{on:on,hold:hold,stats:stats}})()";

// --- tizen-compat: install the shared gate on the JellyPlug namespace --------
export const PATCH_GATE = {
  entry: /tizen-compat/i,
  edits: [
    {
      what: "gate",
      from: "/*jp745*/n.__compatReady=!0,",
      to:
        "/*jp815*/n.rowViewGate=" +
        VIEW_GATE_SRC +
        ",/*jp815*/" +
        "/*jp745*/n.__compatReady=!0,",
    },
  ],
};

// --- genre-rows: hold the 14-candidate fetch burst behind the gate ----------
// In this snippet `d` is window, `t` is the ApiClient, `i` is the user id,
// `f` is the candidate list and `jpUid` is the user the current pass belongs
// to. The deferred body re-checks `i!==jpUid` because a user switch between
// hold and release must abandon the burst, exactly as each `.then` already
// does for an in-flight one.
export const PATCH_ROWS = {
  entry: /genre-rows/i,
  edits: [
    {
      what: "rows:hold",
      from: "!$){$=!0;jpBusy();for(var a=0;a<f.length;a++)(function(u){",
      to:
        "!$){$=!0;" +
        "/*jp815*/var jpG815=(d.JellyPlug&&d.JellyPlug.rowViewGate)||null;" +
        "var jpF815=function(){if(i!==jpUid)return;/*jp815*/" +
        "jpBusy();for(var a=0;a<f.length;a++)(function(u){",
    },
    {
      what: "rows:release",
      from: "})(f[a])}V(t),ve()",
      to:
        "})(f[a])" +
        '/*jp815*/};if(jpG815&&jpG815.on())jpG815.hold("genre-rows",jpF815);' +
        "else jpF815();/*jp815*/" +
        "}V(t),ve()",
    },
  ],
};

export const PATCHES = [PATCH_GATE, PATCH_ROWS];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp815 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The snippets ship to a Chromium-63/V8-6.3 engine — no ES2015+ in our edits.
 *
 * Every insertion is wrapped in a PAIR of `/*jp815*\/` markers, so the added
 * spans are the ODD-indexed split parts (jp745's idiom, and the JELA-681
 * lesson: `.slice(1)` instead would scan the entire rest of the shipped body
 * and trip on unrelated substrings like `class` inside a CSS selector).
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp815*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp815 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp815: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp815 patch for entry "${args.entry}"`);
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
