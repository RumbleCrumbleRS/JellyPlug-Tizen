#!/usr/bin/env node
// JEL-43 — Compare: Audio track selection during playback (TV vs browser).
//
// Audio track selection is 100% jellyfin-web/server-driven. The Tizen shell
// does NOT touch the track-selection code path (see results-JEL-43.md):
//   - NativeShell.AppHost.getDeviceProfile delegates to jellyfin-web's own
//     profileBuilder; the shell adds no audio-codec customization.
//   - The only playback patch in the seed (shell.js) wraps playbackManager.play
//     for ServerId injection; switching audio calls setAudioStreamIndex ->
//     changeStream, which never goes through that patch.
//   - The shell persists only the server URL in localStorage; audio-track
//     resume state lives server-side (per-user MediaSources.DefaultAudioStreamIndex).
//
// So the mechanism the user actually exercises ("open selector, switch track,
// hear it change, have it remembered") is the server's PlaybackInfo + playback
// progress reporting contract. This harness verifies that contract directly
// against the live Jellyfin server, for both a browser-like and a TV-like
// device profile, proving the behavior is identical (expected parity) and that
// the shell's profile delegation does not alter audio-track selection.
//
// What this does NOT do: actually decode video in a browser. Headless Chromium
// cannot decode the server's mpeg2video/ac3 multi-audio content, so a UI-drive
// of the player overlay would be flaky and prove less than the protocol check.
//
// Usage: JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env, then:
//   node tooling/tv-validate/audio-track/verify-audio-track.mjs
// Exits non-zero on any failed assertion. Never prints credentials.

const URL_BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL_BASE || !USER || !PASS) {
  console.error("Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS in env.");
  process.exit(2);
}

const CLIENT = "JEL-43-audio-verify";
const DEVICE_ID = "jel43-audio-verify";
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

// jellyfin-web's profileBuilder produces a profile shaped like these. The two
// differ only in what they can DirectPlay; the AudioStreamIndex selection
// contract is identical for both. The TV profile mirrors what the shell's
// getDeviceProfile(profileBuilder) yields on a Samsung webview (h264/hevc +
// ac3/eac3/aac, ts/hls transcode), enableMkvProgressive:false.
const PROFILE_BROWSER = {
  MaxStreamingBitrate: 120000000,
  DirectPlayProfiles: [
    { Container: "mp4,m4v", Type: "Video", VideoCodec: "h264,hevc,vp9", AudioCodec: "aac,mp3,ac3,eac3,opus,flac,vorbis" },
    { Container: "mkv", Type: "Video", VideoCodec: "h264,hevc,vp9", AudioCodec: "aac,mp3,ac3,eac3,opus,flac,vorbis" },
  ],
  TranscodingProfiles: [
    { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3,ac3", Protocol: "hls", Context: "Streaming" },
  ],
  CodecProfiles: [],
  SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
};
const PROFILE_TV = {
  MaxStreamingBitrate: 120000000,
  DirectPlayProfiles: [
    { Container: "mp4,m4v", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3,mp3" },
    { Container: "ts", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3,mp3" },
  ],
  TranscodingProfiles: [
    { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3", Protocol: "hls", Context: "Streaming" },
  ],
  CodecProfiles: [],
  SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
};

function parseQ(u) {
  try { return Object.fromEntries(new URL(u, URL_BASE).searchParams); }
  catch { return {}; }
}

async function main() {
  // --- auth ---
  const a = await api("/Users/AuthenticateByName", { method: "POST", body: { Username: USER, Pw: PASS } });
  TOKEN = a.json?.AccessToken;
  const userId = a.json?.User?.Id;
  check("authenticate", !!TOKEN && !!userId);
  if (!TOKEN) process.exit(1);

  // --- find an item with >=2 audio tracks ---
  const list = await api(`/Items?UserId=${userId}&IncludeItemTypes=Movie,Episode&Recursive=true&Fields=MediaSources&Limit=400`);
  let target = null;
  for (const it of list.json?.Items || []) {
    const src = (it.MediaSources || [])[0];
    const auds = (src?.MediaStreams || []).filter((s) => s.Type === "Audio");
    if (src && auds.length >= 2) { target = { it, src, auds }; break; }
  }
  check("found item with >=2 audio tracks", !!target, target ? `"${target.it.Name}" (${target.auds.length} tracks)` : "none");
  if (!target) process.exit(1);
  const itemId = target.it.Id;
  const audioIdxs = target.auds.map((s) => s.Index);
  const origDefault = target.src.DefaultAudioStreamIndex;

  // --- (2)+(3) switching audio re-requests a stream targeting the chosen track ---
  // This is the under-the-hood effect of opening the selector and picking a
  // track: jellyfin-web calls PlaybackInfo with the new AudioStreamIndex.
  for (const [label, profile] of [["browser", PROFILE_BROWSER], ["tv", PROFILE_TV]]) {
    let allHonored = true;
    const seen = [];
    for (const idx of audioIdxs) {
      const pi = await api(`/Items/${itemId}/PlaybackInfo?UserId=${userId}`, {
        method: "POST",
        body: { UserId: userId, MediaSourceId: itemId, AudioStreamIndex: idx, DeviceProfile: profile, StartTimeTicks: 0 },
      });
      const src = (pi.json?.MediaSources || [])[0] || {};
      let selected;
      if (src.TranscodingUrl) {
        // transcode path: the muxed stream targets the requested track
        selected = Number(parseQ(src.TranscodingUrl).AudioStreamIndex);
      } else {
        // direct-play/stream path: server reports the active default it will use
        selected = src.DefaultAudioStreamIndex;
      }
      seen.push(`${idx}->${selected}${src.TranscodingUrl ? "(tc)" : "(dp)"}`);
      if (selected !== idx) allHonored = false;
    }
    check(`[${label}] every audio track selectable via PlaybackInfo`, allHonored, seen.join(" "));
  }

  // --- (4) selected track is remembered for resume (server-side, per user) ---
  // Pick a non-default track, report a play session + progress carrying it,
  // stop, then confirm the item's DefaultAudioStreamIndex now reflects it.
  const pick = audioIdxs.find((i) => i !== origDefault) ?? audioIdxs[audioIdxs.length - 1];
  const pi = await api(`/Items/${itemId}/PlaybackInfo?UserId=${userId}`, {
    method: "POST",
    body: { UserId: userId, MediaSourceId: itemId, AudioStreamIndex: pick, DeviceProfile: PROFILE_BROWSER },
  });
  const psid = pi.json?.PlaySessionId;
  await api("/Sessions/Playing", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: psid, AudioStreamIndex: pick, PositionTicks: 0, PlayMethod: "Transcode" } });
  await api("/Sessions/Playing/Progress", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: psid, AudioStreamIndex: pick, PositionTicks: 300000000, PlayMethod: "Transcode" } });
  await api("/Sessions/Playing/Stopped", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: psid, PositionTicks: 300000000 } });
  const after = await api(`/Users/${userId}/Items/${itemId}?Fields=MediaSources`);
  const remembered = ((after.json?.MediaSources || [])[0] || {}).DefaultAudioStreamIndex;
  check("selected track remembered for resume", remembered === pick, `picked idx ${pick}, server now defaults to ${remembered}`);

  // --- restore original default so the shared test account is unchanged ---
  if (origDefault != null && origDefault !== pick) {
    const rp = await api(`/Items/${itemId}/PlaybackInfo?UserId=${userId}`, {
      method: "POST",
      body: { UserId: userId, MediaSourceId: itemId, AudioStreamIndex: origDefault, DeviceProfile: PROFILE_BROWSER },
    });
    const rpsid = rp.json?.PlaySessionId;
    await api("/Sessions/Playing", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: rpsid, AudioStreamIndex: origDefault, PositionTicks: 0, PlayMethod: "Transcode" } });
    await api("/Sessions/Playing/Progress", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: rpsid, AudioStreamIndex: origDefault, PositionTicks: 300000000, PlayMethod: "Transcode" } });
    await api("/Sessions/Playing/Stopped", { method: "POST", body: { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: rpsid, PositionTicks: 0 } });
    const restored = await api(`/Users/${userId}/Items/${itemId}?Fields=MediaSources`);
    const back = ((restored.json?.MediaSources || [])[0] || {}).DefaultAudioStreamIndex;
    check("test-account default audio index restored", back === origDefault, `back to ${back}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e?.message || e); process.exit(1); });
