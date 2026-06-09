# JEL-75 — jQuery-dependent plugin deferred execution (TV vs browser)

**Verdict: DETECTION FIRES, DEFERRAL WORKS, PLUGIN RUNS WITHIN 10 s IN BOTH
ENVIRONMENTS.** When an installed server plugin references `$`/`jQuery` in a body
the shell inlines, `needsJq()` (regex `/\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/`)
detects it and `wrapJq()` defers execution until `window.jQuery` is defined,
polling every 20 ms with a 10 s hard ceiling. The detector and the wrapper are
**byte-identical regardless of platform** — there is no `tizen` branch. The only
difference TV vs browser is _when window.jQuery exists_, which the wrapper's two
exits absorb: the browser hits the synchronous fast path (t=0, exact parity) and
the TV hits the poller (runs the instant jQuery appears, always ≤ 10 s). Run
`node packages/shell-tizen/scripts/jquery-gate.test.cjs` to reproduce (44 checks,
no network; exits non-zero on any drift).

## The two pieces of the gate (source of record)

`packages/shell-tizen/src/shell.js`. The gate exists **twice** so every inline
path is covered, but both copies share one regex and one 10 s wrapper:

|                                         | Used by                                                                                                   | Form                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `needsJQueryGate()` / `wrapForJQuery()` | `transpileLegacyScripts()` — the HTML-rewrite stage (fast path + babel path)                              | real JS (`shell.js:1438–1456`)                     |
| `needsJq()` / `wrapJq()`                | runtime DOM-mutation interceptors `rewrite()` (appendChild/insertBefore) and `srcPipeline()` (src-setter) | emitted as an injected string (`shell.js:937–939`) |

Detection (both copies):

```js
var JQUERY_REF_RE = /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/;
function needsJQueryGate(code) {
  return JQUERY_REF_RE.test(code);
}
```

Deferral wrapper (both copies, structurally identical):

```js
(function () {
  function __run() {
    /* …plugin body… */
  }
  if (typeof window.jQuery !== "undefined") {
    __run();
    return;
  } // ← browser fast path
  var __to;
  var __t = setInterval(function () {
    // ← TV poller, 20 ms
    if (typeof window.jQuery !== "undefined") {
      clearInterval(__t);
      clearTimeout(__to);
      try {
        __run();
      } catch (e) {
        console.error("shell: deferred plugin failed", e && e.message);
      }
    }
  }, 20);
  __to = setTimeout(function () {
    // ← 10 s safety net
    clearInterval(__t);
    console.warn("shell: jQuery wait timed out, running anyway");
    try {
      __run();
    } catch (e) {
      console.error("shell: deferred plugin failed", e && e.message);
    }
  }, 10000);
})();
```

When the gate fires, the inlined `<script>` node is tagged
`data-shell-jquery-gated="1"` so QA can observe deferral on-device.

## Why the TV needs this and the browser does not (JEL-405 / JEL-407)

- **Browser** (jellyfin-web served normally): jQuery
  (`node_modules.jquery.bundle.js`) loads as an ordinary `<script src>` in source
  order. By the time any plugin body runs, `window.jQuery` is already present, so
  the wrapper's first line runs the plugin **synchronously at t=0** — zero
  deferral. (And a plain browser with no shell never wraps anything; the plugin
  `<script src>` just loads after jQuery natively.)
- **TV** (Tizen 5.0 / Chromium 56, inside our shell): the shell XHR-fetches each
  plugin's `<script src>` and re-inlines the body via `textContent` to control
  transpilation and CSP/blob constraints. Inlining **loses the async-load
  ordering**, and the jQuery bundle is deliberately _not_ transpiled (it stays a
  normal `<script src>`), so it may not have finished evaluating when the inlined
  plugin body executes. Without the gate that is a hard
  `ReferenceError: $ is not defined` at parse time, which is exactly what broke
  JellyfinEnhanced sub-modules (discovery-filter-utils, seamless-scroll,
  bookmarks-library, …). The gate bridges the gap: poll until `window.jQuery`
  appears (a few hundred ms in practice), then run — never a crash.

So the comparison is a **timing** story, not a code-branch story: same detector,
same wrapper, same 10 s bound; the browser exits via the synchronous fast path
and the TV exits via the poller. Both end with the plugin executed.

## What the test proves (`scripts/jquery-gate.test.cjs`, 44 checks)

**Part A — contract (source pins).** Both gate implementations exist; static and
dynamic copies use the _same_ regex and the _same_ 10 s / 20 ms wrapper; the gate
is wired into all four inline call sites (fast path, babel path, `rewrite()`,
`srcPipeline()`); gated nodes are tagged `data-shell-jquery-gated`; and the
wrapper ships in **all four artifacts** (`shell.js`, `shell.min.js`,
`boot-shell.src.js`, `boot-shell.min.js`) — no boot path lacks it.

**Part B — detection.** Runs the shipped regex over real-world snippets. Fires on
`jQuery(...)`, `$(sel)` at body start, after whitespace/newline, and after a
non-identifier char, and on `window.jQuery.fn`. Stays quiet (no needless
deferral) on `` `$${x}` `` template literals, a `$el` identifier never called as
`$()`, member `.$( `, `a$ (b)`, and `$.5`.

**Part C — deferral, executing the SHIPPED wrapper under a virtual clock**
(`wrapForJQuery()` is extracted from `shell.js` and run in a `vm` sandbox whose
timers are a fake clock — the literal shipped logic, no re-transcription):

| Scenario           | window.jQuery appears      | Plugin executes at                    | Timeout warn |
| ------------------ | -------------------------- | ------------------------------------- | ------------ |
| **Browser parity** | t=0 (already present)      | **t=0, synchronous**                  | no           |
| **TV typical**     | t≈290 ms (bundle finishes) | **t=300 ms** (first poll tick after)  | no           |
| **TV edge**        | t=9.97 s                   | t=9.98 s (poller, before timeout)     | no           |
| **TV worst case**  | never                      | **t=10.0 s** (timeout runs it anyway) | yes          |

The key parity result: in **every** case the plugin runs, and on the TV it always
runs **within the 10 s ceiling** — instantly when jQuery is already there
(browser), at the first 20 ms tick after jQuery loads (TV typical), and at the
10 s bound with a `console.warn` if jQuery never loads (worst case — never
silently dropped).

## Live plugins this covers

The test server carries 6 server plugins (see
`tooling/tv-validate/plugin-loading/`). JellyfinEnhanced and its sub-modules are
the jQuery users that motivated JEL-405/407; their bodies contain `$(...)` calls
that `needsJq()` flags, so on the TV they are wrapped and deferred, and in the
browser they run synchronously. Non-jQuery plugins (plain DOM/CSS injectors) are
_not_ wrapped, so they incur zero added latency on either platform.

## TV on-device note

This is provable by source + executing the shipped wrapper under a deterministic
clock, because the gate has no platform branch — the same `wrapForJQuery()` bytes
run on the TV and in a browser, and the timing scenarios above bracket the real
Chromium-56 ordering (jQuery bundle a few hundred ms behind the inlined body). On
a panel, a gated plugin shows `data-shell-jquery-gated="1"` on its inlined
`<script>` and, in the rare timeout case, a `shell: jQuery wait timed out`
warning in the `__shellDiag` HUD. No physical-TV verification is required for
JEL-75. Related: `tooling/tv-validate/plugin-loading/` (JEL-37 load harness),
`tooling/tv-validate/bundle-patch/` (transpile pipeline).

Captured 2026-06-09 against `shell.js` @ JEL-75; regex and 10 s bound encoded in
the test so it runs offline.
