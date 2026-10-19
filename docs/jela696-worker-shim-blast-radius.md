# The cross-origin Worker crash broke every native card surface, not just the home

**JELA-696.** Blast-radius sweep for the JELA-695 fix (PR #155, shipped in the shell that is
live on `/shell/` today). JELA-695 was filed as *"the HSS home rows render zero cards"* and
proved the fix on the home only. This is the sweep of everything else.

Short version: **every native card surface in jellyfin-web was dead, and the failure emitted
no error telemetry whatsoever.** The home merely *looked* half-alive because the JellyPlug
injector rows are hand-rolled markup that never touches `cardBuilder`.

---

## 1. Mechanism recap

`new Worker("<server>/web/blurhash.worker.bundle.js")` is a `SecurityError` on the TV: the
widget owns the document, so every `/web/` asset URL is cross-origin. jellyfin-web builds
that worker at **`imageLoader` module scope**, ahead of the module's closing
`var g = {…, getPrimaryImageAspectRatio: v}`. The throw aborts the module body before `g` is
assigned, but webpack has already installed the export getters and cached the half-built
namespace — so `imageLoader.default` is `undefined` for every later importer, permanently.

`cardBuilder`'s `setCardData` opens with `h.default.getPrimaryImageAspectRatio(items)`, and
`buildCardsHtmlInternal` calls `setCardData` unconditionally. So **every**
`cardBuilder.getCardsHtml()` call throws for the lifetime of the document.

## 2. Static reach: who depends on `cardBuilder`

Read off the deployed bundles (`webpack` chunk graph, `s.e(<id>)` ensure calls). `cardBuilder`
is chunk `24468` — it is the only chunk that *defines* `getCardsHtml:`.

21 named view chunks ensure it directly:

```
favorites            list                 itemDetails          search
movies-movies        movies-moviecollections                   movies-moviesrecommended
shows-tvshows        shows-tvrecommended  shows-tvupcoming     shows-episodes
music-musicalbums    music-musicartists   music-musicrecommended  music-songs
livetv-livetvchannels  livetv-livetvrecordings  livetv-livetvschedule
livetv-livetvsuggested                    playback-queue       session-selectServer
```

plus `main.jellyfin.bundle.js` itself and the shared home/section chunk `56213`. A further
30 chunks contain a `.getCardsHtml(` call site, and **56** contain an `imageLoader`
`lazyChildren` call — every one of those is a second, independent way to hit the same
`undefined`.

That is: the library grids, the suggestion/recommended pages, item detail, search,
favourites, collections, playlists, the playback queue, and all of Live TV and Music. There
is no native card surface outside that set.

## 3. Runtime proof — the A/B

Rig: the local M63 (Chromium 63) harness, real WGT bootstrap, real server.

**One shell build in both arms** — the exact `shell.min.js` serving from `/shell/` today
(`a46b98af…`). The only variable is `localStorage["jellyfin.shell.workerShimDisabled"]`:

- `ctl` — kill switch set. The shell returns before installing the wrapper, so `window.Worker`
  is native. This *is* the pre-#155 world, byte for byte, with no unrelated shell drift.
- `fix` — shipped default, wrapper installed.

The probe boots once and then drives the SPA through the stops **from inside the page** (no
CDP traffic during the boot window — that starves the M63 main thread), writing to
`localStorage` on a 500 ms tick.

Two counting rules that matter:

- Cards are counted **scoped to the visible page**. The SPA keeps every page it has visited in
  the DOM behind `.hide`; a document-wide `.card` count is dominated by pages you already left
  and reads ~185 everywhere.
- The load-proof metric is `icHtml` — total `innerHTML` bytes across the `.itemsContainer`s on
  the visible page. Under load a slow arm can look card-poor; it cannot look *empty*. Pre-fix
  containers hold 0–5 bytes.

### Result

Two valid pairs (`ctl2`/`fix2` at load 9–10, `ctl4`/`fix3` at load 2). The numbers below are
the quiet-box pair; the loaded pair agrees on every row. A third control run was **discarded**:
the box hit load 67 mid-run and the shell never booted at all (`__shellWorkerShim` was `null`,
no `.page` element ever existed). That is the discard criterion — a run where the shim diag is
absent measured nothing.

| stop | ctl cards | ctl `icHtml` | fix cards | fix `icHtml` | ctl throws |
|---|---|---|---|---|---|
| home | 185 | 288,704 | **268** | 446,228 | 5 (during boot) |
| Movies grid | **0** | 4 | 58 | 95,122 | 2 |
| Movies › Suggestions | **0** | 5 | 56 | 95,046 | 0 |
| TV Shows grid | **0** | 2 | 9 | 15,773 | 0 |
| Collections (`#/list`) | **0** | 1 | 48 | 53,487 | 4 |
| Search | **0** — page replaced by `errorBoundary` | 0 | 138 | 177,064 | 0 |
| Favourites tab | 25 | 43,865 | 26 | 45,563 | **32** |
| Movie detail | 17 | 16,212 | 57 | 60,987 | 0 |
| Series detail | 15 | 13,643 | 62 | 83,033 | 0 |

Every recorded throw is the same one, 50 of them in one control run:
`TypeError: Cannot read property 'getPrimaryImageAspectRatio' of undefined`.

**Q1 — which surfaces were actually broken pre-fix? All of them.** No native card surface
reachable on this server rendered anything. The containers are not under-filled, they are
*empty*: 0–5 bytes of `innerHTML` across every `.itemsContainer` on the page.

**Search fails worse than the rest.** It is the one React surface in the set, and React's error
boundary catches the throw and replaces the entire page — `page = errorBoundary`, no
`.itemsContainer` at all. Everywhere else the user gets a silent empty shelf; on search they
get an error screen.

**What survived, and why.** Only the JellyPlug injector rows. They are hand-rolled markup:
across the whole 675 KB injector payload there are **zero** `getCardsHtml` call sites, so
`imageLoader` is never on their path. That is the entire reason the home looked half-alive —
its 185 pre-fix cards were all ours.

Two surfaces need that read to interpret them at all:

- **Detail pages.** Pre-fix, the only populated row is *More Like This* (16 cards) — and that
  row is the injector's own `jp-detail-similar` rail (`E = 16`, cards classed `jp-similar-card`),
  which explicitly hides the native `#similarCollapsible`. The native similar-items call is
  hard-capped at `limit: 12`, so a 16-card row cannot be it. Every genuinely native row was
  dead: **Cast & Crew 0 → 24, Seasons 0 → 26, Next Up 0 → 1**, plus Guest Stars and Additional
  Parts.
- **Favourites tab.** Card counts barely move (25 → 26) because this account has almost no
  favourites — but the control run threw **32 times** on that one stop. Card delta cannot show
  breakage on an empty shelf; the throw count can.

**The failure is invisible to error telemetry.** Across every run, in both arms,
`window.onerror` fired **0 times** and `unhandledrejection` fired **0 times**. The only reason
these throws are countable is the explicit `emby-itemscontainer.getItemsHtml` wrap the probe
installs. Nothing in the field would ever have reported this — which is why it survived as
"the HSS rows look empty" for as long as it did.

**Q2 — does anything regress with the shim on? No.** `window.__shellWorkerShim` came back
`{st:"on", n:1, fb:1, up:1, err:""}` in every fix run: one Worker constructed, one native
failure, one successful same-origin blob upgrade, no error — blurhash is real, not stubbed. No
stop rendered fewer cards with the shim on, and the fix arm threw 0 times against the control's
16 and 50.

## 4. Cost

Nothing here is optional: without the shim, the app has no native card surfaces at all. The
fix does add real render work — the home goes from 185 cards to 268–284 (the native rows vary
run to run), and every grid goes from empty to full — so it is not free.

**No firstCard claim is made in either direction, and none should be read into these runs.**
This sweep was built to answer *rendered / did not render*, which is why a zero-vs-58 result
survives a loaded box. Timing does not: nothing here was pre-flighted through
`tooling/perf/preflight.sh`, arms ran in blocks, and n is 2. The real-app detection floor is
±698 ms at n=8 (`docs/perf-measurement-protocol.md`). Fold the extra render work into the next
properly gated measurement instead of chasing it with an underpowered A/B here.

## 5. Re-running this

The sweep is checked in at `tooling/qa/card-surface-sweep/` (probe + driver + README). It is
the only harness we have that answers *"did this shell change break a card grid?"* — the
boot-timing rig cannot, because a page that throws before it renders still finishes booting.

## 6. Field notes

- Diag: `window.__shellWorkerShim`. Healthy is `{st:"on", n:1, fb:1, up:1, err:""}` —
  one Worker constructed, one native failure, one successful same-origin blob upgrade.
  `up:0` with a non-empty `err` means the blob upgrade failed and blurhash is stubbed
  (cards still render; only the placeholder blur is gone).
- Kill switch: `localStorage["jellyfin.shell.workerShimDisabled"]="1"`. **Setting it turns
  every card grid in the app back off** — it is a last resort, not a tuning knob.
- Do not chase any of this in a desktop browser. There the document and the assets share an
  origin, the Worker constructs fine, and none of it reproduces.
