#!/usr/bin/env node
// JEL-59 — Compare: Legacy Chromium preload of main bundle + plugin scripts
// (<link rel=preload as=script|style>).
//
// Unlike the data-parity "Compare:" tickets (movie/series/search/settings),
// JEL-59 is about a SHELL-INTERNAL load optimization that runs ONLY on legacy
// Chromium (M56/M63 Tizen WebViews). It has no server-data dimension, so this
// harness is HERMETIC — it needs no live Jellyfin server. It executes the EXACT
// shipped bytes of the preload code path against a synthetic DOM.
//
// The pipeline has two halves, on two boots:
//
//   FIRST BOOT (write side, shell.js → shell.min.js):
//     transpileLegacyScriptsInner() walks /web/index.html's <script>/<link> and
//     records, into localStorage, the URLs a *next* boot should warm:
//       (1) main bundle URL      -> jellyfin.shell.bundleUrl       (JEL-1289)
//       (2) plugin <script src>  -> jellyfin.shell.pluginUrls      (≤100, JEL-1654)
//       (3) secondary .bundle.js -> jellyfin.shell.secondaryBundleUrls (≤20, JEL-1924)
//       (4) <link rel=stylesheet>-> jellyfin.shell.stylesheetUrls  (≤20, JEL-1959)
//
//   SECOND BOOT (read side, index.html head IIFE — the deployed entry point):
//     On a legacy WebView, reads those 4 keys and injects
//       <link rel=preload as=script>  for the bundle + plugin + secondary URLs
//       <link rel=preload as=style>   for the stylesheet URLs
//     and publishes the counts on window.__shellPreloadScripts /
//     __shellPreloadSecondaries / __shellPreloadStylesheets. (JEL-1967)
//
// WHY "TV vs browser" REDUCES TO A GATING PROOF
//   <link rel=preload> changes ONLY load timing (HTTP cache + V8 script-stream
//   parse warmup); it never changes what renders. The optimization is gated to
//   legacy Chromium: a MODERN browser runs the same IIFE but takes the no-op
//   branch — zero preload links, counts left undefined — so the rendered DOM is
//   identical TV vs browser by construction. This harness proves exactly that:
//   the legacy path emits the correct preloads with correct gates/caps/dedup,
//   and the modern path emits none.
//
// HOW IT RUNS THE REAL CODE
//   PART A executes the literal preload <script> extracted from the shipped
//   src/index.html (packaged verbatim into the .wgt — config.xml
//   <content src="index.html"/>, build-wgt.sh `cp -R src/.`) inside a Node `vm`
//   sandbox with a mocked window/document/localStorage/navigator. No re-
//   implementation — the bytes under test are the bytes that boot on the TV.
//   PART B pins the first-boot WRITE side to source (shell.js source-of-record
//   AND the deployed shell.min.js) and proves the write-keys/caps are exactly
//   the read-keys/caps (the round-trip contract), so the two boots can never
//   drift apart.
//
// Usage:  node tooling/tv-validate/preload/verify-preload.mjs
// Exits non-zero on any failed assertion. Reads no env, no network, no creds.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const INDEX_HTML = resolve(REPO, "packages/shell-tizen/src/index.html");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---------------------------------------------------------------------------
// Extract the deployed preload <script> body from src/index.html.
// It is the plain <script> tag whose body publishes __shellPreloadScripts.
// ---------------------------------------------------------------------------
const html = readFileSync(INDEX_HTML, "utf8");
const iifeMatch = html.match(
  /<script>((?:(?!<\/script>)[\s\S])*__shellPreloadScripts(?:(?!<\/script>)[\s\S])*)<\/script>/,
);
const PRELOAD_IIFE = iifeMatch ? iifeMatch[1] : null;
check(
  "extracted the shipped preload IIFE from src/index.html",
  !!PRELOAD_IIFE && /__shellPrefetch/.test(PRELOAD_IIFE),
  PRELOAD_IIFE ? `${PRELOAD_IIFE.length} bytes` : "NOT FOUND",
);
if (!PRELOAD_IIFE) {
  console.log(`\n0/${results.length} — cannot continue without the IIFE.`);
  process.exit(1);
}

const UA_LEGACY = "Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/537.36 Chrome/63.0.3239.84 Safari/537.36";
const UA_MODERN = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

// Run the real IIFE under a synthetic DOM. Returns {links, win}.
//   links: every element appended to <head> (the injected <link rel=preload>s)
//   win:   the sandbox global (carries __shellPreload* counters + __shellPrefetch)
function runPreload({ ua, store }) {
  const links = [];
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
        links.push(el);
        return el;
      },
    },
    createElement() {
      // mirrors `l.rel=..;l.as=..;l.href=..` on a fresh element
      return { tagName: "LINK", rel: "", as: "", href: "" };
    },
  };
  const ctx = {
    localStorage,
    document,
    navigator: { userAgent: ua },
    // the IIFE kicks index/config fetches purely to warm cache; return a thenable
    fetch: () => Promise.resolve({}),
    performance: { now: () => 0 },
    console,
  };
  ctx.window = ctx; // `window.__shellPreloadScripts = ...` writes onto ctx
  vm.createContext(ctx);
  vm.runInContext(PRELOAD_IIFE, ctx, { filename: "index.html#preload-iife" });
  return { links, win: ctx };
}

// Convenience: split the injected links by `as`.
const scriptLinks = (links) => links.filter((l) => l.as === "script");
const styleLinks = (links) => links.filter((l) => l.as === "style");
const allPreload = (links) => links.every((l) => l.rel === "preload");
const hrefs = (links) => links.map((l) => l.href);

const SERVER = "https://tv.example.local";
const WEB = SERVER + "/web/"; // bundle gate prefix
const ORIGIN = SERVER + "/"; // plugin/secondary/style gate prefix
const baseStore = () => ({ "jellyfin.shell.serverUrl": SERVER });

// ===========================================================================
// PART A — SECOND BOOT (read side): the real IIFE emits the right preloads
// ===========================================================================
function partA() {
  // --- A1: rich realistic legacy boot — gates, dedup, as=script|style ------
  {
    const bundle = WEB + "main.jellyfin.9f3a.bundle.js";
    const p1 = SERVER + "/EditorsChoice/script";
    const p2 = SERVER + "/JellyfinEnhanced/public.js";
    const pX = "https://cdn.elsewhere.example/evil.js"; // cross-origin → drop
    const s1 = SERVER + "/web/runtime.aa.bundle.js";
    const s2 = SERVER + "/web/vendors.bb.bundle.js";
    const sX = "https://cdn.elsewhere.example/chunk.bundle.js"; // drop
    const c1 = SERVER + "/web/main.jellyfin.cc.css";
    const c2 = SERVER + "/HomeScreen/home-screen-sections.css";
    const cX = "https://cdn.elsewhere.example/theme.css"; // drop
    const { links, win } = runPreload({
      ua: UA_LEGACY,
      store: {
        ...baseStore(),
        "jellyfin.shell.bundleUrl": bundle,
        "jellyfin.shell.pluginUrls": JSON.stringify([p1, p2, p1 /*dup*/, pX]),
        "jellyfin.shell.secondaryBundleUrls": JSON.stringify([s1, s2, s1 /*dup*/, sX]),
        "jellyfin.shell.stylesheetUrls": JSON.stringify([c1, c2, c1 /*dup*/, cX]),
      },
    });

    check(
      "A1 legacy: every injected <link> is rel=preload",
      links.length > 0 && allPreload(links),
      `${links.length} links, rels=${[...new Set(links.map((l) => l.rel))].join("/")}`,
    );
    // __shellPreloadScripts = bundle(1) + unique same-origin plugins(2) = 3
    check(
      "A1 __shellPreloadScripts === main bundle (1) + deduped same-origin plugins (2) = 3",
      win.__shellPreloadScripts === 3,
      `got ${win.__shellPreloadScripts}`,
    );
    check(
      "A1 __shellPreloadSecondaries === 2 (deduped, cross-origin dropped)",
      win.__shellPreloadSecondaries === 2,
      `got ${win.__shellPreloadSecondaries}`,
    );
    check(
      "A1 __shellPreloadStylesheets === 2 (deduped, cross-origin dropped)",
      win.__shellPreloadStylesheets === 2,
      `got ${win.__shellPreloadStylesheets}`,
    );
    // DOM shape: 5 as=script (bundle + 2 plugins + 2 secondary), 2 as=style.
    const sc = scriptLinks(links), st = styleLinks(links);
    check(
      "A1 DOM: 5 <link as=script> + 2 <link as=style> injected into <head>",
      sc.length === 5 && st.length === 2,
      `as=script=${sc.length} as=style=${st.length}`,
    );
    check(
      "A1 first script preload is the MAIN BUNDLE",
      sc[0] && sc[0].href === bundle,
      sc[0] ? sc[0].href : "none",
    );
    check(
      "A1 cross-origin URLs are NOT preloaded (same-origin gate holds)",
      !hrefs(links).includes(pX) && !hrefs(links).includes(sX) && !hrefs(links).includes(cX),
      "no foreign-origin hrefs present",
    );
    check(
      "A1 duplicate plugin URL preloaded exactly once (dedup)",
      hrefs(links).filter((h) => h === p1).length === 1,
      `p1 appears ${hrefs(links).filter((h) => h === p1).length}×`,
    );
    check(
      "A1 stylesheet links use as=style, not as=script",
      st.length === 2 && st.every((l) => [c1, c2].includes(l.href)),
      st.map((l) => l.href.split("/").pop()).join(","),
    );
  }

  // --- A2: caps — plugins ≤100, secondary ≤20, stylesheets ≤20 -------------
  {
    const bundle = WEB + "main.bundle.js";
    const plugins = Array.from({ length: 130 }, (_, i) => `${SERVER}/Plugin${i}/script`);
    const secondary = Array.from({ length: 25 }, (_, i) => `${SERVER}/web/chunk${i}.bundle.js`);
    const styles = Array.from({ length: 25 }, (_, i) => `${SERVER}/web/style${i}.css`);
    const { win } = runPreload({
      ua: UA_LEGACY,
      store: {
        ...baseStore(),
        "jellyfin.shell.bundleUrl": bundle,
        "jellyfin.shell.pluginUrls": JSON.stringify(plugins),
        "jellyfin.shell.secondaryBundleUrls": JSON.stringify(secondary),
        "jellyfin.shell.stylesheetUrls": JSON.stringify(styles),
      },
    });
    check(
      "A2 plugin preload capped at 100 (__shellPreloadScripts === 1 bundle + 100)",
      win.__shellPreloadScripts === 101,
      `got ${win.__shellPreloadScripts} from 130 plugin URLs`,
    );
    check(
      "A2 secondary bundle preload capped at 20",
      win.__shellPreloadSecondaries === 20,
      `got ${win.__shellPreloadSecondaries} from 25`,
    );
    check(
      "A2 stylesheet preload capped at 20",
      win.__shellPreloadStylesheets === 20,
      `got ${win.__shellPreloadStylesheets} from 25`,
    );
  }

  // --- A3: bundle gate — a bundle URL NOT under /web/ is rejected -----------
  {
    const badBundle = SERVER + "/notweb/sneaky.bundle.js"; // same origin, wrong path
    const p1 = SERVER + "/EditorsChoice/script";
    const { links, win } = runPreload({
      ua: UA_LEGACY,
      store: {
        ...baseStore(),
        "jellyfin.shell.bundleUrl": badBundle,
        "jellyfin.shell.pluginUrls": JSON.stringify([p1]),
      },
    });
    check(
      "A3 bundle URL outside /web/ is NOT preloaded (__shellPreloadScripts === 1 plugin, no bundle)",
      win.__shellPreloadScripts === 1 && !hrefs(links).includes(badBundle),
      `scripts=${win.__shellPreloadScripts}, badBundle present=${hrefs(links).includes(badBundle)}`,
    );
  }

  // --- A4: MODERN browser takes the no-op branch (the parity proof) --------
  {
    const { links, win } = runPreload({
      ua: UA_MODERN,
      store: {
        ...baseStore(),
        "jellyfin.shell.bundleUrl": WEB + "main.bundle.js",
        "jellyfin.shell.pluginUrls": JSON.stringify([SERVER + "/EditorsChoice/script"]),
        "jellyfin.shell.secondaryBundleUrls": JSON.stringify([SERVER + "/web/x.bundle.js"]),
        "jellyfin.shell.stylesheetUrls": JSON.stringify([SERVER + "/web/x.css"]),
      },
    });
    check(
      "A4 MODERN browser injects ZERO preload links (optimization is legacy-only)",
      links.length === 0,
      `${links.length} links injected`,
    );
    check(
      "A4 MODERN browser leaves __shellPreload* counters UNSET (undefined)",
      win.__shellPreloadScripts === undefined &&
        win.__shellPreloadSecondaries === undefined &&
        win.__shellPreloadStylesheets === undefined,
      `scripts=${win.__shellPreloadScripts}`,
    );
    check(
      "A4 MODERN browser still sets __shellPrefetch (index/config warm) — shared path, only preload differs",
      !!win.__shellPrefetch && typeof win.__shellPrefetch === "object",
      win.__shellPrefetch ? "prefetch object present" : "missing",
    );
  }

  // --- A5: no serverUrl yet (true first boot) → IIFE no-ops cleanly ---------
  {
    const { links, win } = runPreload({ ua: UA_LEGACY, store: {} });
    check(
      "A5 with no saved serverUrl the IIFE no-ops (no links, no __shellPrefetch) — nothing to preload on first boot",
      links.length === 0 && win.__shellPrefetch === undefined,
      `${links.length} links`,
    );
  }
}

// ===========================================================================
// PART B — FIRST BOOT (write side) pinned to source + round-trip contract
// ===========================================================================
const shellJs = readFileSync(SHELL_JS, "utf8");
const shellMin = readFileSync(SHELL_MIN, "utf8");

// The 4 localStorage keys the contract turns on. Each must be WRITTEN by the
// first boot (shell.js) and READ by the second boot (index.html IIFE).
const KEYS = [
  "jellyfin.shell.bundleUrl",
  "jellyfin.shell.pluginUrls",
  "jellyfin.shell.secondaryBundleUrls",
  "jellyfin.shell.stylesheetUrls",
];

function partB() {
  // --- B1: shell.js (source of record) WRITES all 4 keys -------------------
  for (const k of KEYS) {
    const writes = new RegExp(
      `localStorage\\.setItem\\(\\s*["']${k.replace(/\./g, "\\.")}["']`,
    ).test(shellJs);
    check(`B1 shell.js writes ${k} on first boot`, writes, writes ? "setItem present" : "NOT written");
  }

  // --- B2: deployed shell.min.js carries the same 4 writes (not just source) -
  for (const k of KEYS) {
    check(
      `B2 deployed shell.min.js also writes ${k}`,
      shellMin.includes(`"${k}"`),
      shellMin.includes(`"${k}"`) ? "present in min" : "MISSING from deployed artifact",
    );
  }

  // --- B3: write-side caps match the read-side caps (no drift) --------------
  // Read-side caps live in the IIFE: pluN<100, sbN<20, ssN<20.
  const readPluginCap = /pluN\s*<\s*(\d+)/.exec(PRELOAD_IIFE);
  const readSecCap = /sbN\s*<\s*(\d+)/.exec(PRELOAD_IIFE);
  const readStyCap = /ssN\s*<\s*(\d+)/.exec(PRELOAD_IIFE);
  // Write-side caps live in shell.js loop guards.
  const wPluginCap = /pluginUrlsForNextBoot\.length\s*<\s*(\d+)/.exec(shellJs);
  const wSecCap = /secondaryBundleUrls\.length\s*<\s*(\d+)/.exec(shellJs);
  const wStyCap = /stylesheetUrls\.length\s*<\s*(\d+)/.exec(shellJs);
  check(
    "B3 plugin cap agrees write↔read (shell.js 100 === IIFE 100)",
    wPluginCap && readPluginCap && wPluginCap[1] === "100" && readPluginCap[1] === "100",
    `write=${wPluginCap?.[1]} read=${readPluginCap?.[1]}`,
  );
  check(
    "B3 secondary cap agrees write↔read (shell.js 20 === IIFE 20)",
    wSecCap && readSecCap && wSecCap[1] === "20" && readSecCap[1] === "20",
    `write=${wSecCap?.[1]} read=${readSecCap?.[1]}`,
  );
  check(
    "B3 stylesheet cap agrees write↔read (shell.js 20 === IIFE 20)",
    wStyCap && readStyCap && wStyCap[1] === "20" && readStyCap[1] === "20",
    `write=${wStyCap?.[1]} read=${readStyCap?.[1]}`,
  );

  // --- B4: write side excludes what it must (jellyfin-web bundle, main chunk) -
  check(
    "B4 plugin list excludes the jellyfin-web client bundle (isJellyfinWebBundle gate)",
    /pluginUrlsForNextBoot[\s\S]{0,600}isJellyfinWebBundle/.test(shellJs),
    "isJellyfinWebBundle gate present in plugin scan",
  );
  check(
    "B4 secondary list excludes the MAIN bundle (SB_MAIN_RE) — main stays the dedicated bundleUrl key",
    /SB_MAIN_RE\s*=\s*\//.test(shellJs) && /SB_MAIN_RE\.test/.test(shellJs),
    "SB_MAIN_RE defined and applied",
  );
  check(
    "B4 secondary + stylesheet scans apply a server same-origin gate",
    /sbServerOrigin\s*=\s*new URL\(baseUrl\)\.origin/.test(shellJs) &&
      /bUorigin\s*!==\s*sbServerOrigin/.test(shellJs) &&
      /lUorigin\s*!==\s*sbServerOrigin/.test(shellJs),
    "origin gate present for both secondary (bUorigin) and stylesheet (lUorigin) scans",
  );

  // --- B5: ROUND-TRIP CONTRACT — every key written is a key read -----------
  // Pull the keys actually READ by the shipped IIFE and prove the set matches
  // the keys WRITTEN by shell.js. This is what guarantees boot N+1 preloads
  // exactly what boot N recorded.
  const readKeys = new Set();
  for (const k of KEYS) if (PRELOAD_IIFE.includes(`'${k}'`) || PRELOAD_IIFE.includes(`"${k}"`)) readKeys.add(k);
  const writeKeys = new Set();
  for (const k of KEYS)
    if (new RegExp(`setItem\\(\\s*["']${k.replace(/\./g, "\\.")}["']`).test(shellJs)) writeKeys.add(k);
  const sameSet = readKeys.size === KEYS.length && writeKeys.size === KEYS.length;
  check(
    "B5 round-trip: the 4 keys WRITTEN on boot N are exactly the 4 keys READ on boot N+1",
    sameSet,
    `read=${[...readKeys].length} write=${[...writeKeys].length} of ${KEYS.length}`,
  );
}

console.log("== PART A: second boot — real index.html preload IIFE (legacy vs modern) ==");
partA();
console.log("\n== PART B: first boot write side (shell.js + shell.min.js) + round-trip contract ==");
partB();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
