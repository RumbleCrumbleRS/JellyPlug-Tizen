# @jellyfin-tv/jellyplug-lite

JellyPlug Lite (JELA-67): a Netflix-shaped Jellyfin home for Samsung
Tizen TVs — a hand-written ES5 layer driving a scene-graph renderer on a
single `<canvas>`. No DOM tree, no CSS layout engine, no jellyfin-web
SPA on the boot path. Replaces the measured 18–20s boot (≈10s SPA
parse/eval + ≈9s Enhanced-skin DOM hooking + 184-card DOM render, see
JELA-41) with ~100KB of purpose-built code and ~20 drawn posters.

## Status

M1 slice 1 — the core library. Contains the layout math, remote-key nav
engine, localStorage SWR home-sections cache, Jellyfin REST client,
poster prescale pool, canvas renderer, and a `boot()` that wires them to
a real window. **Not yet on any boot path**: nothing in the shell or
server-plugin references it. Wiring over the JELA-66 sha-keyed
localStorage byte-cache rail (behind a default-OFF flag) is slice 2.

Phase gates (evidence on the JELA-67 thread):

- **M0 spike: PASSED on both panels.** Q60R (2019 M63, Tizen 5.0):
  prescaled scene 54fps, frame p95 27.8ms, key→next-frame p95 23.7ms.
  QN90B (Tizen 6.5): 61fps locked, scene draw 1.1ms. The design rules
  baked into this package come from that spike: prescale posters to
  card-size canvases at load, draw only visible cards, never read the
  canvas back (Jellyfin image routes send no ACAO → taint).
- M1 target: ≤3s launch → navigable home on the Q60R.

## Layout of the code

Everything lives in `src/lite.src.js` (single file, ES5, no transpile —
it must parse raw on a 2019 Chromium-63-era engine; `es5-guard.test.cjs`
enforces the envelope). Stateful pieces are `create*()` factories taking
their environment (storage / fetchJson / document / now) as arguments,
so the logic runs under plain node tests with no canvas or network.

- `Lite.layout` — pure 1920×1080 grid math (row/card positions, scroll
  targets, visible ranges, focus-ring rect).
- `Lite.createNav(rowCounts)` — remote-key focus state machine with
  per-row column memory; `setRowCounts()` survives SWR revalidation
  reshaping rows under focus.
- `Lite.createSwr({storage,key,fetchFresh})` — render cached JSON
  instantly, revalidate behind, re-render only on real change.
- `Lite.readCreds(storage)` / `Lite.createApi(...)` — reuse the session
  jellyfin-web persisted (`jellyfin_credentials`); fetch Resume, Next
  Up, and Latest-per-view rows.
- `Lite.createImagePool(doc,onLoaded)` — poster loader + prescaler.
- `Lite.createRenderer(canvas,images)` — scene draw, scroll lerps,
  dirty-flag frame gating (rAF only runs while something moves).
- `Lite.boot(win,doc)` — composition root; returns `null` when there is
  no stored session (caller falls back to the full SPA).

## Build / test

- `pnpm --filter @jellyfin-tv/jellyplug-lite test` — node unit tests.
- `pnpm --filter @jellyfin-tv/jellyplug-lite build` — esbuild
  (whitespace+syntax only, mangle OFF, same discipline as the shell) →
  `dist/lite.min.js`, size-budgeted at 96KiB.
