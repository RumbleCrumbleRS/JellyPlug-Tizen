# @jellyfin-tv/shell-core

Single definition site for functions that used to be hand-mirrored across the
two Tizen shells:

- `packages/shell-tizen/src/shell.js` — retail, hosted `/shell/` drop
- `packages/shell-tizen-bootstrap/src/boot-shell.src.js` — HSB baked fallback

Before this package they were duplicated line-for-line and only _guarded_ (the
`cross-shell-parity.test.cjs` mirror check, JEL-624). This package deletes the
duplication instead: the shared body lives here once and is spliced into both
shells at build time. See **JEL-644**.

## How it works (build-time text substitution — NOT a bundler)

Both shells are single-file IIFE bundles built with
`esbuild --minify-whitespace --minify-syntax` (no mangle, no bundler). Adding
`import`s would force esbuild `--bundle` and change the IIFE / public-symbol
semantics the parity + `verify_*_src.py` guards depend on. So instead:

- `src/shell-core.src.js` is a **raw JS fragment** (no IIFE wrapper, no
  top-level `"use strict"`, no imports). Each function sits between
  `//@@BEGIN:name@@` / `//@@END:name@@` delimiters.
- Each entry file carries a `//@@SHELL_CORE:name@@` marker line where the
  function used to be.
- A shared `expand()` splices the fragment in place before esbuild runs:
  - `expand.py` — used by `build_shell_min.py`, `verify_shell_src.py`,
    `build_boot_shell.py`, `verify_boot_shell_src.py`.
  - `expand.cjs` — used by `cross-shell-parity.test.cjs` (and the future
    shared test loader).

## Zero-shipped-byte

The fragment carries retail's canonical raw text, and every extracted function
was build-minify byte-identical across both shells before extraction. So the
expanded entry files re-minify to the committed `shell.min.js` /
`boot-shell.min.js` **byte-for-byte** — the on-device-validated cold-boot
artifacts are literally untouched (no re-promotion, no on-device re-validation
gate). `verify_shell_src.py` / `verify_boot_shell_src.py` prove this in CI.

## Current contents (JEL-644 proof-of-mechanism slice)

Seven zero-test-coupling functions: `isJellyfinWebBundle`,
`injectChromium56Polyfills`, `injectQaBeacon`, `neutralizeUntranspiled`,
`escAttr`, `markDocumentWrite`, `injectConnectStylesheet`.

## Editing / adding functions

- **Change a shared function:** edit `src/shell-core.src.js` ONLY. Run the
  build/verify guards — both `.min` blobs must stay byte-identical.
- **Add a function:** it must be build-minify byte-identical across both shells
  first (check `cross-shell-parity.test.cjs`). Extract retail's raw text into a
  `//@@BEGIN/END@@` block here, replace its body with a `//@@SHELL_CORE:name@@`
  marker in BOTH shells, then re-run `scripts/expand.test.cjs`, both verify
  guards, and the parity test.
- **Test-coupled functions** (a `.test.cjs` extracts the body from raw source by
  name) need the shared test loader migration first — the remaining ~49
  functions are gated on that (see JEL-644). Do not extract a function whose
  body a test reads until its tests load through the shared loader, or that test
  will fail with `function not found`.

## Guards

- `scripts/expand.test.cjs` — markers resolve, no orphan fragments, each
  fragment is its named function, `expand.py` ≡ `expand.cjs`.
- `verify_shell_src.py` / `verify_boot_shell_src.py` — expanded source ≡
  committed `.min` (byte-identical rebuild).
- `cross-shell-parity.test.cjs` — expands both shells, then mirror-checks.
