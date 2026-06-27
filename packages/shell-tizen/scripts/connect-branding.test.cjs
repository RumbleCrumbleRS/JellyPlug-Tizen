// JEL-359 verification — the shell's OWN connect screen must be JellyPlug-branded.
//
// The connect screen heading is the shell's own surface, rendered before
// jellyfin-web loads (retail: boot-failure RECOVERY form via attachConnectForm()
// in shell.js; bootstrap: FIRST-LAUNCH form). JEL-118 renamed config.xml <name>
// + both <title> JellyfinShell -> JellyPlug but missed this 5rem wordmark, so the
// launcher splash said "JellyPlug" then the first in-app screen showed a giant
// stock-blue "Jellyfin". This test pins the heading text + color so the brand
// can't drift back.
//
// WHAT THIS PINS (retail shell-tizen):
//   1. src/index.html connect <h1> textContent === "JellyPlug" (not "Jellyfin").
//   2. src/connect/connect.css `.boot-shell h1` uses the JellyPlug ember accent
//      #ff6a1a (the --jp-ember literal JEL-299/JEL-301 standardized on), NOT the
//      stock Jellyfin blue #00a4dc.
//
// The companion sub-text <p>...your Jellyfin server address...</p> legitimately
// names the Jellyfin SERVER and is intentionally NOT asserted here.
//
// Run: node scripts/connect-branding.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const css = fs.readFileSync(path.join(SRC, "connect", "connect.css"), "utf8");

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

// 2. Connect heading color.
const rule = css.match(/\.boot-shell\s+h1\s*\{([^}]*)\}/);
check(!!rule, "connect.css has a `.boot-shell h1` rule");
// Strip CSS comments before the color checks — a /* ... */ rationale may
// legitimately name the old #00a4dc it replaced.
const body = (rule ? rule[1] : "").replace(/\/\*[\s\S]*?\*\//g, "");
check(/color\s*:\s*#ff6a1a/i.test(body),
  ".boot-shell h1 color is the JellyPlug ember #ff6a1a");
check(!/#00a4dc/i.test(body),
  ".boot-shell h1 color is NOT stock Jellyfin blue #00a4dc");

if (failures) {
  console.error(`\nconnect-branding.test.cjs: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nconnect-branding.test.cjs: all assertions passed");
