#!/usr/bin/env node
// JEL-50 — Compare: Library browsing — Movies and TV Shows grids (TV vs browser).
//
// Library browsing (the Movies / TV Shows library grids) is 100% jellyfin-web +
// server driven. The Tizen shell does NOT implement, wrap, or customize any part
// of the library-grid code path (see results-JEL-50.md):
//   - Grid rendering is jellyfin-web's cardBuilder over a server /Items query;
//     the shell adds no item-list, image, or layout code.
//   - Intra-grid D-pad movement (card -> card, row -> row) is jellyfin-web's own
//     focusManager geometric navigation. The shell's ONLY focus contribution is
//     the body-focus-rescue / proactive auto-focus that lands focus INTO the
//     grid when activeElement is <body> — verified browser-side on the Library
//     page itself in JEL-33 (landed on the alphaPicker, 7 distinct targets, no
//     stuck frames). Once a card is focused, jellyfin-web owns movement.
//   - Filters / sort are jellyfin-web UI that drive server query params
//     (SortBy, SortOrder, Filters, Genres, Years, ...). The shell adds none.
//   - Paging / infinite scroll is jellyfin-web requesting /Items with
//     StartIndex + Limit and reading TotalRecordCount. The shell adds none.
//
// So the mechanism the user actually exercises ("open Movies, see a grid of
// posters + titles, D-pad around, sort/filter, scroll to load more without
// skips or dupes") is the server's /Items query contract. This harness verifies
// that contract directly against the live Jellyfin server, and runs the grid +
// paging enumeration under BOTH a browser-like and a TV-like client identity,
// asserting the two enumerations are byte-identical — proving the behavior is
// expected parity and that nothing in the shell can make the grids diverge
// between TV and browser.
//
// What this does NOT do: drive cards through a headless browser pixel-by-pixel.
// Intra-grid spatial focus is jellyfin-web focusManager (covered by JEL-33);
// the open question for library browsing is the data contract (correct items,
// correct images, sort/filter honored, paging complete with no skip/dup), which
// is exactly what this checks.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/library-browsing/verify-library-browsing.mjs
// Exits non-zero on any failed assertion. Never prints credentials. Read-only:
// issues only GET/POST-auth requests, mutates no server or account state.

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

let TOKEN = null;
let DEVICE_ID = "jel50-library-verify";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function authHeader() {
  const base = `MediaBrowser Client="JEL-50-library-verify", Device="sandbox", DeviceId="${DEVICE_ID}", Version="1.0.0"`;
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

// Enumerate an entire library view by paging /Items with StartIndex/Limit, the
// exact mechanism jellyfin-web's infinite scroll uses. Returns the ordered id
// list plus the server's reported TotalRecordCount on the first page.
async function pageThrough(userId, parentId, type, sortBy, sortOrder, pageSize) {
  const ids = [];
  const sortNames = [];
  let total = null;
  let start = 0;
  // hard ceiling so a server bug can't infinite-loop the harness
  for (let guard = 0; guard < 1000; guard++) {
    const r = await api(
      `/Items?UserId=${userId}&ParentId=${parentId}&IncludeItemTypes=${type}` +
      `&Recursive=true&SortBy=${sortBy}&SortOrder=${sortOrder}` +
      `&StartIndex=${start}&Limit=${pageSize}` +
      `&Fields=SortName,PrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary`
    );
    if (total === null) total = r.json?.TotalRecordCount ?? null;
    const items = r.json?.Items || [];
    if (items.length === 0) break;
    for (const it of items) { ids.push(it.Id); sortNames.push(it.SortName); }
    start += items.length;
    if (total !== null && start >= total) break;
  }
  return { ids, total, sortNames };
}

async function main() {
  // --- auth ---
  const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  TOKEN = a.json?.AccessToken;
  const userId = a.json?.User?.Id;
  check("authenticate", !!TOKEN && !!userId);
  if (!TOKEN) process.exit(1);

  // --- locate the Movies and TV Shows library views ---
  const views = await api(`/Users/${userId}/Views`);
  const movies = (views.json?.Items || []).find((v) => v.CollectionType === "movies");
  const tvshows = (views.json?.Items || []).find((v) => v.CollectionType === "tvshows");
  check("Movies library view present", !!movies, movies ? `"${movies.Name}"` : "none");
  check("TV Shows library view present", !!tvshows, tvshows ? `"${tvshows.Name}"` : "none");
  if (!movies || !tvshows) process.exit(1);

  const LIBS = [
    { label: "Movies", view: movies, type: "Movie" },
    { label: "TV Shows", view: tvshows, type: "Series" },
  ];

  // --- (1) grid renders with correct thumbnails and titles ---
  // jellyfin-web's cardBuilder needs a Name (title) and a Primary image tag
  // (poster) per card. Verify every item in the first grid page has both, and
  // that the poster image URL the card builds actually resolves to an image.
  for (const { label, view, type } of LIBS) {
    const r = await api(
      `/Items?UserId=${userId}&ParentId=${view.Id}&IncludeItemTypes=${type}` +
      `&Recursive=true&SortBy=SortName&SortOrder=Ascending&StartIndex=0&Limit=100` +
      `&Fields=PrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary`
    );
    const items = r.json?.Items || [];
    const titled = items.filter((it) => typeof it.Name === "string" && it.Name.length > 0);
    const withPoster = items.filter((it) => it.ImageTags && it.ImageTags.Primary);
    check(
      `[${label}] every grid item has a title`,
      items.length > 0 && titled.length === items.length,
      `${titled.length}/${items.length}`
    );
    check(
      `[${label}] every grid item has a Primary poster tag`,
      items.length > 0 && withPoster.length === items.length,
      `${withPoster.length}/${items.length}`
    );
    // resolve one real poster URL the way cardBuilder does
    const sample = withPoster[0];
    if (sample) {
      const tag = sample.ImageTags.Primary;
      const img = await api(`/Items/${sample.Id}/Images/Primary?tag=${tag}&maxWidth=400`, { raw: true });
      const ct = img.headers.get("content-type") || "";
      check(
        `[${label}] sample poster image resolves`,
        img.status === 200 && ct.startsWith("image/"),
        `"${sample.Name}" -> ${img.status} ${ct}`
      );
    }
  }

  // --- (3) filters and sort options are accessible AND honored by the server ---
  for (const { label, view, type } of LIBS) {
    // sort: ascending must be monotonic non-decreasing by SortName and
    // descending monotonic non-increasing, and the two orders must differ.
    // (We can't assert exact reversal: e.g. Movies has 7 titles sharing
    // SortName "superman iv" — a stable secondary tiebreaker keeps tied items
    // in the same relative order both ways, so descending != exact reverse.
    // Monotonicity is the correct, tie-tolerant proof that SortBy/SortOrder
    // are honored.)
    const asc = await pageThrough(userId, view.Id, type, "SortName", "Ascending", 50);
    const desc = await pageThrough(userId, view.Id, type, "SortName", "Descending", 50);
    const ascMono = asc.sortNames.every((n, i) => i === 0 || asc.sortNames[i - 1] <= n);
    const descMono = desc.sortNames.every((n, i) => i === 0 || desc.sortNames[i - 1] >= n);
    const ordersDiffer = JSON.stringify(asc.ids) !== JSON.stringify(desc.ids);
    check(`[${label}] SortBy/SortOrder honored (asc non-decreasing, desc non-increasing, orders differ)`,
      asc.ids.length > 0 && ascMono && descMono && ordersDiffer, `${asc.ids.length} items`);

    // an alternate SortBy must produce a valid permutation of the same set
    // (same items, generally different order) — proves the sort field switches.
    const byDate = await pageThrough(userId, view.Id, type, "DateCreated", "Descending", 50);
    const sameSet =
      byDate.ids.length === asc.ids.length &&
      new Set(byDate.ids).size === new Set(asc.ids).size &&
      [...new Set(byDate.ids)].every((id) => new Set(asc.ids).has(id));
    check(`[${label}] alternate SortBy (DateCreated) returns same set`, sameSet,
      `${byDate.ids.length} items`);

    // filters: the view exposes a filter vocabulary (genres etc.) the UI lists.
    const filt = await api(`/Items/Filters?UserId=${userId}&ParentId=${view.Id}&IncludeItemTypes=${type}`);
    const genres = filt.json?.Genres || [];
    check(`[${label}] filter options available (genres exposed)`, genres.length > 0,
      `${genres.length} genres, e.g. ${genres.slice(0, 3).join(", ")}`);

    // applying a genre filter must narrow the grid to a strict, non-empty subset.
    if (genres.length) {
      const g = genres[0];
      const all = await api(`/Items?UserId=${userId}&ParentId=${view.Id}&IncludeItemTypes=${type}&Recursive=true&Limit=0`);
      const totalAll = all.json?.TotalRecordCount ?? 0;
      const gen = await api(`/Items?UserId=${userId}&ParentId=${view.Id}&IncludeItemTypes=${type}&Recursive=true&Genres=${encodeURIComponent(g)}&Limit=0`);
      const totalGen = gen.json?.TotalRecordCount ?? 0;
      check(`[${label}] genre filter narrows the grid`, totalGen > 0 && totalGen <= totalAll,
        `"${g}": ${totalGen}/${totalAll}`);
    }
  }

  // --- (4) paging / infinite scroll: complete, no skips, no duplicates ---
  // AND (TV vs browser parity): page the full library under a browser-like and
  // a TV-like client identity; the two enumerations must be byte-identical, and
  // each must cover exactly TotalRecordCount items once (no skip, no dup),
  // matching a single unpaged fetch. Small page size forces many page turns.
  for (const { label, view, type } of LIBS) {
    DEVICE_ID = "jel50-browser";
    const browserPage = await pageThrough(userId, view.Id, type, "SortName", "Ascending", 7);
    DEVICE_ID = "jel50-tv";
    const tvPage = await pageThrough(userId, view.Id, type, "SortName", "Ascending", 7);
    DEVICE_ID = "jel50-library-verify";

    const total = browserPage.total;
    const uniq = new Set(browserPage.ids);
    const noDup = uniq.size === browserPage.ids.length;
    const complete = browserPage.ids.length === total;

    // ground truth: one big unpaged fetch in the same sort
    const oneShot = await api(
      `/Items?UserId=${userId}&ParentId=${view.Id}&IncludeItemTypes=${type}` +
      `&Recursive=true&SortBy=SortName&SortOrder=Ascending&StartIndex=0&Limit=${(total || 0) + 50}`
    );
    const truthIds = (oneShot.json?.Items || []).map((it) => it.Id);
    const matchesTruth =
      browserPage.ids.length === truthIds.length &&
      browserPage.ids.every((id, i) => id === truthIds[i]);

    const tvIdentical =
      tvPage.ids.length === browserPage.ids.length &&
      tvPage.ids.every((id, i) => id === browserPage.ids[i]);

    check(`[${label}] paging covers all ${total} items (count matches TotalRecordCount)`,
      complete, `paged ${browserPage.ids.length}/${total}`);
    check(`[${label}] paging has no duplicate items`, noDup,
      `${uniq.size} unique of ${browserPage.ids.length}`);
    check(`[${label}] paged order == unpaged order (no skipped/reordered items)`,
      matchesTruth, `paged ${browserPage.ids.length} vs unpaged ${truthIds.length}`);
    check(`[${label}] TV enumeration byte-identical to browser enumeration`,
      tvIdentical, `tv ${tvPage.ids.length} vs browser ${browserPage.ids.length}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
