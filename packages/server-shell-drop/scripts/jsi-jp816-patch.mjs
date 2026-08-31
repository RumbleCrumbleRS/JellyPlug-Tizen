#!/usr/bin/env node
/*
 * jsi-jp816-patch.mjs — JELA-816: query only the genre rows the home will mount.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-816 edit as anchored textual patches against the LIVE entry
 * body, fail-closed on any anchor that does not match exactly once. Pair it
 * with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline (JELA-107/108,
 * reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes
 * ---------------------------------------------------------------------------
 * The `genre-rows` snippet ships 14 candidate genres (`U` in the entry) and a
 * cap of 8 rows (`O`). Today it fans out ALL 14 `/Users/{u}/Items?Genres=...`
 * queries in one burst, waits for the LAST of them (`G`: `x<f.length`), and
 * only then selects. Selection (`F`) walks the candidates IN ORDER and keeps
 * the first `maxRows` that came back with at least `M` (6) items, so with a
 * healthy library the answer is always "candidates 1-8" and the last 6 queries
 * are pure waste.
 *
 * Measured on the JELA-112 virtual Tizen 5.0 rig against the live shell
 * (JELA-813, 8 of 8 valid boots): 14 genre GETs in a 10 ms burst at t+14.44 s,
 * 8 rows rendered. Surplus in the instrumented boot = Romance, Crime, Mystery,
 * Fantasy, Family, Documentary = 35,532 B, and because they are cross-origin
 * each carries its own CORS preflight => 12 requests per boot, every boot.
 *
 * The edit replaces the all-at-once fan-out with WAVES, keeping the selection
 * function untouched:
 *
 *   wave 1  dispatch the first `maxRows` candidates (8);
 *   settle  when every dispatched query has resolved, run the SHIPPED `F` over
 *           what has come back so far;
 *   short?  if fewer than `maxRows` rows qualified and candidates remain,
 *           dispatch exactly the shortfall and settle again;
 *   done    otherwise mount.
 *
 * Because `F` is order-preserving and is handed the same candidate list, the
 * rendered set is IDENTICAL to today's for any library where the fetched
 * prefix already yields `maxRows` rows — and where it does not, the waves walk
 * further down exactly the same list and land on exactly the same answer as a
 * full fan-out would. The cost is at most the same 14 queries (a library where
 * every candidate is thin), never more, and typically 8.
 *
 * ---------------------------------------------------------------------------
 * Failure modes
 * ---------------------------------------------------------------------------
 * - a query that rejects, or a call site with no promise at all, resolves as
 *   "no items", which does not qualify, which pulls the next candidate in —
 *   i.e. a failure costs one extra query and never costs a row;
 * - `maxRows >= candidates` degenerates to today's single full fan-out;
 * - `maxRows <= 0` mounts nothing after zero queries (today: nothing after 14);
 * - a user switch resets the wave state along with the shipped fetch latch.
 *
 * Latency: the settle gate is the max of 8 concurrent queries instead of the
 * max of 14, so the healthy path cannot be slower than today. A short wave 1
 * costs one extra round trip; the shipped 9 s `jpBusy` watchdog still bounds it.
 *
 * Dark by default. Nothing changes until `jellyplug.rows.genreLazy` is `"1"` in
 * localStorage; `jellyplug.rows.genreLazyDisabled` = `"1"` is the kill switch
 * and wins over the arm key, so a fleet flip can be reversed per device without
 * a redeploy. The armed/disarmed decision is LATCHED at fan-out time (`jpAr816`)
 * so a flag written mid-boot can never mix the two paths.
 *
 * Composes with jsi-jp745-patch.mjs (which re-arms `Z` from the row-prefetch
 * scheduler) and jsi-jp738-patch.mjs (which touches the genre NAME lookup, a
 * different request) — both touch disjoint regions of this entry.
 *
 * ORDER MATTERS against jp815 (row view gate), which wraps this exact fan-out
 * in a deferred thunk and is ALREADY on the live channel entry (it was in the
 * stored config, and not yet in the served `/JavaScriptInjector/public.js`,
 * when this patch was written — see the JSI save off-by-one). jp816's two
 * fan-out anchors are therefore scoped to the loop body, which is identical in
 * both shapes, and the test proves the patch on the jp815-wrapped body. Apply
 * jp816 LAST. Deploy discipline is unchanged: re-fetch the live config and
 * re-run this patcher IMMEDIATELY before the POST, because a config POST
 * replaces every entry and a sibling may have edited one in between.
 *
 * Usage:
 *   node jsi-jp816-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp816-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the wave fan-out. */
export const FLAG_KEY = "jellyplug.rows.genreLazy";
/** Kill switch. Wins over FLAG_KEY, so a flipped fleet can be reversed. */
export const KILL_KEY = "jellyplug.rows.genreLazyDisabled";

/*
 * The wave dispatcher, injected into the `genre-rows` run function next to the
 * state it drives. Names from the live snippet used here:
 *
 *   d   window            f   candidate list        o   maxRows
 *   n   JellyPlug utils   L   items by genre key    A   the selected rows
 *   F   selectRows        Q   titles already on the home (coverage)
 *   V   mount             jpIdle  row-busy release
 *
 * `jpAr816` is the latch: 0 = undecided, 1 = armed (waves), 2 = shipped path.
 * `jpPd816` is incremented for the WHOLE wave before any dispatcher runs, so a
 * call site that resolves synchronously cannot make the wave look settled while
 * its siblings are still queued.
 */
export const WAVE_SRC =
  "var jpNx816=0,jpPd816=0,jpFn816=null,jpAr816=0;" +
  "function jpOn816(){try{var s0=d.localStorage;if(!s0)return!1;" +
  'if(s0.getItem("' +
  KILL_KEY +
  '")==="1")return!1;' +
  'return s0.getItem("' +
  FLAG_KEY +
  '")==="1"}catch(e0){return!1}}' +
  "function jpSnd816(k0){var q0=[],c0=0;" +
  "while(c0<k0&&jpNx816<f.length){q0.push(f[jpNx816]);jpNx816++;c0++}" +
  "if(!c0)return 0;jpPd816+=c0;" +
  "for(var i0=0;i0<c0;i0++)jpFn816(q0[i0]);return c0}" +
  "function jpFin816(e0,s0){A=s0;" +
  'n.log("genre-rows: selected "+A.length+" of "+jpNx816+" fetched, "+f.length+" candidates (jp816).");' +
  "V(e0);jpIdle()}" +
  "function jpG816(e0){if(jpPd816>0)jpPd816--;if(A||jpPd816>0)return;" +
  "var s0=F(f,L,Q(),o);" +
  "if(s0.length<o&&jpNx816<f.length&&jpSnd816(o-s0.length))return;" +
  "jpFin816(e0,s0)}" +
  "function jpWav816(e0,f0){jpFn816=f0;jpNx816=0;jpPd816=0;" +
  "if(!jpSnd816(o))jpFin816(e0,F(f,L,Q(),o))}";

export const PATCH_ROWS = {
  entry: /genre-rows/i,
  edits: [
    // 1) the dispatcher and its state, next to the latch it resets.
    {
      what: "rows:helpers",
      from: "var $=!1,jpBz=!1,jpId=!1,jpFs=null,jpUid=null;",
      to:
        "var $=!1,jpBz=!1,jpId=!1,jpFs=null,jpUid=null;" +
        "/*jp816*/" +
        WAVE_SRC +
        "/*jp816*/",
    },
    // 2) the settle gate. Armed => the wave dispatcher owns the decision;
    //    the shipped "wait for all 14" expression is left byte-identical.
    {
      what: "rows:gate",
      from: "function G(e){A||x<f.length||(A=F(f,L,Q(),o),",
      to:
        "function G(e){/*jp816*/if(jpAr816===1){jpG816(e);return}/*jp816*/" +
        "A||x<f.length||(A=F(f,L,Q(),o),",
    },
    // 3) the fan-out itself: the per-candidate closure becomes a named
    //    dispatcher; the loop that fired all of them becomes wave 1.
    //
    //    Both anchors are scoped to the LOOP and nothing around it, because
    //    jp815 (row view gate) wraps this same region in a deferred `jpF815`
    //    thunk: it inserts between `$=!0;` and `jpBusy()`, and appends after
    //    `(f[a])`. Anchoring on `!$){$=!0;...` or on the `}V(t),ve()` tail
    //    would match the shipped shape only and fail closed on a channel that
    //    already carries jp815 — which the live channel does. Apply jp816
    //    AFTER jp815; the loop text itself is identical in both shapes.
    {
      what: "rows:fanout-open",
      from: "jpBusy();for(var a=0;a<f.length;a++)(function(u){",
      to: "jpBusy();/*jp816*/var jpDs816=function(u){/*jp816*/",
    },
    {
      what: "rows:fanout-close",
      from: ",G(t)})})(f[a])",
      to:
        ",G(t)})/*jp816*/};" +
        "if(jpOn816()){jpAr816=1;jpWav816(t,jpDs816)}" +
        "else{jpAr816=2;for(var a=0;a<f.length;a++)jpDs816(f[a])}/*jp816*/",
    },
    // 4) a user switch drops the wave state with the shipped fetch latch.
    {
      what: "rows:reset",
      from: "$=!1,L={},w={},p={},A=null,x=0,",
      to:
        "$=!1,L={},w={},p={},A=null,x=0," +
        "/*jp816*/jpNx816=0,jpPd816=0,jpFn816=null,jpAr816=0,/*jp816*/",
    },
  ],
};

export const PATCHES = [PATCH_ROWS];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp816 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
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
  const parts = body.split("/*jp816*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp816 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp816: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp816 patch for entry "${args.entry}"`);
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
