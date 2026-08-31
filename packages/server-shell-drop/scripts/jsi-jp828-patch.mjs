#!/usr/bin/env node
/*
 * jsi-jp828-patch.mjs — JELA-828: fleet flip for the JELA-816 genre-row wave
 * fan-out (`jellyplug.rows.genreLazy`).
 *
 * jp816 is already on the live JS-Injector channel and DARK (deployed
 * 2026-08-31 17:08 UTC, CEO interaction c42d7cea). This script turns it ON for
 * every TV, and it does TWO things, because either one alone is wrong:
 *
 *   1) FLIPS THE READ SITE from opt-in to opt-OUT. The gate jp816 shipped is
 *        return s0.getItem("jellyplug.rows.genreLazy")==="1"
 *      i.e. an absent key means OFF. Seeding alone would then leave the flip
 *      hostage to the order in which the channel document happens to run
 *      (JELA-821/823/827: a channel-seeded gate that is READ opt-in arms one
 *      boot late, because this channel runs only after the lite->SPA handoff).
 *      After the flip an absent key means ON, so the first boot that receives
 *      the entry takes the wave path no matter when the seeder ran.
 *   2) APPENDS THE SEEDER that writes the key explicitly, guarded `!== "0"`.
 *      That is what makes the per-TV kill DURABLE (JELA-827): a TV that holds
 *      "0" is never re-armed, and the key is present in localStorage so a
 *      later rollback has something to overwrite.
 *
 * The kill switch is untouched and still wins: `jellyplug.rows.genreLazy`
 * `Disabled` = "1" is tested BEFORE the arm key, so a single per-TV write
 * disarms a flipped fleet with no redeploy.
 *
 * localStorage that THROWS still means OFF (the shipped `catch` returns !1).
 * That is deliberate and differs from JELA-823's "unreadable gate = ON": the
 * cost of standing down is 6 surplus queries on an engine whose storage is
 * already broken, and the wave path's own state lives in that same engine.
 *
 * ---------------------------------------------------------------------------
 * What the flip buys — measured, not modelled
 * ---------------------------------------------------------------------------
 * JELA-816 rig ring, JELA-112 virtual Tizen 5.0, live shell b43aa2b7, armed vs
 * same-session control, 6/6 valid boots:
 *
 *   control  14 genre GETs + 14 CORS preflights   90,873 B   8 rows
 *   armed     8 genre GETs +  8 CORS preflights   55,092 B   8 rows
 *
 * = -12 requests / -35,773 B on EVERY boot, with a byte-identical home (same 8
 * rows, same order: Action | Comedy | Critically Acclaimed Dramas | Adventure |
 * Trending in Horror | Animation | Sci-Fi | Thrillers). Images were OFF in the
 * rig, so the byte figure is a floor — on a panel each surplus row also pulls
 * artwork.
 *
 * ---------------------------------------------------------------------------
 * Rollback
 * ---------------------------------------------------------------------------
 * `--rollback` is a full inverse and NOT a delete (JELA-773/789: once the fleet
 * is seeded, an absent key is no longer an OFF arm — and after the read-site
 * flip an absent key is an ON arm, which is worse). It:
 *   - puts the read site back to `==="1"`, so an unseeded TV is OFF again, and
 *   - rewrites the seeder body to write "0", which fails the restored gate AND
 *     blocks any future seeder pass (`!== "0"`).
 * Per-TV rollback needs neither: write `jellyplug.rows.genreLazyDisabled`="1".
 *
 * Deploy discipline is unchanged and non-negotiable: a config POST replaces
 * EVERY entry, so re-fetch the live config and re-run this patcher IMMEDIATELY
 * before the POST (jsi-config-write-race), POST TWICE (the served bundle
 * rebuilds on the NEXT save), and verify the SERVED bundle, never the stored
 * config (jsi-config-save-off-by-one).
 *
 * Usage:
 *   node jsi-jp828-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp828-patch.mjs --config <live-cfg.json> --out <cfg.json> --rollback
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";
import {
  FLAG_KEY,
  KILL_KEY,
  WAVE_SRC,
  PATCH_ROWS,
} from "./jsi-jp816-patch.mjs";

export { FLAG_KEY, KILL_KEY };

/** The `genre-rows` entry, matched the same way jp816 matches it. */
export const ENTRY_RE = PATCH_ROWS.entry;

/** Channel entry name for the seeder. */
export const ENTRY_NAME = "JellyPlug — genreLazy default-ON (JELA-828)";
/** Grep marker proving the seeder entry is ours. */
export const MARKER = "jp828seed";
/** Grep marker for the rollback (disarm) body. */
export const ROLLBACK_MARKER = "jp828unseed";

/*
 * The read site, taken from jp816's own source so the two can never drift: if
 * jp816's gate is ever re-worded, this module fails to load rather than
 * silently patching nothing.
 */
export const READ_OPT_IN = `return s0.getItem("${FLAG_KEY}")==="1"}catch(e0){return!1}`;
export const READ_OPT_OUT = `return s0.getItem("${FLAG_KEY}")!=="0"}catch(e0){return!1}`;

if (WAVE_SRC.split(READ_OPT_IN).length - 1 !== 1) {
  throw new Error(
    "jp828: jp816's read site no longer matches READ_OPT_IN — re-derive the anchor",
  );
}

/**
 * The seeder. Pure ES5 — the Q60R panel engine is M63-class and throws on
 * ES2020+ (and on ES2019 `catch{`). Fails open: any localStorage throw leaves
 * the TV on whatever the read site decides for a key it cannot read (OFF).
 */
export const SEED_SRC =
  `/* JellyPlug — JELA-828 jp828: fleet default-ON for the JELA-816 genre-row wave\n` +
  `   fan-out. The home ships 14 genre candidates and mounts 8; the shipped code\n` +
  `   fetches all 14 in one burst, and because the queries are cross-origin each\n` +
  `   surplus one also costs a CORS preflight. Waves fetch 8, and only walk further\n` +
  `   down the SAME ordered candidate list if a row came back thin — so the rendered\n` +
  `   set is identical and the cost is never higher than today's.\n` +
  `   Measured (JELA-816 ring, virtual Tizen 5.0, 6/6 valid boots): 14 GETs +\n` +
  `   14 preflights / 90,873 B -> 8 + 8 / 55,092 B, same 8 rows in the same order.\n` +
  `   = -12 requests / -35,773 B per boot, images OFF so that is a floor.\n` +
  `   The read site is opt-OUT as of JELA-828, so this seeder is not what arms the\n` +
  `   feature — it makes the per-TV kill durable: a TV holding "0" is never re-armed.\n` +
  `   Per-TV kill: '${KILL_KEY}'='1' (wins over the arm key, same boot), or\n` +
  `   '${FLAG_KEY}'='0'. ${MARKER} */\n` +
  `(function(){try{var k="${FLAG_KEY}";if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}}catch(e){}})();\n`;

/**
 * The disarm body. Writes "0", which fails the RESTORED `==="1"` read site and
 * blocks the seeder's own `!== "0"` re-write. Paired with the read-site
 * restore in `patchConfig(cfg, {rollback:true})` — either half alone leaves
 * part of the fleet armed.
 */
export const ROLLBACK_SRC =
  `/* JellyPlug — JELA-828 ROLLBACK: disarm the genre-row wave fan-out fleet-wide.\n` +
  `   This REPLACES the jp828 seeder body and is applied together with a restore of\n` +
  `   the genre-rows read site to '==="1"'. Deleting the entry instead would leave\n` +
  `   every TV latched ON, because the flag is already in their localStorage\n` +
  `   (JELA-789), and an absent key reads as ON while the opt-OUT site is live.\n` +
  `   Takes effect on the boot that receives it: the read happens at genre fan-out\n` +
  `   time, which is after this channel document has run.\n` +
  `   Re-flipping ON later needs a remover of this "0" first. ${ROLLBACK_MARKER} */\n` +
  `(function(){try{localStorage.setItem("${FLAG_KEY}","0");}catch(e){}})();\n`;

/** Reject anything the M63-class panel engine would throw on. */
export function assertEs5(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    /=>|`|\blet\b|\bconst\b|\bclass\b|\basync\b|\?\.|\?\?|catch\s*\{/.test(code)
  ) {
    throw new Error("jp828: seeder introduced non-ES5 syntax");
  }
  new vm.Script(src, { filename: "jp828.js" });
  return true;
}

/** Swap the read site one way or the other. Fail-closed: exactly one hit. */
export function flipReadSite(body, { rollback = false } = {}) {
  const from = rollback ? READ_OPT_OUT : READ_OPT_IN;
  const to = rollback ? READ_OPT_IN : READ_OPT_OUT;
  const hits = body.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(
      `jp828 read-site anchor matched ${hits} times (want exactly 1) — ` +
        (rollback
          ? "is the fleet flip actually applied?"
          : "is jp816 deployed, and not already flipped?"),
    );
  }
  return body.replace(from, to);
}

/** The one `genre-rows` entry, or a throw. */
function genreRowsEntry(entries) {
  const hit = entries.filter((e) => ENTRY_RE.test(e.Name || ""));
  if (hit.length !== 1) {
    throw new Error(
      `jp828: ${ENTRY_RE} matched ${hit.length} channel entries (want 1)`,
    );
  }
  return hit[0];
}

/**
 * Flip the read site and append the seeder (or, with `rollback`, restore the
 * read site and rewrite the seeder body to the disarm form).
 * Fail-closed on every ambiguity; never mutates a foreign entry.
 */
export function patchConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("jp828: config has no CustomJavaScripts array");
  }
  const rows = genreRowsEntry(entries);
  const mine = entries.filter(
    (e) =>
      (e.Script || "").includes(MARKER) ||
      (e.Script || "").includes(ROLLBACK_MARKER),
  );

  if (rollback) {
    if (mine.length !== 1) {
      throw new Error(
        `jp828 rollback: found ${mine.length} jp828 entries (want 1)`,
      );
    }
    const before = rows.Script || "";
    const after = flipReadSite(before, { rollback: true });
    new vm.Script(after, { filename: `${rows.Name}.js` });
    assertEs5(ROLLBACK_SRC);
    rows.Script = after;
    mine[0].Script = ROLLBACK_SRC;
    mine[0].Enabled = true;
    return {
      action: "rollback",
      rows: rows.Name,
      name: mine[0].Name,
      entries: entries.length,
    };
  }

  if (mine.length !== 0) {
    throw new Error(
      `jp828: seeder already present (${mine.length} entr${mine.length === 1 ? "y" : "ies"}) — refusing to double-seed`,
    );
  }
  const before = rows.Script || "";
  const after = flipReadSite(before);
  new vm.Script(after, { filename: `${rows.Name}.js` });
  assertEs5(SEED_SRC);
  rows.Script = after;
  entries.push({
    Name: ENTRY_NAME,
    Script: SEED_SRC,
    Enabled: true,
    RequiresAuthentication: false,
  });
  return {
    action: "flip",
    rows: rows.Name,
    name: ENTRY_NAME,
    entries: entries.length,
  };
}

/**
 * Prove the edit by RECONSTRUCTING the pre-image byte-for-byte (JELA-805): a
 * marker count and a byte delta cannot detect a foreign writer racing our
 * POST. Undoes BOTH halves — drop the seeder entry, restore the read site —
 * and returns the result for the caller to compare against the config it
 * actually fetched.
 */
export function reconstructPreImage(patchedCfg) {
  const clone = JSON.parse(JSON.stringify(patchedCfg));
  const before = clone.CustomJavaScripts.length;
  clone.CustomJavaScripts = clone.CustomJavaScripts.filter(
    (e) => !(e.Script || "").includes(MARKER),
  );
  if (clone.CustomJavaScripts.length !== before - 1) {
    throw new Error("jp828: pre-image reconstruction removed != 1 entry");
  }
  const rows = genreRowsEntry(clone.CustomJavaScripts);
  rows.Script = flipReadSite(rows.Script || "", { rollback: true });
  return clone;
}

function parseArgs(argv) {
  const a = { config: null, out: null, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--config") a.config = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--rollback") a.rollback = true;
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.out) {
    console.error("need --config <cfg.json> --out <cfg.json> [--rollback]");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(args.config, "utf8"));
  const r = patchConfig(cfg, { rollback: args.rollback });
  console.error(
    `ok  ${r.action}  rows="${r.rows}"  seeder="${r.name}"  entries=${r.entries}`,
  );
  writeFileSync(args.out, JSON.stringify(cfg));
  console.error(`wrote ${args.out}`);
}
