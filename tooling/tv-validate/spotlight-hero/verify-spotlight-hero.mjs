#!/usr/bin/env node
// JEL-48 — Compare: Home screen spotlight hero renders and auto-advances (TV vs browser).
//
// The "spotlight/hero banner" is NOT a jellyfin-web core feature — it is the
// server-side **Editor's Choice** plugin, which injects a <script> into
// /web/index.html that builds a Splide carousel inside `.homeSectionsContainer`
// (see [[jel17-spotlight-runtime-not-transpile]], [[test-server-plugins-and-harness]]).
// Everything the JEL-48 ticket asks about is owned by that plugin + Splide +
// jellyfin-web, and the Tizen shell is provably transparent to all of it
// (the shell's only keydown preventDefault is BACK/10009 — see
// [[jel42-playback-controls-parity]]). So TV behavior is identical to a desktop
// browser BY CONSTRUCTION, and the only TV-specific code in the plugin is
// server-config-gated (`hideOnTvLayout`) or a focus *enhancement*.
//
// The four behaviors the ticket lists map to the plugin source like this:
//   (1) correct backdrop image  -> each slide's background-image is
//       `../Items/{id}/Images/Backdrop/0{size}`. With reduceImageSizes:false
//       (this server) there is NO size param, so the URL is device-independent.
//   (2) auto-advance interval    -> `new Splide(..., { autoplay: !!data.autoplay,
//       interval: data.autoplayInterval })`. Both come from ONE server config
//       blob (`/EditorsChoice/favourites`), delivered identically to every client.
//   (3) left/right arrow nav     -> `new Splide(..., { keyboard: true })` + the
//       splide__arrow prev/next buttons. Same plugin bytes => same behavior.
//   (4) OK/Enter -> details      -> every slide is
//       `<a href="{base}#/details?id={id}" onclick="Emby.Page.showItem('{id}')">`.
//       Identical markup; the target id must resolve to a real item.
//
// This harness verifies that server contract directly against the live Jellyfin
// server, the same way the JEL-43 audio-track harness does. It proves:
//   * the plugin script is byte-identical regardless of client User-Agent
//     (browser UA vs a Samsung Tizen UA) -> autoplay/keyboard/anchor logic is
//     literally the same code on TV and browser, with no UA branch;
//   * the auto-advance config (autoplay + interval) is a single server value;
//   * the spotlight is NOT hidden on TV on this server (hideOnTvLayout:false);
//   * every spotlight item's backdrop image resolves at the device-independent
//     URL the plugin builds;
//   * every spotlight item's details target id resolves to the correct item.
//
// What this does NOT do: render Splide in a headless browser and watch the
// timer tick. Splide's autoplay/keyboard are upstream library behavior; driving
// it would test Splide, not parity. The DOM-level render + D-pad reachability of
// the hero on the real M63 TV is JEL-17 (resolved: hero renders, watchBtn=18,
// heroEls=1) and the browser D-pad path is JEL-33.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/spotlight-hero/verify-spotlight-hero.mjs
// Exits non-zero on any failed assertion. Never prints credentials.

import { createHash } from "node:crypto";

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

const CLIENT = "JEL-48-spotlight-verify";
const DEVICE_ID = "jel48-spotlight-verify";
// A desktop-browser UA and a real Samsung Tizen TV UA. The Editor's Choice
// script is a static server asset; if it had any UA branch these would diverge.
const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const UA_TV =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.0 TV Safari/537.36";

let TOKEN = null;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function authHeader() {
  const base = `MediaBrowser Client="${CLIENT}", Device="sandbox", DeviceId="${DEVICE_ID}", Version="1.0.0"`;
  return TOKEN ? `${base}, Token="${TOKEN}"` : base;
}
async function api(path, { method = "GET", body, ua } = {}) {
  const headers = { Authorization: authHeader(), "Content-Type": "application/json" };
  if (ua) headers["User-Agent"] = ua;
  const res = await fetch(URL_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}
async function head(path) {
  // image endpoints: confirm the asset exists and is an image, without pulling bytes
  const res = await fetch(URL_BASE + path, { method: "GET", headers: { Authorization: authHeader() } });
  // drain the body so the socket frees up
  await res.arrayBuffer().catch(() => {});
  return { status: res.status, type: res.headers.get("content-type") || "" };
}

function sha(s) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

async function main() {
  // --- auth ---
  const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  TOKEN = a.json?.AccessToken;
  const userId = a.json?.User?.Id;
  check("authenticate", !!TOKEN && !!userId);
  if (!TOKEN) process.exit(1);

  // --- the spotlight is the Editor's Choice plugin; confirm it is injected ---
  // (the plugin transforms /web/index.html to add its <script src=/EditorsChoice/script>)
  const scriptBrowser = await api("/EditorsChoice/script", { ua: UA_BROWSER });
  const scriptTv = await api("/EditorsChoice/script", { ua: UA_TV });
  check("Editor's Choice spotlight plugin script served", scriptBrowser.status === 200 && scriptBrowser.text.length > 1000,
    `${scriptBrowser.text.length} bytes`);

  // --- (1/2/3/4) the SAME plugin bytes drive TV and browser (no UA branch) ---
  // This is the load-bearing parity fact: identical script => identical Splide
  // autoplay/interval, identical keyboard arrow handling, identical anchor click.
  const shB = sha(scriptBrowser.text);
  const shT = sha(scriptTv.text);
  check("plugin script byte-identical for browser UA and Tizen TV UA", shB === shT && scriptTv.status === 200,
    `browser=${shB} tv=${shT}`);

  // sanity: the script really is the Splide hero builder, with keyboard nav,
  // autoplay/interval wiring, and the details-page anchor onclick.
  const s = scriptBrowser.text;
  check("plugin builds a Splide carousel with keyboard arrow nav", /new Splide/.test(s) && /keyboard:\s*true/.test(s),
    "new Splide({ keyboard:true, ... })");
  check("plugin wires autoplay + interval from server config", /autoplay:\s*!!data\.autoplay/.test(s) && /interval:\s*data\.autoplayInterval/.test(s));
  check("plugin slides navigate to details via showItem + #/details?id=", /Emby\.Page\.showItem/.test(s) && /#\/details\?id=/.test(s));

  // --- fetch the single server config that both clients consume identically ---
  const fav = await api("/EditorsChoice/favourites");
  const cfg = fav.json || {};
  const items = cfg.favourites || [];
  check("spotlight config fetched", fav.status === 200 && typeof cfg.autoplayInterval !== "undefined",
    `autoplay=${cfg.autoplay} interval=${cfg.autoplayInterval}ms useHero=${cfg.useHeroLayout}`);

  // (2) auto-advance: a single server value => identical interval on TV & browser.
  check("auto-advance enabled with a concrete shared interval", cfg.autoplay === true && Number(cfg.autoplayInterval) > 0,
    `${cfg.autoplayInterval}ms (same value delivered to every client)`);

  // TV is NOT excluded from the spotlight on this server (else parity is moot).
  check("spotlight shown on TV layout (hideOnTvLayout=false)", cfg.hideOnTvLayout === false);

  // reduceImageSizes:false => backdrop URL has no window.screen size param, so
  // the backdrop request is device-independent (true parity). Flag if that flips.
  check("backdrop URL is device-independent (reduceImageSizes=false)", cfg.reduceImageSizes === false,
    cfg.reduceImageSizes ? "reduceImageSizes=true would append ?width=screen.width (differs TV vs browser)" : "no size param");

  check("spotlight has favourite items", items.length > 0, `${items.length} items`);
  if (!items.length) { finish(); return; }

  // (1) every slide's backdrop image resolves at the URL the plugin builds:
  //     `../Items/{id}/Images/Backdrop/0` (size param empty here). Same URL for both.
  let allBackdrops = true; const bd = [];
  for (const it of items) {
    const r = await head(`/Items/${it.id}/Images/Backdrop/0`);
    const ok = r.status === 200 && /^image\//.test(r.type);
    if (!ok) allBackdrops = false;
    bd.push(`${(it.name || it.id).slice(0, 18)}:${r.status}${ok ? "✓" : "✗"}`);
  }
  check("(1) every spotlight backdrop image resolves", allBackdrops, bd.join("  "));

  // (4) every slide's details target id resolves to the correct real item.
  // The favourites feed returns dashed GUIDs (used verbatim in the slide's
  // `#/details?id=` href); /Items returns the un-dashed form. Same id, different
  // formatting — jellyfin-web's appRouter accepts either — so compare dash-free.
  const norm = (g) => String(g || "").replace(/-/g, "").toLowerCase();
  let allItems = true; const tg = [];
  for (const it of items) {
    const r = await api(`/Users/${userId}/Items/${it.id}`);
    const ok = r.status === 200 && norm(r.json?.Id) === norm(it.id) && !!r.json?.Name;
    if (!ok) allItems = false;
    tg.push(`${(it.name || it.id).slice(0, 18)}->${ok ? r.json?.Type : r.status}`);
  }
  check("(4) every spotlight details target resolves to its item", allItems, tg.join("  "));

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
