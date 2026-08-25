# Upstream report — `IAmParadox27/jellyfin-plugin-media-bar`

**Status: DRAFT (JELA-715) — not yet filed.** File via
`gh api repos/IAmParadox27/jellyfin-plugin-media-bar/issues` (the API path works even
where the UI enforces templates) after CEO approval, same route as JELA-701
(`docs/imageloader-worker-upstream-report.md`). Flip this header to FILED with the link.

Verified against upstream `main` (`b267265`) and the commit our deployment pins
(`ae878fd`) — identical in every cited function; line numbers below are `main`'s. Boot
evidence is the JELA-706 CDP capture (rig boot, quoted in the JELA-715 thread); the
absolute server-time number was taken while the server was loaded (JELA-712 gate B open),
so it is illustrative — the request ordering is structural and load-independent. Do not
add server hostnames to this file (CI guard).

---

## Title

The backdrop slideshow runs a full-library `Recursive=true&sortBy=Random` scan before the
home screen renders — and loads its assets from jsdelivr on the boot path

## Body

Hi — we ship a wrapper client for older Samsung TVs (Tizen 5.0 / Chromium 63) around
jellyfin-web, with Media Bar installed server-side, and we profile cold boots on real
device-class hardware. The slideshow currently adds three structural costs to
time-to-first-home-row. All three are scheduling/delivery issues, not algorithmic ones,
so they should be cheap to fix — happy to PR any of them if you're open to it.

Line references are at current `main` (`b267265`).

### 1. The item scan races the home screen for the server

`slideshowpure.js` line 920 issues:

```
GET /Items?IncludeItemTypes=Movie,Series&Recursive=true&hasOverview=true
    &imageTypes=Logo,Backdrop&sortBy=Random&isPlayed=False&enableUserData=true
    &Limit=<maxItems>&fields=Id,ImageTags,RemoteTrailers
```

`Recursive=true` + `sortBy=Random` cannot be answered from an index: the server has to
enumerate the entire Movie+Series candidate set and shuffle it before `Limit` applies,
and the response cannot be cached because randomising is the point. So the full cost is
paid on every boot, by every client, and it grows with library size.

When it runs is the real problem. `startLoginStatusWatcher` (line 377) polls every 2 s
and starts initialization the moment `ApiClient` is authenticated
(`waitForApiClientAndInitialize`, line 405) — with no coordination with the home
screen's own render. On our test TV the scan's GET starts ~2.6 s into boot while the
first home card appears at ~6.4 s: the scan competes for server CPU and for the TV's
connection pool exactly in the window where the home-sections queries are being served.
In that capture the server reported ~2.1 s `x-response-time-ms` for the scan (measured
on a loaded box, so treat the absolute number as illustrative — the overlap is
structural).

**Ask:** defer the item fetch until the home screen has painted (first visible card /
populated `.homeSectionsContainer`, or an idle callback after it). A decorative backdrop
carousel has nothing it needs to win a race for; appearing a beat after the rows is fine.

One interplay to watch: `initLoadingScreen`'s check interval (lines ~289–317) keeps the
full-screen `.bar-loading` overlay up until **both** `.homeSectionsContainer` **and**
`#slides-container` exist. A naive deferral would therefore hold the loader up longer.
Either keep creating `#slides-container` eagerly (it's cheap — only the data fetch needs
deferring) or decouple the loader from the slideshow container.

### 2. Bound the scan

Even off the critical path, an unbounded recursive shuffle is an expensive way to pick
~10 backdrops, and it scales with the library. Options that preserve the random feel:

- scope the query (`ParentId` per view) instead of `Recursive=true` across everything;
- fetch a capped candidate id list (cheap fields, larger `Limit`, indexed sort), cache
  it for a few minutes, and shuffle client-side — randomness per boot is preserved
  while the server-side enumerate+shuffle is amortized.

### 3. Serve the assets first-party instead of `cdn.jsdelivr.net`

`Inject/index.html` (lines 1–2) loads `slideshowpure.css` and `slideshowpure.js` from
`cdn.jsdelivr.net`, pinned by `{{Config.VersionString}}`. That is a DNS lookup + TLS
handshake to a third-party origin on the boot path of a TV — a device class where DNS
is often slow, some networks can't reach jsdelivr at all, and every extra origin hurts.
It is also a version-skew hazard: the DLL and the `@main`-pinned JS can drift apart.

The plugin already has the mechanism to fix this: `MediaBarController.GetFile`
(`Controllers/MediaBarController.cs` line 18) serves embedded resources at
`/MediaBar/{file}` with correct content types. Embedding `slideshowpure.js`/`.css` as
resources and pointing the injected tags at `/MediaBar/slideshowpure.js` etc. removes
the third-party origin and locks the assets to the installed plugin version.

Related, and worth knowing when you touch this: `slideshowpure.js` uses optional
chaining in 13 places (first at line 588) — ES2020 syntax. Chromium 63 (Tizen 5.0,
i.e. 2018–2019 Samsung sets that still run Jellyfin clients) fails to **parse** the
file, so those TVs pay the CDN fetch for a script that dies at parse and never runs; we
currently carry an es2017-transpiled copy out-of-band to get the hero working at all.
If the assets move first-party, building them to an es2017 target would make the stock
plugin work on that hardware.

### Summary of asks, in order of value

1. Defer the `/Items` fetch until after the home screen has painted (scheduling change
   only; also decouple the loading overlay from `#slides-container`).
2. Bound the scan: view scoping or a cached candidate list + client-side shuffle.
3. Serve `slideshowpure.js`/`.css` from `/MediaBar/…` via the existing `GetFile` route,
   ideally built to es2017.

Happy to open PRs for any subset — say the word.
