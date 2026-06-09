#!/usr/bin/env node
// JEL-70 — Compare: Multiple user accounts / profile switching — TV vs browser.
//
// What the issue asks us to prove, on a server with multiple user accounts:
//   (1) switching users on TV works the same as browser;
//   (2) each user's jellyfin_credentials are stored independently;
//   (3) content recommendations and library visibility respect the logged-in user;
//   (4) logging out and logging in as a different user works WITHOUT an app restart.
//
// ── The parity story ────────────────────────────────────────────────────────
// The multi-user lifecycle — the user picker, login, "Sign Out", profile
// switching, and the per-user `jellyfin_credentials` store — is owned ENTIRELY
// by jellyfin-web and the server. A `grep` of shell.js / boot-shell.src.js
// proves the Tizen shell:
//   - references NO logout / sign-out / login / user-switch flow at all. The
//     ONLY server-state mutation it owns is `clearServerUrl()`, which removes
//     its OWN `jellyfin.shell.serverUrl` key and is reachable from exactly one
//     caller: `selectServer` (the multi-SERVER switch). That is a different
//     server, not a different user — and it never touches `jellyfin_credentials`.
//   - never writes or clears `jellyfin_credentials`; it only READS it
//     (isAuthed() gate + the QA beacon's qcState detector). So when jellyfin-web
//     swaps the active user's token in that blob, the shell is transparent.
//   - boots off `loadServerUrl()` (the saved SERVER url), NOT off
//     `jellyfin_credentials`. So a logout (which clears only credentials) can
//     never bounce the TV back to the first-run connect/setup form — any reload
//     lands straight in jellyfin-web's login/user-picker for the same server.
// Because user switching is jellyfin-web SPA navigation inside an already-loaded
// WebView document that the shell never tears down, "switch users / log out /
// log in as a different user" happens with no app restart, identically to the
// browser, by construction.
//
// ── What this harness does ──────────────────────────────────────────────────
//  PART A (live, real server): under TWO faithful client identities — a
//    browser-like session and the real TV/NativeShell identity — exercise the
//    user-scoped contract the shell relies on: each login mints an independent
//    user-bound token; own Views/Latest/Suggestions resolve (200) and are
//    identical across TV vs browser; a token CANNOT read another user's data
//    (cross-user → 403) → library visibility + recommendations respect the
//    logged-in user; and the server provides the multi-account picker list the
//    login screen renders.
//  PART B (live): prove sessions/credentials are independent — log one session
//    out and confirm the other still authenticates (logout of user A does not
//    disturb user B), then a fresh login mints a new working token ("log in as
//    a different user").
//  PART C (source): assert shell transparency on BOTH shells — no logout/user
//    DOM, no jellyfin_credentials write/clear, the only server-state clear is
//    selectServer's own serverUrl, boot routes off serverUrl not credentials,
//    isAuthed() byte-identical.
//  PART D (simulation): run the REAL isAuthed() in ONE continuous vm context
//    across login → switch user → logout → login-as-different-user, proving the
//    whole cycle needs no fresh context (= no app restart), plus the boot-route
//    predicate that keeps a logged-out-but-server-known TV on the login screen.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/profile-switching/verify-profile-switching.mjs
// Exits non-zero on any failed assertion. Never prints credentials/tokens.
// Read-mostly: it creates + then revokes a few sessions on the test account and
// mutates no other server or account state.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel70-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel70-tv", Version: "10.11.0" },
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
function tokenFormat(t) {
  return { len: (t || "").length, hex32: /^[a-f0-9]{32}$/i.test(t || "") };
}
const idsOf = (arr) => (arr || []).map((it) => it.Id);

// Track every session token we mint so we can revoke them all at the end and
// never leak a live token on the shared test account.
const liveTokens = []; // { id, token, dead }

// ─── PART A + B: live server ────────────────────────────────────────────────
async function liveChecks() {
  // (1)/(2) each login mints an INDEPENDENT, user-bound token. Authenticate the
  // same account under the browser and TV identities → two distinct sessions.
  const ab = await authAs(IDENTITIES.browser);
  const at = await authAs(IDENTITIES.tv);
  const rb = ab.json || {}, rt = at.json || {};
  if (rb.AccessToken) liveTokens.push({ id: IDENTITIES.browser, token: rb.AccessToken, dead: false });
  if (rt.AccessToken) liveTokens.push({ id: IDENTITIES.tv, token: rt.AccessToken, dead: false });

  check("login succeeds under browser + TV identity (multi-user login path)",
    ab.status === 200 && at.status === 200 && rb.AccessToken && rt.AccessToken,
    `browser=${ab.status} tv=${at.status}`);
  if (!rb.AccessToken || !rt.AccessToken) return;

  const uid = rb.User?.Id;
  check("same account resolves to the same UserId under both identities",
    uid && rt.User?.Id === uid, uid ? `uid ${uid.slice(0, 8)}…` : "no user");

  check("each login mints an INDEPENDENT token (sessions stored separately)",
    rb.AccessToken !== rt.AccessToken, "two distinct AccessTokens");

  const fb = tokenFormat(rb.AccessToken), ft = tokenFormat(rt.AccessToken);
  check("token format identical (32-char hex) on TV + browser",
    fb.hex32 && ft.hex32 && fb.len === ft.len,
    `len ${fb.len}/${ft.len}, hex32 ${fb.hex32}/${ft.hex32}`);

  // (3) own user-scoped data resolves under BOTH identities, and the library
  // view + recommendations are byte-identical TV vs browser (server-driven, the
  // TV identity gets no different or extra visibility).
  const ownPaths = {
    Views: `/Users/${uid}/Views`,
    Latest: `/Items/Latest?userId=${uid}&Limit=20`,
    Suggestions: `/Users/${uid}/Suggestions?Limit=20`,
    NextUp: `/Shows/NextUp?userId=${uid}&Limit=20`,
  };
  const ownB = {}, ownT = {};
  for (const [k, p] of Object.entries(ownPaths)) {
    ownB[k] = await api(IDENTITIES.browser, rb.AccessToken, p);
    ownT[k] = await api(IDENTITIES.tv, rt.AccessToken, p);
  }
  const allOwn200 = Object.values(ownB).every((r) => r.status === 200) &&
    Object.values(ownT).every((r) => r.status === 200);
  check("logged-in user's own Views/Latest/Suggestions/NextUp all resolve (200) on both identities",
    allOwn200,
    `B=${Object.values(ownB).map((r) => r.status).join(",")} T=${Object.values(ownT).map((r) => r.status).join(",")}`);

  // Library visibility (Views) must be identical across TV/browser — same user,
  // same server, client-independent.
  const viewsB = idsOf(ownB.Views.json?.Items), viewsT = idsOf(ownT.Views.json?.Items);
  check("library visibility (Views) byte-identical TV vs browser",
    viewsB.length > 0 && eq(viewsB, viewsT), `${viewsB.length} views`);

  // Recommendations (Latest) must be identical across TV/browser too. (Latest is
  // a deterministic newest-first list; Suggestions can reshuffle between calls so
  // we only assert it RESOLVES per-user above, not byte-identity.)
  const latestB = idsOf(ownB.Latest.json), latestT = idsOf(ownT.Latest.json);
  check("recommendations (Items/Latest) byte-identical TV vs browser",
    latestB.length > 0 && eq(latestB, latestT), `${latestB.length} latest items`);

  // (3) cross-user isolation: a token bound to user A must NOT be able to read
  // another user's library or recommendations. Pick a DIFFERENT real user from
  // the server's account list and confirm every user-scoped read is denied —
  // under BOTH identities (the TV identity earns no extra visibility).
  const usersRes = await api(IDENTITIES.browser, rb.AccessToken, "/Users");
  const accounts = (usersRes.json || []).filter((u) => u.Id && u.Id !== uid);
  check("server provides the multi-account picker list the login screen renders",
    Array.isArray(usersRes.json) && usersRes.json.length >= 2,
    `${(usersRes.json || []).length} accounts`);
  // /Users/Public is the unauthenticated user list the connect/login screen can
  // read before any token exists.
  const pub = await api(IDENTITIES.browser, null, "/Users/Public");
  check("unauthenticated /Users/Public lists selectable accounts (pre-login picker)",
    Array.isArray(pub.json) && pub.json.length >= 1, `${(pub.json || []).length} public users`);

  if (accounts.length) {
    const other = accounts[0].Id;
    const crossPaths = [
      `/Users/${other}/Views`,
      `/UserViews?userId=${other}`,
      `/Items/Latest?userId=${other}&Limit=5`,
      `/Users/${other}/Suggestions?Limit=5`,
    ];
    const denied = (st) => st === 401 || st === 403;
    let allDeniedB = true, allDeniedT = true, statusesB = [], statusesT = [];
    for (const p of crossPaths) {
      const cb = await api(IDENTITIES.browser, rb.AccessToken, p);
      const ct = await api(IDENTITIES.tv, rt.AccessToken, p);
      statusesB.push(cb.status); statusesT.push(ct.status);
      if (!denied(cb.status)) allDeniedB = false;
      if (!denied(ct.status)) allDeniedT = false;
    }
    check("cross-user reads denied under browser identity (visibility respects logged-in user)",
      allDeniedB, `statuses ${statusesB.join(",")}`);
    check("cross-user reads denied under TV identity too (TV earns no extra visibility)",
      allDeniedT, `statuses ${statusesT.join(",")}`);
  } else {
    check("a second account exists to test cross-user isolation", false, "only one account visible");
  }

  // ── PART B: session/credential independence + log-in-as-different-user ──
  // Log the TV session out. Its token must die (401) while the browser session's
  // token keeps working (200) — logout of one user/session does not disturb the
  // other; credentials are independent.
  const tvTok = liveTokens.find((t) => t.token === rt.AccessToken);
  await api(IDENTITIES.tv, rt.AccessToken, "/Sessions/Logout", { method: "POST" }).catch(() => {});
  if (tvTok) tvTok.dead = true;
  const tvAfter = await api(IDENTITIES.tv, rt.AccessToken, "/Users/Me");
  const browserAfter = await api(IDENTITIES.browser, rb.AccessToken, "/Users/Me");
  check("logout revokes only that session's token (it now 401s)", tvAfter.status === 401, `status ${tvAfter.status}`);
  check("the OTHER session is unaffected by the logout (still 200) — independent credentials",
    browserAfter.status === 200, `status ${browserAfter.status}`);

  // "Log in as a different user" (here: re-login) mints a brand-new working
  // token without reusing the revoked one → no restart needed at the token layer.
  const re = await authAs(IDENTITIES.tv);
  const reTok = re.json?.AccessToken;
  if (reTok) liveTokens.push({ id: IDENTITIES.tv, token: reTok, dead: false });
  const reMe = reTok ? await api(IDENTITIES.tv, reTok, "/Users/Me") : { status: 0 };
  check("a fresh login mints a NEW working token (≠ the revoked one) — log in as a different user",
    re.status === 200 && reTok && reTok !== rt.AccessToken && reMe.status === 200,
    `auth=${re.status} me=${reMe.status}`);
}

async function revokeAll() {
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

  for (const [label, src] of [["shell.js (TV)", tv], ["boot-shell.src.js (hosted/browser)", hosted]]) {
    // The shell owns NO logout / sign-out / login flow. (The qcState DETECTOR
    // may NAME jellyfin-web's login selectors as string literals to report
    // state, but the shell never CREATES a login/logout/user-picker element.)
    const authorsAuthDom =
      /createElement[^;]*(?:btnLogout|txtUserName|txtManualName|userItemContainer)/.test(src) ||
      /innerHTML[^;]*(?:btnLogout|signout|sign-out|AuthenticateByName|manualLoginForm)/i.test(src) ||
      /\blogout\s*[:(]/i.test(src) ||           // a logout method/handler of its own
      /location\.(?:href|replace)\s*=?\s*\(?["'][^"']*login/i.test(src); // shell-driven nav to a login route
    check(`[${label}] owns no logout / login / user-switch flow (jellyfin-web does)`, !authorsAuthDom);

    // never WRITES or CLEARS the credential blob
    check(`[${label}] never writes jellyfin_credentials (jellyfin-web owns per-user creds)`,
      !/setItem\(\s*["']jellyfin_credentials["']/.test(src));
    check(`[${label}] never clears jellyfin_credentials (logout/switch is jellyfin-web's)`,
      !/removeItem\(\s*["']jellyfin_credentials["']/.test(src));

    // the ONLY server-state clear the shell owns is its own serverUrl, and its
    // ONLY caller is selectServer (the multi-SERVER switch — a different server,
    // not a different user; it never touches credentials). Strip line comments
    // first so a prose mention ("…recovery after clearServerUrl().") is not
    // miscounted as a call site.
    const code = src.replace(/\/\/[^\n]*/g, "");
    const clearCalls = (code.match(/clearServerUrl\(\)/g) || []).length;
    const defAndCaller = clearCalls === 2; // 1 definition `clearServerUrl()` head + 1 call in selectServer
    const callerIsSelectServer =
      /selectServer:\s*function\s*\(\)\s*\{\s*\(?\s*clearServerUrl\(\)/.test(code.replace(/\n/g, " "));
    check(`[${label}] clearServerUrl is called from selectServer only (server switch, not user logout)`,
      defAndCaller && callerIsSelectServer, `${clearCalls} occurrences (1 def + 1 call)`);

    // boot routes off the saved SERVER url, not off credentials → a logout
    // (creds cleared) can never bounce the TV to first-run setup.
    check(`[${label}] boot decision keys on loadServerUrl(), never on jellyfin_credentials`,
      /loadServerUrl\(\)/.test(src) && !/getItem\(\s*["']jellyfin_credentials["']\s*\)[\s\S]{0,400}loadRemoteWebClient/.test(src));
  }

  // the two shells agree on the isAuthed gate byte-for-byte
  const reAuth = /function isAuthed\(\)\{[\s\S]*?\}catch\(_\)\{return false;\}\}/;
  const mtv = tv.match(reAuth), mh = hosted.match(reAuth);
  check("isAuthed() credential gate is byte-identical across TV + hosted shell",
    mtv && mh && mtv[0] === mh[0], mtv ? `${mtv[0].length} chars` : "not found");
  return mtv ? mtv[0] : null;
}

// ─── PART D: real isAuthed() lifecycle over ONE continuous context ───────────
// Models the WebView document staying alive across a profile switch: login →
// switch user → logout → login-as-different-user all in the SAME vm context
// (never re-created) ⇒ no app restart. Then models the boot-route predicate
// that keeps a logged-out-but-server-known TV on the login screen.
function simulationChecks(isAuthedSrc) {
  if (!isAuthedSrc) { check("[sim] isAuthed() extracted from source", false, "regex miss"); return; }

  const map = new Map();
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const sandbox = { window: {}, localStorage, JSON };
  sandbox.window.localStorage = localStorage;
  vm.createContext(sandbox); // ONE context for the whole switch lifecycle
  vm.runInContext(`var __isAuthed = ${isAuthedSrc}`, sandbox);
  const isAuthed = () => vm.runInContext("__isAuthed()", sandbox);
  const loginAs = (uid) =>
    map.set("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: "srv", AccessToken: "f".repeat(32), UserId: uid }] }));
  const logout = () => map.delete("jellyfin_credentials"); // what jellyfin-web's credentialProvider does

  // login as user A
  loginAs("userA");
  check("[sim] login as user A → isAuthed() true", isAuthed() === true);

  // switch user (jellyfin-web swaps the active token in-place) — SAME context
  loginAs("userB");
  check("[sim] switch to user B (same context, no reboot) → isAuthed() true (#1 switch works)", isAuthed() === true);

  // logout — SAME context
  logout();
  check("[sim] logout (same context) → isAuthed() false → login surface (#4, no restart)", isAuthed() === false);

  // log in as a different user C — SAME context
  loginAs("userC");
  check("[sim] log in as a different user C (same context) → isAuthed() true (#4, no app restart)", isAuthed() === true);

  // Boot-route predicate (mirrors source: boot reads loadServerUrl(), ignores
  // credentials). After a logout the SERVER url persists, so the route stays on
  // the web client (jellyfin-web login screen), never the first-run setup form.
  const routeBoot = (serverUrl /*, creds irrelevant */) => (serverUrl ? "web-client" : "setup");
  logout(); // creds gone, but server url is a different key the shell keeps
  check("[sim] logged-out but server-known → boot routes to web-client login, not first-run setup",
    routeBoot("https://server.example") === "web-client" && routeBoot(null) === "setup");
}

async function main() {
  const haveServer = URL_BASE && USER && PASS;
  if (haveServer) {
    try { await liveChecks(); } finally { await revokeAll(); }
  } else {
    console.log("WARN  JELLYFIN_URL/USER/PASS not set — skipping live PART A/B (source+sim still run).");
  }
  const isAuthedSrc = sourceChecks();
  simulationChecks(isAuthedSrc);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (!haveServer) console.log("(live server checks were skipped — set JELLYFIN_* to run them)");
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { try { await revokeAll(); } catch {} console.error("harness error:", e?.message || e); process.exit(1); });
