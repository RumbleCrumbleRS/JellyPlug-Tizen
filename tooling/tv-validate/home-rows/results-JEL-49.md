# JEL-49 — Compare: Home screen rows (Continue Watching, Next Up, Latest) — TV vs browser

**Verdict: parity confirmed — expected behavior, no shell defect.**

The Home screen rows are **100% jellyfin-web + server driven**. The Tizen shell
does not implement, wrap, or customize any home-row code path, so the rows that
render on the TV are identical to the desktop browser by construction. The
empirical harness (`verify-home-rows.mjs`) fetches all four rows under two
distinct client identities — a browser-like session and the real TV session
(`Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV"`) — and confirms
**byte-identical** item sets, counts, thumbnails, and progress indicators.
**14/14 checks pass.**

## Why the rows cannot diverge TV vs browser

| Row               | Server endpoint                                      | Device-dependent?                          |
| ----------------- | ---------------------------------------------------- | ------------------------------------------ |
| Continue Watching | `GET /Users/{uid}/Items/Resume`                      | No — user-scoped, no `DeviceProfile` param |
| Next Up           | `GET /Shows/NextUp?UserId={uid}`                     | No — user-scoped                           |
| Latest Movies     | `GET /Users/{uid}/Items/Latest?ParentId={moviesLib}` | No — user-scoped                           |
| Latest TV         | `GET /Users/{uid}/Items/Latest?ParentId={tvLib}`     | No — user-scoped                           |

None of these endpoints accept a device profile or vary on the client/device
identity — they return the same items, in the same order, with the same image
tags and the same per-user playback state, to **any** client of that user. A
`grep` of `shell.js`, `boot-shell.src.js`, and `shell-core` finds **zero**
references to Resume / NextUp / `Items/Latest` / `homeSection` / card image
building. The shell never touches what the home rows contain.

### The one Home thing the shell does — focus, not content

The shell's only Home-related code is the **JEL-1580 body-focus-rescue +
proactive auto-focuser** (`shell.js`, validated under
[JEL-33](/JEL/issues/JEL-33)). On Tizen, post-login Home leaves `activeElement`
on `<body>`, so `focusManager.nav()` searches geometrically beyond the body rect
and the first D-pad press is a no-op. The rescue focuses the first visible card,
bringing TV D-pad nav to **parity** with the browser (where focus is never stuck
on body). It changes only _whether the focus ring appears_, never _which
items/rows render_. Once focus lands, horizontal (within-row) and vertical
(between-row) D-pad navigation is jellyfin-web's own `focusManager` — the shell
is transparent to it (it only intercepts BACK `10009`), so navigation is
identical on both platforms.

Thumbnails: the home card requests an image **width sized to the layout** (TV
cards are larger than browser cards), but the _source_ image — item `Id` +
`ImageTag` — is identical, so the same artwork renders, just scaled. The harness
compares `ImageTags`, proving the thumbnail is the same asset on both.

## Empirical verification (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/home-rows/verify-home-rows.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never
prints credentials; seeds Next Up then restores the shared test account).

```
PASS  authenticate (browser + tv sessions)  — uid c36be5dd…
PASS  found movies + tvshows libraries  — Movies / Special TV Shows
PASS  seeded Next Up  — marked "99 to Beat" first episode played
PASS  [Continue Watching] item count matches  — browser=7 tv=7
PASS  [Continue Watching] items+thumbnails+progress identical  — 7 items identical
PASS  [Next Up] item count matches  — browser=1 tv=1
PASS  [Next Up] items+thumbnails+progress identical  — 1 items identical
PASS  [Latest Movies] item count matches  — browser=16 tv=16
PASS  [Latest Movies] items+thumbnails+progress identical  — 16 items identical
PASS  [Latest TV] item count matches  — browser=16 tv=16
PASS  [Latest TV] items+thumbnails+progress identical  — 16 items identical
PASS  all four rows exercised, ≥3 non-empty  — 4/4 rows populated
PASS  Continue Watching progress indicators present + positive  — 24% 51% 47% 42% 7% 9% 6%
PASS  test-account episode played-state restored  — un-marked

14/14 checks passed.
```

### What each check proves

- **Item count matches** — each row returns the same number of items to the TV
  session and the browser session.
- **Items + thumbnails + progress identical** — a normalized per-item
  fingerprint (`Id`, `Type`, season/episode, sorted `ImageTags`, parent/series
  thumb presence, `PlayedPercentage`, `PlaybackPositionTicks`, `Played`) is
  **deep-equal** across the two identities, in the same order. This is the core
  of JEL-49: identical items, identical thumbnails, identical progress bars.
- **Continue Watching progress present + positive** — every resume item carries
  a real `PlaybackPositionTicks > 0` and a percentage (24/51/47/42/7/9/6%), so
  the progress overlays the cards render are backed by genuine server state, not
  placeholders.
- **Next Up seeded + restored** — the test account had an empty Next Up row, so
  the harness marks one series' first episode played (surfacing the next
  episode), verifies parity on the now-populated row, then un-marks it so the
  shared account is unchanged.

## Scope notes

- **Not driven through a live D-pad on the physical TV.** Per the JEL-7
  blockers, the locked M63 TV cannot be driven by an automated input harness
  from the sandbox. D-pad navigation _mechanics_ on Home (first-press focus
  rescue + within/between-row movement) were validated automatically in
  [JEL-33](/JEL/issues/JEL-33); this ticket validates the row **content**
  parity, which is what "identical items / count / thumbnails / progress"
  requires. The two together cover the JEL-49 request.
- **Latest rows are per-library.** The home screen renders a Latest row for each
  unhidden library; the harness verifies the Movies and TV-Shows libraries (the
  two the ticket names). Parity holds for any library since the endpoint is
  user-scoped, not device-scoped.
- The harness picks the first `movies`/`tvshows` view from `/Users/{uid}/Views`;
  on this server that resolved to "Movies" and "Special TV Shows".

```
Re-run: node tooling/tv-validate/home-rows/verify-home-rows.mjs
```
