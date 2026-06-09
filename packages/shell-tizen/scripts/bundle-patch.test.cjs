// JEL-56 verification — Bundle patch: serverId=null fix + BUNDLE_CACHE_KEY
// state cache, compared TV-shell vs hosted/browser-shell.
//
// WHAT THE ISSUE ASKS US TO PROVE
//   1. patchPlaybackBundles() runs on the main Jellyfin bundle on both TV and
//      browser.
//   2. The serverId=null patch (CM/PM regex scan) is applied when needed.
//   3. localStorage BUNDLE_CACHE_KEY is written with the correct
//      {v, url, needsPatch, body} fields.
//   4. On warm boot the cached patched body is inlined instead of re-fetching.
//
// THE TV-vs-BROWSER TRUTH (the "Compare" half of the ticket)
//   shell.js is the SAME code on TV and browser — there is no per-UA source
//   fork. The difference is purely RUNTIME, decided by isLegacyChromium():
//
//     • Modern Chromium (every desktop/laptop browser AND modern Tizen TVs,
//       Chrome/Chromium >= 70 or optional-chaining-capable) →
//       patchPlaybackBundles() is INVOKED but early-returns a resolved promise
//       and sets window.__shellBundlePatchSkipped = 1. No fetch, no scan, no
//       cache write. The whole subsystem is inert.
//
//     • Legacy Chromium (<70 — the Tizen 5.0/5.5 M56/M63 WebViews) → the full
//       fetch → CM/PM regex scan → patch → BUNDLE_CACHE_KEY write runs, and
//       warm boots inline the cached body.
//
//   This is correct-by-design: the bug it repairs ("item or serverId cannot be
//   null") is itself a Chromium-<70 viewshow-race failure (JEL-554 / JEL-436).
//   A modern browser never hits that throw, so it needs no patch. So the honest
//   answer to "runs on both TV and browser" is: the FUNCTION runs on both, the
//   substantive work is legacy-only — exactly mirroring the JEL-52 detail-page
//   chain. Empirical runtime confirmation lives in
//   tooling/tv-validate/bundle-patch/results-JEL-56.md.
//
// STRATEGY
//   No DOM test runner exists in this repo, so we (a) lift the REAL cache and
//   patcher functions verbatim out of shell.js into a `vm` sandbox backed by a
//   fake localStorage and exercise the actual shipped behaviour across
//   simulated boots; and (b) source-assert the legacy gate / warm-boot inline /
//   verdict-write wiring on shell.js, the deployed release artifact
//   shell.min.js, and the hosted boot-shell.src.js so TV and browser stay in
//   lockstep.
//
// Run: node scripts/bundle-patch.test.cjs
//   or via the package `test` script.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const HOSTED = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

const src = fs.readFileSync(SHELL, "utf8");
const min = fs.readFileSync(SHELL_MIN, "utf8");
const hosted = fs.readFileSync(HOSTED, "utf8");

const EXPECTED_KEY = "jellyfin.shell.bundlePatchState";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// --- Fake localStorage that mimics the browser Storage contract -------------
// Optional quotaAt: throw QuotaExceededError on setItem when the serialized
// value exceeds N bytes — models Tizen WebKit's per-origin LS quota so we can
// prove the writeBundlePatchState body-drop fallback.
function makeStore(quotaAt) {
  const map = new Map();
  const ls = {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (typeof quotaAt === "number" && String(v).length > quotaAt) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
  return { ls, raw: map };
}

// Walk braces from the first "{" after a `function NAME(` signature to the
// matching close. Unlike the naive walker in server-url-persistence.test.cjs,
// this one is comment/string/regex aware — buildBundleSourcePatcher embeds
// braces inside `//` comments, string literals and regex literals (the CM/PM
// patterns), all of which would desync a raw brace count.
function extractFn(source, name, label) {
  const start = source.indexOf("function " + name + "(");
  if (start === -1) throw new Error(label + ": function " + name + " not found");
  const open = source.indexOf("{", start);
  // A `/` begins a regex (not division) when the previous significant char is
  // one of these — sufficient for the controlled shell.js source.
  // Single-char lookbehind set (prev is always one char, so no multi-char
  // keywords here). Regexes in these functions only follow `[ , ( =`.
  const regexLead = "(,=:[!&|?{;";
  let depth = 0;
  let prev = "";
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === "/" && c2 === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") i++;
        i++;
      }
      prev = c;
      continue;
    }
    // Regex literal: only when a `/` here can't be division.
    if (c === "/" && regexLead.indexOf(prev) !== -1) {
      i++;
      let inClass = false;
      while (i < source.length) {
        const r = source[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error(label + ": unbalanced braces in " + name);
}

// Lift the REAL cache + patcher functions out of shell.js and run them.
function loadCacheApi(source, label, store) {
  const keyM = source.match(/BUNDLE_CACHE_KEY\s*=\s*"([^"]+)"/);
  const verM = source.match(/BUNDLE_CACHE_VER\s*=\s*"([^"]+)"/);
  const maxM = source.match(/MAIN_BUNDLE_BODY_MAX\s*=\s*([^;,]+)/);
  if (!keyM) throw new Error(label + ": BUNDLE_CACHE_KEY not found");
  if (!verM) throw new Error(label + ": BUNDLE_CACHE_VER not found");
  if (!maxM) throw new Error(label + ": MAIN_BUNDLE_BODY_MAX not found");

  const code =
    'var BUNDLE_CACHE_KEY = "' +
    keyM[1] +
    '";\n' +
    'var BUNDLE_CACHE_VER = "' +
    verM[1] +
    '";\n' +
    "var MAIN_BUNDLE_BODY_MAX = " +
    maxM[1].trim() +
    ";\n" +
    extractFn(source, "readBundlePatchState", label) +
    "\n" +
    extractFn(source, "writeBundlePatchState", label) +
    "\n" +
    extractFn(source, "buildBundleSourcePatcher", label) +
    "\n" +
    "globalThis.__api = { read: readBundlePatchState, write: writeBundlePatchState, patcher: buildBundleSourcePatcher(), KEY: BUNDLE_CACHE_KEY, VER: BUNDLE_CACHE_VER, MAX: MAIN_BUNDLE_BODY_MAX };";

  const win = {};
  const sandbox = { localStorage: store.ls, window: win, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: sandbox.__api, win };
}

// ----------------------------------------------------------------------------
// PART 1 — behavioural: the REAL cache functions across simulated boots.
// ----------------------------------------------------------------------------
function behaviouralCache() {
  console.log("--- PART 1: cache read/write behaviour (real shell.js fns) ---");
  const store = makeStore();
  const { api, win } = loadCacheApi(src, "shell.js", store);
  const URL = "https://srv.example/web/main.jellyfin.bundle.js?v=abc123";

  check("BUNDLE_CACHE_KEY is " + EXPECTED_KEY, api.KEY === EXPECTED_KEY);

  // (Q3) no-patch verdict persists {v, url, needsPatch:false, body}, no patches.
  api.write({ url: URL, needsPatch: false, body: "var x=1;" });
  let rec = JSON.parse(store.raw.get(EXPECTED_KEY));
  check(
    "write(needsPatch=false) stores {v,url,needsPatch,body}",
    rec.v === api.VER &&
      rec.url === URL &&
      rec.needsPatch === false &&
      rec.body === "var x=1;",
    JSON.stringify(rec),
  );
  check(
    "no-patch record carries NO patches field",
    !("patches" in rec),
  );

  // (Q3) patched verdict persists patched body + patch count.
  api.write({ url: URL, needsPatch: true, body: "PATCHED", patches: 2 });
  rec = JSON.parse(store.raw.get(EXPECTED_KEY));
  check(
    "write(needsPatch=true) stores body + patches count",
    rec.needsPatch === true && rec.body === "PATCHED" && rec.patches === 2,
    JSON.stringify(rec),
  );

  // (Q4) read-back on a matching version returns the record (warm-boot source).
  const back = api.read();
  check(
    "read() returns the persisted record on matching version",
    back && back.url === URL && back.body === "PATCHED" && back.patches === 2,
  );

  // Version bust: a shell release that touches the patcher invalidates cache.
  const stale = JSON.parse(store.raw.get(EXPECTED_KEY));
  stale.v = "0.0.0-old";
  store.raw.set(EXPECTED_KEY, JSON.stringify(stale));
  check(
    "read() returns null when stored v != BUNDLE_CACHE_VER (release bust)",
    api.read() === null,
  );

  // Body over the 3 MB cap is rejected; verdict still persists.
  const store2 = makeStore();
  const a2 = loadCacheApi(src, "shell.js", store2).api;
  const huge = "x".repeat(a2.MAX + 10);
  a2.write({ url: URL, needsPatch: false, body: huge });
  rec = JSON.parse(store2.raw.get(EXPECTED_KEY));
  check(
    "body over MAIN_BUNDLE_BODY_MAX is dropped, verdict still stored",
    !("body" in rec) && rec.url === URL && rec.needsPatch === false,
  );

  // Quota fallback: setItem throws when body present → retry WITHOUT body,
  // and __shellMainBundleQuotaErr is flagged. needsPatch=true so the next
  // boot is forced to re-fetch+scan (the documented quota path).
  // quotaAt sits above the ~100-byte verdict-only JSON but below the
  // body-bearing record, so the body push trips quota and the retry succeeds.
  const small = "ABCDEF";
  const store3 = makeStore(150);
  const lifted3 = loadCacheApi(src, "shell.js", store3);
  lifted3.api.write({
    url: URL,
    needsPatch: true,
    body: small.repeat(40),
    patches: 1,
  });
  rec = store3.raw.has(EXPECTED_KEY)
    ? JSON.parse(store3.raw.get(EXPECTED_KEY))
    : null;
  check(
    "quota on body → verdict-only record survives (no body, no patches)",
    rec && rec.needsPatch === true && !("body" in rec) && !("patches" in rec),
    JSON.stringify(rec),
  );
  check(
    "quota path sets window.__shellMainBundleQuotaErr",
    lifted3.win.__shellMainBundleQuotaErr === 1,
  );

  // Corrupt JSON / disabled storage must not throw.
  const store4 = makeStore();
  store4.raw.set(EXPECTED_KEY, "{not json");
  const a4 = loadCacheApi(src, "shell.js", store4).api;
  let threw = false;
  try {
    check("read() on corrupt JSON returns null", a4.read() === null);
  } catch (_) {
    threw = true;
  }
  check("cache read never throws on corrupt storage", !threw);
}

// ----------------------------------------------------------------------------
// PART 2 — behavioural: the CM/PM serverId-null patcher actually patches.
// ----------------------------------------------------------------------------
function behaviouralPatcher() {
  console.log("\n--- PART 2: serverId=null regex patcher (real shell.js fn) ---");
  const { api } = loadCacheApi(src, "shell.js", makeStore());
  const patch = api.patcher;

  // The exact minified shape QA found in main.jellyfin.bundle.js (JEL-537):
  const real =
    'function(e){if(!e)throw new Error("item or serverId cannot be null");return e.ServerId&&(e=e.ServerId),this._apiClients.filter(function(t){return t.serverId()===e})[0]}';
  let r = patch(real);
  check(
    "patches the live single-check shape (function(e){if(!e)throw...})",
    r.patches === 1,
    "patches=" + r.patches,
  );
  check(
    "injects the window.ApiClient fallback recovery",
    /e==null&&window\.ApiClient\)return window\.ApiClient/.test(r.source),
  );
  check(
    "preserves the original throw as the final fall-through",
    /throw new Error\("item or serverId cannot be null"\)/.test(r.source),
  );

  // Legacy defensive double-check shape (older jellyfin-web bundles).
  const legacy =
    'function(e){if(!e||!e.ServerId)throw new Error("item or serverId cannot be null");return e}';
  check(
    "patches the legacy double-check shape (if(!e||!e.ServerId))",
    patch(legacy).patches === 1,
  );

  // Arrow form.
  const arrow =
    '(e)=>{if(!e)throw new Error("item or serverId cannot be null");return e}';
  check("patches the arrow form ((e)=>{if(!e)throw...})", patch(arrow).patches === 1);

  // A bundle WITHOUT the error string → 0 patches, source untouched. This is
  // why patchPlaybackBundles gates the patcher behind an indexOf() pre-check.
  const clean = "function(e){return e.ServerId}";
  r = patch(clean);
  check("clean bundle (no error string) yields 0 patches", r.patches === 0);
  check("clean bundle source is returned unchanged", r.source === clean);
}

// ----------------------------------------------------------------------------
// PART 3 — source contract: the legacy gate + warm-boot inline + verdict write.
// These are statements about patchPlaybackBundles / the fast path that the
// behavioural lift cannot reach (they touch document/DOM).
// ----------------------------------------------------------------------------
function ns(s) {
  return s.replace(/\s+/g, " ");
}

function sourceContract(label, code, isMin) {
  console.log("\n--- PART 3: source contract (" + label + ") ---");
  const flat = ns(code);

  // (Q1) patchPlaybackBundles exists and is INVOKED on the boot path.
  check(
    label + ": defines patchPlaybackBundles()",
    /function patchPlaybackBundles\(/.test(code),
  );
  check(
    label + ": patchPlaybackBundles is called on the boot/document path",
    /patchPlaybackBundles\(\s*doc/.test(flat) ||
      /patchPlaybackBundles\([a-z]+,[a-z]+,/i.test(flat),
  );

  // (Q1, the Compare crux) the scan is legacy-Chromium-ONLY. Modern browser
  // (and modern TV) early-returns and flags __shellBundlePatchSkipped=1.
  check(
    label + ": patchPlaybackBundles early-returns on !isLegacyChromium()",
    /!isLegacyChromium\(\)/.test(flat),
  );
  check(
    label + ": modern path sets __shellBundlePatchSkipped = 1 and resolves",
    /__shellBundlePatchSkipped\s*=\s*1/.test(flat) &&
      /Promise\.resolve\(\)/.test(flat),
  );

  // (Q2) only main.*.bundle.js is scanned, and only when the error string is
  // present (the indexOf pre-check before the regex patcher runs).
  check(
    label + ": restricts the scan to main.*.bundle.js",
    code.includes("main\\.[^/]*\\.bundle\\.js"),
  );
  check(
    label + ': applies the patcher only when "item or serverId cannot be null" is present',
    /indexOf\(\s*"item or serverId cannot be null"\s*\)\s*<\s*0/.test(flat),
  );

  // (Q3) both verdicts are persisted: no-patch (raw body) and patched body.
  check(
    label + ": persists the no-patch verdict (needsPatch:false + raw body)",
    /writeBundlePatchState\(\s*\{?\s*url[^}]*needsPatch\s*:\s*(?:false|!1)[^}]*body/.test(
      flat,
    ) ||
      /writeBundlePatchState\(\{url:url,needsPatch:!1,body:code\}\)/.test(flat),
  );
  check(
    label + ": persists the patched verdict (needsPatch:true + body + patches)",
    /needsPatch\s*:\s*(?:true|!0)/.test(flat) &&
      /body\s*:\s*result\.source/.test(flat) &&
      /patches\s*:\s*result\.patches/.test(flat),
  );

  // (Q4) warm boot inlines the cached body and strips the <script src> so the
  // network fetch is skipped. Two sites: patchPlaybackBundles DOM path and the
  // string fast path — both stamp data-shell-bundle-from-cache="1".
  check(
    label + ": warm boot matches cache.url === url before inlining",
    /cache\.url\s*===?\s*url/.test(flat) || /cache\.url\s*==\s*bundleUrl/.test(flat) || /cache\.url\s*!==?\s*bundleUrl/.test(flat),
  );
  check(
    label + ": warm boot inlines cached body via textContent + removeAttribute(src)",
    /removeAttribute\(\s*"src"\s*\)/.test(flat) &&
      (/textContent\s*=\s*cache\.body/.test(flat) ||
        /\.textContent\s*=\s*[a-zA-Z]+/.test(flat)),
  );
  check(
    label + ": warm-boot inline is tagged data-shell-bundle-from-cache=1",
    /data-shell-bundle-from-cache/.test(code),
  );
  // shell.js writes "</script"; the minifier escapes the slash to "<\/script".
  check(
    label + ": warm-boot inline guards against a </script literal in the body",
    /indexOf\(\s*"<\\?\/script"\s*\)\s*(?:<|>=?)\s*0/.test(flat),
  );

  if (!isMin) {
    // version bust wiring — readBundlePatchState compares p.v to the cache ver.
    check(
      label + ": read() invalidates on a version mismatch (p.v !== VER)",
      /p\.v\s*!==?\s*BUNDLE_CACHE_VER/.test(flat),
    );
  }
}

// ----------------------------------------------------------------------------
// PART 4 — parity: TV shell.js vs hosted boot-shell.src.js agree on the
// serverId fix + cache contract (the "Compare" deliverable).
// ----------------------------------------------------------------------------
function parity() {
  console.log("\n--- PART 4: parity (TV shell.js vs hosted boot-shell.src.js) ---");

  const tvKey = src.match(/BUNDLE_CACHE_KEY\s*=\s*"([^"]+)"/)[1];
  const hostedKey = hosted.match(/BUNDLE_CACHE_KEY\s*=\s*"([^"]+)"/)[1];
  check(
    "both shells use the identical key '" + EXPECTED_KEY + "'",
    tvKey === EXPECTED_KEY && hostedKey === EXPECTED_KEY,
    "tv=" + tvKey + " hosted=" + hostedKey,
  );

  const tvMax = src.match(/MAIN_BUNDLE_BODY_MAX\s*=\s*([^;,]+)/)[1].trim();
  const hostedMax = hosted.match(/MAIN_BUNDLE_BODY_MAX\s*=\s*([^;,]+)/)[1].trim();
  check(
    "both shells cap the cached body at the same 3 MB limit",
    tvMax === hostedMax,
    "tv=" + tvMax + " hosted=" + hostedMax,
  );

  check(
    "hosted shell ALSO legacy-gates patchPlaybackBundles (modern = skipped)",
    /!isLegacyChromium\(\)/.test(ns(hosted)) &&
      /__shellBundlePatchSkipped\s*=\s*1/.test(ns(hosted)),
  );

  // The patcher recovery contract — both shells inject the same window.ApiClient
  // fallback and preserve the original throw.
  for (const [label, code] of [
    ["TV shell.js", src],
    ["hosted boot-shell.src.js", hosted],
  ]) {
    const { api } = loadCacheApi(code, label, makeStore());
    const r = api.patcher(
      'function(e){if(!e)throw new Error("item or serverId cannot be null");return e}',
    );
    check(
      label + ": patcher repairs the live serverId-null shape (parity)",
      r.patches === 1 &&
        /window\.ApiClient\)return window\.ApiClient/.test(r.source),
    );
  }

  // Documented divergence (not a parity break): the bootstrap additionally
  // caches the vendors bundle and pins BUNDLE_CACHE_VER to a literal release
  // string, whereas shell.js carries the __SHELL_VER__ build token (substituted
  // to the widget version in shell.min.js). Both bust on a release change.
  check(
    "TV shell.js source carries the __SHELL_VER__ build token for the cache ver",
    /BUNDLE_CACHE_VER\s*=\s*"__SHELL_VER__"/.test(src),
  );
  check(
    "shell.min.js (release artifact) has __SHELL_VER__ substituted to a real version",
    /BUNDLE_CACHE_VER="\d+\.\d+\.\d+"/.test(min),
  );
}

// ----------------------------------------------------------------------------
behaviouralCache();
behaviouralPatcher();
sourceContract("shell.js", src, false);
sourceContract("shell.min.js (release artifact)", min, true);
parity();

console.log("");
if (failures) {
  console.error("JEL-56 bundle-patch contract: " + failures + " check(s) FAILED.");
  process.exit(1);
}
console.log("JEL-56 bundle-patch contract: all checks passed.");
