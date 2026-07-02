#!/usr/bin/env node
// JEL-620: build the slim vendored Babel bundle (babel.min.js) for BOTH
// shells, replacing @babel/standalone (3.13 MB retail / 2.4 MB bootstrap).
//
// WHY NOT @babel/standalone: it bundles every preset (react, typescript,
// flow), every proposal plugin, regenerator-transform and the corejs
// polyfill providers. The shells drive exactly ONE configuration —
//   presets: [["env", {targets:{chrome:"56"}, modules:false, loose:true}]]
// (JEL-354 pinned the chrome:56 floor at all call sites in both shells) —
// so the only plugins that can ever run are the ones preset-env selects
// for chrome 56. Empirically (preset-env 7.29.7, debug:true) that is:
//
//   transform-explicit-resource-management      { chrome < 141 }
//   transform-duplicate-named-capturing-groups-regex { chrome < 126 }
//   transform-regexp-modifiers                  { chrome < 125 }
//   transform-unicode-sets-regex                { chrome < 112 }
//   proposal-class-static-block                 { chrome < 94 }
//   proposal-private-property-in-object         { chrome < 91 }
//   proposal-class-properties                   { chrome < 74 }
//   proposal-private-methods                    { chrome < 84 }
//   proposal-numeric-separator                  { chrome < 75 }
//   proposal-logical-assignment-operators       { chrome < 85 }
//   proposal-nullish-coalescing-operator        { chrome < 80 }
//   proposal-optional-chaining                  { chrome < 91 }
//   proposal-json-strings                       { chrome < 66 }
//   proposal-optional-catch-binding             { chrome < 66 }
//   proposal-async-generator-functions          { chrome < 63 }
//   proposal-object-rest-spread                 { chrome < 60 }
//   transform-dotall-regex                      { chrome < 62 }
//   proposal-unicode-property-regex             { chrome < 64 }
//   transform-named-capturing-groups-regex      { chrome < 64 }
//   proposal-export-namespace-from              { chrome < 72 }
//   syntax-dynamic-import / top-level-await / import-meta
//
// This build keeps the REAL @babel/core and the REAL @babel/preset-env
// (so option plumbing — loose mapping, assumptions, targets filtering —
// stays byte-for-byte Babel behavior) and stubs only the plugins the
// chrome-56 selection can never activate, plus the polyfill providers
// (useBuiltIns is never set) and core-js-compat. If a future edit bumps
// the target above/below chrome 56, preset-env would select a stubbed
// plugin at runtime; the stub throws loudly instead of silently
// pass-through (see STUB_BODY), and the self-check below would fail the
// build first.
//
// Zero committed deps: like build_shell_min.py this script provisions its
// own toolchain — pinned versions npm-installed into a throwaway dir under
// $TMPDIR — so the workspace lockfile never carries Babel.
//
// Usage:
//   node packages/shell-tizen/scripts/build-babel-slim.mjs           # build + verify + write both bundles
//   node packages/shell-tizen/scripts/build-babel-slim.mjs --check   # build + verify only (no writes)
//
// After a write, regenerate BOTH min blobs (retail build_shell_min.py
// re-derives the __BABEL_FPR__ substitution; this script itself rewrites
// the boot-shell.src.js BABEL_FPR literal — bootstrap has no inject pass).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const RETAIL_BABEL = path.join(REPO, "packages", "shell-tizen", "src", "babel.min.js");
const BOOT_BABEL = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "babel.min.js");
const BOOT_SHELL_SRC = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.src.js");
const RETAIL_SHELL_SRC = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");

const CHECK_ONLY = process.argv.includes("--check");

// Toolchain pins. Bump deliberately; the self-check below re-proves the
// bundle against the shells' live MODERN_SYNTAX_RE + semantics fixtures.
const PIN = {
  "@babel/core": "7.29.7",
  "@babel/preset-env": "7.29.7",
  esbuild: "0.21.5",
};

// preset-env plugins that CAN activate at targets:{chrome:"56"} — keep real.
// (Debug-derived list above; package names use the transform- aliases that
// available-plugins.js requires.)
const KEEP_PLUGINS = new Set([
  "@babel/plugin-transform-explicit-resource-management",
  "@babel/plugin-transform-duplicate-named-capturing-groups-regex",
  "@babel/plugin-transform-regexp-modifiers",
  "@babel/plugin-transform-unicode-sets-regex",
  "@babel/plugin-transform-class-static-block",
  "@babel/plugin-transform-private-property-in-object",
  "@babel/plugin-transform-class-properties",
  "@babel/plugin-transform-private-methods",
  "@babel/plugin-transform-numeric-separator",
  "@babel/plugin-transform-logical-assignment-operators",
  "@babel/plugin-transform-nullish-coalescing-operator",
  "@babel/plugin-transform-optional-chaining",
  "@babel/plugin-transform-json-strings",
  "@babel/plugin-transform-optional-catch-binding",
  "@babel/plugin-transform-async-generator-functions",
  "@babel/plugin-transform-object-rest-spread",
  "@babel/plugin-transform-dotall-regex",
  "@babel/plugin-transform-unicode-property-regex",
  "@babel/plugin-transform-named-capturing-groups-regex",
  "@babel/plugin-transform-export-namespace-from",
  // syntax-dynamic-import / top-level-await / import-meta are inline no-op
  // factories inside available-plugins.js in preset-env 7.29 (parser
  // handles the syntax natively) — no packages to keep.
]);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

// ---------------------------------------------------------------------------
// 1. Provision pinned toolchain in a throwaway dir
// ---------------------------------------------------------------------------
const pinKey = Object.entries(PIN)
  .map(([k, v]) => `${k}@${v}`)
  .join("_")
  .replace(/[^\w.@-]+/g, "-");
const WORK = path.join(os.tmpdir(), `jellyplug-babel-slim-${pinKey}`);
fs.mkdirSync(WORK, { recursive: true });
if (!fs.existsSync(path.join(WORK, "node_modules", "@babel", "core"))) {
  console.log(`[babel-slim] installing pinned toolchain into ${WORK}`);
  fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "babel-slim-build", private: true }));
  sh("npm", ["install", "--no-audit", "--no-fund", "--no-save", ...Object.entries(PIN).map(([k, v]) => `${k}@${v}`)], { cwd: WORK, stdio: "inherit" });
}
const req = (m) => path.join(WORK, "node_modules", m);

// ---------------------------------------------------------------------------
// 2. Compute the stub set from preset-env's own plugin registry
// ---------------------------------------------------------------------------
const availSrc = fs.readFileSync(path.join(req("@babel/preset-env"), "lib", "available-plugins.js"), "utf8");
const allPlugins = new Set(
  [...availSrc.matchAll(/require\("(@babel\/plugin-[^"]+)"\)/g)].map((m) => m[1]),
);
for (const k of KEEP_PLUGINS) {
  if (!allPlugins.has(k) && !fs.existsSync(req(k))) {
    throw new Error(`KEEP plugin not found in preset-env registry or node_modules: ${k}`);
  }
}
const stubPlugins = [...allPlugins].filter((p) => !KEEP_PLUGINS.has(p));

// Loud stub: if preset-env ever selects one of these (target drifted away
// from chrome 56), fail the transform instead of silently not lowering.
const STUB_BODY = `"use strict";
function stubbed() { throw new Error("babel-slim: plugin stubbed out for chrome-56-only build (JEL-620): " + STUB_NAME); }
module.exports = stubbed; module.exports.default = stubbed;
module.exports.__esModule = true;
`;
const stubDir = path.join(WORK, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubFileFor = new Map();
let stubIdx = 0;
for (const p of stubPlugins) {
  const f = path.join(stubDir, `stub-${stubIdx++}.js`);
  fs.writeFileSync(f, `var STUB_NAME=${JSON.stringify(p)};\n${STUB_BODY}`);
  stubFileFor.set(p, f);
}
// Polyfill providers + their data: unreachable (useBuiltIns never set).
const emptyStub = path.join(stubDir, "empty.js");
fs.writeFileSync(emptyStub, `var STUB_NAME="polyfill-provider";\n${STUB_BODY}`);
for (const p of ["babel-plugin-polyfill-corejs2", "babel-plugin-polyfill-corejs3", "babel-plugin-polyfill-regenerator", "core-js-compat"]) {
  stubFileFor.set(p, emptyStub);
}

// Node-builtin shims for the few imports that survive @babel/core's
// browser-field mapping. Only what the browser code paths actually touch
// (configFile:false/babelrc:false keeps the fs-flavored config machinery
// dead); minimal implementations are fine.
const pathShim = path.join(stubDir, "path-shim.js");
fs.writeFileSync(
  pathShim,
  `"use strict";
function norm(p){return String(p==null?"":p);}
function basename(p,ext){var b=norm(p).replace(/\\/+$/,"").split("/").pop()||"";if(ext&&b.slice(-ext.length)===ext)b=b.slice(0,-ext.length);return b;}
function dirname(p){p=norm(p).replace(/\\/+$/,"");var i=p.lastIndexOf("/");return i<0?".":i===0?"/":p.slice(0,i);}
function extname(p){var b=basename(p);var i=b.lastIndexOf(".");return i<=0?"":b.slice(i);}
function join(){var parts=[];for(var i=0;i<arguments.length;i++){var s=norm(arguments[i]);if(s)parts.push(s);}return parts.join("/").replace(/\\/{2,}/g,"/")||".";}
function isAbsolute(p){return norm(p).charAt(0)==="/";}
function resolve(){var out="";for(var i=0;i<arguments.length;i++){var s=norm(arguments[i]);if(!s)continue;out=isAbsolute(s)?s:out?out+"/"+s:s;}return out||"/";}
function relative(a,b){return norm(b);}
var P={sep:"/",delimiter:":",basename:basename,dirname:dirname,extname:extname,join:join,resolve:resolve,relative:relative,isAbsolute:isAbsolute,normalize:norm};
P.posix=P;P.win32=P;
module.exports=P;module.exports.default=P;
`,
);
const assertShim = path.join(stubDir, "assert-shim.js");
fs.writeFileSync(
  assertShim,
  `"use strict";
function assert(v,m){if(!v)throw new Error(m||"assertion failed");}
assert.ok=assert;
assert.strictEqual=function(a,b,m){if(a!==b)throw new Error(m||"assert.strictEqual failed");};
assert.deepStrictEqual=function(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(m||"assert.deepStrictEqual failed");};
module.exports=assert;module.exports.default=assert;
`,
);
const builtinShims = {
  path: pathShim,
  assert: assertShim,
};

// ---------------------------------------------------------------------------
// 2b. Unicode property data for transform-unicode-property-regex (chrome<64).
// regexpu-core resolves its data with a BARE-package template-literal
// require (`regenerate-unicode-properties/${path}.js`) which esbuild cannot
// glob-bundle (relative paths only) — at runtime it silently fails and every
// \p{...} lowering dies with "Unknown property". Fix: generate a static
// require map for the property families plugin code can realistically use
// (General_Category \p{Letter}/\p{Lu}, Binary_Property \p{Alphabetic}/
// \p{Extended_Pictographic} emoji-strippers, Property_of_Strings) and
// rewrite that one require site to hit the map. Script/Script_Extensions
// (1.4 MB of the 2.3 MB data set, \p{Script=Han} style) are EXCLUDED —
// the map throws loudly so the transform fails visibly instead of emitting
// a wrong regex, and the shell's untranspiled-fallback path takes over.
const UNIDATA_DIRS = ["General_Category", "Binary_Property", "Property_of_Strings"];
const uniRoot = req("regenerate-unicode-properties");
const uniMapFile = path.join(stubDir, "jel620-unicode-data-map.js");
{
  const entries = [];
  for (const dir of UNIDATA_DIRS) {
    for (const f of fs.readdirSync(path.join(uniRoot, dir))) {
      if (!f.endsWith(".js")) continue;
      const key = `${dir}/${f.slice(0, -3)}`;
      const abs = path.join(uniRoot, dir, f).replace(/\\/g, "/");
      entries.push(`${JSON.stringify(key)}: function(){ return require(${JSON.stringify(abs)}); }`);
    }
  }
  fs.writeFileSync(
    uniMapFile,
    `"use strict";
var MAP = {\n  ${entries.join(",\n  ")}\n};
module.exports = function (p) {
  var f = MAP[p];
  if (!f) throw new Error("babel-slim: unicode property data excluded from chrome-56-only build (JEL-620): " + p);
  return f();
};
`,
  );
  console.log(`[babel-slim] unicode data map: ${entries.length} properties (${UNIDATA_DIRS.join(", ")}); Script/Script_Extensions excluded`);
}

// onLoad rewrite of the single dynamic-require site in regexpu-core.
const REGEXPU_DYNREQ = /return require\(`regenerate-unicode-properties\/\$\{\s*path\s*\}\.js`\);/;
const regexpuRewritePlugin = {
  name: "jel620-regexpu-unidata",
  setup(build) {
    build.onLoad({ filter: /regexpu-core[\\/]rewrite-pattern\.js$/ }, (args) => {
      let src = fs.readFileSync(args.path, "utf8");
      if (!REGEXPU_DYNREQ.test(src)) {
        throw new Error(`jel620-regexpu-unidata: dynamic-require site not found in ${args.path} — regexpu-core layout changed, update REGEXPU_DYNREQ`);
      }
      src =
        `const __JEL620_UNIDATA__ = require(${JSON.stringify(uniMapFile.replace(/\\/g, "/"))});\n` +
        src.replace(REGEXPU_DYNREQ, "return __JEL620_UNIDATA__(path);");
      return { contents: src, loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

// onResolve plugin instead of `alias`: catches SUBPATH imports of stubbed
// packages (e.g. core-js-compat/data) and node builtins uniformly.
const stubResolvePlugin = {
  name: "jel620-stubs",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      const spec = args.path;
      for (const [pkg, file] of stubFileFor) {
        if (spec === pkg || spec.startsWith(pkg + "/")) return { path: file };
      }
      const bare = spec.replace(/^node:/, "");
      if (builtinShims[bare]) return { path: builtinShims[bare] };
      return null;
    });
  },
};

// ---------------------------------------------------------------------------
// 3. Entry: window.Babel with the standalone-compatible transform() surface
// ---------------------------------------------------------------------------
const entry = path.join(WORK, "entry.js");
fs.writeFileSync(
  entry,
  `import { transformSync, version } from "@babel/core";
import presetEnv from "@babel/preset-env";

// The shells only ever name the "env" preset (BABEL_OPTS_KEY lockstep
// constant). Anything else is a build-scope violation -> throw loudly.
function resolvePreset(entry) {
  var name = entry, opts;
  if (Array.isArray(entry)) { name = entry[0]; opts = entry[1]; }
  if (typeof name !== "string") return entry; // already a preset object
  if (name === "env" || name === "@babel/preset-env" || name === "@babel/env" || name === "babel-preset-env") {
    return opts === undefined ? presetEnv : [presetEnv, opts];
  }
  throw new Error("babel-slim: unknown preset (chrome-56-only build, JEL-620): " + name);
}

function transform(code, options) {
  var opts = {};
  for (var k in options) opts[k] = options[k];
  if (opts.presets) opts.presets = opts.presets.map(resolvePreset);
  opts.babelrc = false;
  opts.configFile = false;
  return transformSync(code, opts);
}

var Babel = { version: version, transform: transform, transformSync: transform, buildFlavor: "jel620-slim-chrome56" };
var g = typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this;
g.Babel = Babel;
export default Babel;
`,
);

// process shim for @babel/* env sniffs that survive the defines.
const processShim = path.join(WORK, "process-shim.js");
fs.writeFileSync(processShim, `export var process = { env: {}, argv: [], platform: "browser", cwd: function () { return "/"; } };\n`);

// ---------------------------------------------------------------------------
// 4. Bundle with esbuild (API of the pinned install)
// ---------------------------------------------------------------------------
const esbuild = await import(path.join(req("esbuild"), "lib", "main.js").replace(/\\/g, "/")).then((m) => m.default || m);
const banner = `/* babel.min.js — JEL-620 slim chrome-56-only Babel build.
 * @babel/core ${PIN["@babel/core"]} + @babel/preset-env ${PIN["@babel/preset-env"]} with all
 * plugins preset-env cannot select at targets:{chrome:"56"} stubbed out.
 * Regenerate: node packages/shell-tizen/scripts/build-babel-slim.mjs
 * (then rebuild both min blobs; retail re-derives __BABEL_FPR__, this
 * script rewrites the boot-shell.src.js BABEL_FPR literal itself). */`;

async function bundle() {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    // Must PARSE on the runtime floor: Tizen 5.0/5.5 legacy WebViews
    // (Chromium 56-69). chrome56 keeps esbuild honest about syntax.
    target: ["chrome56"],
    minify: true,
    banner: { js: banner },
    legalComments: "none",
    plugins: [stubResolvePlugin, regexpuRewritePlugin],
    inject: [processShim],
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.BABEL_8_BREAKING": "false",
      "process.env.BABEL_TYPES_8_BREAKING": "false",
      "process.env.NODE_DEBUG": "false",
      "process.env.DEBUG": "false",
    },
    absWorkingDir: WORK,
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

let bundled = await bundle();
console.log(`[babel-slim] bundled: ${(bundled.length / 1024 / 1024).toFixed(2)} MB (was retail ${(fs.statSync(RETAIL_BABEL).size / 1024 / 1024).toFixed(2)} MB)`);

// ---------------------------------------------------------------------------
// 5. Self-check: load in vm, drive with the EXACT shell transform options,
//    prove lowering against the shells' live MODERN_SYNTAX_RE + semantics.
// ---------------------------------------------------------------------------
function loadBabel(srcText, label) {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcText, sandbox, { filename: label, timeout: 120000 });
  if (!sandbox.Babel || typeof sandbox.Babel.transform !== "function") {
    throw new Error(`${label}: window.Babel.transform missing after eval`);
  }
  return sandbox.Babel;
}

// Extract the live denylist regex from shell.js (same technique as
// plugin-syntax-transpile.test.cjs) so this check follows shell edits.
function extractReSrc(src, varName) {
  const m = new RegExp(varName + String.raw`\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)`).exec(src);
  if (!m) throw new Error(`cannot extract ${varName} from shell.js`);
  const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`));
  return parts.join("");
}
const shellSrc = fs.readFileSync(RETAIL_SHELL_SRC, "utf8");
const MODERN_SYNTAX_RE = new RegExp(extractReSrc(shellSrc, "MODERN_SYNTAX_RE_SRC"));

// The EXACT options the shells pass (babelTranspile + seed transpile fn +
// boot-shell mirror — BABEL_OPTS_KEY lockstep constant).
const SHELL_OPTS = {
  presets: [["env", { targets: { chrome: "56" }, modules: false, loose: true }]],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script",
  compact: true,
  comments: false,
};

// Feature corpus: everything chrome 56 lacks that preset-env lowers, each
// with a semantic assertion (lowered code must COMPUTE the same value).
const FIXTURES = [
  ["optional chaining", 'var o={a:{b:7}};R = o?.a?.b ?? 9;', 7],
  ["optional chaining call", 'var o={f:function(){return 3;}};R = o.f?.() ?? 0;', 3],
  ["nullish coalescing", "var x=null;R = x ?? 42;", 42],
  ["logical assignment or", "var a=0;a ||= 5;R = a;", 5],
  ["logical assignment and", "var b=1;b &&= 6;R = b;", 6],
  ["logical assignment nullish", "var c=null;c ??= 7;R = c;", 7],
  ["numeric separator", "R = 1_000_000;", 1000000],
  ["object spread", "var s={a:1};var t={...s,b:2};R = t.a+t.b;", 3],
  ["interior object spread", "var s={b:2};var t={a:1,...s,c:3};R = t.a+t.b+t.c;", 6],
  ["object rest", "var {a, ...rest} = {a:1,b:2,c:3};R = a + rest.b + rest.c;", 6],
  ["optional catch binding", "try { throw new Error('x'); } catch { R = 11; }", 11],
  ["class fields", "class K { v = 13; }\nR = new K().v;", 13],
  ["private class field", "class P { #v = 17; get(){ return this.#v; } }\nR = new P().get();", 17],
  ["static class field", "class S { static v = 19; }\nR = S.v;", 19],
  ["class static block", "class B { static v; static { B.v = 23; } }\nR = B.v;", 23],
  ["dotall regex", 'R = /a.b/s.test("a\\nb") ? 29 : 0;', 29],
  ["named capture groups", 'var m=/(?<num>\\d+)/.exec("x31");R = m.groups.num;', "31"],
  ["unicode property escape", 'R = /\\p{Letter}/u.test("k") ? 37 : 0;', 37],
  ["unicode property GC short", 'R = /\\p{Lu}/u.test("K") ? 41 : 0;', 41],
  ["unicode property GC= form", 'R = /\\p{General_Category=Number}/u.test("5") ? 43 : 0;', 43],
  ["unicode property binary (emoji)", 'R = /\\p{Extended_Pictographic}/u.test("\\u{1F600}") ? 47 : 0;', 47],
  [
    "async generators + for-await",
    "async function* gen(){ yield 1; yield 2; }\n(function(){ R = new Promise(function(res){ (async function(){ var s=0; for await (var v of gen()) s+=v; res(s); })(); }); })();",
    3,
    true, // async: R is a promise
  ],
];

async function verifyBundle(babelObj, label) {
  let failures = 0;
  for (const [name, src, expected, isAsync] of FIXTURES) {
    let out;
    try {
      out = babelObj.transform(src, SHELL_OPTS).code;
    } catch (e) {
      console.error(`FAIL [${label}] ${name}: transform threw: ${e.message}`);
      failures++;
      continue;
    }
    if (MODERN_SYNTAX_RE.test(out)) {
      console.error(`FAIL [${label}] ${name}: lowered output still matches MODERN_SYNTAX_RE:\n  ${out}`);
      failures++;
      continue;
    }
    const sb = { Promise, Error, console };
    sb.window = sb;
    sb.globalThis = sb;
    vm.createContext(sb);
    try {
      vm.runInContext(out, sb, { timeout: 10000 });
      let val = sb.R;
      if (isAsync) val = await val;
      if (val !== expected) {
        console.error(`FAIL [${label}] ${name}: expected ${expected}, got ${val}`);
        failures++;
        continue;
      }
    } catch (e) {
      console.error(`FAIL [${label}] ${name}: lowered code threw: ${e.message}\n  ${out}`);
      failures++;
      continue;
    }
    console.log(`OK [${label}] ${name}`);
  }
  return failures;
}

const slim = loadBabel(bundled, "slim-bundle");
console.log(`[babel-slim] slim bundle loads; Babel.version=${slim.version}`);
let failures = await verifyBundle(slim, "slim");

// Slim-only negative check: excluded Script/Script_Extensions data must fail
// LOUDLY at transform time (never silently emit a wrong regex). The fat
// shipped bundle carries this data, so this check does not run on baseline.
try {
  slim.transform('var r = /\\p{Script=Han}/u;', SHELL_OPTS);
  console.error("FAIL [slim] script-data exclusion: \\p{Script=Han} transform should have thrown");
  failures++;
} catch (e) {
  if (/Failed to recognize|excluded/.test(e.message)) {
    console.log("OK [slim] script-data exclusion throws loudly");
  } else {
    console.error(`FAIL [slim] script-data exclusion: unexpected error: ${e.message}`);
    failures++;
  }
}

// Baseline the OLD shipped bundle on the same corpus (informational parity —
// proves the slim build lowers everything the fat standalone did).
try {
  const old = loadBabel(fs.readFileSync(RETAIL_BABEL, "utf8"), "shipped-retail");
  if (old.buildFlavor !== "jel620-slim-chrome56") {
    console.log(`[babel-slim] baselining shipped retail bundle (Babel ${old.version})`);
    const oldFailures = await verifyBundle(old, "shipped");
    if (oldFailures > 0) console.log(`[babel-slim] note: shipped bundle failed ${oldFailures} fixture(s)`);
  }
} catch (e) {
  console.log(`[babel-slim] baseline skipped: ${e.message}`);
}

if (failures > 0) {
  console.error(`[babel-slim] ${failures} verification failure(s) — NOT writing`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 6. Write both vendored bundles + sync the boot-shell BABEL_FPR literal
// ---------------------------------------------------------------------------
function fingerprint(buf) {
  // Mirror of build_shell_min.py babel_fingerprint(): <len>:<first32hex>:<last32hex>
  const head = buf.subarray(0, 32).toString("hex");
  const tail = buf.length >= 32 ? buf.subarray(buf.length - 32).toString("hex") : head;
  return `${buf.length}:${head}:${tail}`;
}

const outBuf = Buffer.from(bundled, "utf8");
const fpr = fingerprint(outBuf);
console.log(`[babel-slim] fingerprint: ${fpr}`);

if (CHECK_ONLY) {
  console.log("[babel-slim] --check: verification passed, no files written");
  process.exit(0);
}

fs.writeFileSync(RETAIL_BABEL, outBuf);
fs.writeFileSync(BOOT_BABEL, outBuf);
console.log(`[babel-slim] wrote ${RETAIL_BABEL}`);
console.log(`[babel-slim] wrote ${BOOT_BABEL}`);

// boot-shell.src.js pins BABEL_FPR as a literal (no build-time inject pass —
// JEL-379); rewrite it here so TX_VER busts the on-TV transpile cache.
let bootSrc = fs.readFileSync(BOOT_SHELL_SRC, "utf8");
const fprRe = /(BABEL_FPR\s*=\s*\n?\s*")[0-9]+:[0-9a-f]+:[0-9a-f]+(")/;
if (!fprRe.test(bootSrc)) {
  console.error("[babel-slim] FATAL: BABEL_FPR literal not found in boot-shell.src.js — update it by hand");
  process.exit(1);
}
bootSrc = bootSrc.replace(fprRe, `$1${fpr}$2`);
fs.writeFileSync(BOOT_SHELL_SRC, bootSrc);
console.log(`[babel-slim] synced boot-shell.src.js BABEL_FPR literal`);
console.log("[babel-slim] NOW REGENERATE MIN BLOBS: build_shell_min.py (retail) + build_boot_shell.py (bootstrap)");
