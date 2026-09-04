#!/usr/bin/env node
/*
 * jsi-jp859-seed.mjs — JELA-886 step 2: arm `jellyplug.top10.idsplit` fleet-wide.
 *
 * JELA-859's read site (`jpOn859`, deployed by `jsi-jp859-patch.mjs`) is
 * OPT-IN — `getItem(f) === "1"`. With the key absent the shipped path runs
 * verbatim, so the channel deploy alone buys nothing. This adds the JSI
 * `CustomJavaScripts` seeder entry that writes the key on every boot.
 *
 * Shape copied from the live "JellyPlug — top10 pool flags default-ON
 * (JELA-785)" entry, with one deliberate difference: this seeds ONE key.
 * JELA-785's entry seeds `leanfields`/`sharepool`, both already fail-open
 * since jp838 — editing it would re-risk two live flags for no reason.
 *
 * The `!== "0"` guard is what makes the rollback terminate: once a TV (or the
 * rollback seeder) has written "0", this entry stops overwriting it, so
 * "set 0" is a real OFF arm and not a value the next boot re-arms.
 *
 * Under this opt-IN read site `removeItem` is also an OFF arm, but the
 * documented rollback writes the explicit "0" — the next flag will not have
 * this polarity (JELA-816/832).
 *
 * Fail-closed: refuses to run if an entry with this name already exists, if
 * any entry already WRITES the flag, if any entry other than jp859's own read
 * site so much as mentions it, or if the body is not ES5.
 *
 * Usage:
 *   node jsi-jp859-seed.mjs --config <cfg.json> --out <cfg.json>
 *   node jsi-jp859-seed.mjs --config <cfg.json> --out <cfg.json> --rollback
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

export const SPLIT_FLAG = "jellyplug.top10.idsplit";
export const SEED_NAME = "JellyPlug — top10 idsplit default-ON (JELA-859/886)";

/** The one entry allowed to carry the flag string: jp859's READ site. */
export const READ_SITE_ENTRY = /top10-badges/i;

/** Arms the flag. `!== "0"` so an explicit OFF write is never re-armed. */
export const SEED_SRC =
  "/*jp859seed*/(function(){try{var l=window.localStorage;if(!l)return;" +
  'if(l.getItem("' +
  SPLIT_FLAG +
  '")!=="0")l.setItem("' +
  SPLIT_FLAG +
  '","1")}catch(e){}})();';

/**
 * Rollback body for the same entry: writes the explicit "0" instead of
 * disabling the entry, so every TV converges to OFF on its next boot rather
 * than keeping whatever it last latched.
 */
export const ROLLBACK_SRC =
  "/*jp859seed*/(function(){try{var l=window.localStorage;if(!l)return;" +
  'l.setItem("' +
  SPLIT_FLAG +
  '","0")}catch(e){}})();';

export function makeEntry(script) {
  return {
    Name: SEED_NAME,
    Script: script,
    Enabled: true,
    RequiresAuthentication: false,
  };
}

function assertEs5(script) {
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(script)) {
    throw new Error("jp859 seeder introduced non-ES5 syntax");
  }
  new vm.Script(script, { filename: `${SEED_NAME}.js` });
}

/**
 * Append the seeder. Returns a one-line report.
 *
 * `rollback` rewrites an EXISTING seeder entry in place (it must already be
 * there — you cannot roll back a flip you never made).
 */
export function seedConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("config has no CustomJavaScripts array");
  }
  const mine = entries.filter((e) => (e.Name || "") === SEED_NAME);
  if (mine.length > 1) {
    throw new Error(`jp859 seeder is present ${mine.length} times (want <=1)`);
  }

  if (rollback) {
    if (mine.length !== 1) {
      throw new Error(
        "jp859 seeder is not in this config — nothing to roll back",
      );
    }
    assertEs5(ROLLBACK_SRC);
    mine[0].Script = ROLLBACK_SRC;
    mine[0].Enabled = true;
    return { name: SEED_NAME, action: "rollback", chars: ROLLBACK_SRC.length };
  }

  if (mine.length !== 0) {
    throw new Error("jp859 seeder is already in this config");
  }
  // Nobody else may be WRITING this flag — a second writer makes the "0"
  // rollback non-terminating (JELA-836). jp859's own read site legitimately
  // carries the flag string (`var jpF859="…"` + a getItem), so a bare
  // "mentions the flag" test would reject the very channel we just patched.
  // Two tiers, both fail-closed:
  //   a) any entry that setItem()s the literal is a writer, no exceptions;
  //   b) any OTHER entry that so much as mentions the flag is unknown to this
  //      script — it may write through a variable, so refuse rather than guess.
  const writes = new RegExp(
    `setItem\\s*\\(\\s*(["'])${SPLIT_FLAG.replace(/\./g, "\\.")}\\1`,
  );
  const writers = entries.filter((e) => writes.test(e.Script || ""));
  if (writers.length !== 0) {
    throw new Error(
      `${SPLIT_FLAG} is already written by: ${writers
        .map((e) => e.Name)
        .join(", ")}`,
    );
  }
  const strangers = entries.filter(
    (e) =>
      (e.Script || "").includes(SPLIT_FLAG) &&
      !READ_SITE_ENTRY.test(e.Name || ""),
  );
  if (strangers.length !== 0) {
    throw new Error(
      `${SPLIT_FLAG} is mentioned by an entry this script does not know: ${strangers
        .map((e) => e.Name)
        .join(", ")}`,
    );
  }
  assertEs5(SEED_SRC);
  entries.push(makeEntry(SEED_SRC));
  return { name: SEED_NAME, action: "seed", chars: SEED_SRC.length };
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
    console.error("usage: --config <cfg.json> --out <cfg.json> [--rollback]");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(args.config, "utf8"));
  const r = seedConfig(cfg, { rollback: args.rollback });
  console.error(`ok  ${r.action}  ${r.name}  ${r.chars} chars`);
  writeFileSync(args.out, JSON.stringify(cfg, null, 2));
  console.error(`wrote ${args.out}`);
}
