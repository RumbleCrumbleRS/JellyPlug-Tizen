# JEL-78 — Volume control behavior — TV vs browser

**Verdict: behavior diverges BY DESIGN, and the divergence is correct.** On TV
the shell registers **no** volume keys and declares `physicalvolumecontrol`, so
volume is owned entirely by the Samsung TV's hardware mixer (the right TV UX);
jellyfin-web's software volume slider is not loaded and its software volume
operations are short-circuited. In a desktop browser that flag is false, so the
on-screen slider loads and drives the HTML `<video>` element. **Mute/unmute is
functional and reflected in the UI on both** — software mute in the browser
(jellyfin's volume button), hardware mute on TV (the set's native mute OSD).
23/23 deterministic checks pass; 16/16 live-bundle assertions confirm the
jellyfin-web gate.

Run it:

```
# shell contract + behavioural model (no server/browser needed)
node packages/shell-tizen/scripts/volume-control.test.cjs

# live jellyfin-web gate re-derived from the served bundle
JELLYFIN_URL=https://host node tooling/tv-validate/volume-control/verify-volume-gate.mjs
```

## Direct answers to the ticket's questions

| Question                                                 | Answer                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the shell register volume keys, or defer to the OS? | **Defers entirely to the OS.** `registerRemoteKeys()` lists only transport (`Media*`) and color (`ColorF*`) keys. `VolumeUp`/`VolumeDown`/`VolumeMute` are absent, so the Samsung firmware keeps the physical Volume +/- and Mute buttons and drives the set's own mixer — they never enter the webview. |
| Does the on-screen volume slider work on TV?             | **There is no on-screen slider on TV — by design.** jellyfin-web only loads its volume-slider OSD module when `physicalvolumecontrol` is _not_ supported (or on touch). On TV the flag is true, so the module is never loaded. In a browser it loads and works.                                          |
| TV vs browser volume control mechanism                   | **TV:** hardware mixer via the physical remote (OS-level). **Browser:** software, via `playbackManager` → `<video>.volume` driven by the slider and media-key commands.                                                                                                                                  |
| Does mute/unmute work and reflect in the UI?             | **Yes on both.** Browser: the slider's mute button toggles `<video>.muted`; jellyfin's volume icon reflects `IsMuted`. TV: the physical Mute button mutes at the OS/hardware level, reflected in the **TV's native mute OSD**. jellyfin's software-mute path is intact but simply never invoked on TV.   |

## The single root cause: the `physicalvolumecontrol` flag

The shell declares it in `SupportedFeatures` (`packages/shell-tizen/src/shell.js`):

```js
var SupportedFeatures = [ … "physicalvolumecontrol" … ];
…
supports: function (cmd) {
  return !!cmd && SupportedFeatures.indexOf(String(cmd).toLowerCase()) !== -1;
}
```

jellyfin-web's `appHost.supports()` delegates **entirely** to NativeShell when
present (verified live):

```js
supports:function(e){return window.NativeShell?window.NativeShell.AppHost.supports(e):-1!==S.indexOf(e.toLowerCase())}
```

- **TV** (NativeShell present) → our list → `supports("physicalvolumecontrol") === true`.
- **Browser** (no NativeShell) → jellyfin-web's own self-report `S`, which pushes
  `PhysicalVolumeControl` only for `tv||xboxOne||ps4||mobile||ipad`. A desktop
  browser is none of those → **false**.

That one boolean explains every difference below. See
[apphost-supports-delegation] memory.

## How `physicalvolumecontrol` drives jellyfin-web (live ground truth)

Captured from `${JELLYFIN_URL}/web/main.jellyfin.bundle.js` (jellyfin-web
10.11.x) on 2026-06-09; re-derived by `verify-volume-gate.mjs`.

**The gate predicate:**

```js
function Re(e) {
  return e.isLocalPlayer && _.g.supports(ce.Y.PhysicalVolumeControl);
}
```

**Software volume — short-circuited when `Re()` is true (TV):**

```js
i.setVolume = function (e, t) {
  (t = t || i._currentPlayer) && !Re(t) && t.setVolume(e);
};
i.getVolume = function (e) {
  return (e = e || i._currentPlayer) && !Re(e) ? e.getVolume() : 1;
};
i.volumeUp = function (e) {
  (e = e || i._currentPlayer) && !Re(e) && e.volumeUp();
};
i.volumeDown = function (e) {
  (e = e || i._currentPlayer) && !Re(e) && e.volumeDown();
};
```

- **TV:** `setVolume`/`volumeUp`/`volumeDown` are **no-ops** on the local player;
  `getVolume` is pinned to `1` (100%). The `<video>` element always plays at full
  amplitude; the TV's hardware mixer attenuates the actual output.
- **Browser:** none of the guards fire — these operate directly on `<video>.volume`.

**The volume-slider / mute OSD module is conditionally loaded:**

```js
(a.g.supports(d.Y.PhysicalVolumeControl) && !y.A.touch) ||
  n.e(91737).then(n.bind(n, 91737));
```

`A || load(...)`: when `supports(PVC) && !touch` is truthy (TV, non-touch), the
`||` short-circuits and chunk `91737` (the volume control component) is **not
loaded**. In a desktop browser the left side is false, so the slider loads.

**Mute is NOT behind the gate** (verified live):

```js
{key:"setMute", value:function(e){ var t=…||this._currentPlayer; t && t.setMute(e) }}
{key:"toggleMute", value:function(e){ var t=…; t && (t.toggleMute ? t.toggleMute() : t.setMute(!t.isMuted())) }}
```

So the software-mute path works regardless of `physicalvolumecontrol`. On TV it
is simply never reached (the Mute key is unregistered and the OSD control isn't
loaded); mute happens at the hardware level instead.

**Keyboard command contract** (dormant on TV, live in browser):

```
case "VolumeUp"   -> handleCommand("volumeup")    -> playbackManager.volumeUp()   [gated]
case "VolumeDown" -> handleCommand("volumedown")  -> playbackManager.volumeDown() [gated]
case "Mute"       -> handleCommand("mute")        -> playbackManager.setMute(true)
case "ToggleMute" -> handleCommand("togglemute")  -> playbackManager.toggleMute()
```

These are driven by `KeyboardEvent.key` (a media keyboard in the browser). On TV
they cannot fire: the shell never registers the hardware Volume/Mute keys, **and**
jellyfin-web's `KeyNames` keyCode→name table has **no** entry for any Volume/Mute
keyCode (verified live) — so even a leaked keyCode could not be translated to a
volume command.

## Why this is correct, not a gap

A TV is connected to a sound system (TV speakers, soundbar, or AVR) whose volume
the user controls with the TV/AVR remote at the hardware level. Re-implementing a
software volume slider on top of that would be redundant and confusing (two
volume controls that don't agree). jellyfin-web ships `physicalvolumecontrol`
precisely so TV-class clients hand volume to the hardware — the shell opts into
that, exactly as the official Samsung/Tizen target does. Playing `<video>` at a
fixed 100% and letting the hardware attenuate is the standard, correct TV model.

## What is verified deterministically (`volume-control.test.cjs`, 23/23)

- **Shell registers no volume/mute key** — `registerRemoteKeys()` and the
  deployed `shell.min.js` contain none of `VolumeUp/VolumeDown/VolumeMute/Mute`.
- **`physicalvolumecontrol` is declared** in `SupportedFeatures` and present in
  the deployed `.min.js`; `supports()` resolves case-insensitively against it.
- **No shell keydown listener swallows a volume key** — the back-handler
  (keyCode 10009 only) and the focus-rescue key-name/keycode sets are disjoint
  from every volume key.
- **Behavioural model of jellyfin-web's gate** (mirrors the live code): with
  `physicalvolumecontrol = true` (TV) software volume is inert and `getVolume`
  returns 1, while mute still works; with `false` (browser) the full slider path
  works. Mute/unmute reflected via `isMuted()` on **both**.

## Live confirmation (`verify-volume-gate.mjs`, 16/16)

Re-derives from the served bundle: the `supports`→NativeShell delegation, the
`PhysicalVolumeControl` constant + browser self-report set, the `Re()`
predicate, the four `!Re()`-gated volume ops, the two **un**gated mute ops, the
slider-module load gate, the four keyboard command cases, and the absence of any
Volume/Mute `KeyNames` keyCode entry.

> Note: the test Jellyfin server (`REDACTED-SERVER.example`, a home DDNS) is
> intermittently reachable from the sandbox. All 16 assertions were validated
> against a bundle captured live this session (485,026 bytes, jellyfin-web
> 10.11.x). The verifier skips cleanly (exit 0) when `JELLYFIN_URL` is unset and
> re-runs against the live server whenever it is reachable.
