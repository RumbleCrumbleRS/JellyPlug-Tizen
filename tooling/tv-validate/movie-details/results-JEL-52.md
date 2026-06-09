# JEL-52 — Compare: Movie details page — metadata, trailer, and play button — TV vs browser

**Verdict: parity confirmed.** The details page _content_ is identical TV vs
browser by construction, and the one thing that is _not_ free on Tizen 5.0 — the
Play/Resume button actually starting playback — is held at parity by a
legacy-gated shell workaround (JEL-436) that is pinned to source by a contract
guard. **24/24 empirical checks** + **14/14 source-contract checks** pass.

The details page splits into two concerns, verified separately:

| Concern                       | JEL-52 items                                                   | How parity is guaranteed                                | Evidence                           |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| **What is shown**             | (1) metadata, (2) images, (5) trailer button, (4) Resume state | Server-driven `BaseItemDto`; no device/client branching | `verify-movie-details.mjs` — 24/24 |
| **Whether Play/Resume works** | (3) Play starts playback, (4) Resume                           | Shell JEL-436 chain, Chromium-<70 gated                 | `movie-details.test.cjs` — 14/14   |

## (A) Page content is server-driven — identical by construction

Everything the details header renders comes from a single user-scoped call,
`GET /Users/{uid}/Items/{id}`, which does **not** vary on the client/device
identity. The harness fetches the same movie under two faithful client
identities — a browser session (`Client="Jellyfin Web"`) and the real TV session
(`Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV"`) — and asserts a
**byte-identical fingerprint** of every field JEL-52 names:

- **(1) metadata** — `Name`, `ProductionYear`, `OfficialRating`, `RunTimeTicks`,
  `Genres`, `Overview`. Present and identical (e.g. _"3 Men and a Little Lady"_,
  1990, PG, 104 min, Family/Comedy, 245-char synopsis).
- **(2) images** — `ImageTags.Primary` (poster) and `BackdropImageTags` are the
  same asset tags on both, and the harness resolves the actual poster + backdrop
  URLs over HTTP under both identities: **200 `image/jpeg`**, identical byte
  length (154,900 B poster / 341,849 B backdrop).
- **(5) trailer** — `RemoteTrailers` (2 URLs for the sample item) +
  `LocalTrailerCount` are identical, so the trailer button is shown with the
  same source list on both. (45 of 58 movies on the test library carry a
  trailer.)
- **(4) Resume state** — `UserData.PlaybackPositionTicks` is per-**user**, not
  per-device. The harness seeds a 5-min resume position, confirms the Resume
  precondition (`PlaybackPositionTicks > 0`) reports the **same percentage**
  (4.82%) to both identities, then restores the original position.

**(3) Play button** — `POST /Items/{id}/PlaybackInfo` returns a playable
`MediaSource` + `PlaySessionId` under both identities, so the button always has
something to play. (Codec / direct-play _decisions_ differ by device profile —
that is intentional and out of scope here; see
[JEL-41](/JEL/issues/JEL-41) / [JEL-47](/JEL/issues/JEL-47).)

## (B) The Play/Resume button working on TV is **not** free — JEL-436

On Tizen 5.0 (Chromium 56) and other Chromium **<70** WebViews, navigating to a
detail-page hash does **not** fire jellyfin-web's `viewshow` lifecycle event. The
itemDetails controller never runs `reload()`, `currentItem` stays `undefined`,
and clicking **Play** invokes `playbackManager` with an item lacking `ServerId` →
`ConnectionManager.getApiClient` throws _"item or serverId cannot be null"_ →
**no `<video>` is ever created**. Confirmed on QN82Q60RAFXZA via the QA HUD.

The shell closes that gap with a legacy-gated chain that brings the TV
Play/Resume button to parity with the browser (`shell.js`):

1. **viewshow synth** — on `hashchange`/`popstate`, dispatch a synthetic
   `viewshow` `CustomEvent` on the active page so `itemDetails.reload()` runs and
   `currentItem` populates.
2. **getApiClient fallback** — wrap `connectionManager.getApiClient` so a
   `null`/`ServerId`-less item resolves to the authenticated `window.ApiClient`
   instead of throwing.
3. **play hardening** — wrap `playbackManager.play` to inject `ServerId` and
   derive `MediaType` from `Type` (`Movie`/`Trailer` → `"Video"`) so
   `getPlayer()` resolves a real video player.

The entire chain is gated behind `parseInt(chromiumMajor) < 70` with an early
`if (!legacy) return;` — a modern browser fires `viewshow` natively and skips it
entirely. That gate is the formal statement of _"the TV needs the fix, the
browser does not"_: same shell, same details page, parity reached on both.

`movie-details.test.cjs` pins all three links — plus the legacy gate and the
`btnPlay`/`btnReplay` (Play **and** Resume) handling — to `shell.js` **and** to
the deployed release artifact `shell.min.js` (the blob that actually boots on the
TV). If a build drops any link, the TV Play button silently regresses to the
JEL-436 failure and this guard fails first.

## Reproduce

```bash
# (A) empirical server-data + image + resume parity (needs JELLYFIN_* env)
node tooling/tv-validate/movie-details/verify-movie-details.mjs

# (B) shell-side detail-page Play/Resume contract (no network)
node packages/shell-tizen/scripts/movie-details.test.cjs
#   or: pnpm --filter @jellyfin-tv/shell-tizen test
```

The empirical harness discovers the movies library and picks the richest movie
at runtime (no hardcoded IDs), seeds then **restores** the resume position, and
never prints credentials. Exits non-zero on any failed assertion.

## Scope notes

- **On-device button render/click** (HUD-level confirmation that Play wires up
  and a `<video>` is created on the physical M63 panel) is covered by the
  JEL-436 work and the QA HUD instrumentation in `shell.js`, not re-run here;
  this ticket verifies the data parity + that the repair chain is present and
  correctly gated in the shipped artifact.
- **Playback codec/direct-play decisions** are device-profile-gated and verified
  under [JEL-41](/JEL/issues/JEL-41) / [JEL-47](/JEL/issues/JEL-47).
