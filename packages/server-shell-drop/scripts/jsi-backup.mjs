#!/usr/bin/env node
/*
 * jsi-backup.mjs — JELA-898: snapshot the live JavaScript Injector config.
 *
 * `GET /Plugins/{jsi}/Configuration` -> a validated, timestamped snapshot file.
 * See `jsi-snapshot-lib.mjs` for why this config is irreplaceable and what the
 * safety floors are guarding against.
 *
 * The floors are the point. A mirror that writes whatever the server returns
 * would have cheerfully overwritten the last good snapshot with JELA-896's
 * empty config — the tool would have been running, "succeeding", and holding
 * nothing. So:
 *
 *   - fewer than `--min-entries` entries          -> refuse (the wipe signature)
 *   - shrunk >`--max-shrink-pct` vs the baseline  -> refuse (a loss, not an edit)
 *   - a personal dynamic-DNS hostname in the body -> refuse (JEL-139, this file
 *                                                    gets committed)
 *
 * Each is overridable with `--force`, which prints what it is overriding.
 *
 * Usage:
 *   # write a snapshot next to the committed ones, comparing against the newest
 *   node jsi-backup.mjs --dir ../snapshots
 *
 *   # scheduled use: only write when the config actually moved
 *   node jsi-backup.mjs --dir /var/backups/jsi --if-changed --prune-keep 30
 *
 *   # explicit destination
 *   node jsi-backup.mjs --out /tmp/jsi-now.json
 *
 * Env: JELLYFIN_URL, JELLYFIN_API_KEY (or --url / --api-key).
 *
 * Exit codes:
 *   0  snapshot written
 *   3  --if-changed and the config is identical to the baseline (nothing written)
 *   1  a floor tripped, or the fetch failed
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import process from "node:process";

import {
  assessShrink,
  assertSnapshotIntegrity,
  buildSnapshot,
  configStats,
  defaultSnapshotName,
  discoverPlugin,
  findPersonalEndpoints,
  fmtBytes,
  getPluginConfig,
  getServerInfo,
  isIdenticalConfig,
  parseArgs,
  resolveConnection,
  stampFor,
  validateSnapshot,
} from "./jsi-snapshot-lib.mjs";

export const DEFAULT_MIN_ENTRIES = 50;
export const DEFAULT_MAX_SHRINK_PCT = 10;

const ARG_SPEC = {
  flags: ["ifChanged", "force", "allowPersonalEndpoints", "quiet", "help"],
  values: [
    "out",
    "dir",
    "url",
    "apiKey",
    "plugin",
    "baseline",
    "minEntries",
    "maxShrinkPct",
    "pruneKeep",
  ],
};

const USAGE = `usage: jsi-backup.mjs (--out <file> | --dir <dir>) [options]

  --out <file>              write the snapshot here
  --dir <dir>               write <dir>/jsi-config-<stamp>.json
  --baseline <file>         compare against this snapshot (default: newest in --dir)
  --if-changed              exit 3 without writing if identical to the baseline
  --prune-keep <n>          keep only the newest n snapshots in --dir
  --min-entries <n>         refuse below this many entries (default ${DEFAULT_MIN_ENTRIES})
  --max-shrink-pct <n>      refuse a drop larger than this vs baseline (default ${DEFAULT_MAX_SHRINK_PCT})
  --force                   write anyway when a floor trips
  --allow-personal-endpoints  skip the JEL-139 scan (local backups only, never for a commit)
  --url / --api-key         override JELLYFIN_URL / JELLYFIN_API_KEY
  --plugin <guid>           skip plugin discovery by name
  --quiet                   only print the written path
`;

/** Snapshot files in a directory, newest name first (the stamp sorts lexically). */
export function listSnapshots(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^jsi-config-\d{8}T\d{6}Z\.json$/.test(n))
    .sort()
    .reverse()
    .map((n) => join(dir, n));
}

/**
 * Every reason this config must not be written, as a list. Returning them all
 * at once beats failing on the first: an operator staring at a wiped config
 * wants to see both "12 entries" and "-89% bytes", not one then the other.
 */
export function evaluateFloors({
  stats,
  baselineStats,
  minEntries,
  maxShrinkPct,
  personalEndpoints,
}) {
  const violations = [];
  if (stats.entries < minEntries) {
    violations.push(
      `only ${stats.entries} entries (floor ${minEntries}) — this is the JELA-896 wipe signature`,
    );
  }
  if (baselineStats) {
    const shrink = assessShrink(baselineStats, stats);
    if (shrink.entriesDropPct > maxShrinkPct) {
      violations.push(
        `entry count dropped ${shrink.entriesDropPct.toFixed(1)}% vs baseline ` +
          `(${baselineStats.entries} -> ${stats.entries}, ceiling ${maxShrinkPct}%)`,
      );
    }
    if (shrink.scriptBytesDropPct > maxShrinkPct) {
      violations.push(
        `script bytes dropped ${shrink.scriptBytesDropPct.toFixed(1)}% vs baseline ` +
          `(${fmtBytes(baselineStats.scriptBytes)} -> ${fmtBytes(stats.scriptBytes)}, ceiling ${maxShrinkPct}%)`,
      );
    }
  }
  if (personalEndpoints?.length) {
    violations.push(
      `personal / dynamic-DNS hostname in the config body: ${personalEndpoints.join(", ")} ` +
        `— this snapshot is a tracked file (JEL-139)`,
    );
  }
  return violations;
}

export function pruneSnapshots(dir, keep) {
  const all = listSnapshots(dir);
  const doomed = all.slice(keep);
  for (const f of doomed) unlinkSync(f);
  return doomed;
}

function loadBaseline(path) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  validateSnapshot(snap);
  assertSnapshotIntegrity(snap);
  return snap;
}

async function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help || (!args.out && !args.dir)) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const say = args.quiet ? () => {} : (m) => console.error(m);

  const minEntries = Number(args.minEntries ?? DEFAULT_MIN_ENTRIES);
  const maxShrinkPct = Number(args.maxShrinkPct ?? DEFAULT_MAX_SHRINK_PCT);
  const { url, apiKey } = resolveConnection(args);

  const plugin = args.plugin
    ? { id: args.plugin, name: "JavaScript Injector", version: null }
    : await discoverPlugin(url, apiKey);
  const { jellyfinVersion } = await getServerInfo(url, apiKey);
  say(
    `server  Jellyfin ${jellyfinVersion}, ${plugin.name} ${plugin.version ?? "?"}`,
  );

  const config = await getPluginConfig(url, apiKey, plugin.id);
  const stats = configStats(config);
  say(
    `live    ${stats.entries} entries (${stats.enabledEntries} enabled, ` +
      `${stats.publicEntries} public), ${fmtBytes(stats.scriptBytes)} script bytes`,
  );

  // Baseline: explicit, else the newest snapshot already in --dir.
  const baselinePath =
    args.baseline || (args.dir ? listSnapshots(args.dir)[0] : undefined);
  let baseline = null;
  if (baselinePath) {
    baseline = loadBaseline(baselinePath);
    say(
      `base    ${baselinePath} (${baseline.stats.entries} entries, ` +
        `${fmtBytes(baseline.stats.scriptBytes)} script bytes, ${baseline.capturedAt})`,
    );
  } else {
    say("base    none — no shrink comparison available");
  }

  if (baseline && isIdenticalConfig(baseline.config, config)) {
    if (args.ifChanged) {
      say("unchanged since the baseline; nothing written (--if-changed)");
      return 3;
    }
    say("note    config is byte-identical to the baseline");
  }

  const personalEndpoints = args.allowPersonalEndpoints
    ? []
    : findPersonalEndpoints(JSON.stringify(config));

  const violations = evaluateFloors({
    stats,
    baselineStats: baseline?.stats,
    minEntries,
    maxShrinkPct,
    personalEndpoints,
  });
  if (violations.length) {
    for (const v of violations) {
      console.error(`${args.force ? "FORCED" : "REFUSE"}  ${v}`);
    }
    if (!args.force) {
      console.error(
        "\nNothing written. If this loss is real and intended, re-run with --force —\n" +
          "but first confirm the live config is what you think it is, because the\n" +
          "previous snapshot may be the only copy of the JellyPlug layer that exists.",
      );
      return 1;
    }
  }

  const capturedAt = new Date();
  const snapshot = buildSnapshot({
    config,
    capturedAt: capturedAt.toISOString(),
    source: {
      jellyfinVersion,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
    },
  });
  // Round-trip our own output before trusting it.
  assertSnapshotIntegrity(
    validateSnapshot(JSON.parse(JSON.stringify(snapshot))),
  );

  const outPath =
    args.out || join(args.dir, defaultSnapshotName(stampFor(capturedAt)));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  say(
    `wrote   ${outPath} (${fmtBytes(statSync(outPath).size)} B, sha256 ${snapshot.configSha256.slice(0, 12)}…)`,
  );

  if (args.pruneKeep && args.dir) {
    const gone = pruneSnapshots(args.dir, Number(args.pruneKeep));
    if (gone.length)
      say(`pruned  ${gone.length} snapshot(s) beyond --prune-keep`);
  }

  if (args.quiet) console.log(outPath);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`jsi-backup: ${e.message}`);
      process.exit(1);
    });
}
