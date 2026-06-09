# JEL-84 — Cold boot vs warm boot: full comparison of both paths on TV

**Status:** ✅ verified — `23/23` checks pass
**Harness:** `tooling/tv-validate/cold-warm-boot/verify-cold-warm-boot.mjs`
**Run:** `node tooling/tv-validate/cold-warm-boot/verify-cold-warm-boot.mjs`
**Method:** hermetic — executes the **shipped** persistence / index-cache / server-validation
helpers extracted verbatim from `packages/shell-tizen/src/shell.js` inside a Node `vm`
sandbox, once with an empty (cold) `localStorage` and once with a populated (warm) store,
on both a legacy (TV) and a modern (browser) WebView. No live server, creds, or network.

---

## Definitions

- **Cold boot** — factory-reset-style start: the app's `localStorage` is empty. The shell
  has **no** saved server URL, **no** cached `/web/` bodies, and **no** learned legacy
  transpile verdict. This is also the shape of every boot when the index-cache gate is off
  (`jellyfin.shell.indexCache !== '1'`, the QA default).
- **Warm boot** — steady state: every cache the shell maintains is populated — saved server
  URL, valid `/web/index.html` + `/web/config.json` body cache for this origin, and the
  learned `legacy.babelNeeded` verdict.

The shell instruments and owns the span from the head-IIFE boot mark (`tShellStart`) to the
`document.open()/write()` handoff (`tDocumentWrite`). Everything **after** document.write —
`jellyfin-web` init, the login screen, the home screen — runs inside the **identical**
jellyfin-web bundle on cold and warm, TV and browser. Those phases are parity-by-construction
(same bytes); the cold/warm difference is entirely in the **pre-handoff** span, which is what
this comparison decomposes. (First-card paint is observed downstream by the QA beacon's
`countCards()` — see JEL-62 boot-timing.)

---

## Phase-by-phase comparison

Legend: **RUN** = phase executes and is on the critical path · **SKIP** = phase removed ·
**bg** = demoted to background (off the critical path).

| #   | Phase                          | TV cold          | TV warm            | Browser cold     | Browser warm     | Owner of the skip                           |
| --- | ------------------------------ | ---------------- | ------------------ | ---------------- | ---------------- | ------------------------------------------- |
| 1   | Connect screen                 | **RUN**          | **SKIP**           | **RUN**          | **SKIP**         | serverUrl persistence (`bootstrap()`)       |
| 2   | Server URL entry (user typing) | **RUN**          | **SKIP**           | **RUN**          | **SKIP**         | serverUrl persistence                       |
| 3   | `/System/Info/Public` probe    | **RUN**          | **SKIP**           | **RUN**          | **SKIP**         | JEL-555 (stored boots skip the pre-flight)  |
| 4   | `/web/index.html` fetch        | **RUN**          | **SKIP** → bg      | **RUN**          | **SKIP** → bg    | index body cache · JEL-57/JEL-1977 (gated)  |
| 5   | `/web/config.json` fetch       | **RUN**          | **SKIP** → bg      | **RUN**          | **SKIP** → bg    | config body cache · JEL-57/JEL-1977 (gated) |
| 5b  | `config.json` `JSON.parse`     | **RUN**          | **SKIP**           | **RUN**          | **SKIP**         | parsed-config cache (`p.parsed`)            |
| 5c  | DOMParser + `outerHTML` reflow | **RUN**          | **SKIP**¹          | **RUN**          | **SKIP**¹        | string fast path · JEL-1832                 |
| 6   | babel 3.13 MB fetch+parse      | **RUN**²         | **RUN**² (learned) | —                | —                | legacy-only; never on browser               |
| 6b  | per-`<script>` transpile       | **RUN**²         | **RUN**² (cached³) | —                | —                | JEL-17 warm-transpile cache                 |
| 7   | `document.write` handoff       | **RUN**          | **RUN**            | **RUN**          | **RUN**          | shared critical path (always)               |
| —   | jellyfin-web init              | identical bundle | identical bundle   | identical bundle | identical bundle | parity-by-construction                      |
| —   | Login screen                   | identical bundle | identical bundle   | identical bundle | identical bundle | parity-by-construction                      |
| —   | Home screen / first card       | identical bundle | identical bundle   | identical bundle | identical bundle | parity-by-construction                      |

¹ The string fast path **bails** (DOMParser path runs even warm) when the learned
`legacy.babelNeeded` verdict is `'1'` for this server's bundle — see note ².
² The babel phase is **legacy-only** and fires on **both** cold and warm TV boots when the
server's web bundle needs transpiling. The warm boot does not re-discover the verdict — it is
read from `jellyfin.shell.legacy.babelNeeded` — but it still pays the transpile. The browser
never satisfies the legacy gate, so it has **no** babel phase on either boot.
³ JEL-17: transpiled bodies are cached in `localStorage`, so a warm boot re-uses them instead
of cold-transpiling every script (this is what keeps the spotlight hero rendering reliably).

---

## Which optimizations are active in each path

| Optimization                          | Key / gate                                            | Active on cold  | Active on warm  | What it removes                                    |
| ------------------------------------- | ----------------------------------------------------- | --------------- | --------------- | -------------------------------------------------- |
| serverUrl persistence                 | `jellyfin.shell.serverUrl`                            | seeds it        | **yes**         | connect screen + URL entry (phases 1–2)            |
| JEL-555 pre-flight skip               | `bootstrap()` `if (stored)` branch                    | n/a             | **yes**         | `/System/Info/Public` round trip (phase 3)         |
| index/config body cache (JEL-57/1977) | `jellyfin.shell.indexCache='1'` (off by default)      | seeds it        | **yes** (gated) | `/web/` RTT pair from the critical path (4–5)      |
| parsed-config cache                   | `p.parsed` on the config wrapper                      | seeds it        | **yes**         | second `JSON.parse` (phase 5b)                     |
| string fast path (JEL-1832)           | `!fastPathDisabled` & not babel-needed                | n/a             | **yes**¹        | DOMParser + `outerHTML` reflow (phase 5c)          |
| warm-transpile cache (JEL-17)         | `localStorage` transpiled bodies                      | seeds it        | **yes** (TV)    | per-script re-transpile (phase 6b, legacy)         |
| babel preload (legacy)                | `legacy.babelPreload` + `legacy.babelNeeded`          | not yet learned | **yes** (TV)    | overlaps babel fetch with shell startup            |
| prefetch (JEL-58) / preload (JEL-59)  | head IIFE `__shellPrefetch` / `__shellPreloadScripts` | **yes**         | **yes**         | overlaps `/web/` fetch w/ shell parse (both boots) |

¹ Bails to the slow path when `legacy.babelNeeded==='1'` for this server.

**Net:** the warm boot removes phases 1, 2, 3, 5b and (gate-permitting) 4, 5, 5c from the
pre-`document.write` critical path. On a modern browser that is essentially the whole
pre-handoff delta. On the TV the **dominant residual cost is the legacy babel phase (6/6b)**,
which warm boots still pay — they re-use the _verdict_ and the _transpile cache_, not a
zero-cost path. That is why the TV cold↔warm delta is larger than the browser's, and why the
TV warm boot is still slower than the browser warm boot.

---

## Caveats / boundaries (what this cannot claim)

- **No wall-clock milliseconds.** This is a hermetic structural decomposition of _which
  phases run_ on each path, pinned to shipped bytes — not an on-device stopwatch. Real
  per-phase ms (LAN RTT 200–500 ms, babel parse, etc.) require the QA boot-marks beacon on
  the physical TV (JEL-62 pipeline) and physical-device access (JEL-7 blockers). The relative
  ordering and which phases are present/skipped is what is asserted here.
- **Index-cache gate is off by default** (`jellyfin.shell.indexCache`). Until it is turned on
  post-QA, _every_ boot pays the `/web/` RTT pair (phase 4–5) — i.e. the default boot is
  "cold-shaped" for those two phases even when the server URL is saved.
- **Origin- and version-pinned.** Switching servers or upgrading the shell forces one
  cold-shaped boot before the cache re-warms (asserted B5/B6) — by design, to avoid stale or
  cross-origin body adoption.
- **Post-handoff phases** (jellyfin-web init, login, home) are parity-by-construction and out
  of the shell's measurable scope — same bundle bytes on every path.

---

## Check inventory (23/23)

- **PART A (6)** — serverUrl persistence: cold shows connect screen + drives the real
  `validateServer` `/System/Info/Public` probe; warm skips both; `bootstrap()` fork and the
  JEL-555 pre-flight skip pinned to shipped bytes; `saveServerUrl` cold→warm transition.
- **PART B (7)** — `/web/` body cache: cold miss → live fetch → writes LS; warm hit serves
  both bodies + parsed config from LS; gate-off bypass; origin-pin, version-pin, and poison
  guards (a flaky cold fetch can't poison the warm boot).
- **PART C (4)** — legacy babel verdict: fast-path `babelNeeded` bail; `loadRemoteWebClient`
  consults the learned verdict; browser never satisfies the legacy gate (no babel either
  boot); JEL-17 warm-transpile cache.
- **PART D (5)** — optimization matrix pinned to the deployed `shell.min.js` + `index.html`
  artifacts (each optimization is present where the comparison claims it).
