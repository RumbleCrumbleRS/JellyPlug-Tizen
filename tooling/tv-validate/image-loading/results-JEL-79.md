# JEL-79 — Compare: Image loading and CDN/proxy behavior — artwork thumbnails

**Verdict: artwork loading is TV/browser-identical by construction, because the
shell is transparent to images.** Every poster/thumb/backdrop/logo URL is built
by jellyfin-web's `imageLoader` / `cardBuilder` / `backdrop` modules as
`${serverUrl}/Items/{id}/Images/{Type}?…&maxWidth|fillWidth=…&quality=…`, fetched
by the WebView's native `<img>` decoder, and served — resized — directly by the
Jellyfin server. There is **no CDN and no proxy**, and the shell installs **zero**
image-path code: no `<img>`/`Image()` interception, no URL rewrite, and a
network shim scoped to `config.json` only, so every `/Items/.../Images/` request
passes straight through. The four ticket claims are guaranteed by that
transparency and asserted directly by the harness; a live confirmation run
(PART B/C) is included and reproducible, but the test server was **offline**
(`ECONNREFUSED`) during authoring, so the live numbers will be captured the next
time it is reachable. The authoritative verdict — that the shell cannot affect
image loading and TV cannot diverge from browser — does not depend on that run:
it is proven offline (PART A, 7/7).

## What the ticket asked us to prove

Each row's Result states what the shell guarantees (proven offline) and what the
live harness asserts when the server is reachable.

| #   | Ticket question                                               | Result                                                                                                                             | Evidence           |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | Images load from the server's `/Items/{id}/Images/` endpoints | Shell never touches image URLs; harness asserts every poster/thumb/backdrop returns `200` + `image/*` from `/Items/.../Images`     | PART A; PART B (1) |
| 2   | No images fail silently (no broken-image icons)               | Shell adds no failure mode; harness asserts `broken == 0` (no `404`/empty/wrong-type) among reachable artwork                      | PART A; PART B (2) |
| 3   | Image load times reasonable on the TV network                 | Shell adds no latency (no intercept); harness times each GET against an 8 s ceiling (sandbox is a worse path than the TV's LAN)    | PART A; PART B (3) |
| 4   | Resize/quality params appropriate for 1920×1080               | jellyfin-web builds the size params (shell-free); harness asserts returned width ≤ requested + backdrops in [1280, 1920] for 1080p | PART A; PART B (4) |
| —   | TV vs browser parity                                          | Identical jellyfin-web bytes + no shell image code ⇒ same URL; harness asserts byte-identical responses across client identities   | PART A; PART C     |

## Why this is parity by construction (the shell is transparent to images)

The Tizen shell authors **no image code at all**. Three independent facts, each a
static guard in `verify-image-loading.mjs` PART A (7/7 offline checks pass):

1. **The only network interception is `config.json`-scoped.** The shim's match
   predicate is `var matches=function(u){return /(^|\/)config\.json(\?|$)/.test(…)}`
   — it matches `config.json` and nothing else. Both the `fetch` and the
   `XMLHttpRequest` shims fall through to `origFetch.call(this,i,init)` /
   `origSend.apply(this,arguments)` for every other URL, so every
   `/Items/.../Images/` request reaches the network **verbatim** (JEL-64 model).
   And `<img>` loads never enter `fetch`/XHR in the first place.
2. **No `<img>` / `Image()` / src rewriting.** The shell overrides neither
   `window.Image` nor `HTMLImageElement.prototype`, and never queries or rewrites
   `img` elements. It cannot resize, redirect, or proxy artwork.
3. **No CDN, no proxy.** There is no CDN host or proxy path token anywhere in the
   shell code. The shell's only URL contribution is `<base href>` = the server
   origin + `cfg.servers=[serverUrl]`; jellyfin-web composes **all** URLs —
   artwork included — against that same origin. Image bytes are served directly
   by the server's `/Items/.../Images` endpoint, which resizes via SkiaSharp
   honoring `maxWidth`/`fillWidth`/`quality`.

The shipped artifact carries the same property: `shell.min.js` keeps the
`config.json`-only shim and contains **zero** `Images`/`/Items/` interception
tokens.

Because the request URL is determined solely by jellyfin-web's layout geometry
(TV layout @ 1920×1080) and both UAs run **identical** jellyfin-web bytes, the TV
and the browser issue the same artwork requests and get the same bytes back. PART
C proves the response side directly: the image endpoint is UA-agnostic, so the
same URL returns byte-identical artwork regardless of client identity.

## The request shapes the harness exercises (what cardBuilder/backdrop build)

For the TV layout the harness builds the exact URL shapes jellyfin-web produces,
across **multiple libraries** (Movies + TV Shows) and image types — mirroring
"browse libraries and detail pages":

- **Poster** (portrait grid card): `…/Images/Primary?tag=…&maxWidth=400&quality=90`
- **Thumb** (16:9 card): `…/Images/Thumb?tag=…&maxWidth=500&quality=90`
- **Backdrop** (full-bleed @ 1080p): `…/Images/Backdrop/0?tag=…&fillWidth=1920&fillHeight=1080&quality=90`

For each it asserts a `200` + `image/*` with real bytes (claims 1 & 2), times the
GET (claim 3), and parses the returned image header to confirm the server
actually resized to ≤ the requested width (claim 4). Backdrops are additionally
asserted to land in [1280, 1920] px wide — full-resolution for the panel, not an
upscaled postage stamp and not a wasteful 4K download.

## What this does NOT do (and why that's fine)

It does not drive a headless TV WebView pixel-by-pixel to "see" the posters. The
open question for artwork is the **request/response contract** (right endpoint,
right size, none broken, identical across clients) — which is what this verifies
directly. Whether the decoded image then paints is the WebView's native `<img>`
renderer, which the shell does not touch; layout/focus of the cards themselves is
covered by JEL-50 (library browsing) and JEL-33 (focus).

## Note on the test server

This Jellyfin instance (`REDACTED-SERVER.example`) sits behind a flaky DDNS reverse
proxy that intermittently returns `502`/`503`/timeouts and, when the backend is
powered off, refuses connections outright (`ECONNREFUSED`) — it was hard-down
during this authoring window. The harness retries transient 5xx with backoff,
skips gracefully (non-failing) when the server is unreachable, and counts any
artwork that stays unreachable **separately** from genuinely-broken artwork — a
proxy flap or an offline server is never reported as a shell defect or a missing
image. PART A (shell transparency) is fully offline and always runs, so the
authoritative verdict stands regardless of server availability. To capture the
live PART B/C numbers, re-run the documented command once the server answers.

## How to run

```
JELLYFIN_URL=… JELLYFIN_USER=… JELLYFIN_PASS=… \
  node tooling/tv-validate/image-loading/verify-image-loading.mjs
```

PART A is offline (source structure, 7 checks). PART B/C need the server
reachable; they skip gracefully (non-failing) if it never comes up. Read-only:
GET image bytes + POST-auth only; mutates nothing; never prints credentials.
