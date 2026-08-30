#!/usr/bin/env node
/*
 * jsi-jp791-patch.mjs — JELA-791: let the hero chip readers answer from the
 * media-bar's own item store instead of re-reading full bodies per rotation.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone, so the JS-Injector
 * channel IS the source of truth for these snippets. This applies the JELA-791
 * edit as anchored textual patches against the LIVE entry bodies, fail-closed
 * on any anchor that does not match exactly once — same shape and discipline
 * as jsi-jp755-patch.mjs / jsi-jp762-patch.mjs.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * With JELA-762's pool prime armed, the media bar's ENTIRE residual idle cost
 * is one `/Users/{u}/Items/{id}` full-body read (plus its CORS preflight —
 * the URL is unique per item, so the JELA-709 max-age cache never helps) per
 * rotation. The JELA-791 call-site wrap (jp791-attrib.mjs, M63 rig, pool arm)
 * attributed every one of them: each rotation, `hero-runtime` asks
 * `JellyPlug.getItem` for the rotated item (its cb computes the "2h 15m" /
 * "N Seasons" chip), `match-score` asks 4-10 ms later for the same id (its cb
 * scores the hero badge), tizen-compat's jpIWait coalesces the pair, and ONE
 * alias GET leaves the box: 10/10 rotations = hero-runtime 10, match-score 10,
 * ApiClient.getItem dispatches 10, network OPTIONS+GET pairs 10.
 *
 * Both consumers memoize their DERIVED value per item id for the session, so
 * this is a first-seen-item cost: it decays to zero after one full pool cycle
 * (~49 items x ~12 s = ~10 min), costing ~49 alias GETs + ~49 preflights +
 * ~1.3 MB per app session. The waste: the body they need is ALREADY in
 * `slideshowPure.STATE.slideshow.loadedItems` when the slide is built —
 * seeded by the jp762 prime (pool arm) or by fetchItemDetails' own read
 * (control) — and every field either consumer touches is in the jp762
 * projection:
 *
 *   hero-runtime : Type, ChildCount (projected), RunTimeTicks (base)
 *   match-score  : Type, Id, Genres (projected), CommunityRating (base),
 *                  UserData.* (EnableUserData=true)
 *
 * This is the "widen fields, not narrow the consumer" coalesce the JELA-762
 * scope note anticipated: jpICache is NOT seeded with the projection (other
 * consumers want full bodies out of it — that rule stands); instead the two
 * enumerated consumers, whose field needs are verified subsets, consult the
 * pool store FIRST and fall through to their shipped jp317 path on any miss.
 *
 * Fail-open by construction: flag off, store miss, store body without an Id,
 * or any exception -> the shipped path runs verbatim. The mediabar's own
 * favourite toggle deletes the store entry AND invalidates jpICache, so a
 * post-toggle read falls through to a fresh fetch exactly as today. The
 * per-rotation slide pruner only deletes ALREADY-SHOWN items, so the store
 * still holds an item at the moment its slide is built (verified on the rig:
 * all 10 observed rotations answered from the store while it drained behind
 * the rotation index).
 *
 * NOTE: `jellyplug.mediabar.poolFields` (jp762) must stay a SUPERSET of its
 * default `Overview,Genres,RemoteTrailers,ChildCount` — narrowing it below
 * Genres/ChildCount would degrade (not crash) the chip and badge in the
 * pool arm: hero-runtime falls back to RunTimeTicks, match-score's affinity
 * loses genre signal. The default projection satisfies both.
 *
 * Why this matters beyond the ~49 reads: it is the missing half of the
 * JELA-764 flip decision. poolPrefetch's solo A/B was null (13 vs 13) BECAUSE
 * these two consumers kept one network read per rotation alive in both arms.
 * With jp791 armed, the pool arm's rotation cost is the single bulk prime.
 *
 * Dark by default. Nothing changes until `jellyplug.mediabar.heroPoolRead`
 * is "1" in localStorage; `jellyplug.mediabar.heroPoolReadDisabled` is the
 * kill switch reserved for the default-ON flip. Both keys are read per call,
 * so the switch takes effect on the next rotation without a reboot. Every
 * store hit is counted on `window.__jpMB791` ({hr,ms}) so a capture can PROVE
 * which path ran (JELA-690: an arm reporting 0 is discarded).
 *
 * Usage:
 *   node jsi-jp791-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp791-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the pool-store read. */
export const FLAG_KEY = "jellyplug.mediabar.heroPoolRead";
/** Kill switch, reserved for the default-ON flip. */
export const KILL_KEY = "jellyplug.mediabar.heroPoolReadDisabled";
/** Counter bag on window, read over CDP to prove which path ran. */
export const COUNTER_KEY = "__jpMB791";

/*
 * Three helpers, inserted at the top of each patched snippet's IIFE. They take
 * the window as a parameter, so the same text works in both modules regardless
 * of what its IIFE calls it (u/b).
 *
 * jp791F(w)    — is the flag armed (and the kill switch not)? Read per call.
 * jp791P(w,i)  — the media-bar item store lookup: a body with an Id, or null.
 * jp791C(w,k)  — count a store hit on w.__jpMB791 so a capture can prove it.
 */
export const HELPER_SRC =
  "function jp791F(w){try{var l=w.localStorage;return!!(l&&l.getItem(" +
  JSON.stringify(FLAG_KEY) +
  ')==="1"&&l.getItem(' +
  JSON.stringify(KILL_KEY) +
  ')!=="1")}catch(e){return!1}}' +
  "function jp791P(w,i){try{var s=w.slideshowPure&&w.slideshowPure.STATE&&w.slideshowPure.STATE.slideshow," +
  "b=s&&s.loadedItems&&s.loadedItems[i];return b&&b.Id?b:null}catch(e){return null}}" +
  "function jp791C(w,k){try{var c=w." +
  COUNTER_KEY +
  "||(w." +
  COUNTER_KEY +
  "={hr:0,ms:0});c[k]=(c[k]||0)+1}catch(e){}}";

const HELPER = "/*jp791*/" + HELPER_SRC + "/*jp791*/";

/*
 * hero-runtime: window is `u`; the memo is `a`, the in-flight set is `o`,
 * `J` is the jp573 season-count formatter, `T` the runtime formatter. The gate
 * sits between the memo check and the in-flight/network path, and writes the
 * memo exactly as the shipped jp317K does (`a[t]=v||""`), so a store hit and a
 * network hit are indistinguishable downstream.
 */
export const PATCH_HERO_RUNTIME = {
  entry: /hero-runtime$/i,
  edits: [
    {
      what: "hr:helper",
      from: '(function(u){"use strict";var h="jp-runtime"',
      to: '(function(u){"use strict";' + HELPER + 'var h="jp-runtime"',
    },
    {
      what: "hr:gate",
      from: "function s(t,n){if(a.hasOwnProperty(t)){n(a[t]);return}",
      to:
        "function s(t,n){if(a.hasOwnProperty(t)){n(a[t]);return}" +
        "/*jp791*/if(jp791F(u)){var jp791B=jp791P(u,t);if(jp791B){var jp791V=J(jp791B)||T(jp791B.RunTimeTicks);" +
        'a[t]=jp791V||"";jp791C(u,"hr");n(a[t]);return}}/*jp791*/',
    },
  ],
};

/*
 * match-score: window is `b`; the memo is `q`, `y` delivers the taste profile,
 * `le` scores, `t` is the resolved config, `jpEp345` is the jp345 profile
 * epoch. The gate keeps the shipped epoch discipline: the profile wait is
 * re-checked against the epoch captured at call time, and a memo write that
 * raced us wins (same shape as the shipped jp317K). `le` may return null for
 * a non-scorable body — cached and delivered as null, exactly as shipped.
 */
export const PATCH_MATCH_SCORE = {
  entry: /match-score$/i,
  edits: [
    {
      what: "ms:helper",
      from: '(function(b){"use strict";',
      to: '(function(b){"use strict";' + HELPER,
    },
    {
      what: "ms:gate",
      from:
        "function k(a,i){if(!a){i(null);return}if(Object.prototype.hasOwnProperty.call(q,a)){i(q[a]);return}",
      to:
        "function k(a,i){if(!a){i(null);return}if(Object.prototype.hasOwnProperty.call(q,a)){i(q[a]);return}" +
        "/*jp791*/if(jp791F(b)){var jp791B=jp791P(b,a);if(jp791B){var jp791E=jpEp345;y(function(o){" +
        "if(jp791E!==jpEp345)return;if(Object.prototype.hasOwnProperty.call(q,a)){i(q[a]);return}" +
        'var jp791S=le(jp791B,o,t);q[a]=jp791S;jp791C(b,"ms");i(jp791S)});return}}/*jp791*/',
    },
  ],
};

export const PATCHES = [PATCH_HERO_RUNTIME, PATCH_MATCH_SCORE];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp791 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp791*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp791 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp791: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp791 patch for entry "${args.entry}"`);
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
