#!/usr/bin/env node
/*
 * jsi-minify-es5.mjs — JEL-632: minify + ES5-lower snippet sources at DEPLOY
 * time, before they are written into the server's script-injection plugin
 * config (the channel the TV shell fetches as one concatenated public.js).
 *
 * Why: the live channel is ~70 snippets / ~1.22MB of unminified modern JS.
 * Every body that trips the shell's transpile PRE-check forces an on-TV
 * Babel pass (the dominant Tizen boot cost, JEL-616/618). Running the SAME
 * lowering offline — plus real minification — makes refresh boots
 * download-only: the shell's precheck sees plain lowered JS, keeps
 * needsTranspile=false, and inlines the body raw.
 *
 * The output contract is therefore stricter than "valid ES5": every emitted
 * body must NOT match MODERN_PRECHECK_RE (the shell's transpile trigger,
 * JEL-417). The shell's own chrome:56 transform is not enough for that —
 * preset-env keeps ES2015 array/call spread and rest params (Chrome 56
 * parses them), and `f(a, ...b)` / `(a, ...r)` match the precheck's
 * `,\s*\.\.\.` alternative, which would re-trigger on-TV Babel and forfeit
 * the payoff. So the deploy transform runs the lockstep chrome:56 options
 * PLUS transform-spread/transform-parameters to clear every `...` form the
 * precheck can see. Correctness gate: any output that still trips the
 * precheck fails the whole run loudly.
 *
 * Minification is esbuild (target chrome56) in transform mode, which keeps
 * TOP-LEVEL names intact — snippets share globals across entries (one
 * declares a helper, another calls it), so top-level mangling would break
 * the channel. Only inner scopes are mangled. Each output is forced to end
 * in `;` so concatenation into one public.js stays statement-safe.
 *
 * Inputs are explicit — this tool names no plugin (JEL-181/203/240):
 *
 *   node jsi-minify-es5.mjs --dir snippets/ --out-dir build/snippets/
 *   node jsi-minify-es5.mjs --file jel4xx-feature.js --in-place
 *   cat snippet.js | node jsi-minify-es5.mjs --stdin > snippet.min.js
 *
 *   --file F      one snippet file (repeatable)
 *   --dir D       every *.js under D, recursively (repeatable)
 *   --stdin       read one snippet from stdin, write result to stdout
 *   --out-dir O   write results under O (mirrors --dir relative paths;
 *                 --file basenames land at O/<name>)
 *   --in-place    overwrite inputs (deploy-pipeline mode)
 *   --suffix S    default when neither --out-dir nor --in-place is given:
 *                 write next to the input as <name><S>.js (default .min)
 *   --babel P     path to @babel/standalone UMD (default: this repo's
 *                 vendored packages/shell-tizen/src/babel.min.js — the same
 *                 bytes the TV runs, so lowering is device-faithful)
 *   --no-minify   lower + verify only (when esbuild is unavailable in the
 *                 calling workspace); output is still precheck-clean
 *
 * Exit is non-zero if ANY input fails to transform or verify — this is a
 * deploy gate, not a best-effort filter.
 */

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---- Lockstep constants (guarded by jsi-minify.test.cjs) ------------------
// STRICT post-transpile oracle — must equal MODERN_SYNTAX_RE_SRC in
// packages/shell-tizen/src/shell.js + boot-shell.src.js.
export const ORACLE_SRC =
  "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await";
// Broader transpile PRE-check — must equal MODERN_PRECHECK_RE_SRC (JEL-417).
// This is the shell's needsTranspile trigger and therefore THE verification
// gate here: precheck-clean output is what buys the raw fast path.
export const PRECHECK_SRC = ORACLE_SRC + "|,\\s*\\.\\.\\.[\\w$]";
// Lockstep transform base — must stay byte-lockstep with the shells'
// transform options (assumptions carry the JEL-26 iterator fix). The extra
// plugins below are a DEPLOY-ONLY superset: they only lower ES2015 spread /
// rest forms Chrome 56 could run natively, so device behavior is unchanged;
// they exist purely to clear the precheck's `...` alternatives.
export const BABEL_LOWER_OPTS = {
  presets: [
    ["env", { targets: { chrome: "56" }, modules: false, loose: true }],
  ],
  plugins: [["transform-spread", { loose: true }], "transform-parameters"],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script",
  compact: true,
  comments: false,
};
// esbuild floor for the minify pass. chrome56 (not es5) so the minifier
// never emits syntax the panels lack, while post-Babel output passes
// through untouched syntactically.
export const ESBUILD_TARGET = "chrome56";

const ORACLE_RE = new RegExp(ORACLE_SRC);
const PRECHECK_RE = new RegExp(PRECHECK_SRC);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BABEL = path.join(
  HERE,
  "..",
  "..",
  "shell-tizen",
  "src",
  "babel.min.js",
);

function usageDie(msg) {
  console.error("ERROR: " + msg);
  console.error(
    "usage: jsi-minify-es5.mjs [--file F]... [--dir D]... [--stdin] " +
      "[--out-dir O | --in-place | --suffix S] [--babel P] [--no-minify]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    files: [],
    dirs: [],
    stdin: false,
    outDir: null,
    inPlace: false,
    suffix: ".min",
    babel: DEFAULT_BABEL,
    minify: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.files.push(argv[++i]);
    else if (a === "--dir") args.dirs.push(argv[++i]);
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--in-place") args.inPlace = true;
    else if (a === "--suffix") args.suffix = argv[++i];
    else if (a === "--babel") args.babel = argv[++i];
    else if (a === "--no-minify") args.minify = false;
    else usageDie("unknown argument " + a);
  }
  if (!args.stdin && !args.files.length && !args.dirs.length)
    usageDie("no inputs (use --file/--dir/--stdin)");
  if (args.stdin && (args.files.length || args.dirs.length))
    usageDie("--stdin cannot be combined with --file/--dir");
  if (args.outDir && args.inPlace)
    usageDie("--out-dir and --in-place are mutually exclusive");
  return args;
}

async function listJsFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJsFiles(p)));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function loadBabel(babelPath) {
  const require = createRequire(import.meta.url);
  const Babel = require(path.resolve(babelPath));
  if (!Babel || typeof Babel.transform !== "function")
    usageDie("could not load a usable @babel/standalone from " + babelPath);
  return Babel;
}

function loadEsbuild() {
  const require = createRequire(import.meta.url);
  try {
    return require("esbuild");
  } catch {
    return null;
  }
}

// Transform one snippet body. Throws on any failure; the caller decides
// whether that aborts the run (it does — deploy gate).
export function transformSnippet(text, { Babel, esbuild, minify }) {
  let body = text;
  // Lower whenever the shell's precheck would: same trigger, same floor.
  // (Bodies that are already precheck-clean skip Babel and only minify.)
  if (PRECHECK_RE.test(body)) {
    const out = Babel.transform(body, BABEL_LOWER_OPTS);
    if (!out || typeof out.code !== "string" || !out.code.length)
      throw new Error("babel produced no output");
    body = out.code;
  }
  if (minify) {
    body = esbuild.transformSync(body, {
      loader: "js",
      minify: true,
      target: ESBUILD_TARGET,
    }).code;
  }
  // The channel is served as ONE concatenated file; make each body a
  // self-terminating statement so neighbors can't merge into a call/index
  // expression.
  body = body.replace(/\s+$/, "");
  if (!body.endsWith(";")) body += ";";
  body += "\n";
  // Deploy gate: precheck-clean is the success condition (raw fast path on
  // TV, no babelTranspile). ORACLE_RE ⊂ PRECHECK_RE, so this covers the
  // device's post-transpile oracle too; both are asserted for clarity.
  if (PRECHECK_RE.test(body) || ORACLE_RE.test(body))
    throw new Error("output still trips the shell transpile precheck");
  return body;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const Babel = loadBabel(args.babel);
  const esbuild = args.minify ? loadEsbuild() : null;
  if (args.minify && !esbuild)
    usageDie(
      "esbuild is not resolvable from this workspace — install it or pass --no-minify",
    );
  const ctx = { Babel, esbuild, minify: args.minify };

  if (args.stdin) {
    const out = transformSnippet(await readStdin(), ctx);
    process.stdout.write(out);
    return;
  }

  // Collect [{ src, outPath }] — --dir inputs mirror their relative path
  // under --out-dir so same-named snippets in different folders can't
  // clobber each other.
  const jobs = [];
  for (const f of args.files) {
    const src = path.resolve(f);
    jobs.push({ src, rel: path.basename(src) });
  }
  for (const d of args.dirs) {
    const base = path.resolve(d);
    for (const f of await listJsFiles(base))
      jobs.push({ src: f, rel: path.relative(base, f) });
  }
  if (!jobs.length) usageDie("inputs matched no .js files");

  let inBytes = 0;
  let outBytes = 0;
  for (const job of jobs) {
    const text = await fs.readFile(job.src, "utf8");
    let out;
    try {
      out = transformSnippet(text, ctx);
    } catch (e) {
      console.error("ERROR: " + job.src + " — " + e.message);
      process.exit(1);
    }
    let dest;
    if (args.inPlace) dest = job.src;
    else if (args.outDir) dest = path.join(path.resolve(args.outDir), job.rel);
    else
      dest = path.join(
        path.dirname(job.src),
        path.basename(job.src, ".js") + args.suffix + ".js",
      );
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, out, "utf8");
    inBytes += text.length;
    outBytes += out.length;
    console.log(
      job.src + " -> " + dest + " (" + text.length + " -> " + out.length + ")",
    );
  }
  console.log(
    "done: " +
      jobs.length +
      " snippet(s), " +
      inBytes +
      " -> " +
      outBytes +
      " bytes (" +
      (inBytes ? Math.round((100 * outBytes) / inBytes) : 100) +
      "%), all precheck-clean (device fast path)",
  );
}

// Allow jsi-minify.test.cjs to import the constants/transform without
// running the CLI: only execute when invoked as a script.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error("ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
