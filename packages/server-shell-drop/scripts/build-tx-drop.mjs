#!/usr/bin/env node
/*
 * build-tx-drop.mjs — JEL-621: publish pre-lowered ES5 bundles into the
 * server's /shell/ drop so legacy TVs (Tizen 5.0 / Chromium 56) never run
 * Babel on the boot path.
 *
 * THE dominant cold-boot cost on Tizen 5.0 is Babel itself: the shell
 * serially transforms ~1.9 MB of plugin JS on the TV main thread (21-42 s
 * measured). This tool runs the EXACT same transform offline — it loads the
 * repo's vendored @babel/standalone (the same babel.min.js the TV would
 * load) with the byte-identical option literal from the shells — and writes:
 *
 *   <drop_dir>/tx/<fnv1a-of-source>.js   pre-lowered ES5 body per input
 *   <drop_dir>/tx-manifest.json          { format, babelOptsKey, entries }
 *
 * The shells fetch tx-manifest.json at boot (parallel with the /web/ RTT);
 * a slow-path script whose fetched source hashes to a manifest entry
 * downloads the pre-lowered body instead of loading Babel. The hash is the
 * same txFnv1a over the source TEXT that the JEL-178 `txc:` cache key uses,
 * so the drop stays correct across plugin config changes: new content, new
 * hash, manifest miss, on-device fallback — never a stale body.
 *
 * On-device safety gates (see shell.js loadTxDropManifest/txDropResolve):
 *   - manifest.babelOptsKey must equal the shell's BABEL_OPTS_KEY, and
 *   - every drop body must pass the STRICT fully-lowered oracle
 *     (MODERN_SYNTAX_RE) before it is inlined.
 * This builder enforces both at publish time and fails loudly otherwise.
 * The ORACLE_SRC / PRECHECK_SRC / BABEL_OPTS_KEY / fnv1a constants below are
 * lockstep-guarded against the shell sources by tx-drop-build.test.cjs.
 *
 * Inputs are explicit — this tool names no plugin (plugin-agnostic repo
 * policy, JEL-181/203/240). Point it at whatever your server actually
 * serves:
 *
 *   # everything the TV recorded on earlier boots + your snippet channel
 *   node build-tx-drop.mjs /var/www/jellyfin/shell \
 *     --url "https://server/MySnippetChannel/public.js" \
 *     --url-list tv-plugin-urls.txt \
 *     --web-index https://server
 *
 *   --url U        fetch one source URL (repeatable)
 *   --url-list F   file with one source URL per line (# comments ok)
 *   --dir D        every *.js file under D, recursively (repeatable)
 *   --web-index S  fetch S/web/index.html and process every non-bundle
 *                  <script src> on it (the same set the shell's static
 *                  pass would transpile)
 *   --babel P      path to babel.min.js (default: the repo's vendored
 *                  packages/shell-tizen/src/babel.min.js)
 *   --merge        keep existing manifest entries whose tx/ file survives
 *
 * Sources that don't trip the transpile PRE-check are skipped (the TV's
 * fast path inlines them raw; a drop entry would never be consulted).
 */

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---- Lockstep constants (guarded by tx-drop-build.test.cjs) --------------
// STRICT post-transpile oracle — must equal MODERN_SYNTAX_RE_SRC in
// packages/shell-tizen/src/shell.js + boot-shell.src.js.
export const ORACLE_SRC =
  "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await";
// Broader transpile PRE-check — must equal MODERN_PRECHECK_RE_SRC (JEL-417).
export const PRECHECK_SRC = ORACLE_SRC + "|,\\s*\\.\\.\\.[\\w$]";
// Canonical transform-option descriptor — must equal BABEL_OPTS_KEY in both
// shells; it is embedded in tx-manifest.json and checked on-device.
export const BABEL_OPTS_KEY =
  "presets:[[env,{targets:{chrome:56},modules:false,loose:true}]];sourceType:script;compact:true;comments:false";
// Transform options — must stay byte-lockstep with the seed-side
// transpile() literal in both shells (assumptions carry the JEL-26 fix).
export const BABEL_OPTS = {
  presets: [
    ["env", { targets: { chrome: "56" }, modules: false, loose: true }],
  ],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script",
  compact: true,
  comments: false,
};

// Same fnv1a-over-UTF-16-code-units the shells use (txFnv1a / seed __txFnv).
export function txFnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

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
    "usage: build-tx-drop.mjs <drop_dir> [--url U]... [--url-list F] " +
      "[--dir D]... [--web-index SERVER] [--babel P] [--merge]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    dropDir: null,
    urls: [],
    urlLists: [],
    dirs: [],
    webIndexes: [],
    babel: DEFAULT_BABEL,
    merge: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.urls.push(argv[++i]);
    else if (a === "--url-list") args.urlLists.push(argv[++i]);
    else if (a === "--dir") args.dirs.push(argv[++i]);
    else if (a === "--web-index") args.webIndexes.push(argv[++i]);
    else if (a === "--babel") args.babel = argv[++i];
    else if (a === "--merge") args.merge = true;
    else if (a.startsWith("--")) usageDie("unknown flag " + a);
    else if (!args.dropDir) args.dropDir = a;
    else usageDie("unexpected positional " + a);
  }
  if (!args.dropDir) usageDie("missing <drop_dir>");
  return args;
}

async function listJsFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJsFiles(p)));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return await r.text();
}

// Mirrors the shell's static-pass selection: every <script src> that is not
// a jellyfin-web webpack bundle (those are patched/replayed, never fed to
// the transpiler) and not an inline-scheme URL.
function scriptUrlsFromWebIndex(html, serverUrl) {
  const urls = [];
  const seen = new Set();
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^(?:data|blob|javascript):/i.test(src)) continue;
    if (/\.bundle\.js$/i.test(String(src).split("?")[0])) continue;
    let abs;
    try {
      abs = new URL(src, serverUrl + "/web/").href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    urls.push(abs);
  }
  return urls;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dropDir = path.resolve(args.dropDir);
  const txDir = path.join(dropDir, "tx");
  await fs.mkdir(txDir, { recursive: true });

  // Load the vendored @babel/standalone UMD — same bytes the TV would run,
  // so drop output is what the device would have produced itself.
  const require = createRequire(import.meta.url);
  const Babel = require(path.resolve(args.babel));
  if (!Babel || typeof Babel.transform !== "function")
    usageDie("could not load a usable @babel/standalone from " + args.babel);

  // Collect sources: [{ from, text }]
  const sources = [];
  for (const f of args.urlLists) {
    const body = await fs.readFile(f, "utf8");
    for (const line of body.split("\n")) {
      const u = line.trim();
      if (u && !u.startsWith("#")) args.urls.push(u);
    }
  }
  for (const server of args.webIndexes) {
    const base = server.replace(/\/+$/, "");
    let html;
    try {
      html = await fetchText(base + "/web/index.html");
    } catch (e) {
      console.warn("WARN: skip --web-index " + server + " — " + e.message);
      continue;
    }
    for (const u of scriptUrlsFromWebIndex(html, base)) args.urls.push(u);
  }
  for (const u of args.urls) {
    try {
      sources.push({ from: u, text: await fetchText(u) });
    } catch (e) {
      console.warn("WARN: skip " + u + " — " + e.message);
    }
  }
  for (const d of args.dirs) {
    for (const f of await listJsFiles(path.resolve(d))) {
      sources.push({ from: f, text: await fs.readFile(f, "utf8") });
    }
  }
  if (!sources.length) usageDie("no readable sources (use --url/--dir/...)");

  const entries = {};
  if (args.merge) {
    try {
      const prev = JSON.parse(
        await fs.readFile(path.join(dropDir, "tx-manifest.json"), "utf8"),
      );
      if (prev && prev.babelOptsKey === BABEL_OPTS_KEY && prev.entries) {
        for (const [h, rel] of Object.entries(prev.entries)) {
          try {
            await fs.access(path.join(dropDir, rel));
            entries[h] = rel;
          } catch {
            /* stale file — drop the entry */
          }
        }
      }
    } catch {
      /* no previous manifest — fresh build */
    }
  }

  let lowered = 0;
  let skipped = 0;
  for (const s of sources) {
    if (!PRECHECK_RE.test(s.text)) {
      skipped++;
      console.log("skip (ES5-safe, device fast-path): " + s.from);
      continue;
    }
    const hash = txFnv1a(s.text);
    const rel = "tx/" + hash + ".js";
    let out;
    try {
      out = Babel.transform(s.text, BABEL_OPTS).code;
    } catch (e) {
      console.error("ERROR: babel failed on " + s.from + " — " + e.message);
      process.exit(1);
    }
    if (typeof out !== "string" || !out.length || ORACLE_RE.test(out)) {
      // Publishing a body the device oracle would reject (or worse, one it
      // would accept but that still carries modern syntax) is a correctness
      // hazard — fail the whole build loudly.
      console.error(
        "ERROR: transform output for " + s.from + " failed the lowered oracle",
      );
      process.exit(1);
    }
    await fs.writeFile(path.join(dropDir, rel), out, "utf8");
    entries[hash] = rel;
    lowered++;
    console.log(
      "lowered: " +
        s.from +
        "  ->  " +
        rel +
        "  (" +
        s.text.length +
        " -> " +
        out.length +
        " bytes)",
    );
  }

  const manifest = {
    format: 1,
    babelOptsKey: BABEL_OPTS_KEY,
    generated: new Date().toISOString(),
    entries,
  };
  const outPath = path.join(dropDir, "tx-manifest.json");
  await fs.writeFile(outPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(
    "manifest  path=" +
      outPath +
      "  entries=" +
      Object.keys(entries).length +
      "  lowered=" +
      lowered +
      "  skipped=" +
      skipped,
  );
}

// Allow tx-drop-build.test.cjs to import the constants without running a
// build: only execute when invoked as a script.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error("ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
