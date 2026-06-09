# JEL-81 — Compare: Seed script injection (\_\_TXVER, NativeShell override, focus rescue)

**Verdict: PASS.** `buildSeedScript()`'s output is injected before any remote
jellyfin-web script runs, and all four ticket items are established when the seed
installs. TV (Chromium 56) and browser (Chrome 120) are **identical** for the
seed body; the only intended divergence is _which code path owns_ `window.__TXVER`.

Verified by `packages/shell-tizen/scripts/seed-injection.test.cjs` (67/67 checks,
wired into the shell-tizen `test` script). The test recomputes the cache hash,
runs the **actual** extracted `buildSeedScript()` output in a DOM sandbox under
both user agents, and introspects `window` — the "window introspection" the
ticket asks for. No re-transcription of shell logic; everything is pulled from
the shipping `shell.js` bytes.

## What the seed establishes (and where)

| #   | Ticket item                         | Set by                                                  | TV (Chromium 56)          | Browser (Chrome 120)           |
| --- | ----------------------------------- | ------------------------------------------------------- | ------------------------- | ------------------------------ |
| 1   | `window.__TXVER` = correct hash     | static shell (`shell.js:119`, unconditional) **+** seed | seed re-asserts on legacy | static-only (seed skips)       |
| 2   | body-focus rescue keydown listener  | seed (capture phase, `__shellBodyFocusRescueBound=1`)   | installed                 | installed (identical)          |
| 3   | auto-focus interval (600 ms)        | seed (`setInterval(…,600)`, budget 24)                  | running, budget 24        | running, budget 24 (identical) |
| 4   | NativeShell getPlugins/downloadFile | static `window.NativeShell` (widget origin, pre-write)  | `[]` / no-op              | `[]` / no-op                   |

## The one TV/browser divergence — `__TXVER` ownership

There is **no `tizen` branch** in `buildSeedScript()`. The seed body is byte-for-byte
the same on both platforms. The only conditional is the server-origin transpile
machinery, which re-asserts `window.__TXVER` so its localStorage cache prefix
(`shell.tx<ver>:`) matches the widget-side prefix. That block is legacy-gated:

```js
var m = /(?:Chrome|Chromium)\/(\d+)\./.exec(navigator.userAgent);
var legacy = !!(m && parseInt(m[1], 10) < 70);
if (!legacy) { try { new Function("var a={};return a?.b"); } catch (_) { legacy = true; } }
if (!legacy) return;            // modern browser: nothing to transpile
...
var __TXVER = "<hash>"; try { window.__TXVER = __TXVER; } catch (_) {}
```

- **TV (Chromium 56)**: `legacy` is true → the seed sets `window.__TXVER` itself,
  so the server-origin transpile cache and the widget-origin cache share a key.
- **Browser (modern Chrome)**: `legacy` is false → the seed returns early and
  never touches `__TXVER`. The value still exists on `window` because the **static
  shell** set it unconditionally at `shell.js:119` (`window.__TXVER = TX_VER`) on
  the widget origin, and `window` persists across `document.write`.

Both paths resolve to the **same derived hash**. The test recomputes that hash
independently from `shell.js`'s own inputs (the extracted `txFnv1a` over
`MODERN_SYNTAX_RE_SRC | BABEL_OPTS_KEY | BABEL_FPR`) and asserts the static
assignment, the embedded seed literal, and the TV runtime value all equal it.
In this environment (unbuilt `BABEL_FPR` placeholder) the hash is `io1hbs`; the
test pins the relationship, not the literal — a real build substitutes
`BABEL_FPR` and the hash moves in lockstep across static and seed.

## Injection order & timing (before remote scripts)

Both injection paths place the seed `<script data-shell-seed="1">` into `<head>`,
**before** jellyfin-web's body scripts, in the order `diag → <base> → seed → polyfill`:

- **TV path** (`document.open/write`): the injection block is spliced at
  `headIdx + 6` (immediately after `<head>`) via `html.slice(0, insertAt) + injected`.
- **Browser path** (DOM): `insertBefore(seedTag, baseTag.nextSibling)` — right
  after `<base>`, before any remote `<script>`.

Liveness proof: after running the seed, the overridden `window.fetch("…/config.json")`
resolves to `{ servers: ["https://tv.example.test"], multiserver: false, … }` with
upstream fields preserved — confirming the config intercept is active before
jellyfin-web boots, which is what lands the user on the server's login UI without
a second "Add Server" step.

## Artifact coverage

All four shipped artifacts carry the seed and its four features:
`shell.js`, `shell.min.js`, `boot-shell.src.js`, `boot-shell.min.js`.

## How to reproduce

```
node packages/shell-tizen/scripts/seed-injection.test.cjs
# or: pnpm --filter @jellyfin-tv/shell-tizen test
```

Exits non-zero on any drift between the shipped bytes and this contract.
