#!/usr/bin/env node
// JEL-49 — Compare: Home screen rows (Continue Watching, Next Up, Latest Movies,
// Latest TV) — TV vs browser.
//
// The Home screen rows are 100% jellyfin-web/server-driven. The Tizen shell
// does NOT implement, wrap, or customize any home-row code path:
//   - `grep` of shell.js / boot-shell.src.js / shell-core finds ZERO references
//     to Resume / NextUp / Items/Latest / homeSection / card image building.
//   - The rows are populated by user-scoped server endpoints that take NO
//     DeviceProfile and are NOT keyed on client/device:
//       Continue Watching -> GET /Users/{uid}/Items/Resume
//       Next Up           -> GET /Shows/NextUp?UserId={uid}
//       Latest <library>  -> GET /Users/{uid}/Items/Latest?ParentId={libId}
//     So the server returns identical items/counts/thumbnails/progress to any
//     client of the same user — TV behavior equals browser by construction.
//   - The shell's ONLY Home-related behavior is the JEL-1580 body-focus-rescue
//     + proactive auto-focuser (validated under JEL-33): it makes the FIRST
//     D-pad press land on a focusable card on TV (where post-login focus is
//     stuck on <body>), bringing TV D-pad nav to parity with the browser. It
//     does not change WHICH items/rows render — only that the focus ring
//     appears. Horizontal (within-row) and vertical (between-row) D-pad
//     navigation is jellyfin-web's focusManager, identical on both.
//
// This harness proves the row CONTENT is identical by fetching every row under
// two distinct client identities — a browser-like session and a TV-like session
// (the real NativeShell AppHost identity: Client="Jellyfin Shell for Tizen",
// Device="Samsung Smart TV") — and asserting byte-identical fingerprints:
// item IDs + order (count), ImageTags (thumbnails), and UserData progress
// (PlayedPercentage / PlaybackPositionTicks). To make the Next Up row non-empty
// on the shared test account it temporarily marks one episode played, then
// restores it.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/home-rows/verify-home-rows.mjs
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
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Two faithful client identities. The TV identity mirrors the shell's
// NativeShell.AppHost values (see memory: nativeshell-apphost-identity-values).
const IDENTITIES = {
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel49-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel49-tv", Version: "10.11.0" },
};

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(id, token, path, { method = "GET", body } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(id, token), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// Normalized, device-agnostic fingerprint of a row's items. Captures exactly
// what JEL-49 asks to compare: identity+order (count), thumbnails (ImageTags),
// progress indicators (UserData). Card pixel dimensions are deliberately NOT
// here: the home card requests an image width sized to the layout (TV cards are
// larger), but the SOURCE image — Id + ImageTag — is identical, so the same
// artwork renders, just scaled. Comparing ImageTags proves the thumbnail is the
// same asset on both.
function fingerprint(items) {
  return (items || []).map((i) => ({
    Id: i.Id,
    Type: i.Type,
    SxE: i.ParentIndexNumber != null ? `S${i.ParentIndexNumber}E${i.IndexNumber}` : undefined,
    imageTags: Object.keys(i.ImageTags || {}).sort().join(","),
    hasParentThumb: !!i.ParentThumbImageTag || !!i.SeriesThumbImageTag,
    pct: i.UserData?.PlayedPercentage ?? null,
    ticks: i.UserData?.PlaybackPositionTicks ?? null,
    played: i.UserData?.Played ?? null,
  }));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function getRows(id, token, uid, libs) {
  const fields = "PrimaryImageAspectRatio,BasicSyncInfo";
  const resume = await api(id, token, `/Users/${uid}/Items/Resume?Limit=12&Recursive=true&MediaTypes=Video&Fields=${fields}&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
  const nextUp = await api(id, token, `/Shows/NextUp?UserId=${uid}&Limit=24&Fields=${fields}&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Banner,Thumb`);
  const latestMovies = await api(id, token, `/Users/${uid}/Items/Latest?IncludeItemTypes=Movie&ParentId=${libs.movies}&Limit=16&Fields=${fields}&ImageTypeLimit=1&EnableImageTypes=Primary,Thumb`);
  const latestTv = await api(id, token, `/Users/${uid}/Items/Latest?IncludeItemTypes=Episode&ParentId=${libs.tv}&Limit=16&GroupItems=false&Fields=${fields}&ImageTypeLimit=1&EnableImageTypes=Primary,Thumb`);
  return {
    "Continue Watching": resume.json?.Items || [],
    "Next Up": nextUp.json || [], // NextUp returns {Items}
    "Latest Movies": latestMovies.json || [],
    "Latest TV": latestTv.json || [],
  };
}
// NextUp returns {Items:[...]}, the Latest endpoint returns a bare array.
function rowItems(rows, key) {
  const v = rows[key];
  return Array.isArray(v) ? v : v.Items || [];
}

async function authAs(id) {
  const a = await api(id, null, "/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  return { token: a.json?.AccessToken, uid: a.json?.User?.Id };
}
async function setPlayed(id, token, uid, itemId, played) {
  return api(id, token, `/Users/${uid}/PlayedItems/${itemId}`, { method: played ? "POST" : "DELETE" });
}

async function main() {
  // --- two independent client sessions, same user ---
  const b = await authAs(IDENTITIES.browser);
  const t = await authAs(IDENTITIES.tv);
  check("authenticate (browser + tv sessions)", b.token && t.token && b.uid && t.uid && b.uid === t.uid,
    b.uid ? `uid ${b.uid.slice(0, 8)}…` : "no token");
  if (!b.token || !t.token) process.exit(1);
  const uid = b.uid;

  // --- discover libraries (don't hardcode IDs) ---
  const views = await api(IDENTITIES.browser, b.token, `/Users/${uid}/Views`);
  const vitems = views.json?.Items || [];
  const movieLib = vitems.find((v) => v.CollectionType === "movies");
  const tvLib = vitems.find((v) => v.CollectionType === "tvshows");
  check("found movies + tvshows libraries", !!movieLib && !!tvLib,
    `${movieLib?.Name} / ${tvLib?.Name}`);
  if (!movieLib || !tvLib) process.exit(1);
  const libs = { movies: movieLib.Id, tv: tvLib.Id };

  // --- seed Next Up so the row is non-empty (mark first episode of a series
  //     played -> the next episode surfaces). Restored at the end. ---
  let seeded = null;
  const series = await api(IDENTITIES.browser, b.token, `/Items?UserId=${uid}&ParentId=${libs.tv}&IncludeItemTypes=Series&Recursive=true&Limit=8`);
  for (const s of series.json?.Items || []) {
    const eps = await api(IDENTITIES.browser, b.token, `/Shows/${s.Id}/Episodes?UserId=${uid}&Fields=UserData&Limit=4`);
    const list = (eps.json?.Items || []).filter((e) => e.IndexNumber != null);
    const firstUnplayed = list.find((e) => !e.UserData?.Played);
    if (firstUnplayed && list.length >= 2) {
      await setPlayed(IDENTITIES.browser, b.token, uid, firstUnplayed.Id, true);
      seeded = { series: s.Name, epId: firstUnplayed.Id };
      break;
    }
  }
  check("seeded Next Up", !!seeded, seeded ? `marked "${seeded.series}" first episode played` : "no seedable series");

  // --- fetch all four rows under both identities ---
  const rowsB = await getRows(IDENTITIES.browser, b.token, uid, libs);
  const rowsT = await getRows(IDENTITIES.tv, t.token, uid, libs);

  const ROWS = ["Continue Watching", "Next Up", "Latest Movies", "Latest TV"];
  let nonEmpty = 0;
  for (const row of ROWS) {
    const ib = rowItems(rowsB, row), it = rowItems(rowsT, row);
    const fb = fingerprint(ib), ft = fingerprint(it);
    nonEmpty += ib.length > 0 ? 1 : 0;
    // (a) identical item count
    check(`[${row}] item count matches`, ib.length === it.length, `browser=${ib.length} tv=${it.length}`);
    // (b) identical items, order, thumbnails, progress (full fingerprint)
    const same = eq(fb, ft);
    let why = `${ib.length} items identical`;
    if (!same) {
      const diffIdx = fb.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(ft[i]));
      why = `first diff at index ${diffIdx}: ${JSON.stringify(fb[diffIdx])} vs ${JSON.stringify(ft[diffIdx])}`;
    }
    check(`[${row}] items+thumbnails+progress identical`, same, why);
  }
  check("all four rows exercised, ≥3 non-empty", nonEmpty >= 3, `${nonEmpty}/4 rows populated`);

  // --- progress-indicator spot check on Continue Watching (the only row with
  //     progress bars): every item has a real PlaybackPositionTicks > 0 and the
  //     two identities report the same percentage. ---
  const cwB = fingerprint(rowItems(rowsB, "Continue Watching"));
  const cwOk = cwB.length > 0 && cwB.every((x) => x.ticks > 0 && x.pct > 0);
  check("Continue Watching progress indicators present + positive", cwOk,
    cwB.map((x) => `${x.pct?.toFixed?.(0)}%`).join(" "));

  // --- restore shared test-account state (un-mark the seeded episode) ---
  if (seeded) {
    await setPlayed(IDENTITIES.browser, b.token, uid, seeded.epId, false);
    const verify = await api(IDENTITIES.browser, b.token, `/Users/${uid}/Items/${seeded.epId}?Fields=UserData`);
    const restored = verify.json?.UserData?.Played === false;
    check("test-account episode played-state restored", restored, restored ? "un-marked" : "STILL PLAYED");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
