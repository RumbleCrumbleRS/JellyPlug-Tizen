/*
 * JELA-152: external text-sub delivery — Lite.parseSrt, Lite.createSubTrack,
 * the jellyfin.lite.subs flag gating SubtitleProfiles, and the OSD cue line.
 *
 * Pinned invariants:
 *   - SubtitleProfiles stays [] while the flag is off (JELA-151 C5
 *     decision: subbed items decline to the SPA on the rollout train);
 *     flag on declares srt-family Method:External ONLY — the server
 *     converts every text codec to srt, image subs match nothing
 *   - parseSrt tolerates BOM/CRLF/missing counters, strips <i> tags and
 *     {\an8} ASS residue, skips malformed blocks, sorts by start
 *   - createSubTrack is O(1) amortized forward, rescans on a backwards
 *     seek, returns null in gaps and past the tail
 *   - the OSD draws the cue line even while the OSD chrome is hidden
 *     (clearRect first — G2: opaque pixels cover the video plane), and
 *     the clean latch still avoids clear-per-tick when there is no cue
 */
"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();
const j = (o) => JSON.parse(JSON.stringify(o));

// --- flag gates the profile ------------------------------------------------
{
  assert.strictEqual(Lite.subsEnabled(), false, "no localStorage = subs off");
  assert.deepStrictEqual(
    j(Lite.deviceProfile().SubtitleProfiles),
    [],
    "flag off: JELA-151 C5 decision holds — sub-selecting answers decline",
  );
  Lite.subsEnabled._v = true;
  assert.deepStrictEqual(
    j(Lite.deviceProfile().SubtitleProfiles),
    [
      { Format: "srt", Method: "External" },
      { Format: "subrip", Method: "External" },
    ],
    "flag on: srt-family External only — text codecs convert server-side, image subs (pgssub/dvdsub) match nothing and keep declining",
  );
  Lite.subsEnabled._v = false;
}

// --- flag probe reads localStorage once, tolerates throws ------------------
{
  const { loadLite: load2 } = require("./lite-testkit.cjs");
  let reads = 0;
  const LiteOn = load2({
    localStorage: {
      getItem: (k) => {
        reads++;
        return k === "jellyfin.lite.subs" ? "1" : null;
      },
    },
  });
  assert.strictEqual(LiteOn.subsEnabled(), true);
  assert.strictEqual(LiteOn.subsEnabled(), true);
  assert.strictEqual(reads, 1, "probed once, then cached");

  const LiteThrow = load2({
    localStorage: {
      getItem: () => {
        throw new Error("privacy");
      },
    },
  });
  assert.strictEqual(LiteThrow.subsEnabled(), false, "throwing storage = off");
}

// --- JELA-141 fleet default fallback ----------------------------------------
{
  const { loadLite: load3 } = require("./lite-testkit.cjs");
  const defRec = (f) => JSON.stringify({ v: 1, o: "http://srv", f, ts: 1 });
  const mkStore = (vals) => ({
    localStorage: { getItem: (k) => (k in vals ? vals[k] : null) },
  });

  const LiteDef = load3(
    mkStore({
      "jellyfin.shell.flagDefaults": defRec({ "jellyfin.lite.subs": "1" }),
    }),
  );
  assert.strictEqual(
    LiteDef.subsEnabled(),
    true,
    "no explicit value: fleet default ON applies",
  );

  const LiteDevKill = load3(
    mkStore({
      "jellyfin.lite.subs": "0",
      "jellyfin.shell.flagDefaults": defRec({ "jellyfin.lite.subs": "1" }),
    }),
  );
  assert.strictEqual(
    LiteDevKill.subsEnabled(),
    false,
    "explicit device-local 0 beats the fleet default",
  );

  const LiteDefOff = load3(
    mkStore({
      "jellyfin.shell.flagDefaults": defRec({ "jellyfin.lite.subs": "0" }),
    }),
  );
  assert.strictEqual(LiteDefOff.subsEnabled(), false, "fleet default 0 = off");

  const LiteCorrupt = load3(
    mkStore({ "jellyfin.shell.flagDefaults": "{not json" }),
  );
  assert.strictEqual(
    LiteCorrupt.subsEnabled(),
    false,
    "corrupt defaults record = off",
  );
}

// --- parseSrt --------------------------------------------------------------
{
  const srt =
    "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i>\r\n\r\n" +
    "2\r\n00:00:04,000 --> 00:00:06,000\r\n{\\an8}Line one\r\nLine two\r\n\r\n" +
    "garbage block without a time line\r\n\r\n" +
    "00:01:00,250 --> 00:01:02,750\nNo counter line\n\n" +
    "4\n00:00:10,000 --> 00:00:09,000\nend before start dropped\n";
  const cues = j(Lite.parseSrt(srt));
  assert.deepStrictEqual(cues, [
    { start: 1000, end: 2500, text: "Hello world" },
    { start: 4000, end: 6000, text: "Line one\nLine two" },
    { start: 60250, end: 62750, text: "No counter line" },
  ]);
  assert.deepStrictEqual(j(Lite.parseSrt("")), [], "empty text = no cues");
  assert.deepStrictEqual(j(Lite.parseSrt(null)), []);
  assert.deepStrictEqual(
    j(Lite.parseSrt("<html><body>login page</body></html>")),
    [],
    "non-srt payload parses to zero cues (caller declines)",
  );
  // out-of-order input is sorted
  const unsorted = Lite.parseSrt(
    "1\n00:00:10,000 --> 00:00:11,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA\n",
  );
  assert.deepStrictEqual(
    j(unsorted).map((c) => c.text),
    ["A", "B"],
  );
  // hour field > 2 digits (long movies), dot millis separator
  const long = j(Lite.parseSrt("1\n10:00:00.500 --> 10:00:01.500\nlate\n"));
  assert.strictEqual(long[0].start, 36000500);
}

// --- createSubTrack cursor -------------------------------------------------
{
  const track = Lite.createSubTrack(
    Lite.parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\nA\n\n" +
        "2\n00:00:03,000 --> 00:00:04,000\nB\n\n" +
        "3\n00:00:05,000 --> 00:00:06,000\nC\n",
    ),
  );
  assert.strictEqual(track.count, 3);
  assert.strictEqual(track.textAt(0), null, "before first cue");
  assert.strictEqual(track.textAt(1000), "A", "start is inclusive");
  assert.strictEqual(track.textAt(1999), "A");
  assert.strictEqual(track.textAt(2000), null, "end is exclusive (gap)");
  assert.strictEqual(track.textAt(3500), "B");
  assert.strictEqual(track.textAt(5999), "C");
  assert.strictEqual(track.textAt(9000), null, "past the tail");
  assert.strictEqual(track.textAt(1500), "A", "backwards seek rescans");
  assert.strictEqual(track.textAt(5500), "C", "forward again after rescan");
}

// --- OSD cue line ----------------------------------------------------------
{
  function recCtx() {
    const calls = [];
    return {
      calls,
      clearRect: (...a) => calls.push(["clearRect", ...a]),
      fillRect: (...a) => calls.push(["fillRect", ...a]),
      fillText: (...a) => calls.push(["fillText", ...a]),
      strokeText: (...a) => calls.push(["strokeText", ...a]),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fill: () => {},
    };
  }
  let t = 0;
  const ctx = recCtx();
  const osd = Lite.createOsd({ ctx, title: "Heat", now: () => t });

  // hidden OSD + cue: clearRect first, stroke under fill, both lines
  const drew = osd.draw({
    posMs: 0,
    durMs: 1000,
    paused: false,
    buffering: false,
    subText: "Line one\nLine two",
  });
  assert.strictEqual(drew, true, "cue line drawn while OSD hidden");
  assert.strictEqual(ctx.calls[0][0], "clearRect", "always clears first (G2)");
  const strokes = ctx.calls.filter((c) => c[0] === "strokeText");
  const fills = ctx.calls.filter((c) => c[0] === "fillText");
  assert.deepStrictEqual(
    strokes.map((c) => c[1]),
    ["Line one", "Line two"],
  );
  assert.deepStrictEqual(
    fills.map((c) => c[1]),
    ["Line one", "Line two"],
  );
  assert.ok(
    ctx.calls.indexOf(strokes[0]) < ctx.calls.indexOf(fills[0]),
    "stroke under fill",
  );
  assert.strictEqual(
    ctx.calls.filter((c) => c[0] === "fillRect").length,
    0,
    "no scrim/box while OSD hidden — cue text only",
  );

  // cue gone + OSD hidden: one clear, then the clean latch holds
  ctx.calls.length = 0;
  assert.strictEqual(
    osd.draw({ posMs: 0, durMs: 1000, paused: false, buffering: false }),
    false,
  );
  assert.deepStrictEqual(ctx.calls.map((c) => c[0]), ["clearRect"]);
  ctx.calls.length = 0;
  osd.draw({ posMs: 0, durMs: 1000, paused: false, buffering: false });
  assert.strictEqual(ctx.calls.length, 0, "clean latch: no clear-per-tick");

  // OSD visible + cue: chrome AND cue text both render
  ctx.calls.length = 0;
  osd.show();
  osd.draw({
    posMs: 0,
    durMs: 1000,
    paused: false,
    buffering: false,
    subText: "Cue",
  });
  assert.ok(ctx.calls.some((c) => c[0] === "fillRect"), "scrim drawn");
  assert.ok(
    ctx.calls.some((c) => c[0] === "fillText" && c[1] === "Cue"),
    "cue drawn with the chrome",
  );
}

console.log("subs.test.cjs OK");
