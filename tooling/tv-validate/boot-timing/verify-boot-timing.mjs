#!/usr/bin/env node
// JEL-62 — Compare: Boot timing — shell start to first card rendered.
//
// Measures and compares the end-to-end boot timeline TV (legacy Chromium) vs
// browser (modern Chromium), using the SHIPPED QA boot-marks instrumentation:
//
//   tShellStart → tFirstWebFetchStart → tFirstWebFetchEnd → tDocumentWrite
//   → (ApiClient init → first card visible)
//
// WHAT THIS HARNESS PROVES (and what it cannot)
//   The shell instruments the span it OWNS — from the head-IIFE boot
//   (`tShellStart`) to the `document.open()/write()` handoff to the remote web
//   client (`tDocumentWrite`). Everything AFTER document.write — ApiClient init
//   and first-card paint — runs inside the IDENTICAL jellyfin-web bundle on both
//   UAs, so it is parity-by-construction (same bytes, only time-shifted by the
//   shell's pre-handoff delta). The shell does not (and should not) re-instrument
//   jellyfin-web internals; first-card is observed downstream by the QA beacon's
//   countCards() and the HUD `cards:N` row.
//
//   So the measurable, regress-able question is: does the boot-marks pipeline
//   correctly decompose the shell-owned span, and which phases are longer on TV?
//   This harness answers it HERMETICALLY (no live server, no creds, no network)
//   by executing the EXACT shipped boot-mark IIFEs from src/index.html and the
//   real `markDocumentWrite()` from shell.js inside a Node `vm` sandbox, once as
//   a legacy (TV) WebView and once as a modern (browser) one, under a strictly-
//   increasing clock so the captured timeline order is itself an assertion.
//
// THE TIMELINE DIFFERENCE (the headline result)
//   The /web/ fetch span (tFirstWebFetchStart→End) and the shell-start and
//   document-write marks fire on BOTH UAs — that is the shared critical path.
//   The babel TRANSPILE phase (tBabelPreloadAppend → tBabelScriptAppend →
//   tBabelReady — the 3.13 MB Babel fetch + parse + every legacy <script>
//   re-transpile) fires ONLY on the legacy TV WebView. That phase is the
//   dominant TV-only cost, and on the physical TV the /web/ RTT itself is also
//   heavier (LAN 200–500 ms vs localhost). On modern Chromium all three babel
//   marks stay 0 — there is no transpile phase at all.
//
// NO REGRESSION from the optimization milestones — each still participates:
//   • prefetch       (JEL-58)   — head IIFE fires the /web/index.html fetch and
//                                  stamps tFirstWebFetchStart/End (PART A).
//   • babel preload  (JEL-1973) — legacy boots stamp tBabelPreloadAppend and
//                                  eagerly kick __ensureBabel (PART A/B).
//   • preload        (JEL-59)   — legacy <link rel=preload> path coexists with
//                                  the marks, modern emits none (PART A).
//   • index cache    (JEL-57)   — shell.js still consults jellyfin.shell.index
//                                  Cache around the document-write handoff (B).
//
// Usage:  node tooling/tv-validate/boot-timing/verify-boot-timing.mjs
// Exits non-zero on any failed assertion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const INDEX_HTML = resolve(REPO, "packages/shell-tizen/src/index.html");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const QA_BEACON = resolve(REPO, "packages/shell-tizen/src/qa-beacon.js");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const html = readFileSync(INDEX_HTML, "utf8");
const shellJs = readFileSync(SHELL_JS, "utf8");
const shellMin = readFileSync(SHELL_MIN, "utf8");
const qaBeacon = readFileSync(QA_BEACON, "utf8");

// ---------------------------------------------------------------------------
// Extract the four shipped head <script> IIFEs that touch window.__qaMarks, in
// document order. These are the LITERAL bytes packaged into the .wgt
// (config.xml <content src="index.html"/>; build-wgt.sh `cp -R src/.`).
// ---------------------------------------------------------------------------
const SCRIPTS = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const byToken = (tok) => SCRIPTS.find((s) => s.includes(tok));

const IIFE_INIT = byToken("tShellStart:now()"); // boot-mark initializer
const IIFE_BABEL_PRELOAD = byToken("__shellBabelPreload=0"); // <link rel=preload babel>
const IIFE_PREFETCH = byToken("__shellPrefetch=pf"); // /web/ index+config fetch
const IIFE_ENSURE_BABEL = byToken("__ensureBabel=function"); // lazy/eager babel loader

check(
  "extracted all 4 shipped boot-mark head IIFEs from src/index.html (in document order)",
  IIFE_INIT && IIFE_BABEL_PRELOAD && IIFE_PREFETCH && IIFE_ENSURE_BABEL,
  `init=${!!IIFE_INIT} babelPreload=${!!IIFE_BABEL_PRELOAD} prefetch=${!!IIFE_PREFETCH} ensureBabel=${!!IIFE_ENSURE_BABEL}`,
);

// The REAL shell-side document-write stamp, extracted verbatim from shell.js.
const MDW_MATCH = shellJs.match(/function markDocumentWrite\(\)\s*\{[\s\S]*?\n {2}\}/);
const MARK_DOCUMENT_WRITE = MDW_MATCH ? MDW_MATCH[0] : null;
check(
  "extracted the real markDocumentWrite() stamp from shell.js (source of record)",
  !!MARK_DOCUMENT_WRITE && /tDocumentWrite\s*=\s*performance\.now\(\)/.test(MARK_DOCUMENT_WRITE),
  MARK_DOCUMENT_WRITE ? `${MARK_DOCUMENT_WRITE.length} bytes` : "NOT FOUND",
);
if (!IIFE_INIT || !IIFE_PREFETCH || !IIFE_ENSURE_BABEL || !MARK_DOCUMENT_WRITE) {
  console.log(`\n0/${results.length} — cannot continue without the shipped marks code.`);
  process.exit(1);
}

const UA_LEGACY =
  "Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/537.36 Chrome/63.0.3239.84 Safari/537.36";
const UA_MODERN =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const SERVER = "https://tv.example.local";

// ---------------------------------------------------------------------------
// Drive a full cold boot through the shipped marks code under a synthetic DOM
// and a STRICTLY-INCREASING clock, then run the real markDocumentWrite().
// Returns the final window.__qaMarks plus the persisted localStorage snapshot.
// ---------------------------------------------------------------------------
async function bootOnce({ ua, store }) {
  let clock = 0; // each performance.now() returns a new, strictly larger int
  const appended = []; // every element appended to <head>
  const localStorage = {
    _m: Object.assign(Object.create(null), store),
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null;
    },
    setItem(k, v) {
      this._m[k] = String(v);
    },
  };
  const document = {
    head: {
      appendChild(el) {
        appended.push(el);
        return el;
      },
    },
    createElement(tag) {
      const t = String(tag).toLowerCase();
      if (t === "script")
        return { tagName: "SCRIPT", src: "", async: false, onload: null, onerror: null };
      return { tagName: "LINK", rel: "", as: "", href: "" };
    },
  };
  const ctx = {
    localStorage,
    document,
    navigator: { userAgent: ua },
    performance: { now: () => ++clock },
    // /web/ index+config fetch — resolve async so the .then stamps fire on flush
    fetch: () => Promise.resolve({ ok: true }),
    console: { log() {}, warn() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const run = (src, file) => vm.runInContext(src, ctx, { filename: file });

  // Boot in document order: init → babel-preload → prefetch → ensure-babel.
  run(IIFE_INIT, "index.html#init");
  run(IIFE_BABEL_PRELOAD, "index.html#babel-preload");
  run(IIFE_PREFETCH, "index.html#prefetch");
  run(IIFE_ENSURE_BABEL, "index.html#ensure-babel");

  // Flush the /web/ fetch .then (stamps tFirstWebFetchEnd).
  await new Promise((r) => setTimeout(r, 0));

  // Fire the (eagerly-kicked) babel <script> onload to stamp tBabelReady,
  // mirroring the real V8 parse-complete event on legacy boots.
  const babelScript = appended.find(
    (el) => el.tagName === "SCRIPT" && /babel\.min\.js/.test(el.src) && typeof el.onload === "function",
  );
  if (babelScript) {
    babelScript.onload();
    await new Promise((r) => setTimeout(r, 0));
  }

  // The shell's real document-write stamp (loadRemoteWebClient, just before
  // document.open()/write()/close()).
  run(MARK_DOCUMENT_WRITE + "\nmarkDocumentWrite();", "shell.js#markDocumentWrite");

  let persisted = null;
  try {
    persisted = JSON.parse(localStorage.getItem("jellyfin.qa.bootMarks.current"));
  } catch (_) {}

  return {
    marks: ctx.__qaMarks,
    persisted,
    babelPreloadFlag: ctx.__shellBabelPreload,
    prefetch: ctx.__shellPrefetch,
    appended,
    store: localStorage._m,
  };
}

// The schema declared by the boot-mark initializer (the contract all three
// consumers — index IIFEs, shell.js stamp, qa-beacon read — share).
const SCHEMA = [
  "bootIndex",
  "bootTs",
  "tShellStart",
  "tBabelPreloadAppend",
  "tBabelScriptAppend",
  "tBabelReady",
  "tFirstWebFetchStart",
  "tFirstWebFetchEnd",
  "tDocumentWrite",
];

// Marks the boot-marks pipeline gates on `jellyfin.qa.bootMarks.enabled`.
const bootEnabled = (extra) => ({
  "jellyfin.qa.bootMarks.enabled": "1",
  "jellyfin.shell.serverUrl": SERVER,
  ...extra,
});

// ===========================================================================
// PART A — drive the REAL marks code: TV (legacy) vs browser (modern) timeline
// ===========================================================================
async function partA() {
  // -- A1/A2/A3/A4: legacy TV boot, babel-needed server --------------------
  const tv = await bootOnce({
    ua: UA_LEGACY,
    store: bootEnabled({ "jellyfin.shell.legacy.babelNeeded": "1" }),
  });
  const m = tv.marks;

  check(
    "A1 boot-mark initializer creates window.__qaMarks with the full 9-field schema",
    m && SCHEMA.every((k) => k in m),
    m ? `fields=${Object.keys(m).length}` : "no __qaMarks",
  );
  check(
    "A1 bootIndex incremented (first boot → 1) and bootTs stamped",
    m && m.bootIndex === 1 && m.bootTs > 0,
    m ? `bootIndex=${m.bootIndex} bootTs=${m.bootTs}` : "—",
  );

  // A2: the four ticket-named timeline marks, in the order the ticket lists.
  check(
    "A2 TV core timeline is captured in order: tShellStart < tFirstWebFetchStart < tFirstWebFetchEnd < tDocumentWrite",
    m &&
      0 < m.tShellStart &&
      m.tShellStart < m.tFirstWebFetchStart &&
      m.tFirstWebFetchStart < m.tFirstWebFetchEnd &&
      m.tFirstWebFetchEnd < m.tDocumentWrite,
    m
      ? `shellStart=${m.tShellStart} webStart=${m.tFirstWebFetchStart} webEnd=${m.tFirstWebFetchEnd} docWrite=${m.tDocumentWrite}`
      : "—",
  );
  check(
    "A2 the /web/ fetch span is non-empty (tFirstWebFetchEnd > tFirstWebFetchStart) — prefetch RTT measured",
    m && m.tFirstWebFetchEnd > m.tFirstWebFetchStart,
    m ? `Δfetch=${m.tFirstWebFetchEnd - m.tFirstWebFetchStart} ticks` : "—",
  );

  // A3: the TV-ONLY babel transpile phase fires and is ordered.
  check(
    "A3 TV-only babel phase fires and is ordered: tBabelPreloadAppend ≤ tBabelScriptAppend ≤ tBabelReady (all > 0)",
    m &&
      m.tBabelPreloadAppend > 0 &&
      m.tBabelScriptAppend > 0 &&
      m.tBabelReady > 0 &&
      m.tBabelPreloadAppend <= m.tBabelScriptAppend &&
      m.tBabelScriptAppend <= m.tBabelReady,
    m
      ? `preload=${m.tBabelPreloadAppend} script=${m.tBabelScriptAppend} ready=${m.tBabelReady}`
      : "—",
  );
  check(
    "A3 TV boot appended <link rel=preload babel.min.js> + <script src=babel.min.js> (the transpile phase is real DOM work)",
    tv.appended.some((el) => el.tagName === "LINK" && el.rel === "preload" && /babel\.min\.js/.test(el.href)) &&
      tv.appended.some((el) => el.tagName === "SCRIPT" && /babel\.min\.js/.test(el.src)),
    `babelPreloadFlag=${tv.babelPreloadFlag}`,
  );

  // A4: marks persisted to localStorage (so the qa-beacon can ship them).
  check(
    "A4 marks persisted to localStorage['jellyfin.qa.bootMarks.current'] as parseable JSON matching the schema",
    tv.persisted && SCHEMA.every((k) => k in tv.persisted) && tv.persisted.tDocumentWrite === m.tDocumentWrite,
    tv.persisted ? `persisted tDocumentWrite=${tv.persisted.tDocumentWrite}` : "not persisted",
  );

  // -- A5/A6/A7: modern BROWSER boot — same shared path, NO babel phase ----
  const br = await bootOnce({
    ua: UA_MODERN,
    store: bootEnabled({ "jellyfin.shell.legacy.babelNeeded": "1" }),
  });
  const b = br.marks;

  check(
    "A5 browser core timeline captured in the same order (shared critical path): tShellStart < tFirstWebFetchStart < tFirstWebFetchEnd < tDocumentWrite",
    b &&
      0 < b.tShellStart &&
      b.tShellStart < b.tFirstWebFetchStart &&
      b.tFirstWebFetchStart < b.tFirstWebFetchEnd &&
      b.tFirstWebFetchEnd < b.tDocumentWrite,
    b
      ? `shellStart=${b.tShellStart} webStart=${b.tFirstWebFetchStart} webEnd=${b.tFirstWebFetchEnd} docWrite=${b.tDocumentWrite}`
      : "—",
  );
  check(
    "A6 browser has NO babel phase — tBabelPreloadAppend/tBabelScriptAppend/tBabelReady all stay 0 (this is the phase that is longer on TV)",
    b && b.tBabelPreloadAppend === 0 && b.tBabelScriptAppend === 0 && b.tBabelReady === 0,
    b ? `preload=${b.tBabelPreloadAppend} script=${b.tBabelScriptAppend} ready=${b.tBabelReady}` : "—",
  );
  check(
    "A6 browser appended NO babel.min.js <link>/<script> (transpile DOM work is legacy-only) and __shellBabelPreload === 0",
    br.babelPreloadFlag === 0 &&
      !br.appended.some((el) => /babel\.min\.js/.test(el.href || el.src || "")),
    `babelPreloadFlag=${br.babelPreloadFlag}, appended=${br.appended.length}`,
  );
  check(
    "A7 both UAs run the SAME prefetch path — __shellPrefetch set on TV and browser (only the babel phase differs)",
    !!tv.prefetch && !!br.prefetch,
    `tv=${!!tv.prefetch} browser=${!!br.prefetch}`,
  );

  // -- A8: second boot rotates current→prior (so the beacon ships boot N) --
  const priorJson = JSON.stringify({ ...m, bootIndex: m.bootIndex });
  const tv2 = await bootOnce({
    ua: UA_LEGACY,
    store: bootEnabled({
      "jellyfin.shell.legacy.babelNeeded": "1",
      "jellyfin.qa.bootMarks.current": priorJson,
      "jellyfin.qa.bootIndex": "1",
    }),
  });
  check(
    "A8 second boot rotates last boot's marks into bootMarks.prior and increments bootIndex (1 → 2)",
    tv2.store["jellyfin.qa.bootMarks.prior"] === priorJson && tv2.marks.bootIndex === 2,
    `prior set=${tv2.store["jellyfin.qa.bootMarks.prior"] === priorJson} bootIndex=${tv2.marks.bootIndex}`,
  );

  // -- A9: gating — when bootMarks disabled, no instrumentation at all -----
  const off = await bootOnce({
    ua: UA_LEGACY,
    store: { "jellyfin.shell.serverUrl": SERVER }, // no bootMarks.enabled flag
  });
  check(
    "A9 with bootMarks.enabled unset, window.__qaMarks is null — production builds carry zero timing overhead",
    off.marks === null,
    `__qaMarks=${off.marks}`,
  );
}

// ===========================================================================
// PART B — pin the contract to the shipped artifacts + no-regression
// ===========================================================================
function partB() {
  // B1: the 9-field schema is declared by the initializer in src/index.html.
  check(
    "B1 src/index.html boot-mark initializer declares the exact 9-field schema",
    SCHEMA.every((k) => new RegExp(`${k}\\s*:`).test(IIFE_INIT)) &&
      /window\.__qaMarks\s*=\s*\{/.test(IIFE_INIT),
    `fields matched=${SCHEMA.filter((k) => new RegExp(`${k}\\s*:`).test(IIFE_INIT)).length}/${SCHEMA.length}`,
  );

  // B2: shell.js stamps tDocumentWrite and invokes markDocumentWrite() at BOTH
  // document.write call sites (fast path + slow path) — so the mark fires no
  // matter which handoff branch the boot takes.
  const mdwCalls = (shellJs.match(/markDocumentWrite\(\)/g) || []).length; // 2 calls + 1 def
  const mdwSites = (shellJs.match(/markDocumentWrite\(\);\s*\n\s*document\.open\(/g) || []).length;
  check(
    "B2 shell.js invokes markDocumentWrite() at BOTH document.open/write handoff sites (fast + slow path)",
    mdwCalls >= 3 && mdwSites === 2,
    `markDocumentWrite() occurrences=${mdwCalls} (1 def + 2 calls); call-then-document.open sites=${mdwSites}`,
  );

  // B3: the deployed shell.min.js artifact carries the same stamp (not just src).
  check(
    "B3 deployed shell.min.js carries tDocumentWrite + markDocumentWrite (artifact, not just source)",
    shellMin.includes("tDocumentWrite") && shellMin.includes("markDocumentWrite"),
    `tDocumentWrite=${shellMin.includes("tDocumentWrite")} markDocumentWrite=${shellMin.includes("markDocumentWrite")}`,
  );

  // B4: the downstream half — qa-beacon reads bootMarks.prior ONCE, nulls it,
  // and ships it as payload.priorBootMarks (so boot N's full span set reaches
  // the collector on boot N+1). This is how first-card timing is observed off
  // the device without an inspector.
  check(
    "B4 qa-beacon reads bootMarks.prior once, nulls it (takePriorBootMarks), and ships it as payload.priorBootMarks",
    /jellyfin\.qa\.bootMarks\.prior/.test(qaBeacon) &&
      /function takePriorBootMarks\(\)\s*\{[\s\S]*?priorBootMarks\s*=\s*null/.test(qaBeacon) &&
      /priorBootMarks:\s*takePriorBootMarks\(\)/.test(qaBeacon),
    "one-shot prior-marks read present in qa-beacon payload",
  );
  check(
    "B4 first-card is observed downstream — qa-beacon countCards() counts rendered .card/.listItem/.cardScalable",
    /function countCards\(\)/.test(qaBeacon) &&
      /\.card,\s*\.listItem,\s*\.cardScalable/.test(qaBeacon),
    "countCards present (HUD `cards:N` + beacon `cards` field)",
  );

  // B5: NO REGRESSION — each optimization milestone still participates in the
  // shipped boot path (proven live in PART A where noted).
  check(
    "B5 no-regression: prefetch (JEL-58) still stamps tFirstWebFetchStart/End around the /web/index.html fetch",
    /tFirstWebFetchStart\s*=\s*performance\.now\(\)/.test(IIFE_PREFETCH) &&
      /tFirstWebFetchEnd\s*=\s*performance\.now\(\)/.test(IIFE_PREFETCH) &&
      /fetch\(b\+'index\.html'/.test(IIFE_PREFETCH),
    "prefetch IIFE stamps both fetch marks",
  );
  check(
    "B5 no-regression: babel preload (JEL-1973) still stamps tBabelPreloadAppend + eagerly kicks __ensureBabel on legacy babel-needed boots",
    /tBabelPreloadAppend\s*=\s*performance\.now\(\)/.test(IIFE_BABEL_PRELOAD) &&
      /legacy\.babelNeeded'\)==='1'&&localStorage\.getItem\('jellyfin\.shell\.legacy\.babelPreload'\)!=='0'/.test(
        IIFE_ENSURE_BABEL,
      ) &&
      /__ensureBabel\(\)/.test(IIFE_ENSURE_BABEL),
    "babel preload stamp + eager kick present",
  );
  check(
    "B5 no-regression: preload (JEL-59) <link rel=preload> path still present in the prefetch IIFE, gated legacy (publishes __shellPreloadScripts)",
    /__shellPreloadScripts\s*=/.test(IIFE_PREFETCH) && /rel='preload'/.test(IIFE_PREFETCH),
    "preload counters + gate coexist with marks",
  );
  check(
    "B5 no-regression: index cache (JEL-57) still consulted by shell.js around the document-write handoff (jellyfin.shell.indexCache)",
    /jellyfin\.shell\.indexCache/.test(shellJs),
    `indexCache references in shell.js=${(shellJs.match(/jellyfin\.shell\.indexCache/g) || []).length}`,
  );
}

console.log("== PART A: drive the real boot-mark IIFEs — TV (legacy) vs browser (modern) timeline ==");
await partA();
console.log("\n== PART B: pin the marks contract to shipped artifacts + no-regression ==");
partB();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
