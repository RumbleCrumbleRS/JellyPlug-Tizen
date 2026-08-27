#!/usr/bin/env node
/*
 * jsi-jp755-patch.mjs — JELA-755: stop the row modules re-fetching on every
 * Back-to-home navigation.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone, so the JS-Injector
 * channel IS the source of truth for these snippets. This applies the JELA-755
 * edit as anchored textual patches against the LIVE entry bodies, fail-closed
 * on any anchor that does not match exactly once — same shape and discipline
 * as jsi-jp682-patch.mjs / jsi-jp738-patch.mjs.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * JELA-753 made the home survive a Back press (rows are MOVED, not rebuilt),
 * but a Back press still costs ~30 requests, ~22 of them `/Users/{u}/Items`
 * GETs + their CORS preflights, all pure re-fetch: the card count is
 * identical before and after (JELA-755 capture: 266→266, 282→282, 250→250).
 *
 * They fire because of jp305 ("revalidate on home re-entry"): four modules
 * deliberately CLEAR their module-level fetch latch on any hashchange that
 * lands on the home route:
 *
 *   my-list          jp5n&&!jp5h&&(B=!1,E=null)        1 GET per re-entry
 *   watch-it-again   jp5n&&!jp5h&&(K=!1,U=null)        3 GETs per re-entry
 *   top-picks        jp5n&&!jp5h&&(j=!1,M=!1,_=null)   1 GET (83 KB)
 *   match-score      jpRst345("home re-entry")         4+1 GETs (taste profile
 *                                                      + the jp625 Ids= merge)
 *   home-resume-left jpForget() on EVERY hashchange    1 GET (60-id Ids= batch)
 *
 * jp305 predates the jp348/jp477 dirty signal. Today the first three modules
 * ALSO register `JellyPlug.onUserData`, which resets the same latch when a
 * favourite is toggled, an item is (un)marked played, or the server pushes a
 * `UserDataChanged` socket message (tizen-compat wraps updateFavoriteStatus /
 * markPlayed / markUnplayed AND taps ApiClient._webSocket, re-tapped every
 * 5 s). So the unconditional home-re-entry reset buys no freshness those
 * modules do not already have — it only re-buys the same bytes on every
 * Back press.
 *
 * The edit: gate the jp305 reset behind the `jellyplug.rows.navkeep` flag.
 *   - Flag absent/off: shipped behaviour, byte-for-byte the same resets.
 *   - Flag "1": the latch survives home re-entry; freshness comes from the
 *     dirty signal alone. match-score, the one module of the four with NO
 *     onUserData registration, gets one (flag-gated) so its taste profile
 *     still rebuilds after real user-data changes rather than never.
 *
 * Every gate decision is counted on `window.__jp755` per module
 * ({kept,reset}), so a capture can PROVE which path ran (JELA-690: an arm
 * reporting 0 is discarded, AC5).
 *
 * Kill switch: remove the flag (or set anything but "1"). The flag is read
 * per event, so the switch takes effect on the next navigation without a
 * reboot, and the OFF path is the shipped code verbatim.
 *
 * Explicitly NOT touched (freshness policy per module, AC4):
 *   - my-list / watch-it-again / top-picks: onUserData reset (shipped) stays.
 *   - match-score: gains the same onUserData reset (flag-gated).
 *   - user-switch resets (uid latch keys / jpChk345) stay in all modules.
 *   - new-badge keeps its 5-minute TTL decision cache — its data (DateCreated)
 *     does not change with user actions, and its batch only re-fires when the
 *     TTL lapses, not on every navigation.
 *
 * Usage:
 *   node jsi-jp755-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp755-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the whole patch. */
export const FLAG_KEY = "jellyplug.rows.navkeep";

/*
 * Two helpers, inserted at the top of each patched snippet's IIFE (right after
 * its "use strict"). They take the window as a parameter, so the same text
 * works in every module regardless of what its IIFE calls it (s/c/b).
 *
 * jpOn755(w)    — is the flag armed? Read per call: the kill switch works on
 *                 the NEXT navigation, no reboot.
 * jpNK755(w,n)  — the gate. Counts the decision on w.__jp755[n] either way
 *                 ({kept,reset}) so a capture can prove which path ran, then
 *                 answers "keep the latch?".
 */
export const HELPER_SRC =
  "function jpOn755(w){try{return!!(w.localStorage&&w.localStorage.getItem(" +
  JSON.stringify(FLAG_KEY) +
  ')==="1")}catch(e){return!1}}' +
  "function jpNK755(w,n){var s=w.__jp755||(w.__jp755={}),m=s[n]||(s[n]={kept:0,reset:0});" +
  "return jpOn755(w)?(m.kept++,!0):(m.reset++,!1)}";

const HELPER = "/*jp755*/" + HELPER_SRC + "/*jp755*/";

// --- my-list: window is `s`; latch is (B, E) --------------------------------
export const PATCH_MY_LIST = {
  entry: /my-list$/i,
  edits: [
    { what: "mylist:helper", from: '"use strict";', to: '"use strict";' + HELPER },
    {
      what: "mylist:gate",
      from: "jp5n&&!jp5h&&(B=!1,E=null),jp5h=jp5n,F()",
      to:
        "jp5n&&!jp5h&&/*jp755*/!jpNK755(s,\"my-list\")&&/*jp755*/(B=!1,E=null),jp5h=jp5n,F()",
    },
  ],
};

// --- watch-it-again: window is `c`; latch is (K, U) -------------------------
export const PATCH_WATCH_IT_AGAIN = {
  entry: /watch-it-again$/i,
  edits: [
    { what: "wia:helper", from: '"use strict";', to: '"use strict";' + HELPER },
    {
      what: "wia:gate",
      from: "jp5n&&!jp5h&&(K=!1,U=null),jp5h=jp5n,q()",
      to:
        "jp5n&&!jp5h&&/*jp755*/!jpNK755(c,\"watch-it-again\")&&/*jp755*/(K=!1,U=null),jp5h=jp5n,q()",
    },
  ],
};

// --- top-picks: window is `c`; latch is (j, M, _) ---------------------------
export const PATCH_TOP_PICKS = {
  entry: /top-picks$/i,
  edits: [
    { what: "picks:helper", from: '"use strict";', to: '"use strict";' + HELPER },
    {
      what: "picks:gate",
      from: "jp5n&&!jp5h&&(j=!1,M=!1,_=null),jp5h=jp5n,z()",
      to:
        "jp5n&&!jp5h&&/*jp755*/!jpNK755(c,\"top-picks\")&&/*jp755*/(j=!1,M=!1,_=null),jp5h=jp5n,z()",
    },
  ],
};

/*
 * match-score: window is `b`, util namespace is `e`, and the whole taste
 * profile (4 bulk /Users/{u}/Items reads) is torn down by jpRst345 on home
 * re-entry. It is the only module of the four with NO onUserData registration,
 * so gating jp305 alone would freeze the profile for the session. The third
 * edit registers the dirty signal, flag-gated: with the flag on, a favourite
 * toggle / played change / UserDataChanged push rebuilds the profile on the
 * next apply — strictly fresher than the shipped "rebuild on re-entry whether
 * or not anything changed". The registration anchor is the end of the
 * hashchange-listener statement, after jpRst345 and D exist and before the
 * settle timers arm.
 */
export const PATCH_MATCH_SCORE = {
  entry: /match-score$/i,
  edits: [
    { what: "ms:helper", from: '"use strict";', to: '"use strict";' + HELPER },
    {
      what: "ms:gate",
      from: 'jpN&&!jpH345&&jpRst345("home re-entry"),jpH345=jpN,D()',
      to:
        'jpN&&!jpH345&&/*jp755*/!jpNK755(b,"match-score")&&/*jp755*/jpRst345("home re-entry"),jpH345=jpN,D()',
    },
    {
      what: "ms:dirty",
      from: ",!1),D();",
      to:
        ",!1),D();/*jp755*/e.onUserData&&e.onUserData(function(jpW){" +
        'jpOn755(b)&&jpRst345("user data changed ("+jpW+")")},"match-score");/*jp755*/',
    },
  ],
};

/*
 * home-resume-left: window is `s`, util namespace is `e`. Its hashchange
 * handler is blunter than jp305: `jpForget()` wipes the per-id minutes-left
 * decision cache on EVERY hashchange, so the Back press re-reads the whole
 * Continue Watching row in one 60-id `Ids=` batch. Freshness with the flag on
 * comes from (a) a new flag-gated onUserData registration — playback progress
 * arrives as a UserDataChanged socket push, exactly the event that changes a
 * minutes-left label — and (b) the module's own shipped 5-minute TTL
 * (jpSync), which stays untouched as the backstop.
 */
export const PATCH_HOME_RESUME_LEFT = {
  entry: /home-resume-left$/i,
  edits: [
    { what: "hrl:helper", from: '"use strict";', to: '"use strict";' + HELPER },
    {
      what: "hrl:gate",
      from:
        's.addEventListener&&s.addEventListener("hashchange",function(){jpForget(),h()},!1),h();',
      to:
        's.addEventListener&&s.addEventListener("hashchange",function(){/*jp755*/jpNK755(s,"home-resume-left")||jpForget();/*jp755*/h()},!1),h();' +
        '/*jp755*/e.onUserData&&e.onUserData(function(){jpOn755(s)&&jpForget()},"home-resume-left");/*jp755*/',
    },
  ],
};

export const PATCHES = [
  PATCH_MY_LIST,
  PATCH_WATCH_IT_AGAIN,
  PATCH_TOP_PICKS,
  PATCH_MATCH_SCORE,
  PATCH_HOME_RESUME_LEFT,
];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp755 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp755*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp755 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp755: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp755 patch for entry "${args.entry}"`);
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
