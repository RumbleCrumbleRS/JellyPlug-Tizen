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
 *   --no-dyn-scan  skip the JELA-186 dynamic-module discovery pass
 *
 * Sources that don't trip the transpile PRE-check are skipped (the TV's
 * fast path inlines them raw; a drop entry would never be consulted).
 *
 * JELA-186: after lowering, every URL-fetched body is scanned for the
 * dynamic module URLs it would inject at runtime (mirror of the seed's
 * __txScrapeBodies — plugin-agnostic, regex-driven); discovered modules are
 * fetched and lowered into the drop too, so on-device dynamic injection
 * drop-HITs and Babel never loads. Capped at 200 fetch attempts.
 */

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// ---- Lockstep constants (guarded by tx-drop-build.test.cjs) --------------
// STRICT post-transpile oracle — MODERN_SYNTAX_RE_SRC from
// packages/shell-tizen/src/shell.js + boot-shell.src.js, with ONE token
// refined (JELA-186): the shells' numeric-separator check `\d_\d` matches
// digit_digit ANYWHERE, including inside plain identifiers (a fleet plugin
// names properties `iso_3166_1`), which vetoed publishing two perfectly
// lowered bodies. The publish gate instead requires the digit run to start
// a numeric token — preceded by start/non-identifier, optionally `.` for
// bare fractions — so identifiers can't trip it while every real separator
// (1_000, 0x1F_2A, 0b1_0, 1.5_1, 1e1_0, 1_0n) still matches. Device-side
// acceptance is the JELA-11 parse probe on every real engine (regex is its
// fallback), so the shells keep the stricter token unchanged.
export const ORACLE_NUMSEP_LEGACY = "\\d_\\d";
export const ORACLE_NUMSEP = "(^|[^\\w$])\\.?\\d[\\w.]*_[\\da-fA-F]";
export const ORACLE_SRC =
  "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|" +
  ORACLE_NUMSEP +
  "|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await";
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

// JELA-186 dynamic-module discovery — lockstep with the seed __txScrapeBodies
// REL/ABS regex literals in both shells (tx-drop-build.test.cjs guards the
// compiled .source against the shell lines byte-for-byte). REL collects
// quoted script-name literals (relative names group for dir-probing,
// absolute paths are exact candidates); ABS collects quoted absolute dir
// literals that could host the relative names.
export const SCRAPE_REL_SRC =
  "([\"'])(/?[A-Za-z0-9_@%-]+(?:/[A-Za-z0-9_@%.-]+)*\\.js)(\\?[^\"']*)?\\1";
export const SCRAPE_ABS_SRC =
  "([\"'])(/[A-Za-z0-9_@%-]+(?:/[A-Za-z0-9_@%-]+){0,4})\\1";
// Builder-only supplement (no seed sibling): chrome-56-targeted Babel does
// NOT lower template literals (56 supports them), so a module URL built as
// `/dir/name.js?v=${ver}` survives lowering in backticks and the
// quote-anchored REL regex above can't see it — the seed shares that blind
// spot (it's covered on-device only by runtime interception recording). The
// builder additionally scrapes backtick literals whose STATIC prefix is a
// complete .js path; interpolation is only tolerated after the `?`.
export const SCRAPE_TPL_SRC =
  "`(/?[A-Za-z0-9_@%-]+(?:/[A-Za-z0-9_@%.-]+)*\\.js)(\\?[^`]*)?`";

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
      "[--dir D]... [--web-index SERVER] [--babel P] [--merge] [--no-dyn-scan]",
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
    noDynScan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.urls.push(argv[++i]);
    else if (a === "--url-list") args.urlLists.push(argv[++i]);
    else if (a === "--dir") args.dirs.push(argv[++i]);
    else if (a === "--web-index") args.webIndexes.push(argv[++i]);
    else if (a === "--babel") args.babel = argv[++i];
    else if (a === "--merge") args.merge = true;
    else if (a === "--no-dyn-scan") args.noDynScan = true;
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

// Mirror of the seed's __txScrapeBodies (JELA-186), one body at a time:
// relative .js name literals need a base dir, so collect quoted absolute dir
// literals from the same body (capped 6, no dots, ≤64 chars, ranked
// /js|/scripts|/modules last-segment first) plus the source's own directory;
// the driver probes names[0] across them and commits to the dir that answers
// with JS. Absolute .js literals are exact candidates as-is.
export function scrapeDynamicRefs(body, from) {
  const REL = new RegExp(SCRAPE_REL_SRC, "g");
  const ABS = new RegExp(SCRAPE_ABS_SRC, "g");
  body = String(body || "");
  from = String(from || "");
  const exact = [];
  const names = [];
  const seenN = new Set();
  const dirs = [];
  const seenD = new Set();
  let m;
  while ((m = REL.exec(body)) && names.length < 80) {
    const nm = m[2];
    if (seenN.has(nm)) continue;
    seenN.add(nm);
    if (nm.charAt(0) === "/") exact.push(nm);
    else names.push(nm);
  }
  const TPL = new RegExp(SCRAPE_TPL_SRC, "g");
  while ((m = TPL.exec(body)) && names.length < 80) {
    const nm = m[1];
    if (seenN.has(nm)) continue;
    seenN.add(nm);
    if (nm.charAt(0) === "/") exact.push(nm);
    else names.push(nm);
  }
  if (!names.length) return { exact, groups: [] };
  while ((m = ABS.exec(body)) && dirs.length < 6) {
    const d = m[2];
    if (d.indexOf(".") >= 0 || d.length > 64 || seenD.has(d)) continue;
    seenD.add(d);
    dirs.push(d);
  }
  dirs.sort(
    (a, b) =>
      (/\/(js|scripts|modules)$/.test(a) ? 0 : 1) -
      (/\/(js|scripts|modules)$/.test(b) ? 0 : 1),
  );
  if (from) {
    const qi = from.indexOf("?");
    const fp = qi < 0 ? from : from.slice(0, qi);
    const sl = fp.lastIndexOf("/");
    if (sl > 0 && !seenD.has(fp.slice(0, sl))) dirs.push(fp.slice(0, sl));
  }
  return { exact, groups: dirs.length ? [{ dirs, names }] : [] };
}

// JELA-186 discovery driver: scan every final (device-visible) static body
// for the dynamic module URLs it would inject at runtime, fetch them, and
// hand them to the same lower pipeline — so drop-injected dynamic modules
// drop-HIT and the device never lazy-loads Babel. finals = [{ from, body }]
// where body is what the device would inline (lowered output, or raw text
// for ES5-safe sources). seenUrls carries the already-fetched static URL
// set; cap bounds total fetch attempts (probes included).
export async function discoverDynamicSources(finals, seenUrls, cap, fetchFn) {
  const grab = fetchFn || fetchText;
  const out = [];
  let attempts = 0;
  const norm = (base, u) => {
    let abs;
    try {
      abs = new URL(u, base).href;
    } catch {
      return null;
    }
    try {
      if (new URL(abs).origin !== new URL(base).origin) return null;
    } catch {
      return null;
    }
    if (/\.bundle\.js$/i.test(String(abs).split("?")[0])) return null;
    if (seenUrls.has(abs)) return null;
    seenUrls.add(abs);
    return abs;
  };
  const tryFetch = async (abs) => {
    if (attempts >= cap) return null;
    attempts++;
    try {
      const text = await grab(abs);
      // Probing candidate dirs can 200 an HTML SPA-fallback page; a scraped
      // "module" that isn't JS must not win a probe or poison the drop.
      if (/^\s*</.test(text)) return null;
      return text;
    } catch {
      return null;
    }
  };
  for (const f of finals) {
    if (attempts >= cap) break;
    if (!/^https?:/i.test(f.from)) continue; // dir-file sources have no origin
    const { exact, groups } = scrapeDynamicRefs(f.body, f.from);
    for (const p of exact) {
      const abs = norm(f.from, p);
      if (!abs) continue;
      const text = await tryFetch(abs);
      if (text != null) out.push({ from: abs, text });
    }
    for (const g of groups) {
      // Probe names[0] across candidate dirs in rank order; the first dir
      // that answers with JS wins the whole group (mirror of the seed's
      // probe(), which keeps the lowest-ranked success).
      let win = null;
      for (const d of g.dirs) {
        const abs = norm(f.from, d + "/" + g.names[0]);
        if (!abs) continue;
        const text = await tryFetch(abs);
        if (text != null) {
          out.push({ from: abs, text });
          win = d;
          break;
        }
      }
      if (win == null) continue;
      for (let i = 1; i < g.names.length; i++) {
        const abs = norm(f.from, win + "/" + g.names[i]);
        if (!abs) continue;
        const text = await tryFetch(abs);
        if (text != null) out.push({ from: abs, text });
      }
    }
  }
  if (attempts >= cap)
    console.warn(
      "WARN: dynamic-scan fetch cap (" +
        cap +
        ") reached — discovery may be incomplete",
    );
  return out;
}

// Load the repo's vendored babel and return its { transform } object.
// Two shapes are supported so the builder tracks whatever babel.min.js the
// shells actually ship:
//   1. A UMD @babel/standalone (pre-JEL-620): CommonJS require() yields the
//      module directly.
//   2. The JEL-620 slim chrome56 build: an esbuild IIFE that assigns
//      (window||self||globalThis).Babel — exactly what the TV runs from a
//      <script> tag. Execute it in an isolated realm (globalThis === the
//      sandbox) and read the global back, so the offline transform is the
//      byte-for-byte transform the device would have produced itself.
function loadBabel(babelPath) {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(babelPath);
    if (mod && typeof mod.transform === "function") return mod;
  } catch (_) {
    // Not a CommonJS module (the slim build is a browser IIFE) — fall through.
  }
  const code = readFileSync(babelPath, "utf8");
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: babelPath });
  const Babel = sandbox.Babel;
  return Babel && typeof Babel.transform === "function" ? Babel : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dropDir = path.resolve(args.dropDir);
  const txDir = path.join(dropDir, "tx");
  await fs.mkdir(txDir, { recursive: true });

  // Load the vendored babel — same bytes the TV would run, so drop output is
  // what the device would have produced itself.
  const Babel = loadBabel(path.resolve(args.babel));
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
  // Returns the FINAL body the device would inline (raw for ES5-safe
  // sources, lowered output otherwise), or null when the source must not be
  // published. bestEffort sources (JELA-186 discovered dynamics) warn+skip
  // on failure — they are speculative regex-scraped URLs and the device
  // lazy-Babel fallback still covers a miss; explicit inputs stay fail-loud.
  async function lowerOne(s, bestEffort) {
    if (!PRECHECK_RE.test(s.text)) {
      skipped++;
      console.log("skip (ES5-safe, device fast-path): " + s.from);
      return s.text;
    }
    const hash = txFnv1a(s.text);
    const rel = "tx/" + hash + ".js";
    let out;
    try {
      out = Babel.transform(s.text, BABEL_OPTS).code;
    } catch (e) {
      if (bestEffort) {
        console.warn("WARN: babel failed on " + s.from + " — " + e.message);
        return null;
      }
      console.error("ERROR: babel failed on " + s.from + " — " + e.message);
      process.exit(1);
    }
    if (typeof out !== "string" || !out.length || ORACLE_RE.test(out)) {
      // Publishing a body the device oracle would reject (or worse, one it
      // would accept but that still carries modern syntax) is a correctness
      // hazard — fail the whole build loudly.
      if (bestEffort) {
        console.warn(
          "WARN: transform output for " + s.from + " failed the lowered oracle",
        );
        return null;
      }
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
    return out;
  }

  const finals = [];
  for (const s of sources) {
    const fin = await lowerOne(s, false);
    if (fin != null) finals.push({ from: s.from, body: fin });
  }

  // JELA-186: enumerate the dynamic module bodies the static scripts inject
  // at runtime, so drop-injected dynamic modules drop-HIT on-device and
  // Babel never loads. Discovery is URL-driven (mirror of the seed's
  // __txScrapeBodies) — this tool still names no plugin.
  let discovered = 0;
  if (!args.noDynScan) {
    const seenUrls = new Set(sources.map((s) => s.from));
    const dyn = await discoverDynamicSources(finals, seenUrls, 200);
    for (const s of dyn) {
      if ((await lowerOne(s, true)) != null) discovered++;
    }
    if (dyn.length)
      console.log(
        "dynamic scan: " +
          dyn.length +
          " module bodies discovered, " +
          discovered +
          " published/kept",
      );
  }

  const manifest = {
    format: 1,
    babelOptsKey: BABEL_OPTS_KEY,
    generated: new Date().toISOString(),
    entries,
  };
  const outPath = path.join(dropDir, "tx-manifest.json");
  // Atomic publish (JEL-653): the drop dir is a live web root under a cron
  // regen loop; write-then-rename so a TV fetching mid-regen can never read
  // a truncated manifest. tx/ bodies are content-addressed and written
  // before this point, so the renamed manifest only ever references
  // complete files.
  const tmpPath = outPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(tmpPath, outPath);
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
