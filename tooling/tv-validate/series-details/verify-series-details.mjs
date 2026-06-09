#!/usr/bin/env node
// JEL-51 — Compare: Series details page — seasons and episodes list (M63 iterate fix).
//
// This is THE page that previously wedged the physical M63 Tizen TV: navigating
// to a TV-show details route fired "Invalid attempt to iterate non-iterable
// instance" and the WebView hung (JEL-19 / JEL-21). The wedge was NOT a content
// bug — it was server-injected plugin scripts running RAW on Chromium 63 because
// the shell's fast-path transpile gate was skipping them, producing SyntaxErrors
// with the iterate-non-iterable as a downstream symptom (root-caused in JEL-23,
// fixed in build dedab53, pixel-verified on the physical QN82Q60RAFXZA TV: 0
// iterate errors, full home + details render). JEL-20 added the __ensureBabel
// transpile gate; JEL-23 added the catch{} denylist entry, detection-time
// markBabelNeeded, and the unconditional plugin scan.
//
// So JEL-51 has two independent dimensions, both verified here:
//
//   PART A — CONTENT PARITY (what the user sees on the details page).
//     The series header, season selector, and per-season episode lists are 100%
//     jellyfin-web + server driven; the Tizen shell implements NO season/episode
//     /details code path (grep of shell.js / boot-shell.src.js finds zero refs to
//     Seasons / Episodes / season-selector / episode-card building). The data
//     comes from user-scoped server endpoints that take NO DeviceProfile and are
//     NOT keyed on client/device:
//        series metadata  -> GET /Users/{uid}/Items/{seriesId}
//        season selector  -> GET /Shows/{seriesId}/Seasons?UserId={uid}
//        episode list     -> GET /Shows/{seriesId}/Episodes?SeasonId=..&UserId=..
//     We fetch all three under a browser-like AND a TV-like client identity and
//     assert byte-identical fingerprints: season list+order (selector), every
//     season's episode list+order (SxE), episode thumbnails (ImageTags), and
//     episode metadata (name, runtime, overview-presence). Plus we resolve a real
//     episode thumbnail under both identities to prove the image asset renders.
//     This covers JEL-51 checks (2) season selector, (3) episodes list,
//     (4) thumbnails + metadata.
//
//   PART B — M63 ITERATE-FIX REGRESSION GUARD (JEL-51 check (1)).
//     Two layers:
//       (B1) Source guards: assert boot-shell.src.js still contains the four
//            fixes that, if reverted, re-wedge the details page —
//              * MODERN_SYNTAX_RE includes optional-catch-binding `catch{`
//              * babelTranspile passes assumptions iterableIsArray +
//                arrayLikeIsIterable (so any lowered for-of/spread emits indexed
//                access, never the throwing _createForOfIteratorHelper)
//              * the transpile path is gated on __ensureBabel (JEL-20)
//              * the legacy script scan runs for every legacy boot
//                (isLegacyChromium), NOT gated on a stale babelNeeded flag (JEL-23)
//       (B2) Functional: fetch the EXACT plugin scripts the server injects into
//            /web/index.html (the scripts that execute on every route, including
//            details), run each through the SHIPPED babel bundle with the
//            production transpile config, and assert each transpiles to output
//            that contains NO M63-fatal modern syntax (?. ?? ??= ||= &&=
//            optional-catch) and NO throwing iterator helper. This is the literal
//            mechanism that stopped the wedge: raw plugins -> SyntaxError is now
//            transpiled-clean -> details page survives.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/series-details/verify-series-details.mjs
// Read-only against the server (GET + auth POST only). Never prints credentials.
// Exits non-zero on any failed assertion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

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

// Two faithful client identities. The TV identity mirrors the shell's real
// NativeShell.AppHost values (memory: nativeshell-apphost-identity-values).
const IDENTITIES = {
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel51-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel51-tv", Version: "10.11.0" },
};

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(id, token, path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(id, token), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}
async function authAs(id) {
  const a = await api(id, null, "/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  return { token: a.json?.AccessToken, uid: a.json?.User?.Id };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function firstDiff(a, b) {
  const i = a.findIndex((x, idx) => JSON.stringify(x) !== JSON.stringify(b[idx]));
  if (i < 0) return a.length !== b.length ? `length ${a.length} vs ${b.length}` : "none";
  return `index ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
}

// --- device-agnostic fingerprints (the things the details page renders) ---
function seriesFp(it) {
  if (!it) return null;
  return {
    Id: it.Id,
    Name: it.Name,
    Type: it.Type,
    hasOverview: !!(it.Overview && it.Overview.length),
    Genres: (it.Genres || []).slice().sort(),
    Year: it.ProductionYear ?? null,
    Rating: it.OfficialRating ?? null,
    Studios: (it.Studios || []).map((s) => s.Name).sort(),
    peopleCount: (it.People || []).length,
    imageTags: Object.keys(it.ImageTags || {}).sort().join(","),
    backdrops: (it.BackdropImageTags || []).length,
    childCount: it.ChildCount ?? null,
  };
}
function seasonFp(s) {
  return {
    Id: s.Id,
    Idx: s.IndexNumber ?? null,
    Name: s.Name,
    primary: (s.ImageTags || {}).Primary ? 1 : 0,
    childCount: s.ChildCount ?? null,
  };
}
function episodeFp(e) {
  return {
    Id: e.Id,
    SxE: `S${e.ParentIndexNumber ?? "?"}E${e.IndexNumber ?? "?"}`,
    Name: e.Name,
    runTimeTicks: e.RunTimeTicks ?? null,
    hasOverview: !!(e.Overview && e.Overview.length),
    // episode thumbnail: jellyfin-web's episode card uses the Primary image
    primary: (e.ImageTags || {}).Primary || null,
    premiere: e.PremiereDate ?? null,
  };
}

const EP_FIELDS = "Overview,PrimaryImageAspectRatio,MediaSourceCount";
async function getSeasons(id, token, uid, seriesId) {
  const r = await api(id, token, `/Shows/${seriesId}/Seasons?UserId=${uid}&Fields=ChildCount`);
  return r.json?.Items || [];
}
async function getEpisodes(id, token, uid, seriesId, seasonId) {
  const r = await api(id, token, `/Shows/${seriesId}/Episodes?UserId=${uid}&SeasonId=${seasonId}&Fields=${EP_FIELDS}`);
  return r.json?.Items || [];
}

// ===================== PART A: content parity ============================
async function partA() {
  const b = await authAs(IDENTITIES.browser);
  const t = await authAs(IDENTITIES.tv);
  check("authenticate (browser + tv sessions)", b.token && t.token && b.uid === t.uid,
    b.uid ? `uid ${b.uid.slice(0, 8)}…` : "no token");
  if (!b.token || !t.token) process.exit(1);
  const uid = b.uid;

  // Pick the multi-season series with the most seasons (deterministic: most
  // ChildCount, then lowest Id) so the test exercises a season selector with
  // many entries and a deep episode list — exactly the heavy page that wedged.
  const series = await api(IDENTITIES.browser, b.token,
    `/Items?UserId=${uid}&IncludeItemTypes=Series&Recursive=true&Fields=ChildCount&Limit=500`);
  const candidates = (series.json?.Items || [])
    .filter((s) => (s.ChildCount || 0) >= 2)
    .sort((x, y) => (y.ChildCount - x.ChildCount) || x.Id.localeCompare(y.Id));
  check("found a multi-season series", candidates.length > 0,
    candidates[0] ? `${candidates.length} multi-season series; picked "${candidates[0].Name}" (${candidates[0].ChildCount} seasons)` : "none");
  if (!candidates.length) process.exit(1);
  const seriesId = candidates[0].Id;

  // --- (header) series metadata identical TV vs browser ---
  const metaB = await api(IDENTITIES.browser, b.token, `/Users/${uid}/Items/${seriesId}`);
  const metaT = await api(IDENTITIES.tv, t.token, `/Users/${uid}/Items/${seriesId}`);
  const sfb = seriesFp(metaB.json), sft = seriesFp(metaT.json);
  check("series header metadata identical (name/genres/year/rating/cast/images)",
    eq(sfb, sft), eq(sfb, sft) ? `"${sfb.Name}" ${sfb.Genres.length} genres, ${sfb.peopleCount} cast` : JSON.stringify(sfb) + " vs " + JSON.stringify(sft));

  // --- (2) season selector: the list that backs the dropdown ---
  const seasB = await getSeasons(IDENTITIES.browser, b.token, uid, seriesId);
  const seasT = await getSeasons(IDENTITIES.tv, t.token, uid, seriesId);
  const sfpB = seasB.map(seasonFp), sfpT = seasT.map(seasonFp);
  check("season selector: ≥2 seasons returned", sfpB.length >= 2, `${sfpB.length} seasons`);
  check("season selector list + order identical (TV vs browser)",
    eq(sfpB, sfpT), eq(sfpB, sfpT) ? `${sfpB.length} seasons identical` : firstDiff(sfpB, sfpT));

  // --- (3)+(4) every season's episode list + thumbnails + metadata identical ---
  let totalEpB = 0, totalEpT = 0, seasonsWithEps = 0;
  let aThumbEp = null; // remember one episode that has a Primary thumbnail
  for (const s of seasB) {
    const epB = await getEpisodes(IDENTITIES.browser, b.token, uid, seriesId, s.Id);
    const epT = await getEpisodes(IDENTITIES.tv, t.token, uid, seriesId, s.Id);
    totalEpB += epB.length; totalEpT += epT.length;
    if (epB.length) seasonsWithEps++;
    const efb = epB.map(episodeFp), eft = epT.map(episodeFp);
    check(`[${s.Name}] episodes list + thumbnails + metadata identical (${epB.length} eps)`,
      eq(efb, eft), eq(efb, eft) ? `${epB.length} eps identical` : firstDiff(efb, eft));
    if (!aThumbEp) {
      const withThumb = epB.find((e) => (e.ImageTags || {}).Primary);
      if (withThumb) aThumbEp = withThumb;
    }
  }
  check("total episode count identical across all seasons (TV vs browser)",
    totalEpB === totalEpT && totalEpB > 0, `browser=${totalEpB} tv=${totalEpT} over ${seasonsWithEps} populated seasons`);

  // --- (4) episode thumbnail asset actually resolves under BOTH identities ---
  if (aThumbEp) {
    const tag = aThumbEp.ImageTags.Primary;
    const imgB = await api(IDENTITIES.browser, b.token, `/Items/${aThumbEp.Id}/Images/Primary?tag=${tag}&maxWidth=400`, { raw: true });
    const imgT = await api(IDENTITIES.tv, t.token, `/Items/${aThumbEp.Id}/Images/Primary?tag=${tag}&maxWidth=400`, { raw: true });
    const ctB = imgB.headers.get("content-type") || "", ctT = imgT.headers.get("content-type") || "";
    check("episode thumbnail asset resolves to an image on BOTH identities",
      imgB.status === 200 && ctB.startsWith("image/") && imgT.status === 200 && ctT.startsWith("image/"),
      `"${aThumbEp.Name}" browser=${imgB.status} ${ctB} / tv=${imgT.status} ${ctT}`);
  } else {
    check("episode thumbnail asset resolves to an image on BOTH identities", false, "no episode with a Primary thumbnail found");
  }
}

// ============ PART B1: source-level iterate-fix regression guards ============
function partB1() {
  const srcPath = resolve(REPO, "packages/shell-tizen-bootstrap/src/boot-shell.src.js");
  const src = readFileSync(srcPath, "utf8");

  // (1) optional-catch-binding in the modern-syntax denylist (JEL-23 fix #1).
  //     Without it, JavaScriptInjector's public.js (uses catch{}) is treated as
  //     ES5, inlined raw, and SyntaxErrors on M63.
  // the file literally contains the bytes  catch\\s*\\{  (double-backslash in the
  // JS source string that builds MODERN_SYNTAX_RE), so match that byte sequence.
  check("guard: MODERN_SYNTAX_RE detects optional-catch-binding (catch{)",
    src.includes("catch\\\\s*\\\\{"),
    "MODERN_SYNTAX_RE_SRC contains the catch{ pattern");

  // (2) babelTranspile passes the iterable assumptions so a lowered for-of/spread
  //     emits indexed access, never the throwing _createForOfIteratorHelper.
  const hasIterAssume = src.includes("iterableIsArray") && src.includes("arrayLikeIsIterable");
  check("guard: babelTranspile passes iterableIsArray + arrayLikeIsIterable assumptions",
    hasIterAssume, hasIterAssume ? "both assumptions present" : "MISSING — for-of could emit the throwing helper");

  // (3) transpile is gated on __ensureBabel (JEL-20): babel is guaranteed loaded
  //     before transform, so a modern plugin is never document.write'd raw.
  check("guard: transpile path gated on __ensureBabel (JEL-20)",
    src.includes("__ensureBabel"), "__ensureBabel referenced");

  // (4) the legacy scan runs for every legacy boot, not gated on a stale
  //     babelNeeded flag (JEL-23 fix #3) — and the flag is persisted at
  //     detection time (fix #2).
  const scanUnconditional = /function transpileLegacyScriptsInner[\s\S]{0,400}querySelectorAll\("script"\)/.test(src);
  check("guard: legacy script scan enumerates all scripts (not gated on babelNeeded)",
    scanUnconditional, scanUnconditional ? "scan slices doc.querySelectorAll('script')" : "scan appears gated");
  check("guard: babelNeeded persisted at detection time (markBabelNeeded present)",
    src.includes("function markBabelNeeded"), "markBabelNeeded() defined");
}

// ===== PART B2: functional — server-injected plugins transpile M63-safe =====
function loadBabel() {
  const bundle = readFileSync(resolve(REPO, "packages/shell-tizen-bootstrap/src/babel.min.js"), "utf8");
  (0, eval)(bundle); // sets globalThis.Babel — the EXACT bundle that ships in the WGT
  return globalThis.Babel;
}
// production transpile config, copied verbatim from babelTranspile in boot-shell.src.js
function prodTranspile(Babel, code) {
  return Babel.transform(code, {
    presets: [["env", { targets: { chrome: "63" }, modules: false, loose: true }]],
    assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
    sourceType: "script", compact: true, comments: false,
  }).code;
}
// M63-fatal syntax that, if it survives transpile, throws "Unexpected token" on
// Chromium 63 and (per JEL-23) wedges the details page.
const M63_FATAL = /\?\.|\?\?|\?\?=|\|\|=|&&=|catch\s*\{/;
const ITER_THROWER = /_createForOfIteratorHelper|Invalid attempt to iterate non-iterable|non-iterable instance/;

async function partB2() {
  const b = await authAs(IDENTITIES.browser);
  // discover the plugin scripts the server injects into the web client shell —
  // these execute on EVERY route, including the details page that wedged.
  const idx = await api(IDENTITIES.browser, b.token, "/web/index.html");
  const html = idx.text || "";
  // resolve every <script src> relative to /web/, then keep ONLY the server
  // PLUGIN scripts (those that resolve OUTSIDE /web/, e.g. /EditorsChoice/script,
  // ../JellyfinEnhanced/script). The jellyfin-web client bundle itself (/web/*)
  // is deliberately excluded: it is webpack-built ES5 that ships its own
  // _createForOfIteratorHelper and is proven M63-safe by the app booting (JEL-23
  // verified 32 home rows on the physical TV). The historical details-page wedge
  // was plugin-specific — raw, un-transpiled plugin scripts — so those are what
  // this check must cover.
  const urls = [...new Set(
    [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
      .filter((s) => !/^https?:\/\//.test(s))
      .map((s) => {
        let p = s.replace(/^\.\.\//, "/").replace(/^\.\//, "/web/");
        if (!p.startsWith("/")) p = "/web/" + p;
        return p;
      })
      .filter((p) => !p.startsWith("/web/")) // plugin scripts only
  )];
  check("discovered server-injected plugin scripts in /web/index.html", urls.length > 0,
    `${urls.length} plugin scripts: ${urls.map((u) => u.split("?")[0]).join(", ")}`);

  const Babel = loadBabel();
  check("shipped babel bundle loads (the exact WGT bundle)", !!Babel && typeof Babel.transform === "function",
    Babel ? `Babel ${Babel.version}` : "failed to load");

  let transpiledCount = 0, fatalSurvivors = 0, throwerSurvivors = 0, checked = 0;
  for (const u of urls) {
    const r = await api(IDENTITIES.browser, b.token, u, { raw: true });
    if (r.status !== 200) continue;
    const ct = r.headers.get("content-type") || "";
    if (!/javascript|ecmascript|text\/plain/.test(ct)) continue;
    const code = await r.text();
    if (!code || code.length < 32) continue;
    checked++;
    const needsTx = M63_FATAL.test(code) || /=>|`|\bclass\b/.test(code);
    let out = code;
    if (M63_FATAL.test(code)) {
      let t = null;
      try { t = prodTranspile(Babel, code); } catch { t = null; }
      if (t != null) { out = t; transpiledCount++; }
    }
    if (M63_FATAL.test(out)) fatalSurvivors++;
    if (ITER_THROWER.test(out)) throwerSurvivors++;
    void needsTx;
  }
  check("plugin scripts: production transpile leaves NO M63-fatal syntax", fatalSurvivors === 0,
    `${checked} scripts checked, ${transpiledCount} needed transpile, ${fatalSurvivors} fatal survivors`);
  check("plugin scripts: production config emits NO throwing iterator helper", throwerSurvivors === 0,
    `${throwerSurvivors} _createForOfIteratorHelper survivors`);
}

async function main() {
  console.log("== PART A: Series details content parity (TV vs browser) ==");
  await partA();
  console.log("\n== PART B1: M63 iterate-fix source regression guards ==");
  partB1();
  console.log("\n== PART B2: server-injected plugins transpile M63-safe ==");
  await partB2();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
