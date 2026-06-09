# JEL-53 — Compare: Search functionality (query entry, results, navigation) — TV vs browser

**Verdict: parity confirmed — expected behavior, no shell defect.**

Search is **100% jellyfin-web + server driven**. The Tizen shell does not
implement, wrap, or customize any part of the search code path, so the search
screen on the TV behaves identically to the desktop browser by construction. The
empirical harness (`verify-search.mjs`) runs the full search flow — incremental
query entry, result rendering, and result→details navigation — under two distinct
client identities (a browser-like session and the real TV session,
`Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV"`) and confirms
**byte-identical** results for every probed term. **35/35 checks pass.**

## The shell has zero search code

A `grep` of `shell.js` and `boot-shell.src.js` for `search` finds only:

| Hit | What it is | Relevant to text search? |
| --- | --- | --- |
| `focusManager.nav()` "searches geometrically…" | D-pad **spatial** focus nav | No — that's [JEL-33](/JEL/issues/JEL-33) focus, not query search |
| `location.search` | URL query-string parsing | No |

There is **no** text-search, search-input, search-results, or `/Search/Hints`
code anywhere in the shell. Every piece the user exercises on the search screen
maps to a layer the shell does not touch:

| Step in the task | Owned by | Why it can't diverge TV vs browser |
| --- | --- | --- |
| **(1) Query entry** (virtual keyboard / input via D-pad) | jellyfin-web `searchFields` UI + platform `<input>`; D-pad focus *into* the field is the shell's body-focus-rescue ([JEL-33](/JEL/issues/JEL-33)) | The shell adds no key handling on the search screen (it only intercepts BACK `10009` — see PARITY_NOTES / [JEL-42](/JEL/issues/JEL-42)). Once focus lands, character entry + caret + intra-screen D-pad movement are the platform/`focusManager`. |
| **(2) Results** | `GET /Search/Hints?searchTerm=…` per (debounced) keystroke | The hint payload takes **no `DeviceProfile`** and does not vary on client/device — the server returns identical `SearchHints` to any client of the user. |
| **(3) Result display** (movies/shows/episodes/people) | result card built from hint fields (`Name`, `Type`, `PrimaryImageTag`, `Series`, …) | Same fields delivered to both clients. |
| **(4) Navigation** | OK/click routes to `#!/details?id=<ItemId>`, payload `GET /Users/{uid}/Items/{ItemId}` | Id-addressed; identical payload for both. |

### Query entry / on-screen keyboard — the JEL-33 link

The "virtual keyboard / search input accessible via D-pad" requirement is the
same focus mechanism validated in [JEL-33](/JEL/issues/JEL-33): on Tizen,
`activeElement` can sit on `<body>` so the first D-pad press is a no-op; the
shell's body-focus-rescue lands focus on the first focusable target (7 distinct
targets, no stuck frames in JEL-33). That brings TV D-pad reach to the search
field/keyboard to **parity** with the browser. Actual character entry is the
WebView's native text input — not shell code — so the typed query that reaches
`/Search/Hints` is identical to the browser's. This harness therefore verifies
the data contract (the open question for search); the spatial focus piece is
covered by JEL-33 and is not re-driven pixel-by-pixel here.

### How the results page surfaces each type

The live "as you type" dropdown issues one unfiltered `/Search/Hints` call. The
search **results page** additionally issues one `includeItemTypes=`-filtered call
per category section (Movies / Shows / Episodes / People / …) — which is why each
type gets its own row even when one type (e.g. Episodes) would otherwise saturate
the result limit. The harness mirrors both: the unfiltered call for the
"as you type" flow, and per-type filtered calls to confirm each result class is
returned.

## Empirical verification (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/search/verify-search.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never prints
credentials; **read-only** — no server or account state mutated).

```
PASS  authenticate
PASS  incremental query "s"/"st"/"sta"/"star" returns results        — 40 hints each
PASS  query results all match the query text                         — 40/40 match /…/i
PASS  query does not widen vs shorter prefix                         — monotone narrowing
PASS  search surfaces multiple item types                            — Episode:23, Studio:3, Movie:6, BoxSet:2, Person:6
PASS  every result has a display Name / Type                         — 40/40
PASS  episode results carry Series context                           — 23/23
PASS  result poster image resolves                                   — "Star Turn" -> 200 image/jpeg
PASS  People / Series / Movie / Episode results returned             — 40 / 28 / 7 / 40
PASS  select (Episode/Studio/Movie/BoxSet/Person/Person/Series) -> details resolves to same item  — 200, id match, type match
PASS  TV results byte-identical to browser for star/love/the/john/man/a  — identical

35/35 checks passed.
```

### What each group proves

- **(1) Query entry** — incremental queries (`s` → `st` → `sta` → `star`) each
  return relevant, monotonically-narrowing results, exactly the per-keystroke UX
  the user sees while typing. Focus-into-field is covered by JEL-33.
- **(2) Results match the browser** — for six terms the TV and browser fingerprints
  (ordered `[ItemId, Name, Type]`) are byte-identical. The server cannot return
  different search results to the two clients.
- **(3) Items display correctly** — all four user-named classes are returned
  (Movies, Shows/Series, Episodes, People), every hint carries the `Name`/`Type`
  the result card needs, episodes carry their `Series` context, and a sample
  poster resolves to a real `image/*`.
- **(4) Navigation** — selecting one result of **every** surfaced type resolves
  `/Users/{uid}/Items/{ItemId}` to the same Id with a matching Type — the click
  lands on the right details page, not a 404 or the wrong entity.

## Scope / limits

This is a data-contract + parity harness, not a pixel driver. Spatial D-pad focus
and on-screen text entry are the platform/jellyfin-web `focusManager` (validated
in [JEL-33](/JEL/issues/JEL-33)); this harness does not re-drive the keyboard
key-by-key. The claim it proves is the one unique to search: the query reaches
the server identically, the results/display fields are identical TV vs browser,
and every result navigates to the correct details payload.
