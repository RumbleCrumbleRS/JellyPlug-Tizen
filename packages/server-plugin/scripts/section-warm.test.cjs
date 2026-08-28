#!/usr/bin/env node
/*
 * section-warm.test.cjs — JELA-793 guard for the background library warmer.
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring that would only break at runtime is
 * source-pinned.
 *
 * What it is for: a box that has been idle answers its first
 * /HomeScreen/Section/* request 10-25x slower than its own warm median, and
 * the penalty is in the shared library-query path rather than in any one
 * section — a trivial /Items?Limit=1 control pays it too while /System/Info
 * stays at its 1.5 ms floor. The JELA-732 row cache cannot help, because its
 * TTL is 30 s and the first boot of the day is always a miss.
 *
 * Four properties make a background timer on a family media server acceptable,
 * and all four are pinned below. Each of them is a way to get this wrong that
 * still looks like a working warmer from the outside — which is the whole
 * reason they are pins and not comments:
 *
 *   A. OFF by default. The interval field defaults to 0, so installing the
 *      plugin does not silently add a background query loop to anyone's box.
 *
 *   B. NOT an IScheduledTask. The JELA-692 pre-flight gate blocks every
 *      production measurement in this programme while any scheduled task is
 *      non-Idle. A warmer on a ~45 s cadence registered as a task would put
 *      the gate into BLOCKED a large fraction of the time and take the
 *      programme's own instrument down with it.
 *
 *   C. It warms by BUILDING THE ROW, one user per pass. The cheap version —
 *      user-less ordered item scans — was measured and is a null: it moved a
 *      300 s-cold fan-out from 2,199/1,528/2,317/635 ms to 2,058/1,587/2,109/
 *      581 ms. Building the LatestShows row for one user gets 140/141/172/21
 *      against a warm reference of 146/158/184/16. So the pins below defend
 *      the expensive-looking call against being "optimised" back into the
 *      version that does nothing, and defend one-user-per-pass against
 *      becoming all-users-per-pass (11x the cost to redo shared work).
 *
 *   C2. Still read-only. It builds an in-memory row and discards it; nothing
 *      it does is observable as a change.
 *
 *   C3. JELA-798: the movies half, off by default. JELA-793 shipped believing
 *      one warmed row carried the other three; re-measured, LatestShows goes
 *      warm (1.6x) while LatestMovies stays at 13.3x. The rotation was the
 *      cheap suspect and is not the cause — at a 110 s lap LatestMovies is
 *      still 4.25x, and a USER-LESS /Items Movie control probe read 9,573 ms
 *      against a 7.9 ms warm median in the same burst, which no rotation
 *      setting can explain. So the pins here defend a second ROW against
 *      being replaced by a faster rotation or by the cheaper user-less scan.
 *
 *   D. It cannot pile up or take the host down. Overlapping passes are
 *      skipped rather than queued, and an unhandled exception on a timer
 *      callback would kill the process, so the callback body is wrapped.
 *
 * Run: node packages/server-plugin/scripts/section-warm.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const svc = read("SectionWarmService.cs");
const filter = read("SectionWarmStartupFilter.cs");
const registrator = read("PluginServiceRegistrator.cs");
const config = read("PluginConfiguration.cs");
const page = read(path.join("Configuration", "configPage.html"));

// ---- A. off by default -------------------------------------------------------

// An auto-property with no initializer is 0 for an int. Spelling an explicit
// default here (or anywhere) is the one-character change that turns this from
// an opt-in into a background loop on every install, so pin the absence.
const intervalDecl =
  /public\s+int\s+SectionWarmIntervalSeconds\s*\{\s*get;\s*set;\s*\}\s*(=[^;]*;)?/.exec(
    config,
  );
assert.ok(
  intervalDecl,
  "PluginConfiguration.SectionWarmIntervalSeconds is missing",
);
assert.ok(
  !intervalDecl[1],
  `SectionWarmIntervalSeconds must default to 0 (off); found initializer '${intervalDecl[1]}'`,
);

// And the service must treat 0 (and anything negative) as off rather than as
// "every tick", which is what a `!= 0` or a missing guard would do.
assert.ok(
  /interval\s*<=\s*0/.test(svc),
  "a non-positive interval must switch the warmer off, not run it every tick",
);

// ---- B. not a scheduled task -------------------------------------------------

// Match the IMPLEMENTATION, not the name: the service's own doc comment
// explains at length why it is not a scheduled task, and a bare
// /IScheduledTask/ pin fails on that prose. (JELA-732 recorded the mirror
// image of this — a pin that a doc-comment mention satisfied on its own.)
assert.ok(
  !/:\s*IScheduledTask\b/.test(svc) && !/:\s*IScheduledTask\b/.test(filter),
  "the warmer must not implement IScheduledTask — it would block the JELA-692 pre-flight gate on every pass",
);
assert.ok(
  !/using MediaBrowser\.Model\.Tasks/.test(svc),
  "the warmer must not pull in the scheduled-task API — see JELA-692 gate A",
);
assert.ok(
  !fs.existsSync(path.join(ROOT, "ScheduledTasks", "SectionWarmTask.cs")),
  "the warmer must not be an IScheduledTask — see JELA-692 gate A",
);
// The reason has to travel with the code: the next person to see a timer in a
// plugin that already owns two scheduled tasks will otherwise "tidy" it into
// one.
assert.ok(
  /JELA-692/.test(svc),
  "SectionWarmService must record WHY it is a timer and not a scheduled task",
);

// ---- C. it warms by building the row, one user per pass ----------------------

// THE pin on this file. The obvious "cheaper" refactor — drop the row build,
// keep the item scans — is the exact version that was measured and produced
// nothing, and it is indistinguishable from a working warmer without a 10-minute
// production A/B. Anyone removing this call has to delete an assertion that says
// so.
assert.ok(
  /LatestShowsFastPath\.TryBuild\(/.test(svc),
  "the warm pass must BUILD the row — user-less item scans alone are a measured null (2,058 vs 2,199 ms control)",
);
assert.ok(
  /NULL|null\b/.test(svc) && /2,058/.test(svc),
  "SectionWarmService must carry the numbers that rule out the cheap version, or it will be reintroduced",
);

// One user per pass. Warming every user each pass is 11x the cost to redo the
// same shared item/DTO/image work — measured: warming as one user left another
// user's fan-out at 148/124/135/15 ms.
assert.ok(
  /Interlocked\.Increment\(ref _userCursor\)/.test(svc),
  "users must be walked round-robin, one per pass",
);
// Pinned as "no loop at all" rather than "no loop over a variable named users":
// the first version of this assertion matched the identifier, and a seeded
// mutation that looped over the expression directly walked straight through it.
//
// JELA-798 added WarmMovieRow, which legitimately loops — over the user's movie
// LIBRARIES, and over the cards it builds. Neither is a loop over users. Rather
// than weaken the strong form to something a mutation can walk through again,
// cut that one method out and keep the strong form over everything else; the
// method is then pinned separately, below, as not touching the user list at all.
const MOVIE_ROW_START = svc.indexOf("private static int WarmMovieRow(");
const MOVIE_ROW_END = svc.indexOf(
  "/// Picks the user this pass warms on behalf of",
);
assert.ok(
  MOVIE_ROW_START > 0 && MOVIE_ROW_END > MOVIE_ROW_START,
  "WarmMovieRow must sit between its own signature and NextUser's doc comment — the loop pin below is scoped by those markers and silently widens if either moves",
);
const movieRow = svc.slice(MOVIE_ROW_START, MOVIE_ROW_END);
const outsideMovieRow =
  svc.slice(0, MOVIE_ROW_START) + svc.slice(MOVIE_ROW_END);
assert.ok(
  !/\bforeach\b|\bfor\s*\(|\bwhile\s*\(/.test(outsideMovieRow),
  "a warm pass must not loop over users — that is 11x the cost to redo the same shared work",
);
// The scoping is only safe while the carve-out cannot itself become a user walk.
assert.ok(
  !/GetUsersIds|_userCursor|NextUser\(/.test(movieRow),
  "the movies half must warm for the ONE user the pass already picked — it must not reach the user list",
);
assert.strictEqual(
  (svc.match(/LatestShowsFastPath\.TryBuild\(/g) || []).length,
  1,
  "exactly one row build per pass",
);
// GetUsersIds, not GetUsers: identity only, no User entity materialised per pass.
assert.ok(
  /GetUsersIds\(\)/.test(svc) && !/\.GetUsers\(\)/.test(svc),
  "the user walk needs ids only",
);
// A lap that reshuffles every pass is not a lap.
assert.ok(
  /GetUsersIds\(\)\.OrderBy\(/.test(svc),
  "the user order must be stable across passes",
);

// The fallback probe, for when TryBuild steps aside (HideWatchedItems on, or a
// user with no TV library). Worth ~40% rather than 0%, so it must stay cheap.
assert.ok(
  /EnableTotalRecordCount\s*=\s*false/.test(svc),
  "the fallback probe must not ask for a total record count — a second pass over the same set, for nothing",
);
assert.ok(
  /Limit\s*=\s*ProbeLimit/.test(svc) && /ProbeLimit\s*=\s*200/.test(svc),
  "the fallback probe must be bounded by an explicit row limit",
);

// ---- C3. the JELA-798 movies half --------------------------------------------

// Same shape as A: an auto-property with no initializer is false for a bool, so
// the plugin ships with this off and the flip is an operator action.
const movieDecl =
  /public\s+bool\s+SectionWarmMovieRow\s*\{\s*get;\s*set;\s*\}\s*(=[^;]*;)?/.exec(
    config,
  );
assert.ok(movieDecl, "PluginConfiguration.SectionWarmMovieRow is missing");
assert.ok(
  !movieDecl[1],
  `SectionWarmMovieRow must default to false (off); found initializer '${movieDecl[1]}'`,
);
// Read per pass off the live configuration, like the interval — not captured at
// Start(), which would make the kill switch need a restart to take effect.
assert.ok(
  /Plugin\.Instance\?\.Configuration\.SectionWarmMovieRow\s*==\s*true/.test(
    svc,
  ),
  "the movies half must read its flag per pass, so it is its own kill switch",
);

// The same trap as C, one row along: the cheap version of the movies half is the
// user-less scan this file ALREADY runs on its fallback path, and JELA-793
// measured that family at ~0% of the win. It has to build the row — the
// user-scoped query plus a DTO with images per card, which is where the
// expensive cold state actually is.
assert.ok(
  /dtoService\.GetBaseItemDto\(/.test(movieRow) &&
    /LatestShowsFastPath\.SectionDtoOptions\(\)/.test(movieRow),
  "the movies half must resolve DTOs with the section's own image options — a cheaper shape is the measured-null version",
);
assert.ok(
  /new InternalItemsQuery\(user\)/.test(movieRow),
  "the movies half must be user-scoped — a user-less scan was measured at ~0% of the win",
);
assert.ok(
  /EnableTotalRecordCount\s*=\s*false/.test(movieRow),
  "the movies half must not ask for a total record count",
);
assert.ok(
  /Limit\s*=\s*MovieRowLimit/.test(movieRow) &&
    /MovieRowLimit\s*=\s*16/.test(svc),
  "the movies half must be bounded by an explicit row limit",
);

// The numbers that rule out the cheaper fix have to travel with the code, or the
// next person will reach for the rotation — it is genuinely the cheaper lever and
// it is genuinely not the cause. 4.25x is LatestMovies at a 110 s lap, where
// every user is fresher than the ~60 s decay time; 9,573 is the user-less
// /Items Movie control probe against a 7.9 ms warm median, which is the reading
// that no rotation setting can explain.
assert.ok(
  /4\.25x/.test(svc) && /9,573/.test(svc),
  "SectionWarmService must carry the measurements that rule out a faster rotation, or it will be reintroduced as the fix",
);
// JELA-793's "one section carries the other three" is now false and must not be
// left asserted anywhere: it is the sentence that would justify deleting this.
assert.ok(
  !/carries the other three/.test(svc),
  "the disproved 'one section carries the other three' claim must not survive in the source",
);

// ---- C2. still read-only -----------------------------------------------------

assert.ok(
  !/\b(Save|Update|Delete|Create|Write)Item|SaveChanges|Response\b/.test(svc),
  "a warm pass must be read-only",
);

// ---- D. it cannot pile up, and it cannot kill the host ------------------------

assert.ok(
  /Interlocked\.CompareExchange\(ref _running, 1, 0\)\s*!=\s*0/.test(svc),
  "an overlapping pass must be skipped, not queued behind the previous one",
);
// A pass slower than its own interval must not be able to re-trigger itself
// immediately: the interval is the GAP between passes.
assert.ok(
  /finally\s*\{[^}]*_sinceLastPass\.Restart\(\)/.test(svc),
  "the interval clock must restart after the pass, inside a finally",
);
// System.Threading.Timer callbacks run on the thread pool: an escaping
// exception is an unhandled exception, and that is a process kill.
assert.ok(
  /private void OnTick\(object\? state\)\s*\{\s*try\b/.test(svc),
  "the timer callback body must be wrapped in try/catch — an escaping exception kills the host",
);
// Stopwatch, not DateTime: this is a duration comparison, and a wall-clock one
// stalls for an hour on an NTP step or a DST change on a box running local
// time.
assert.ok(
  /Stopwatch\b/.test(svc) && !/DateTime\.(UtcNow|Now)/.test(svc),
  "the interval must be measured with Stopwatch, not wall-clock DateTime",
);

// ---- the wiring actually runs ------------------------------------------------

// Same lesson as JELA-731/732: a plain AddSingleton of the class compiles and
// never runs. The service needs a hook that fires after the container exists —
// plugin RegisterServices is far too early to resolve ILibraryManager.
assert.ok(
  /AddSingleton<SectionWarmService>/.test(registrator),
  "SectionWarmService must be a singleton — a transient warmer would restart its clock every resolve",
);
assert.ok(
  /AddTransient<IStartupFilter,\s*SectionWarmStartupFilter>/.test(registrator),
  "SectionWarmStartupFilter is not registered as an IStartupFilter",
);
assert.ok(
  /class SectionWarmStartupFilter\s*:\s*IStartupFilter/.test(filter),
  "SectionWarmStartupFilter must implement IStartupFilter",
);
assert.ok(
  /_warm\.Start\(app\.ApplicationServices\)/.test(filter) &&
    /next\(app\)/.test(filter),
  "the filter must start the warmer and then hand the pipeline on unchanged",
);
// It adds no middleware, so its position is irrelevant to it — but NOT to the
// filters above it, whose nesting order is load-bearing (JELA-727 compression
// outermost, then the JELA-732 cache, then the JELA-731 fast path). Pin that
// it was appended after them rather than inserted among them.
assert.ok(
  registrator.indexOf("SectionWarmStartupFilter") >
    registrator.indexOf("LatestShowsFastPathStartupFilter"),
  "the warmer's filter must be registered after the filters whose nesting order matters",
);
// Idempotent start: IStartupFilter is transient and the pipeline can be built
// more than once in a process, which would otherwise leak a timer per build.
assert.ok(
  /Interlocked\.Exchange\(ref _started, 1\)\s*==\s*1/.test(svc),
  "Start must be idempotent — a second pipeline build would otherwise leak a second timer",
);

// ---- the operator surface ----------------------------------------------------

assert.ok(
  /id="SectionWarmIntervalSeconds"/.test(page),
  "the interval must be editable from the dashboard — it is also the kill switch",
);
// The one way to set this that looks enabled and does nothing.
assert.ok(
  /about a minute/.test(page),
  "the settings page must say how fast the penalty comes back, or an operator will set an interval that never helps",
);
// JELA-798: the movies half is inert unless the interval is non-zero, which is
// the one way to switch it on and see nothing happen.
assert.ok(
  /id="SectionWarmMovieRow"/.test(page),
  "the movies half must be switchable from the dashboard",
);
assert.ok(
  /\{ id: 'SectionWarmMovieRow', type: 'bool' \}/.test(page),
  "a field the page renders but never loads or saves reads as a working switch that does nothing",
);

console.log("section-warm.test.cjs: all pins hold");
