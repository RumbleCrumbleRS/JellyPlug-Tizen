// JEL-56 — empirical runtime verification of the playback-bundle patch +
// BUNDLE_CACHE_KEY state cache, exercised under the TWO user-agent identities
// that decide its behaviour (TV WebView vs browser).
//
// Unlike the other tv-validate harnesses this one does NOT hit the Jellyfin
// server — the bundle patch is shell-internal, not server-driven. Instead it
// lifts the REAL functions (isLegacyChromium, patchPlaybackBundles,
// buildBundleSourcePatcher, read/writeBundlePatchState) verbatim out of
// shell.js into a vm sandbox with a fake DOM + fetch + localStorage, and runs
// the actual boot scan under:
//
//   • a legacy Tizen 5.0 WebView UA (Chromium 56)  → the real TV path
//   • a modern Chromium UA (Chrome 120)            → every desktop browser and
//                                                     modern Tizen TV
//
// It proves, by execution (not by reading source):
//   1. patchPlaybackBundles() is INVOKED on both UAs, but only the legacy UA
//      fetches + scans the main bundle; the modern UA early-returns and sets
//      window.__shellBundlePatchSkipped = 1.
//   2. The serverId=null CM/PM patch is applied to the legacy fetch when the
//      bundle carries "item or serverId cannot be null".
//   3. localStorage[BUNDLE_CACHE_KEY] is written with {v, url, needsPatch, body}
//      (+ patches) after the legacy scan.
//   4. A second (warm) legacy boot inlines the cached patched body — the
//      <script src> is stripped and NO network fetch occurs.
//
// Run: node tooling/tv-validate/bundle-patch/verify-bundle-patch.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const source = fs.readFileSync(SHELL, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Comment/string/regex-aware function extractor (the CM/PM patterns embed
// braces inside regex + string + comment context).
function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error("function " + name + " not found");
  const open = src.indexOf("{", start);
  const regexLead = "(,=:[!&|?{;";
  let depth = 0;
  let prev = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      prev = c;
      continue;
    }
    if (c === "/" && regexLead.indexOf(prev) !== -1) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
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
      if (depth === 0) return src.slice(start, i + 1);
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error("unbalanced braces in " + name);
}

const keyM = source.match(/BUNDLE_CACHE_KEY\s*=\s*"([^"]+)"/);
const verM = source.match(/BUNDLE_CACHE_VER\s*=\s*"([^"]+)"/);
const maxM = source.match(/MAIN_BUNDLE_BODY_MAX\s*=\s*([^;,]+)/);

const LIFTED =
  `var BUNDLE_CACHE_KEY = ${JSON.stringify(keyM[1])};\n` +
  `var BUNDLE_CACHE_VER = ${JSON.stringify(verM[1])};\n` +
  `var MAIN_BUNDLE_BODY_MAX = ${maxM[1].trim()};\n` +
  extractFn(source, "isLegacyChromium") +
  "\n" +
  extractFn(source, "readBundlePatchState") +
  "\n" +
  extractFn(source, "writeBundlePatchState") +
  "\n" +
  extractFn(source, "buildBundleSourcePatcher") +
  "\n" +
  extractFn(source, "patchPlaybackBundles") +
  "\n" +
  "globalThis.__run = { patchPlaybackBundles, readBundlePatchState, isLegacyChromium, KEY: BUNDLE_CACHE_KEY };";

// A faithful-enough <script> element: only the attrs/props the patcher touches.
function makeScript(srcAttr) {
  const attrs = { src: srcAttr };
  return {
    _attrs: attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
    textContent: "",
  };
}

// Build a sandbox simulating one boot under a given UA + optional optional-
// chaining support (Chromium 56 cannot parse `a?.b` → new Function throws).
function makeSandbox(userAgent, supportsOptionalChaining, fetchImpl, store) {
  const map = store || new Map();
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const sandbox = {
    navigator: { userAgent },
    window: {},
    console,
    localStorage,
    fetch: fetchImpl,
    URL,
    Promise,
    Array,
    parseInt,
    // Chromium 56 throws a SyntaxError compiling optional chaining; emulate the
    // `new Function("var a={};return a?.b")` probe inside isLegacyChromium.
    Function: supportsOptionalChaining
      ? Function
      : function () {
          const body = arguments[arguments.length - 1] || "";
          if (/\?\./.test(body)) throw new SyntaxError("unexpected token");
          return Function.apply(null, arguments);
        },
    _map: map,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, map, localStorage };
}

const MAIN_URL = "https://srv.example/web/main.jellyfin.bundle.js?v=hashAAA";
// A minified main bundle carrying the exact serverId-null throw QA found.
const BUNDLE_WITH_THROW =
  'var a=1;var gac=function(e){if(!e)throw new Error("item or serverId cannot be null");return e.ServerId&&(e=e.ServerId),e};var b=2;';

function freshDoc() {
  const script = makeScript("./main.jellyfin.bundle.js?v=hashAAA");
  return {
    script,
    querySelectorAll: () => [script],
  };
}

// ---------------------------------------------------------------------------
// SCENARIO 1 — legacy Tizen WebView (Chromium 56): cold boot.
// ---------------------------------------------------------------------------
async function legacyColdBoot() {
  console.log("\n--- Scenario 1: legacy Tizen WebView (Chromium 56), cold boot ---");
  let fetched = 0;
  const fetchImpl = (u) => {
    fetched++;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(BUNDLE_WITH_THROW) });
  };
  const { sandbox, map } = makeSandbox(
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36",
    false,
    fetchImpl,
    new Map(),
  );
  vm.createContext(sandbox);
  vm.runInContext(LIFTED, sandbox);
  const doc = freshDoc();
  await sandbox.__run.patchPlaybackBundles(doc, MAIN_URL, null);

  check("legacy UA is detected as legacy Chromium", sandbox.__run.isLegacyChromium());
  check("legacy boot does NOT set __shellBundlePatchSkipped", !sandbox.window.__shellBundlePatchSkipped);
  check("legacy boot fetched the main bundle once", fetched === 1, "fetched=" + fetched);
  check("legacy boot scanned 1 bundle", sandbox.window.__shellBundlesScanned === 1);
  check("legacy boot applied >=1 serverId-null patch", sandbox.window.__shellBundlePatches >= 1, "patches=" + sandbox.window.__shellBundlePatches);
  check(
    "patched <script> has src stripped and patched body inlined",
    doc.script.getAttribute("src") === null &&
      /window\.ApiClient/.test(doc.script.textContent) &&
      doc.script.getAttribute("data-shell-bundle-patched") === MAIN_URL,
  );
  const rec = map.has(sandbox.__run.KEY) ? JSON.parse(map.get(sandbox.__run.KEY)) : null;
  check(
    "BUNDLE_CACHE_KEY written with {v,url,needsPatch:true,body,patches}",
    rec &&
      rec.v === verM[1] &&
      rec.url === MAIN_URL &&
      rec.needsPatch === true &&
      typeof rec.body === "string" &&
      /window\.ApiClient/.test(rec.body) &&
      rec.patches >= 1,
    JSON.stringify({ ...rec, body: rec && rec.body ? "<" + rec.body.length + "B>" : rec && rec.body }),
  );
  return map; // hand the warm cache to scenario 3
}

// ---------------------------------------------------------------------------
// SCENARIO 2 — modern Chromium (Chrome 120): browser AND modern TV.
// ---------------------------------------------------------------------------
async function modernBoot() {
  console.log("\n--- Scenario 2: modern Chromium (Chrome 120) — browser / modern TV ---");
  let fetched = 0;
  const fetchImpl = () => {
    fetched++;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(BUNDLE_WITH_THROW) });
  };
  const { sandbox, map } = makeSandbox(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    true,
    fetchImpl,
    new Map(),
  );
  vm.createContext(sandbox);
  vm.runInContext(LIFTED, sandbox);
  const doc = freshDoc();
  await sandbox.__run.patchPlaybackBundles(doc, MAIN_URL, null);

  check("modern UA is NOT detected as legacy Chromium", !sandbox.__run.isLegacyChromium());
  check("modern boot sets __shellBundlePatchSkipped = 1", sandbox.window.__shellBundlePatchSkipped === 1);
  check("modern boot performs NO bundle fetch", fetched === 0, "fetched=" + fetched);
  check("modern boot leaves the <script src> untouched", doc.script.getAttribute("src") === "./main.jellyfin.bundle.js?v=hashAAA");
  check("modern boot writes NOTHING to BUNDLE_CACHE_KEY", !map.has(sandbox.__run.KEY));
}

// ---------------------------------------------------------------------------
// SCENARIO 3 — legacy WebView, WARM boot: cache from scenario 1 is reused.
// ---------------------------------------------------------------------------
async function legacyWarmBoot(warmCache) {
  console.log("\n--- Scenario 3: legacy Tizen WebView, warm boot (cache primed) ---");
  let fetched = 0;
  const fetchImpl = () => {
    fetched++;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(BUNDLE_WITH_THROW) });
  };
  const { sandbox, map } = makeSandbox(
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36",
    false,
    fetchImpl,
    warmCache,
  );
  vm.createContext(sandbox);
  vm.runInContext(LIFTED, sandbox);
  const doc = freshDoc();
  await sandbox.__run.patchPlaybackBundles(doc, MAIN_URL, null);

  check("warm boot performs NO network fetch (cached body reused)", fetched === 0, "fetched=" + fetched);
  check("warm boot reports a cache body hit", sandbox.window.__shellBundleCacheBodyHit >= 1);
  check(
    "warm boot inlines the cached patched body and strips src",
    doc.script.getAttribute("src") === null &&
      doc.script.getAttribute("data-shell-bundle-from-cache") === "1" &&
      /window\.ApiClient/.test(doc.script.textContent),
  );
  check(
    "warm-boot patch count carries over from the cached record",
    sandbox.window.__shellBundlePatches >= 1,
    "patches=" + sandbox.window.__shellBundlePatches,
  );
}

const warm = await legacyColdBoot();
await modernBoot();
await legacyWarmBoot(warm);

console.log("");
if (failures) {
  console.error("JEL-56 runtime verification: " + failures + " check(s) FAILED.");
  process.exit(1);
}
console.log("JEL-56 runtime verification: all checks passed.");
