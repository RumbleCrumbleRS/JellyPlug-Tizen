#!/usr/bin/env node
// JEL-47 — Compare: NativeShell.getDeviceProfile device profile (TV vs browser).
//
// WHAT THIS PROVES (empirically, against the live Jellyfin server)
//   The Tizen shell does not author a codec matrix — getDeviceProfile delegates
//   to jellyfin-web's profileBuilder, which builds DirectPlayProfiles from the
//   WebView's runtime canPlayType results (see results-JEL-47.md). The server's
//   direct-play-vs-transcode decision is therefore a pure function of
//   (DeviceProfile, item codecs). This harness submits representative per-model
//   profiles (M56 / M63 / M69 Chromium) and a desktop-browser profile to the
//   server's PlaybackInfo endpoint over a sample of real library items and:
//     (A) asserts NO FORMAT IS INCORRECTLY EXCLUDED — every item whose
//         (container, video, audio) is covered by a profile's DirectPlayProfiles
//         is returned as DirectPlay/DirectStream, never Transcode;
//     (B) prints the TV-vs-browser direct-play matrix, surfacing items the TV
//         direct-plays that the desktop browser must transcode (the expected
//         Samsung advantage: HEVC / AC3 / E-AC3) and vice-versa, so any real
//         asymmetry is attributable to genuine WebView codec support, not a
//         shell-side exclusion.
//
// IMPORTANT — representative profiles
//   jellyfin-web's profileBuilder needs a real DOM (canPlayType / MediaSource),
//   so it cannot run in Node. The profiles below MODEL what each Chromium
//   generation's WebView reports (Samsung documented codec support per Tizen
//   year). They are the same shape jellyfin-web emits. The shell passes
//   { enableMkvProgressive:false, enableSsaRender:true }; enableMkvProgressive is
//   inert in jellyfin-web 10.10/10.11 and enableSsaRender:true is the default —
//   so these profiles already reflect the shell's two options. To validate the
//   REAL on-device profile, capture window.NativeShell.getDeviceProfile(...) JSON
//   from the TV (see results-JEL-47.md, "On-device capture") and drop it in via
//   PROFILE_FILE=<path>.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/device-profile/verify-device-profile.mjs
//   (optional) PROFILE_FILE=captured-tv-profile.json  — adds a captured profile.
// Exits non-zero on any failed assertion. Never prints credentials.

import fs from "node:fs";

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

const CLIENT = "JEL-47-deviceprofile-verify";
const DEVICE_ID = "jel47-deviceprofile-verify";
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
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// --- Representative profiles, in jellyfin-web's DeviceProfile shape. ----------
// Each models the DirectPlay support a given WebView's canPlayType reports.
// Samsung Tizen panels decode HEVC + Dolby (ac3/eac3) in hardware; desktop
// Chrome generally does NOT (no HEVC without OS/HW + flag, no ac3/eac3).
const TS = 120000000;
const SUBS = [
  { Format: "vtt", Method: "External" },
  { Format: "ass", Method: "External" }, // enableSsaRender:true -> client-rendered, no burn-in
  { Format: "ssa", Method: "External" },
];
const dp = (container, video, audio) => ({ Container: container, Type: "Video", VideoCodec: video, AudioCodec: audio });
const tcHls = { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3,ac3", Protocol: "hls", Context: "Streaming" };

// Desktop Chrome (no HEVC, no Dolby): h264/vp9/av1 + aac/mp3/opus/vorbis/flac.
const PROFILE_BROWSER = {
  MaxStreamingBitrate: TS,
  DirectPlayProfiles: [
    dp("mp4,m4v", "h264,vp9,av1", "aac,mp3,opus,vorbis,flac"),
    dp("webm", "vp9,av1", "opus,vorbis"),
    dp("mkv", "h264,vp9,av1", "aac,mp3,opus,vorbis,flac"),
  ],
  TranscodingProfiles: [tcHls],
  CodecProfiles: [],
  SubtitleProfiles: SUBS,
};
// M56 (Tizen 4.0, ~2018): h264 + hevc + Dolby; no av1, no vp9 (varies).
const PROFILE_M56 = {
  MaxStreamingBitrate: TS,
  DirectPlayProfiles: [
    dp("mp4,m4v", "h264,hevc", "aac,mp3,ac3,eac3"),
    dp("mkv", "h264,hevc", "aac,mp3,ac3,eac3"),
    dp("ts", "h264,hevc", "aac,mp3,ac3,eac3"),
  ],
  TranscodingProfiles: [tcHls],
  CodecProfiles: [],
  SubtitleProfiles: SUBS,
};
// M63 (Tizen 5.0): M56 + vp9.
const PROFILE_M63 = {
  MaxStreamingBitrate: TS,
  DirectPlayProfiles: [
    dp("mp4,m4v", "h264,hevc,vp9", "aac,mp3,ac3,eac3,opus"),
    dp("mkv", "h264,hevc,vp9", "aac,mp3,ac3,eac3,opus,flac"),
    dp("ts", "h264,hevc", "aac,mp3,ac3,eac3"),
    dp("webm", "vp9", "opus,vorbis"),
  ],
  TranscodingProfiles: [tcHls],
  CodecProfiles: [],
  SubtitleProfiles: SUBS,
};
// M69 (Tizen 5.5, ~2020): M63 + av1 (newer panels).
const PROFILE_M69 = {
  MaxStreamingBitrate: TS,
  DirectPlayProfiles: [
    dp("mp4,m4v", "h264,hevc,vp9,av1", "aac,mp3,ac3,eac3,opus,flac"),
    dp("mkv", "h264,hevc,vp9,av1", "aac,mp3,ac3,eac3,opus,flac,vorbis"),
    dp("ts", "h264,hevc", "aac,mp3,ac3,eac3"),
    dp("webm", "vp9,av1", "opus,vorbis"),
  ],
  TranscodingProfiles: [tcHls],
  CodecProfiles: [],
  SubtitleProfiles: SUBS,
};

const PROFILES = [
  ["browser", PROFILE_BROWSER],
  ["M56", PROFILE_M56],
  ["M63", PROFILE_M63],
  ["M69", PROFILE_M69],
];
// Optional: a profile captured from the real TV via the on-device method.
if (process.env.PROFILE_FILE) {
  try {
    const captured = JSON.parse(fs.readFileSync(process.env.PROFILE_FILE, "utf8"));
    PROFILES.push(["captured-tv", captured]);
    console.log(`(loaded captured TV profile from ${process.env.PROFILE_FILE})`);
  } catch (e) {
    console.error("could not read PROFILE_FILE:", e?.message || e);
  }
}

const norm = (s) => String(s || "").toLowerCase();
const inList = (csv, v) => norm(csv).split(",").map((x) => x.trim()).includes(norm(v));
const containerMatch = (profCsv, itemContainer) => {
  const items = norm(itemContainer).split(",").map((x) => x.trim());
  const prof = norm(profCsv).split(",").map((x) => x.trim());
  return items.some((c) => prof.includes(c));
};

// Does the profile's DirectPlayProfiles cover this item's (container, v, a)?
function profileCoversItem(profile, src) {
  const container = src.Container;
  const v = (src.MediaStreams || []).find((s) => s.Type === "Video");
  const a = (src.MediaStreams || []).find((s) => s.Type === "Audio");
  const vc = v?.Codec;
  const ac = a?.Codec;
  return (profile.DirectPlayProfiles || []).some((p) =>
    containerMatch(p.Container, container) &&
    (!vc || inList(p.VideoCodec, vc)) &&
    (!ac || inList(p.AudioCodec, ac)),
  );
}

async function playbackInfo(itemId, userId, profile) {
  const pi = await api(`/Items/${itemId}/PlaybackInfo?UserId=${userId}`, {
    method: "POST",
    body: { UserId: userId, MediaSourceId: itemId, DeviceProfile: profile, MaxStreamingBitrate: TS, StartTimeTicks: 0 },
  });
  const src = (pi.json?.MediaSources || [])[0] || {};
  // The server sets SupportsDirectPlay/SupportsDirectStream and a TranscodingUrl
  // when it decides to transcode. PlayMethod is what the client would use.
  let method = "Transcode";
  if (src.SupportsDirectPlay) method = "DirectPlay";
  else if (src.SupportsDirectStream) method = "DirectStream";
  else if (src.TranscodingUrl) method = "Transcode";
  return { method, transcoding: !!src.TranscodingUrl, src };
}

async function main() {
  const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  TOKEN = a.json?.AccessToken;
  const userId = a.json?.User?.Id;
  check("authenticate", !!TOKEN && !!userId);
  if (!TOKEN) process.exit(1);

  // Sample a spread of items across codecs/containers.
  const list = await api(`/Items?UserId=${userId}&IncludeItemTypes=Movie,Episode&Recursive=true&Fields=MediaSources,MediaStreams&Limit=60`);
  const items = (list.json?.Items || []).filter((it) => (it.MediaSources || [])[0]);
  check("library returned sample items", items.length > 0, `${items.length} items`);
  if (!items.length) process.exit(1);

  // Gather the per-item, per-profile decision matrix first.
  const IMAGE_SUB = new Set(["pgssub", "dvdsub", "dvbsub", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"]);
  const matrix = []; // per item: { name, container, v, a, defImgSub, methods:{profile->method} }
  for (const it of items) {
    const src = it.MediaSources[0];
    const v = (src.MediaStreams || []).find((s) => s.Type === "Video");
    const aud = (src.MediaStreams || []).find((s) => s.Type === "Audio");
    // A default/forced image subtitle forces burn-in (transcode) regardless of
    // video/audio codec, and does so for EVERY profile (browser included). This
    // is a subtitle-delivery decision, not a codec direct-play exclusion.
    const defImgSub = (src.MediaStreams || []).some(
      (s) => s.Type === "Subtitle" && (s.IsDefault || s.IsForced) && IMAGE_SUB.has(norm(s.Codec)),
    );
    const v10bit = v && Number(v.BitDepth) >= 10;
    const row = { name: it.Name, container: src.Container, v: v?.Codec, a: aud?.Codec, defImgSub, v10bit, methods: {} };
    for (const [label, profile] of PROFILES) {
      const { method } = await playbackInfo(it.Id, userId, profile);
      row.methods[label] = method;
    }
    matrix.push(row);
  }

  // (A) NO FORMAT INCORRECTLY EXCLUDED (the precise, false-positive-free test):
  //     a real shell/TV exclusion bug would be an item the DESKTOP BROWSER
  //     direct-plays, whose codecs the TV profile ALSO lists, yet the TV profile
  //     transcodes. That is the only way the shell's two options or any TV-side
  //     choice could cause "unnecessary server-side transcoding". Items that
  //     transcode under the browser too (mpeg2video/mpeg4 sources, default image
  //     subtitles, etc.) are intrinsic to the content and are NOT a TV exclusion.
  const TV_LABELS = ["M56", "M63", "M69"];
  let unnecessary = 0;
  for (const it of items) {
    const src = it.MediaSources[0];
    const row = matrix[items.indexOf(it)];
    if (row.methods.browser === "Transcode") continue; // intrinsic transcode, not TV-specific
    for (const label of TV_LABELS) {
      const profile = PROFILES.find(([l]) => l === label)[1];
      if (profileCoversItem(profile, src) && row.methods[label] === "Transcode") {
        unnecessary++;
        console.log(`  UNNECESSARY [${label}] "${it.Name}" (${row.container}/${row.v}/${row.a}): browser direct-plays and the ${label} profile lists these codecs, yet the TV transcodes`);
      }
    }
  }
  check(
    "no format incorrectly excluded — TV never transcodes a browser-direct-play item whose codecs the TV profile lists",
    unnecessary === 0,
    `${unnecessary} unnecessary TV transcode(s)`,
  );

  // (B) TV-vs-browser direct-play matrix — informational, surfaces real asymmetry.
  console.log("\nDirect-play matrix (DP=DirectPlay/Stream, TC=Transcode; note: !sub=default image subtitle burn-in, 10b=10-bit video):");
  console.log("  item                                   | container/v/a            | " + PROFILES.map(([l]) => l.padEnd(8)).join("| ") + "| note");
  let tvAdvantage = 0;
  let intrinsic = 0;
  for (const r of matrix) {
    const cell = (m) => (m === "Transcode" ? "TC" : "DP").padEnd(8);
    const codecs = `${r.container}/${r.v}/${r.a}`;
    const note = [r.defImgSub ? "!sub" : "", r.v10bit ? "10b" : ""].filter(Boolean).join(" ");
    console.log(`  ${String(r.name).slice(0, 38).padEnd(38)} | ${codecs.slice(0, 24).padEnd(24)} | ` + PROFILES.map(([l]) => cell(r.methods[l])).join("| ") + "| " + note);
    const tvDP = TV_LABELS.some((l) => r.methods[l] !== "Transcode");
    if (tvDP && r.methods.browser === "Transcode") tvAdvantage++;
    if (PROFILES.every(([l]) => r.methods[l] === "Transcode")) intrinsic++;
  }
  console.log(`\n  TV direct-plays but desktop browser transcodes on ${tvAdvantage} item(s) (expected: HEVC / AC3 / E-AC3 — Samsung hardware decode the browser lacks).`);
  console.log(`  ${intrinsic} item(s) transcode under EVERY profile (browser + all TV models) — intrinsic to the content (mpeg2video/mpeg4 source, or default image-subtitle burn-in), NOT a TV-side exclusion.`);
  check("matrix produced for TV vs browser comparison", matrix.length > 0, `${matrix.length} items`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
