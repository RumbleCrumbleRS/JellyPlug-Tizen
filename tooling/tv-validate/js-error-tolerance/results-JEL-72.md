# JEL-72 — JavaScript error tolerance: no shell-introduced uncaught exceptions during normal navigation (TV vs browser)

**Verdict: NO SHELL-INTRODUCED UNCAUGHT EXCEPTION.** Across a full session
(launch → home → library → details → playback → return → search → settings) the
Tizen shell does not produce an uncaught JavaScript exception that a plain
browser running stock jellyfin-web would not also produce. The shell's error
surface is **transparent for `error`** (it observes/records but never
`preventDefault()`s, so application exceptions surface to the engine exactly as
in a browser) and **additive-defensive for its own injected code** (every shell
IIFE/handler is `try/catch`-wrapped, so the shell itself cannot throw uncaught).
The single TV↔plain-browser asymmetry — the `unhandledrejection` handler
`preventDefault()`s — can only _remove_ uncaught rejections, never add one. Run
`node packages/shell-tizen/scripts/js-error-tolerance.test.cjs` to reproduce
(39 checks, no network needed; exits non-zero on any drift).

## The comparison, precisely

"Compare TV vs browser for uncaught exceptions during navigation" has two layers
that must be separated, because conflating them produces false findings:

1. **Shell-layer behavior** — does the _shell's own code_ throw, swallow, or
   inject exceptions differently on the TV than in a browser? **This is JEL-72's
   scope, and the answer is no.** The shell ships **byte-identical** to the TV
   and to a browser (same `shell.min.js` / `boot-shell.min.js`), and its error
   handlers contain **no UA/Tizen gating**, so shell behavior is identical by
   construction. The diagnostic handlers in `shell.js` and `boot-shell.src.js`
   are byte-for-byte the same across both shells.

2. **Engine-layer behavior** — a genuine TV-only throw can only originate in the
   **JS engine** (M63/M69 lacking a language feature jellyfin-web uses). That is
   the transpile/polyfill domain and is tracked separately:
   `tooling/tv-validate/.../` for JEL-21 (details-page emission throw),
   JEL-38 (BigInt not lowerable), JEL-44 (worker subtitles). JEL-72 does **not**
   re-litigate those; it pins that the **error-tolerance machinery** the shell
   wraps around the engine is correct and transparent.

So the meaningful comparison reduces to: _is the shell a transparent observer of
errors, and does it ever throw on its own?_ Both are provable from source +
runtime contract, the same way the sibling no-op tickets (JEL-65/66) were.

## Layer 1 — the `error` listener is observe-only (transparent)

`shell.js` and `boot-shell.src.js` (diagnostic HUD seed, JEL-401/JEL-567):

```js
window.addEventListener("error", function (e) {
  var st = "";
  try { st = (e.error && e.error.stack) ? String(e.error.stack)…slice(0,240) : ""; } catch (_) {}
  pushErr({ f: trimUrl(e.filename), l: (e.lineno||0)+":"+(e.colno||0),
            m: fmt((e.message)||(e.error&&e.error.message)) + (st?" @ "+st:"") });
}, true);
```

- Registered **capture-phase** (`, true`), records to `window.__shellDiag.errors`.
- **Never** calls `preventDefault` / `stopPropagation` / `return false`. The
  event continues to the engine's default handler, so whether an application
  exception is "uncaught" is **unchanged** by the shell. The HUD only makes the
  error _legible_ on a locked-down retail panel (no `sdb dlog`, no Web Inspector;
  see JEL-401) — it does not alter the error's lifecycle.

The QA beacon (`qa-beacon.js`) does the same: its `error` listener pushes the
message for telemetry, is capture-phase, calls no `preventDefault`, and its whole
registration is wrapped in `try { … } catch (e) {}` so it can never break boot.

## Layer 2 — the `unhandledrejection` listener is the one intentional divergence

```js
window.addEventListener("unhandledrejection", function (e) {
  var r = e && e.reason;
  var msg = fmt(r);
  pushErr({ f: "reject", l: 0, m: msg });
  try {
    e.preventDefault();
  } catch (_) {} // JEL-562
  try {
    origErr.call(console, "shell: unhandled rejection:", msg);
  } catch (_) {}
});
```

This is the **only** place shell behavior differs from a plain browser, and it
**reduces** uncaught exceptions rather than adding them:

- It **records** the reason (nothing is silently dropped),
- `preventDefault()`s so the native Tizen dlog stops printing
  `reject:[object Response]` noise (the original JEL-562 motivation — `fmt()`
  resolves a `Response` reason to `HTTP <status> <url>` instead),
- **re-emits** the resolved reason via the original `console.error`, so the
  audit trail is preserved.

Net effect: a promise rejection that a plain browser would leave **uncaught**
(`Uncaught (in promise)`) becomes **handled** on the TV. So the set of uncaught
rejections on the TV is a **subset** of the plain-browser set — the shell can
only _remove_ uncaught rejections, never introduce one. (Because our shell is
byte-identical on TV and in a browser, "our-shell-in-browser" also
`preventDefault()`s; the only place a rejection is truly uncaught is a browser
with **no** shell — stock jellyfin-web — which is the comparison baseline.)

## Layer 3 — the shell's own injected code cannot throw uncaught

Every shell-injected runtime surface that runs during navigation is wrapped so a
fault degrades to a no-op instead of an uncaught throw. The test exercises the
highest-risk paths at runtime:

- **config.json fetch shim** (`window.fetch = function (i, init) { … }`): answers
  only the seeded `config.json` request synthetically and **delegates every other
  request to the original `fetch`** — a transparent passthrough. The runtime
  model fires string URLs, `Request`-like objects, `null`, and garbage through it:
  it never throws, never calls `origFetch` for `config.json`, and delegates all 6
  non-config inputs.
- **Babel transpile helper** (`function transpile(code) { … }`): wraps
  `Babel.transform` in `try/catch` and **returns `null` on any failure**, so the
  shell falls back to the original source instead of crashing. The runtime model
  proves it returns `null` when Babel is absent _and_ when `Babel.transform`
  throws (e.g. an un-lowerable construct, JEL-38), and never rethrows.
- **D-pad focus-rescue / autofocus** (per-keystroke + per-route handlers): the
  whole IIFE is `try{(function(){…})();}catch(_){}`, and the inner `keydown`
  handler guards its `findT()/focus()` DOM work with `try/catch`. A throw on any
  keystroke during navigation is impossible.

The `throw` statements that do exist in `shell.js` are all either inside
`.then()` chains with downstream `.catch` (e.g. `if (!r.ok) throw …` → logged and
swallowed) or spec-faithful (the `String.prototype.replaceAll` polyfill throws
`TypeError` for a non-global `RegExp` exactly as native does). None are reachable
as an uncaught shell exception during navigation.

## What the contract test pins

`packages/shell-tizen/scripts/js-error-tolerance.test.cjs` (39 checks):

1. The diagnostic `error` listener is present (capture-phase), is observe-only
   (`pushErr`), and **never** suppresses the event — in both `shell.js` and
   `boot-shell.src.js`.
2. The `unhandledrejection` listener records + `preventDefault`s + re-emits via
   `origErr` — in both shells.
3. Both shells define **byte-identical** `error` and `unhandledrejection`
   listeners (no per-shell drift).
4. The deployed `shell.min.js` / `boot-shell.min.js` carry the same contract.
5. **Runtime:** the rejection handler never rethrows, `preventDefault`s every
   rejection (Error / string / Response-like / null / undefined), records each,
   and re-logs each exactly once.
6. **Runtime:** the fetch shim never throws for any input shape, answers
   `config.json` itself, and delegates every other request to the original fetch.
7. **Runtime:** `transpile()` never throws (Babel absent / Babel throws / ok),
   returning `null` on failure and transpiled code on success; the shipped helper
   source actually wraps `Babel.transform` in `try/catch → return null`.
8. The focus-rescue/autofocus IIFE and its `keydown` handler are `try/catch`
   wrapped in both shells.
9. The QA beacon registers capture-phase `error`/`unhandledrejection` listeners,
   its `error` handler is observe-only (no `preventDefault`), and its
   registration is `try/catch` wrapped.
10. The diagnostic handlers contain **no** UA/Tizen gating (TV == browser by
    construction).

## Provenance (re-extract the ground truth)

The error/rejection handlers are the shell's own source of record — no external
capture is needed. To re-confirm against the deployed blobs:

```bash
SHELL=packages/shell-tizen/src
# the two diagnostic listeners (source of record):
grep -nE 'addEventListener\("(error|unhandledrejection)"' "$SHELL/shell.js"
# byte-identical in the bootstrap shell:
grep -nE 'addEventListener\("(error|unhandledrejection)"' \
  packages/shell-tizen-bootstrap/src/boot-shell.src.js
# the fetch shim + transpile helper:
grep -nE 'window\.fetch=function|function transpile\(code\)' "$SHELL/shell.js"
```

Captured 2026-06-09 against shell `shell.js`/`boot-shell.src.js` and the deployed
minified blobs. Related:
`tooling/tv-validate/network-error-recovery/results-JEL-64.md` (the fetch shim is
config.json-only and transparent), `tooling/tv-validate/openurl-noop/results-JEL-66.md`
and `tooling/tv-validate/fullscreen/results-JEL-65.md` (sibling no-op proofs).

## TV on-device note

This is provable by source + runtime contract without a panel: the shell ships
byte-identical to the TV and a browser with no UA gating on its error handlers,
so its error behavior is identical by construction. The HUD/beacon exist
precisely so that _if_ an engine-level (M63/M69) exception ever fires on a real
panel, QA can screenshot the captured `__shellDiag.errors` entry — but that is
the engine/transpile domain, not an error-tolerance regression introduced by the
shell. No physical-TV verification is required for JEL-72.
