#!/usr/bin/env node
/*
 * jsi-jp856-patch.mjs — JELA-856 (injector half): stop the JELA-110/542
 * media-bar "0 ms probe" re-downloading a `no-store` /web/index.html the
 * shell already holds.
 *
 * ---------------------------------------------------------------------------
 * The defect
 * ---------------------------------------------------------------------------
 * On a steady-state boot with hero history (`jp:mediabar:seen:<uid>==='1'`),
 * `T()` in the `JellyPlug — media-bar` channel entry XHRs the WHOLE server
 * `/web/index.html` purely to test whether hero assets are present, so it can
 * dispatch `jp:mediabar-expected` and let `mediabar-guard` reserve the
 * billboard offset pre-mount. Measured on the JELA-112 M63 rig, and
 * reproduced on the JELA-843/846 census captures (L-boot, L3, L4, L5, WBON,
 * WBOFF), the probe's own console line tracks the request count exactly:
 *
 *   boot 1 (fresh profile, key absent, line not emitted)  -> 1 request
 *   boot 2 (steady state,  key '1',   line emitted)       -> 2 requests
 *
 * 20,406 B per steady-state boot, pre-first-card. `/web/index.html` is served
 * `cache-control: no-cache, no-store, must-revalidate` + `expires: -1`, so no
 * HTTP cache can ever coalesce that second copy — this is a real-panel cost,
 * not a rig artifact. And the body is already in memory AND on disk: the
 * shell resolved that exact document this boot (JEL-1977 localStorage body
 * cache, `jellyfin.shell.webIndexHtml`) and document.wrote the SPA from it.
 *
 * ---------------------------------------------------------------------------
 * The fix
 * ---------------------------------------------------------------------------
 * The shell half (merged separately, dark on its own) publishes the RAW
 * resolved body and the origin it belongs to before document.write:
 *
 *   window.__shellWebIndexHtml    // byte-identical to what the XHR returns
 *   window.__shellWebIndexOrigin  // the server URL that body came from
 *
 * This patch teaches `A()` — the module's single XHR helper — to answer from
 * that global when it is present and its origin resolves to the URL being
 * requested, and to fall through to the XHR exactly as today otherwise.
 *
 * WHY `A()` AND NOT `T()`. `A()` is the choke point; `T()` is only the
 * culprit that showed up in the capture (JELA-854's rule). The other caller,
 * `D()`, is the recovery path that re-delivers hero assets when the JS is
 * missing entirely — it fetches the SAME document for the SAME reason and
 * gets the same saving for free. Patching `T()` would leave `D()` re-fetching
 * a `no-store` document on exactly the boots that are already degraded.
 *
 * TWO PROPERTIES THE CALLBACK MUST KEEP, or this regresses JELA-110:
 *
 *   1. It must stay ASYNCHRONOUS. `T()`'s callback dispatches
 *      `jp:mediabar-expected`, and the listener for it is registered by the
 *      SEPARATE `mediabar-guard` entry, which sits AFTER media-bar in the
 *      channel document. A synchronous `r(body)` would dispatch the event
 *      before the guard's listener exists, silently killing the pre-mount
 *      reservation — the exact thing AC2 protects. So the cached answer is
 *      handed back through setTimeout(...,0): a task boundary, like the XHR
 *      it replaces, with none of the bytes.
 *
 *   2. It must be the RAW body. The shell publishes pre-rewrite bytes on
 *      purpose; `y()` scans for <link rel=stylesheet href=…slideshowpure…>
 *      and media-bar <script> tags, and the shell's own media-bar CDN strip
 *      (jp716/JELA-716) removes one of those very tags from the document it
 *      writes. Scanning the rewritten copy would change the verdict.
 *
 * Origin match is done by resolving BOTH sides through the module's existing
 * `c()` helper (an <a>.href round trip), so the comparison is between two
 * canonicalized absolute URLs rather than two hand-built strings that could
 * differ by a trailing slash, a default port, or case. Any mismatch — a
 * different server, a stale global, a non-Tizen client with no global at all
 * — takes the XHR path, unchanged.
 *
 * Diag, so the ON arm can prove the lever fired (perf-protocol rule 4):
 * `window.__jpMB856` counts cache-served answers this boot; it stays
 * undefined when the path never fires.
 *
 * ---------------------------------------------------------------------------
 * Rollback
 * ---------------------------------------------------------------------------
 * Per-TV, no deploy: `localStorage["jellyplug.mediabar.jp856Off"]="1"` — the
 * kill switch is tested FIRST, before the global is even read, so a killed TV
 * is byte-for-byte on today's path. Fleet-wide: `--rollback` removes the
 * added region between the paired `/*jp856*\/` markers, restoring the shipped
 * `A()` exactly.
 *
 * Deploy discipline is unchanged and non-negotiable: a config POST replaces
 * EVERY entry, so re-fetch the live config and re-run this patcher IMMEDIATELY
 * before the POST (jsi-config-write-race), then POST until the SERVED bundle
 * carries the marker (jsi-config-save-off-by-one — the count is not fixed at
 * two, and a server restart is also a rebuild).
 *
 * Usage:
 *   node jsi-jp856-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp856-patch.mjs --config <cfg.json> --out <cfg.json> --rollback
 *   node jsi-jp856-patch.mjs --entry "JellyPlug — media-bar" --in body.js --out out.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

export const OFF_KEY = "jellyplug.mediabar.jp856Off";
export const HTML_GLOBAL = "__shellWebIndexHtml";
export const ORIGIN_GLOBAL = "__shellWebIndexOrigin";
export const DIAG_GLOBAL = "__jpMB856";

// The shipped head of the module's only XHR helper. Anchoring on the head (and
// re-emitting it verbatim) means the XHR fallback below is untouched bytes.
const A_HEAD =
  "function A(e,r){try{var i=a.XMLHttpRequest;if(!i){r(null);return}";

// Everything between the paired markers is what --rollback removes.
const A_CACHE_BRANCH =
  "/*jp856*/" +
  "try{" +
  // Kill switch first: a killed TV never even reads the globals.
  'if(!(a.localStorage&&a.localStorage.getItem("' +
  OFF_KEY +
  '")==="1")){' +
  "var jp856h=a." +
  HTML_GLOBAL +
  ",jp856o=a." +
  ORIGIN_GLOBAL +
  ";" +
  'if(typeof jp856h=="string"&&jp856h.length&&typeof jp856o=="string"&&jp856o.length' +
  // c() canonicalizes both sides through <a>.href, so the comparison cannot
  // fail on a trailing slash / default port / case difference.
  '&&c(String(jp856o).replace(/\\/+$/,"")+"/web/index.html")===c(String(e))){' +
  "a." +
  DIAG_GLOBAL +
  "=(a." +
  DIAG_GLOBAL +
  "||0)+1;" +
  // MUST stay async: T()'s callback dispatches jp:mediabar-expected and
  // mediabar-guard registers its listener from a LATER channel entry.
  "(a.setTimeout||setTimeout)(function(){r(jp856h)},0);" +
  "return}}" +
  "}catch(jp856e){}" +
  "/*jp856*/";

export const PATCH = {
  entry: /^JellyPlug — media-bar$/,
  edits: [
    {
      what: "xhr-prefer-shell-index",
      from: A_HEAD,
      to:
        "function A(e,r){" +
        A_CACHE_BRANCH +
        A_HEAD.slice("function A(e,r){".length),
    },
  ],
};

/** Apply the patch. Throws unless the anchor matches exactly once. */
export function applyPatch(body) {
  let out = body;
  for (const e of PATCH.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp856 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * Byte-level inverse: drop the marked region. Not a re-derivation of the
 * shipped text — whatever sat outside the markers is what comes back, so a
 * concurrent writer's unrelated edit to this entry survives a rollback.
 */
export function rollbackPatch(body) {
  const parts = body.split("/*jp856*/");
  if (parts.length !== 3) {
    throw new Error(
      `jp856 rollback: expected exactly 2 markers, found ${parts.length - 1}`,
    );
  }
  return parts[0] + parts[2];
}

export function isPatched(body) {
  return body.split("/*jp856*/").length - 1 === 2;
}

/**
 * The channel runs on Tizen 5.0 / Chromium 63 / V8 6.3, which throws at PARSE
 * on ES2020+ (and on ES2019 optional-catch-binding) — a syntax error here
 * does not degrade the feature, it kills the whole channel document for every
 * entry after it. Only the region we add is checked; the surrounding vendored
 * body is not ours to police.
 */
export function assertNoModernAdditions(body) {
  const parts = body.split("/*jp856*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/\?\.|\?\?|catch\s*\{|=>|`/.test(added)) {
    throw new Error("jp856 edit introduced ES2019+ syntax");
  }
}

export function patchConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts || [];
  const hit = entries.filter((e) => PATCH.entry.test(e.Name || ""));
  if (hit.length !== 1) {
    throw new Error(
      `jp856: ${PATCH.entry} matched ${hit.length} channel entries (want 1)`,
    );
  }
  const before = hit[0].Script || "";
  if (rollback && !isPatched(before)) {
    throw new Error("jp856 rollback: entry is not patched");
  }
  if (!rollback && isPatched(before)) {
    throw new Error("jp856: entry is already patched");
  }
  const after = rollback ? rollbackPatch(before) : applyPatch(before);
  assertNoModernAdditions(after);
  new vm.Script(after, { filename: `${hit[0].Name}.js` });
  hit[0].Script = after;
  return [{ name: hit[0].Name, delta: after.length - before.length }];
}

function parseArgs(argv) {
  const a = { config: null, out: null, in: null, entry: null, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--config") a.config = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--in") a.in = argv[++i];
    else if (k === "--entry") a.entry = argv[++i];
    else if (k === "--rollback") a.rollback = true;
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
    for (const r of patchConfig(cfg, { rollback: args.rollback })) {
      console.error(`ok  ${r.name}  ${r.delta >= 0 ? "+" : ""}${r.delta} B`);
    }
    writeFileSync(args.out, JSON.stringify(cfg, null, 2));
  } else if (args.in && args.entry) {
    if (!PATCH.entry.test(args.entry)) {
      console.error(`no jp856 patch targets entry "${args.entry}"`);
      process.exit(2);
    }
    const body = readFileSync(args.in, "utf8");
    const after = args.rollback ? rollbackPatch(body) : applyPatch(body);
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
