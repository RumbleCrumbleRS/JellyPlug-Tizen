// JEL-184 verification — cross-origin third-party scripts must load NATIVELY.
//
// The media bar plugin (EditorsChoice / slideshowpure.js) plays trailers by
// loading the YouTube IFrame Player API: it injects
//   <script src="https://www.youtube.com/iframe_api">
// then creates a muted `new YT.Player(...)` and calls playVideo() on it.
//
// The shell's dynamic-script interceptor (JEL-406/JEL-407) was built ONLY to
// transpile ES2020+ syntax in SAME-ORIGIN jellyfin-web plugin bodies served
// from ${server} (the document.baseURI origin). It read every intercepted
// body with window.fetch(). A cross-origin third-party script like
// youtube.com/iframe_api cannot be read that way — youtube.com sends no CORS
// header for the widget origin — so the fetch ALWAYS fails, the interceptor
// fires an `error` event, the script never executes, window.YT stays
// undefined, onYouTubeIframeAPIReady never resolves, and the media bar's
// trailers never autoplay. ONLY on the TV (a real browser has no interceptor
// and loads the API natively, so autoplay works there) — exactly the JEL-184
// report.
//
// Fix: isForeignOrigin(src) — resolve src against document.baseURI and skip
// interception when its origin differs from the server origin, letting the
// browser load it natively (mirrors the JEL-131 primer's same-origin guard).
//
// This test extracts the SHIPPED isForeignOrigin predicate from the real
// built seed (via buildSeedScript) and pins its behavior, then asserts all
// three interception entry points (appendChild/insertBefore, the src IDL
// setter, and setAttribute("src")) are gated by it.
//
// Run: node scripts/foreign-origin-passthrough.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
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

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");

// --- Build the real seed text from the shipped buildSeedScript() ------------
function extractTopFn(src, name) {
  const lines = src.split("\n");
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

const SERVER = "https://tv.example.test";
let seed;
{
  const fnSrc = extractTopFn(tvSrc, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  seed = buildSeedScript(SERVER + "/web/", {});
}
check(
  "built seed loads the JEL-184 foreign-origin guard",
  /function isForeignOrigin\(/.test(seed),
);

// --- Slice the shipped isForeignOrigin predicate out of the built seed ------
function sliceBraceFn(text, anchor) {
  const i = text.indexOf(anchor);
  if (i === -1) return null;
  let depth = 0,
    started = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") {
      depth++;
      started = true;
    } else if (c === "}") {
      depth--;
      if (started && depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

const fnText = sliceBraceFn(seed, "function isForeignOrigin(");
check("isForeignOrigin predicate extracted from seed", !!fnText);

// --- Behavioral: run the SHIPPED predicate against a controlled baseURI -----
// document.baseURI origin == the server (the shell writes <base href=server>).
function makeForeign(baseURI) {
  const sb = { URL, document: { baseURI } };
  vm.createContext(sb);
  vm.runInContext(fnText + "\nthis.__isForeign=isForeignOrigin;", sb);
  return sb.__isForeign;
}

if (fnText) {
  const isForeign = makeForeign(SERVER + "/web/index.html");

  // The media bar's YouTube API — the exact JEL-184 trigger. MUST be foreign
  // (passthrough → native load) so the API actually initializes on TV.
  check(
    "youtube.com/iframe_api is FOREIGN (native load, not intercepted)",
    isForeign("https://www.youtube.com/iframe_api") === true,
  );
  check(
    "youtube www-widgetapi.js is FOREIGN",
    isForeign("https://www.youtube.com/s/player/www-widgetapi.js") === true,
  );

  // Same-origin jellyfin-web plugin scripts MUST still be intercepted/transpiled.
  check(
    "absolute same-origin plugin URL is NOT foreign (still intercepted)",
    isForeign(SERVER + "/web/configurationpage?name=plugin.js") === false,
  );
  check(
    "relative plugin path is NOT foreign (resolves to server origin)",
    isForeign("/Trickplay/whatever.js") === false &&
      isForeign("modules/plugin.js") === false,
  );
  check(
    "protocol-relative same host is NOT foreign",
    isForeign("//tv.example.test/web/plugin.js") === false,
  );

  // A different host/scheme/port is foreign.
  check(
    "different CDN host is FOREIGN",
    isForeign("https://cdn.jsdelivr.net/npm/thing.js") === true,
  );
  check(
    "different port is FOREIGN",
    isForeign("https://tv.example.test:8920/web/plugin.js") === true,
  );

  // Robustness: an unparseable baseURI must DEFAULT to not-foreign (preserve
  // the pre-JEL-184 intercept behavior rather than newly skipping everything).
  const isForeignBadBase = makeForeign("not a url");
  check(
    "unparseable baseURI defaults to NOT foreign (safe fallback)",
    isForeignBadBase("https://www.youtube.com/iframe_api") === false,
  );
}

// --- Structural: all THREE interception gates must be wired to the guard ----
// 1) appendChild/insertBefore (shouldIntercept), 2) the src IDL setter,
// 3) setAttribute("src"). If any one drops the guard, foreign scripts get
// fetched again and the media bar regresses.
check(
  "GATE 1 — shouldIntercept() skips foreign origins",
  /if\(!src\|\|isBundle\(src\)\|\|isForeignOrigin\(src\)\)return null;/.test(
    tvSrc,
  ),
);
check(
  "GATE 2 — src IDL setter skips foreign origins",
  /!isShellInternal\(this\)&&v&&!isBundle\(v\)&&!isForeignOrigin\(v\)/.test(
    tvSrc,
  ),
);
check(
  'GATE 3 — setAttribute("src") skips foreign origins',
  /!isShellInternal\(this\)&&value&&!isBundle\(value\)&&!isForeignOrigin\(value\)/.test(
    tvSrc,
  ),
);

// --- Lockstep: the guard must survive into the shipped minified shell -------
const minSrc = fs.readFileSync(TV_MIN, "utf8");
check(
  "shell.min.js carries the foreign-origin guard (JEL-120 lockstep)",
  minSrc.indexOf("isForeignOrigin") !== -1,
);

if (failures) {
  console.error("\n" + failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("\nALL JEL-184 FOREIGN-ORIGIN PASSTHROUGH CHECKS PASS");
