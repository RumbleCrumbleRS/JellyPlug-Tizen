# JELA-829 — where the residual home-row boot requests actually come from

Follow-up to JELA-820, which closed with "the last ~50 home-row boot requests have
no JSI seam". This document is the census that tests that sentence. Both halves of
it turn out to be wrong: there are not ~50 of them on the fleet, and they are not
outside the JSI channel.

Shell `a171f117` throughout (JELA-827 landed mid-ticket — see
"Re-derive a baseline when the shell sha changes" in the JELA-820 notes; every
number below is from captures taken on that one sha).

---

## 1. Half the count was a rig artifact: `queryAuth` arms one boot late

`jellyfin.shell.queryAuth` (JELA-740 / JELA-788) moves the API token from the
`Authorization` header into the query string, which turns every API GET from a
preflighted CORS request into a simple one. It is **seeded by the JSI channel**
(entry "queryAuth default-ON"), so like every channel-seeded shell flag it arms on
the boot _after_ the one that writes it.

Every home-row census in this program — JELA-815's 76, JELA-820's 61 / 58 / 54, and
the "~50" in this ticket's title — was taken on a **fresh rig profile**, i.e. boot 1,
where the key does not exist yet. A fleet TV is on boot _N_.

Two boots, one instrument, one key different:

| arm   | pre-nav seeds               | home-row @boot | GET | OPTIONS | boot-wide reqs | boot-wide OPTIONS |
| ----- | --------------------------- | -------------: | --: | ------: | -------------: | ----------------: |
| `QA0` | `viewgate=1`                |             58 |  29 |  **29** |            428 |                76 |
| `QA1` | `viewgate=1`, `queryAuth=1` |             26 |  26 |   **0** |            362 |                12 |

Home-row preflights go to **exactly zero**, not "fewer". The 29→26 GET difference is
_not_ claimed: `QA1` also finished on 98 cards against `QA0`'s 114, so roughly three
requests' worth of fan-out had not landed inside the fixed 45 s settle. The zero is
what is unambiguous, and it is worth 29 requests per boot that no previous census in
this program subtracted.

Five boots at fleet flag state, across three separate rig runs, agree:

| capture    | home-row GET | home-row OPTIONS | cards | sections | firstCard |
| ---------- | -----------: | ---------------: | ----: | -------: | --------: |
| `QA1-b1`   |           26 |            **0** |    98 |        9 | 30 077 ms |
| `ATTR-b1`  |           30 |            **0** |   130 |       11 | 20 464 ms |
| `WARM-b1`  |           28 |            **0** |    98 |        9 | 25 027 ms |
| `WARM-b2`  |           28 |            **0** |    98 |        9 | 25 365 ms |
| `WARM2-b1` |           28 |            **0** |   130 |       11 | 29 077 ms |

The GET count moves 26–30 with how much fan-out landed inside the fixed 45 s settle —
it tracks cards rendered, not anything about the code. The OPTIONS count is zero every
time. `ATTR` carries the in-page `fetch`/`XHR` observer and is not an outlier, so the
instrument does not inflate the census it records.

**Rule this generalises to:** a census taken on a fresh profile measures a TV that
does not exist. Seed the fleet's _flag_ state (JELA-796) **and** re-check which of
those flags are seeded rather than shipped, because a seeded flag is one boot behind
on boot 1 and only on boot 1.

## 2. The residual is overwhelmingly JSI-owned

`initiator.type` is `"script"` for every one of these requests and cannot separate a
channel entry from jellyfin-web core. CDP's `initiator.stack` is empty on this build
unless `Debugger.enable` is on, and that perturbs the census it is meant to explain.
An in-page `fetch`/`XHR` wrapper installed at document-start does record a stack, but
it is not usable here either: **the shell Babel-transpiles the whole JSI bundle and
re-injects it without a `sourceURL`, so every channel frame reports as
`<anonymous>`**, and the true caller is behind a core-js Promise boundary regardless.

What does survive is the query shape. Each producer builds its params from literals
that appear verbatim in exactly one artifact, so attribution is _static_: score every
candidate artifact — each JSI entry separately, plus the HSS plugin script, the shell
and the web bundles — by an **ordered subsequence** match of the URL's
`name=value` literals with bounded gaps.

The ordering matters. A bag-of-tokens score picks the biggest file: a 56 KB entry
outscored the true 17 KB owner on volume alone and claimed `match-score`'s own taste
queries. Requiring `Recursive`…`IncludeItemTypes`…`Filters:"IsFavorite"`…
`Fields:"Genres"` **in URL order** cannot be faked by shared vocabulary.

**Attribute a request to whoever BUILDS its URL, never to whoever names the thing it
fetches.** The first pass matched `/HomeScreen/Section/LatestMovies` against any
artifact containing `"LatestMovies"` and handed all six section fetches to the
`netflix-rows` channel entry. `netflix-rows` does not fetch them: it lists every
section class in a JELA-292 _ranking comment_. The only artifact anywhere that
contains the string `/HomeScreen/Section` is `shell.min.js` — not the channel, and
not `home-screen-sections.js`, which is 3.6 KB of `MutationObserver` glue and issues
no requests at all.

Result, boot-phase, fleet flag state, 30 home-row GETs:

| owner                                                     | GETs | bytes | note                                         |
| --------------------------------------------------------- | ---: | ----: | -------------------------------------------- |
| `shell` — HSS section prefetch                            |    6 |  38 K | `/HomeScreen/Section/*`                      |
| `JSI: match-score`                                        |    6 |  34 K | taste profile                                |
| `JSI: vertical-cards` / `resume-cover-art` (tie)          |    4 |  22 K | `Ids=` hydration                             |
| `JSI: watch-it-again`                                     |    3 |   3 K | three legs (Movie+Series / Series / Episode) |
| `JSI: new-badge`                                          |    2 |  11 K | `Ids=` hydration                             |
| `JSI: top-picks`                                          |    1 |  20 K |                                              |
| `JSI: my-list`                                            |    1 |   1 K |                                              |
| `JSI: mediabar-tizen5-rescue` ×2                          |    2 |  55 K | hero pool + its `Ids=` hydration             |
| `JSI: top10-badges`                                       |    1 |  51 K | candidate pool, `Limit=500`                  |
| `JSI: home-resume-left`, `resume-cover-art`, one `TIE(…)` |    3 |   9 K | `Ids=` hydration                             |
| `shell` or apiclient — `/Items/Latest`                    |    1 |   4 K | only ambiguous row left                      |

**23 of 30 are issued by a named JSI channel entry; 7 by the shell.** Nothing is
issued by the HSS plugin script, and nothing by jellyfin-web core.

So "no JSI seam" is false for three quarters of the residual, and the quarter that is
outside the channel is inside our own shell — which is not a harder target, it is an
easier one. There is no request in this census owned by code we cannot change.

## 3. The lever: the `Ids=` hydration burst asks for the same items 2.35×

Eleven boot GETs carry `Ids=`. Between them they request **339 item ids of which only
144 are distinct**, and they arrive in three tight clusters:

|   # | t (ms after nav) | ids |  bytes | non-`Ids` params                                         |
| --: | ---------------: | --: | -----: | -------------------------------------------------------- |
|   0 |          +19 443 |  50 |  6 851 | `Limit=50&EnableImageTypes=Primary&EnableUserData=false` |
|   1 |          +19 686 |  50 |  6 792 | _(same)_                                                 |
|   2 |          +20 006 |  42 |  5 981 | _(same)_                                                 |
|   3 |          +20 186 |  46 | 30 093 | `Fields=Overview,Genres,RemoteTrailers,ChildCount&…`     |
|   4 |          +20 200 |  16 |  2 620 | _(same as 0)_                                            |
|   5 |          +21 626 |  60 |  6 969 | `Fields=DateCreated&…`                                   |
|   6 |          +21 727 |  26 |  4 511 | _(same as 5)_                                            |
|   7 |          +22 440 |   1 |    538 | `Fields=Genres&…`                                        |
|   8 |          +30 407 |  21 |  3 600 | `EnableImages=false&EnableUserData=false&…`              |
|   9 |          +30 436 |  21 |  4 463 | `Fields=RunTimeTicks&…`                                  |
|  10 |          +30 469 |   6 |  1 246 | `EnableImages=true&ImageTypeLimit=1&…`                   |

Requests 8, 9 and 10 land inside **62 ms of each other with pairwise 100 % id
overlap** — the same items fetched three times, differing only in which fields are
asked for. 2 and 4 and 7 likewise overlap 100 %.

The shell already owns the machinery: `fetchCoalesce` (JELA-724 / 752) coalesces
concurrent GETs and `/Users/*/Items` is already on its allowlist — but it keys on the
**byte-identical URL**, so it never fires on any of these. Generalising the key from
"identical URL" to "same route + same non-`Ids` params ⇒ union the `Ids`", with the
response sliced per waiter, is a small extension of code that already exists,
already has a window (`fetchCoalesceWindowMs`), a kill switch and counters.

Simulated against the capture above:

| coalesce window | strict (identical non-`Ids` params) | field-union |
| --------------- | ----------------------------------- | ----------- |
| 150 ms          | 11 → 10                             | 11 → 8      |
| 250 ms          | 11 → 8                              | 11 → **6**  |
| 800 ms          | 11 → 7                              | 11 → 5      |

So **−3 to −5 of 30 boot home-row GETs**, plus the byte saving from collapsing 339 id
lookups into 144. The whole burst fires at +19 s to +30 s — well after firstCard — so
the window's added latency is paid by post-paint hydration, not by paint.

Constraints any implementation has to respect, all visible in the table above:

- never merge across base paths (`/Items?Ids=` and `/Users/{u}/Items?Ids=` are
  different routes and one of them ignores user data);
- the union's `Limit` must be ≥ the union's id count, or the server truncates
  somebody's items;
- `EnableUserData` / `EnableImages` union to `true`, `Fields` unions;
- only merge requests with `EnableTotalRecordCount=false` — a caller that wants the
  count cannot be served from a filtered slice;
- a caller passing a `Request` object, a body or an `AbortSignal` opts out, exactly
  as the existing coalescer already requires.

## 4. What is NOT yet answered, and the instrument bug in the way

Whether a genuinely warm TV still pays all 30 is **unresolved**, and the first attempt
to answer it produced a capture that looked warm and was not.

A two-boot pair on one profile ended boot 1 with **378 localStorage keys** and started
boot 2 with **26**. The 352 missing ones include every channel-seeded flag
(`itemCache`, `deferJe`, `udcGate`, `aliasCoalesce`, `genreLazy`, `flagDefaults`) and
every LS-backed cache (`jp:taste`, `jp:picks`, `jp:again`, `jp:mylist`,
`bundlePatchState`). Boot 2 measured 28 home-row GETs — identical to boot 1, because
it _was_ boot 1 again.

It is **not** `lsWriteBehind` (JELA-806): that shim only holds keys ≥ 4096 B named
`shell.tx*` or `bundlePatchState`, and `itemCache` is one byte. It is Chromium's
LocalStorage commit delay against a `SIGKILL` two seconds after `Browser.close`: the
keys that survived are the ones written early in the boot, the ones that vanished are
the late ones.

**A two-boot proof must verify that boot 1's late writes are readable at boot 2's
start, not assume it.** Compare the boot-1 `lsPost` key set against the boot-2
`lsPre` key set and void the pair if the intersection is small — a boot 2 that
silently re-ran boot 1 reads as "the warm path is the same as the cold path", which
is the most expensive possible false negative.

---

## Reproducing

Rig `run829.mjs` (fork of JELA-820's `run820.mjs`), namespaced per `RUN_ID`. Adds:
an in-page `fetch`/`XHR` observer installed via
`Page.addScriptToEvaluateOnNewDocument` that records `new Error().stack` per request
without blocking, delaying or rewriting anything; `__shellLsWB` captured at close;
and a nav-to-`about:blank` plus a long idle dwell before shutdown.

Analysis scripts: `attribute2.mjs` (ordered-literal static attribution against the
**served** `public.js`, `home-screen-sections.js`, `shell.min.js` and the web
bundles) and the `Ids=` overlap/coalesce simulator.

Arms used: `QA0` / `QA1` for §1, `ATTR` for §2 and §3, `WARM` / `WARM2` for §4.
