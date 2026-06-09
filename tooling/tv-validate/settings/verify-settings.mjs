#!/usr/bin/env node
// JEL-55 — Compare: Settings pages (display, navigation, save) — TV vs browser.
//
// The Settings ("My Preferences") section is 100% jellyfin-web/server-driven.
// The Tizen shell does NOT implement, wrap, or customize any settings code path:
//   - `grep` of shell.js / boot-shell.src.js finds ZERO references to
//     DisplayPreferences, user Configuration, SubtitleLanguagePreference,
//     AudioLanguagePreference, subtitle size, or any settings form. The only
//     localStorage keys the shell owns are shell-internal (serverUrl, bundle
//     cache, _deviceId2, layout="tv").
//   - Settings NAVIGATION is jellyfin-web's focusManager. D-pad reaches every
//     category exactly as in the browser; on TV the shell's JEL-1580 body-focus
//     -rescue + proactive auto-focuser (validated under JEL-33) only guarantees
//     the focus ring LANDS on a focusable control after a page/hash change — it
//     never changes which controls exist or how they're traversed.
//   - Settings PERSISTENCE is server-side, and on BOTH backends the storage key
//     is device-agnostic, so a value saved on TV is byte-identical when read on
//     the browser and survives an app restart (a restart is just a new login /
//     token against the same server state):
//       (a) Language / playback prefs  -> POST /Users/{uid}/Configuration
//           Fields: SubtitleLanguagePreference, AudioLanguagePreference,
//           SubtitleMode, PlayDefaultAudioTrack, ... Stored on the USER, not the
//           client — global to every device.
//       (b) Display / appearance prefs -> POST /DisplayPreferences/usersettings
//           jellyfin-web ALWAYS calls getDisplayPreferences("usersettings",uid,
//           "emby") / updateDisplayPreferences(...,"emby") with the FIXED client
//           literal "emby" (verified against the live 10.11.10 main bundle), NOT
//           the device Client header. So the TV (Client="Jellyfin Shell for
//           Tizen") and the browser (Client="Jellyfin Web") share ONE
//           DisplayPreferences bucket. Subtitle size, theme, skip lengths, etc.
//           live in its CustomPrefs map.
//
// This harness proves SAVE + cross-client parity + persist-across-restart by
// driving each backend under two distinct client identities (a browser-like and
// a real-TV NativeShell identity), plus a third fresh "restart" session, and
// asserting the written value round-trips identically on every read. It also
// unit-tests the shell's __qaIsSettingsView() detector (extracted verbatim from
// shell.js) against the REAL jellyfin-web 10.11 settings routes and a set of
// non-settings routes. All mutations are restored at the end.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/settings/verify-settings.mjs
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

// Two faithful client identities + a third "fresh restart" session. The TV
// identity mirrors the shell's NativeShell.AppHost values (see memory:
// nativeshell-apphost-identity-values). The DeviceId differs per identity on
// purpose — it proves persistence is NOT keyed on the device.
const IDENTITIES = {
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel55-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel55-tv", Version: "10.11.0" },
  restart: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel55-tv-restart", Version: "10.11.0" },
};

function authHeader(id, token) {
  const base = `MediaBrowser Client="${id.Client}", Device="${id.Device}", DeviceId="${id.DeviceId}", Version="${id.Version}"`;
  return token ? `${base}, Token="${token}"` : base;
}
async function api(id, token, path, { method = "GET", body } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(id, token), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}
async function authAs(id) {
  const a = await api(id, null, "/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  return { token: a.json?.AccessToken, uid: a.json?.User?.Id };
}

// ---------------------------------------------------------------------------
// PART 1 — __qaIsSettingsView() detector, extracted VERBATIM from
// packages/shell-tizen/src/shell.js (the QA-overlay settings detector). Runs
// the real shell logic against real routes — no fetch, pure unit test.
// ---------------------------------------------------------------------------
function makeQaIsSettingsView(hash, bodyClass) {
  return function __qaIsSettingsView() {
    var h = String(hash || "").toLowerCase();
    if (/(preferences|displaysettings|languagesettings|playbacksettings|subtitlesettings|homesettings|quicksettings|dashboard|userprofile|usersettings|settings\.html)/.test(h)) return true;
    var b = bodyClass || "";
    if (/(dashboardDocument|userPreferencesPage|preferencesContainer)/.test(b)) return true;
    return false;
  };
}

function testSettingsDetector() {
  // Real jellyfin-web 10.11 settings routes — extracted from the live
  // main.jellyfin.bundle.js served by the test server (10.11.10).
  const SETTINGS_HASHES = [
    "#/mypreferencesmenu",
    "#/mypreferencesdisplay",
    "#/mypreferenceshome",
    "#/mypreferencesplayback",
    "#/mypreferencessubtitles",
    "#/mypreferencescontrols",
    "#/mypreferencesquickconnect",
    "#/userprofile",
    "#/dashboard",
    "#/dashboard/settings",
  ];
  const NON_SETTINGS_HASHES = [
    "",
    "#/home.html",
    "#/movies.html?topParentId=abc",
    "#/details?id=123",
    "#/video?index=0",
    "#/list.html?parentId=xyz",
    "#/search.html",
    "#/livetv.html",
    "#/music.html",
  ];
  let allTrue = true;
  for (const h of SETTINGS_HASHES) {
    const ok = makeQaIsSettingsView(h, "")();
    if (!ok) allTrue = false;
    if (!ok) console.log(`    settings hash NOT detected: ${h}`);
  }
  check("__qaIsSettingsView() returns true on all real settings routes", allTrue,
    `${SETTINGS_HASHES.length}/${SETTINGS_HASHES.length} settings routes detected`);

  let allFalse = true;
  for (const h of NON_SETTINGS_HASHES) {
    const ok = makeQaIsSettingsView(h, "")();
    if (ok) allFalse = false;
    if (ok) console.log(`    non-settings hash MISdetected: ${h || "(empty)"}`);
  }
  check("__qaIsSettingsView() returns false on non-settings routes", allFalse,
    `${NON_SETTINGS_HASHES.length}/${NON_SETTINGS_HASHES.length} non-settings routes correctly excluded`);

  // body-className branch: dashboard/preferences pages set these classes even
  // when the hash alone wouldn't match.
  const bodyTrue = makeQaIsSettingsView("#/anything", "layout-tv dashboardDocument")() &&
    makeQaIsSettingsView("#/x", "userPreferencesPage")() &&
    makeQaIsSettingsView("#/x", "preferencesContainer libraryPage")();
  check("__qaIsSettingsView() body-class branch detects preferences/dashboard documents", bodyTrue,
    "dashboardDocument / userPreferencesPage / preferencesContainer");
  const bodyFalse = !makeQaIsSettingsView("#/home", "layout-tv libraryDocument")();
  check("__qaIsSettingsView() body-class branch ignores non-settings documents", bodyFalse,
    "libraryDocument not misdetected");
}

// ---------------------------------------------------------------------------
// PART 2 — server user Configuration (language / playback prefs). Save on TV,
// read on browser + fresh "restart" session, restore.
// ---------------------------------------------------------------------------
async function getConfig(id, token, uid) {
  const u = await api(id, token, `/Users/${uid}`);
  return u.json?.Configuration || null;
}
async function putConfig(id, token, uid, cfg) {
  return api(id, token, `/Users/${uid}/Configuration`, { method: "POST", body: cfg });
}

async function testServerConfiguration(sessions, uid) {
  const { tv, browser, restart } = sessions;
  const original = await getConfig(tv.id, tv.token, uid);
  check("read current user Configuration (TV identity)", !!original,
    original ? `SubtitleMode=${original.SubtitleMode} AudioLangPref=${JSON.stringify(original.AudioLanguagePreference)}` : "null");
  if (!original) return;

  // Pick test values that differ from current, covering the ticket's exact
  // examples: "preferred audio language" + subtitle prefs.
  const want = JSON.parse(JSON.stringify(original));
  want.AudioLanguagePreference = original.AudioLanguagePreference === "jpn" ? "eng" : "jpn";
  want.SubtitleLanguagePreference = original.SubtitleLanguagePreference === "fre" ? "ger" : "fre";
  want.SubtitleMode = original.SubtitleMode === "Always" ? "OnlyForced" : "Always";

  // SAVE on the TV identity.
  const save = await putConfig(tv.id, tv.token, uid, want);
  check("save Configuration change on TV identity (audio/subtitle language + mode)", save.status >= 200 && save.status < 300,
    `HTTP ${save.status}`);

  // READ on the BROWSER identity -> changes are saved + visible cross-client.
  const onBrowser = await getConfig(browser.id, browser.token, uid);
  const browserMatch = onBrowser &&
    onBrowser.AudioLanguagePreference === want.AudioLanguagePreference &&
    onBrowser.SubtitleLanguagePreference === want.SubtitleLanguagePreference &&
    onBrowser.SubtitleMode === want.SubtitleMode;
  check("Configuration change saved correctly + identical on browser identity", browserMatch,
    browserMatch ? `audio=${onBrowser.AudioLanguagePreference} sub=${onBrowser.SubtitleLanguagePreference} mode=${onBrowser.SubtitleMode}`
      : `got audio=${onBrowser?.AudioLanguagePreference} sub=${onBrowser?.SubtitleLanguagePreference} mode=${onBrowser?.SubtitleMode}`);

  // READ on a FRESH session (= app restart) -> persists across restarts.
  const onRestart = await getConfig(restart.id, restart.token, uid);
  const restartMatch = onRestart &&
    onRestart.AudioLanguagePreference === want.AudioLanguagePreference &&
    onRestart.SubtitleLanguagePreference === want.SubtitleLanguagePreference &&
    onRestart.SubtitleMode === want.SubtitleMode;
  check("Configuration prefs persist across restart (fresh TV session)", restartMatch,
    restartMatch ? "preferred audio language + subtitle prefs retained after re-login"
      : `got audio=${onRestart?.AudioLanguagePreference} mode=${onRestart?.SubtitleMode}`);

  // RESTORE.
  const restore = await putConfig(tv.id, tv.token, uid, original);
  const after = await getConfig(tv.id, tv.token, uid);
  const restored = after &&
    after.AudioLanguagePreference === original.AudioLanguagePreference &&
    after.SubtitleLanguagePreference === original.SubtitleLanguagePreference &&
    after.SubtitleMode === original.SubtitleMode;
  check("user Configuration restored to original", restore.status < 300 && restored,
    restored ? "restored" : "STILL MODIFIED");
}

// ---------------------------------------------------------------------------
// PART 3 — DisplayPreferences usersettings/emby (display / appearance prefs,
// e.g. subtitle size). Save on TV, read on browser + restart, restore.
// ---------------------------------------------------------------------------
const DP_PATH = (uid) => `/DisplayPreferences/usersettings?userId=${uid}&client=emby`;
async function getDP(id, token, uid) {
  const r = await api(id, token, DP_PATH(uid));
  return r.json || null;
}
async function putDP(id, token, uid, dp) {
  return api(id, token, DP_PATH(uid), { method: "POST", body: dp });
}

async function testDisplayPreferences(sessions, uid) {
  const { tv, browser, restart } = sessions;
  const dpTv = await getDP(tv.id, tv.token, uid);
  const dpBrowser = await getDP(browser.id, browser.token, uid);
  // Proof the TWO device identities read the SAME bucket (fixed "emby" client).
  const sameBucket = dpTv && dpBrowser && dpTv.Id === dpBrowser.Id && dpTv.Client === "emby" && dpBrowser.Client === "emby";
  check("TV + browser read ONE shared DisplayPreferences bucket (client=emby)", sameBucket,
    sameBucket ? `Id=${dpTv.Id.slice(0, 8)}… Client=emby (device Client header ignored)` : "different/absent buckets");
  if (!dpTv) return;

  // Save a scoped test key (mimics e.g. subtitle text size) so we never clobber
  // a real user setting. CustomPrefs is the exact map jellyfin-web stores
  // subtitle appearance / skip lengths / theme under.
  const original = JSON.parse(JSON.stringify(dpTv));
  const TEST_KEY = "jel55-subtitleTextSize";
  const TEST_VAL = "Larger";
  const mutated = JSON.parse(JSON.stringify(dpTv));
  mutated.CustomPrefs = mutated.CustomPrefs || {};
  mutated.CustomPrefs[TEST_KEY] = TEST_VAL;

  const save = await putDP(tv.id, tv.token, uid, mutated);
  check("save display setting on TV identity (CustomPrefs round-trip)", save.status >= 200 && save.status < 300,
    `HTTP ${save.status}`);

  const onBrowser = await getDP(browser.id, browser.token, uid);
  const browserMatch = onBrowser?.CustomPrefs?.[TEST_KEY] === TEST_VAL;
  check("display setting saved + identical on browser identity", browserMatch,
    browserMatch ? `${TEST_KEY}=${onBrowser.CustomPrefs[TEST_KEY]}` : `got ${JSON.stringify(onBrowser?.CustomPrefs?.[TEST_KEY])}`);

  const onRestart = await getDP(restart.id, restart.token, uid);
  const restartMatch = onRestart?.CustomPrefs?.[TEST_KEY] === TEST_VAL;
  check("display setting persists across restart (fresh TV session)", restartMatch,
    restartMatch ? "subtitle-size-style display pref retained after re-login" : "lost after restart");

  // RESTORE: write back original (drops the test key) and confirm it's gone.
  const restore = await putDP(tv.id, tv.token, uid, original);
  const after = await getDP(tv.id, tv.token, uid);
  const restored = restore.status < 300 && !(after?.CustomPrefs && Object.prototype.hasOwnProperty.call(after.CustomPrefs, TEST_KEY));
  check("DisplayPreferences restored (test key removed)", restored,
    restored ? "restored" : "TEST KEY STILL PRESENT");
}

// ---------------------------------------------------------------------------
async function main() {
  // PART 1 needs no network.
  testSettingsDetector();

  // Three sessions, same user.
  const tv = { id: IDENTITIES.tv, ...(await authAs(IDENTITIES.tv)) };
  const browser = { id: IDENTITIES.browser, ...(await authAs(IDENTITIES.browser)) };
  const restart = { id: IDENTITIES.restart, ...(await authAs(IDENTITIES.restart)) };
  check("authenticate (tv + browser + fresh-restart sessions, same user)",
    tv.token && browser.token && restart.token && tv.uid === browser.uid && browser.uid === restart.uid,
    tv.uid ? `uid ${tv.uid.slice(0, 8)}…` : "no token");
  if (!tv.token || !browser.token || !restart.token) process.exit(1);
  const sessions = { tv, browser, restart };
  const uid = tv.uid;

  await testServerConfiguration(sessions, uid);
  await testDisplayPreferences(sessions, uid);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
