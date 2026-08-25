#!/usr/bin/env node
/*
 * jsi-jp745-patch.mjs — JELA-745: start the home row queries when the user id
 * exists, not when the DOM goes quiet.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-745 edit as anchored textual patches against the LIVE entry
 * bodies, fail-closed on any anchor that does not match exactly once. Pair it
 * with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline (JELA-107/108,
 * reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * JELA-744 traced the warm home's six serial round-trips to a TWO-STAGE
 * DEBOUNCE CASCADE, not to data:
 *
 *   - `tizen-compat` owns ONE MutationObserver on document.body feeding 62
 *     `onMutation` registrations behind a 100 ms debounce that EVERY mutation
 *     resets. On a fully-warm boot it was scheduled 2,444x, cleared 2,314x
 *     (95% discarded) and fired 130x.
 *   - Each row module then debounces AGAIN, 300 ms, on top of that.
 *
 * So one hop costs >= 400 ms of pure setTimeout latency before the next
 * module's query reaches the wire, and a CPU profile of a round boundary is
 * 91% idle with 38 ms of named JS in a 407 ms window. Nothing runs there.
 *
 * ---------------------------------------------------------------------------
 * Why the fix is this small
 * ---------------------------------------------------------------------------
 * Every module in scope ALREADY calls its own apply function once at load
 * (`q()`, `z()`, `F()`, `X()`, `Z()`), and every one of them ALREADY memoizes
 * its fetch in a module-level latch:
 *
 *   watch-it-again  U  = be(api,uid)     apply q()
 *   top-picks       _  = je(api,uid)     apply z()
 *   my-list         E  = Ie(api,uid)     apply F()
 *   top10-badges    T  = Ue(api,...)     apply X()   (keyed on `pe`)
 *   genre-rows      $  one-shot guard    apply Z()
 *
 * That load-time call does NOT fetch, for one reason only: at load time
 * `ApiClient.getCurrentUserId()` is still null, so the apply bails before it
 * reaches the latch. The query then waits for the debounce cascade to call the
 * apply again — which is the 400 ms-per-hop serialization.
 *
 * So the whole change is: call each module's OWN apply once more, at the first
 * moment `getCurrentUserId()` returns a value. The latch then holds the
 * in-flight promise, and the debounced apply that runs later — UNCHANGED —
 * mounts whatever that promise resolved. FETCH is decoupled from MOUNT without
 * touching either one.
 *
 * The debounce is deliberately NOT removed. Removing it would only make the
 * 62-callback sweep run more often (JELA-744, AC2).
 *
 *   PATCH_STORE   (tizen-compat) install `JellyPlug.rowPrefetch`: a shared
 *                                one-shot arming primitive, sibling of
 *                                `JellyPlug.genreBulk` from JELA-738.
 *   PATCH_AGAIN   (watch-it-again)
 *   PATCH_PICKS   (top-picks)
 *   PATCH_MYLIST  (my-list)
 *   PATCH_GENRES  (genre-rows)     arm that module's apply with the store.
 *   PATCH_TOP10   (top10-badges)   defined, tested, and HELD BACK — see the
 *                                  comment on PATCHES for the measured reason.
 *
 * ---------------------------------------------------------------------------
 * Why the mount cannot break, and why a row cannot go missing
 * ---------------------------------------------------------------------------
 * The armed call is the module's own apply, entered through the module's own
 * route guard, with no arguments and no new state. Three consequences:
 *
 *   - Off the home route, every apply short-circuits on its first line, so an
 *     early arm on a deep link fetches nothing. Same as today.
 *   - The mount half is idempotent by construction — it is what the 300 ms
 *     debounce already calls dozens of times per boot. An early call that
 *     finds no container simply returns, exactly as the load-time call does.
 *   - The user id we arm on is read from `ApiClient.getCurrentUserId()`, the
 *     SAME source each apply reads. There is no second id to disagree with.
 *     If the user changes later, each module's shipped user-change branch
 *     (`jpUid!==r && ... latch=null`) resets and refetches, untouched.
 *
 * A failed or rejected prefetch costs exactly what today's boot costs: the
 * module's own error branch clears its latch and the debounced apply refetches.
 *
 * ---------------------------------------------------------------------------
 * Not in scope: match-score
 * ---------------------------------------------------------------------------
 * JELA-745's table lists match-score's profile queries, but match-score is NOT
 * serialized the way the five row modules are. Its apply (`ge`) is purely
 * decorative — `ve`/`ye`/`me` walk focused cards, hero slides and the detail
 * page — and the profile fetch `w()` is reached only lazily, through `k(id,cb)`
 * when a card actually needs a score. Arming `ge` early therefore issues NO
 * request; issuing one would mean calling `y()` directly, which converts a
 * demand-driven fetch into an unconditional one on every boot. That is a
 * behaviour change, not a decoupling, so it is left alone — as is the genuine
 * two-hop `jpGo625` chain (Episode play history -> SeriesIds -> Items?Ids=).
 *
 * Dark by default. Nothing changes until `jellyplug.rows.prefetch` is `"1"` in
 * localStorage: with the flag off `arm()` returns false before registering, no
 * timer is created, and every module runs verbatim.
 *
 * Composes with jsi-jp682-patch.mjs and jsi-jp738-patch.mjs in ANY order — all
 * three touch disjoint regions (jp682/jp738 rewrite the /Genres name->id
 * resolution; jp745 only adds a second call to an apply that already exists)
 * and each is independently fail-closed.
 *
 * Usage:
 *   node jsi-jp745-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp745-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the whole patch. */
export const FLAG_KEY = "jellyplug.rows.prefetch";

/**
 * Poll step and ceiling for "has a user id appeared yet".
 *
 * On a warm boot the id resolves ~2.2-2.5 s in and the modules load ~1-1.5 s
 * in, so the common case is ~20-30 polls of one property read. The ceiling
 * exists for the pre-auth case (login screen, no session): the poll gives up
 * after MAX_POLLS * POLL_MS and never rearms, so a logged-out client cannot
 * spin. Both numbers are small against the cascade this replaces — JELA-744
 * measured 2,444 schedulings of the 100 ms debounce alone on ONE boot.
 */
export const POLL_MS = 50;
export const MAX_POLLS = 200;

/*
 * The store, as it is injected into tizen-compat. `s` is window and `n` is the
 * JellyPlug namespace in that snippet's IIFE.
 *
 * `arm(key, fn)` registers a module's own apply. `fn` is invoked at most once
 * per user id, as soon as `ApiClient.getCurrentUserId()` is non-empty — which
 * may be immediately, if the id already resolved before the module loaded.
 *
 * Notes on the shape:
 *   - `on()` is checked in `arm` AND in `pump`, so with the flag off nothing
 *     is registered and no timer is ever created.
 *   - a duplicate key is refused, so a module that somehow runs twice cannot
 *     double-fetch.
 *   - a returned promise gets a no-op rejection handler attached. The apply
 *     already has its own handler; this only stops the prefetch's reference
 *     from surfacing as an unhandled rejection on engines that report them.
 *   - `stats()` exists so a rig capture can prove the lever fired rather than
 *     inferring it from timing (JELA-699: a lever that never fired reads as a
 *     null result).
 */
export const ROW_PREFETCH_SRC =
  "(function(){" +
  'var F="' +
  FLAG_KEY +
  '",ST=' +
  POLL_MS +
  ",MX=" +
  MAX_POLLS +
  ",R=[],H=null,tr=0,fired=0;" +
  'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}' +
  "function uid(){try{var a=s.ApiClient;" +
  'return a&&a.getCurrentUserId?String(a.getCurrentUserId()||""):""}catch(e){return""}}' +
  "function run(u){for(var i=0;i<R.length;i++){var r=R[i];" +
  "if(r.uid===u)continue;" +
  "r.uid=u;fired++;" +
  "var p=null;try{p=r.fn(u)}catch(e){p=null}" +
  'if(p&&typeof p.then=="function")try{p.then(null,function(){})}catch(e2){}}}' +
  "function pump(){H=null;if(!on())return;" +
  "var u=uid();if(u){run(u);return}" +
  "if(++tr>MX)return;" +
  "try{H=(s.setTimeout||setTimeout)(pump,ST)}catch(e){}}" +
  'function arm(k,fn){if(!on()||typeof fn!="function"||!k)return!1;' +
  "var K=String(k);" +
  "for(var i=0;i<R.length;i++)if(R[i].key===K)return!1;" +
  "R.push({key:K,fn:fn,uid:null});" +
  "var u=uid();if(u){run(u);return!0}" +
  "if(H===null&&tr<=MX)try{H=(s.setTimeout||setTimeout)(pump,0)}catch(e){}" +
  "return!0}" +
  "function stats(){var o={flag:on(),fired:fired,polls:tr,mods:[]};" +
  "for(var i=0;i<R.length;i++)o.mods.push({key:R[i].key,uid:R[i].uid});" +
  "return o}" +
  "return{on:on,arm:arm,stats:stats}})()";

/**
 * One module's arm, as a self-contained expression statement.
 *
 * `win` is that snippet's window binding (they differ: `c`, `s`, `g`, `d`) and
 * `apply` is the module's own apply function. The wrapper returns nothing, so
 * `run()` records no promise for it — the promise lives in the module's latch,
 * which is the point.
 */
function armSrc(win, key, apply) {
  return (
    "/*jp745*/(function(){" +
    "var jpS745=(" +
    win +
    ".JellyPlug&&" +
    win +
    ".JellyPlug.rowPrefetch)||null;" +
    'jpS745&&jpS745.arm("' +
    key +
    '",function(){' +
    apply +
    "()})})();/*jp745*/"
  );
}

// --- tizen-compat: install the shared arming primitive -----------------------
// Anchored on the namespace publication itself, so the store exists the instant
// `window.JellyPlug` does — before any row module can call `arm`.
export const PATCH_STORE = {
  entry: /tizen-compat/i,
  edits: [
    {
      what: "store",
      from: "n.__compatReady=!0,s.JellyPlug=n,",
      to:
        "/*jp745*/n.rowPrefetch=" +
        ROW_PREFETCH_SRC +
        ",/*jp745*/" +
        "n.__compatReady=!0,s.JellyPlug=n,",
    },
  ],
};

/*
 * The five row modules. Each edit is inserted immediately before that module's
 * `onMutation` registration — i.e. at the one place in the snippet where the
 * module has finished defining its apply and is about to hand itself to the
 * debounce cascade. Anchoring on the registration (rather than on the apply
 * definition) is deliberate: if an upstream edit ever moves a module off
 * `onMutation`, this patch fails closed rather than arming a module whose
 * serialization it no longer understands.
 */
export const PATCH_AGAIN = {
  entry: /watch-it-again/i,
  edits: [
    {
      what: "again:arm",
      from: 'function de(){b||fe()}if(t.onMutation)t.onMutation(de,"watch-it-again")',
      to:
        "function de(){b||fe()}" +
        armSrc("c", "watch-it-again", "q") +
        'if(t.onMutation)t.onMutation(de,"watch-it-again")',
    },
  ],
};

export const PATCH_PICKS = {
  entry: /top-picks/i,
  edits: [
    {
      what: "picks:arm",
      from: 'function Ce(){O||Se()}if(t.onMutation)t.onMutation(Ce,"top-picks")',
      to:
        "function Ce(){O||Se()}" +
        armSrc("c", "top-picks", "z") +
        'if(t.onMutation)t.onMutation(Ce,"top-picks")',
    },
  ],
};

export const PATCH_MYLIST = {
  entry: /my-list/i,
  edits: [
    {
      what: "mylist:arm",
      from: 'function ae(){T||ne()}if(t.onMutation)t.onMutation(ae,"my-list")',
      to:
        "function ae(){T||ne()}" +
        armSrc("s", "my-list", "F") +
        'if(t.onMutation)t.onMutation(ae,"my-list")',
    },
  ],
};

export const PATCH_TOP10 = {
  entry: /top10-badges/i,
  edits: [
    {
      what: "top10:arm",
      from: 'function Se(){R||V()}if(r.onMutation)r.onMutation(Se,"top10-badges")',
      to:
        "function Se(){R||V()}" +
        armSrc("g", "top10-badges", "X") +
        'if(r.onMutation)r.onMutation(Se,"top10-badges")',
    },
  ],
};

// genre-rows registers an inline callback rather than a named one, and its
// load-time `Z()` call sits in the same expression — hence the different anchor
// shape. The arm goes BEFORE that expression so `Z` is armed exactly once.
export const PATCH_GENRES = {
  entry: /genre-rows/i,
  edits: [
    {
      what: "genres:arm",
      from: 'if(Z(),n.onMutation)n.onMutation(function(){W()},"genre-rows")',
      to:
        armSrc("d", "genre-rows", "Z") +
        'if(Z(),n.onMutation)n.onMutation(function(){W()},"genre-rows")',
    },
  ],
};

/*
 * PATCH_TOP10 is defined and unit-tested above but is deliberately NOT applied.
 *
 * On a matched warm rig pair (same snapshot, same patched channel, flag the
 * only difference — 282 cards and 18 rows in both arms) arming top10-badges
 * moved its query the WRONG way:
 *
 *   module           flag off   flag on     delta
 *   my-list             3,021     1,577    -1,444
 *   watch-it-again      3,190     1,735    -1,455
 *   top-picks           3,197     1,738    -1,459
 *   genre-rows          5,822     5,532      -290
 *   top10-badges        5,693    12,005    +6,312   <-- worse
 *
 * The mechanism is visible in the snippet: top10's fetch latch is keyed on
 * `pe = j(S()) + ":" + (m()||"")`, where `S()` is a DOM lookup for the source
 * row. Every other module in scope keys its latch on the user id alone. Called
 * before the home has rendered, `S()` answers null, so the early call latches
 * under a key that the real, DOM-present call does not match — and top10 also
 * carries `jpEmpty` / `jp473` "empty result" latches that a premature call can
 * arm. That is a state hazard, not a timing miss, so it is held out rather
 * than shipped dark and hoped for.
 *
 * Investigating that latch (and why genre-rows barely moves) is a follow-up.
 */
export const PATCHES = [
  PATCH_STORE,
  PATCH_AGAIN,
  PATCH_PICKS,
  PATCH_MYLIST,
  PATCH_GENRES,
];

/** Held out of PATCHES; see the comment above. Exported so the guard can pin it. */
export const HELD_BACK = [PATCH_TOP10];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp745 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp745*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp745 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp745: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp745 patch for entry "${args.entry}"`);
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
