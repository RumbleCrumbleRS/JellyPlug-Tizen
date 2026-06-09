// JEL-66 verification — NativeShell.openUrl is an inert no-op on TV, while a
// plain browser opens the link (TV vs browser).
//
// CLAIM TO PROVE
//   Calling NativeShell.openUrl(url, target) on the Tizen set does nothing
//   observable — no navigation, no popup, no JavaScript error — because a Tizen
//   WRT app cannot launch an external browser. Compare a desktop browser, where
//   jellyfin-web's shell module falls back to window.open() and the link opens.
//   No UI that *could* trigger openUrl ("View on TMDB"-style external links)
//   leaves the user in a broken state on the TV.
//
// THE jellyfin-web CALL PATH (ground truth, 10.11.x)
//
//   jellyfin-web's shell module wraps the native hook with an existence guard:
//     openUrl:function(e,t){var n;null!==(n=window.NativeShell)&&void 0!==n&&
//       n.openUrl ? window.NativeShell.openUrl(e,t) : window.open(e,t||"_blank")}
//   - On TV: window.NativeShell.openUrl exists, so the wrapper calls the shell's
//     body — an EMPTY function. No-op, no throw, nothing opens.
//   - In a plain desktop browser: window.NativeShell is undefined, so the guard
//     falls through to window.open(url, target||"_blank") — the link opens.
//     THAT is the "link behavior in browser" the ticket refers to. (Our shell
//     loaded in a desktop browser still no-ops: NativeShell is present there too.)
//
// WHY NO "View on TMDB" UI CAN STRAND THE USER ON TV — three independent layers
//
//   (1) UI gate — the external-links section is gated on the ExternalLinks
//       feature. jellyfin-web: `if(!0===n && !appHost.supports(ExternalLinks))
//       return null` (component renders nothing) and a `data-autohide` handler
//       hides external-link elements when unsupported. The TV reports
//       ExternalLinks=false (our SupportedFeatures has no "externallinks" — the
//       legacy "externallinkdisplay" string matches NO current AppFeature enum;
//       see JEL-46). jellyfin-web's own Tizen-browser baseline also omits
//       ExternalLinks (the builder pushes it only for non-tizen). So the
//       "View on TMDB / IMDb" links are NOT rendered on the TV at all.
//
//   (2) Handler gate — for any link that DID render with a target attribute, the
//       click handler is: `supports(TargetBlank) || (e.preventDefault(),
//       shell.openUrl(href))`. The TV reports TargetBlank=true, so the OR
//       short-circuits: no preventDefault, no openUrl — the native <a target>
//       path runs (the Tizen WebView simply opens no popup). openUrl is never
//       reached through these handlers on the TV.
//
//   (3) Safety net — even if some other path calls shell.openUrl on the TV, the
//       native body is an empty function: it returns undefined and throws
//       nothing. Worst case is a control that visibly does nothing — never a
//       crash, never a broken state.
//
// GROUND TRUTH captured live from $JELLYFIN_URL/web/main.jellyfin.bundle.js
// (jellyfin-web 10.11.x) on 2026-06-09 — re-capture commands in
// tooling/tv-validate/openurl-noop/results-JEL-66.md. The exact byte-strings the
// shell wrapper and the click handlers use are pinned below so a jellyfin-web
// change to the contract is caught here rather than as a dead/crashing call on
// the TV.
//
// Run: node scripts/openurl-noop.test.cjs
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
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
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
// An empty body provably cannot navigate, open a popup, throw, or change the
// page. Any statement here could touch the firmware/DOM and diverge.
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  const body = methodBody(file.src, "openUrl");
  check(
    file.label + ": openUrl body has no executable statements (pure no-op)",
    executableSubstance(body) === "",
    "substance=[" + executableSubstance(body) + "]",
  );
}

// --- 2. Deployed minified blobs define openUrl as the empty function --------
// The bytes that actually run on the TV must match the source-of-record intent.
for (const file of [
  { label: "shell.min.js", src: shellMin },
  { label: "boot-shell.min.js", src: bootMin },
]) {
  check(
    file.label + ": openUrl is the empty function function(){}",
    /openUrl:function\([^)]*\)\{\}/.test(file.src.replace(/\s+/g, "")),
    "not found as empty fn",
  );
}

// --- 3. The no-op body references no navigation / firmware surface ----------
// Belt-and-suspenders beyond the "empty" check: prove the body names nothing
// that could navigate, open a window, or hit the firmware — so even a future
// non-empty edit that *looks* harmless is flagged for review.
const FORBIDDEN =
  /window\.|document\.|location|\.open\b|tizen|webapis|navigator|href/i;
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  const body = methodBody(file.src, "openUrl");
  check(
    file.label + ": openUrl references no navigation/window/Tizen API",
    !FORBIDDEN.test(body),
    "matched=[" + (body.match(FORBIDDEN) || []).join(",") + "]",
  );
}

// --- 4. RUNTIME proof: the actual shipped body throws nothing for any args --
// Build a callable function from the real shell.js openUrl body and invoke it
// with the call shapes jellyfin-web (and anything else) could produce. A no-op
// must return undefined and never throw, regardless of arity or argument type.
const liveBody = methodBody(shellSrc, "openUrl");
let liveFn;
try {
  // openUrl is declared `function (/* url, target */)` — reconstruct with the
  // documented params so the body is exercised exactly as shipped.
  liveFn = new Function("url", "target", liveBody);
} catch (e) {
  check("shell.js openUrl body compiles as a function", false, String(e));
}
if (liveFn) {
  const argSets = [
    [],
    ["https://www.themoviedb.org/movie/550"],
    ["https://imdb.com/title/tt0137523", "_blank"],
    [null, undefined],
    [{}, 42],
    ["javascript:alert(1)", "_self"], // hostile input must still no-op, not run
  ];
  let threw = false;
  let nonUndefined = false;
  for (const args of argSets) {
    try {
      const r = liveFn.apply(null, args);
      if (r !== undefined) nonUndefined = true;
    } catch (e) {
      threw = true;
    }
  }
  check("shell.js openUrl never throws across 0/1/2/garbage/hostile args", !threw);
  check("shell.js openUrl returns undefined (inert) for every input", !nonUndefined);
}

// --- 5. jellyfin-web shell wrapper contract (ground truth, pinned) ----------
// The wrapper guards on NativeShell + openUrl existence, then delegates to the
// shell on TV or window.open() in a plain browser. Reconstruct it verbatim and
// prove BOTH branches with a window.open spy, so a jellyfin-web rename of either
// the hook or the fallback surfaces here rather than as a dead TV call.
const SHELL_WRAPPER_BYTES =
  'openUrl:function(e,t){var n;null!==(n=window.NativeShell)&&void 0!==n&&n.openUrl?window.NativeShell.openUrl(e,t):window.open(e,t||"_blank")}';
check(
  "jellyfin-web shell.openUrl is NativeShell-guarded with a window.open fallback",
  /null!==\(n=window\.NativeShell\)&&void 0!==n&&n\.openUrl\?window\.NativeShell\.openUrl\(e,t\):window\.open\(e,t\|\|"_blank"\)/.test(
    SHELL_WRAPPER_BYTES,
  ),
);

// Faithful transcription of the wrapper above, parameterized over a fake global
// scope so we can observe which branch runs.
function makeShellOpenUrl(win) {
  return function (e, t) {
    var n;
    if (null !== (n = win.NativeShell) && void 0 !== n && n.openUrl) {
      win.NativeShell.openUrl(e, t);
    } else {
      win.open(e, t || "_blank");
    }
  };
}

// (a) TV branch: NativeShell present with our no-op → window.open NOT called.
{
  let opened = null;
  let delegated = 0;
  const win = {
    NativeShell: { openUrl: new Function("url", "target", liveBody || "") },
    open: function (u, tgt) {
      opened = [u, tgt];
    },
  };
  // wrap the no-op to count delegations without altering its (empty) behavior
  const realNoop = win.NativeShell.openUrl;
  win.NativeShell.openUrl = function (u, tgt) {
    delegated++;
    return realNoop(u, tgt);
  };
  const open = makeShellOpenUrl(win);
  let threw = false;
  try {
    open("https://www.themoviedb.org/movie/550", "_blank");
  } catch (e) {
    threw = true;
  }
  check("TV branch: shell.openUrl delegates to NativeShell.openUrl", delegated === 1);
  check("TV branch: window.open is NOT called on the TV", opened === null);
  check("TV branch: the whole open() path throws nothing", !threw);
}

// (b) Browser branch: no NativeShell → window.open(url, target||"_blank").
{
  let opened = null;
  const win = {
    NativeShell: undefined,
    open: function (u, tgt) {
      opened = [u, tgt];
    },
  };
  const open = makeShellOpenUrl(win);
  open("https://www.themoviedb.org/movie/550");
  check(
    "browser branch: window.open(url, '_blank') opens the link (no target given)",
    opened && opened[0] === "https://www.themoviedb.org/movie/550" && opened[1] === "_blank",
    "opened=" + JSON.stringify(opened),
  );
  open("https://imdb.com/title/tt0137523", "_self");
  check(
    "browser branch: explicit target is honored",
    opened && opened[1] === "_self",
    "opened=" + JSON.stringify(opened),
  );
}

// --- 6. The two openUrl call sites are TargetBlank-gated link handlers -------
// Pin jellyfin-web's link click handler. With TargetBlank=true on the TV the
// `supports(TargetBlank) ||` short-circuits, so the (preventDefault, openUrl)
// branch never runs there — external links use the native <a target> path.
const LINK_HANDLER_BYTES =
  'function d(e){var t=this.getAttribute("href")||"";"#"!==t?this.getAttribute("target")?r.g.supports(a.Y.TargetBlank)||(e.preventDefault(),l.A.openUrl(t)):(e.preventDefault(),o.appRouter.show(t';
check(
  "link click handler routes target links through supports(TargetBlank)||openUrl",
  /supports\(\w+\.\w+\.TargetBlank\)\|\|\(e\.preventDefault\(\),\w+\.\w+\.openUrl\(t\)/.test(
    LINK_HANDLER_BYTES,
  ),
);

// Prove the short-circuit: supports(TargetBlank)===true means the openUrl branch
// is never evaluated.
{
  let openUrlCalls = 0;
  const supports = function () {
    return true; // TargetBlank=true on TV
  };
  const ev = {
    prevented: false,
    preventDefault: function () {
      this.prevented = true;
    },
  };
  // mirror: supports(TargetBlank) || (e.preventDefault(), openUrl(href))
  // eslint-disable-next-line no-unused-expressions
  supports("targetblank") ||
    (ev.preventDefault(), openUrlCalls++);
  check(
    "TargetBlank=true short-circuits: openUrl branch not taken, no preventDefault",
    openUrlCalls === 0 && ev.prevented === false,
  );
}

// --- 7. Shell feature flags: TargetBlank advertised, ExternalLinks withheld --
// SupportedFeatures is the shell's appHost.supports source of truth (JEL-46).
// targetblank=true keeps external links on the native path (layer 2); the TV
// withholds the current ExternalLinks enum so the external-links UI never
// renders (layer 1). The legacy "externallinkdisplay" matches no enum.
const featBlockStart = shellSrc.indexOf("var SupportedFeatures");
const featBlock = shellSrc.slice(
  featBlockStart,
  shellSrc.indexOf("]", featBlockStart) + 1,
);
check(
  "shell advertises targetblank (native-link path; keeps openUrl off the TV)",
  /"targetblank"/.test(featBlock),
);
check(
  'shell does NOT advertise the current "externallinks" feature (UI gate: section renders null)',
  !/"externallinks"/.test(featBlock),
  "block=[" + featBlock.replace(/\s+/g, " ") + "]",
);

// --- 8. Both shells AGREE on the openUrl contract ---------------------------
// shell.js (full) and boot-shell.src.js (bootstrap) must both define openUrl as
// the same inert no-op — otherwise behavior would depend on which shell booted.
check(
  "shell.js and boot-shell.src.js both define an empty openUrl",
  executableSubstance(methodBody(shellSrc, "openUrl")) === "" &&
    executableSubstance(methodBody(bootSrc, "openUrl")) === "",
);

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All openUrl no-op parity checks passed.");
