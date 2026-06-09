# JEL-33 — D-pad / body-focus-rescue results (browser)

Captured 2026-06-09 against the live Jellyfin test server (Jellyfin 10.11.x),
real headless Chrome-for-Testing 149 driven over CDP, logged in as the Test
user. Rescue IIFE injected from `boot-shell.src.js` (3497 bytes, byte-identical
to `shell.js`).

`node dpad-test.mjs` → **exit 0 (all PASS)**:

| Page     | focusables | started on `<body>` | rescue fired | rescue succeeded | landed on                          | not-stuck distinct targets |
| -------- | ---------- | ------------------- | ------------ | ---------------- | ---------------------------------- | -------------------------- |
| Home     | 1237       | yes                 | ✅           | ✅               | `BUTTON.emby-scrollbuttons-button` | 8                          |
| Library  | 1225       | yes                 | ✅           | ✅               | `BUTTON.alphaPickerButton "#"`     | 7                          |
| Search   | 1254       | yes                 | ✅           | ✅               | `INPUT.emby-input` (search box)    | 7                          |
| Settings | 1242       | yes                 | ✅           | ✅               | `A.emby-button "Profile"`          | 8                          |
| Details  | 1233       | yes                 | ✅           | ✅               | `BUTTON.button-flat` (header)      | 7                          |

Final rescue counters: `attempts=13, rescues=13` — **every rescue attempt
succeeded** (no attempt left focus on `<body>`).

## Notes

- The "not-stuck" trace on Details organically passed through
  `BODY.libraryDocument` mid-cycle and recovered — i.e. focus really does land
  on `<body>` during normal traversal (a focusable being removed/re-rendered),
  which is exactly the condition the rescue handles on the next keydown.
- Spatial (arrow-only) movement between cards is jellyfin-web's own focus
  manager, not shell code; the shell's contribution is the body-focus rescue +
  the periodic auto-focus interval, both verified here.
- TV/M63: same rescue bytes, ES5-only, all required primitives present in the
  M63 feature matrix. On-device telemetry capture is tracked under the JEL-28
  comparison (pixel capture on the Q60R is firmware-blocked; the rescue is a
  behavioral counter readable via the QA beacon/telemetry harness, not a pixel
  claim).
