# JEL-48 — Compare: Home screen spotlight hero renders and auto-advances (TV vs browser)

**Verdict: parity confirmed — expected behavior, no shell defect.**

The home-screen "spotlight/hero banner" is **not** a jellyfin-web core feature — it
is the server-side **Editor's Choice** plugin (`/EditorsChoice/script`), which
injects a `<script>` into `/web/index.html` that builds a [Splide](https://splidejs.com/)
carousel inside `.homeSectionsContainer`. Every behavior the ticket lists —
backdrop image, auto-advance interval, left/right arrow navigation, and
OK/Enter → details — is owned by that plugin + Splide + jellyfin-web. The Tizen
shell is provably transparent to all of it (its only keydown `preventDefault` is
BACK/10009 — see [JEL-42](/JEL/issues/JEL-42) parity facts). So TV behavior is
identical to a desktop browser **by construction**.

That the hero actually renders and is D-pad-reachable on the real locked M63 TV
was the subject of [JEL-17](/JEL/issues/JEL-17) (resolved: warm-boot DOM shows
`hsc=1, splide=function, heroEls=1, spotlightEls=68, watchBtn=18`, after a
5-part babel/cache shell fix). JEL-48 is the *behavioral parity comparison* of
the four spotlight interactions, verified against the live server contract.

## What the shell touches (and what it doesn't)

| Spotlight concern | Owner | Shell involvement |
| --- | --- | --- |
| Hero/spotlight markup + Splide mount | Editor's Choice plugin | none |
| Backdrop image | server image endpoint | none |
| Auto-advance (`autoplay`, `interval`) | server config → Splide | none |
| Left/right arrow navigation | Splide (`keyboard:true`) + `splide__arrow` buttons | none — shell only `preventDefault`s BACK/10009 |
| OK/Enter → details page | slide `<a href="#/details?id=">` + `Emby.Page.showItem` | none |
| TV layout adjustments | plugin, gated on jellyfin-web's `layout-tv` class | none — shell does not set `layout-tv` |

The plugin's **only** TV-specific code is (a) a cosmetic `.layout-tv` CSS rule
for overview text, (b) the `hideOnTvLayout` config gate (`false` on this server,
so the spotlight *shows* on TV), and (c) a focus *enhancement* that nudges D-pad
focus off the scroll buttons onto the tab bar. `layout-tv` is a class
**jellyfin-web** sets from its own display-mode detection, not the shell. There
is no User-Agent / Tizen / WebOS branch anywhere in the plugin (the lone
`navigator` use is `navigator.language` for localization).

## Empirical verification (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/spotlight-hero/verify-spotlight-hero.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never
prints credentials; read-only — makes no server-state changes).

```
PASS  authenticate
PASS  Editor's Choice spotlight plugin script served  — 19059 bytes
PASS  plugin script byte-identical for browser UA and Tizen TV UA  — browser=d7f6f67df1983202 tv=d7f6f67df1983202
PASS  plugin builds a Splide carousel with keyboard arrow nav  — new Splide({ keyboard:true, ... })
PASS  plugin wires autoplay + interval from server config
PASS  plugin slides navigate to details via showItem + #/details?id=
PASS  spotlight config fetched  — autoplay=true interval=10000ms useHero=true
PASS  auto-advance enabled with a concrete shared interval  — 10000ms (same value delivered to every client)
PASS  spotlight shown on TV layout (hideOnTvLayout=false)
PASS  backdrop URL is device-independent (reduceImageSizes=false)  — no size param
PASS  spotlight has favourite items  — 5 items
PASS  (1) every spotlight backdrop image resolves  — Chronicle:200✓  Indiana Jones and :200✓  Harry Potter and t:200✓  Fallout:200✓  Oblivion:200✓
PASS  (4) every spotlight details target resolves to its item  — Chronicle->Movie  Indiana Jones and ->Movie  Harry Potter and t->Movie  Fallout->Series  Oblivion->Movie

13/13 checks passed.
```

The load-bearing parity fact is the **byte-identical script** check: the exact
same plugin bytes are served regardless of client User-Agent (a desktop Chrome
UA and a real Samsung `Tizen 5.0` TV UA hash identically), so the Splide
autoplay/interval, keyboard arrow handling, and anchor-click navigation are
literally the same code on TV and browser.

### (1) Correct backdrop image
Each slide's `background-image` is `../Items/{id}/Images/Backdrop/0{size}`. With
`reduceImageSizes:false` (this server) the size param is empty, so the backdrop
request is **device-independent** — TV and browser fetch the identical URL.
Every one of the 5 spotlight items returns a real `image/*` backdrop (HTTP 200).
*(If `reduceImageSizes` were ever flipped to `true`, the plugin would append
`?width=window.screen.width`, which differs TV vs browser; the harness asserts
it is `false` and would flag a flip.)*

### (2) Auto-advance fires at the same interval
`new Splide(..., { autoplay: !!data.autoplay, interval: data.autoplayInterval })`.
Both values come from **one** server config blob (`/EditorsChoice/favourites`),
delivered identically to every client: `autoplay:true`, `interval:10000` (10 s).
Splide's autoplay timer is upstream library code running on the same bytes, so
the cadence is identical on TV and browser.

### (3) Manual left/right navigation via arrow keys
`new Splide(..., { keyboard: true })` enables Splide's own arrow-key handler, and
the carousel renders `splide__arrow--prev`/`--next` buttons. On the browser,
Left/Right reach Splide directly; on TV the D-pad Left/Right are the same key
events (the shell passes them straight through — see [JEL-33](/JEL/issues/JEL-33)
browser D-pad verification and [JEL-42](/JEL/issues/JEL-42) shell transparency).
`type:"loop"` + `rewind:true` means navigation wraps identically on both.

### (4) OK/Enter/Select → correct details page
Every slide is `<a href="{base}#/details?id={item.id}" onclick="Emby.Page.showItem('{item.id}'); return false;">`.
Activating the focused anchor (Enter on browser, Select/OK on the TV remote)
calls jellyfin-web's `Emby.Page.showItem(id)` → details page. All 5 spotlight
target ids resolve to their real items on the server (Movie/Series). *(The
favourites feed returns dashed GUIDs used verbatim in the href; `/Items` returns
the un-dashed form — same id, jellyfin-web's appRouter accepts either.)*

## Scope notes
- Not driven through a headless browser watching the Splide timer tick:
  autoplay/keyboard are upstream Splide behavior; UI-driving it would test Splide,
  not TV/browser parity. The harness verifies the server contract + the
  identical-bytes fact that makes the two clients behave the same.
- On-device render + D-pad reachability of the hero on the locked M63 TV is
  [JEL-17](/JEL/issues/JEL-17) (resolved). Browser D-pad focus traversal is
  [JEL-33](/JEL/issues/JEL-33).
- The spotlight depends on the server config staying `hideOnTvLayout:false`;
  flipping it would intentionally hide the hero on TV only (a config choice, not
  a shell bug). The harness asserts the current value.

```
Re-run: node tooling/tv-validate/spotlight-hero/verify-spotlight-hero.mjs
```
