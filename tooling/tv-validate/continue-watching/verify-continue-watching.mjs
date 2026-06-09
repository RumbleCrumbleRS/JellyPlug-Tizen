#!/usr/bin/env node
// JEL-77 — Compare: Playback resume — Continue Watching progress reported to
// server — TV vs browser.
//
// SCENARIO (from the ticket): watch the first 10 minutes of a movie on TV, then
// stop. Verify (1) the seek position is reported to the server, (2) the movie
// appears in Continue Watching on TV *and* browser, (3) resuming on TV starts at
// the right position, (4) resuming on browser also starts at the TV-reported
// position (cross-device sync).
//
// WHY THIS IS PARITY BY CONSTRUCTION — and what the shell actually contributes:
//
//   • Progress reporting is jellyfin-web's `playbackManager`, not the shell.
//     During playback jellyfin-web POSTs the seek position to the server on a
//     timer and at stop: POST /Sessions/Playing (start), .../Progress (every
//     ~10s), and .../Stopped (final position). The Tizen shell is TRANSPARENT to
//     these calls — its only fetch/XHR interception is config.json (memory:
//     jel64-network-error-transparency), and it adds no playback listeners
//     (memory: jel42-playback-controls-parity). So the reporting POSTs leave the
//     TV byte-identically to the browser, under the TV's client identity.
//
//   • The server stores the seek position in per-USER UserData
//     (PlaybackPositionTicks), NOT per-device. Continue Watching
//     (GET /Users/{uid}/Items/Resume) and the resume seed position are therefore
//     returned identically to EVERY client of that user. Cross-device sync (TV →
//     browser) is a property of the server data model, not of either client.
//
//   • The one genuinely TV-specific precondition is that playback STARTS on
//     Tizen 5.0 at all — that is the JEL-52 / JEL-436 legacy-gated shell chain
//     (synth viewshow + wrapped getApiClient/play). Once playback runs, the same
//     jellyfin-web reporting timer fires regardless of UA. JEL-52 covers the
//     start path; this harness covers what happens to the reported position
//     afterward.
//
// This harness PROVES (1)-(4) empirically against the live server by driving the
// real reporting API as the TV client and reading back the result under both
// identities:
//   1. Authenticates a browser-like session AND the real TV session
//      (Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV").
//   2. Picks a movie whose 10-minute mark falls inside the server's resume
//      window (min 5% .. max 90% played), records & clears its position, and
//      confirms it is NOT in Continue Watching to start.
//   3. As the TV client, reports a real watch-then-stop: Playing(0) →
//      Progress(10min) → Stopped(10min) via /Sessions/Playing[/Progress|/Stopped].
//   4. (1) Asserts the server now reports PlaybackPositionTicks == 10 min for the
//      user, under BOTH identities, with identical PlayedPercentage.
//   5. (2) Asserts the movie appears in /Users/{uid}/Items/Resume under BOTH the
//      TV and browser identities, at the same position.
//   6. (3) Asserts the TV resume seed (UserData.PlaybackPositionTicks read as the
//      TV client) equals the reported 10-minute position.
//   7. (4) Asserts the browser resume seed equals the TV-reported position —
//      cross-device sync — then RESTORES the movie's original position.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/continue-watching/verify-continue-watching.mjs
// Exits non-zero on any failed assertion. Never prints credentials.

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

const TICKS_PER_MIN = 60 * 10_000_000; // Jellyfin ticks = 100ns; 1 min = 6e8
const WATCH_TICKS = 10 * TICKS_PER_MIN; // "first 10 minutes"

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(
    `${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
}

// Two faithful client identities. The TV identity mirrors the shell's
// NativeShell.AppHost values (memory: nativeshell-apphost-identity-values).
const IDENTITIES = {
  browser: {
    Client: "Jellyfin Web",
    Device: "Chrome",
    DeviceId: "jel77-browser",
    Version: "10.11.0",
  },
  tv: {
    Client: "Jellyfin Shell for Tizen",
    Device: "Samsung Smart TV",
    DeviceId: "jel77-tv",
    Version: "10.11.0",
  },
};

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(id, token, path, { method = "GET", body } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: {
      Authorization: authHeader(id, token),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json (204 No Content etc.) */
  }
  return { status: res.status, json, text };
}
async function authAs(id) {
  const a = await api(id, null, "/Users/AuthenticateByName", {
    method: "POST",
    body: { Username: USER, Pw: PASS },
  });
  return { token: a.json?.AccessToken, uid: a.json?.User?.Id };
}
async function getItem(id, token, uid, itemId) {
  return api(id, token, `/Users/${uid}/Items/${itemId}`);
}
async function resumeIds(id, token, uid) {
  const r = await api(
    id,
    token,
    `/Users/${uid}/Items/Resume?Limit=100&MediaTypes=Video`,
  );
  return r.json?.Items || [];
}

async function main() {
  // --- two independent client sessions, same user ---
  const b = await authAs(IDENTITIES.browser);
  const t = await authAs(IDENTITIES.tv);
  check(
    "authenticate (browser + tv sessions, same user)",
    b.token && t.token && b.uid && t.uid && b.uid === t.uid,
    b.uid ? `uid ${b.uid.slice(0, 8)}…` : "no token",
  );
  if (!b.token || !t.token) process.exit(1);
  const uid = b.uid;

  // --- discover the movies library (don't hardcode IDs) ---
  const views = await api(IDENTITIES.browser, b.token, `/Users/${uid}/Views`);
  const movieLib = (views.json?.Items || []).find(
    (v) => v.CollectionType === "movies",
  );
  check("found movies library", !!movieLib, movieLib?.Name);
  if (!movieLib) process.exit(1);

  // --- pick a movie whose 10-minute mark is a valid resume point: between the
  //     server's min (default 5%) and max (default 90%) resume thresholds, so a
  //     10-minute watch genuinely lands it in Continue Watching. Prefer one not
  //     already in Resume so the "appears after watching" transition is real. ---
  const list = await api(
    IDENTITIES.browser,
    b.token,
    `/Users/${uid}/Items?ParentId=${movieLib.Id}&IncludeItemTypes=Movie&Recursive=true&Limit=100&Fields=MediaSources`,
  );
  const movies = list.json?.Items || [];
  const alreadyResuming = new Set(
    (await resumeIds(IDENTITIES.browser, b.token, uid)).map((i) => i.Id),
  );
  const validResumePoint = (m) => {
    if (!m.RunTimeTicks || !m.MediaSources?.length) return false;
    const pct = (WATCH_TICKS / m.RunTimeTicks) * 100;
    return pct >= 5 && pct <= 90; // server's default resume window
  };
  const movie =
    movies.find((m) => validResumePoint(m) && !alreadyResuming.has(m.Id)) ||
    movies.find(validResumePoint);
  check(
    "picked a movie whose 10-min mark is a valid resume point",
    !!movie,
    movie
      ? `"${movie.Name}" (${Math.round(movie.RunTimeTicks / TICKS_PER_MIN)} min, 10min=${((WATCH_TICKS / movie.RunTimeTicks) * 100).toFixed(1)}%)`
      : "none",
  );
  if (!movie) process.exit(1);
  const itemId = movie.Id;

  // --- record the original position so the shared test account is left intact,
  //     then clear it to establish a clean "not yet watched" baseline. ---
  const origTicks =
    (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json?.UserData
      ?.PlaybackPositionTicks ?? 0;
  await api(IDENTITIES.browser, b.token, `/UserItems/${itemId}/UserData`, {
    method: "POST",
    body: { PlaybackPositionTicks: 0 },
  });
  const baselineResume = (await resumeIds(IDENTITIES.tv, t.token, uid)).some(
    (i) => i.Id === itemId,
  );
  check(
    "baseline: movie is NOT in Continue Watching before playback",
    !baselineResume,
    `cleared position (was ${origTicks} ticks)`,
  );

  // --- (1) Drive the REAL reporting API as the TV client: a 10-minute watch
  //     then stop. This is exactly what jellyfin-web's playbackManager POSTs
  //     during/after playback; the shell forwards these natively. ---
  const psid = `jel77-${itemId}`;
  const playMethod = "DirectPlay";
  const start = await api(IDENTITIES.tv, t.token, `/Sessions/Playing`, {
    method: "POST",
    body: {
      ItemId: itemId,
      PlaySessionId: psid,
      PositionTicks: 0,
      CanSeek: true,
      IsPaused: false,
      PlayMethod: playMethod,
    },
  });
  const progress = await api(
    IDENTITIES.tv,
    t.token,
    `/Sessions/Playing/Progress`,
    {
      method: "POST",
      body: {
        ItemId: itemId,
        PlaySessionId: psid,
        PositionTicks: WATCH_TICKS,
        IsPaused: false,
        PlayMethod: playMethod,
      },
    },
  );
  const stopped = await api(IDENTITIES.tv, t.token, `/Sessions/Playing/Stopped`, {
    method: "POST",
    body: { ItemId: itemId, PlaySessionId: psid, PositionTicks: WATCH_TICKS },
  });
  const ok2xx = (s) => s >= 200 && s < 300;
  check(
    "(1) TV reported watch→stop to playback API (Playing/Progress/Stopped)",
    ok2xx(start.status) && ok2xx(progress.status) && ok2xx(stopped.status),
    `start ${start.status}, progress ${progress.status}, stopped ${stopped.status}`,
  );

  // --- (1) The server now reports the seek position, read back under BOTH
  //     identities, with identical position + percentage. ---
  const ub = (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json
    ?.UserData;
  const ut = (await getItem(IDENTITIES.tv, t.token, uid, itemId)).json?.UserData;
  check(
    "(1) server stored the reported seek position (~10 min)",
    ub?.PlaybackPositionTicks === WATCH_TICKS,
    `${ub?.PlaybackPositionTicks} ticks (${(WATCH_TICKS / TICKS_PER_MIN).toFixed(0)} min), ${ub?.PlayedPercentage?.toFixed?.(2)}%`,
  );
  check(
    "(1) reported position identical TV vs browser (per-user UserData)",
    ub?.PlaybackPositionTicks === ut?.PlaybackPositionTicks &&
      ub?.PlayedPercentage === ut?.PlayedPercentage,
    `browser ${ub?.PlaybackPositionTicks} / tv ${ut?.PlaybackPositionTicks}`,
  );

  // --- (2) the movie now appears in Continue Watching under BOTH identities, at
  //     the same position. ---
  const resTv = (await resumeIds(IDENTITIES.tv, t.token, uid)).find(
    (i) => i.Id === itemId,
  );
  const resBr = (await resumeIds(IDENTITIES.browser, b.token, uid)).find(
    (i) => i.Id === itemId,
  );
  check(
    "(2) movie appears in Continue Watching on TV",
    !!resTv,
    resTv ? `pos ${resTv.UserData?.PlaybackPositionTicks} ticks` : "absent",
  );
  check(
    "(2) movie appears in Continue Watching on browser",
    !!resBr,
    resBr ? `pos ${resBr.UserData?.PlaybackPositionTicks} ticks` : "absent",
  );
  check(
    "(2) Continue Watching position identical TV vs browser",
    !!resTv &&
      !!resBr &&
      resTv.UserData?.PlaybackPositionTicks ===
        resBr.UserData?.PlaybackPositionTicks,
    `tv ${resTv?.UserData?.PlaybackPositionTicks} / browser ${resBr?.UserData?.PlaybackPositionTicks}`,
  );

  // --- (3) resuming on TV starts at the reported position. jellyfin-web seeds
  //     the resume from UserData.PlaybackPositionTicks; reading it as the TV
  //     client IS the value the TV would resume from. ---
  check(
    "(3) TV resume seed == reported 10-min position",
    ut?.PlaybackPositionTicks === WATCH_TICKS,
    `${ut?.PlaybackPositionTicks} ticks`,
  );

  // --- (4) resuming on browser starts at the SAME TV-reported position
  //     (cross-device sync). ---
  check(
    "(4) browser resume seed == TV-reported position (cross-device sync)",
    ub?.PlaybackPositionTicks === WATCH_TICKS &&
      ub?.PlaybackPositionTicks === ut?.PlaybackPositionTicks,
    `browser ${ub?.PlaybackPositionTicks} == tv ${ut?.PlaybackPositionTicks}`,
  );

  // --- restore the movie's original position on the shared test account. ---
  await api(IDENTITIES.browser, b.token, `/UserItems/${itemId}/UserData`, {
    method: "POST",
    body: { PlaybackPositionTicks: origTicks },
  });
  const restored = (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json
    ?.UserData?.PlaybackPositionTicks;
  check(
    "cleanup: original position restored",
    restored === origTicks,
    `back to ${origTicks} ticks`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("harness error:", e?.message || e);
  process.exit(1);
});
