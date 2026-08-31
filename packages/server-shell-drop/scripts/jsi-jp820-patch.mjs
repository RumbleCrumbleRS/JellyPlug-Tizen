#!/usr/bin/env node
/*
 * jsi-jp820-patch.mjs — JELA-820: reserve the mid-home row slots, then fill
 * them, so the fetch can be gated on visibility WITHOUT shifting content.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-820 edits as anchored textual patches against the LIVE
 * entry bodies, fail-closed on any anchor that does not match exactly once.
 *
 * ---------------------------------------------------------------------------
 * Why this could not be another jp815 hold()
 * ---------------------------------------------------------------------------
 * jp815 gated the genre block and took 28 of the 76 boot home-row requests off
 * the boot path. Genre rows are safe to defer because they are ALWAYS LAST —
 * rank 51+ plus `style.order`, so a late arrival appends below everything and
 * nothing the user is looking at moves.
 *
 * The remaining producers do not have that property. At rest (JELA-815 control
 * boot, 854x540 rig) they land mid-home:
 *
 *     y=1230  Top Picks for <user>     top-picks       rank 22
 *     y=1607  Watch It Again           watch-it-again  rank 25
 *     y=3060  My List                  my-list         rank 50
 *
 * Defer one of those fetches and its row materialises ABOVE the user's scroll
 * position and shifts everything under it. On a D-pad TV that moves the focused
 * card out from under the user's thumb — a worse regression than the requests
 * are worth.
 *
 * So: RESERVE THE SLOT, THEN FILL IT. At boot each producer mounts a
 * fixed-geometry placeholder section at its own rank (cheap, zero network) and
 * holds only the FETCH. The document height is therefore final from boot, and
 * hydration is an in-place swap of the cards inside a container that never
 * moves.
 *
 * ---------------------------------------------------------------------------
 * The placeholder is built by the producer's own code
 * ---------------------------------------------------------------------------
 * The one thing that makes AC2 ("no section's document-space top moves by more
 * than 8 px") tractable is refusing to hand-roll the placeholder DOM. Each
 * producer already owns three functions:
 *
 *     build   me() / ie() / V()   -> the empty `.verticalSection` shell
 *     fill    X() / F() / j()     -> replaces `.itemsContainer` with cards
 *     insert  ge() / oe() / $()   -> rank-ordered insertBefore into the home
 *
 * The patch calls those SAME three with a list of neutral stub items, so the
 * placeholder is structurally identical to the hydrated row by construction
 * rather than by a hardcoded height that drifts the first time a card gains a
 * line of text. Hydration then goes down the shipped "swap in place" branch —
 * the one that already exists for a cached row being revalidated — because
 * `find()` now returns our placeholder.
 *
 * The stub items carry NO `imageTag`, and every card builder guards its poster
 * on `e.imageTag && api.getImageUrl`, so a placeholder issues zero requests. It
 * takes the `--noart` fallback branch, which is the same box. Both card text
 * lines are present (name and year set to U+00A0) so the text block is the
 * height of a two-line real card, which is the tallest real state.
 *
 * Placeholder cards are stripped of `href` and given `tabindex="-1"` +
 * `aria-hidden` so D-pad focus cannot land on a blank card. That sanitation is
 * SELF-CLEANING: the fill function replaces the whole `.itemsContainer`, so the
 * dead anchors are gone the moment the row hydrates. Nothing is left on the
 * SECTION that could survive hydration and make a live row unclickable — which
 * is why the placeholder is not marked with `pointer-events:none`.
 *
 * ---------------------------------------------------------------------------
 * Why the gate is per-element now, and still needs the scroll term
 * ---------------------------------------------------------------------------
 * jp815 could not observe its target: a genre row's DOM node does not exist
 * until its items arrive, so it watched the bottom edge of the built home as a
 * proxy. Reserving the slot removes that limitation — the placeholder IS the
 * row's final position — so `holdEl` measures the real element.
 *
 * The scroll term survives anyway, for the same reason it existed in jp815 but
 * a different mechanism. A placeholder mounted at t+2 s sits at whatever y the
 * two sections built so far leave it at; the sections above it are still
 * arriving, so its rect.top climbs toward its resting y over the next seconds.
 * Geometry alone therefore FALSE-OPENS early — exactly the jp815 trap, relocated.
 * ANDing with "the user has scrolled at all" kills it outright, and unlike
 * jp815 the wait is free: the slot is already reserved, so a late fill shifts
 * nothing. Scroll is detected three ways (jp815's `scrolled()`, reused
 * verbatim from the enclosing IIFE scope) because JELA-813 proved
 * `.page.homePage` ignores `scrollTop` writes and a probe keyed to any ONE
 * mechanism reports a FALSE NULL.
 *
 * Lookahead is ONE screenful (`max(innerHeight, 540)`), not jp815's two. jp815
 * needed two because it was measuring a proxy edge that UNDERSTATES the
 * distance to the deferred rows; a per-element gate knows the real distance, so
 * the ticket's "first viewport plus one screenful" is what it should use. It is
 * relative to `innerHeight`, so a 1080p panel gets 1080 px of lookahead against
 * a layout whose rows are correspondingly taller — the JELA-815 "size it for
 * 1080p, not the rig" note is satisfied by construction rather than by a floor.
 *
 * Two bounded fallbacks, because a stuck row is worse than an early fetch:
 *
 *   MOUNT_MAX polls  the placeholder could not be mounted (no home container
 *                    yet, or the producer's build threw) -> release and let the
 *                    shipped path fetch and inject as it does today.
 *   MAX_POLLS        fail-open belt inherited from jp815: a geometry probe that
 *                    silently breaks on some future layout costs a late fetch,
 *                    never a permanently missing row.
 *
 * ---------------------------------------------------------------------------
 * Ordering, composition, and scope
 * ---------------------------------------------------------------------------
 * PATCH_GATE extends the jp815 gate object in place; it anchors on jp815's own
 * `stats()`/`return` tail, so it REQUIRES jp815 to be applied first and says so
 * by name if it is not. jp816 touches only the genre-rows fan-out, which this
 * patch does not go near, so jp820 commutes with jp816. Supported order is
 * jp815 -> jp816 -> jp820, and the test pins all three.
 *
 * NOT here, deliberately: the 10 boot requests from `/HomeScreen/Section/*`
 * (LatestMovies, LatestShows, BecauseYouWatched, ContinueWatchingNextUp) and
 * `/Items/Latest`. Those rows are built by the Home Screen Sections plugin and
 * the stock web client, not by a JS-Injector entry — there is no `build`/`fill`
 * pair to reserve a slot with, so they need a shell-side change and their own
 * ticket. Also not here: the 10-request taste-profile burst, which belongs to
 * `match-score` and renders no row at all.
 *
 * Dark by default. Nothing changes until `jellyplug.rows.viewgate` is `"1"` in
 * localStorage — the SAME flag jp815 already uses, on purpose: these are two
 * halves of one behaviour and a TV must never run half of it. With the flag off
 * `reserve()` returns null, no placeholder is mounted, `holdEl()` is never
 * reached and the shipped code path runs verbatim, which is the AC4
 * differential.
 *
 * Usage:
 *   node jsi-jp820-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp820-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** Shared with jp815 on purpose — one flag arms the whole row-view behaviour. */
export const FLAG_KEY = "jellyplug.rows.viewgate";
/** Stub cards per reserved row. Height is independent of this; 3 reads as a row. */
export const STUB_CARDS = 3;
/** Give up on mounting a placeholder after this many polls (~15 s at 750 ms). */
export const MOUNT_MAX = 20;
/** Lookahead floor, px. Normally `innerHeight` dominates; this covers a 0/NaN. */
export const LOOKAHEAD_MIN_PX = 540;

/*
 * Gate additions, injected INSIDE jp815's `rowViewGate` IIFE so they close over
 * its `s` (window), `P` (poll ms), `MX` (belt), `on()`, `vh()`, `geo()`,
 * `scrolled()` and the shared `scr` latch. Sharing `scr` is what lets a single
 * scroll satisfy both queues; sharing `mxT` inside `scrolled()` is safe because
 * it is a monotonic maximum that both callers only ever raise.
 *
 * The element queue polls independently of jp815's `tick()` because `tick()`
 * stops rescheduling once its own queue drains — reaching into it would mean
 * rewriting proven shipped code instead of adding to it.
 */
export const HOLD_EL_SRC =
  "/*jp820*/" +
  "var EQ=[],EK={},eH=null,eF=0,eP=0,eO=0,eW=null,RES=0,NOM=0," +
  "MM=" +
  MOUNT_MAX +
  ",LK1=" +
  LOOKAHEAD_MIN_PX +
  ";" +
  // One screenful of lookahead, relative to the panel (JELA-815 sizing note).
  "function look1(){var v=vh();return v<LK1?LK1:v}" +
  // `el` is the memoised resolver returned by reserve(): re-run every poll so a
  // home container that appears late still gets its placeholder.
  "function node820(it){" +
  'if(typeof it.el=="function"){try{return it.el()}catch(e){return null}}' +
  "return it.el||null}" +
  // 1 = release, 0 = keep holding. A node with no box yet (display:none, or
  // detached mid-reap) keeps holding rather than releasing on a bogus 0/0 rect.
  "function nearEl(nd){" +
  "if(!nd||!nd.getBoundingClientRect)return 0;" +
  "var r;try{r=nd.getBoundingClientRect()}catch(e){return 0}" +
  "if(!r)return 0;" +
  "if(!(r.width>0||r.height>0))return 0;" +
  "return r.top<=vh()+look1()?1:0}" +
  'function mark820(nd,v){try{if(nd&&nd.setAttribute)nd.setAttribute("data-jp820",v)}catch(e){}}' +
  // `w` is the RELEASE REASON, and it is written onto the node as well as into
  // the counters. JELA-815: without it you cannot tell a gate that opened on
  // geometry from one the fail-open belt let through, and those are very
  // different results to report.
  "function fire820(it,w){eF++;eO=1;eW=eW||w;delete EK[it.k];" +
  "mark820(node820(it),w);" +
  "try{it.fn()}catch(e){}}" +
  "function eflush(w){var q=EQ;EQ=[];EK={};" +
  "for(var i=0;i<q.length;i++)fire820(q[i],w)}" +
  "function etick(){eH=null;if(!EQ.length)return;" +
  'if(!on()){eflush("disarmed");return}' +
  'if(++eP>=MX){eflush("belt");return}' +
  "if(!scr&&scrolled(geo()))scr=1;" +
  "var keep=[],i,it,nd;" +
  "for(i=0;i<EQ.length;i++){it=EQ[i];nd=node820(it);" +
  // Bounded give-up: never let a row hang because its slot never mounted.
  'if(!nd){if(++it.m>=MM){NOM++;fire820(it,"nomount");continue}keep.push(it);continue}' +
  'if(scr&&nearEl(nd)){fire820(it,"near");continue}' +
  "keep.push(it)}" +
  "EQ=keep;if(EQ.length)esched()}" +
  "function esched(){if(eH!==null)return;" +
  "try{eH=(s.setTimeout||setTimeout)(etick,P)}catch(e){eH=null}}" +
  // Contract, same as jp815's hold(): fn is called exactly once either way, and
  // the return value says only whether the call was DEFERRED.
  "function holdEl(k,el,fn){" +
  'if(typeof fn!="function")return!1;' +
  "if(!on()){try{fn()}catch(e){}return!1}" +
  "if(EK[k])return!0;" +
  "var it={k:k,el:el,fn:fn,m:0};" +
  // Resolve once now so the placeholder is in the DOM at boot, not a poll later.
  "var nd=node820(it);" +
  "if(nd&&scr&&nearEl(nd)){try{fn()}catch(e){}return!1}" +
  "EK[k]=1;EQ.push(it);esched();return!0}" +
  // Neutral items: no imageTag => every card builder takes its no-poster branch
  // and issues no request. name/year are U+00A0 so both cardText lines exist.
  "function stubs(n){var a=[],i;if(!(n>0))n=" +
  STUB_CARDS +
  ";" +
  'for(i=0;i<n;i++)a.push({id:"",serverId:"",type:"",name:"\\u00a0",' +
  'year:"\\u00a0",imageTag:null,us:null,wide:!1});return a}' +
  // Strip interactivity from placeholder cards. Section-level state is
  // deliberately untouched so nothing can survive the hydration swap.
  "function sane820(nd){" +
  'var l,i;try{l=nd.querySelectorAll?nd.querySelectorAll("a"):[]}catch(e){return}' +
  'for(i=0;i<l.length;i++){try{l[i].removeAttribute("href");' +
  'l[i].setAttribute("tabindex","-1");l[i].setAttribute("aria-hidden","true")}catch(e2){}}}' +
  // Returns a MEMOISED resolver, not a node: the home container may not exist
  // when the producer first runs, and retrying each poll is what makes the
  // reservation survive a slow home mount.
  "function reserve(k,o){" +
  "if(!on()||!o)return null;" +
  "var nd=null;" +
  "return function(){" +
  "if(nd&&nd.parentNode)return nd;" +
  "var ex=null;try{ex=o.find?o.find():null}catch(e){ex=null}" +
  "if(ex){nd=ex;return nd}" +
  "var b=null;try{b=o.build?o.build():null}catch(e2){b=null}" +
  "if(!b)return null;" +
  'sane820(b);mark820(b,"ph");' +
  "var ok=!1;try{ok=!!(o.mount&&o.mount(b))}catch(e3){ok=!1}" +
  "if(!ok)return null;" +
  "RES++;nd=b;return nd}}" +
  "function stats820(){return{flag:on(),reserved:RES,held:EQ.length,fired:eF," +
  "polls:eP,opened:eO,why:eW,nomount:NOM,scrolled:scr,vh:vh(),look:look1()}}" +
  "/*jp820*/";

// --- tizen-compat: extend the jp815 gate with the per-element half ----------
export const PATCH_GATE = {
  entry: /tizen-compat/i,
  requires: "jp815",
  edits: [
    {
      what: "gate:holdEl",
      from: "function stats(){return{flag:on(),held:Q.length,",
      to: HOLD_EL_SRC + "function stats(){return{flag:on(),held:Q.length,",
    },
    {
      what: "gate:export",
      from: "return{on:on,hold:hold,stats:stats}})()",
      to:
        "return{on:on,hold:hold,stats:stats" +
        "/*jp820*/,holdEl:holdEl,reserve:reserve,stubs:stubs,stats820:stats820/*jp820*/" +
        "}})()",
    },
  ],
};

/*
 * Producer edits. Each is the same shape:
 *
 *   open   name the shipped fetch block `jpRun820` and reserve the slot first
 *   close  close that function and either hold it or run it
 *
 * `win` is the snippet's window alias, and find/build/fill/insert/container/
 * idle are that snippet's own minified helpers — read off the live entry
 * bodies, and pinned by the anchors, which fail closed if the minifier renames
 * them on a future publish.
 *
 * On hold we call the producer's IDLE function immediately. Those are the
 * JELA-681 paint-gate signals (`t.rowIdle`); leaving a held row marked BUSY
 * would stall the home paint for the whole hold. jp815 does the same thing with
 * genre-rows' `ve()`. The busy-side 9 s watchdog would eventually clear it
 * anyway, but "eventually" is not a design.
 *
 * The hold key carries the user id so a mid-hold profile switch enqueues a
 * fresh closure instead of being deduped away; the stale one still self-aborts
 * on the shipped `r!==jpUid` guard when it fires.
 */
function producerEdits(cfg) {
  const {
    tag,
    win,
    api,
    uid,
    find,
    build,
    fill,
    insert,
    container,
    idle,
    apply,
    title,
    open,
    close,
  } = cfg;
  const t = title ? title : null;
  // build(): the shell, then the producer's own fill with neutral stubs.
  const buildSrc = t
    ? `var jt=${t},jn=${build}(jt);${fill}(jn,jt,jpG820.stubs(${STUB_CARDS}),${api});return jn`
    : `var jn=${build}();${fill}(jn,jpG820.stubs(${STUB_CARDS}),${api});return jn`;
  return [
    {
      what: `${tag}:open`,
      from: open,
      to:
        `/*jp820*/var jpG820=(${win}.JellyPlug&&${win}.JellyPlug.rowViewGate)||null;` +
        `var jpPh820=jpG820&&jpG820.reserve?jpG820.reserve("${tag}",{` +
        `find:function(){return ${find}()},` +
        `build:function(){${buildSrc}},` +
        `mount:function(jn){var jc=${container}();if(!jc)return!1;` +
        `${apply}(function(){${insert}(jc,jn)});return!0}` +
        `}):null;` +
        `var jpRun820=function(){/*jp820*/` +
        open,
    },
    {
      what: `${tag}:close`,
      from: close,
      to:
        close +
        `/*jp820*/};` +
        `if(jpPh820&&jpG820.holdEl("${tag}:"+${uid},jpPh820,jpRun820))${idle}();` +
        `else jpRun820();/*jp820*/`,
    },
  ];
}

export const PATCH_TOP_PICKS = {
  entry: /top-picks/i,
  edits: producerEdits({
    tag: "top-picks",
    win: "c",
    api: "e",
    uid: "r",
    find: "ye",
    build: "me",
    fill: "X",
    insert: "ge",
    container: "N",
    idle: "k",
    apply: "x",
    // w(null) resolves to the shipped default "Top Picks for You" with no
    // network; hydration overwrites it, and a title is one line either way.
    title: "w(null)",
    open: "var a=je(e,r);",
    close: 't.warn("top-picks: pool fetch failed: "+o),k()}))',
  }),
};

export const PATCH_WATCH_IT_AGAIN = {
  entry: /watch-it-again/i,
  edits: producerEdits({
    tag: "watch-it-again",
    win: "c",
    api: "e",
    uid: "r",
    find: "ce",
    build: "ie",
    fill: "F",
    insert: "oe",
    container: "_",
    idle: "v",
    apply: "E",
    title: null, // ie() bakes the constant title in
    open: "var a=be(e,r);",
    close: 't.warn("watch-it-again: finished-titles fetch failed: "+i),v()})',
  }),
};

export const PATCH_MY_LIST = {
  entry: /my-list/i,
  edits: producerEdits({
    tag: "my-list",
    win: "s",
    api: "e",
    uid: "r",
    find: "te",
    build: "V",
    fill: "j",
    insert: "$",
    container: "P",
    idle: "p",
    apply: "A",
    title: null, // V() bakes the constant title in
    open: "var n=Ie(e,r);",
    close: 't.warn("my-list: favorites fetch failed: "+l),p()})',
  }),
};

export const PATCHES = [
  PATCH_GATE,
  PATCH_TOP_PICKS,
  PATCH_WATCH_IT_AGAIN,
  PATCH_MY_LIST,
];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      const why =
        hits === 0 && patch.requires
          ? ` — is ${patch.requires} applied first?`
          : "";
      throw new Error(
        `jp820 anchor "${e.what}" matched ${hits} times (want exactly 1)${why}`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The snippets ship to a Chromium-63/V8-6.3 engine — no ES2015+ in our edits.
 *
 * Every insertion is wrapped in a PAIR of `/*jp820*\/` markers, so the added
 * spans are the ODD-indexed split parts (jp745's idiom, and the JELA-681
 * lesson: `.slice(1)` instead would scan the entire rest of the shipped body
 * and trip on unrelated substrings like `class` inside a CSS selector).
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp820*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp820 edit introduced non-ES5 syntax");
  }
}

/** Strip every `/*jp820*\/…/*jp820*\/` span — the rollback pre-image check. */
export function stripAdditions(body) {
  const parts = body.split("/*jp820*/");
  return parts.filter((_, i) => i % 2 === 0).join("");
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp820: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    assertEs5Additions(after);
    if (stripAdditions(after) !== before) {
      throw new Error(
        `jp820: ${hit[0].Name} is not reversible by marker strip`,
      );
    }
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
      console.error(`no jp820 patch for entry "${args.entry}"`);
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
