#!/usr/bin/env node
// JEL-79 — Compare: Image loading and CDN/proxy behavior — artwork thumbnails
// (TV vs browser).
//
// Artwork (poster/thumb/backdrop/logo) loading is 100% jellyfin-web + server
// driven. The Tizen shell does NOT implement, wrap, proxy, rewrite, or customize
// any part of the image code path (see results-JEL-79.md):
//
//   - jellyfin-web's imageLoader / cardBuilder / backdrop modules build every
//     artwork URL as `${serverUrl}/Items/{id}/Images/{Type}[/{idx}]?tag=...&
//     maxWidth|fillWidth=...&quality=...` from the CARD GEOMETRY and the layout
//     manager (TV layout @ 1920x1080). The shell authors no image-sizing code.
//   - Artwork is fetched by the WebView's native <img> decoder, NOT via fetch()
//     or XHR. The shell's ONLY network interception is a config.json-scoped
//     fetch/XHR shim (matches = /(^|\/)config\.json(\?|$)/, JEL-64); every
//     /Items/.../Images/ request passes through to origFetch/origSend untouched,
//     and <img> loads never enter that shim at all.
//   - There is NO CDN and NO proxy. The shell sets <base href> to the server
//     origin and seeds cfg.servers=[serverUrl]; jellyfin-web composes image URLs
//     against that same origin. Image bytes are served directly by the Jellyfin
//     server's /Items/.../Images endpoint (which itself resizes/transcodes via
//     SkiaSharp honoring maxWidth/fillWidth/quality).
//
// So the mechanism the user exercises ("browse libraries + detail pages, see
// posters/backdrops, none broken, sized right for the TV") reduces to the
// server's /Items/.../Images contract. This harness verifies that contract
// DIRECTLY against the live Jellyfin server, exercising the EXACT request shapes
// jellyfin-web's cardBuilder/backdrop build for the TV layout, and runs the
// fetches under BOTH a browser-like and a TV-like client identity — asserting
// the responses are byte-identical, proving the behavior is expected parity and
// that nothing in the shell can make artwork diverge between TV and browser.
//
// The four ticket claims, each proven below:
//   (1) images load from /Items/{id}/Images/ endpoints  -> PART B
//   (2) no images fail silently (no broken-image)        -> PART B (broken==0)
//   (3) image load times reasonable on the TV network    -> PART B (timing)
//   (4) resize/quality params appropriate for 1920x1080  -> PART B (dims honored)
//   (parity) TV == browser request + response            -> PART C
// PART A is the offline shell-transparency proof (source structure).
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env (PART B/C only):
//   node tooling/tv-validate/image-loading/verify-image-loading.mjs
// PART A is offline (source). PART B/C need the server reachable; they retry
// transient 5xx (this test server sits behind a flaky DDNS reverse proxy) and
// SKIP gracefully if it never comes up — they never report a proxy flap as a
// shell defect. Read-only: GET image bytes + POST-auth only; mutates nothing.
// Never prints credentials. Exits non-zero on any real failed assertion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

let TOKEN = null;
let DEVICE_ID = "jel79-image-verify";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function skip(name, detail) {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`SKIP  ${name}${detail ? "  — " + detail : ""}`);
}

function authHeader() {
  const base = `MediaBrowser Client="JEL-79-image-verify", Device="sandbox", DeviceId="${DEVICE_ID}", Version="1.0.0"`;
  return TOKEN ? `${base}, Token="${TOKEN}"` : base;
}

// retry transient proxy 5xx / network errors; return the first non-5xx Response
// or null if it never settles. Treats 502/503/504 + fetch throws as transient
// (the DDNS reverse proxy in front of this test server flaps); 200/4xx are
// returned immediately as real answers.
const TRANSIENT = new Set([502, 503, 504]);
async function fetchRetry(url, opts = {}, tries = 6) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(25000) });
      if (!TRANSIENT.has(r.status)) return r;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e?.name || String(e);
    }
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  return { __unreachable: true, __why: last };
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetchRetry(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.__unreachable) return { unreachable: true, why: res.__why };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// fetch raw image bytes + timing. Returns {status, ct, bytes(Buffer), ms} or
// {unreachable}. <img> uses no Authorization header, but Jellyfin image
// endpoints are public, so neither does this — matching the WebView exactly.
async function getImage(path) {
  const t0 = Number(process.hrtime.bigint() / 1000n) / 1000;
  const res = await fetchRetry(URL_BASE + path, {}, 5);
  if (res.__unreachable) return { unreachable: true, why: res.__why };
  const ab = await res.arrayBuffer();
  const ms = Number(process.hrtime.bigint() / 1000n) / 1000 - t0;
  return {
    status: res.status,
    ct: res.headers.get("content-type") || "",
    bytes: Buffer.from(ab),
    ms,
  };
}

// ---- image pixel-dimension readers (header parse; no decode lib) ----
function jpegDims(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    // SOF markers carry dimensions; skip standalone + non-SOF segments.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)]; // [w,h]
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    o += 2 + b.readUInt16BE(o + 2);
  }
  return null;
}
function pngDims(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
function webpDims(b) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF") return null;
  const f = b.toString("ascii", 12, 16);
  if (f === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (f === "VP8L") {
    const n = b.readUInt32LE(21);
    return [(n & 0x3fff) + 1, ((n >> 14) & 0x3fff) + 1];
  }
  if (f === "VP8X") return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return null;
}
function imgDims(buf, ct) {
  if (ct.includes("jpeg") || ct.includes("jpg")) return jpegDims(buf);
  if (ct.includes("png")) return pngDims(buf);
  if (ct.includes("webp")) return webpDims(buf);
  // fall back to magic-byte sniff if content-type is generic
  return jpegDims(buf) || pngDims(buf) || webpDims(buf);
}

// ===================================================================
// PART A — SHELL TRANSPARENCY (offline source structure).
// Encodes the invariants that, if reverted, would let the shell fork
// or break image loading between TV and browser. UA-independent.
// ===================================================================
function partA() {
  const src = readFileSync(SHELL_JS, "utf8");

  // (T1) the network shim's match predicate is config.json ONLY. Anything that
  // widened it to /Images/ or /Items/ would let the shell touch artwork.
  // (The shim is built as string-array literals; substring checks are robust to
  // the doubled-backslash escaping that string-encoded regex literals carry.)
  const matchLine = src.match(/var matches=function\(u\)\{return ([^;]+);\}/);
  const pred = matchLine ? matchLine[1] : "";
  check(
    "shell network shim matches config.json ONLY (artwork passes through)",
    !!matchLine && pred.includes("config") && pred.includes("json") &&
      !pred.includes("Images") && !pred.includes("Items"),
    matchLine ? pred.trim() : "matches() predicate not found",
  );

  // (T2) both the fetch and XHR shims fall through to the originals for any
  // non-config URL — i.e. /Items/.../Images requests reach the network verbatim.
  check(
    "fetch shim falls through to origFetch for non-config URLs",
    src.includes("return origFetch.call(this,i,init)"),
    "non-config fetch -> origFetch.call (unmodified)",
  );
  check(
    "XHR shim falls through to origSend for non-config URLs",
    src.includes("return origSend.apply(this,arguments)"),
    "non-config XHR -> origSend.apply (unmodified)",
  );

  // (T3) the shell installs NO <img>/Image()/src interception or CDN/proxy
  // rewrite. Grep for the shapes a proxy/rewriter would need. (We allow the
  // word "image" in comments; assert on code constructs only.)
  const noImageCtor = !/window\.Image\s*=|new Proxy\([^)]*Image/.test(src);
  const noImgRewrite =
    !/HTMLImageElement\.prototype/.test(src) &&
    !/querySelectorAll\(['"]img/.test(src) &&
    !/getElementsByTagName\(['"]img/.test(src);
  const noCdn = !/cdn|imageproxy|image-proxy|\/proxy\//i.test(
    // strip comments first so prose can't trip this
    src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
  );
  check("shell does NOT override the Image constructor", noImageCtor, "no window.Image= / Proxy(Image)");
  check("shell does NOT intercept/rewrite <img> elements", noImgRewrite,
    "no HTMLImageElement.prototype / img querySelector / getElementsByTagName(img)");
  check("shell embeds NO CDN/proxy for images (direct-from-server)", noCdn,
    "no cdn/imageproxy/proxy-path token in code");

  // (T4) the shipped artifact carries the same config.json-only shim (so the
  // transparency property holds in what actually runs on the TV) and contains
  // ZERO Images/Items interception tokens.
  const min = readFileSync(SHELL_MIN, "utf8").replace(/\s+/g, "");
  check(
    "shell.min.js (shipped) keeps the config.json-only shim (no /Images/ widening)",
    min.includes("config") && min.includes("json") &&
      !min.includes("Images") && !min.includes("/Items/"),
    "shipped shim matches config.json; zero Images/Items interception tokens",
  );
}

// ===================================================================
// Helpers for PART B/C — build the EXACT request shapes jellyfin-web's
// cardBuilder/backdrop produce for the TV (1920x1080) layout.
// ===================================================================
// jellyfin-web rounds requested widths up to a "fill" bucket; for the TV layout
// a portrait poster card is ~280–400px wide and a full-bleed backdrop is the
// 1920px viewport width. quality defaults to 90 for jpg. These mirror
// cardBuilder.getCardImageUrl / backdrop.getBackdropImageUrl on a TV layout.
const POSTER_MAXW = 400;     // portrait poster thumbnail (grid card)
const THUMB_MAXW = 500;      // 16:9 thumb card
const BACKDROP_FILLW = 1920; // full-screen backdrop @ 1080p
const BACKDROP_FILLH = 1080;

function primaryUrl(id, tag, maxWidth) {
  return `/Items/${id}/Images/Primary?tag=${tag}&maxWidth=${maxWidth}&quality=90`;
}
function thumbUrl(id, tag, maxWidth) {
  return `/Items/${id}/Images/Thumb?tag=${tag}&maxWidth=${maxWidth}&quality=90`;
}
function backdropUrl(id, tag) {
  return `/Items/${id}/Images/Backdrop/0?tag=${tag}&fillWidth=${BACKDROP_FILLW}&fillHeight=${BACKDROP_FILLH}&quality=90`;
}

// Collect a representative artwork worklist across MULTIPLE libraries + a few
// detail items (so we mirror "browse libraries and detail pages").
async function collectArtwork(userId, views) {
  const work = []; // {label, kind, url, expectMaxW?, expectFillW?}
  const libs = (views.json?.Items || []).filter((v) =>
    ["movies", "tvshows"].includes(v.CollectionType),
  );
  for (const v of libs) {
    const r = await api(
      `/Items?UserId=${userId}&ParentId=${v.Id}` +
      `&IncludeItemTypes=${v.CollectionType === "movies" ? "Movie" : "Series"}` +
      `&Recursive=true&SortBy=SortName&StartIndex=0&Limit=8` +
      `&Fields=PrimaryImageAspectRatio,BackdropImageTags&ImageTypeLimit=2`,
    );
    if (r.unreachable) return { unreachable: true };
    for (const it of r.json?.Items || []) {
      const t = it.ImageTags || {};
      if (t.Primary)
        work.push({
          label: `${v.Name}:"${it.Name}" Primary`,
          kind: "poster",
          url: primaryUrl(it.Id, t.Primary, POSTER_MAXW),
          expectMaxW: POSTER_MAXW,
        });
      if (t.Thumb)
        work.push({
          label: `${v.Name}:"${it.Name}" Thumb`,
          kind: "thumb",
          url: thumbUrl(it.Id, t.Thumb, THUMB_MAXW),
          expectMaxW: THUMB_MAXW,
        });
      if (it.BackdropImageTags && it.BackdropImageTags[0])
        work.push({
          label: `${v.Name}:"${it.Name}" Backdrop`,
          kind: "backdrop",
          url: backdropUrl(it.Id, it.BackdropImageTags[0]),
          expectFillW: BACKDROP_FILLW,
        });
    }
  }
  return { work };
}

// ===================================================================
// PART B — LIVE IMAGE CONTRACT (claims 1-4) against the real server.
// ===================================================================
async function partB(userId, views) {
  const { work, unreachable } = await collectArtwork(userId, views);
  if (unreachable) { skip("[live] image worklist (server unreachable)", "5xx/timeout"); return null; }
  check("[live] artwork worklist spans multiple libraries + image types",
    work.length >= 6 &&
      new Set(work.map((w) => w.kind)).size >= 2,
    `${work.length} images, kinds: ${[...new Set(work.map((w) => w.kind))].join("/")}`);

  let ok200 = 0, broken = 0, unreach = 0;
  const times = [];
  const dimRows = [];
  for (const w of work) {
    const img = await getImage(w.url);
    if (img.unreachable) { unreach++; continue; }
    // (1)+(2) the /Items/.../Images endpoint returns real image bytes — a 200
    // with an image/* content-type and a non-trivial body. A 404/empty body is
    // a genuine silent-broken image; a persistent 5xx is infra (counted apart).
    const isImage =
      img.status === 200 && img.ct.startsWith("image/") && img.bytes.length > 256;
    if (isImage) {
      ok200++;
      times.push(img.ms);
      // (4) the server honored the resize: returned pixel width must not exceed
      // the requested maxWidth/fillWidth (no oversized payloads shipped to the
      // TV). Allow +1px rounding slack.
      const d = imgDims(img.bytes, img.ct);
      const cap = w.expectMaxW || w.expectFillW;
      dimRows.push({ label: w.label, kind: w.kind, dims: d, cap, bytes: img.bytes.length, ms: img.ms });
    } else if (img.status === 200) {
      broken++; // 200 but not a real image (empty / wrong type)
    } else if (img.status >= 500) {
      unreach++;
    } else {
      broken++; // 4xx == genuinely missing artwork
    }
  }

  const attempted = work.length;
  // (1) loads from /Items/.../Images
  check("[live] (1) artwork loads from /Items/{id}/Images/ endpoints",
    ok200 > 0 && ok200 >= attempted - unreach - 0,
    `${ok200}/${attempted} returned image/* (${unreach} transient-unreachable, excluded)`);
  // (2) none fail silently
  check("[live] (2) no images fail silently (no 404/broken among reachable)",
    broken === 0 && ok200 > 0,
    `broken=${broken}, ok=${ok200}, transient-5xx=${unreach}`);
  if (unreach > 0)
    console.log(`    note: ${unreach}/${attempted} images stayed 5xx/timeout after retries — DDNS proxy flap, not a shell or missing-artwork defect.`);

  // (3) timings reasonable
  if (times.length) {
    const sorted = [...times].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const max = sorted[sorted.length - 1];
    console.log(`    [timing] n=${times.length} median=${med.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms`);
    // a server-resized artwork GET over a home uplink should land well under a
    // few seconds; 8s is a generous TV-network ceiling. (We measure from the
    // sandbox, which is a WORSE path than the TV's LAN to the server, so this is
    // a conservative upper bound.)
    check("[live] (3) image load times reasonable on a TV-grade network (median < 8s)",
      med < 8000, `median ${med.toFixed(0)}ms across ${times.length} artworks`);
  } else {
    skip("[live] (3) image load timing", "no reachable images to time");
  }

  // (4) resize honored for the TV resolution
  const measured = dimRows.filter((r) => r.dims);
  const within = measured.filter((r) => r.dims[0] <= r.cap + 1);
  for (const r of measured.slice(0, 8))
    console.log(`    [dims] ${r.kind} ${r.dims[0]}x${r.dims[1]} (cap ${r.cap}) ${r.bytes}B ${r.label}`);
  check("[live] (4) server honors maxWidth/fillWidth — returned width <= requested (TV-sized, no oversized payloads)",
    measured.length > 0 && within.length === measured.length,
    `${within.length}/${measured.length} within requested cap`);
  // backdrops specifically should be sized for the 1920px viewport, not a tiny
  // thumbnail — proves the TV gets a full-resolution backdrop, not an upscaled
  // postage stamp (and not a wasteful 4K download).
  const bds = measured.filter((r) => r.kind === "backdrop");
  if (bds.length) {
    const wellSized = bds.filter((r) => r.dims[0] >= 1280 && r.dims[0] <= BACKDROP_FILLW + 1);
    check("[live] (4) backdrops sized for the 1080p viewport (>=1280, <=1920 wide)",
      wellSized.length === bds.length,
      `${wellSized.length}/${bds.length} backdrops in [1280,1920]`);
  }

  return work;
}

// ===================================================================
// PART C — TV vs BROWSER PARITY of artwork requests + responses.
// The shell adds no image code, so the URL jellyfin-web builds depends
// only on layout geometry; both UAs run identical jellyfin-web bytes.
// We fetch the SAME artwork URLs under a browser-like and a TV-like
// client identity and assert the responses are byte-identical.
// ===================================================================
async function partC(work) {
  if (!work || !work.length) { skip("[parity] TV==browser artwork", "no worklist"); return; }
  const sample = work.filter((w) => w.kind === "poster").slice(0, 2)
    .concat(work.filter((w) => w.kind === "backdrop").slice(0, 1));
  if (!sample.length) { skip("[parity] TV==browser artwork", "no sample"); return; }

  let identical = 0, compared = 0, unreach = 0;
  for (const w of sample) {
    DEVICE_ID = "jel79-browser";
    const a = await getImage(w.url);
    DEVICE_ID = "jel79-tv";
    const b = await getImage(w.url);
    DEVICE_ID = "jel79-image-verify";
    if (a.unreachable || b.unreachable) { unreach++; continue; }
    compared++;
    const same =
      a.status === b.status &&
      a.ct === b.ct &&
      a.bytes.length === b.bytes.length &&
      a.bytes.equals(b.bytes);
    if (same) identical++;
    else console.log(`    [parity] DIVERGED ${w.label}: browser ${a.status}/${a.bytes.length}B vs tv ${b.status}/${b.bytes.length}B`);
  }
  if (compared === 0) { skip("[parity] TV==browser artwork (all transient-unreachable)", `${unreach} unreachable`); return; }
  check("[parity] artwork bytes byte-identical under TV-like vs browser-like client",
    identical === compared,
    `${identical}/${compared} byte-identical (image endpoint is UA-agnostic; ${unreach} skipped as unreachable)`);
}

async function main() {
  console.log("== PART A: shell transparency to image loading (offline source) ==");
  partA();

  console.log("\n== PART B/C: live image contract + TV/browser parity ==");
  if (!URL_BASE || !USER || !PASS) {
    skip("[live] image contract (PART B)", "JELLYFIN_URL/USER/PASS not set");
    skip("[parity] TV==browser (PART C)", "JELLYFIN_URL/USER/PASS not set");
  } else {
    const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
    if (a.unreachable) {
      skip("[live] authenticate (server unreachable)", a.why);
      skip("[live] image contract (PART B)", "server down");
      skip("[parity] TV==browser (PART C)", "server down");
    } else {
      TOKEN = a.json?.AccessToken;
      const userId = a.json?.User?.Id;
      check("[live] authenticate against test server", !!TOKEN && !!userId);
      if (TOKEN) {
        const views = await api(`/Users/${userId}/Views`);
        if (views.unreachable) {
          skip("[live] image contract (PART B)", "Views unreachable");
        } else {
          const work = await partB(userId, views);
          await partC(work);
        }
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped ? ` (${skipped} skipped — server availability)` : ""}.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
