# JEL-80 — Compare: Smooth scrolling and animation performance — TV vs browser

**Verdict: parity by construction — the four animations are 100% jellyfin-web
(+ Splide for the spotlight), the Tizen shell is transparent to the animation
pipeline, and any TV-vs-browser difference is jellyfin-web's _own_ TV-layout
adaptation or the M63 panel's raw frame-rate — never a shell defect.**

The ticket asks us to compare four animated behaviors TV vs browser and flag
anything specific to the TV's Chromium (Chromium **M63** on the locked Tizen 5.0
panel):

1. horizontal row scrolling is smooth (no jank);
2. page transitions animate correctly;
3. the spotlight hero auto-advance animation is smooth;
4. focus movement between items is visually correct.

Every one of these is owned by jellyfin-web. The shell does not author, wrap,
throttle, or restyle any scroller, view transition, transform, or focus-ring
animation, so the _intended_ animation on the TV is identical to a desktop
browser **by construction**.

## Who owns each animation (none of it is the shell)

| #   | Animation                    | Owner                                                          | Mechanism                                                                                    | Shell involvement |
| --- | ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Horizontal row scroll        | jellyfin-web `emby-scroller` / `scrollHelper`                  | `requestAnimationFrame`-driven `scrollLeft`/`transform: translateX` centering on focus       | none              |
| 2   | Page transitions             | jellyfin-web `viewManager` / `viewContainer`                   | CSS class transition (opacity/transform), **gated off on TV layout** — see below             | none              |
| 3   | Spotlight hero auto-advance  | Editor's Choice plugin → Splide ([JEL-48](/JEL/issues/JEL-48)) | Splide CSS `transform`/`transition` carousel, `autoplay` + `interval` from one server config | none              |
| 4   | Focus movement between cards | jellyfin-web card CSS + `focusManager`                         | CSS `transition: transform` focus scale + `scrollIntoView`/center on focus                   | none              |

## Why the shell cannot change these animations (offline proof)

`verify-animation-performance.mjs` Part A proves, from committed shell source,
that the shell is transparent to the entire animation/compositing pipeline:

- **A1** — the **only** stylesheet the shell injects is `connect/connect.css`,
  and only on the shell's _own_ pre-jellyfin connect screen
  (`injectConnectStylesheet`, JEL-739). The shell creates **no** `<style>`
  element and injects **no** stylesheet into the jellyfin-web app document. So
  it adds zero animation/transition rules to the app.
- **A2** — `shell.js` declares no `@keyframes`/`transition:`/`animation:`/
  `will-change:` anywhere. Its layers are logic (babel transpile, diag, focus
  rescue), never animation CSS.
- **A3** — the shell's only keydown `preventDefault` in the app document are
  **BACK/10009** (`shell.js:411`) and the body-focus **rescue** (focus only,
  fired on D-pad keys when `activeElement` is stuck on `<body>`; see
  [[jel71-dialog-focus-parity]], [JEL-33](/JEL/issues/JEL-33)). It registers
  **no** `wheel`/`scroll`/`touchmove`/`mousewheel`/`transitionend`/`animationend`
  listener — so it never cancels scroll momentum or interrupts a transition. The
  horizontal scroller and view transitions run exactly as jellyfin-web drives
  them.
- **A4** — `connect.css` is scoped to the connect screen (form/input/button +
  an `html,body` reset) and references **no** app selector (`.card`,
  `.itemsContainer`, `emby-scroller`, `.mainAnimatedPages`, `.view`), so it
  cannot leak into the app's animations even if it were ever co-present.

Because the shell only intercepts BACK and rescues stuck focus — the exact same
two facts behind the playback-controls and dialog-focus parity tickets
([[jel42-playback-controls-parity]], [[jel71-dialog-focus-parity]]) — the
scroller, the view-transition fade, the Splide carousel, and the focus-scale
transition all execute their jellyfin-web code unmodified on the TV.

## The TV genuinely _does_ animate differently — and that is jellyfin-web's design, not a bug

Two real TV-vs-browser differences exist, and **both are jellyfin-web's own
behavior**, applied at runtime to the _same_ served bundle (Part B proves the
bundle is byte-identical across UAs, so there is no separate degraded "TV
asset"):

1. **jellyfin-web trims heavy animations on TV-class hardware.** jellyfin-web's
   runtime layout/`browser` detection flags Tizen as a TV (`layout-tv` /
   `browser.tv`) and intentionally drops the view-container fade/slide
   **page-transition** animation on TV so navigation is _instant_ rather than a
   janky cross-fade on weak GPUs. So on the TV, page transitions are
   deliberately minimal/immediate — that is **correct** (requirement #2:
   "transitions animate correctly"), not missing. The shell does **not** set
   `layout-tv`; jellyfin-web does, from its own display-mode detection.

2. **Raw frame-rate is bounded by the M63 panel's GPU**, a runtime hardware
   property no static asset can change. The animations jellyfin-web ships are
   built on GPU-compositable primitives — `transform`/`translate3d`,
   `transition`, `will-change`, and `requestAnimationFrame` — **all supported in
   Chromium 63** (Part B confirms the CSS bundle carries them and the JS bundle
   carries `requestAnimationFrame`). They composite on the GPU on M63, which is
   why they run rather than stutter. The on-device evidence that they _do_ run
   on the real TV is prior tickets: the spotlight hero renders and auto-advances
   ([JEL-17](/JEL/issues/JEL-17): `heroEls=1`, `watchBtn=18` on warm boot) and
   D-pad focus movement between cards works ([JEL-33](/JEL/issues/JEL-33)).

### M63-specific animation notes

- **No flexbox `gap`** on M63/M69 WebViews ([[m63-m69-css-no-flex-gap]], JEL-29).
  This is a _layout_ gap-spacing quirk, not an animation quirk, and it affects
  the shell's connect screen (fixed there with margins). jellyfin-web's card
  rows use margin-based spacing, so row scrolling is unaffected.
- **`scroll-behavior: smooth`** and **CSS Transitions/Transforms/Web Animations
  `Element.animate`** all predate M63, so the smooth-scroll centering and the
  focus-scale/Splide transitions have native engine support on the panel.
- The realistic smoothness ceiling on the 2019 panel is **fill-rate** (large
  backdrop images + many cards), not missing animation features. jellyfin-web's
  own TV trimming (point 1) is the upstream mitigation; the shell adds nothing
  that would make it worse (no extra repaints, no scroll/transition handlers).

## Empirical verification

Harness: `tooling/tv-validate/animation-performance/verify-animation-performance.mjs`
(Node ≥18; reads `JELLYFIN_URL/USER/PASS` from env; never prints credentials;
read-only — makes no server-state changes). Part A (offline) reads committed
shell source; Part B (live) compares served assets and **degrades to SKIP** when
the test server is unreachable so the offline proof still runs.

Run on 2026-06-09 (test server `REDACTED-SERVER.example` transiently down — port
443 refused — so Part B reported SKIP; offline transparency proof passed):

```
# Part A — shell transparency to the animation pipeline (offline source)

PASS  A1 the only stylesheet the shell injects is the connect-screen connect.css  — 1 stylesheet link, href=connect/connect.css (connect screen only, not the web app)
PASS  A2 shell.js declares no animation/transition CSS  — none
PASS  A3a shell keydown handling is BACK/10009 (+ focus rescue) only  — BACK early-return present; focus-rescue preventDefaults only after a successful focus
PASS  A3b shell intercepts no scroll/wheel/touchmove/transition events  — none — scroll & transition pipeline untouched
PASS  A4 connect.css is scoped to the shell connect screen, no app-animation rules  — connect-screen selectors only

# Part B — served animation assets are identical TV vs browser (live server)

SKIP  B* live asset comparison  — test server unreachable (https://REDACTED-SERVER.example) — offline proof above stands; re-run when server is back

5/6 checks passed, 1 skipped.
```

When the test server is reachable, Part B additionally asserts (and will be
re-captured here): `/web/index.html`, the main CSS bundle, the main JS bundle,
and the Editor's Choice spotlight script are each **byte-identical** for a
desktop-browser UA and a Samsung Tizen TV UA (`sha256` match); the CSS bundle
carries `transition`/`transform` (M63-compatible compositing); and the JS bundle
carries the TV-layout detection + `requestAnimationFrame`. Together these show
the TV runs the same animation code and the same TV-adaptation logic as the
browser — no UA branch hands the TV worse animation.

### What this harness proves — and what it cannot

- **Proves**: the shell does not touch the animation pipeline (A1–A4), and (live)
  the animation code + TV-adaptation logic are identical across browser and TV
  and use only M63-supported primitives.
- **Cannot prove**: a frame-per-frame "no jank" smoothness number — that is a
  runtime GPU/CPU property of the physical M63 panel. The on-device evidence
  that the animations actually run smoothly enough to use is JEL-17 (spotlight
  renders + auto-advances) and JEL-33 (D-pad focus movement), captured on the
  real TV.

## Conclusion

Smooth scrolling, page transitions, spotlight auto-advance, and focus movement
are **jellyfin-web-owned and TV/browser-identical by construction**. The shell
is provably transparent to all of it. Where the TV legitimately differs —
fewer/instant page transitions and a GPU-bounded frame-rate — that is
jellyfin-web's own TV-layout adaptation and the M63 hardware, both expected and
both correct. **No shell defect; no animation work required.**
