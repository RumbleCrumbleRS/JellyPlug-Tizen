#!/usr/bin/env node
/*
 * jsi-jp806-patch.mjs — JELA-806: fleet default-ON for `lsWriteBehind`.
 *
 * Appends ONE seeder entry to the JS-Injector channel that writes
 * `jellyfin.shell.lsWriteBehind="1"` into every TV's localStorage. The shell
 * bytes that read that flag are ALREADY SERVED (v1.0.90, shell.min.js sha
 * 3ec5c49fb8a84dbb0f47f3b39c5ebcc5874a1bdf26955757846b929beb44b226), so no
 * publish is owed — this patch is the entire flip.
 *
 * CEO gate: JELA-806 interaction 09a53e59-85ec-4d8c-884d-047c75cab639,
 * accepted 2026-08-30T03:30:43Z by de245420.
 *
 * ---------------------------------------------------------------------------
 * What the flag does
 * ---------------------------------------------------------------------------
 * Without it the shell writes ~315 tx cache keys one `setItem` at a time, and
 * almost none of them clear M63's localStorage commit throttle before the TV
 * is powered off — so a cache that looks full in-page is empty on the next
 * boot. `installLsWriteBehind()` buffers writes and coalesces every value
 * >=4096 chars into ONE synchronous pass (~3.17 MB) that the engine commits as
 * a single transaction.
 *
 * JELA-776 AC A/B (2026-08-30, clear preflight box, n=3):
 *   AC1'  154/154 version-keyed slots persist, vs a BIMODAL control of 2/48/30
 *   AC2'  boot 2 inherits 154 slots at document start;
 *         warm firstCard 2,791 ms vs cold 6,936 ms
 *   AC3'  flush deterministic (fl=128-129, qe=0, 21-45 ms), no instability
 *
 * ---------------------------------------------------------------------------
 * Two properties that must not be mistaken for a broken deploy
 * ---------------------------------------------------------------------------
 * 1. THE SEED ENGAGES ONE BOOT LATE. `installLsWriteBehind()` is called at the
 *    very top of the shell IIFE (packages/shell-tizen/src/shell.js) and reads
 *    the flag ONCE at install time — not per call. The JSI channel only runs
 *    after the lite->SPA handoff (JELA-802), which is far later. So the boot
 *    that first receives this seeder cannot arm the overlay; boot N+1 arms.
 *    A post-flip smoke boot showing `window.__shellLsWB === undefined` on
 *    boot 1 is CORRECT. Verify on boot 2 of a single profile.
 *    (Contrast jp768/jp801, whose gate is a per-call read and so arms
 *    same-boot. Entry ORDER inside the channel does not change this — the
 *    whole channel is post-handoff.)
 *
 * 2. THE WIN NEEDS ~300 s OF UPTIME. The coalesced flush still has to clear
 *    M63's commit throttle (JELA-748). At a 45 s window the ON arm persists
 *    less than control — a short window INVERTS THE SIGN. A TV power-cycled
 *    within ~45 s of boot sees no benefit.
 *
 * Also expect ONE cold boot fleet-wide immediately after the POST: a channel
 * deploy purges the whole tx cache (JELA-800).
 *
 * ---------------------------------------------------------------------------
 * Polarity, and why the seed may be unconditional
 * ---------------------------------------------------------------------------
 * The gate in the SERVED bytes reads, verbatim:
 *
 *   enabled = localStorage.getItem("jellyfin.shell.lsWriteBehind") !== "0"
 *          && localStorage.getItem("jellyfin.shell.lsWriteBehindDisabled") !== "1"
 *
 * JELA-827 flipped the first clause from `=== "1"` to `!== "0"`: this channel
 * runs only after the lite->SPA handoff, while installLsWriteBehind() runs at
 * the TOP of the shell, so the seeded "1" could never arm a cold boot.
 *
 * The kill switch always wins, so seeding the flag can never override a TV
 * that opted out via `...Disabled`. The seeder additionally honours the
 * house-style `!== "0"` guard (jp799a/b), so an explicit per-TV `"0"` also
 * survives the seed.
 *
 * ROLLBACK IS A REMOVER, NOT A DELETE (JELA-789). Deleting this entry leaves
 * every TV latched ON forever, because the flag is already in their
 * localStorage. `--rollback` swaps the seeder body for one that writes `"0"`,
 * which both trips the shell's `!== "0"` enable clause and blocks this seeder's own
 * `!== "0"` re-write. (Re-flipping ON later therefore needs a remover of that
 * `"0"` first.)
 *
 * Usage:
 *   node jsi-jp806-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp806-patch.mjs --config <live-cfg.json> --out <c.json> --rollback
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the write-behind overlay. */
export const FLAG_KEY = "jellyfin.shell.lsWriteBehind";
/** Per-TV kill switch, honoured by the shell ahead of the flag. */
export const KILL_KEY = "jellyfin.shell.lsWriteBehindDisabled";
/** Channel entry name. */
export const ENTRY_NAME = "JellyPlug — lsWriteBehind default-ON (JELA-806)";
/** Grep marker proving the entry is ours. */
export const MARKER = "jp806seed";
/** Grep marker for the rollback (remover) body. */
export const ROLLBACK_MARKER = "jp806unseed";

/**
 * The seeder. Pure ES5 — the Q60R engine is M63-class and throws on ES2020+.
 * Fail-open: any localStorage throw leaves the TV on the shipped path.
 */
export const SEED_SRC =
  `/* JellyPlug — JELA-806 jp806: fleet default-ON for installLsWriteBehind. The shell\n` +
  `   writes ~315 tx keys one at a time and almost none clear M63's localStorage commit\n` +
  `   throttle before power-off; the flag coalesces every value >=4096 chars into ONE\n` +
  `   synchronous pass that commits as a single transaction (JELA-776: 154/154 slots\n` +
  `   persist vs a bimodal 2/48/30 control). Per-TV kill: '${FLAG_KEY}'='0'\n` +
  `   or '${KILL_KEY}'='1'.\n` +
  `   installLsWriteBehind() runs at the TOP of the shell IIFE and reads the flag ONCE at\n` +
  `   install time, while this channel only runs AFTER the lite->SPA handoff, so the seed\n` +
  `   takes effect on the NEXT boot — a boot-1 'window.__shellLsWB === undefined' is\n` +
  `   CORRECT, not a failed deploy. ${MARKER} */\n` +
  `(function(){try{var k="${FLAG_KEY}";if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}}catch(e){}})();\n`;

/**
 * The remover. Writes "0", which trips the shell's `!== "0"` enable clause
 * (JELA-827; it failed the older `=== "1"` gate too) AND blocks
 * the seeder's `!== "0"` re-write. Deliberately does NOT touch KILL_KEY — a TV
 * that set it itself keeps it.
 */
export const ROLLBACK_SRC =
  `/* JellyPlug — JELA-806 ROLLBACK: disarm lsWriteBehind fleet-wide. This REPLACES the\n` +
  `   jp806 seeder body; deleting the entry instead would leave every TV latched ON,\n` +
  `   because the flag is already in their localStorage (JELA-789). Writing "0" both\n` +
  `   fails the shell's '==="1"' gate and blocks the seeder's own '!=="0"' re-write.\n` +
  `   Re-flipping ON later needs a remover of this "0" first. ${ROLLBACK_MARKER} */\n` +
  `(function(){try{localStorage.setItem("${FLAG_KEY}","0");}catch(e){}})();\n`;

/** Reject anything the M63-class Q60R engine would throw on. */
export function assertEs5(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    /=>|`|\blet\b|\bconst\b|\bclass\b|\basync\b|\?\.|\?\?|catch\s*\{/.test(code)
  ) {
    throw new Error("jp806: seeder introduced non-ES5 syntax");
  }
  new vm.Script(src, { filename: "jp806.js" });
  return true;
}

/**
 * Append the seeder (or, with `rollback`, rewrite its body to the remover).
 * Fail-closed on every ambiguity; never mutates a foreign entry.
 */
export function patchConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("jp806: config has no CustomJavaScripts array");
  }
  const mine = entries.filter(
    (e) =>
      (e.Script || "").includes(MARKER) ||
      (e.Script || "").includes(ROLLBACK_MARKER),
  );

  if (rollback) {
    if (mine.length !== 1) {
      throw new Error(
        `jp806 rollback: found ${mine.length} jp806 entries (want 1)`,
      );
    }
    assertEs5(ROLLBACK_SRC);
    mine[0].Script = ROLLBACK_SRC;
    mine[0].Enabled = true;
    return { action: "rollback", name: mine[0].Name, entries: entries.length };
  }

  if (mine.length !== 0) {
    throw new Error(
      `jp806: seeder already present (${mine.length} entr${mine.length === 1 ? "y" : "ies"}) — refusing to double-seed`,
    );
  }
  assertEs5(SEED_SRC);
  entries.push({
    Name: ENTRY_NAME,
    Script: SEED_SRC,
    Enabled: true,
    RequiresAuthentication: false,
  });
  return { action: "seed", name: ENTRY_NAME, entries: entries.length };
}

/**
 * Prove the edit by RECONSTRUCTING the pre-image byte-for-byte (JELA-805): a
 * marker count and a byte delta cannot detect a foreign writer racing us.
 * Returns the reconstructed pre-image for the caller to compare against the
 * config it actually fetched.
 */
export function reconstructPreImage(patchedCfg) {
  const clone = JSON.parse(JSON.stringify(patchedCfg));
  const before = clone.CustomJavaScripts.length;
  clone.CustomJavaScripts = clone.CustomJavaScripts.filter(
    (e) => !(e.Script || "").includes(MARKER),
  );
  if (clone.CustomJavaScripts.length !== before - 1) {
    throw new Error("jp806: pre-image reconstruction removed != 1 entry");
  }
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
  console.error(`ok  ${r.action}  "${r.name}"  entries=${r.entries}`);
  writeFileSync(args.out, JSON.stringify(cfg));
  console.error(`wrote ${args.out}`);
}
