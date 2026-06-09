#!/usr/bin/env node
// JEL-52 — Compare: Movie details page — metadata, trailer, and play button —
// TV vs browser.
//
// The Movie details page splits cleanly into two concerns:
//
//   (A) WHAT IS SHOWN — title, year, rating, runtime, genres, synopsis,
//       backdrop/poster, the trailer button, and Resume-vs-Play state. Every
//       one of these is read from the server's BaseItemDto for the item via
//       GET /Users/{uid}/Items/{id}. That endpoint is user-scoped and does NOT
//       vary on the client/device identity — it returns the same Name,
//       ProductionYear, OfficialRating, RunTimeTicks, Genres, Overview,
//       ImageTags, BackdropImageTags, RemoteTrailers/LocalTrailerCount, and
//       per-user UserData (PlaybackPositionTicks) to ANY client of that user.
//       So the details page CONTENT is identical TV vs browser by construction.
//
//   (B) WHETHER THE PLAY/RESUME BUTTON WORKS — this is NOT free on Tizen 5.0.
//       On Chromium <70 (M56/M63), navigating to a detail hash does not fire
//       jellyfin-web's `viewshow` lifecycle event, so the itemDetails
//       controller never runs reload(), `currentItem` stays undefined, and
//       clicking Play throws "item or serverId cannot be null" — no <video> is
//       ever created. The Tizen shell carries a legacy-gated workaround chain
//       (JEL-436) that makes the Play/Resume button reach parity with the
//       browser. That chain is a SOURCE contract, asserted by the companion
//       static guard: packages/shell-tizen/scripts/movie-details.test.cjs.
//
// This harness proves (A) empirically and the playability precondition for (B):
//   1. Fetches the item under TWO faithful client identities — a browser-like
//      session and the real TV session (Client="Jellyfin Shell for Tizen",
//      Device="Samsung Smart TV") — and asserts a byte-identical fingerprint of
//      every field JEL-52 names (title/year/rating/runtime/genres/synopsis,
//      poster+backdrop image tags, trailer fields).
//   2. Resolves the Primary (poster) and Backdrop image URLs over HTTP and
//      asserts 200 + an image content-type under both identities.
//   3. Confirms POST /Items/{id}/PlaybackInfo returns a playable MediaSource +
//      PlaySessionId under both identities — i.e. the Play button always has
//      something to play. (Codec/direct-play DECISIONS differ by device profile
//      and are out of scope here — that is JEL-41 / JEL-47.)
//   4. Seeds a resume position on a movie, asserts the Resume precondition
//      (UserData.PlaybackPositionTicks > 0 with the SAME percentage under both
//      identities), then restores the original UserData position.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/movie-details/verify-movie-details.mjs
// Exits non-zero on any failed assertion. Never prints credentials.

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(
    `${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
}

// Two faithful client identities. The TV identity mirrors the shell's
// NativeShell.AppHost values (see memory: nativeshell-apphost-identity-values).
const IDENTITIES = {
  browser: {
    Client: "Jellyfin Web",
    Device: "Chrome",
    DeviceId: "jel52-browser",
    Version: "10.11.0",
  },
  tv: {
    Client: "Jellyfin Shell for Tizen",
    Device: "Samsung Smart TV",
    DeviceId: "jel52-tv",
    Version: "10.11.0",
  },
};

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(
  id,
  token,
  path,
  { method = "GET", body, raw = false } = {},
) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: {
      Authorization: authHeader(id, token),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw)
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      length:
        Number(res.headers.get("content-length")) ||
        (await res.arrayBuffer()).byteLength,
    };
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
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

// The fields JEL-52 item (1) names, normalized to a device-agnostic shape.
// RunTimeTicks/ProductionYear/OfficialRating/Genres/Overview are the literal
// strings the details header renders; ImageTags.Primary + BackdropImageTags
// identify the SAME poster/backdrop asset (item (2)); RemoteTrailers +
// LocalTrailerCount drive the trailer button (item (5)).
function fingerprint(it) {
  return {
    Id: it.Id,
    Name: it.Name,
    ProductionYear: it.ProductionYear ?? null,
    OfficialRating: it.OfficialRating ?? null,
    RunTimeTicks: it.RunTimeTicks ?? null,
    Genres: (it.Genres || []).slice(),
    OverviewLen: (it.Overview || "").length,
    OverviewHead: (it.Overview || "").slice(0, 64),
    PrimaryImageTag: it.ImageTags?.Primary ?? null,
    BackdropImageTags: (it.BackdropImageTags || []).slice(),
    RemoteTrailerCount: (it.RemoteTrailers || []).length,
    RemoteTrailerUrls: (it.RemoteTrailers || []).map((t) => t.Url).sort(),
    LocalTrailerCount: it.LocalTrailerCount ?? 0,
  };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FIELDS =
  "Overview,Genres,RemoteTrailers,LocalTrailerCount,RunTimeTicks,ProductionYear,OfficialRating,MediaSources";

async function getItem(id, token, uid, itemId) {
  return api(id, token, `/Users/${uid}/Items/${itemId}?Fields=${FIELDS}`);
}

async function main() {
  // --- two independent client sessions, same user ---
  const b = await authAs(IDENTITIES.browser);
  const t = await authAs(IDENTITIES.tv);
  check(
    "authenticate (browser + tv sessions)",
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

  // --- pick the richest movie: one with every JEL-52 field populated, ideally
  //     a trailer too, so all five checks exercise real data. ---
  const list = await api(
    IDENTITIES.browser,
    b.token,
    `/Users/${uid}/Items?ParentId=${movieLib.Id}&IncludeItemTypes=Movie&Recursive=true&Limit=80&Fields=${FIELDS}`,
  );
  const movies = list.json?.Items || [];
  const complete = (m) =>
    m.Overview &&
    m.Genres?.length &&
    m.ProductionYear &&
    m.OfficialRating &&
    m.RunTimeTicks;
  const movie =
    movies.find(
      (m) =>
        complete(m) &&
        ((m.RemoteTrailers?.length || 0) > 0 || (m.LocalTrailerCount || 0) > 0),
    ) ||
    movies.find(complete) ||
    movies[0];
  check(
    "picked a movie with full metadata",
    !!movie && complete(movie),
    movie ? `"${movie.Name}" (${movie.ProductionYear})` : "none",
  );
  if (!movie) process.exit(1);
  const itemId = movie.Id;

  // --- (1)(2)(5) fetch the item under both identities, assert identical
  //     fingerprint of every JEL-52 field. ---
  const ib = (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json;
  const it = (await getItem(IDENTITIES.tv, t.token, uid, itemId)).json;
  const fb = fingerprint(ib),
    ft = fingerprint(it);

  // Field presence (item 1): every header field is non-empty.
  check("(1) title present", !!fb.Name, fb.Name);
  check(
    "(1) year present",
    fb.ProductionYear != null,
    String(fb.ProductionYear),
  );
  check("(1) rating present", !!fb.OfficialRating, fb.OfficialRating);
  check(
    "(1) runtime present",
    fb.RunTimeTicks > 0,
    `${Math.round(fb.RunTimeTicks / 600000000)} min`,
  );
  check("(1) genres present", fb.Genres.length > 0, fb.Genres.join(", "));
  check("(1) synopsis present", fb.OverviewLen > 0, `${fb.OverviewLen} chars`);
  // Images (item 2): both a poster (Primary) and at least one backdrop tag.
  check(
    "(2) poster (Primary) image tag present",
    !!fb.PrimaryImageTag,
    fb.PrimaryImageTag?.slice(0, 8),
  );
  check(
    "(2) backdrop image tag present",
    fb.BackdropImageTags.length > 0,
    `${fb.BackdropImageTags.length} backdrop(s)`,
  );

  // The core parity assertion: identical field-by-field fingerprint.
  const same = eq(fb, ft);
  let why = "all JEL-52 fields identical";
  if (!same) {
    const ka = Object.keys(fb).find(
      (k) => JSON.stringify(fb[k]) !== JSON.stringify(ft[k]),
    );
    why = `first diff at "${ka}": ${JSON.stringify(fb[ka])} vs ${JSON.stringify(ft[ka])}`;
  }
  check(
    "(1)(2)(5) metadata+images+trailer fields identical TV vs browser",
    same,
    why,
  );

  // --- (2) backdrop/poster images actually LOAD (200 + image content-type)
  //     under both identities. Image routes are token-authed but device-
  //     agnostic; resolving them on both proves the artwork renders. ---
  for (const [label, id, token] of [
    ["browser", IDENTITIES.browser, b.token],
    ["tv", IDENTITIES.tv, t.token],
  ]) {
    const poster = await api(
      id,
      token,
      `/Items/${itemId}/Images/Primary?tag=${fb.PrimaryImageTag}&maxWidth=400`,
      { raw: true },
    );
    check(
      `(2) [${label}] poster image loads`,
      poster.status === 200 && /^image\//.test(poster.contentType || ""),
      `${poster.status} ${poster.contentType} ${poster.length}B`,
    );
    if (fb.BackdropImageTags.length) {
      const back = await api(
        id,
        token,
        `/Items/${itemId}/Images/Backdrop/0?tag=${fb.BackdropImageTags[0]}&maxWidth=1280`,
        { raw: true },
      );
      check(
        `(2) [${label}] backdrop image loads`,
        back.status === 200 && /^image\//.test(back.contentType || ""),
        `${back.status} ${back.contentType} ${back.length}B`,
      );
    }
  }

  // --- (3) Play button precondition: PlaybackInfo returns a playable
  //     MediaSource + PlaySessionId under both identities. (Codec/direct-play
  //     decisions are device-profile-gated — out of scope; see JEL-41/JEL-47.) ---
  for (const [label, id, token] of [
    ["browser", IDENTITIES.browser, b.token],
    ["tv", IDENTITIES.tv, t.token],
  ]) {
    const pi = await api(
      id,
      token,
      `/Items/${itemId}/PlaybackInfo?UserId=${uid}`,
      {
        method: "POST",
        body: {
          UserId: uid,
          MaxStreamingBitrate: 120000000,
          DeviceProfile: {},
        },
      },
    );
    const sources = pi.json?.MediaSources || [];
    check(
      `(3) [${label}] Play button has a playable source`,
      pi.status === 200 && sources.length > 0 && !!pi.json?.PlaySessionId,
      `status ${pi.status}, ${sources.length} source(s), playSessionId=${!!pi.json?.PlaySessionId}`,
    );
  }

  // --- (4) Resume button: seed a playback position, assert the Resume
  //     precondition (PlaybackPositionTicks > 0, identical % both identities),
  //     then RESTORE the original position. ---
  const before = (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json;
  const origTicks = before.UserData?.PlaybackPositionTicks ?? 0;
  const seedTicks = 5 * 60 * 10_000_000; // 5 minutes, well above the server's resume threshold
  const seed = await api(
    IDENTITIES.browser,
    b.token,
    `/UserItems/${itemId}/UserData`,
    { method: "POST", body: { PlaybackPositionTicks: seedTicks } },
  );
  check(
    "(4) seeded a resume position",
    seed.status === 200,
    `set ${seedTicks} ticks (5 min)`,
  );

  const rb = (await getItem(IDENTITIES.browser, b.token, uid, itemId)).json
    ?.UserData;
  const rt = (await getItem(IDENTITIES.tv, t.token, uid, itemId)).json
    ?.UserData;
  check(
    "(4) Resume precondition: PlaybackPositionTicks > 0",
    (rb?.PlaybackPositionTicks || 0) > 0,
    `${rb?.PlaybackPositionTicks} ticks`,
  );
  check(
    "(4) Resume position + percentage identical TV vs browser",
    rb?.PlaybackPositionTicks === rt?.PlaybackPositionTicks &&
      rb?.PlayedPercentage === rt?.PlayedPercentage,
    `browser ${rb?.PlayedPercentage?.toFixed?.(2)}% / tv ${rt?.PlayedPercentage?.toFixed?.(2)}%`,
  );

  // restore original position on the shared test account
  await api(IDENTITIES.browser, b.token, `/UserItems/${itemId}/UserData`, {
    method: "POST",
    body: { PlaybackPositionTicks: origTicks },
  });
  const restored = (await getItem(IDENTITIES.browser, b.token, uid, itemId))
    .json?.UserData?.PlaybackPositionTicks;
  check(
    "(4) original resume position restored",
    restored === origTicks,
    `back to ${origTicks} ticks`,
  );

  // --- (5) trailer button: at least one trailer source exists, and the
  //     RemoteTrailers list is identical (already covered by the fingerprint;
  //     this surfaces it explicitly). ---
  const hasTrailer = fb.RemoteTrailerCount > 0 || fb.LocalTrailerCount > 0;
  check(
    "(5) trailer source present (button is shown for this item)",
    hasTrailer,
    `remote=${fb.RemoteTrailerCount} local=${fb.LocalTrailerCount}`,
  );
  check(
    "(5) trailer source list identical TV vs browser",
    eq(fb.RemoteTrailerUrls, ft.RemoteTrailerUrls) &&
      fb.LocalTrailerCount === ft.LocalTrailerCount,
    `${fb.RemoteTrailerCount} remote trailer url(s) match`,
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
