# JEL-46 — NativeShell.AppHost.supports() feature-flag parity (TV vs browser)

**Verdict: PARITY HOLDS.** Every feature gate jellyfin-web actually queries via
`appHost.supports()` resolves consistently between the Tizen shell and the
browser. The only two differences are an _intentional, beneficial_ TV override
(`exitmenu`) and an _inert_ flag the browser sets but no code reads
(`displaymode`). No feature gate diverges in a way that breaks or degrades the
TV. Run `node tooling/tv-validate/apphost-supports/verify-apphost-supports.mjs`
to reproduce (no network needed; exits non-zero on any undocumented drift).

## How supports() resolves on the TV

jellyfin-web's apphost wrapper (decoded from the deployed bundle):

```js
supports: function (e) {
  return window.NativeShell
    ? window.NativeShell.AppHost.supports(e)   // inside our TV shell
    : -1 !== S.indexOf(e.toLowerCase());        // plain browser
}
```

Inside our NativeShell, `appHost.supports()` defers **entirely** to
`NativeShell.AppHost.supports()`. There is no merge with the browser's computed
`S` array — **our hard-coded `SupportedFeatures` list is the single source of
truth for every feature gate on the TV.** That is why this audit matters.

TV implementation (`packages/shell-tizen/src/shell.js`, identical in
`boot-shell.src.js` and `shell.min.js`):

```js
var SupportedFeatures = [
  "exit",
  "exitmenu",
  "externallinkdisplay",
  "htmlaudioautoplay",
  "htmlvideoautoplay",
  "physicalvolumecontrol",
  "displaylanguage",
  "otherapppromotions",
  "targetblank",
  "screensaver",
  "multiserver",
  "subtitleappearancesettings",
  "subtitleburnsettings",
];
supports: (cmd) =>
  !!cmd && SupportedFeatures.indexOf(String(cmd).toLowerCase()) !== -1;
```

## The "browser version" baseline

The fairest browser comparison is what jellyfin-web's **own** browser apphost
computes for a Samsung Tizen TV web browser (`browser.tv === true`,
`browser.tizen === true`). The harness re-implements the bundle's `S` builder
verbatim for that environment. Decoded results for a Tizen TV browser:

| pushed                                                                                                                                                                                         | reason                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| exit, htmlaudioautoplay, htmlvideoautoplay, physicalvolumecontrol, displaylanguage, **displaymode**, targetblank, screensaver, multiserver*, subtitleappearancesettings*, subtitleburnsettings | matches per the platform branches |
| **not** pushed: filedownload, externallinks, fullscreenchange, remotecontrol, remotevideo, fileinput, chromecast, sharing, remoteaudio                                                         | excluded for `tv`/`tizen`         |

\* `multiserver` is config-gated; `subtitleappearancesettings` is `::cue`-detection-gated (true on modern Tizen Chromium).

## Full per-command comparison

`Δ` marks a TV-vs-browser difference. `consumed` = a real `appHost.supports()`
call site was found in the reachable bundles.

| cmd                        | TV        | browser(Tizen) | consumed | gate                                                                                         |
| -------------------------- | --------- | -------------- | -------- | -------------------------------------------------------------------------------------------- |
| castmenuhashchange         | false     | false          | yes      | cast menu hash-change routing                                                                |
| chromecast                 | false     | false          | no       | —                                                                                            |
| clientsettings             | false     | false          | yes      | client-settings UI                                                                           |
| displaylanguage            | true      | true           | no       | display-language selection                                                                   |
| **displaymode** `Δ`        | **false** | **true**       | **no**   | desktop window display-mode; **no caller in reachable bundles**, irrelevant to fullscreen TV |
| downloadmanagement         | false     | false          | yes      | downloads management UI                                                                      |
| **exit**                   | true      | true           | yes      | app exit → `tizen.application` exit                                                          |
| **exitmenu** `Δ`           | **true**  | **false**      | **yes**  | renders in-app **Exit** menu item                                                            |
| externallinks              | false     | false          | yes      | external project/info links                                                                  |
| externalplayerintent       | false     | false          | no       | —                                                                                            |
| filedownload               | false     | false          | no       | —                                                                                            |
| fileinput                  | false     | false          | no       | —                                                                                            |
| fullscreenchange           | false     | false          | yes      | fullscreen toggle button                                                                     |
| htmlaudioautoplay          | true      | true           | no       | audio autoplay policy                                                                        |
| htmlvideoautoplay          | true      | true           | no       | video autoplay policy                                                                        |
| multiserver                | true      | true           | yes      | "Select Server" switching                                                                    |
| nativeblurayplayback       | false     | false          | no       | —                                                                                            |
| nativedvdplayback          | false     | false          | no       | —                                                                                            |
| nativeisoplayback          | false     | false          | no       | —                                                                                            |
| physicalvolumecontrol      | true      | true           | yes      | hides on-screen volume slider                                                                |
| remoteaudio                | false     | false          | yes      | remote/cast audio target                                                                     |
| remotecontrol              | false     | false          | yes      | cast sender / "play on another device"                                                       |
| **remotevideo**            | false     | false          | yes      | play `IsRemote` video items (blocks when false)                                              |
| screensaver                | true      | true           | no       | screensaver behavior                                                                         |
| sharing                    | false     | false          | yes      | Share button                                                                                 |
| subtitleappearancesettings | true      | true           | no       | subtitle appearance page                                                                     |
| subtitleburnsettings       | true      | true           | no       | subtitle burn-in                                                                             |
| targetblank                | true      | true           | yes      | open links in new tab                                                                        |

## The three flags JEL-46 called out

- **`exit` → true (correct).** Matches the Tizen-browser baseline. The TV's
  `exit()` calls `tizen.application.getCurrentApplication().exit()`. Required so
  jellyfin-web's exit pathway works.
- **`remotevideo` → false (consistent, not a divergence).** This is the one that
  could have bitten us: `if (item.IsRemote && !appHost.supports('remotevideo'))
return false` blocks playback of remote items. The TV reports false — **and so
  does jellyfin-web's own Tizen browser baseline** (the builder excludes `tizen`
  from the `remotevideo` push). So behavior is identical: remote items are
  handled the same way on TV and browser. No divergence.
- **`displaymode` → false on TV, true on browser, but INERT.** The browser
  builder unconditionally pushes `displaymode`, yet **no `appHost.supports(
'displaymode')` call site exists** anywhere in the reachable bundles (33
  chunks crawled transitively from `main`). It gates a desktop windowing
  display-mode preference that does not apply to a fullscreen TV. Because nothing
  reads it, the TV omitting it changes no behavior.

## The two real differences — both fine

1. **`exitmenu`: TV true, browser false — intentional.** Gates
   `supports(ExitMenu) && <Exit menu item>` in the user drawer. A TV has no
   browser chrome to close the app, so surfacing an in-app **Exit** is correct
   and desirable. Beneficial override, not a bug.
2. **`multiserver`: TV always true, browser config-gated.** The shell genuinely
   implements `selectServer()` (clears stored URL, reloads to the connect
   screen), so hard-coding `true` is a safe superset — never a regression.

## Stale strings to clean up (cosmetic, non-blocking)

The TV list carries two strings that **no current `AppFeature` enum value
matches**, so they are never queried and have zero effect:

- `externallinkdisplay` — old name. Current jellyfin-web queries `externallinks`
  (TV correctly reports false for that, matching the Tizen browser baseline).
- `otherapppromotions` — no enum entry in current jellyfin-web at all.

They are harmless today. A future cleanup could drop both and (optionally) decide
whether to add `externallinks` — but leaving `externallinks` false is the correct
Tizen behavior, so no functional change is needed. Tracked as a note here rather
than changing shipped behavior under a verification ticket.

## Provenance (re-extract the ground truth)

Deployed jellyfin-web on the test server, `web/main.jellyfin.bundle.js`:

```bash
B="${JELLYFIN_URL%/}"
curl -s "$B/web/main.jellyfin.bundle.js" -o main.js
# AppFeature enum (all cmd strings):
grep -oE 'CastMenuHashChange=.*TargetBlank="targetblank"' main.js
# supports() NativeShell delegation:
grep -oE 'supports:function\(e\)\{return window.NativeShell[^}]*\}' main.js
# browser feature builder S (decoded in the harness):
#   grep around 'physicalvolumecontrol' for the h.push(...) chain
# gate sites (consumers):
grep -ohE 'supports\([a-zA-Z]+\.Y\.[A-Za-z]+' main.js <crawled chunks>
```

The harness encodes these snapshots so the test runs offline; the commands above
let a future engineer refresh them against a newer jellyfin-web build.
