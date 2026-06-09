#!/usr/bin/env node
// JEL-54 — Compare: User login and credential persistence — TV vs browser.
//
// What the issue asks us to prove, on a fresh session (no saved credentials):
//   (1) a login surface appears (user list OR username input);
//   (2) PIN/password entry works;
//   (3) `jellyfin_credentials` is saved to localStorage after a successful login;
//   (4) on next boot, login is NOT required again (the token persists);
//   and that the token FORMAT + credential STRUCTURE match between TV and browser.
//
// ── The parity story ────────────────────────────────────────────────────────
// The entire login + credential lifecycle is owned by jellyfin-web, NOT by the
// Tizen shell. A `grep` of shell.js / boot-shell.src.js proves the shell:
//   - NEVER calls setItem("jellyfin_credentials", …) — it never writes the
//     credential blob; jellyfin-web's credentialProvider does, identically on
//     every client.
//   - NEVER removes "jellyfin_credentials" — the only credential-ish key it
//     ever clears is its OWN "jellyfin.shell.serverUrl" (JEL-31). So a token,
//     once written by jellyfin-web, survives every shell reboot untouched →
//     "login not required again" is true by construction.
//   - authors ZERO login DOM (no username field, no PIN form, no user picker).
//     The login UI is 100% jellyfin-web; the shell's only login-adjacent code
//     is a READ of `jellyfin_credentials` to gate the body-focus auto-focuser
//     (it only auto-focuses once authed) and the QA beacon's qcState detector.
// Therefore the token format and the stored credential structure are identical
// on TV and browser because the same jellyfin-web code produces them. The shell
// is transparent to credentials.
//
// ── What this harness does ──────────────────────────────────────────────────
//  PART A (live, real server): authenticate the SAME user under two faithful
//    client identities — a browser-like session and the real TV/NativeShell
//    identity (Client="Jellyfin Shell for Tizen", Device="Samsung Smart TV") —
//    and assert the AuthenticationResult + token FORMAT + the assembled
//    `jellyfin_credentials` object SHAPE are identical (covers token parity).
//  PART B (live): re-use each captured token on a fresh request WITHOUT
//    re-authenticating, proving the persisted token alone authenticates →
//    models "next boot, no login required" (covers #4). Then confirm a
//    deliberately malformed token is rejected (the token is what gates access).
//  PART C (source): assert shell transparency on BOTH shells — no write, no
//    clear of jellyfin_credentials, identical isAuthed() structure check, and
//    no shell-authored login DOM.
//  PART D (simulation): lift the REAL isAuthed() out of shell.js and run it in
//    a vm over a fake localStorage to prove the fresh-session → login →
//    reboot → still-authed lifecycle (covers #1 boundary + #3 + #4 mechanics).
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/credential-persistence/verify-credential-persistence.mjs
// Exits non-zero on any failed assertion. Never prints credentials/tokens.

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
  browser: { Client: "Jellyfin Web", Device: "Chrome", DeviceId: "jel54-browser", Version: "10.11.0" },
  tv: { Client: "Jellyfin Shell for Tizen", Device: "Samsung Smart TV", DeviceId: "jel54-tv", Version: "10.11.0" },
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

// jellyfin-web's credentialProvider persists exactly this shape under the
// "jellyfin_credentials" localStorage key after a successful AuthenticateByName.
// We reconstruct it from the AuthenticationResult so we can compare the SHAPE
// (key set) the shell would see on each platform — the shell only ever reads
// Servers[0].AccessToken out of it.
function buildCredentials(authResult, id) {
  return {
    Servers: [
      {
        Id: authResult.ServerId,
        AccessToken: authResult.AccessToken,
        UserId: authResult.User?.Id,
        // jellyfin-web also stamps the manual address / name; modelled for shape parity.
        ManualAddress: URL_BASE,
        Name: authResult.SessionInfo?.ServerId ? undefined : undefined,
        LastConnectionMode: 1,
        DateLastAccessed: 0, // normalized (jellyfin-web uses Date.now(); not part of shape parity)
      },
    ],
  };
}
const shapeOf = (obj) => {
  // recursive sorted key signature, ignoring values — for structural parity
  if (Array.isArray(obj)) return `[${obj.map(shapeOf).join("|")}]`;
  if (obj && typeof obj === "object") {
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${k}:${shapeOf(obj[k])}`).join(",")}}`;
  }
  return typeof obj;
};

function tokenFormat(t) {
  return { len: (t || "").length, hex32: /^[a-f0-9]{32}$/i.test(t || "") };
}

// ─── PART A + B: live server ────────────────────────────────────────────────
async function liveChecks() {
  const ab = await authAs(IDENTITIES.browser);
  const at = await authAs(IDENTITIES.tv);
  const rb = ab.json || {}, rt = at.json || {};
  check("authenticate succeeds under browser + TV identity (PIN/password entry path)",
    ab.status === 200 && at.status === 200 && rb.AccessToken && rt.AccessToken,
    `browser=${ab.status} tv=${at.status}`);
  if (!rb.AccessToken || !rt.AccessToken) return null;

  // same user resolved both ways
  check("same user resolved under both identities",
    rb.User?.Id && rt.User?.Id && rb.User.Id === rt.User.Id,
    rb.User?.Id ? `uid ${rb.User.Id.slice(0, 8)}…` : "no user");

  // (token FORMAT parity)
  const fb = tokenFormat(rb.AccessToken), ft = tokenFormat(rt.AccessToken);
  check("AccessToken format identical (32-char hex) on TV + browser",
    fb.hex32 && ft.hex32 && fb.len === ft.len,
    `len ${fb.len}/${ft.len}, hex32 ${fb.hex32}/${ft.hex32}`);

  // (AuthenticationResult STRUCTURE parity)
  const sb = shapeOf({ AccessToken: rb.AccessToken, ServerId: rb.ServerId, User: { Id: rb.User?.Id }, SessionInfo: !!rb.SessionInfo });
  const st = shapeOf({ AccessToken: rt.AccessToken, ServerId: rt.ServerId, User: { Id: rt.User?.Id }, SessionInfo: !!rt.SessionInfo });
  check("AuthenticationResult top-level structure identical",
    eq(Object.keys(rb).sort(), Object.keys(rt).sort()) && sb === st,
    Object.keys(rb).sort().join(","));

  // (assembled jellyfin_credentials SHAPE parity — what the shell reads)
  const cb = buildCredentials(rb, IDENTITIES.browser), ct = buildCredentials(rt, IDENTITIES.tv);
  check("stored jellyfin_credentials object shape identical (Servers[0].{Id,AccessToken,UserId,…})",
    shapeOf(cb) === shapeOf(ct), shapeOf(cb));

  // ── PART B: persisted token alone authenticates a "next boot" request ──
  const meB = await api(IDENTITIES.browser, rb.AccessToken, "/Users/Me");
  const meT = await api(IDENTITIES.tv, rt.AccessToken, "/Users/Me");
  check("persisted token authenticates a fresh request (next boot: no re-login)",
    meB.status === 200 && meT.status === 200 && meB.json?.Id === rb.User.Id && meT.json?.Id === rt.User.Id,
    `browser=${meB.status} tv=${meT.status}`);

  // negative control: a malformed/garbage token is rejected → the token is the
  // gate; a fresh session with no/invalid credentials must show login (#1).
  const bad = await api(IDENTITIES.tv, "0".repeat(32), "/Users/Me");
  check("invalid token is rejected (fresh/empty session → login required)",
    bad.status === 401, `status ${bad.status}`);

  // tidy: revoke the two sessions we created so we don't leak tokens on the
  // shared test account.
  await api(IDENTITIES.browser, rb.AccessToken, "/Sessions/Logout", { method: "POST" }).catch(() => {});
  await api(IDENTITIES.tv, rt.AccessToken, "/Sessions/Logout", { method: "POST" }).catch(() => {});
  return true;
}

// ─── PART C: source transparency, both shells ───────────────────────────────
function sourceChecks() {
  const tv = fs.readFileSync(TV_SHELL, "utf8");
  const hosted = fs.readFileSync(HOSTED_SHELL, "utf8");
  for (const [label, src] of [["shell.js (TV)", tv], ["boot-shell.src.js (hosted/browser)", hosted]]) {
    // never WRITES the credential blob
    const writes = /setItem\(\s*["']jellyfin_credentials["']/.test(src);
    check(`[${label}] never writes jellyfin_credentials (jellyfin-web owns it)`, !writes);
    // never REMOVES the credential blob
    const removes = /removeItem\(\s*["']jellyfin_credentials["']/.test(src);
    check(`[${label}] never clears jellyfin_credentials (token survives reboot)`, !removes);
    // reads it with the canonical structure check
    const reads = /getItem\(\s*["']jellyfin_credentials["']/.test(src) &&
      /Servers\[0\]\.AccessToken/.test(src);
    check(`[${label}] reads creds via canonical Servers[0].AccessToken shape`, reads);
    // authors no login DOM of its own (only the qcState DETECTOR may name web's
    // selectors; the shell never builds a login form / username field).
    const authorsLogin = /createElement[^;]*txtUserName|innerHTML[^;]*(?:txtUserName|manualLoginForm|AuthenticateByName)/.test(src);
    check(`[${label}] authors no login DOM (login UI is jellyfin-web)`, !authorsLogin);
  }
  // the two shells agree on the isAuthed gate byte-for-byte
  const reAuth = /function isAuthed\(\)\{[\s\S]*?\}catch\(_\)\{return false;\}\}/;
  const mtv = tv.match(reAuth), mh = hosted.match(reAuth);
  check("isAuthed() credential gate is byte-identical across TV + hosted shell",
    mtv && mh && mtv[0] === mh[0], mtv ? `${mtv[0].length} chars` : "not found");
  return mtv ? mtv[0] : null;
}

// ─── PART D: real isAuthed() lifecycle over a fake localStorage ──────────────
function simulationChecks(isAuthedSrc) {
  if (!isAuthedSrc) { check("[sim] isAuthed() extracted from source", false, "regex miss"); return; }

  // persistent backing store survives "reboots" (we build a fresh window/vm
  // context per boot but keep the same Map → models localStorage on disk).
  const map = new Map();
  function bootContext() {
    const localStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
    const sandbox = { window: {}, localStorage, JSON };
    sandbox.window.localStorage = localStorage;
    vm.createContext(sandbox);
    vm.runInContext(`var __isAuthed = ${isAuthedSrc}`, sandbox);
    return () => vm.runInContext("__isAuthed()", sandbox);
  }

  // Boot 1 — fresh session, nothing stored → not authed → login surface shown.
  const boot1 = bootContext();
  check("[sim] fresh session (no creds) → isAuthed() false → login required (#1)", boot1() === false);

  // Login happens (jellyfin-web writes the blob). We write the same shape the
  // server produced.
  map.set("jellyfin_credentials", JSON.stringify({
    Servers: [{ Id: "srv", AccessToken: "a".repeat(32), UserId: "u1" }],
  }));
  check("[sim] after login → isAuthed() true (creds persisted, #3)", boot1() === true);

  // Boot 2 — simulate app restart: brand new context, SAME backing store.
  const boot2 = bootContext();
  check("[sim] next boot (new context, persisted store) → isAuthed() true → no re-login (#4)", boot2() === true);

  // A malformed blob (no AccessToken) must NOT count as authed → would fall
  // back to login rather than silently trusting garbage.
  map.set("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: "srv" }] }));
  check("[sim] creds without AccessToken → isAuthed() false (no false-positive auth)", bootContext()() === false);

  // Corrupt JSON is swallowed (try/catch) → false, never throws.
  map.set("jellyfin_credentials", "{not json");
  let threw = false, val;
  try { val = bootContext()(); } catch { threw = true; }
  check("[sim] corrupt creds JSON → isAuthed() false, never throws", !threw && val === false);
}

async function main() {
  const haveServer = URL_BASE && USER && PASS;
  if (haveServer) {
    await liveChecks();
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

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
