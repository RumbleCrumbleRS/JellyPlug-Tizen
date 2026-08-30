#!/usr/bin/env node
/*
 * jsi-jp807-patch.mjs — JELA-807: fleet default-ON for the `udcGate`
 * UserDataChanged home-rebuild gate (JELA-761).
 *
 * Appends ONE seeder entry to the JS-Injector channel that writes
 * `jellyfin.shell.udcGate="1"` into every TV's localStorage.
 *
 * UNLIKE jp806, this flip owed a PUBLISH first, and it has been done: the gate
 * bytes ship in server-plugin v1.0.41.0 (commit e210a88, PR #234), and the
 * served /shell/shell.min.js is now
 *   8724caf369089db93c83ab4e9a134cbd2b775413c7c51e3d37db1e43bcc9521b
 * (243,199 B), byte-identical to main's packages/shell-tizen/src/shell.min.js
 * and carrying `udcGate`. Before that publish the served bytes were
 * 3ec5c49f…b226 with ZERO udcGate hits, so seeding the flag would have been a
 * no-op on every TV (JELA-747: "flag-dark" can mean NOT DEPLOYED — grep the
 * SERVED artifact, never the repo).
 *
 * CEO gate: JELA-807 interaction c9c730e9-035e-45fa-a32a-79a6c5aa0b4b,
 * accepted 2026-08-30T04:41:38Z by de245420. That approval covered BOTH the
 * publish and this seeder.
 *
 * ---------------------------------------------------------------------------
 * What the flag does
 * ---------------------------------------------------------------------------
 * jellyfin-web rebuilds the WHOLE home tab on every `UserDataChanged` socket
 * frame — hometab stylesheet, the /Users/{u}/Items rows and the
 * /HomeScreen/Section/* rows — whether or not any affected item is on screen.
 * The gate hooks the WebSocket onmessage accessor, normalises the frame's
 * ItemIds and the DOM's [data-id]s to dashless/lower, and drops the frame when
 * nothing it names is rendered. It fails OPEN on anything unrecognised and
 * whenever a <video> is in the document.
 *
 * JELA-807 ring (2026-08-30, virtual Tizen 5.0 panel, 8 boots / 32 pushes /
 * 0 rejected / 0 foreign frames, interleaved C1 F1 A1 G1 F2 C2 G2 A2, sized at
 * the fleet's CURRENT flag state per JELA-796 — 17 seeded flags armed):
 *   gate OFF  n=6   16.00 requests / 59,680 bytes per swallowable frame
 *   gate ON   n=6    0.00 requests /      0 bytes
 *   correctness n=4  a push for an item that IS rendered still rebuilds; PASS
 * The ON arm's zero is EARNED: all 12 ON-arm pushes took 2/2 frames at the CDP
 * layer. The gate drops in JS, after the wire, so frame receipt is
 * gate-independent — the server demonstrably emitted and the client did nothing.
 *
 * ---------------------------------------------------------------------------
 * The one property that must not be mistaken for a broken deploy
 * ---------------------------------------------------------------------------
 * THE SEED ENGAGES ONE BOOT LATE. The gate's IIFE opens with
 *     if(localStorage.getItem("jellyfin.shell.udcGate")!=="1")return;
 * and that runs ONCE, when the shell installs the socket hook at document
 * start — it is NOT re-read per frame. This channel only runs AFTER the
 * lite->SPA handoff (JELA-802), which is far later. So the boot that first
 * receives this seeder cannot arm the gate; boot N+1 arms.
 *
 * A post-flip smoke boot showing `window.__shellUdc === undefined` on boot 1
 * is CORRECT, not a failed deploy. Verify on BOOT 2 of a single fresh profile
 * (JELA-790: a served bundle does not prove a seeder — boot twice on ONE
 * profile). An armed boot reports
 * `__shellUdc = {on:1, seen, pass, dropNoHit, dropDup, held, ids, err}`.
 *
 * Per-TV kill: `jellyfin.shell.udcGate` = "0". The shell gate is `!== "1"`, so
 * "0" disarms it, and the seeder's own `!== "0"` guard means a TV that set "0"
 * itself is never re-armed by this entry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

/** localStorage flag that arms the UserDataChanged gate. */
export const FLAG_KEY = "jellyfin.shell.udcGate";
/** Channel entry name. */
export const ENTRY_NAME = "JellyPlug — udcGate default-ON (JELA-807)";
/** Grep marker proving the entry is ours. */
export const MARKER = "jp807seed";
/** Grep marker for the rollback (remover) body. */
export const ROLLBACK_MARKER = "jp807unseed";

/**
 * The seeder. Pure ES5 — the Q60R engine is M63-class and throws on ES2020+
 * (and on ES2019 `catch{`).
 * Fail-open: any localStorage throw leaves the TV on the shipped path.
 */
export const SEED_SRC =
  `/* JellyPlug — JELA-807 jp807: fleet default-ON for the JELA-761 UserDataChanged\n` +
  `   home-rebuild gate. jellyfin-web rebuilds the WHOLE home tab on every\n` +
  `   UserDataChanged frame even when nothing it names is on screen; the gate drops\n` +
  `   those frames and costs a measured 16.00 requests / 59,680 bytes each\n` +
  `   (JELA-807 ring, n=6/arm at the fleet's flag state; ON arm exactly 0; a push for\n` +
  `   a RENDERED item still rebuilds, 4/4). Gate bytes ship in server-plugin\n` +
  `   v1.0.41.0, served shell.min.js sha 8724caf3...521b.\n` +
  `   The gate reads this flag ONCE at install time, at document start, while this\n` +
  `   channel runs only AFTER the lite->SPA handoff — so the seed arms on the NEXT\n` +
  `   boot. A boot-1 'window.__shellUdc === undefined' is CORRECT, not a failed\n` +
  `   deploy; verify on boot 2 of one fresh profile.\n` +
  `   Per-TV kill: '${FLAG_KEY}'='0'. ${MARKER} */\n` +
  `(function(){try{var k="${FLAG_KEY}";if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}}catch(e){}})();\n`;

/**
 * The remover. Writes "0", which fails the shell's `=== "1"` gate AND blocks
 * the seeder's `!== "0"` re-write.
 */
export const ROLLBACK_SRC =
  `/* JellyPlug — JELA-807 ROLLBACK: disarm the udcGate fleet-wide. This REPLACES the\n` +
  `   jp807 seeder body; deleting the entry instead would leave every TV latched ON,\n` +
  `   because the flag is already in their localStorage (JELA-789). Writing "0" both\n` +
  `   fails the shell's '==="1"' gate and blocks the seeder's own '!=="0"' re-write.\n` +
  `   Like the seed, this takes effect on the NEXT boot — the gate installs once, at\n` +
  `   document start, before this channel runs.\n` +
  `   Re-flipping ON later needs a remover of this "0" first. ${ROLLBACK_MARKER} */\n` +
  `(function(){try{localStorage.setItem("${FLAG_KEY}","0");}catch(e){}})();\n`;

/** Reject anything the M63-class Q60R engine would throw on. */
export function assertEs5(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b|\basync\b|\?\.|\?\?|catch\s*\{/.test(code)) {
    throw new Error("jp807: seeder introduced non-ES5 syntax");
  }
  new vm.Script(src, { filename: "jp807.js" });
  return true;
}

/**
 * Append the seeder (or, with `rollback`, rewrite its body to the remover).
 * Fail-closed on every ambiguity; never mutates a foreign entry.
 */
export function patchConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("jp807: config has no CustomJavaScripts array");
  }
  const mine = entries.filter((e) => (e.Script || "").includes(MARKER) ||
    (e.Script || "").includes(ROLLBACK_MARKER));

  if (rollback) {
    if (mine.length !== 1) {
      throw new Error(`jp807 rollback: found ${mine.length} jp807 entries (want 1)`);
    }
    assertEs5(ROLLBACK_SRC);
    mine[0].Script = ROLLBACK_SRC;
    mine[0].Enabled = true;
    return { action: "rollback", name: mine[0].Name, entries: entries.length };
  }

  if (mine.length !== 0) {
    throw new Error(
      `jp807: seeder already present (${mine.length} entr${mine.length === 1 ? "y" : "ies"}) — refusing to double-seed`,
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
    throw new Error("jp807: pre-image reconstruction removed != 1 entry");
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
