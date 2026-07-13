/*
 * JELA-67 M3 slice 3: Lite.createPlaybackInfo — direct-play + DirectStream
 * remux decision (design doc §3, slice-3 extension).
 *
 * Pinned invariants:
 *   - one POST to /Items/{id}/PlaybackInfo?userId= with the M63
 *     profile and AutoOpenLiveStream:false
 *   - the FIRST MediaSource with SupportsDirectPlay===true wins (kind="direct");
 *     URL built from ms.Container, ms.Id, token
 *   - if no DirectPlay source, the FIRST source with SupportsDirectStream===true
 *     AND TranscodingUrl wins (kind="remux"); URL = base + ms.TranscodingUrl
 *   - transcode-only / empty / malformed answers and HTTP errors are
 *     declines (cb(err)) — the caller falls back to the SPA deep-link
 *   - the 3s timeout wins races: a late server reply after the
 *     timeout already fell back is dropped, cb fires exactly once
 */
"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();

// objects born inside the vm sandbox have a foreign Object prototype —
// normalize through JSON before deepStrictEqual against host literals
const j = (o) => JSON.parse(JSON.stringify(o));

function harness(opts) {
  const posts = [];
  const timers = new Map();
  let seq = 1;
  const pb = Lite.createPlaybackInfo({
    base: "http://srv",
    token: "tok",
    userId: "u1",
    timeoutMs: opts && opts.timeoutMs,
    postJson: (url, headers, body, cb) => posts.push({ url, headers, body, cb }),
    setTimeout: (fn, ms) => {
      timers.set(seq, { fn, ms });
      return seq++;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return { pb, posts, timers };
}

// --- request shape ---------------------------------------------------------
{
  const { pb, posts } = harness();
  pb.resolve({ id: "m1" }, () => {});
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(
    posts[0].url,
    "http://srv/Items/m1/PlaybackInfo?userId=u1",
  );
  assert.deepStrictEqual(j(posts[0].headers), { "X-Emby-Token": "tok" });
  assert.strictEqual(posts[0].body.AutoOpenLiveStream, false);
  const prof = posts[0].body.DeviceProfile;
  assert.ok(prof, "M63 profile attached");
  assert.strictEqual(prof.MaxStreamingBitrate, 40000000);
  assert.strictEqual(prof.DirectPlayProfiles.length, 1);
  assert.strictEqual(prof.DirectPlayProfiles[0].Container, "mp4,mov,mkv");
  assert.strictEqual(prof.DirectPlayProfiles[0].VideoCodec, "h264,hevc");
  assert.strictEqual(prof.TranscodingProfiles.length, 1, "remux profile present (slice 3)");
  assert.strictEqual(prof.TranscodingProfiles[0].Container, "mkv");
  assert.strictEqual(prof.TranscodingProfiles[0].VideoCodec, "h264,hevc");
}

// --- first SupportsDirectPlay source wins, URL from ms.Container -----------
{
  const { pb, posts, timers } = harness();
  let res;
  pb.resolve({ id: "m1" }, (err, r) => (res = r));
  posts[0].cb(null, {
    PlaySessionId: "ps1",
    MediaSources: [
      { Id: "bad", Container: "mkv", SupportsDirectPlay: false },
      { Id: "ms1", Container: "mov", SupportsDirectPlay: true },
      { Id: "ms2", Container: "mp4", SupportsDirectPlay: true },
    ],
  });
  assert.strictEqual(
    res.url,
    "http://srv/Videos/m1/stream.mov?static=true&mediaSourceId=ms1&api_key=tok",
  );
  assert.strictEqual(res.playSessionId, "ps1");
  assert.strictEqual(res.mediaSourceId, "ms1");
  assert.strictEqual(res.container, "mov");
  assert.strictEqual(res.kind, "direct");
  assert.strictEqual(timers.size, 0, "timeout cleared on settle");
}

// --- transcode-only answer (no DirectPlay, no DirectStream) is a decline ----
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(null, {
    MediaSources: [
      {
        Id: "x",
        Container: "mkv",
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        TranscodingUrl: "/t",
      },
    ],
  });
  assert.strictEqual(err.message, "no-direct-play");
}

// --- DirectStream remux: first SupportsDirectStream source wins --------------
{
  const { pb, posts, timers } = harness();
  let res;
  pb.resolve({ id: "m1" }, (err, r) => (res = r));
  posts[0].cb(null, {
    PlaySessionId: "ps2",
    MediaSources: [
      { Id: "ms1", Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false },
      { Id: "ms2", Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: true, TranscodingUrl: "/Videos/m1/stream.mkv?videoCodec=hevc" },
      { Id: "ms3", Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: true, TranscodingUrl: "/Videos/m1/stream.mkv?videoCodec=hevc&other=x" },
    ],
  });
  assert.strictEqual(res.url, "http://srv/Videos/m1/stream.mkv?videoCodec=hevc");
  assert.strictEqual(res.playSessionId, "ps2");
  assert.strictEqual(res.mediaSourceId, "ms2");
  assert.strictEqual(res.kind, "remux");
  assert.strictEqual(timers.size, 0, "timeout cleared");
}

// --- DirectPlay beats DirectStream when both present -------------------------
{
  const { pb, posts } = harness();
  let res;
  pb.resolve({ id: "m1" }, (err, r) => (res = r));
  posts[0].cb(null, {
    PlaySessionId: "ps3",
    MediaSources: [
      { Id: "ms1", Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: true, TranscodingUrl: "/t" },
      { Id: "ms2", Container: "mov", SupportsDirectPlay: true },
    ],
  });
  assert.strictEqual(res.kind, "direct");
  assert.strictEqual(res.url, "http://srv/Videos/m1/stream.mov?static=true&mediaSourceId=ms2&api_key=tok");
}

// --- DirectStream without TranscodingUrl is not eligible ---------------------
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(null, {
    MediaSources: [
      { Id: "x", Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: true },
    ],
  });
  assert.strictEqual(err.message, "no-direct-play");
}

// --- malformed winners (no Id / no Container) are declines ------------------
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(null, {
    MediaSources: [{ Container: "mov", SupportsDirectPlay: true }],
  });
  assert.strictEqual(err.message, "no-direct-play");
}
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(null, { MediaSources: [] });
  assert.strictEqual(err.message, "no-direct-play");
}
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(null, null);
  assert.strictEqual(err.message, "no-direct-play");
}

// --- HTTP error is a decline -------------------------------------------------
{
  const { pb, posts } = harness();
  let err;
  pb.resolve({ id: "m1" }, (e) => (err = e));
  posts[0].cb(new Error("HTTP 500"), null);
  assert.strictEqual(err.message, "HTTP 500");
}

// --- timeout: default 3s, late reply dropped, cb exactly once ---------------
{
  const { pb, posts, timers } = harness();
  const calls = [];
  pb.resolve({ id: "m1" }, (e, r) => calls.push([e && e.message, r]));
  const [id, t] = [...timers.entries()][0];
  assert.strictEqual(t.ms, 3000, "design §3 fallback-promptness bar");
  t.fn();
  assert.deepStrictEqual(calls, [["timeout", null]]);
  // the server answers after the SPA handoff already started — dropped
  posts[0].cb(null, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  assert.strictEqual(calls.length, 1, "cb fires exactly once");
  void id;
}

// --- a settle beats a later timeout tick -------------------------------------
{
  const { pb, posts, timers } = harness({ timeoutMs: 1234 });
  const calls = [];
  pb.resolve({ id: "m1" }, (e, r) => calls.push([e, r && r.mediaSourceId]));
  const t = [...timers.values()][0];
  assert.strictEqual(t.ms, 1234);
  posts[0].cb(null, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  assert.strictEqual(timers.size, 0, "timer cleared");
  assert.deepStrictEqual(calls, [[null, "ms1"]]);
}

console.log("playbackinfo.test.cjs OK");
