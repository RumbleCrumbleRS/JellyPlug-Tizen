#!/usr/bin/env node
/*
 * jsi-restore.mjs — JELA-898: POST a snapshot back into the JavaScript Injector.
 *
 * The counterpart to `jsi-backup.mjs`. This one writes to prod, so it is
 * dry-run by default and every guard is fail-closed.
 *
 * ---------------------------------------------------------------------------
 * The three prod behaviours this has to respect
 * ---------------------------------------------------------------------------
 * 1. THE SAVE IS OFF-BY-ONE ([[jsi-config-save-off-by-one]]). `POST
 *    /Plugins/{jsi}/Configuration` persists — the config re-GET round-trips
 *    byte-clean — but the served `/JavaScriptInjector/public.js` does NOT
 *    rebuild until the NEXT save or a server restart. JELA-762 shipped a patch
 *    that was dark for six minutes with a green config check. JELA-815 then
 *    proved the count is not fixed at two: a bundle can rebuild and still not
 *    carry your bytes, because it picked up a SIBLING's pending change. So the
 *    loop here is "POST until the SERVED artifact carries the bytes", verifying
 *    the bundle each pass — never a fixed number of saves.
 *
 * 2. THE WRITE IS A WHOLE-CONFIG READ-MODIFY-WRITE ([[jsi-config-write-race]]).
 *    There is no version check on the POST. JELA-764 silently reverted three
 *    entries because its base config was three minutes stale. So the live
 *    config is re-fetched immediately before the POST and compared against the
 *    one this run captured; if it moved, abort rather than clobber.
 *
 * 3. A STALE SNAPSHOT IS A LOADED GUN. Restoring a two-week-old snapshot over a
 *    healthy live config deletes every entry added since. Removals are refused
 *    by default and need `--allow-removals`, which prints exactly what dies.
 *    The disaster case this tool exists for — a wiped config — is pure
 *    additions, so the common path is unaffected.
 *
 * A pre-write backup of current live state is ALWAYS taken first, including on
 * a dry run, and it goes to a durable directory rather than run scratch: per
 * [[jsi-config-write-race]] the snapshot is both the rollback AND the
 * clobber-detection reference, and run scratch is deleted at run end.
 *
 * Usage:
 *   # see what would change — writes nothing to the server
 *   node jsi-restore.mjs --snapshot ../snapshots/jsi-config-20260912T190000Z.json
 *
 *   # actually restore
 *   node jsi-restore.mjs --snapshot <file> --backup-dir /var/backups/jsi --yes
 *
 * Env: JELLYFIN_URL, JELLYFIN_API_KEY (or --url / --api-key).
 *
 * Exit codes:
 *   0  restored and verified on the served bundle (or: dry run completed)
 *   4  live is already byte-identical to the snapshot; nothing to do
 *   1  a guard tripped, the POST failed, or the served bundle never carried the bytes
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  assertSnapshotIntegrity,
  buildSnapshot,
  canonicalConfigJson,
  configStats,
  defaultSnapshotName,
  diffConfigs,
  discoverPlugin,
  fmtBytes,
  getPluginConfig,
  getServedBundle,
  getServerInfo,
  isIdenticalConfig,
  parseArgs,
  postPluginConfig,
  resolveConnection,
  stampFor,
  validateSnapshot,
  verifyServed,
} from "./jsi-snapshot-lib.mjs";

export const DEFAULT_MAX_ATTEMPTS = 5;
/** Give the plugin a moment to rebuild the bundle before re-reading it. */
export const SETTLE_MS = 4000;

const ARG_SPEC = {
  flags: ["yes", "allowRemovals", "force", "skipServedCheck", "help"],
  values: [
    "snapshot",
    "url",
    "apiKey",
    "plugin",
    "backupDir",
    "maxAttempts",
    "servedPath",
  ],
};

const USAGE = `usage: jsi-restore.mjs --snapshot <file> [options]

  --snapshot <file>      the snapshot to restore (written by jsi-backup.mjs)
  --yes                  actually POST (without this it is a dry run)
  --backup-dir <dir>     where the pre-write backup goes (default: alongside the snapshot)
  --allow-removals       permit a restore that DELETES live entries
  --force                proceed even if the live config moved under us
  --max-attempts <n>     served-bundle save attempts (default ${DEFAULT_MAX_ATTEMPTS})
  --skip-served-check    do not verify /JavaScriptInjector/public.js (not recommended)
  --served-path <path>   default /JavaScriptInjector/public.js
  --url / --api-key      override JELLYFIN_URL / JELLYFIN_API_KEY
  --plugin <guid>        skip plugin discovery by name
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render a diff for a human about to overwrite prod. */
export function formatDiff(diff) {
  const lines = [];
  lines.push(
    `  ${diff.added.length} added, ${diff.removed.length} removed, ` +
      `${diff.changed.length} changed, ${diff.unchanged} unchanged`,
  );
  for (const e of diff.removed) {
    lines.push(`    - REMOVE  ${e.name}  (${fmtBytes(e.bytes)} B)`);
  }
  for (const e of diff.added) {
    lines.push(`    + ADD     ${e.name}  (${fmtBytes(e.bytes)} B)`);
  }
  for (const e of diff.changed) {
    lines.push(
      `    ~ CHANGE  ${e.name}  (${e.delta >= 0 ? "+" : ""}${fmtBytes(e.delta)} B)`,
    );
  }
  if (diff.otherKeysChanged.length) {
    lines.push(`    ~ KEYS    ${diff.otherKeysChanged.join(", ")}`);
  }
  return lines.join("\n");
}

async function writePreBackup({ dir, config, source, label }) {
  const now = new Date();
  const snap = buildSnapshot({
    config,
    capturedAt: now.toISOString(),
    source: { ...source, note: label },
  });
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `pre-restore-${defaultSnapshotName(stampFor(now)).replace(/^jsi-config-/, "")}`,
  );
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
  return { path, snap };
}

async function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help || !args.snapshot) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const maxAttempts = Number(args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const servedPath = args.servedPath || "/JavaScriptInjector/public.js";
  const { url, apiKey } = resolveConnection(args);

  // 1. Load and fully validate the snapshot BEFORE touching the server.
  const snapshot = JSON.parse(readFileSync(args.snapshot, "utf8"));
  validateSnapshot(snapshot);
  assertSnapshotIntegrity(snapshot);
  const wantStats = configStats(snapshot.config);
  console.error(
    `snapshot ${args.snapshot}\n` +
      `         captured ${snapshot.capturedAt} on Jellyfin ${snapshot.source?.jellyfinVersion ?? "?"}\n` +
      `         ${wantStats.entries} entries, ${fmtBytes(wantStats.scriptBytes)} script bytes, ` +
      `sha256 ${snapshot.configSha256.slice(0, 12)}…`,
  );

  const plugin = args.plugin
    ? { id: args.plugin, name: "JavaScript Injector", version: null }
    : await discoverPlugin(url, apiKey);
  const { jellyfinVersion } = await getServerInfo(url, apiKey);
  console.error(
    `server   Jellyfin ${jellyfinVersion}, ${plugin.name} ${plugin.version ?? "?"}`,
  );

  // 2. Capture current live state and back it up before anything else.
  const liveBefore = await getPluginConfig(url, apiKey, plugin.id);
  const liveStats = configStats(liveBefore);
  console.error(
    `live     ${liveStats.entries} entries, ${fmtBytes(liveStats.scriptBytes)} script bytes`,
  );

  const backupDir = args.backupDir || join(args.snapshot, "..");
  const { path: backupPath } = await writePreBackup({
    dir: backupDir,
    config: liveBefore,
    source: {
      jellyfinVersion,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
    },
    label: `pre-restore state, superseded by ${args.snapshot}`,
  });
  console.error(`backup   ${backupPath}`);

  if (isIdenticalConfig(liveBefore, snapshot.config)) {
    console.error("\nlive config is already byte-identical to the snapshot.");
    if (!args.yes) return 4;
    console.error(
      "proceeding anyway (--yes): this exercises the save + served-verify path.",
    );
  }

  // 3. Show the operator exactly what this does.
  const diff = diffConfigs(liveBefore, snapshot.config);
  console.error(`\nrestore would apply:\n${formatDiff(diff)}`);

  if (diff.removed.length && !args.allowRemovals) {
    console.error(
      `\nREFUSE: this restore DELETES ${diff.removed.length} live entr${diff.removed.length === 1 ? "y" : "ies"} ` +
        `listed above.\nThat is the signature of restoring a stale snapshot over a healthy config.\n` +
        `If you really mean it, re-run with --allow-removals. The pre-restore backup\n` +
        `above is your rollback either way.`,
    );
    return 1;
  }

  if (!args.yes) {
    console.error(
      "\nDRY RUN — nothing was POSTed. Re-run with --yes to apply.",
    );
    return 0;
  }

  // 4. Re-fetch immediately before the write and refuse to clobber a concurrent
  //    writer ([[jsi-config-write-race]]).
  const liveNow = await getPluginConfig(url, apiKey, plugin.id);
  if (canonicalConfigJson(liveNow) !== canonicalConfigJson(liveBefore)) {
    const raced = diffConfigs(liveBefore, liveNow);
    console.error(
      `\n${args.force ? "FORCED" : "REFUSE"}: the live config changed while this run was preparing:\n` +
        `${formatDiff(raced)}`,
    );
    if (!args.force) {
      console.error(
        "\nAnother writer is mid-deploy. Re-run once it finishes so your restore is\n" +
          "based on their state, or pass --force to overwrite it.",
      );
      return 1;
    }
  }

  // 5. POST until the SERVED artifact carries the bytes.
  let servedOk = false;
  let lastReport = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await postPluginConfig(url, apiKey, plugin.id, snapshot.config);

    const roundTrip = await getPluginConfig(url, apiKey, plugin.id);
    if (!isIdenticalConfig(roundTrip, snapshot.config)) {
      const drift = diffConfigs(snapshot.config, roundTrip);
      console.error(
        `\nFAIL: config did not round-trip after POST ${attempt}:\n${formatDiff(drift)}`,
      );
      return 1;
    }
    console.error(`post ${attempt}   config round-trips byte-clean`);

    if (args.skipServedCheck) {
      servedOk = true;
      break;
    }

    await sleep(SETTLE_MS);
    const served = await getServedBundle(url, servedPath);
    const report = verifyServed(snapshot.config, served.text);
    lastReport = { ...report, served };
    console.error(
      `         served ${fmtBytes(served.bytes)} B sha ${served.sha256.slice(0, 12)}… — ` +
        `${report.present}/${report.expected} entries present` +
        (report.unverifiable
          ? `, ${report.unverifiable} private (unverifiable)`
          : ""),
    );
    if (report.missing.length === 0) {
      servedOk = true;
      break;
    }
    console.error(
      `         ${report.missing.length} entr${report.missing.length === 1 ? "y" : "ies"} not yet in the bundle ` +
        `(save is off-by-one) — re-POSTing`,
    );
  }

  if (!servedOk) {
    console.error(
      `\nFAIL: after ${maxAttempts} saves the served bundle still misses ` +
        `${lastReport?.missing.length} entr${lastReport?.missing.length === 1 ? "y" : "ies"}:\n` +
        `  ${lastReport?.missing.slice(0, 10).join("\n  ")}\n` +
        `The CONFIG is stored correctly (it round-tripped), so TVs will pick this up\n` +
        `on the next save or a server restart. Re-run, or POST /System/Restart.\n` +
        `Rollback if needed: jsi-restore.mjs --snapshot ${backupPath} --yes`,
    );
    return 1;
  }

  console.error(
    `\nOK: restored ${wantStats.entries} entries and verified them in the served bundle.\n` +
      `Rollback if needed: jsi-restore.mjs --snapshot ${backupPath} --allow-removals --yes`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`jsi-restore: ${e.message}`);
      process.exit(1);
    });
}
