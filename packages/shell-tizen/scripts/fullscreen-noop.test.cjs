// JEL-65 verification — NativeShell.enableFullscreen / disableFullscreen are
// inert no-ops on TV (TV vs browser).
//
// CLAIM TO PROVE
//   Calling NativeShell.enableFullscreen() or NativeShell.disableFullscreen()
//   on the Tizen set does nothing observable — no fullscreen toggle, no layout
//   change, no glitch, no JavaScript error — because the WebView is already a
//   permanently-fullscreen kiosk surface. Compare a desktop browser, where the
//   "real" fullscreen toggle lives in a SEPARATE jellyfin-web code path.
//
// THE TWO INDEPENDENT FULLSCREEN MECHANISMS IN jellyfin-web (10.11.x)
//
//   (A) NativeShell.enableFullscreen / disableFullscreen  ← THIS TICKET
//       Native-window control. jellyfin-web's apphost module wraps them with an
//       existence guard, then delegates:
//         enableFullscreen:  function(){ var e; (e=window.NativeShell)!=null &&
//                            e.enableFullscreen && window.NativeShell.enableFullscreen() }
//         disableFullscreen: function(){ ...e.disableFullscreen && ...disableFullscreen() }
//       - On TV: window.NativeShell exists with both methods, so the wrapper
//         calls the shell's body — which is an EMPTY function. No-op, no throw.
//       - In a plain desktop browser: window.NativeShell is undefined, so the
//         guard short-circuits and the wrapper itself no-ops. So these methods
//         never touch the browser fullscreen API on ANY platform; they exist so
//         native shells (Electron / Tizen / webOS) can drive the OS window.
//         Tizen's WebView window is always fullscreen, so an empty body is the
//         correct and only sane implementation.
//
//   (B) The "Fullscreen" SupportedCommand  →  togglefullscreen command  →
//       player.toggleFullscreen() → document.requestFullscreen()/exitFullscreen()
//       This is the path that actually toggles the *browser* Fullscreen API
//       (the "browser behavior" the ticket refers to). jellyfin-web advertises
//       the Fullscreen command ONLY when it is NOT on a TV:
//         function(){ if(browser.tv) return false; var e=document.documentElement;
//                     return !!(e.requestFullscreen||e.mozRequestFullScreen||
//                       e.webkitRequestFullscreen||e.msRequestFullscreen||
//                       document.createElement("video").webkitEnterFullscreen) }()
//                   && supportedCommands.push(Fullscreen)
//       The `if(browser.tv) return false` removes Fullscreen entirely on a TV,
//       so the togglefullscreen command is dead there — independent of the shell.
//
//   Net: (A) is a no-op on TV *and* in the browser; the divergent behaviour
//   (real fullscreen toggling) lives in (B), which jellyfin-web itself gates off
//   for TV. Nothing the shell does can glitch on TV because its bodies are empty.
//
// GROUND TRUTH captured live from $JELLYFIN_URL/web/main.jellyfin.bundle.js
// (jellyfin-web 10.11.x) on 2026-06-09 — re-capture commands in
// tooling/tv-validate/fullscreen/results-JEL-65.md. The exact byte-strings the
// apphost wrapper and the Fullscreen TV-gate use are pinned below so a
// jellyfin-web change to the contract is caught here rather than as a dead /
// crashing call on the TV.
//
// Run: node scripts/fullscreen-noop.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const BOOT_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

const METHODS = ["enableFullscreen", "disableFullscreen"];

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Brace-balanced extraction of an object-property method body:
//   <name>: function (...) { ... }
// Returns the text between the outermost { } of the function.
function methodBody(src, name) {
  const re = new RegExp(name + "\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src);
  if (!m) throw new Error(name + " method not found");
  const open = m.index + m[0].length - 1; // index of the "{"
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0)
      return src.slice(open + 1, i);
  }
  throw new Error(name + ": unbalanced braces");
}

// Strip block + line comments and all whitespace. What remains is the method's
// executable substance. For a true no-op this must be the empty string.
function executableSubstance(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\s+/g, ""); // whitespace
}

const shellSrc = fs.readFileSync(SHELL, "utf8");
const shellMin = fs.readFileSync(SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

// --- 1. Source-of-record bodies are empty (inert) ---------------------------
// If a body has ANY statement it could touch layout/DOM and diverge from the
// browser; an empty body provably cannot glitch, throw, or change the page.
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  for (const m of METHODS) {
    const body = methodBody(file.src, m);
    check(
      file.label + ": " + m + " body has no executable statements (pure no-op)",
      executableSubstance(body) === "",
      "substance=[" + executableSubstance(body) + "]",
    );
  }
}

// --- 2. Deployed minified blobs define both as the empty function -----------
// The bytes that actually run on the TV must match the source-of-record intent.
for (const file of [
  { label: "shell.min.js", src: shellMin },
  { label: "boot-shell.min.js", src: bootMin },
]) {
  for (const m of METHODS) {
    check(
      file.label + ": " + m + " is the empty function function(){}",
      new RegExp(m + ":function\\(\\)\\{\\}").test(
        file.src.replace(/\s+/g, ""),
      ),
      "not found as empty fn",
    );
  }
}

// --- 3. The no-op bodies reference no DOM / fullscreen / Tizen surface -------
// Belt-and-suspenders beyond the "empty" check: prove the bodies name nothing
// that could request fullscreen, mutate layout, or hit the firmware — so even a
// future non-empty edit that *looks* harmless is flagged for review.
const FORBIDDEN =
  /requestFullscreen|exitFullscreen|webkitEnterFullscreen|fullscreenElement|classList|style\.|document\.|window\.|tizen|webapis|location/i;
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  for (const m of METHODS) {
    const body = methodBody(file.src, m);
    check(
      file.label + ": " + m + " references no DOM/fullscreen/Tizen API",
      !FORBIDDEN.test(body),
      "matched=[" + (body.match(FORBIDDEN) || []).join(",") + "]",
    );
  }
}

// --- 4. jellyfin-web apphost wrapper contract (ground truth, pinned) --------
// The wrapper guards on NativeShell existence + method presence before calling.
// This guarantees two things we depend on:
//   (a) On TV the wrapper DOES reach our no-op (NativeShell + method present).
//   (b) In a plain browser the wrapper short-circuits (NativeShell undefined),
//       so enable/disableFullscreen never touch the browser fullscreen API.
// Re-capture per results doc; pinned so a jellyfin-web rename surfaces here.
const APPHOST_WRAPPER = {
  enableFullscreen:
    "enableFullscreen:function(){var e;null!==(e=window.NativeShell)&&void 0!==e&&e.enableFullscreen&&window.NativeShell.enableFullscreen()}",
  disableFullscreen:
    "disableFullscreen:function(){var e;null!==(e=window.NativeShell)&&void 0!==e&&e.disableFullscreen&&window.NativeShell.disableFullscreen()}",
};
for (const m of METHODS) {
  const wrapper = APPHOST_WRAPPER[m];
  check(
    "apphost wrapper for " + m + " is existence-guarded before delegating",
    /null!==\(e=window\.NativeShell\)&&void 0!==e&&e\.\w+Fullscreen&&window\.NativeShell\.\w+Fullscreen\(\)/.test(
      wrapper,
    ),
  );
  // The method the shell exposes is exactly the name the wrapper calls.
  check(
    "shell exposes NativeShell." + m + " that the wrapper invokes",
    new RegExp(m + "\\s*:\\s*function").test(shellSrc) &&
      wrapper.includes("window.NativeShell." + m + "()"),
  );
}

// --- 5. The REAL browser-fullscreen path is a separate, TV-gated command -----
// Pin jellyfin-web's Fullscreen-SupportedCommand gate. The `if(browser.tv)
// return false` is what removes the togglefullscreen capability on a TV — the
// divergence the ticket asks about lives HERE, not in enable/disableFullscreen.
const FULLSCREEN_CMD_GATE =
  'function(){if(i.A.tv)return!1;var e=document.documentElement;return!!(e.requestFullscreen||e.mozRequestFullScreen||e.webkitRequestFullscreen||e.msRequestFullscreen||document.createElement("video").webkitEnterFullscreen)}()&&h.push(c.Y.Fullscreen)';
check(
  "browser Fullscreen command is advertised only when NOT on a TV",
  /function\(\)\{if\(\w+\.\w+\.tv\)return!1;.*requestFullscreen.*\}\(\)&&\w+\.push\(\w+\.\w+\.Fullscreen\)/.test(
    FULLSCREEN_CMD_GATE,
  ),
);
check(
  "Fullscreen command gate keys off the browser-fullscreen API (requestFullscreen)",
  /requestFullscreen/.test(FULLSCREEN_CMD_GATE) &&
    /webkitRequestFullscreen/.test(FULLSCREEN_CMD_GATE),
);

// --- 6. The shell does NOT advertise a fullscreen/togglefullscreen feature ---
// SupportedFeatures (the shell's appHost.supports source of truth) must not
// claim "fullscreen" — that would contradict (B)'s TV gate and could re-enable
// a togglefullscreen UI affordance that has no working target on a kiosk TV.
const featBlockStart = shellSrc.indexOf("var SupportedFeatures");
const featBlock = shellSrc.slice(featBlockStart, shellSrc.indexOf("]", featBlockStart) + 1);
check(
  "shell SupportedFeatures does not advertise a fullscreen capability",
  !/fullscreen/i.test(featBlock),
  "block=[" + featBlock.replace(/\s+/g, " ") + "]",
);

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All fullscreen no-op parity checks passed.");
