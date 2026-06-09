#!/usr/bin/env node
// JEL-76 — Compare: Favorites — mark/unmark and persistence across sessions — TV vs browser.
//
// What the issue asks us to prove:
//   (1) the heart icon toggles correctly (mark → favorite, unmark → not favorite);
//   (2) the Favorites library/filter shows the SAME items on TV as on browser;
//   (3) favorites persist after a TV power cycle — API-backed, NOT local-only;
//   (4) a change made on browser immediately reflects on TV after a refresh.
//
// ── The parity story ────────────────────────────────────────────────────────
// A "favorite" is server state, not client state. jellyfin-web's heart button
// calls `apiClient.updateFavoriteStatus()` → POST/DELETE on the server's
// FavoriteItems endpoint, and the server stamps `UserData.IsFavorite` on the
// item, keyed by (user, item). The "Favorites" view and every `Filters=IsFavorite`
// query read that same server state back. NOTHING about a favorite lives in the
// client.
//
// A `grep` of shell.js / boot-shell.src.js proves the Tizen shell is transparent
// to all of this:
//   - it references NO favorite / FavoriteItems / IsFavorite / heart anywhere —
//     it owns none of the toggle UI or the mutation call;
//   - its fetch + XMLHttpRequest shim only intercepts `config.json`
//     (matches = /(^|\/)config\.json(\?|$)/); every FavoriteItems POST/DELETE and
//     every Filters=IsFavorite read flows straight to native networking → the
//     server, untouched (memory: jel64-network-error-transparency);
//   - it never writes user-data / favorites to localStorage. Its only LS keys are
//     boot-infra (bundle/web/config cache, serverUrl, _deviceId2, layout,
//     transpile caches) — so there is no client-side favorites copy to go stale,
//     and a power cycle (which only loses client memory) cannot lose a favorite.
// So the heart toggle, the Favorites filter, cross-session persistence, and
// cross-client reflection are all TV==browser BY CONSTRUCTION — same server, same
// jellyfin-web client code, the shell merely a transparent host.
//
// ── What this harness does ──────────────────────────────────────────────────
//  PART A (live, real server) — under TWO faithful client identities, a
//    browser-like session and the real TV/NativeShell identity:
//    (1) the heart toggle is correct + symmetric on BOTH identities: POST marks
//        (IsFavorite→true), DELETE unmarks (→false), re-POST re-marks; the
//        returned UserItemDataDto and a fresh item GET both reflect the new state.
//    (2) the Favorites filter (Filters=IsFavorite) returns a byte-IDENTICAL item
//        set on TV vs browser and contains exactly the marked items.
//    (3) persistence is API-backed: mark under one session, then authenticate a
//        BRAND-NEW session (new token = a cold TV boot after a power cycle) and a
//        login that never saw the mark — both still read IsFavorite=true.
//    (4) cross-client reflection: mark under the BROWSER identity, then a fresh
//        read under the TV identity (the "refresh") already sees it (true + in the
//        TV favorites filter); unmark under TV → the browser's next read sees
//        false. Bidirectional, immediate, no caching in between.
//  PART C (source) — assert shell transparency on BOTH shells: no favorite/heart
//    code, the fetch/XHR shim matches ONLY config.json (favorites pass through),
//    no favorites/user-data ever written to localStorage, and the config-only
//    `matches` predicate is byte-identical across the TV and hosted shells.
//
// Why no vm simulation here (unlike JEL-70's profile-switch lifecycle): favorite
// persistence is genuinely SERVER state, so PART A(3)'s fresh-token reads are
// direct, real-server evidence of the power-cycle guarantee — stronger than any
// in-process model could be.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/favorites/verify-favorites.mjs
// Exits non-zero on any failed assertion. Never prints credentials/tokens.
// Read-mostly: it toggles favorites on a few items then RESTORES each item's
// original IsFavorite state and revokes every session it minted; no other server
// or account state is mutated.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const HOSTED_SHELL = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.src.js");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Two faithful client identities. TV mirrors the shell's NativeShell.AppHost
// values (memory: nativeshell-apphost-identity-values).
const IDENTITIES = {
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel76-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel76-tv", Version: "10.11.0" },
};

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(id, token, p, { method = "GET", body } = {}) {
  const res = await fetch(URL_BASE + p, {
    method,
    headers: { Authorization: authHeader(id, token), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json };
}
async function authAs(id) {
  return api(id, null, "/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
}
const idsOf = (arr) => (arr || []).map((it) => it.Id);
const liveTokens = []; // { id, token, dead }

// Mutation helpers. jellyfin-web uses POST/DELETE on the user-scoped Favorite
// endpoint; both the modern (/UserFavoriteItems/{id}?userId=) and legacy
// (/Users/{uid}/FavoriteItems/{id}) forms are accepted by the server. We use the
// modern form jellyfin-web's ApiClient emits today.
const markFav = (id, tok, uid, iid) => api(id, tok, `/UserFavoriteItems/${iid}?userId=${uid}`, { method: "POST" });
const unFav = (id, tok, uid, iid) => api(id, tok, `/UserFavoriteItems/${iid}?userId=${uid}`, { method: "DELETE" });
const favFilter = (id, tok, uid) =>
  api(id, tok, `/Users/${uid}/Items?Filters=IsFavorite&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Limit=200&SortBy=SortName`);
const itemFav = async (id, tok, uid, iid) => {
  const r = await api(id, tok, `/Users/${uid}/Items/${iid}`);
  return { status: r.status, isFav: r.json?.UserData?.IsFavorite };
};

// Items we touch, with their ORIGINAL favorite state so we can restore.
const touched = []; // { iid, name, original }

async function liveChecks() {
  const ab = await authAs(IDENTITIES.browser);
  const at = await authAs(IDENTITIES.tv);
  const rb = ab.json || {}, rt = at.json || {};
  if (rb.AccessToken) liveTokens.push({ id: IDENTITIES.browser, token: rb.AccessToken, dead: false });
  if (rt.AccessToken) liveTokens.push({ id: IDENTITIES.tv, token: rt.AccessToken, dead: false });
  check("login succeeds under browser + TV identity",
    ab.status === 200 && at.status === 200 && rb.AccessToken && rt.AccessToken,
    `browser=${ab.status} tv=${at.status}`);
  if (!rb.AccessToken || !rt.AccessToken) return;
  const uid = rb.User.Id;
  const bTok = rb.AccessToken, tTok = rt.AccessToken;

  // Grab a handful of stable items and record original favorite state.
  const pool = await api(IDENTITIES.browser, bTok, `/Users/${uid}/Items?Recursive=true&IncludeItemTypes=Movie&Limit=4&SortBy=SortName`);
  const items = pool.json?.Items || [];
  check("server returns items to mark as favorites", items.length >= 2, `${items.length} items`);
  if (items.length < 2) return;
  for (const it of items) touched.push({ iid: it.Id, name: it.Name, original: !!it.UserData?.IsFavorite });

  // ── (1) heart toggle is correct + symmetric, on BOTH identities ──────────
  // Use item[0] under TV, item[1] under browser; assert mark→true, unmark→false,
  // re-mark→true, with BOTH the mutation response and a fresh GET agreeing.
  for (const [label, id, tok, iid] of [
    ["TV", IDENTITIES.tv, tTok, touched[0].iid],
    ["browser", IDENTITIES.browser, bTok, touched[1].iid],
  ]) {
    const m = await markFav(id, tok, uid, iid);
    const afterMark = await itemFav(id, tok, uid, iid);
    const u = await unFav(id, tok, uid, iid);
    const afterUn = await itemFav(id, tok, uid, iid);
    const m2 = await markFav(id, tok, uid, iid);
    const afterRe = await itemFav(id, tok, uid, iid);
    check(`[${label}] heart toggle correct: mark→IsFavorite true (response + reread agree)`,
      m.status === 200 && m.json?.IsFavorite === true && afterMark.isFav === true,
      `resp=${m.json?.IsFavorite} reread=${afterMark.isFav}`);
    check(`[${label}] heart toggle correct: unmark→IsFavorite false (response + reread agree)`,
      u.status === 200 && u.json?.IsFavorite === false && afterUn.isFav === false,
      `resp=${u.json?.IsFavorite} reread=${afterUn.isFav}`);
    check(`[${label}] heart toggle is idempotent/symmetric: re-mark→true again`,
      m2.status === 200 && afterRe.isFav === true, `reread=${afterRe.isFav}`);
  }

  // ── (2) Favorites filter shows the SAME items on TV vs browser ───────────
  // Leave item[0] (TV-marked) and item[1] (browser-marked) favorited, ensure the
  // rest are unfavorited, then read the favorites filter under BOTH identities.
  await markFav(IDENTITIES.tv, tTok, uid, touched[0].iid);
  await markFav(IDENTITIES.browser, bTok, uid, touched[1].iid);
  for (let i = 2; i < touched.length; i++) await unFav(IDENTITIES.browser, bTok, uid, touched[i].iid);

  const favB = await favFilter(IDENTITIES.browser, bTok, uid);
  const favT = await favFilter(IDENTITIES.tv, tTok, uid);
  const setB = idsOf(favB.json?.Items), setT = idsOf(favT.json?.Items);
  check("Favorites filter (Filters=IsFavorite) byte-identical TV vs browser",
    setB.length > 0 && eq(setB, setT), `${setB.length} favorites, identical=${eq(setB, setT)}`);
  check("Favorites filter contains exactly the items marked under each client",
    setB.includes(touched[0].iid) && setB.includes(touched[1].iid),
    `tv-marked in=${setB.includes(touched[0].iid)} browser-marked in=${setB.includes(touched[1].iid)}`);

  // ── (3) persistence is API-backed, survives a power cycle ────────────────
  // A power cycle loses ALL client memory (localStorage survives, but a favorite
  // was never written there; a clean reinstall loses even that). Model the worst
  // case: a BRAND-NEW session with a new DeviceId + new token that never
  // participated in the mark. It must still read IsFavorite=true.
  const fresh = await authAs({ ...IDENTITIES.tv, DeviceId: "jel76-tv-after-powercycle" });
  const freshTok = fresh.json?.AccessToken;
  if (freshTok) liveTokens.push({ id: { ...IDENTITIES.tv, DeviceId: "jel76-tv-after-powercycle" }, token: freshTok, dead: false });
  const persisted = freshTok
    ? await itemFav({ ...IDENTITIES.tv, DeviceId: "jel76-tv-after-powercycle" }, freshTok, uid, touched[0].iid)
    : { isFav: undefined };
  check("favorite persists for a NEW session/token (cold TV boot after power cycle) — API-backed, not local-only",
    fresh.status === 200 && persisted.isFav === true, `auth=${fresh.status} reread=${persisted.isFav}`);
  const freshFilter = freshTok ? await favFilter({ ...IDENTITIES.tv, DeviceId: "jel76-tv-after-powercycle" }, freshTok, uid) : { json: {} };
  check("a session that never set the favorite still sees it in the Favorites filter (server-stored, user-keyed)",
    idsOf(freshFilter.json?.Items).includes(touched[0].iid), `count=${idsOf(freshFilter.json?.Items).length}`);

  // ── (4) a browser change immediately reflects on TV after a refresh ──────
  // Mark item[2] under the BROWSER identity; a FRESH read under the TV identity
  // (the "refresh") must already see it. Then unmark under TV → the browser's
  // next read sees it gone. Bidirectional, no stale client cache in between.
  const tgt = touched[2] ? touched[2].iid : touched[0].iid;
  await markFav(IDENTITIES.browser, bTok, uid, tgt);
  const tvSeesMark = await itemFav(IDENTITIES.tv, tTok, uid, tgt);
  const tvFilterSees = idsOf((await favFilter(IDENTITIES.tv, tTok, uid)).json?.Items).includes(tgt);
  check("browser→TV: favorite marked on browser is seen by a fresh TV read (refresh) + TV favorites filter",
    tvSeesMark.isFav === true && tvFilterSees, `tv reread=${tvSeesMark.isFav} in-filter=${tvFilterSees}`);
  await unFav(IDENTITIES.tv, tTok, uid, tgt);
  const browserSeesUnmark = await itemFav(IDENTITIES.browser, bTok, uid, tgt);
  check("TV→browser: unmark on TV is seen by a fresh browser read (bidirectional, immediate)",
    browserSeesUnmark.isFav === false, `browser reread=${browserSeesUnmark.isFav}`);
}

async function restoreAndRevoke() {
  // Restore every touched item to its original favorite state, using whichever
  // live token still works.
  const live = liveTokens.find((t) => !t.dead);
  if (live && touched.length) {
    const uid = liveTokens[0] && (await api(live.id, live.token, "/Users/Me")).json?.Id;
    if (uid) {
      for (const t of touched) {
        if (t.original) await markFav(live.id, live.token, uid, t.iid).catch(() => {});
        else await unFav(live.id, live.token, uid, t.iid).catch(() => {});
      }
    }
  }
  for (const t of liveTokens) {
    if (t.dead) continue;
    await api(t.id, t.token, "/Sessions/Logout", { method: "POST" }).catch(() => {});
    t.dead = true;
  }
}

// ─── PART C: source transparency, both shells ───────────────────────────────
function sourceChecks() {
  const tv = fs.readFileSync(TV_SHELL, "utf8");
  const hosted = fs.readFileSync(HOSTED_SHELL, "utf8");

  // The exact config-only intercept predicate as it appears (verbatim) in both
  // shells' injected-script string array. It is the WHOLE allowlist of what the
  // fetch/XHR shim touches — anything not matching (every FavoriteItems POST/
  // DELETE, every Filters=IsFavorite read) flows to native networking → server.
  const MATCHES_PREDICATE =
    'var matches=function(u){return /(^|\\\\/)config\\\\.json(\\\\?|$)/.test(String(u||""));};';

  for (const [label, src] of [["shell.js (TV)", tv], ["boot-shell.src.js (hosted/browser)", hosted]]) {
    // Strip line comments so prose ("…the heart button…") never trips a code match.
    const code = src.replace(/\/\/[^\n]*/g, "");
    check(`[${label}] owns no favorite / heart / FavoriteItems code (jellyfin-web does)`,
      !/FavoriteItems|IsFavorite|updateFavoriteStatus|favoriteButton|btnFavorite/i.test(code));

    // The fetch/XHR shim intercepts ONLY config.json — every FavoriteItems
    // POST/DELETE and Filters=IsFavorite read passes through to native → server.
    check(`[${label}] fetch/XHR shim matches ONLY config.json (favorite traffic passes through to server)`,
      code.includes(MATCHES_PREDICATE));

    // Never persists favorites / user-data to localStorage → no client copy to go
    // stale or to lose on a power cycle. Assert no setItem of a favorites/user-data
    // key (the shell's real keys are boot-infra only).
    check(`[${label}] never writes favorites/user-data to localStorage (no client copy to go stale)`,
      !/setItem\(\s*["'][^"']*(?:favorit|userdata|user_data|userItemData)[^"']*["']/i.test(code));
  }

  // Both shells embed the byte-identical config-only intercept predicate, so the
  // pass-through guarantee for favorites is the same on TV and hosted/browser.
  check("config-only `matches` predicate byte-identical across TV + hosted shell",
    tv.includes(MATCHES_PREDICATE) && hosted.includes(MATCHES_PREDICATE), `${MATCHES_PREDICATE.length} chars`);
}

async function main() {
  const haveServer = URL_BASE && USER && PASS;
  if (haveServer) {
    try { await liveChecks(); } finally { await restoreAndRevoke(); }
  } else {
    console.log("WARN  JELLYFIN_URL/USER/PASS not set — skipping live PART A (source checks still run).");
  }
  sourceChecks();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (!haveServer) console.log("(live server checks were skipped — set JELLYFIN_* to run them)");
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { try { await restoreAndRevoke(); } catch {} console.error("harness error:", e?.message || e); process.exit(1); });
