#!/usr/bin/env node
/*
 * jsi-jp681-patch.mjs — JELA-681: unblock home first paint.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these two snippets. This
 * applies both JELA-681 edits as anchored textual patches against the LIVE
 * entry bodies, fail-closed on any anchor that does not match exactly once.
 * Pair it with jsi-channel-deploy.mjs's snapshot/gate/rollback discipline
 * (JELA-107/108, reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What JELA-681 actually is
 * ---------------------------------------------------------------------------
 * The ticket's premise was "the home render is gated on the slowest row, so
 * stream rows as their data arrives". Measured on the virtual Tizen 5.0 rig,
 * that premise does not hold and the real gate is one level up:
 *
 *   1. Every `.card[data-id]` on the cold home comes from the JellyPlug
 *      injector rows (8 x jp-genre-row = 160, plus top-picks / watch-it-again /
 *      my-list). The native Home Screen Sections rows contribute ZERO cards.
 *   2. genre-rows dispatches all 14 candidate queries in a single ~20 ms burst
 *      and they come back inside ~46 ms of each other, so there is no per-row
 *      latency spread to stream against. Removing the batch barrier alone
 *      (PATCH_STREAM below, measured) leaves the insert shape unchanged: still
 *      8 rows in one DOM tick.
 *   3. What actually costs ~12 s is WHEN that burst starts. tizen-compat only
 *      installs the shared MutationObserver that drives every row module once
 *      `__shellPaintGate.onPaint` fires (JEL-623), and onPaint waits for a
 *      `.card` to exist. On this home the only things that can produce one are
 *      the very modules being gated — the sole early `.card` is the HSS
 *      Discover card, which carries `data-tmdb-id` and no `data-id`. So the row
 *      modules idle until Discover paints, and firstCard lands ~1.3 s later.
 *
 * Hence two patches, each behind its own flag, both dark by default:
 *
 *   PATCH_EARLY  (tizen-compat, flag `jellyplug.rows.earlyarm`)
 *       Arm the shared mutation dispatcher at `__shellPaintGate.onApi`
 *       (webpack entry done, ApiClient live) instead of `onPaint`. This is the
 *       lever: it removes the circular dependency. JEL-623's protection of the
 *       pre-ApiClient bundle blackout is untouched — onApi is still a gate,
 *       just an earlier one, and the unflagged path is byte-identical.
 *
 *   PATCH_STREAM (genre-rows, flag `jellyplug.genrerows.stream`)
 *       Prefix-commit instead of all-or-nothing. Shipped `G()` injects nothing
 *       until all 14 candidate queries settle, then appends the selected 8 in
 *       one tick. With prefix-commit, candidate i is decided as soon as it has
 *       settled AND every higher-priority candidate has been decided, so the
 *       plan is flushed incrementally. The final DOM is identical by
 *       construction: same candidate order, same eligibility test (>= MIN_ITEMS
 *       and not covered by a native row title), same cap of 8, ranks still
 *       assigned by position in the committed plan. Worthless on its own (see
 *       point 2), but under PATCH_EARLY the burst does spread out and the rows
 *       land across several ticks instead of one.
 *
 * The native-row title snapshot (`Q()`) moves from the all-settled point to the
 * first commit. The HSS section shells are all in the DOM by ~2.5 s, well
 * before any genre query resolves, so it is the same list either way, and
 * `ve()` still re-reconciles coverage on later mutations.
 *
 * Usage:
 *   node jsi-jp681-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp681-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

// --- tizen-compat: arm the shared mutation dispatcher at onApi, not onPaint --
export const PATCH_EARLY = {
  entry: /tizen-compat/i,
  edits: [
    {
      what: "earlyarm",
      from: "},t=s.__shellPaintGate;t&&t.onPaint?t.onPaint(r):r()}}",
      to:
        "},t=s.__shellPaintGate;" +
        '/*jp681*/var jpE=function(){try{return!!(s.localStorage&&s.localStorage.getItem("jellyplug.rows.earlyarm")==="1")}catch(_e){return!1}}();' +
        "if(jpE&&t&&t.onApi){t.onApi(r);return}/*jp681*/" +
        "t&&t.onPaint?t.onPaint(r):r()}}",
    },
  ],
};

// --- genre-rows: prefix-commit instead of all-or-nothing ---------------------
export const PATCH_STREAM = {
  entry: /genre-rows/i,
  edits: [
    {
      what: "state+V+G",
      from:
        'var L={},x=0,A=null;function V(e){if(A){var t=re();if(t.length)for(var i=0;i<t.length;i++){if(t[i].getAttribute&&t[i].getAttribute(ne)==="1")continue;for(var a=0;a<A.length;a++){var u=A[a];n.safe("genre-rows.inject",function(l,c){return function(){fe(l,c.cand,c.items,e,c.rank)}}(t[i],u))}t[i].setAttribute(ne,"1")}}}' +
        'function G(e){A||x<f.length||(A=F(f,L,Q(),o),n.log("genre-rows: selected "+A.length+" of "+f.length+" genres."),V(e),jpIdle())}',
      to:
        "var L={},x=0,A=null;" +
        '/*jp681*/var jpS681=function(){try{return!!(d.localStorage&&d.localStorage.getItem("jellyplug.genrerows.stream")==="1")}catch(_e){return!1}}(),jpDn681={},jpCr681=0,jpNv681=null,jpFin681=!1;/*jp681*/' +
        'function V(e){if(A){var t=re();if(t.length)for(var i=0;i<t.length;i++){if(t[i].getAttribute&&t[i].getAttribute(ne)==="1")continue;for(var a=0;a<A.length;a++){var u=A[a];n.safe("genre-rows.inject",function(l,c){return function(){fe(l,c.cand,c.items,e,c.rank)}}(t[i],u))}' +
        // Sealing the re-entry guard is deferred to the final flush, otherwise
        // the first partial flush would lock every later row out of the container.
        '/*jp681*/if(!jpS681||jpFin681)/*jp681*/t[i].setAttribute(ne,"1")}}}' +
        "/*jp681*/function jpCm681(e){if(jpFin681)return;if(jpNv681===null)jpNv681=Q();A||(A=[]);var jpPre=A.length;" +
        "while(jpCr681<f.length&&A.length<o){var jpCd=f[jpCr681],jpKy=I(jpCd);if(!jpDn681[jpKy])break;jpCr681++;var jpIt=L[jpKy];" +
        "if(!jpIt||jpIt.length<M||T(jpCd.genre,jpNv681))continue;A.push({cand:jpCd,items:jpIt,rank:String(_+A.length)})}" +
        "var jpDone=jpCr681>=f.length||A.length>=o;" +
        'if(A.length>jpPre){n.log("genre-rows: streamed row "+A.length+"/"+o+" after candidate "+jpCr681+"/"+f.length+"."),V(e)}' +
        'if(jpDone){jpFin681=!0,n.log("genre-rows: selected "+A.length+" of "+f.length+" genres (streamed)."),V(e),jpIdle()}}/*jp681*/' +
        'function G(e){/*jp681*/if(jpS681)return jpCm681(e);/*jp681*/A||x<f.length||(A=F(f,L,Q(),o),n.log("genre-rows: selected "+A.length+" of "+f.length+" genres."),V(e),jpIdle())}',
    },
    {
      what: "reset",
      from: "$=!1,L={},w={},p={},A=null,x=0,",
      to: "$=!1,L={},w={},p={},A=null,x=0,/*jp681*/jpDn681={},jpCr681=0,jpNv681=null,jpFin681=!1,/*jp681*/",
    },
    // The commit loop keys off jpDn681, not the x counter, so every settle leg
    // (no-promise, resolve, reject) has to mark its candidate decided.
    {
      what: "settle:none",
      from: "if(!c){L[l]=null,x++,G(t);return}",
      to: "if(!c){L[l]=null,/*jp681*/jpDn681[l]=1,/*jp681*/x++,G(t);return}",
    },
    {
      what: "settle:ok",
      from: "L[l]=/*jp655*/jpFlt655(/*jp655*/J(h)/*jp655*/,u)/*jp655*/,x++,G(t)",
      to: "L[l]=/*jp655*/jpFlt655(/*jp655*/J(h)/*jp655*/,u)/*jp655*/,/*jp681*/jpDn681[l]=1,/*jp681*/x++,G(t)",
    },
    {
      what: "settle:fail",
      from: "L[l]=null,x++,n.warn('genre-rows: fetch failed for \"'",
      to: "L[l]=null,/*jp681*/jpDn681[l]=1,/*jp681*/x++,n.warn('genre-rows: fetch failed for \"'",
    },
  ],
};

export const PATCHES = [PATCH_EARLY, PATCH_STREAM];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp681 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/** The snippets ship to a Chromium-63/V8-6.3 engine — no ES2015+ in our edits. */
export function assertEs5Additions(body) {
  const added = body.split("/*jp681*/").slice(1).join("");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp681 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp681: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
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
      console.error(`no jp681 patch for entry "${args.entry}"`);
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
