# JEL-44 — Subtitle selection & rendering: browser vs Tizen M63 — results

Date: 2026-06-09 · Server: Test (Jellyfin 10.11) · Browser baseline:
headless Chrome-for-Testing 149. Re-run the three scripts in this folder to
reproduce.

## Verdict

**Server-side parity confirmed; client render path verified in-browser; ASS
client renderer is parse-safe on M63.** Subtitle selection, toggle, and track
switching are pure jellyfin-web behavior loaded verbatim by the shell, so they
are identical on TV and browser by construction. No shell defect found. One
shell-owned lever (`enableSsaRender:true`) is correct. Residual risk is
on-glass-only and listed at the end.

## Test scope mapped to the ticket

1. **Open subtitle selector** — ✅ confirmed live in-browser. The OSD subtitle
   button opens an action sheet listing every track with its codec, e.g.
   `Off`, `English-SRT - ASS`, `Chinese-PGS - PGSSUB`, … (14 tracks on "300").
2. **Toggle on/off** — ✅ `Off` is the first menu item; selecting it clears the
   track. Same code path on TV.
3. **Switch between tracks** — ✅ selecting `English-SRT - ASS` switched the
   active track and instantiated the renderer (below).
4. **Position/size on the TV display** — ⚠️ partial: render _path_ verified;
   pixel position/size on the physical 1080p panel is on-glass-only (see
   residual risks). CSS is identical bytes, so divergence would require an M63
   CSS-engine gap.
5. **Font/styling match the browser** — ⚠️ same: appearance CSS is jellyfin-web
   byte-for-byte on both; the only divergence vector is M63 font glyph coverage.

## Findings

### 1. Server delivery is identical for TV and browser (`subtitle-delivery.mjs`)

For every codec family, the `DeliveryMethod` the server assigns is the same
whether the request comes from the shell's TV profile or a browser profile. The
only thing the shell's `enableSsaRender:true` changes is keeping ASS as a
client-rendered external track instead of burning it in:

| codec           | shell-TV (`ssa=on`)          | hypothetical `ssa=off`  |
| --------------- | ---------------------------- | ----------------------- |
| subrip (text)   | External                     | External                |
| ass (SSA)       | **External** (client libass) | Encode (server burn-in) |
| pgssub (bitmap) | Encode (burn-in)             | Encode                  |
| dvdsub (bitmap) | Encode (burn-in)             | Encode                  |

`surprises: 0` — every row matched the expected delivery. So: text and bitmap
subtitles render the same way on TV and browser; only ASS depends on the M63
client renderer, which is what the next two findings probe.

### 2. ASS renders via client SubtitlesOctopus in a real browser (`subtitle-render-capture.mjs`)

Selecting the ASS track on "300" produced:

- `canvas.libassjs-canvas` (1280×533) under `div.libassjs-canvas-parent`, and
- `video.textTracks.length === 0` (so it is **not** native `<track>`/`::cue`).

That is exactly the `enableSsaRender:true` path: jellyfin-web routed ASS to the
libass-WASM engine, which loaded and created its overlay canvas. Screenshots:
`capture-menu.png` (selector), `capture-subs-on.png` (canvas live over
playback). The captured frame is at t≈11s (studio logo), so no dialogue cue is
painted yet — the canvas is instantiated and sized, proving the engine came up.

### 3. The ASS worker is parse-safe on M63 (`octopus-worker-syntax.cjs`)

`SubtitlesOctopus` loads its engine with `new Worker('subtitles-octopus-worker.js')`.
A worker script is parsed by the worker engine directly and **bypasses the
shell's `<script>`/plugin Babel transpile** — so modern syntax there would throw
a `SyntaxError` on the M63 worker thread and silently kill ASS while leaving SRT
and the desktop browser unaffected.

A regex pre-scan flagged the worker (`?.` ×3, `#x` ×52), but running it through
the shell's exact Babel (chrome:63) **lowered none of them** — they are all
inside libass's embedded string data (CJK / word-frequency tables), not real
syntax. Both the WASM worker and the 4.4 MB asm.js fallback are parse-safe.
This is now a committed regression guard for future jellyfin-web bumps.

## Residual risk — on-glass only (cannot be captured headless or via sdb on M63)

These require the physical TV and cannot be screenshotted from the sandbox (sdb
screen capture is unavailable on the M63 set):

- **ASS render quality / perf** of libass-WASM on the TV's SoC (canvas instantiates
  in-browser; on-device frame rate / memory for heavy ASS is unverified).
- **Font glyph coverage** for non-Latin subtitle languages against the fonts
  actually installed on the Samsung 2018 firmware (Latin SRT is low-risk).
- **Pixel position/size** of the text overlay at native 1080p (CSS is identical
  bytes; M63 supports the units used, so low-risk, but unconfirmed visually).

Recommended path if pixel-level on-TV confirmation is wanted: the existing
phone-home M63 remote-debug build (see the team's `m63-remote-debug-harness`
playbook) rather than a manual photo — keep verification agent-driven.
