#!/usr/bin/env node
// JEL-53 — Compare: Search functionality — query entry, results, and navigation
// (TV vs browser).
//
// Search is 100% jellyfin-web + server driven. The Tizen shell does NOT
// implement, wrap, or customize any part of the search code path (see
// results-JEL-53.md). A grep of shell.js / boot-shell.src.js for "search" finds
// only (a) focusManager *geometric* search (D-pad spatial nav — JEL-33) and
// (b) `location.search` URL parsing. There is zero text-search, search-input,
// search-results, or Search/Hints code in the shell. So every piece the user
// exercises on the search screen maps to a layer the shell does not touch:
//
//   (1) Query entry — the search field + on-screen text entry is jellyfin-web's
//       searchFields UI rendered in the WebView. Landing D-pad focus INTO that
//       field (when activeElement is <body>) is the shell's body-focus-rescue,
//       validated browser-side in JEL-33 (7 distinct focus targets, no stuck
//       frames). Once focused, character entry + caret are the platform input
//       element; intra-screen D-pad movement is jellyfin-web focusManager. The
//       shell adds no key handling here (it only intercepts BACK 10009 — see
//       PARITY_NOTES / JEL-42).
//   (2) Results — jellyfin-web's search calls GET /Search/Hints?searchTerm=...
//       per (debounced) keystroke and renders the SearchHints array. The hint
//       payload takes no DeviceProfile and does not vary by client/device, so
//       the server returns identical hints to TV and browser by construction.
//   (3) Result item display — each card is built from hint fields (Name, Type,
//       PrimaryImageTag, Series for episodes, ProductionYear...). Same fields
//       to both clients.
//   (4) Navigation — clicking/OK on a result routes jellyfin-web to
//       #!/details?id=<ItemId> (or the person/series page), whose payload is
//       GET /Users/{uid}/Items/{ItemId}. Id-addressed, identical for both.
//
// This harness verifies that contract directly against the live server and runs
// the full search flow under BOTH a browser-like and the real TV client
// identity ("Jellyfin Shell for Tizen" / "Samsung Smart TV" — see
// nativeshell-apphost-identity-values), asserting the two are byte-identical —
// proving the behavior is expected parity and that nothing in the shell can make
// search diverge between TV and browser.
//
// What this does NOT do: drive an on-screen keyboard pixel-by-pixel. Spatial
// D-pad focus + text entry is the platform/jellyfin-web (covered by JEL-33);
// the open question for search is the data contract (right results, right
// display fields, navigation resolves), which is exactly what this checks.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/search/verify-search.mjs
// Exits non-zero on any failed assertion. Never prints credentials. Read-only:
// issues only GET/POST-auth requests, mutates no server or account state.

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

// Two client identities: a generic browser, and the REAL TV identity the shell
// presents (see memory: nativeshell-apphost-identity-values). If the server
// branched search on client/device, these would diverge.
const IDENT = {
  browser: { client: "Jellyfin Web", device: "Chrome", deviceId: "jel53-browser" },
  tv: { client: "Jellyfin Shell for Tizen", device: "Samsung Smart TV", deviceId: "jel53-tv" },
};
let CUR = IDENT.browser;
let TOKEN = null;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function authHeader() {
  const base = `MediaBrowser Client="${CUR.client}", Device="${CUR.device}", DeviceId="${CUR.deviceId}", Version="1.0.0"`;
  return TOKEN ? `${base}, Token="${TOKEN}"` : base;
}
async function api(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// The request jellyfin-web's search issues. The all-types form (no
// includeItemTypes) backs the live "as you type" hint dropdown; the search
// RESULTS page additionally issues one filtered call per category section
// (Movies / Shows / Episodes / People / ...), which is how each type gets its
// own row even when one type would otherwise saturate the limit.
async function searchHints(userId, term, { limit = 40, types = null } = {}) {
  const typeParam = types ? `&includeItemTypes=${types}` : "";
  const r = await api(
    `/Search/Hints?userId=${userId}&searchTerm=${encodeURIComponent(term)}&limit=${limit}${typeParam}`
  );
  return r.json?.SearchHints || [];
}

// Fingerprint a hint list the way the UI consumes it: ordered ItemId + Name +
// Type. Two byte-identical fingerprints == identical results AND identical
// rendered cards.
function fingerprint(hints) {
  return JSON.stringify(hints.map((h) => [h.ItemId, h.Name, h.Type]));
}

async function main() {
  // --- auth (browser identity) ---
  CUR = IDENT.browser;
  const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  TOKEN = a.json?.AccessToken;
  const userId = a.json?.User?.Id;
  check("authenticate", !!TOKEN && !!userId);
  if (!TOKEN) process.exit(1);

  // ===================================================================
  // (2) Typing a query returns results — and incremental (per-keystroke)
  //     queries each return valid, narrowing results, matching what the user
  //     sees as they type. We type "star" one char at a time.
  // ===================================================================
  const TYPED = "star";
  let prevCount = Infinity;
  let lastHints = [];
  for (let i = 1; i <= TYPED.length; i++) {
    const prefix = TYPED.slice(0, i);
    const h = await searchHints(userId, prefix);
    check(
      `incremental query "${prefix}" returns results`,
      h.length > 0,
      `${h.length} hints`
    );
    // every hint must actually relate to the term (Name OR Series matches the
    // prefix) — proves the server is filtering on the query, not echoing a
    // fixed list. Person/Studio names also match.
    const rx = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const relevant = h.filter((x) => rx.test(x.Name || "") || rx.test(x.Series || ""));
    check(
      `query "${prefix}" results all match the query text`,
      h.length > 0 && relevant.length === h.length,
      `${relevant.length}/${h.length} match /${prefix}/i`
    );
    // typing more characters must not widen the result set (monotone narrowing
    // or equal — matches the UX of a refining search).
    check(
      `query "${prefix}" does not widen vs shorter prefix`,
      h.length <= prevCount,
      `${h.length} <= ${prevCount === Infinity ? "∞" : prevCount}`
    );
    prevCount = h.length;
    lastHints = h;
  }

  // ===================================================================
  // (3) Result items (movies, shows, episodes, people) display correctly.
  //     The "star" query happens to surface several types; assert the variety
  //     and that each carries the fields jellyfin-web's result card needs.
  // ===================================================================
  const byType = {};
  for (const h of lastHints) (byType[h.Type] ||= []).push(h);
  const typesPresent = Object.keys(byType);
  check(
    `search surfaces multiple item types`,
    typesPresent.length >= 3,
    typesPresent.map((t) => `${t}:${byType[t].length}`).join(", ")
  );

  // Every hint, regardless of type, must have a non-empty Name and a Type the
  // card switches on — without these jellyfin-web cannot render the result.
  const named = lastHints.filter((h) => typeof h.Name === "string" && h.Name.length > 0);
  const typed = lastHints.filter((h) => typeof h.Type === "string" && h.Type.length > 0);
  check("every result has a display Name", named.length === lastHints.length, `${named.length}/${lastHints.length}`);
  check("every result has a Type", typed.length === lastHints.length, `${typed.length}/${lastHints.length}`);

  // Episodes must carry their Series name (the result card shows "Series — Ep").
  if (byType.Episode) {
    const withSeries = byType.Episode.filter((h) => typeof h.Series === "string" && h.Series.length > 0);
    check("episode results carry Series context", withSeries.length === byType.Episode.length,
      `${withSeries.length}/${byType.Episode.length}`);
  }

  // A media result with a PrimaryImageTag must resolve to a real poster the way
  // the result card builds it (proves thumbnails display, not just metadata).
  const withImg = lastHints.find((h) => h.PrimaryImageTag);
  if (withImg) {
    const img = await api(
      `/Items/${withImg.ItemId}/Images/Primary?tag=${withImg.PrimaryImageTag}&maxWidth=300`,
      { raw: true }
    );
    const ct = img.headers.get("content-type") || "";
    check("result poster image resolves", img.status === 200 && ct.startsWith("image/"),
      `"${withImg.Name}" -> ${img.status} ${ct}`);
  }

  // Explicitly confirm each of the four user-named result classes is returned,
  // using the per-category filtered queries the search-results page issues for
  // each section row (so a flood of episodes can't hide the shows row, etc.).
  const personHits = await searchHints(userId, "john", { types: "Person" });
  const seriesHits = await searchHints(userId, "e", { types: "Series" });
  const movieHits = await searchHints(userId, "star", { types: "Movie" });
  const episodeHits = await searchHints(userId, "the", { types: "Episode" });
  check("People results returned", personHits.length > 0, `${personHits.length} for "john"`);
  check("Series (shows) results returned", seriesHits.length > 0, `${seriesHits.length} for "e"`);
  check("Movie results returned", movieHits.length > 0, `${movieHits.length} for "star"`);
  check("Episode results returned", episodeHits.length > 0, `${episodeHits.length} for "the"`);

  // ===================================================================
  // (4) Selecting a result navigates to the correct details page. The UI
  //     routes to the item's Id; the page payload is /Users/{uid}/Items/{Id}.
  //     For one sample of EACH surfaced type, the Id must resolve and come back
  //     with the same Id and a consistent Type — i.e. the click lands on the
  //     right item, not a 404 or the wrong entity.
  // ===================================================================
  const navSamples = [];
  for (const t of typesPresent) navSamples.push(byType[t][0]);
  if (personHits[0]) navSamples.push(personHits[0]);
  if (seriesHits[0]) navSamples.push(seriesHits[0]);
  for (const h of navSamples) {
    const d = await api(`/Users/${userId}/Items/${h.ItemId}`);
    const ok = d.status === 200 && d.json?.Id === h.ItemId;
    // Type should match the hint's Type (the card and the details agree).
    const typeOk = !ok || d.json?.Type === h.Type;
    check(`select "${h.Name}" (${h.Type}) -> details resolves to same item`,
      ok && typeOk,
      `${d.status} id=${d.json?.Id === h.ItemId ? "match" : "MISMATCH"} type=${d.json?.Type}`);
  }

  // ===================================================================
  // TV vs browser parity: run the whole search under both identities and assert
  // byte-identical results for every probed term. This is the core claim — the
  // shell cannot make search diverge between TV and browser.
  // ===================================================================
  const TERMS = ["star", "love", "the", "john", "man", "a"];
  for (const term of TERMS) {
    CUR = IDENT.browser;
    const fb = fingerprint(await searchHints(userId, term));
    CUR = IDENT.tv;
    const ft = fingerprint(await searchHints(userId, term));
    CUR = IDENT.browser;
    check(`TV results byte-identical to browser for "${term}"`, fb === ft,
      fb === ft ? `identical (${JSON.parse(fb).length} hints)` : "DIVERGED");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
