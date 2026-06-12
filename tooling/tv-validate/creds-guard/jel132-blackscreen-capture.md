# JEL-132 follow-up — black login page: custom-Babel mis-transpile of jellyfin-web core

2026-06-12 evening, M63, retail v2.0.12 base + QA probe builds
(`qa/jel132-blackscreen` v3 `133cd67` / v4 `9852bc2`, sign runs
27432540231 / 27433638115). User report: after v2.0.12 the login page is
"just a black image".

## What the black screen is

Login route (`#/login.html?serverid=…&url=%2Fhome`) with `#loginPage`
present full-screen: full-screen black `backdropContainer`/
`backgroundContainer`, a 97 px header strip, `.mainAnimatedPages` at
1910×0 and `.manualLoginForm` in-DOM but `display:none`. Zero errors on
screen; one unhandled rejection captured:

    TypeError: Cannot read property 'A' of undefined
      at Object.tF (<anonymous>:2:332410)
      at …/web/32721.c6b0ccd421f063bbf5e2.chunk.js:2:5629

Main-bundle module 67430 defines getters `{KN:()=>r.K, tF:()=>i.A}` with
`i = n(84138)`; module 84138's factory throws during evaluation (error
swallowed), leaving `i` undefined; the login chunk later dereferences
`f.tF` and the page mount dies. `<anonymous>` = the main bundle is eval'd
by the shell pipeline with `jellyfin.shell.legacy.babelNeeded = 1`, i.e.
core bundles run through the custom 2.45 MB babel.min.js.

## Eliminated by on-device experiment

- tx cache: cfg `clearTx` wiped all 62 `shell.tx*` keys → unchanged.
- stale caches: `bundlePatchState` fingerprints the server's CURRENT
  build (`?4c3e5ec610f9c71cad1c`, bodyLen 485280 ≈ live 485069 + JEL-111
  patches); vendors/webIndex/webConfig caches do not exist.
- JEL-134 creds vault: `vm:0, cr:0` — never engaged (user never logged in
  on v2.0.12); not implicated.
- server drift mid-investigation: runtime.bundle.js byte-identical
  16:25Z → 18:00Z; chunk 32721 hash matches the served runtime map.
- `clearAux` (drops babelNeeded + bundle caches) → flag re-arms within
  ~10 s of boot (detector trips on early scripts) and the breakage
  reproduces identically with all-fresh caches.

Control: the morning post-rollback boots (flag cleared by the JEL-132
storage rollback) rendered the login form raw and the user logged in —
raw core works on this webview; transpiled core breaks.

## Verdict and fix path

The custom Babel mis-emits something in current jellyfin-web core such
that module 84138 (large dep fan-out) throws at eval. Fully reproducible
offline: transpile the live main bundle with the repo babel.min.js using
the shell's options and require module 84138 raw-vs-transpiled. Fix owned
by JEL-137 (critical — the user cannot log in until it ships as v2.0.13).
`jel132-main-bundle-16-25Z.sha256` pins the bundle archived at 16:25Z for
content-drift comparison.

## End state

TV restored to retail v2.0.12 (release asset sha `63845a09…b837`),
beacon-silent after farewell (QA keys cleared; one webview wedge during
the loop recovered with a calm stop→install→launch). User remains at the
broken login page until JEL-137 ships.
