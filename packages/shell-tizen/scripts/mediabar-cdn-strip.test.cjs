/*
 * JELA-716 (local half of JELA-715): strip the parse-dead CDN media-bar
 * <script> from the written /web/index.html on engines that cannot parse
 * optional chaining, and warm the JELA-710 self-hosted media-bar css instead
 * of the root-relative /gh/ jsdelivr pin (which resolved against the server
 * origin and 404ed on prod).
 *
 * The Media Bar plugin pins slideshowpure.js on cdn.jsdelivr.net; that copy
 * carries 13 `?.` sites and dies at parse on Tizen 5.0 / Chromium 63 — the
 * hero there is the vendored es2017 copy in the JS-Injector channel
 * (JELA-115), so the tag is a wasted fetch on every boot. Engines that CAN
 * parse `?.` run the CDN copy and must keep the tag, so the gate is a
 * parse-probe, not a feature-test.
 *
 * WHAT THIS PINS
 *   PART A — CONTRACT (src + minified sibling): call-site order (after the
 *            JELA-707 JE strip), kill switch, diag object, parse-probe.
 *   PART B — STRIP (the REAL stripDeadMediaBarJs, lifted from source):
 *     B0. engine parses `?.` -> the exact input reference is returned.
 *     B1. parse-dead engine -> the CDN slideshowpure.js tag is removed;
 *         every other tag (incl. the slideshowpure.css <link>) is
 *         byte-identical; the URL lands on the diag object.
 *     B2. kill switch -> unchanged even on a parse-dead engine.
 *     B3. a throwing localStorage -> the strip still runs (fail-open is
 *         toward stripping: the kill switch is the opt-out, and on a
 *         parse-dead engine the tag can never execute anyway).
 *     B4. parse-dead engine, no CDN tag -> the exact input reference.
 *     B5. stripping is idempotent.
 *   PART C — CWS WARM LIST (src + min): the media-bar css warm entry is the
 *            self-hosted /shell/fonts/ URL; no /gh/IAmParadox27 pin remains.
 *
 * Run: node scripts/mediabar-cdn-strip.test.cjs
 *   or: pnpm --filter @jellyfin-tv/shell-tizen test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "shell.js");

const MIN = SRC.endsWith("boot-shell.src.js")
  ? SRC.replace(/boot-shell\.src\.js$/, "boot-shell.min.js")
  : SRC.replace(/shell\.js$/, "shell.min.js");

const KILL = "jellyfin.shell.keepCdnMediaBarJs";
const DIAG = "__shellMbStrip";
const CDN_JS =
  "https://cdn.jsdelivr.net/gh/IAmParadox27/jellyfin-plugin-media-bar@ae878fd763c1d2065db4dcbc7d15a90539a0f813/slideshowpure.js";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const src = fs.readFileSync(SRC, "utf8");
const min = fs.readFileSync(MIN, "utf8");
const srcLabel = path.basename(SRC);
const minLabel = path.basename(MIN);

function extractTopFn(text, name) {
  const lines = text.split("\n");
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("  function " + name + "(")) {
      s = i;
      break;
    }
  }
  if (s === -1) throw new Error("function not found: " + name);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(s, i + 1).join("\n");
  }
  throw new Error("no closing brace for: " + name);
}

// ===========================================================================
// PART A — CONTRACT
// ===========================================================================
check(
  srcLabel + ": strip wraps the JE strip at the write-path choke point",
  /stripDeadMediaBarJs\(\s*stripJeScriptsForDefer\(\s*rewriteFontThirdPartyCss\(results\[0\], serverUrl\),?\s*\),?\s*\)/.test(
    src,
  ),
);
check(
  srcLabel + ": parse-probe idiom keeps `?.` out of the shell source",
  src.includes('new Function("void 0?" + ".x")'),
);
for (const [label, text] of [
  [srcLabel, src],
  [minLabel, min],
]) {
  check(label + ": kill switch survives", text.includes(KILL));
  check(label + ": diag object present", text.includes(DIAG));
}

// ===========================================================================
// PART B — STRIP (the real function, in a vm sandbox)
// ===========================================================================
const fnSrc = extractTopFn(src, "stripDeadMediaBarJs").replace(
  /^  function stripDeadMediaBarJs/,
  "function",
);

// The prod index.html neighborhood the strip runs over: the (already
// jp710-rewritten) css link, the CDN script, an inline defer script and a
// same-origin bundle tag.
const CSS_LINK =
  '<link rel="stylesheet" href="/shell/fonts/mediabar-slideshowpure.css" />';
const OTHER_TAG =
  '<script defer="defer" src="main.jellyfin.bundle.js?4c3e5ec610f9c71cad1c"></script>';
const CDN_TAG = '<script defer src="' + CDN_JS + '"></script>';
const INLINE_TAG = "<script defer>var MediaBarConfigHandler = 1;</script>";
const HTML =
  "<!doctype html><html><head>" +
  CSS_LINK +
  OTHER_TAG +
  CDN_TAG +
  INLINE_TAG +
  "</head><body></body></html>";

function runStrip(html, opts) {
  const o = opts || {};
  const sb = {
    String,
    RegExp,
    window: {},
    localStorage: o.throwingLs
      ? {
          getItem() {
            throw new Error("quota");
          },
        }
      : {
          getItem(k) {
            return (o.ls || {})[k] || null;
          },
        },
    // M63 sim: `new Function` on any source containing `?.` throws at parse.
    Function: o.parseDead
      ? function (body) {
          if (String(body).indexOf("?.") !== -1) {
            throw new SyntaxError("Unexpected token .");
          }
          return function () {};
        }
      : Function,
  };
  vm.createContext(sb);
  const strip = vm.runInContext("(" + fnSrc + ")", sb);
  return { out: strip(html), diag: sb.window[DIAG] };
}

// B0 — capable engine: untouched, same reference.
{
  const r = runStrip(HTML, { parseDead: false });
  check(srcLabel + " B0: `?.`-capable engine returns the input reference", r.out === HTML);
}

// B1 — parse-dead engine: only the CDN js tag goes.
{
  const r = runStrip(HTML, { parseDead: true });
  check(
    srcLabel + " B1: CDN slideshowpure.js tag removed",
    r.out.indexOf(CDN_TAG) === -1,
  );
  check(
    srcLabel + " B1: everything else byte-identical",
    r.out === HTML.replace(CDN_TAG, ""),
  );
  check(
    srcLabel + " B1: css link untouched",
    r.out.indexOf(CSS_LINK) !== -1,
  );
  check(
    srcLabel + " B1: diag counts the held tag",
    r.diag && r.diag.held === 1 && r.diag.urls[0] === CDN_JS,
  );
}

// B2 — kill switch restores the stock tag.
{
  const r = runStrip(HTML, { parseDead: true, ls: { [KILL]: "1" } });
  check(srcLabel + " B2: kill switch passes through", r.out === HTML);
}

// B3 — throwing localStorage: strip still runs.
{
  const r = runStrip(HTML, { parseDead: true, throwingLs: true });
  check(
    srcLabel + " B3: throwing localStorage still strips",
    r.out.indexOf(CDN_TAG) === -1,
  );
}

// B4 — nothing to strip: exact reference back.
{
  const noCdn = HTML.replace(CDN_TAG, "");
  const r = runStrip(noCdn, { parseDead: true });
  check(srcLabel + " B4: no CDN tag returns the input reference", r.out === noCdn);
}

// B5 — idempotent.
{
  const once = runStrip(HTML, { parseDead: true }).out;
  const twice = runStrip(once, { parseDead: true }).out;
  check(srcLabel + " B5: idempotent", once === twice);
}

// ===========================================================================
// PART C — CWS WARM LIST
// ===========================================================================
for (const [label, text] of [
  [srcLabel, src],
  [minLabel, min],
]) {
  check(
    label + ": CWS warms the self-hosted media-bar css",
    text.includes(
      '"/web/blurhash.worker.bundle.js","/shell/fonts/mediabar-slideshowpure.css"',
    ),
  );
  check(
    label + ": no root-relative /gh/ jsdelivr pin remains",
    !text.includes("/gh/IAmParadox27"),
  );
}

if (failures) {
  console.error(failures + " failure(s)");
  process.exit(1);
}
console.log("mediabar-cdn-strip: all checks passed");
