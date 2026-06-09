# JEL-66 — NativeShell.openUrl: no-op on TV, link behavior in browser (TV vs browser)

**Verdict: NO-OP CONFIRMED, NO BROKEN STATE ON TV.** `NativeShell.openUrl()` is
an empty function in every shipped shell artifact: it returns `undefined` and
throws nothing for any argument shape. jellyfin-web routes to it only through a
`window.NativeShell.openUrl ? … : window.open(…)` guard, so a plain browser opens
the link (`window.open`) while the TV no-ops. Three independent layers ensure
"View on TMDB"-style external-link UI cannot strand the user on the TV. Run
`node packages/shell-tizen/scripts/openurl-noop.test.cjs` to reproduce
(no network needed; exits non-zero on any drift).

## The shell hook (source of record)

`packages/shell-tizen/src/shell.js` (and identically `boot-shell.src.js`,
`shell.min.js`, `boot-shell.min.js`):

```js
openUrl: function (/* url, target */) {
  /* TV cannot open external browsers */
},
```

A Tizen WRT widget has no API to launch the system browser, so an empty body is
the correct and only sane implementation. The minified blobs that actually boot
on the TV carry it as `openUrl:function(){}`.

## The jellyfin-web call path (ground truth, 10.11.x)

jellyfin-web's shell module wraps the native hook with an existence guard:

```js
openUrl: function (e, t) {
  var n;
  (null !== (n = window.NativeShell) && void 0 !== n && n.openUrl)
    ? window.NativeShell.openUrl(e, t)
    : window.open(e, t || "_blank");
}
```

- **On the TV** `window.NativeShell.openUrl` exists → the wrapper calls our empty
  body. Nothing opens, nothing throws.
- **In a plain desktop browser** `window.NativeShell` is `undefined` → the guard
  falls through to `window.open(url, target || "_blank")` and the link opens.
  **This is the "link behavior in browser" the ticket asks about.**
- Our shell _loaded in a desktop browser_ still no-ops — `NativeShell` is present
  there too — so the TV-vs-(our-shell-in-)browser comparison is byte-identical by
  construction. The only place the link actually opens is a browser with **no**
  NativeShell, which is jellyfin-web's intended fallback.

## Why no external-link UI can strand the user on the TV — three layers

### Layer 1 — UI gate (the section never renders)

The external-links UI is gated on the `ExternalLinks` feature:

```js
// React component for the external links block:
if (!0 === n && !appHost.supports(ExternalLinks)) return null;
// auto-hide handler elsewhere:
…supports(ExternalLinks) ? el.classList.remove("hide") : /* stays hidden */
```

The TV reports `ExternalLinks = false`: our `SupportedFeatures` list has **no
`"externallinks"`** entry. (It carries the legacy `"externallinkdisplay"`, which
matches **no** current `AppFeature` enum value — the enum is
`ExternalLinks="externallinks"`; see JEL-46.) jellyfin-web's own Tizen-browser
baseline also omits `ExternalLinks` (its feature builder pushes it only for
non-tizen platforms). So the "View on TMDB / IMDb" links section is **not
rendered on the TV at all** — there is nothing to click.

### Layer 2 — handler gate (clicks never reach openUrl)

For any link that _did_ render with a `target` attribute, the click handler is:

```js
function (e) {
  var t = this.getAttribute("href") || "";
  if ("#" !== t) {
    if (this.getAttribute("target"))
      appHost.supports(TargetBlank) || (e.preventDefault(), shell.openUrl(t));
    else { e.preventDefault(); appRouter.show(t); }
  }
}
```

The TV reports `TargetBlank = true`, so `supports(TargetBlank) || (…)`
**short-circuits**: no `preventDefault`, no `shell.openUrl`. The native
`<a target="_blank">` path runs instead — and a Tizen WebView simply opens no
popup. `openUrl` is never reached through these handlers on the TV.

### Layer 3 — safety net (openUrl is harmless if ever called)

Even if some other code path calls `shell.openUrl` on the TV, the native body is
empty: returns `undefined`, throws nothing. Worst case is a control that
visibly does nothing — never a crash, never a broken state. The runtime test
exercises this directly with 0/1/2/garbage/hostile (`javascript:`) arguments.

## What the contract test pins

`packages/shell-tizen/scripts/openurl-noop.test.cjs` (19 checks):

1. `openUrl` body is empty (no executable substance) in `shell.js` + `boot-shell.src.js`.
2. `shell.min.js` + `boot-shell.min.js` define it as `function(){}`.
3. The body names no navigation/window/Tizen/`href` surface.
4. **Runtime:** the real shipped body throws nothing and returns `undefined` for
   0/1/2/garbage/hostile args.
5. **Runtime:** a verbatim transcription of jellyfin-web's `shell.openUrl` wrapper
   proves the TV branch delegates to our no-op (window.open NOT called) and the
   browser branch calls `window.open(url, target||"_blank")`.
6. The click-handler bytes route target links through `supports(TargetBlank) || openUrl`,
   and a `TargetBlank=true` short-circuit leaves `openUrl` un-called.
7. The shell advertises `targetblank` (native-link path) and withholds the current
   `externallinks` feature (UI gate).
8. `shell.js` and `boot-shell.src.js` agree on the empty-`openUrl` contract.

## Provenance (re-extract the ground truth)

Deployed jellyfin-web on the test server, `web/main.jellyfin.bundle.js`:

```bash
B="${JELLYFIN_URL%/}"
curl -s "$B/web/main.jellyfin.bundle.js" -o main.js
# shell.openUrl wrapper (NativeShell guard + window.open fallback):
grep -oE 'openUrl:function\(e,t\)\{[^}]*window\.open\(e,t\|\|"_blank"\)\}' main.js
# AppFeature enum strings:
grep -oE 'ExternalLinks="[^"]*"|TargetBlank="[^"]*"' main.js
# link click handler (TargetBlank-gated):
grep -oE 'supports\([a-zA-Z]\.Y\.TargetBlank\)\|\|\(e\.preventDefault\(\),[a-zA-Z]\.A\.openUrl\(t' main.js
# external-links UI gate:
grep -oE '!supports\([a-zA-Z]\.Y\.ExternalLinks\)\)return null' main.js
```

Captured 2026-06-09 against jellyfin-web 10.11.x. The test encodes these
snapshots so it runs offline; the commands above refresh them against a newer
build. Related: `tooling/tv-validate/apphost-supports/results-JEL-46.md`
(feature-flag parity incl. `externallinks`/`targetblank`),
`tooling/tv-validate/fullscreen/results-JEL-65.md` (sibling no-op).

## TV on-device note

This is provable by source + contract without a panel: the body is empty, so
there is no platform-dependent behavior to observe — the no-op is identical on
TV and browser, and the external-link UI is gated off on the TV before any click.
No physical-TV verification is required for JEL-66.
