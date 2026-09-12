#!/usr/bin/env node
/*
 * jsi-backup-restore.test.cjs — JELA-898 guard for the JSI snapshot tooling.
 *
 * These two tools protect the only copy of the JellyPlug product layer, so the
 * thing under test is not "does it serialize JSON" — it is every way a backup
 * tool can quietly fail to be a backup:
 *
 *  1) THE WIPE MUST NOT BE SNAPSHOTTABLE. JELA-896 emptied the injector config
 *     during a Jellyfin major upgrade. A mirror that writes whatever the server
 *     returns would have overwritten the last good snapshot with the empty one
 *     and reported success. Both floors (absolute entry minimum, and shrink
 *     versus the baseline) are asserted against a reconstruction of that exact
 *     event, and `evaluateFloors` must report BOTH reasons rather than the
 *     first — an operator looking at a wiped config needs the whole picture.
 *  2) INTEGRITY IS CHECKED, NOT ASSUMED. A snapshot that was truncated or
 *     hand-edited must fail before `jsi-restore.mjs` can POST it to prod.
 *  3) THE JEL-139 PATTERN CANNOT DRIFT. The snapshot is a tracked file, so the
 *     backup tool front-runs `tooling/ci/check-no-personal-endpoints.sh`. This
 *     test reads that shell script and asserts the two patterns are the SAME
 *     STRING — a future edit to the CI guard that is not mirrored here fails.
 *  4) SERVED VERIFICATION IS BYTE-PRESENCE, AND PRIVATE ENTRIES ARE NOT FAKED
 *     PASSES. [[jsi-config-save-off-by-one]]: a config round-trip proves nothing
 *     about what TVs receive. `verifyServed` must catch an entry missing from
 *     the bundle, and must report `RequiresAuthentication` entries (served from
 *     the per-user private.js, which 401s for an API key) as unverifiable
 *     instead of counting them present.
 *  5) A STALE RESTORE IS VISIBLE. `diffConfigs` must surface removals, because
 *     `jsi-restore.mjs` refuses on them by default — that is what stops a
 *     two-week-old snapshot from deleting everything added since.
 *
 * No network: every check runs against in-memory configs.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let checks = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}
function eq(a, b, msg) {
  assert.deepStrictEqual(a, b, msg);
  checks++;
}

/** A config shaped like the live one: N entries, all enabled and anonymous. */
function makeConfig(n, { bodyLen = 100, prefix = "JellyPlug — entry" } = {}) {
  return {
    CustomJavaScripts: Array.from({ length: n }, (_, i) => ({
      Name: `${prefix} ${i}`,
      Script: `/*${i}*/` + "x".repeat(bodyLen),
      Enabled: true,
      RequiresAuthentication: false,
    })),
    PluginJavaScripts: [],
    DisableScriptInjectionMiddleware: false,
  };
}

async function main() {
  const dir = __dirname;
  const lib = await import("file://" + path.join(dir, "jsi-snapshot-lib.mjs"));
  const backup = await import("file://" + path.join(dir, "jsi-backup.mjs"));
  const restore = await import("file://" + path.join(dir, "jsi-restore.mjs"));

  /* ---------------------------------------------------------------- 1. stats */
  const cfg110 = makeConfig(110);
  const s110 = lib.configStats(cfg110);
  eq(
    { e: s110.entries, en: s110.enabledEntries, pub: s110.publicEntries },
    { e: 110, en: 110, pub: 110 },
    "configStats counts entries / enabled / public",
  );
  ok(s110.scriptBytes > 0, "configStats sums script bytes");

  // UTF-8, not UTF-16 code units — entry names and bodies carry em-dashes.
  const utf8 = {
    CustomJavaScripts: [
      { Name: "é", Script: "é", Enabled: true, RequiresAuthentication: false },
    ],
  };
  eq(lib.configStats(utf8).scriptBytes, 2, "scriptBytes counts UTF-8 bytes");

  // A disabled or private entry is not a public one.
  const mixed = {
    CustomJavaScripts: [
      { Name: "on", Script: "a", Enabled: true, RequiresAuthentication: false },
      {
        Name: "off",
        Script: "b",
        Enabled: false,
        RequiresAuthentication: false,
      },
      {
        Name: "priv",
        Script: "c",
        Enabled: true,
        RequiresAuthentication: true,
      },
    ],
  };
  const ms = lib.configStats(mixed);
  eq(
    { e: ms.entries, en: ms.enabledEntries, pub: ms.publicEntries },
    { e: 3, en: 2, pub: 1 },
    "configStats separates enabled from public",
  );

  ok(
    (() => {
      try {
        lib.configStats({});
        return false;
      } catch {
        return true;
      }
    })(),
    "configStats throws on a config with no CustomJavaScripts",
  );

  /* ------------------------------------------------------------ 2. integrity */
  const snap = lib.buildSnapshot({
    config: cfg110,
    capturedAt: "2026-09-12T19:00:00.000Z",
    source: { jellyfinVersion: "12.0.0", pluginName: "JavaScript Injector" },
  });
  const roundTripped = JSON.parse(JSON.stringify(snap));
  lib.validateSnapshot(roundTripped);
  lib.assertSnapshotIntegrity(roundTripped);
  checks += 2;
  ok(
    !JSON.stringify(snap).includes("JELLYFIN_URL") &&
      snap.source.url === undefined,
    "snapshot records no server URL (JEL-139)",
  );

  // Tamper with the body: the recorded hash must catch it.
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.config.CustomJavaScripts[0].Script += "/*evil*/";
  ok(
    (() => {
      try {
        lib.assertSnapshotIntegrity(tampered);
        return false;
      } catch (e) {
        return /integrity failure/.test(e.message);
      }
    })(),
    "assertSnapshotIntegrity rejects an edited config body",
  );

  // Tamper with the stats instead of the body.
  const tamperedStats = JSON.parse(JSON.stringify(snap));
  tamperedStats.stats.entries = 999;
  ok(
    (() => {
      try {
        lib.assertSnapshotIntegrity(tamperedStats);
        return false;
      } catch (e) {
        return /stats\.entries/.test(e.message);
      }
    })(),
    "assertSnapshotIntegrity rejects doctored stats",
  );

  for (const [bad, why] of [
    [{ ...snap, format: "something-else" }, "format"],
    [{ ...snap, formatVersion: 99 }, "formatVersion"],
    [{ ...snap, config: undefined }, "config"],
  ]) {
    ok(
      (() => {
        try {
          lib.validateSnapshot(bad);
          return false;
        } catch {
          return true;
        }
      })(),
      `validateSnapshot rejects a bad ${why}`,
    );
  }

  /* ------------------------------------------- 3. the JELA-896 wipe is refused */
  const wiped = { ...cfg110, CustomJavaScripts: [] };
  const wipedStats = lib.configStats(wiped);
  const wipeViolations = backup.evaluateFloors({
    stats: wipedStats,
    baselineStats: s110,
    minEntries: backup.DEFAULT_MIN_ENTRIES,
    maxShrinkPct: backup.DEFAULT_MAX_SHRINK_PCT,
    personalEndpoints: [],
  });
  ok(
    wipeViolations.length >= 2,
    "a wiped config trips BOTH the entry floor and the shrink ceiling",
  );
  ok(
    wipeViolations.some((v) => /JELA-896 wipe signature/.test(v)),
    "the wipe violation names the failure mode",
  );
  ok(
    wipeViolations.some((v) => /dropped 100\.0%/.test(v)),
    "the shrink violation quantifies the loss",
  );

  // The shrink ceiling catches a partial loss the absolute floor would miss:
  // 110 -> 99 entries is above DEFAULT_MIN_ENTRIES but is a 10% drop.
  const partial = lib.configStats(makeConfig(90));
  const partialViolations = backup.evaluateFloors({
    stats: partial,
    baselineStats: s110,
    minEntries: backup.DEFAULT_MIN_ENTRIES,
    maxShrinkPct: backup.DEFAULT_MAX_SHRINK_PCT,
    personalEndpoints: [],
  });
  ok(
    partial.entries > backup.DEFAULT_MIN_ENTRIES &&
      partialViolations.length > 0,
    "shrink ceiling catches a partial loss that clears the absolute floor",
  );

  // Normal growth is not a violation.
  eq(
    backup.evaluateFloors({
      stats: lib.configStats(makeConfig(111)),
      baselineStats: s110,
      minEntries: backup.DEFAULT_MIN_ENTRIES,
      maxShrinkPct: backup.DEFAULT_MAX_SHRINK_PCT,
      personalEndpoints: [],
    }),
    [],
    "a config that grew by one entry passes every floor",
  );

  // With no baseline (first ever snapshot) the absolute floor still applies.
  ok(
    backup.evaluateFloors({
      stats: wipedStats,
      baselineStats: null,
      minEntries: backup.DEFAULT_MIN_ENTRIES,
      maxShrinkPct: backup.DEFAULT_MAX_SHRINK_PCT,
      personalEndpoints: [],
    }).length === 1,
    "with no baseline the entry floor alone still refuses a wipe",
  );

  const shrink = lib.assessShrink(s110, wipedStats);
  ok(
    shrink.entriesDropPct === 100 && shrink.scriptBytesDropPct === 100,
    "assessShrink reports a total loss as 100%",
  );
  ok(
    lib.assessShrink(s110, lib.configStats(makeConfig(220))).entriesDropPct < 0,
    "assessShrink reports growth as negative shrink",
  );

  /* --------------------------------- 4. JEL-139 pattern parity with the CI guard */
  const guardPath = path.join(
    dir,
    "..",
    "..",
    "..",
    "tooling",
    "ci",
    "check-no-personal-endpoints.sh",
  );
  const guardSrc = fs.readFileSync(guardPath, "utf8");
  const m = guardSrc.match(/^PATTERN='([^']*)'/m);
  ok(m, "the CI guard still declares a single-quoted PATTERN");
  eq(
    lib.PERSONAL_ENDPOINT_PATTERN,
    m[1],
    "PERSONAL_ENDPOINT_PATTERN is byte-identical to the CI guard's PATTERN",
  );

  // Built at runtime, not written literally: the JEL-139 guard scans this file
  // too, and a hard-coded sample hostname would trip it (same reason
  // PERSONAL_ENDPOINT_PATTERN is assembled from parts).
  const sampleHost = ["myserver", "ddns", "net"].join(".");
  eq(
    lib.findPersonalEndpoints(
      JSON.stringify({ Script: `var u='https://${sampleHost}/x';` }),
    ),
    [sampleHost],
    "findPersonalEndpoints catches a dynamic-DNS hostname in a script body",
  );
  eq(
    lib.findPersonalEndpoints("https://REDACTED-SERVER.example/x"),
    [],
    "a reserved .example placeholder is not flagged",
  );
  ok(
    backup.evaluateFloors({
      stats: s110,
      baselineStats: s110,
      minEntries: 1,
      maxShrinkPct: 100,
      personalEndpoints: [sampleHost],
    }).length === 1,
    "a personal endpoint alone refuses the snapshot",
  );

  /* --------------------------------------------------- 5. served verification */
  const servedAll = cfg110.CustomJavaScripts.map((e) => e.Script).join("\n");
  const vAll = lib.verifyServed(cfg110, servedAll);
  eq(
    { e: vAll.expected, p: vAll.present, miss: vAll.missing.length },
    { e: 110, p: 110, miss: 0 },
    "verifyServed passes when every body is byte-present",
  );

  // Drop one entry from the bundle — the off-by-one signature.
  const servedMissing = cfg110.CustomJavaScripts.slice(1)
    .map((e) => e.Script)
    .join("\n");
  const vMiss = lib.verifyServed(cfg110, servedMissing);
  eq(
    vMiss.missing,
    ["JellyPlug — entry 0"],
    "verifyServed names the missing entry",
  );
  ok(vMiss.present === 109, "verifyServed counts the ones that did land");

  // A near-miss must not pass: a truncated body is not the body.
  const truncated = cfg110.CustomJavaScripts.map((e) =>
    e.Script.slice(0, -5),
  ).join("\n");
  ok(
    lib.verifyServed(cfg110, truncated).missing.length === 110,
    "verifyServed is byte-presence, not a prefix match",
  );

  const vMixed = lib.verifyServed(mixed, "a");
  eq(
    { e: vMixed.expected, p: vMixed.present, u: vMixed.unverifiable },
    { e: 1, p: 1, u: 1 },
    "private entries are unverifiable, not silently counted present",
  );
  ok(
    !vMixed.missing.includes("off"),
    "a disabled entry is not expected in the served bundle",
  );

  /* --------------------------------------------------------------- 6. diffing */
  const before = makeConfig(3);
  const after = JSON.parse(JSON.stringify(before));
  after.CustomJavaScripts[0].Script += "/*more*/";
  after.CustomJavaScripts.push({
    Name: "brand new",
    Script: "zz",
    Enabled: true,
    RequiresAuthentication: false,
  });
  after.CustomJavaScripts.splice(1, 1); // remove "entry 1"
  after.DisableScriptInjectionMiddleware = true;

  const d = lib.diffConfigs(before, after);
  eq(
    d.added.map((x) => x.name),
    ["brand new"],
    "diffConfigs finds the added entry",
  );
  eq(
    d.removed.map((x) => x.name),
    ["JellyPlug — entry 1"],
    "diffConfigs finds the removed entry",
  );
  eq(
    d.changed.map((x) => x.name),
    ["JellyPlug — entry 0"],
    "diffConfigs finds the changed entry",
  );
  eq(d.changed[0].delta, 8, "diffConfigs reports the byte delta");
  eq(d.unchanged, 1, "diffConfigs counts the untouched entry");
  eq(
    d.otherKeysChanged,
    ["DisableScriptInjectionMiddleware"],
    "diffConfigs notices non-entry keys",
  );

  eq(
    lib.diffConfigs(before, before).changed,
    [],
    "a config does not differ from itself",
  );
  ok(
    lib.isIdenticalConfig(before, JSON.parse(JSON.stringify(before))),
    "isIdenticalConfig",
  );
  ok(
    !lib.isIdenticalConfig(before, after),
    "isIdenticalConfig detects a change",
  );

  // A restore that deletes entries must render them, because jsi-restore.mjs
  // refuses on exactly this and the operator has to see what would die.
  const rendered = restore.formatDiff(d);
  ok(
    /- REMOVE {2}JellyPlug — entry 1/.test(rendered),
    "formatDiff spells out each removal",
  );
  ok(
    /\+ ADD/.test(rendered) && /~ CHANGE/.test(rendered),
    "formatDiff renders adds and changes",
  );

  /* ------------------------------------------------- 7. snapshot dir handling */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsi-snap-"));
  try {
    const stamps = [
      "20260901T000000Z",
      "20260912T190000Z",
      "20260904T161247Z",
      "20260912T083000Z",
    ];
    for (const s of stamps) {
      fs.writeFileSync(path.join(tmp, lib.defaultSnapshotName(s)), "{}");
    }
    fs.writeFileSync(path.join(tmp, "notes.md"), "not a snapshot");
    fs.writeFileSync(path.join(tmp, "jsi-config-bogus.json"), "{}");

    const listed = backup.listSnapshots(tmp).map((p) => path.basename(p));
    eq(
      listed,
      [
        "jsi-config-20260912T190000Z.json",
        "jsi-config-20260912T083000Z.json",
        "jsi-config-20260904T161247Z.json",
        "jsi-config-20260901T000000Z.json",
      ],
      "listSnapshots returns only stamped snapshots, newest first",
    );

    const pruned = backup.pruneSnapshots(tmp, 2);
    eq(pruned.length, 2, "pruneSnapshots deletes beyond --prune-keep");
    eq(
      backup.listSnapshots(tmp).map((p) => path.basename(p)),
      ["jsi-config-20260912T190000Z.json", "jsi-config-20260912T083000Z.json"],
      "pruneSnapshots keeps the NEWEST n",
    );
    ok(
      fs.existsSync(path.join(tmp, "notes.md")),
      "pruneSnapshots leaves foreign files alone",
    );
    eq(
      backup.listSnapshots(path.join(tmp, "nope")),
      [],
      "listSnapshots tolerates a missing dir",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* -------------------------------------------------------------- 8. plumbing */
  eq(
    lib.stampFor(new Date("2026-09-04T16:12:47.123Z")),
    "20260904T161247Z",
    "stampFor matches this package's existing artifact stamps",
  );
  eq(
    lib.defaultSnapshotName("20260904T161247Z"),
    "jsi-config-20260904T161247Z.json",
    "defaultSnapshotName",
  );
  ok(
    lib.authHeaders("abc").Authorization === 'MediaBrowser Token="abc"',
    "auth uses the header form Jellyfin 12.0 still accepts (JELA-896)",
  );

  const parsed = lib.parseArgs(
    ["--snapshot", "f.json", "--yes", "--max-attempts", "3"],
    { flags: ["yes"], values: ["snapshot", "maxAttempts"] },
  );
  eq(
    { s: parsed.snapshot, y: parsed.yes, m: parsed.maxAttempts },
    { s: "f.json", y: true, m: "3" },
    "parseArgs handles flags, values and kebab-case",
  );
  ok(
    (() => {
      try {
        lib.parseArgs(["--nope"], { flags: [], values: [] });
        return false;
      } catch {
        return true;
      }
    })(),
    "parseArgs rejects an unknown option instead of ignoring it",
  );

  // Missing credentials must fail loudly, not POST to nowhere.
  const savedUrl = process.env.JELLYFIN_URL;
  const savedKey = process.env.JELLYFIN_API_KEY;
  try {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    ok(
      (() => {
        try {
          lib.resolveConnection({});
          return false;
        } catch (e) {
          return /JELLYFIN_URL/.test(e.message);
        }
      })(),
      "resolveConnection demands a server",
    );
    ok(
      (() => {
        try {
          lib.resolveConnection({ url: "https://x.example" });
          return false;
        } catch (e) {
          return /JELLYFIN_API_KEY/.test(e.message);
        }
      })(),
      "resolveConnection demands a credential",
    );
    eq(
      lib.resolveConnection({ url: "https://x.example/", apiKey: "k" }).url,
      "https://x.example",
      "resolveConnection strips a trailing slash",
    );
  } finally {
    if (savedUrl !== undefined) process.env.JELLYFIN_URL = savedUrl;
    if (savedKey !== undefined) process.env.JELLYFIN_API_KEY = savedKey;
  }

  console.log(`jsi-backup-restore.test.cjs: ${checks} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
