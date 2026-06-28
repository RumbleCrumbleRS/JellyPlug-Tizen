// JEL-359 verification — the bootstrap FIRST-LAUNCH connect screen must be
// JellyPlug-branded (parity with the retail shell-tizen test of the same name).
//
// The bootstrap connect form is the very first screen a brand-new user sees.
// Unlike retail it bundles NO connect/connect.css (build_bootstrap.py packages
// only {config.xml,index.html,icon.png,boot-shell.min.js,babel.min.js}), so the
// injected `connect/connect.css` 404s on-device and the form is styled entirely
// by the inline <style> in index.html. Both the heading text AND its color must
// therefore live in index.html.
//
// WHAT THIS PINS (bootstrap shell-tizen-bootstrap):
//   1. src/index.html connect <h1> textContent === "JellyPlug" (not "Jellyfin").
//   2. the inline `.boot-shell h1` rule sets color #ff6a1a (JellyPlug ember,
//      the --jp-ember literal JEL-299/JEL-301 standardized on), NOT stock
//      Jellyfin blue #00a4dc.
//   3. (JEL-415) the inline `#server-form button` rule sets an ember #ff6a1a
//      background (parity with the retail shell — previously the bootstrap
//      button had NO background and rendered browser-default gray).
//
// Run: node scripts/connect-branding.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ok  - " + msg);
  } else {
    console.error("  FAIL - " + msg);
    failures++;
  }
}

// 1. Connect heading text.
const h1 = html.match(/<h1>([^<]*)<\/h1>/);
check(!!h1, "index.html has a connect <h1>");
check(h1 && h1[1].trim() === "JellyPlug",
  `connect <h1> textContent === "JellyPlug" (got "${h1 ? h1[1].trim() : "<none>"}")`);
check(!/<h1>\s*Jellyfin\s*<\/h1>/.test(html),
  'no off-brand "<h1>Jellyfin</h1>" wordmark remains');

// 2. Connect heading color (inline rule — connect.css is NOT bundled here).
const rule = html.match(/\.boot-shell\s+h1\s*\{([^}]*)\}/);
check(!!rule, "index.html inline style has a `.boot-shell h1` rule");
const body = rule ? rule[1] : "";
check(/color\s*:\s*#ff6a1a/i.test(body),
  "inline .boot-shell h1 color is the JellyPlug ember #ff6a1a");
check(!/#00a4dc/i.test(body),
  "inline .boot-shell h1 color is NOT stock Jellyfin blue #00a4dc");

// 3. (JEL-415) Connect button fill — inline (no connect.css bundled here).
const btnRule = html.match(/#server-form\s+button\s*\{([^}]*)\}/);
const btn = btnRule ? btnRule[1] : "";
check(!!btnRule, "index.html inline style has a `#server-form button` rule");
check(/background\s*:\s*#ff6a1a/i.test(btn),
  "inline #server-form button background is the JellyPlug ember #ff6a1a");
check(!/#00a4dc/i.test(btn),
  "inline #server-form button has NO stock Jellyfin blue #00a4dc");

if (failures) {
  console.error(`\nconnect-branding.test.cjs: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nconnect-branding.test.cjs: all assertions passed");
