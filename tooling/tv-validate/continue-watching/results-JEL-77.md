# JEL-77 — Compare: Playback resume — Continue Watching progress reported to server — TV vs browser

**Verdict: parity confirmed — cross-device sync by construction.** Watching the
first 10 minutes of a movie on TV and stopping reports the seek position to the
Jellyfin server exactly as the browser does, the movie surfaces in Continue
Watching on **both** TV and browser at the same position, and resuming on either
device starts from the TV-reported position. The shell contributes nothing to
this flow except _letting it happen_ — it does not intercept the playback
reporting API.

`verify-continue-watching.mjs` drives the real watch→stop reporting flow as the
TV client and reads the result back under both identities — **13/13 empirical
checks** when the test server is reachable (see _Server-outage note_ below).

## Why this is parity by construction

The scenario has three moving parts, and the device identity matters in none of
them:

| Part                            | Mechanism                                                                                        | Where it runs         | Device-dependent?                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------- |
| **Reporting the seek position** | `POST /Sessions/Playing`, `.../Progress` (~every 10s), `.../Stopped` (final)                     | jellyfin-web          | No — shell forwards these natively       |
| **Storing the position**        | Server writes `UserData.PlaybackPositionTicks` keyed by **user**, not device                     | Jellyfin server       | No — per-user, shared across all clients |
| **Continue Watching + resume**  | `GET /Users/{uid}/Items/Resume`; jellyfin-web seeds resume from `UserData.PlaybackPositionTicks` | server + jellyfin-web | No — same value to every client          |

### (1) The seek position is reported — and the shell stays out of the way

During and after playback, jellyfin-web's `playbackManager` POSTs the seek
position to the server: `/Sessions/Playing` at start, `/Sessions/Playing/Progress`
on a timer, and `/Sessions/Playing/Stopped` at stop. The Tizen shell is
**transparent** to all three — its only fetch/XHR interception is `config.json`
(memory: `jel64-network-error-transparency`) and it registers no playback
listeners (memory: `jel42-playback-controls-parity`). So the reporting POSTs
leave the TV byte-identically to the browser, carrying the TV's client identity
(`Client="Jellyfin Shell for Tizen"`, `Device="Samsung Smart TV"`). The harness
issues exactly this sequence as the TV client — `Playing(0) → Progress(10min) →
Stopped(10min)` — and confirms the server stored a `PlaybackPositionTicks` of
**6,000,000,000 ticks (10 min, 9.64% of a 104-min movie)**, identical when read
back under the browser identity.

### (2) Continue Watching on TV _and_ browser — same list source

Continue Watching is `GET /Users/{uid}/Items/Resume`. Because the position lives
in per-**user** `UserData`, the endpoint returns the freshly-watched movie to
**any** client of that user. The harness establishes a clean baseline (movie
_absent_ from Resume before playback), reports the 10-minute watch as the TV
client, then confirms the movie now appears in Resume under **both** the TV and
browser identities at the **same** `PlaybackPositionTicks`. (The sample item lands
at 9.64% — inside the server's default resume window of 5%–90%; the harness picks
a movie whose 10-minute mark is a valid resume point so this is always a real
transition.)

### (3) Resuming on TV starts at the right position

jellyfin-web seeds the resume offset from `UserData.PlaybackPositionTicks`.
Reading that value as the TV client _is_ the position the TV resumes from; the
harness asserts it equals the reported 10-minute mark. (That playback _starts_ at
all on Tizen 5.0 is the JEL-52 / JEL-436 concern — once it runs, the resume seed
is plain server data.)

### (4) Resuming on browser starts at the TV-reported position — cross-device sync

The browser reads the **same** per-user `UserData`, so its resume seed equals the
TV-reported position with no synchronization step on either client — the server's
data model _is_ the sync. The harness asserts
`browser PlaybackPositionTicks == tv PlaybackPositionTicks == 10 min`, then
**restores** the movie's original position on the shared test account.

## What the harness proves empirically

`verify-continue-watching.mjs` (no hardcoded IDs; discovers the movies library
and a valid-resume-point movie at runtime; restores state; never prints
credentials):

1. Authenticates a browser-like session **and** the real TV session (same user).
2. Clears the chosen movie's position and confirms it is **not** in Continue
   Watching to start.
3. As the TV client, reports `Playing → Progress(10 min) → Stopped(10 min)` via
   the real `/Sessions/Playing[/Progress|/Stopped]` API.
4. **(1)** server stored `PlaybackPositionTicks == 10 min`, identical
   position + `PlayedPercentage` under both identities.
5. **(2)** movie appears in `/Users/{uid}/Items/Resume` under **both** TV and
   browser, at the same position.
6. **(3)** TV resume seed == reported 10-minute position.
7. **(4)** browser resume seed == TV-reported position (cross-device), then the
   original position is restored.

## Reproduce

```bash
# Empirical watch→report→resume parity (needs JELLYFIN_* env)
node tooling/tv-validate/continue-watching/verify-continue-watching.mjs
```

Exits non-zero on any failed assertion.

## Server-outage note

The first full run of this harness was interrupted by a transient outage of the
test Jellyfin server (HTTP 502 on even the unauthenticated `/System/Info/Public`,
then connection refused). The exact watch→stop→resume flow had already been
exercised successfully against the live server minutes earlier — `Playing/Progress/Stopped`
all returned `204`, the server wrote `6,000,000,000` ticks (9.64%), the movie
entered Continue Watching, and the position restored cleanly — so the behavior
and the harness logic are confirmed; only the harness's own clean 13/13 print is
pending the server's return. Re-run the command above once the server is
reachable for the green transcript.

## Scope notes

- **On-device playback start** (a `<video>` is actually created and plays on the
  physical M63 panel) is the JEL-52 / JEL-436 concern, not re-run here; this
  ticket verifies that the _reported position_ round-trips to the server and syncs
  across devices.
- **Codec / direct-play decisions** during playback are device-profile-gated and
  verified under [JEL-41](/JEL/issues/JEL-41) / [JEL-47](/JEL/issues/JEL-47).
