# JEL-37 — Plugin-loading compare (Browser vs Tizen 5.0 / Chromium 56)

`verify-plugin-loading.mjs` confirms that the server-injected Jellyfin plugin
`<script>` tags in `/web/index.html` are **detected, fetched, and processed**
by both render paths the JellyPlug shell has to support:

- **Browser path** — modern Chromium runs the plugin bodies verbatim.
- **Tizen 5.0 path** — `packages/shell-tizen/src/shell.js` must intercept each
  non-bundle plugin `<script src>`, run `needsTranspile()` / Babel for any
  ES2020+ syntax, jQuery-gate where needed, and inline a body that itself
  parses on Chromium 56. A single un-transpiled `?.` token SyntaxErrors at
  parse time and silently kills the whole plugin module (JEL-401/406/407).

## What it verifies

For every plugin script the shell would treat as a plugin (the same
`isJellyfinWebBundle` filter `transpileLegacyScriptsInner` uses):

1. HTTP fetch succeeds (status + byte size).
2. **Browser path:** raw body parses on a modern engine (Node's V8).
3. **TV path:** `needsTranspile()` decision, Babel→`chrome:63` transpile (or
   raw fast-path), jQuery-gate wrap, then the **inlined body parses** — i.e. it
   will not re-throw the SyntaxError the shell set out to prevent.

The reported `shellPluginCount_scriptsFound` is the exact value the on-device
diagnostic surfaces as `window.__shellDiagInit.scriptsFound` (HUD line
`plugins found=N`). There is no `window.__shellPluginCount`; `scriptsFound`
(static plugin scripts) + `window.__shellInterceptCount` (dynamically-injected
ones) are the equivalents the issue refers to.

The detection regex (`MODERN_SYNTAX_RE_SRC`) and Babel options are copied
**verbatim** from `shell.js` and guarded by a lockstep check that fails loudly
if `shell.js` drifts.

## Run

```bash
JELLYFIN_URL=https://your-server node \
  tooling/tv-validate/plugin-loading/verify-plugin-loading.mjs
```

Reads `JELLYFIN_URL` from the environment. Writes
`plugin-loading-report.json` next to the script. Exit 0 = every detected
plugin fetched + parse-clean on both paths.

## Scope / limitation

This proves the **load → fetch → transpile → inject** pipeline (the
JellyPlug-owned failure mode). It does **not** confirm _runtime_ registration
or pixel-level UI parity on the physical locked M63 retail TV — that is a
runtime concern (cf. JEL-17, where transpile worked but a plugin threw at
runtime) and is gated behind the phone-home debug build / `__shellDiagInit`
read, not an inspector. Track that as a separate on-device pass.
