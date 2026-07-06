// JEL-72 verification — JavaScript error tolerance: the shell introduces no
// uncaught exception during normal navigation, and its error layer is
// transparent (TV vs browser).
//
// CLAIM TO PROVE
//   Across a full session (launch → home → library → details → playback →
//   return → search → settings) the Tizen shell does not produce an uncaught
//   JavaScript exception that a plain browser running jellyfin-web would not
//   also produce. Equivalently: the shell's error surface is (a) TRANSPARENT
//   for the `error` event — it observes/records but never preventDefault()s, so
//   application exceptions surface to the engine exactly as in a browser; and
//   (b) ADDITIVE-DEFENSIVE for its own injected code — every shell IIFE/handler
//   is try/catch-wrapped so the shell itself cannot throw uncaught.
//
// THE ONE TV↔plain-browser ASYMMETRY (and why it cannot ADD an exception)
//   The diagnostic `unhandledrejection` handler DOES call e.preventDefault()
//   (JEL-562) — to quell the native Tizen dlog "[object Response]" noise — and
//   re-emits the reason via console.error. Net effect: a promise rejection that
//   a plain browser would leave UNCAUGHT becomes HANDLED on the TV (recorded +
//   re-logged, no default "Uncaught (in promise)"). So the set of uncaught
//   rejections on the TV is a SUBSET of the plain-browser set — the shell can
//   only REMOVE uncaught rejections, never add one. Our shell is byte-identical
//   whether it boots on the TV or in a browser, so "our-shell-in-browser" also
//   preventDefault()s; the only place a rejection is truly uncaught is a browser
//   with NO shell (stock jellyfin-web), which is the comparison baseline.
//
// WHERE A TV-ONLY EXCEPTION *COULD* COME FROM (out of scope here, by design)
//   A genuine TV-only throw can only originate in the JS ENGINE — M63/M69
//   lacking a language feature jellyfin-web uses — which is the transpile /
//   polyfill domain (JEL-21 details-page emission throw, JEL-38 BigInt,
//   JEL-44 worker subtitles). Those are tracked separately. This test pins the
//   ERROR-TOLERANCE contract: the shell's own code never throws uncaught, and
//   the shell never suppresses or injects an application `error` event.
//
// Run: node scripts/js-error-tolerance.test.cjs
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
const QA_BEACON = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "qa-beacon.js",
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

const shellSrc = fs.readFileSync(SHELL, "utf8");
const shellMin = fs.readFileSync(SHELL_MIN, "utf8");
const qaBeacon = fs.readFileSync(QA_BEACON, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

// Extract the body of the diagnostic `error` / `unhandledrejection` listeners
// as they appear in the source of record. Both shells build the same diagnostic
// seed script line-by-line as an array of string literals; we work on the joined
// source text so the line-array boundaries don't matter.
//
// The diagnostic `error` listener (NOT the narrow __qaBtnPlay one) records file,
// line:col, message + trimmed stack, and is registered capture-phase (`,true)`).
const DIAG_ERROR_RE =
  /addEventListener\(["']error["'],function\(e\)\{var st="";[\s\S]*?pushErr\(\{f:trimUrl\(e\.filename\)[\s\S]*?\},\s*true\)/;
// The diagnostic `unhandledrejection` listener records the reason, preventDefaults,
// and re-emits via the original console.error. This handler is built as several
// adjacent array-element string literals, so in the source FILE its tokens are
// separated by `",\n      "` scaffolding — the `[\s'",]*` right after `{` walks
// that scaffolding but cannot cross into the earlier narrow __qaBtnPlay listener
// (whose body opens `try{var r=...;var m=String(...)`, with letters the class
// rejects). Anchored on the diagnostic-only `var r=e&&e.reason;var msg=fmt(r)`.
const DIAG_REJECT_RE =
  /addEventListener\(["']unhandledrejection["'],function\(e\)\{[\s'",]*var r=e&&e\.reason;var msg=fmt\(r\)[\s\S]*?preventDefault\(\)[\s\S]*?origErr\.call\(console/;

// =====================================================================
// 1. The diagnostic `error` listener is TRANSPARENT (observe-only).
//    It must be capture-phase and must NOT call preventDefault/stopPropagation
//    in its body — otherwise it would swallow application errors on the TV that
//    a browser surfaces, which is itself a TV-vs-browser divergence.
// =====================================================================
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  const m = DIAG_ERROR_RE.exec(file.src);
  check(
    file.label + ": diagnostic `error` listener is present (capture-phase)",
    !!m,
    "diagnostic error-listener bytes not found",
  );
  if (m) {
    const body = m[0];
    check(
      file.label +
        ": `error` listener never preventDefault()s — app errors surface as in a browser",
      !/preventDefault|stopImmediatePropagation|stopPropagation|return\s+false/.test(
        body,
      ),
      "body suppresses the event",
    );
    check(
      file.label + ": `error` listener is observe-only (writes to __shellDiag)",
      /pushErr\(/.test(body),
    );
  }
}

// =====================================================================
// 2. The diagnostic `unhandledrejection` listener is the single intentional
//    divergence: it DOES preventDefault and re-emits. This can only REMOVE
//    uncaught rejections relative to a plain browser, never add one.
// =====================================================================
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  const m = DIAG_REJECT_RE.exec(file.src);
  check(
    file.label +
      ": diagnostic `unhandledrejection` listener records + preventDefault + re-emits",
    !!m,
    "diagnostic rejection-listener bytes not found",
  );
  if (m) {
    check(
      file.label +
        ": rejection handler preventDefault()s (TV-only: suppresses native dlog noise)",
      /preventDefault\(\)/.test(m[0]),
    );
    check(
      file.label +
        ": rejection handler re-emits via origErr (the reason is never lost, just re-logged)",
      /origErr\.call\(console/.test(m[0]),
    );
  }
}

// =====================================================================
// 3. Both shells carry the SAME diagnostic handlers (no per-shell drift).
// =====================================================================
{
  const a = DIAG_ERROR_RE.exec(shellSrc);
  const b = DIAG_ERROR_RE.exec(bootSrc);
  check(
    "shell.js and boot-shell.src.js define byte-identical `error` listeners",
    a && b && a[0] === b[0],
  );
  const c = DIAG_REJECT_RE.exec(shellSrc);
  const d = DIAG_REJECT_RE.exec(bootSrc);
  check(
    "shell.js and boot-shell.src.js define byte-identical `unhandledrejection` listeners",
    c && d && c[0] === d[0],
  );
}

// =====================================================================
// 4. The deployed minified blobs carry the same contract.
//    (The minifier folds the diagnostic + __qaBtnPlay listener sets together,
//    so we presence-check rather than pin exact bytes.)
// =====================================================================
for (const file of [
  { label: "shell.min.js", src: shellMin },
  { label: "boot-shell.min.js", src: bootMin },
]) {
  const flat = file.src.replace(/\s+/g, "");
  check(
    file.label + ": registers a global `error` listener",
    /addEventListener\("error",function/.test(flat),
  );
  check(
    file.label +
      ": registers an `unhandledrejection` listener that preventDefault()s",
    /addEventListener\("unhandledrejection",function\(e\)\{[^}]*preventDefault/.test(
      flat,
    ) || /unhandledrejection[\s\S]{0,400}?preventDefault/.test(flat),
  );
}

// =====================================================================
// 5. RUNTIME model: the `unhandledrejection` handler is a SUBSET reducer.
//    Faithful transcription of the diagnostic handler. Prove it records the
//    reason, marks the event prevented, re-logs once, and never rethrows — for
//    Error reasons, string reasons, and (the JEL-562 case) Response-like reasons.
// =====================================================================
{
  // Minimal fmt() faithful to the shell: Error → "Name:message", else String().
  function fmt(s) {
    if (s == null) return "";
    if (typeof s === "string") return s;
    try {
      if (s instanceof Error)
        return (s.name || "Error") + ":" + (s.message || "");
    } catch (_) {}
    try {
      return String(s);
    } catch (_) {
      return "[unstringable]";
    }
  }
  const recorded = [];
  const reLogged = [];
  const origErr = function () {
    reLogged.push(Array.prototype.slice.call(arguments).join(" "));
  };
  // mirror of: function(e){var r=e&&e.reason;var msg=fmt(r);pushErr({f:"reject",l:0,m:msg});
  //            try{e.preventDefault();}catch(_){}; try{origErr.call(console,"...",msg);}catch(_){}}
  function rejectionHandler(e) {
    var r = e && e.reason;
    var msg = fmt(r);
    recorded.push(msg);
    try {
      e.preventDefault();
    } catch (_) {}
    try {
      origErr.call(console, "shell: unhandled rejection:", msg);
    } catch (_) {}
  }
  const reasons = [
    new Error("boom"),
    "plain string reason",
    { status: 404, url: "https://x/y", statusText: "Not Found" }, // Response-like
    null,
    undefined,
  ];
  let threw = false;
  let allPrevented = true;
  for (const reason of reasons) {
    const ev = {
      reason: reason,
      prevented: false,
      preventDefault: function () {
        this.prevented = true;
      },
    };
    try {
      rejectionHandler(ev);
    } catch (e) {
      threw = true;
    }
    if (!ev.prevented) allPrevented = false;
  }
  check("rejection handler never rethrows (any reason shape)", !threw);
  check(
    "rejection handler preventDefault()s every rejection (→ handled, not uncaught on TV)",
    allPrevented,
  );
  check(
    "rejection handler records every reason (nothing is silently dropped)",
    recorded.length === reasons.length,
  );
  check(
    "rejection handler re-logs every reason exactly once (audit trail preserved)",
    reLogged.length === reasons.length,
  );
}

// =====================================================================
// 6. RUNTIME model: the config.json fetch shim is a transparent passthrough.
//    It must answer ONLY the config.json request from the seeded server and
//    delegate every other request to the original fetch — and never throw,
//    regardless of input shape (string URL, Request-like object, garbage).
// =====================================================================
{
  // Transcription of the shipped shim (shell.js ~line 660):
  //   window.fetch=function(i,init){var u=typeof i==="string"?i:(i&&i.url)||"";
  //     if(matches(u))return Promise.resolve(new Response(CFG,{status:200,...}));
  //     return origFetch.call(this,i,init);};
  const CFG = '{"ServerUrl":"https://demo.example"}';
  const matches = function (u) {
    return /\/web\/config\.json(\?|$)/.test(String(u || ""));
  };
  let origFetchCalls = [];
  const origFetch = function (i, init) {
    origFetchCalls.push(typeof i === "string" ? i : (i && i.url) || "");
    return Promise.resolve("ORIG:" + (typeof i === "string" ? i : ""));
  };
  function shimFetch(i, init) {
    var u = typeof i === "string" ? i : (i && i.url) || "";
    if (matches(u))
      return Promise.resolve({ __synthetic: true, status: 200, body: CFG });
    return origFetch.call(this, i, init);
  }

  let threw = false;
  const inputs = [
    "https://demo.example/web/config.json", // intercepted
    "https://demo.example/web/config.json?v=2", // intercepted (query)
    "https://demo.example/Users/Public", // passthrough (string)
    { url: "https://demo.example/System/Info" }, // passthrough (Request-like)
    null, // garbage — must not throw
    undefined,
    12345,
    {},
  ];
  const results = [];
  for (const i of inputs) {
    try {
      results.push(shimFetch(i));
    } catch (e) {
      threw = true;
    }
  }
  check(
    "fetch shim never throws (string / Request / null / garbage inputs)",
    !threw,
  );
  // config.json calls are answered synthetically (origFetch NOT invoked for them).
  check(
    "fetch shim answers config.json itself (origFetch not called for config.json)",
    !origFetchCalls.some((u) => /config\.json/.test(u)),
    "origFetchCalls=" + JSON.stringify(origFetchCalls),
  );
  // Everything else is delegated to origFetch (transparent passthrough).
  check(
    "fetch shim delegates every non-config request to the original fetch",
    origFetchCalls.length === 6, // 8 inputs − 2 config.json
    "delegated=" + origFetchCalls.length,
  );
}

// =====================================================================
// 7. RUNTIME model: the Babel transpile helper never throws — it returns null
//    on any failure so the shell falls back to the original source instead of
//    crashing. (shell.js ~line 890.)
// =====================================================================
{
  // Transcription of (JELA-11 shape): function transpile(code){if(typeof
  //   window.Babel==="undefined")return null;var out;try{out=window.Babel
  //   .transform(...).code;}catch(_){return null;}if(typeof out==="string"
  //   &&__ppOn()&&!__ppParses(out))return null;return out;}
  //   (probe verification exercised in parse-probe.test.cjs; here we pin the
  //   never-throws contract, so the transcription omits the probe gate.)
  function makeTranspile(win) {
    return function transpile(code) {
      if (typeof win.Babel === "undefined") return null;
      try {
        return win.Babel.transform(code, {}).code;
      } catch (_) {
        return null;
      }
    };
  }
  let threw = false;
  let r1, r2, r3;
  try {
    // (a) Babel absent → null, no throw.
    r1 = makeTranspile({})("const x = 1;");
    // (b) Babel.transform throws (e.g. BigInt / parse error) → null, no throw.
    r2 = makeTranspile({
      Babel: {
        transform: function () {
          throw new Error("cannot transform 10n");
        },
      },
    })("const x = 10n;");
    // (c) Babel succeeds → transpiled code returned.
    r3 = makeTranspile({
      Babel: {
        transform: function (c) {
          return { code: "var x=1;" };
        },
      },
    })("const x = 1;");
  } catch (e) {
    threw = true;
  }
  check(
    "transpile() never throws (Babel absent / Babel throws / Babel ok)",
    !threw,
  );
  check("transpile() returns null when Babel is absent", r1 === null);
  check(
    "transpile() returns null when Babel.transform throws (no crash)",
    r2 === null,
  );
  check("transpile() returns transpiled code on success", r3 === "var x=1;");
  // Source-of-record: the shipped helper actually catches and returns null
  // (JELA-11: Babel output is additionally probe-verified before return).
  check(
    "shell.js transpile() wraps Babel.transform in try/catch → return null",
    /function transpile\(code\)\{if\(typeof window\.Babel==="undefined"\)return null;var out;try\{out=window\.Babel\.transform\([\s\S]*?\)\.code;\}catch\(_\)\{return null;\}if\(typeof out==="string"&&__ppOn\(\)&&!__ppParses\(out\)\)return null;return out;\}/.test(
      shellSrc,
    ),
  );
}

// =====================================================================
// 8. Injected runtime handlers are additive-defensive (try/catch wrapped).
//    The highest-risk per-keystroke / per-navigation handlers run on every
//    D-pad press and route change; a throw there would surface during normal
//    navigation. Each is wrapped so it cannot.
// =====================================================================
for (const file of [
  { label: "shell.js", src: shellSrc },
  { label: "boot-shell.src.js", src: bootSrc },
]) {
  // The focus-rescue / autofocus IIFE is wrapped in `try{(function(){...})();}catch(_){}`.
  check(
    file.label + ": focus-rescue/autofocus IIFE is try/catch wrapped",
    /try\{\(function\(\)\{var K=\{ArrowUp:1[\s\S]*?\}\)\(\);\}catch\(_\)\{\}/.test(
      file.src,
    ),
  );
  // Inside it, the keydown handler's focus() work is itself guarded.
  check(
    file.label + ": keydown focus-rescue guards its DOM work with try/catch",
    /addEventListener\("keydown",function\(e\)\{[\s\S]*?try\{var t=findT\(\);[\s\S]*?\}catch\(_\)\{\}/.test(
      file.src,
    ),
  );
}

// =====================================================================
// 9. The QA beacon's error/rejection capture is also non-intrusive.
//    The beacon records errors for telemetry but must NOT preventDefault the
//    `error` event (observe-only) and must wrap its own work in try/catch.
// =====================================================================
{
  check(
    "qa-beacon.js registers `error` + `unhandledrejection` listeners (capture-phase)",
    /addEventListener\(\s*["']error["'],\s*function\s*\(ev\)/.test(qaBeacon) &&
      /addEventListener\(\s*["']unhandledrejection["'],\s*function\s*\(ev\)/.test(
        qaBeacon,
      ),
  );
  // The beacon's error handler is observe-only: it pushes the message and does
  // not preventDefault (so it does not alter whether the app error is uncaught).
  const beaconErr =
    /addEventListener\(\s*["']error["'],\s*function\s*\(ev\)\s*\{[\s\S]*?pushError\([\s\S]*?\},\s*true,?\s*\)/.exec(
      qaBeacon,
    );
  check("qa-beacon `error` handler block found", !!beaconErr);
  if (beaconErr) {
    check(
      "qa-beacon `error` handler is observe-only (no preventDefault)",
      !/preventDefault/.test(beaconErr[0]),
    );
  }
  check(
    "qa-beacon wraps its listener registration in try/catch (cannot break boot)",
    /try\s*\{\s*window\.addEventListener\(\s*["']error["'][\s\S]*?addEventListener\(\s*["']unhandledrejection["'][\s\S]*?\}\s*catch\s*\(e\)\s*\{\}/.test(
      qaBeacon,
    ),
  );
}

// =====================================================================
// 10. The error handlers are NOT UA-gated. The shell ships byte-identical to
//     the TV and a browser, so error behavior is identical by construction —
//     there is no `if (isTizen)` branch around the diagnostic handlers that
//     could make the TV behave differently from a browser during navigation.
// =====================================================================
{
  const m = DIAG_REJECT_RE.exec(shellSrc);
  const errM = DIAG_ERROR_RE.exec(shellSrc);
  check(
    "diagnostic handlers contain no UA/Tizen gating (TV == browser by construction)",
    m &&
      errM &&
      !/userAgent|tizen|webapis|isTizen/i.test(m[0]) &&
      !/userAgent|tizen|webapis|isTizen/i.test(errM[0]),
  );
}

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All JS error-tolerance parity checks passed.");
