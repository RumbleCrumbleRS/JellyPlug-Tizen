#!/usr/bin/env node
// JEL-61 — Compare: QA overlay & boot marks — window.__qaMarks fields populated
// correctly (TV vs browser), persisted to localStorage and rotated next boot.
//
// What the ticket asks us to confirm, with the QA overlay + boot marks enabled
// (jellyfin.qa.overlay='1', jellyfin.qa.bootMarks.enabled='1'):
//   (1) window.__qaMarks is populated with the seven boot spans:
//         tShellStart, tBabelPreloadAppend, tBabelScriptAppend, tBabelReady,
//         tFirstWebFetchStart, tFirstWebFetchEnd, tDocumentWrite.
//   (2) Marks persist to localStorage['jellyfin.qa.bootMarks.current'].
//   (3) On the next boot, current is rotated to
//         localStorage['jellyfin.qa.bootMarks.prior'].
//
// Why a Node harness (and not a physical-TV pixel capture): boot marks are a
// pure browser-side instrumentation channel implemented entirely in the head
// IIFEs of index.html (JEL-1973/1974, v68) plus markDocumentWrite() in
// shell.js. Their correctness is structural + runtime-deterministic and does
// NOT depend on the Tizen WebView's rendering — it depends only on (a) the
// boot-mark IIFE allocating window.__qaMarks and persisting it, (b) the other
// head IIFEs + markDocumentWrite stamping their span into it, and (c) the next
// boot rotating current->prior. We prove all three by source structure and by
// executing the EXACT IIFE bytes from index.html (plus the real
// markDocumentWrite from shell.js) under both a modern-browser and a
// legacy-Chromium (Tizen) navigator, across two simulated boots that share one
// localStorage.
//
// The TV-vs-browser truth (the "Compare" half of the ticket):
//   The boot-mark IIFE is NOT UA-gated — only `jellyfin.qa.bootMarks.enabled`
//   gates it — so the buffer, persistence and rotation are byte-for-byte
//   identical on TV and browser. FOUR spans stamp on BOTH UAs:
//     tShellStart, tFirstWebFetchStart, tFirstWebFetchEnd, tDocumentWrite.
//   THREE spans are legacy-Chromium-only BY DESIGN:
//     tBabelPreloadAppend, tBabelScriptAppend, tBabelReady — they measure the
//     babel.min.js critical path, and babel.min.js is only ever loaded on
//     legacy Chromium (<70). A modern browser never transpiles, so those three
//     legitimately stay 0. This exactly mirrors the JEL-56 bundle-patch
//     precedent (the function runs on both; the substantive work is
//     legacy-only). So on the TV (the legacy path) all seven populate; on a
//     modern browser the four UA-independent spans populate and the three babel
//     spans stay 0 — which is the correct, designed behaviour, not a regression.
//
// Usage (fully offline — no server or device needed):
//   node tooling/tv-validate/qa-bootmarks/verify-qa-bootmarks.mjs
// Exits non-zero on any failed check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const INDEX_HTML = resolve(REPO, "packages/shell-tizen/src/index.html");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const QA_BEACON = resolve(REPO, "packages/shell-tizen/src/qa-beacon.js");
const HOSTED = resolve(REPO, "packages/shell-tizen-bootstrap/src/boot-shell.src.js");

const SPANS = [
  "tShellStart",
  "tBabelPreloadAppend",
  "tBabelScriptAppend",
  "tBabelReady",
  "tFirstWebFetchStart",
  "tFirstWebFetchEnd",
  "tDocumentWrite",
];
// The four spans that are UA-independent (stamp on TV AND browser); the rest
// are legacy-only because they time the babel.min.js critical path.
const UA_INDEPENDENT = new Set([
  "tShellStart",
  "tFirstWebFetchStart",
  "tFirstWebFetchEnd",
  "tDocumentWrite",
]);
const BABEL_SPANS = ["tBabelPreloadAppend", "tBabelScriptAppend", "tBabelReady"];

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Slice the EXACT bytes of the head <script> IIFE that contains `marker`.
function sliceIife(html, marker, label) {
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error(`${label}: marker not found: ${marker}`);
  const start = html.lastIndexOf("<script>", idx);
  const end = html.indexOf("</script>", idx);
  if (start < 0 || end < 0) throw new Error(`${label}: <script> boundaries not found`);
  return html.slice(start + "<script>".length, end);
}

// Brace-walk a `function NAME(){...}` out of a source. The only functions we
// lift here (markDocumentWrite) carry no braces inside their string/regex
// literals, so a plain depth counter is exact.
function extractFn(source, name, label) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error(`${label}: function ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${label}: unbalanced braces in ${name}`);
}

// ===================================================================
// PART A — STATIC STRUCTURE GUARDS. Encode the invariants that, if
// reverted, silently break the boot-mark buffer, its persistence, or
// the next-boot rotation. UA-independent.
// ===================================================================
function partA() {
  const html = readFileSync(INDEX_HTML, "utf8");

  // The QA seed flips both gates on (overlay HUD/beacon + boot marks).
  check("index.html seeds jellyfin.qa.overlay='1' (overlay + beacon gate)",
    /localStorage\.setItem\(['"]jellyfin\.qa\.overlay['"],\s*['"]1['"]\)/.test(html));
  check("index.html seeds jellyfin.qa.bootMarks.enabled='1' (boot-marks gate)",
    /localStorage\.setItem\(['"]jellyfin\.qa\.bootMarks\.enabled['"],\s*['"]1['"]\)/.test(html));

  const bm = sliceIife(html, "window.__qaMarks={bootIndex:idx", "boot-mark IIFE");

  // (gate) the IIFE is gated ONLY by bootMarks.enabled — no UA branch — so the
  // buffer/persistence/rotation are identical on TV and browser.
  check("boot-mark IIFE is gated only by jellyfin.qa.bootMarks.enabled (no UA fork)",
    /getItem\(['"]jellyfin\.qa\.bootMarks\.enabled['"]\)===['"]1['"]/.test(bm) &&
      /if\(!en\)\{window\.__qaMarks=null;return;?\}/.test(bm) &&
      !/userAgent|Chrome|Chromium|tizen|webapis/i.test(bm),
    "enabled-gate present; no navigator/UA reference inside the IIFE");

  // (1) the buffer is allocated with all seven spans (+ bootIndex/bootTs).
  check("boot-mark IIFE allocates window.__qaMarks with all seven span fields",
    SPANS.every((s) => new RegExp(s + "\\s*:").test(bm)),
    SPANS.join(", "));
  check("buffer also carries bootIndex + bootTs (boot identity)",
    /bootIndex:idx/.test(bm) && /bootTs:Date\.now\(\)/.test(bm));
  check("tShellStart is stamped at allocation via performance.now()",
    /tShellStart:now\(\)/.test(bm) && /var now=function\(\)\{try\{return performance\.now\(\)/.test(bm));

  // (2) persistence: __qaMarksSave writes the buffer to .current and is called
  // at allocation time.
  check("(2) __qaMarksSave persists the buffer to jellyfin.qa.bootMarks.current",
    /window\.__qaMarksSave=function\(\)\{try\{localStorage\.setItem\(['"]jellyfin\.qa\.bootMarks\.current['"],\s*JSON\.stringify\(window\.__qaMarks\)\)/.test(bm));
  check("(2) initial allocation immediately persists (calls __qaMarksSave())",
    /window\.__qaMarksSave\(\);?\}catch\(e\)\{\}\}\)\(\);?$/.test(bm.trim()) ||
      /window\.__qaMarksSave\(\)/.test(bm));

  // (3) rotation: read current, write it to prior, BEFORE the new buffer is
  // allocated — so prior holds the *previous* boot's spans.
  const readCurPos = bm.indexOf("getItem('jellyfin.qa.bootMarks.current')");
  const writePriorPos = bm.indexOf("setItem('jellyfin.qa.bootMarks.prior'");
  const allocPos = bm.indexOf("window.__qaMarks={bootIndex:idx");
  check("(3) rotation reads .current and writes it to .prior",
    readCurPos >= 0 && writePriorPos >= 0,
    "prior <- current at boot start");
  check("(3) rotation happens BEFORE the new buffer is allocated (prior=previous boot)",
    readCurPos >= 0 && writePriorPos >= 0 && allocPos >= 0 &&
      readCurPos < allocPos && writePriorPos < allocPos,
    `read.current@${readCurPos} & write.prior@${writePriorPos} both precede alloc@${allocPos}`);
  check("boot index increments each boot (jellyfin.qa.bootIndex)",
    /getItem\(['"]jellyfin\.qa\.bootIndex['"]\)/.test(bm) &&
      /setItem\(['"]jellyfin\.qa\.bootIndex['"],\s*String\(idx\)\)/.test(bm));

  // The boot-mark IIFE must run before shell.min.js (so tShellStart and the
  // rotation happen at the very top of the document) and before the IIFEs that
  // stamp the babel/fetch spans into the buffer.
  const bmPos = html.indexOf("window.__qaMarks={bootIndex:idx");
  const shellTag = html.indexOf('<script src="shell.min.js">');
  const preloadPos = html.indexOf("__qaMarks.tBabelPreloadAppend");
  const prefetchPos = html.indexOf("__qaMarks.tFirstWebFetchStart");
  const babelPos = html.indexOf("__qaMarks.tBabelReady");
  check("boot-mark IIFE precedes <script src=shell.min.js>",
    bmPos >= 0 && shellTag >= 0 && bmPos < shellTag);
  check("boot-mark IIFE precedes every span-writer (preload/prefetch/babel)",
    bmPos < preloadPos && bmPos < prefetchPos && bmPos < babelPos,
    `bm@${bmPos} < preload@${preloadPos}, prefetch@${prefetchPos}, babel@${babelPos}`);

  // Each of the other six spans is stamped at exactly one documented site,
  // guarded by `if(window.__qaMarks)` and followed by a save.
  const preload = sliceIife(html, "__qaMarks.tBabelPreloadAppend", "preload IIFE");
  check("tBabelPreloadAppend stamped in the JEL-1973 preload IIFE (guarded + saved)",
    /if\(window\.__qaMarks\)\{window\.__qaMarks\.tBabelPreloadAppend=performance\.now\(\);if\(window\.__qaMarksSave\)window\.__qaMarksSave\(\);?\}/.test(preload));

  const prefetch = sliceIife(html, "__qaMarks.tFirstWebFetchStart", "prefetch IIFE");
  check("tFirstWebFetchStart stamped before fetch(b+'index.html') in idxFetch (guarded + saved)",
    /window\.__qaMarks\.tFirstWebFetchStart=performance\.now\(\)/.test(prefetch) &&
      /return fetch\(b\+['"]index\.html['"]/.test(prefetch));
  check("tFirstWebFetchEnd stamped in the index.html fetch .then() (guarded + saved)",
    /\.then\(function\(r\)\{if\(window\.__qaMarks\)\{window\.__qaMarks\.tFirstWebFetchEnd=performance\.now\(\)/.test(prefetch));
  check("fetch-span stamping is OUTSIDE the legacy gate (fires on TV AND browser)",
    prefetch.indexOf("tFirstWebFetchStart") < prefetch.indexOf("if(legacy){"),
    "idxFetch is built before the `if(legacy)` preload-warmers branch");

  const babel = sliceIife(html, "__qaMarks.tBabelReady", "babel IIFE");
  check("tBabelScriptAppend stamped after appendChild(<script src=babel.min.js>) (guarded + saved)",
    /window\.__qaMarks\.tBabelScriptAppend=performance\.now\(\)/.test(babel) &&
      /s\.src=['"]babel\.min\.js['"]/.test(babel));
  check("tBabelReady stamped in babel script onload (guarded + saved)",
    /s\.onload=function\(\)\{if\(window\.__qaMarks\)\{window\.__qaMarks\.tBabelReady=performance\.now\(\)/.test(babel));
  // (the Compare crux) the babel IIFE early-returns on modern Chromium, so the
  // three babel spans are legacy-only by construction.
  check("babel IIFE early-returns on !legacy (3 babel spans are legacy-only by design)",
    /if\(!legacy\)\{window\.__ensureBabel=function\(\)\{return Promise\.resolve\(\);?\}/.test(babel));

  // tDocumentWrite lives in shell.js markDocumentWrite() and is wired into the
  // document.open/write path; it ships in the release artifact + hosted shell.
  for (const [label, path] of [
    ["shell.js (source)", SHELL_JS],
    ["shell.min.js (release artifact)", SHELL_MIN],
    ["boot-shell.src.js (hosted/bootstrap shell)", HOSTED],
  ]) {
    const code = readFileSync(path, "utf8").replace(/\s+/g, "");
    check(`${label}: stamps tDocumentWrite into __qaMarks + persists to .current`,
      /window\.__qaMarks\.tDocumentWrite=performance\.now\(\)/.test(code) &&
        /["']jellyfin\.qa\.bootMarks\.current["']/.test(code),
      "markDocumentWrite() flush just before document.open replaces the shell doc");
  }
  // and markDocumentWrite is actually invoked on the boot path in shell.js.
  const shellSrc = readFileSync(SHELL_JS, "utf8");
  check("shell.js calls markDocumentWrite() on the document.write boot path",
    (shellSrc.match(/markDocumentWrite\(\)/g) || []).length >= 2,
    `${(shellSrc.match(/markDocumentWrite\(\)/g) || []).length} call-sites`);

  // The beacon side: same overlay gate, and it reads the rotated .prior once.
  const beacon = readFileSync(QA_BEACON, "utf8");
  check("qa-beacon.js shares the jellyfin.qa.overlay gate",
    /getItem\(["']jellyfin\.qa\.overlay["']\)\s*!==\s*["']1["']/.test(beacon));
  check("qa-beacon.js reads the rotated jellyfin.qa.bootMarks.prior and emits priorBootMarks",
    /getItem\(["']jellyfin\.qa\.bootMarks\.prior["']\)/.test(beacon) &&
      /priorBootMarks:\s*takePriorBootMarks\(\)/.test(beacon));

  return { html, markDocumentWriteFn: extractFn(shellSrc, "markDocumentWrite", "shell.js") };
}

// ===================================================================
// PART B — RUNTIME EXECUTION of the EXACT IIFE bytes under both UAs,
// across TWO boots sharing one localStorage. Proves the buffer is
// populated, persisted, and rotated — and which spans each UA stamps.
// ===================================================================
function makeStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    ls: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
    map,
  };
}

// Run one head IIFE with the browser free-identifiers injected.
function runIife(iife, env) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window", "document", "navigator", "localStorage", "performance", "fetch", "console",
    iife,
  );
  fn(env.window, env.document, env.navigator, env.localStorage, env.performance, env.fetch, console);
}

// Simulate one full boot of the head pipeline (boot-mark IIFE -> preload ->
// prefetch -> babel) for a given UA on a shared localStorage, then run the real
// markDocumentWrite() lifted from shell.js. Returns the populated buffer.
async function simulateBoot(html, markDocumentWriteFn, ua, store) {
  // Monotonic performance.now() so every stamp is a distinct positive value;
  // a span that never fires stays at its allocation default of 0.
  let t = 0;
  const performance = { now: () => ++t };
  const appendedScripts = [];
  const appendedLinks = [];
  const document = {
    head: {
      appendChild: (el) => {
        if (el.__kind === "script") appendedScripts.push(el);
        else appendedLinks.push(el);
        return el;
      },
    },
    createElement: (tag) =>
      tag === "script"
        ? { __kind: "script", src: "", async: false, onload: null, onerror: null }
        : { __kind: "link", rel: "", as: "", href: "" },
  };
  const fetchCalls = [];
  const fetch = (url) => {
    fetchCalls.push(url);
    return Promise.resolve({ ok: true, status: 200, url, text: async () => "" });
  };
  const window = {};
  const env = {
    window,
    document,
    navigator: { userAgent: ua },
    localStorage: store.ls,
    performance,
    fetch,
  };

  // 1) boot-mark IIFE — allocates window.__qaMarks, stamps tShellStart,
  //    persists .current, rotates previous .current -> .prior.
  runIife(sliceIife(html, "window.__qaMarks={bootIndex:idx", "boot-mark"), env);

  // 2) preload IIFE — stamps tBabelPreloadAppend on babel-needed legacy boots.
  runIife(sliceIife(html, "__qaMarks.tBabelPreloadAppend", "preload"), env);

  // 3) prefetch IIFE — stamps tFirstWebFetchStart synchronously and
  //    tFirstWebFetchEnd when the index.html fetch resolves.
  runIife(sliceIife(html, "__qaMarks.tFirstWebFetchStart", "prefetch"), env);
  if (window.__shellPrefetch && window.__shellPrefetch.index) {
    await window.__shellPrefetch.index; // let the .then() stamp tFirstWebFetchEnd
  }

  // 4) babel IIFE — on legacy babel-needed boots it auto-calls __ensureBabel(),
  //    which appends <script src=babel.min.js> (stamps tBabelScriptAppend);
  //    firing its onload stamps tBabelReady.
  runIife(sliceIife(html, "__qaMarks.tBabelReady", "babel"), env);
  const babelScript = appendedScripts.find((s) => s.src === "babel.min.js");
  if (babelScript && typeof babelScript.onload === "function") babelScript.onload();

  // 5) markDocumentWrite() (real shell.js bytes) — stamps tDocumentWrite right
  //    before document.open swaps in the /web/ document.
  // eslint-disable-next-line no-new-func
  const mdw = new Function(
    "window", "localStorage", "performance",
    markDocumentWriteFn + "\nmarkDocumentWrite();",
  );
  mdw(window, store.ls, performance);

  return { window, marks: window.__qaMarks, appendedScripts, appendedLinks, fetchCalls };
}

async function partB(html, markDocumentWriteFn) {
  const UAS = {
    browser:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // Real Tizen 5.5 legacy Chromium 69 (regex-detectable as <70).
    tv:
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36 Chrome/69.0.3497.106",
  };
  // Seed: overlay + boot-marks enabled, a stored server (so prefetch fires),
  // and a babel-needed flag (so the legacy babel critical path is exercised).
  const seed = () => ({
    "jellyfin.qa.overlay": "1",
    "jellyfin.qa.bootMarks.enabled": "1",
    "jellyfin.shell.serverUrl": "https://jellyfin.example.test",
    "jellyfin.shell.legacy.babelNeeded": "1",
  });

  for (const [label, ua] of Object.entries(UAS)) {
    console.log(`\n--- [${label}] two boots on one localStorage ---`);
    const store = makeStore(seed());

    // BOOT 1 — fresh store: no prior yet, bootIndex -> 1.
    const b1 = await simulateBoot(html, markDocumentWriteFn, ua, store);

    check(`[${label}] boot 1 allocates window.__qaMarks (buffer present)`,
      b1.marks && typeof b1.marks === "object", b1.marks ? "object" : "MISSING");
    check(`[${label}] boot 1 bootIndex === 1`, b1.marks.bootIndex === 1, `bootIndex=${b1.marks.bootIndex}`);

    // (2) persisted to .current as JSON with all the span keys present.
    const cur1 = JSON.parse(store.map.get("jellyfin.qa.bootMarks.current"));
    check(`[${label}] (2) boot 1 persisted buffer to jellyfin.qa.bootMarks.current`,
      cur1 && cur1.bootIndex === 1 && SPANS.every((s) => s in cur1),
      "current carries all seven span keys");
    check(`[${label}] (3) boot 1 wrote NO .prior yet (nothing to rotate)`,
      store.map.get("jellyfin.qa.bootMarks.prior") == null);

    // (1) the four UA-independent spans populate on BOTH browser and TV.
    for (const s of UA_INDEPENDENT) {
      check(`[${label}] (1) ${s} populated (> 0)`, b1.marks[s] > 0, `${s}=${b1.marks[s]}`);
    }

    // The three babel spans: populated on TV (legacy), legitimately 0 on browser.
    if (label === "tv") {
      for (const s of BABEL_SPANS) {
        check(`[tv] (1) ${s} populated on legacy Chromium (> 0)`, b1.marks[s] > 0, `${s}=${b1.marks[s]}`);
      }
      check("[tv] babel.min.js <script> was appended (drives tBabelScriptAppend/tBabelReady)",
        b1.appendedScripts.some((s) => s.src === "babel.min.js"));
      check("[tv] <link rel=preload href=babel.min.js> appended (drives tBabelPreloadAppend)",
        b1.appendedLinks.some((l) => l.rel === "preload" && l.href === "babel.min.js"));
    } else {
      for (const s of BABEL_SPANS) {
        check(`[browser] ${s} stays 0 by design (modern Chromium never loads babel)`,
          b1.marks[s] === 0, `${s}=${b1.marks[s]}`);
      }
      check("[browser] no babel.min.js <script> appended (no transpile on modern)",
        !b1.appendedScripts.some((s) => s.src === "babel.min.js"));
    }

    // BOOT 2 — same store: boot 1's .current must rotate into .prior.
    const b2 = await simulateBoot(html, markDocumentWriteFn, ua, store);
    check(`[${label}] boot 2 bootIndex === 2 (counter advanced)`,
      b2.marks.bootIndex === 2, `bootIndex=${b2.marks.bootIndex}`);

    const prior = JSON.parse(store.map.get("jellyfin.qa.bootMarks.prior"));
    const cur2 = JSON.parse(store.map.get("jellyfin.qa.bootMarks.current"));
    check(`[${label}] (3) boot 2 rotated boot 1's marks into jellyfin.qa.bootMarks.prior`,
      prior && prior.bootIndex === 1 && prior.tShellStart === cur1.tShellStart,
      `prior.bootIndex=${prior && prior.bootIndex} (expected 1)`);
    check(`[${label}] (3) .prior holds boot 1's full span set (not boot 2's)`,
      prior && SPANS.every((s) => prior[s] === cur1[s]) && prior.bootIndex !== cur2.bootIndex,
      "prior === boot-1 snapshot, current === boot-2 snapshot");
    check(`[${label}] (2)+(3) .current now holds the fresh boot-2 buffer`,
      cur2 && cur2.bootIndex === 2,
      `current.bootIndex=${cur2 && cur2.bootIndex}`);
  }
}

// ===================================================================
// PART C — disabled-gate guard: with bootMarks.enabled unset, the IIFE
// allocates NOTHING and writes no localStorage keys (production safety).
// ===================================================================
function partC(html) {
  console.log("\n--- gate-off: bootMarks disabled allocates nothing ---");
  const store = makeStore({ "jellyfin.shell.serverUrl": "https://jellyfin.example.test" });
  const window = {};
  runIife(sliceIife(html, "window.__qaMarks={bootIndex:idx", "boot-mark"), {
    window,
    document: { head: { appendChild: () => {} }, createElement: () => ({}) },
    navigator: { userAgent: "Chrome/120" },
    localStorage: store.ls,
    performance: { now: () => 1 },
    fetch: () => Promise.resolve({}),
  });
  check("gate-off: window.__qaMarks is null when bootMarks.enabled is unset",
    window.__qaMarks === null, `__qaMarks=${window.__qaMarks}`);
  check("gate-off: no jellyfin.qa.bootMarks.* keys written (no allocation, no rotation)",
    !store.map.has("jellyfin.qa.bootMarks.current") &&
      !store.map.has("jellyfin.qa.bootMarks.prior") &&
      !store.map.has("jellyfin.qa.bootIndex"),
    "production builds (gate off) never touch boot-mark storage");
}

async function main() {
  console.log("== PART A: boot-mark source structure (gate + buffer + persist + rotate) ==");
  const { html, markDocumentWriteFn } = partA();
  console.log("\n== PART B: runtime — populate, persist, rotate (browser + TV) ==");
  await partB(html, markDocumentWriteFn);
  console.log("\n== PART C: gate-off safety ==");
  partC(html);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error("harness error:", e?.stack || e?.message || e);
  process.exit(1);
});
