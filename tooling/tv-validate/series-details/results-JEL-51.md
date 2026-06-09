# JEL-51 — Compare: Series details page — seasons and episodes list (M63 iterate fix)

**Verdict: confirmed working and identical to browser — the page that previously
wedged the M63 TV now renders cleanly. 44/44 checks pass.**

This is THE details page that historically wedged the physical M63 Samsung TV
with `Invalid attempt to iterate non-iterable instance` (JEL-19 / JEL-21). The
wedge was never a content bug — it was **server-injected plugin scripts running
raw on Chromium 63** because the shell's fast-path transpile gate skipped them,
producing `Unexpected token`/SyntaxErrors with the iterate-non-iterable as a
downstream symptom. That was root-caused in **JEL-23** (fix build `dedab53`),
which was **pixel-verified on the physical `QN82Q60RAFXZA` TV: 0 iterate errors,
full home + details render**. JEL-20 added the `__ensureBabel` transpile gate.

JEL-51 re-verifies that page along two independent dimensions. Harness:
`verify-series-details.mjs` (read-only against the live server; mutates nothing;
never prints credentials).

```
node tooling/tv-validate/series-details/verify-series-details.mjs   # 44/44 PASS
```

## Part A — Content parity (what the user sees): season selector + episodes

The series header, the season selector, and the per-season episode lists are
**100% jellyfin-web + server driven**. A `grep` of `shell.js` / `boot-shell.src.js`
finds **zero** references to Seasons / Episodes / season-selector / episode-card
building — the shell implements no details code path. The data comes from
user-scoped endpoints that take **no `DeviceProfile`** and are **not keyed on
client/device**:

| Details element           | Server endpoint                                          | Device-dependent? |
| ------------------------- | -------------------------------------------------------- | ----------------- |
| Series header metadata    | `GET /Users/{uid}/Items/{seriesId}`                      | No                |
| Season selector list      | `GET /Shows/{seriesId}/Seasons?UserId={uid}`             | No                |
| Episode list (per season) | `GET /Shows/{seriesId}/Episodes?SeasonId=…&UserId={uid}` | No                |

The harness fetches all three under a **browser-like** identity and the **real TV
identity** (`Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV"`) and
asserts byte-identical fingerprints. Verified against **South Park** (the deepest
multi-season series on the test server):

- **(2) Season selector** — 28 seasons, list **and order** byte-identical TV vs browser.
- **(3) Episodes list** — every one of the 28 seasons enumerated; **338 episodes
  total, identical** (count, order, SxE numbering) on both identities.
- **(4) Thumbnails + metadata** — per episode the fingerprint covers the Primary
  thumbnail tag, name, runtime, premiere date, and overview-presence — all
  identical; and a real episode thumbnail asset resolves `200 image/jpeg` under
  **both** identities. Series header (genres, year, rating, cast, image tags)
  identical.

Because none of these endpoints vary on device and the shell adds no code on this
path, TV == browser **by construction**; the harness confirms it empirically.

## Part B — M63 iterate-fix regression guard (JEL-51 check 1)

**(B1) Source guards** — assert `boot-shell.src.js` still carries the four fixes
that, if reverted, re-wedge the details page:

| Guard                                                                                                          | Fix                 | Why it matters                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `MODERN_SYNTAX_RE` detects `catch{`                                                                            | JEL-23 #1           | else JavaScriptInjector (uses optional-catch) is mis-classed ES5, inlined raw → SyntaxError     |
| `babelTranspile` passes `iterableIsArray` + `arrayLikeIsIterable`                                              | belt-and-suspenders | any lowered for-of/spread emits indexed access, never the throwing `_createForOfIteratorHelper` |
| transpile gated on `__ensureBabel`                                                                             | JEL-20              | babel guaranteed loaded before transform — a modern plugin is never `document.write`'d raw      |
| legacy scan enumerates all scripts (not gated on stale `babelNeeded`); `markBabelNeeded` persists at detection | JEL-23 #2/#3        | breaks the chicken-and-egg that let the warm cache skip the slow path                           |

**(B2) Functional** — the harness loads the **exact babel bundle that ships in the
WGT** (`babel.min.js`, 7.29.0) and runs the **6 plugin scripts the server injects
into `/web/index.html`** (the scripts that execute on every route, including
details) through the **production transpile config**. Result: **4 of 6 need
transpile, 0 leave M63-fatal syntax (`?.` `??` `??=` `||=` `&&=` optional-catch),
0 emit the throwing iterator helper.** This is the literal mechanism that stopped
the wedge — raw plugins → SyntaxError is now transpiled-clean → details page
survives. (The jellyfin-web client bundle under `/web/*` is excluded: it is
webpack-built ES5 proven M63-safe by the app booting — the wedge was
plugin-specific.)

## On-device status

The fix itself was already **pixel-verified on the physical M63 TV** in JEL-23
(`dedab53`): the details route survives to full render with 0 `iterate
non-iterable` / 0 `setter transpile failed`, self-healing after one boot. JEL-51
adds the durable, re-runnable regression guard (44 checks) so a future change that
re-breaks the transpile path — or a server that changes a plugin's syntax — is
caught off-device before it can re-wedge the TV. No new on-device run is required
to close JEL-51; the guard is the standing protection.

## Bottom line

The series details page renders **identically to the browser** (seasons,
episodes, thumbnails, metadata — 338 episodes across 28 seasons byte-identical),
and the M63 `iterate non-iterable` failure mode is both **fixed on-device
(JEL-23)** and **guarded against regression** here. JEL-51 done.
