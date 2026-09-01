#!/usr/bin/env node
/*
 * jsi-channel-deploy.mjs — JELA-227: reconstructed snapshot/gate/rollback
 * pipeline for the JS-Injector channel (the concatenated public.js the TV
 * shell fetches).
 *
 * The web-skin's `jellyplug-theme` repo (build.py + tools/deploy.sh +
 * snapshots + cssdiff gate) was lost from the workspace (local-only, no
 * remote). Per JELA-107/108 discipline, the channel must NEVER be edited
 * API-direct without a snapshot, a structural gate, and a one-command
 * rollback. This tool reconstructs exactly that safety discipline for the
 * *JS* channel (it does NOT touch the generated theme-css entry), driven off
 * the LIVE plugin config, so the WS-B2 minify can land self-service.
 *
 * Pipeline:
 *   1. GET the live plugin config (or read a --config snapshot).
 *   2. Snapshot the ORIGINAL config verbatim to --snapshot (rollback source).
 *   3. Minify each eligible CustomJavaScripts[] body via jsi-minify-es5's
 *      transformSnippet (same precheck-clean deploy gate). A body is replaced
 *      only when: not excluded, transform succeeds, and the win >= --min-win.
 *      The generated theme-css loader (JELA-107) is ALWAYS excluded — esbuild
 *      would re-encode its <-escaped CSS string and undo that hardening.
 *   4. STRUCTURAL GATE (fail-closed): entry count/order/Names identical,
 *      Enabled + RequiresAuthentication identical per entry, PluginJavaScripts
 *      untouched, unchanged bodies byte-identical, every changed body strictly
 *      smaller AND precheck-clean, and the full concatenated channel parses.
 *   5. Print the change report + the one-command rollback line.
 *   6. With --deploy: POST the new config back to the plugin.
 *
 * Read-only by default. --deploy is the only thing that writes to the server.
 *
 *   node jsi-channel-deploy.mjs --plugin <id> [--out <newcfg.json>]
 *        --snapshot <pre.json> [--min-win N] [--deploy]
 *        [--config <live.json>]   # skip the GET, use a local snapshot
 *
 * Env: JELLYFIN_URL + JELLYFIN_API_KEY (admin token) for GET/POST.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transformSnippet, loadBabel } from "./jsi-minify-es5.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BABEL = path.join(
  HERE,
  "..",
  "..",
  "shell-tizen",
  "src",
  "babel.min.js",
);

// The generated theme-css loader (JELA-107): its body embeds minified CSS as a
// <-escaped JS string. Re-minifying would let esbuild fold < back to
// '<' and reintroduce the U+2028/</script> hazards that escaping kills. Never
// touch it here — CSS ships through its own build.
function isExcluded(name) {
  return /do not edit|generated from src\/css/i.test(name || "");
}

function parseArgs(argv) {
  const a = {
    plugin: null,
    out: null,
    snapshot: null,
    minWin: 400,
    deploy: false,
    config: null,
    babel: DEFAULT_BABEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--plugin") a.plugin = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--snapshot") a.snapshot = argv[++i];
    else if (k === "--min-win") a.minWin = parseInt(argv[++i], 10);
    else if (k === "--deploy") a.deploy = true;
    else if (k === "--config") a.config = argv[++i];
    else if (k === "--babel") a.babel = argv[++i];
    else die("unknown argument " + k);
  }
  if (!a.snapshot) die("--snapshot <path> is required (rollback source)");
  if (!a.config && !a.plugin) die("need --plugin <id> (or --config <file>)");
  return a;
}

function die(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function baseUrl() {
  const u = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
  if (!u) die("JELLYFIN_URL not set");
  return u;
}
function token() {
  const t = process.env.JELLYFIN_API_KEY;
  if (!t) die("JELLYFIN_API_KEY not set");
  return t;
}

async function getConfig(plugin) {
  const r = await fetch(baseUrl() + "/Plugins/" + plugin + "/Configuration", {
    headers: { "X-Emby-Token": token(), Accept: "application/json" },
  });
  if (!r.ok) die("GET config failed: HTTP " + r.status);
  return await r.json();
}

async function postConfig(plugin, cfg) {
  const r = await fetch(baseUrl() + "/Plugins/" + plugin + "/Configuration", {
    method: "POST",
    headers: {
      "X-Emby-Token": token(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) die("POST config failed: HTTP " + r.status);
  return r.status;
}

function bytes(s) {
  return Buffer.byteLength(s || "", "utf8");
}

async function loadEsbuild() {
  try {
    return (await import("esbuild")).default || (await import("esbuild"));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orig = args.config
    ? JSON.parse(readFileSync(args.config, "utf8"))
    : await getConfig(args.plugin);
  const cj = orig.CustomJavaScripts;
  if (!Array.isArray(cj)) die("config has no CustomJavaScripts[]");

  // Snapshot the ORIGINAL verbatim FIRST — the rollback source. Never gated on
  // anything downstream: if the run dies mid-gate, the snapshot already exists.
  writeFileSync(args.snapshot, JSON.stringify(orig, null, 2), "utf8");
  console.log(
    "snapshot written: " + args.snapshot + " (" + cj.length + " entries)",
  );

  const Babel = loadBabel(args.babel);
  const esbuild = await loadEsbuild();
  if (!esbuild) die("esbuild not resolvable — cannot minify");
  const ctx = { Babel, esbuild, minify: true };

  // Deep-copy so the snapshot object stays pristine.
  const next = JSON.parse(JSON.stringify(orig));
  const changes = [];
  const skipped = [];
  for (let i = 0; i < cj.length; i++) {
    const e = cj[i];
    const body = e.Script || "";
    if (isExcluded(e.Name)) {
      skipped.push([i, e.Name, "excluded (generated / do-not-edit)"]);
      continue;
    }
    let out;
    try {
      out = transformSnippet(body, ctx);
    } catch (ex) {
      skipped.push([i, e.Name, "gate: " + ex.message.slice(0, 70)]);
      continue;
    }
    const win = bytes(body) - bytes(out);
    if (win < args.minWin) {
      skipped.push([
        i,
        e.Name,
        "win " + win + "B < min-win " + args.minWin + "B",
      ]);
      continue;
    }
    next.CustomJavaScripts[i].Script = out;
    changes.push([i, e.Name, bytes(body), bytes(out), win]);
  }

  // ---- STRUCTURAL GATE (fail-closed) ------------------------------------
  const nj = next.CustomJavaScripts;
  const fail = (m) => die("STRUCTURAL GATE FAIL: " + m);
  if (nj.length !== cj.length) fail("entry count changed");
  if (
    JSON.stringify(orig.PluginJavaScripts) !==
    JSON.stringify(next.PluginJavaScripts)
  )
    fail("PluginJavaScripts mutated");
  const changedIdx = new Set(changes.map((c) => c[0]));
  for (let i = 0; i < cj.length; i++) {
    if (cj[i].Name !== nj[i].Name) fail("Name/order changed at #" + i);
    if (cj[i].Enabled !== nj[i].Enabled) fail("Enabled changed at #" + i);
    if (cj[i].RequiresAuthentication !== nj[i].RequiresAuthentication)
      fail("RequiresAuthentication changed at #" + i);
    if (!changedIdx.has(i)) {
      if (cj[i].Script !== nj[i].Script)
        fail("unchanged entry #" + i + " body drifted");
    } else {
      if (bytes(nj[i].Script) >= bytes(cj[i].Script))
        fail("changed entry #" + i + " not smaller");
    }
  }
  // Whole-channel parse check: concatenation must be syntactically valid JS.
  const channel = nj
    .filter((e) => e.Enabled)
    .map((e) => e.Script)
    .join("\n");
  try {
    new vm.Script(channel, { filename: "public.js" });
  } catch (ex) {
    fail("concatenated channel does not parse: " + ex.message);
  }

  // ---- Report -----------------------------------------------------------
  const totalOrig = cj.reduce((n, e) => n + bytes(e.Script), 0);
  const totalNext = nj.reduce((n, e) => n + bytes(e.Script), 0);
  changes.sort((a, b) => b[4] - a[4]);
  console.log("\n=== changed (" + changes.length + ") ===");
  for (const c of changes)
    console.log(
      `  -${String(c[4]).padStart(6)}B  #${c[0]} ${c[1]}  (${c[2]}->${c[3]})`,
    );
  console.log(
    "\ntotal channel: " +
      totalOrig +
      " -> " +
      totalNext +
      " B  (win " +
      (totalOrig - totalNext) +
      " B)",
  );
  console.log(
    "gate: PASS (order/Enabled/auth/PluginJavaScripts intact, unchanged bodies identical, channel parses)",
  );

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(next, null, 2), "utf8");
    console.log("new config written: " + args.out);
  }

  console.log(
    '\nROLLBACK (one command):\n  curl -s -X POST -H "X-Emby-Token: $JELLYFIN_API_KEY" ' +
      "-H 'Content-Type: application/json' --data-binary @" +
      args.snapshot +
      ' "$JELLYFIN_URL/Plugins/' +
      (args.plugin || "<plugin-id>") +
      '/Configuration"',
  );

  if (args.deploy) {
    if (!args.plugin) die("--deploy needs --plugin");
    const status = await postConfig(args.plugin, next);
    console.log("\nDEPLOYED: POST HTTP " + status);
  } else {
    console.log("\n(dry run — pass --deploy to POST)");
  }
}

main().catch((e) => {
  console.error("ERROR: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
