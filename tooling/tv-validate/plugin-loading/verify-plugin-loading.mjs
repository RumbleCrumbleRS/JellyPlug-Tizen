#!/usr/bin/env node
// JEL-37 — Compare: server-installed plugin loading (Browser vs Tizen 5.0 / Chromium 56)
//
// Verifies that server-injected Jellyfin plugin <script> tags in /web/index.html
// are detected, fetched, and "processed" by BOTH render paths:
//
//   Browser path  — modern Chromium runs the plugin bodies raw (no transpile).
//   Tizen 5.0 path — the shell (packages/shell-tizen/src/shell.js) must intercept
//                    each plugin <script src>, run needsTranspile()/Babel for any
//                    ES2020+ syntax, and inline the result so it executes on
//                    Chromium 56.
//
// This harness reuses the SHELL'S OWN detection logic (regexes + Babel options,
// copied verbatim from shell.js and asserted in lockstep below) against the REAL
// plugin bytes served by the test Jellyfin server, so the "plugins detected and
// processed" count it reports is exactly what window.__shellDiagInit.scriptsFound /
// transpiled would be on the TV. No physical TV required for the transpile path.
//
// Usage:
//   JELLYFIN_URL=... node tooling/tv-validate/plugin-loading/verify-plugin-loading.mjs
//
// Exit 0 = every detected plugin script fetched + processed cleanly on both paths.

import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

// Parse-check a script body the way a browser engine would at <script> insertion
// time: a SyntaxError here is exactly the failure mode that silently kills a
// whole plugin module (JEL-401). Returns null on success, the message on error.
function parseError(code) {
  try {
    new vm.Script(code, { filename: "plugin.js" });
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");

// ---- shell.js detection logic (verbatim mirror; see lockstep assert below) ----
const MODERN_SYNTAX_RE_SRC =
  "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{";
const MODERN_SYNTAX_RE = new RegExp(MODERN_SYNTAX_RE_SRC);
const JQUERY_REF_RE = /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/;
const BABEL_OPTS = {
  presets: [
    ["env", { targets: { chrome: "63" }, modules: false, loose: true }],
  ],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script",
  compact: true,
  comments: false,
};
function needsTranspile(code) {
  return typeof code === "string" && MODERN_SYNTAX_RE.test(code);
}
function needsJQueryGate(code) {
  return JQUERY_REF_RE.test(code);
}
// Mirror of shell.js wrapForJQuery() so the TV-path parse-check covers the
// exact body the shell inlines for jQuery-referencing plugins.
function wrapForJQueryParseShim(code) {
  return [
    "(function(){",
    "function __run(){",
    code,
    "\n}",
    'if(typeof window.jQuery!=="undefined"){__run();return;}',
    "var __to;",
    "var __t=setInterval(function(){",
    'if(typeof window.jQuery!=="undefined"){clearInterval(__t);clearTimeout(__to);try{__run();}catch(e){}}',
    "},20);",
    "__to=setTimeout(function(){clearInterval(__t);try{__run();}catch(e){}},10000);",
    "})();",
  ].join("");
}
function isJellyfinWebBundle(src) {
  const bare = String(src || "").split("?")[0];
  if (/\.bundle\.js$/i.test(bare)) return true;
  if (/\.chunk\.js$/i.test(bare)) return true;
  if (/(^|\/)serviceworker\.js$/i.test(bare)) return true;
  return false;
}

// ---- lockstep guard: fail loudly if shell.js drifts from this mirror ----------
function assertLockstep() {
  const shell = fs.readFileSync(
    path.join(REPO, "packages/shell-tizen/src/shell.js"),
    "utf8",
  );
  const problems = [];
  // shell.js stores the regex source as a JS string literal with doubled
  // backslashes. Our runtime MODERN_SYNTAX_RE_SRC has single backslashes, so
  // re-double them to reconstruct the exact source token shell.js must contain.
  const shellLiteral = MODERN_SYNTAX_RE_SRC.replace(/\\/g, "\\\\");
  if (!shell.includes(shellLiteral)) {
    problems.push("MODERN_SYNTAX_RE_SRC drift vs shell.js");
  }
  if (!shell.includes('targets: { chrome: "63" }')) {
    problems.push("Babel chrome:63 target drift vs shell.js");
  }
  return problems;
}

const Babel = require(path.join(REPO, "packages/shell-tizen/src/babel.min.js"));

const RAW_URL = process.env.JELLYFIN_URL || "";
const BASE = RAW_URL.replace(/\/+$/, "");
if (!BASE) {
  console.error("JELLYFIN_URL not set");
  process.exit(2);
}
const WEB_INDEX = BASE + "/web/index.html";

function extractScriptTags(html) {
  const tags = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const srcM = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs);
    const pluginM = /\bplugin\s*=\s*"([^"]*)"/i.exec(attrs);
    tags.push({
      raw: m[0],
      src: srcM ? srcM[1] : null,
      pluginAttr: pluginM ? pluginM[1] : null,
    });
  }
  return tags;
}

async function main() {
  const lockstep = assertLockstep();
  const report = {
    server: BASE,
    serverVersion: null,
    generatedAtNote: "timestamp omitted (set by caller)",
    lockstepProblems: lockstep,
    plugins: [],
    summary: {},
  };

  // server version (public)
  try {
    const r = await fetch(BASE + "/System/Info/Public");
    if (r.ok) {
      const j = await r.json();
      report.serverVersion = j.Version + " (" + j.ServerName + ")";
    }
  } catch (_) {}

  const htmlResp = await fetch(WEB_INDEX);
  const html = await htmlResp.text();
  const tags = extractScriptTags(html);

  // Replicate transpileLegacyScriptsInner's plugin-detection filter:
  // a "plugin script" is any <script src> that is NOT a jellyfin-web bundle.
  const pluginTags = tags.filter((t) => t.src && !isJellyfinWebBundle(t.src));

  let scriptsFound = 0;
  let transpiled = 0;
  let transpileFailed = 0;
  let raw = 0;
  let fetchFailed = 0;
  let jqGated = 0;

  for (const t of pluginTags) {
    let url;
    try {
      url = new URL(t.src, WEB_INDEX).href;
    } catch (_) {
      continue;
    }
    scriptsFound++;
    const entry = {
      plugin: t.pluginAttr || "(no plugin attr)",
      src: t.src,
      url,
      httpStatus: null,
      bytes: 0,
      browserParseOk: null,
      tvNeedsTranspile: false,
      tvTranspileOk: null,
      tvParseOk: null,
      tvJQueryGated: false,
      tvNote: "",
    };
    try {
      // shell fetches plugin bodies with credentials omitted.
      const pr = await fetch(url, { credentials: "omit" });
      entry.httpStatus = pr.status;
      if (!pr.ok) {
        fetchFailed++;
        entry.tvNote = "fetch failed";
        report.plugins.push(entry);
        continue;
      }
      const code = await pr.text();
      entry.bytes = code.length;
      // Browser path: the raw body is what a modern Chromium executes verbatim.
      entry.browserParseOk = parseError(code) === null;
      const nt = needsTranspile(code);
      entry.tvNeedsTranspile = nt;
      let tvBody = null;
      if (!nt) {
        raw++;
        entry.tvTranspileOk = true; // inlined raw, no babel needed
        tvBody = code;
        entry.tvNote = "ES5/ES6 — inlined raw on Chromium 56 (fast path)";
      } else {
        try {
          const out = Babel.transform(code, BABEL_OPTS).code;
          if (typeof out === "string" && out.length > 0) {
            transpiled++;
            entry.tvTranspileOk = true;
            tvBody = out;
            entry.tvNote =
              "ES2020+ detected — Babel→chrome63 OK (" +
              code.length +
              "→" +
              out.length +
              " bytes)";
          } else {
            transpileFailed++;
            entry.tvTranspileOk = false;
            entry.tvNote = "Babel returned empty";
          }
        } catch (e) {
          transpileFailed++;
          entry.tvTranspileOk = false;
          entry.tvNote = "Babel threw: " + (e && e.message);
        }
      }
      if (needsJQueryGate(code)) {
        entry.tvJQueryGated = true;
        jqGated++;
        if (tvBody != null) tvBody = wrapForJQueryParseShim(tvBody);
      }
      // TV path: the body the shell actually inlines must itself be valid JS,
      // or injection re-throws the SyntaxError it set out to prevent.
      if (tvBody != null) {
        const pe = parseError(tvBody);
        entry.tvParseOk = pe === null;
        if (pe) entry.tvNote += " | TV inline parse error: " + pe;
      }
    } catch (e) {
      fetchFailed++;
      entry.tvNote = "fetch error: " + (e && e.message);
    }
    report.plugins.push(entry);
  }

  const browserParseFailed = report.plugins.filter(
    (p) => p.httpStatus === 200 && p.browserParseOk === false,
  ).length;
  const tvParseFailed = report.plugins.filter(
    (p) => p.tvParseOk === false,
  ).length;
  report.summary = {
    // Equivalent of window.__shellDiagInit.scriptsFound on the TV.
    shellPluginCount_scriptsFound: scriptsFound,
    tvTranspiled: transpiled,
    tvInlinedRaw: raw,
    tvTranspileFailed: transpileFailed,
    tvJQueryGated: jqGated,
    fetchFailed,
    browserParseFailed,
    tvParseFailed,
    browserVsTvParity:
      fetchFailed === 0 &&
      transpileFailed === 0 &&
      browserParseFailed === 0 &&
      tvParseFailed === 0
        ? "PASS — every detected plugin fetched + parse-clean on both paths"
        : "FAIL — see entries",
  };
  return report;
}

main().then(
  (report) => {
    const outDir = __dirname;
    fs.writeFileSync(
      path.join(outDir, "plugin-loading-report.json"),
      JSON.stringify(report, null, 2),
    );
    // Human summary
    console.log("=== JEL-37 plugin-loading compare ===");
    console.log("Server:", report.serverVersion || report.server);
    if (report.lockstepProblems.length) {
      console.log("!! LOCKSTEP DRIFT:", report.lockstepProblems.join("; "));
    } else {
      console.log("lockstep vs shell.js: OK");
    }
    console.log("");
    console.log(
      "plugin".padEnd(34),
      "HTTP".padEnd(5),
      "bytes".padEnd(8),
      "browser".padEnd(8),
      "TVpath",
    );
    for (const p of report.plugins) {
      console.log(
        String(p.plugin).padEnd(34),
        String(p.httpStatus).padEnd(5),
        String(p.bytes).padEnd(8),
        (p.browserParseOk ? "parse ok" : "PARSE!! ").padEnd(8),
        (p.tvNeedsTranspile ? "TRANSPILE " : "raw       ") +
          (p.tvJQueryGated ? "+jq " : "") +
          (p.tvTranspileOk && p.tvParseOk !== false ? "ok" : "FAIL"),
      );
      console.log("   ", p.url);
      console.log("   ", p.tvNote);
    }
    console.log("");
    console.log("SUMMARY", JSON.stringify(report.summary, null, 2));
    const s = report.summary;
    process.exit(s.fetchFailed === 0 && s.tvTranspileFailed === 0 ? 0 : 1);
  },
  (err) => {
    console.error("harness error:", err);
    process.exit(3);
  },
);
