#!/usr/bin/env node
/*
 * jsi-image-rightsize.mjs — JELA-435 (WS-E3): right-size the JellyPlug skin's
 * home-row poster requests on the JS-Injector channel.
 *
 * WHY (measured on Q60R / Tizen 5.0 / Chrome 63, 2026-08-01):
 *   The skin's home rows build their own cards and ask the server for
 *   `maxWidth=400` posters. On a 1080p panel (devicePixelRatio 1) a
 *   `.jp-card-poster` renders **167x251 CSS px** and the skin's largest focus
 *   scale is 1.06 -> 177 px. The request is therefore ~2.4x oversampled in
 *   width (~5.7x in pixel area). Measured on five real posters, dropping the
 *   width to the rendered size cut 247,602 B -> 66,215 B (-73%). `jp-top10`
 *   thumbs are a fixed 150x220 and request `maxWidth=300`.
 *   162 of 208 image requests in a boot are this group, and they occupy the
 *   firstCard->settle window (+7,190..+28,290 ms rel. handoff).
 *
 * WHAT: replaces the hard-coded literal at each allow-listed call site with a
 * viewport-derived expression, so 1080p panels ask for ~200 px while a 4K
 * browser still gets the full 400. Nothing else about the channel changes.
 *
 *   maxWidth:400      -> maxWidth:Math.max(160,Math.min(400,Math.round(window.innerWidth/9.6)))
 *   imageMaxWidth:300 -> imageMaxWidth:Math.max(160,Math.min(300,Math.round(window.innerWidth/12)))
 *
 * Same JELA-107/108 deploy discipline as jsi-channel-deploy.mjs: snapshot
 * first, fail-closed structural gate, one-command rollback, read-only unless
 * --deploy. The gate here is stricter than the minify one in one respect: the
 * transform must be exactly INVERTIBLE — re-substituting the literal has to
 * reproduce the original body byte-for-byte, so a changed body can differ from
 * its original at the intended call sites and nowhere else.
 *
 *   node jsi-image-rightsize.mjs --plugin <id> --snapshot pre.json \
 *        [--out next.json] [--config live.json] [--revert] [--deploy]
 *
 * Env: JELLYFIN_URL + JELLYFIN_API_KEY (admin token) for GET/POST.
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

// Viewport-derived widths. Floored so a mis-sized viewport can never request a
// thumbnail smaller than the smallest layout, capped at the current literal so
// this can only ever REDUCE what a big screen asks for.
export const POSTER_EXPR =
  "Math.max(160,Math.min(400,Math.round(window.innerWidth/9.6)))";
export const TOP10_EXPR =
  "Math.max(160,Math.min(300,Math.round(window.innerWidth/12)))";

/*
 * Allow-list. `key` matches the snippet Name (the live names carry an em dash
 * and are not safe to compare literally from a shell), `find` is the exact
 * literal, and `count` is how many times it must occur — a different count
 * means the snippet was rewritten upstream and we fail closed rather than
 * guess. Only home-boot row builders are listed: the detail/search/postplay
 * builders also use maxWidth:400 but render at unverified sizes and are not in
 * the boot window.
 */
export const SITES = [
  { key: "top-picks", find: "maxWidth:400", expr: POSTER_EXPR, count: 1 },
  { key: "watch-it-again", find: "maxWidth:400", expr: POSTER_EXPR, count: 1 },
  { key: "my-list", find: "maxWidth:400", expr: POSTER_EXPR, count: 1 },
  { key: "genre-rows", find: "maxWidth:400", expr: POSTER_EXPR, count: 1 },
  { key: "new-hot", find: "maxWidth:400", expr: POSTER_EXPR, count: 1 },
  {
    key: "top10-badges",
    find: "imageMaxWidth:300",
    expr: TOP10_EXPR,
    count: 1,
  },
];

// A rewritten site is `<name>:<expr>`; the inverse maps it back to the literal.
const applied = (site) => site.find.split(":")[0] + ":" + site.expr;

export function bytes(s) {
  return Buffer.byteLength(s || "", "utf8");
}

function countOf(hay, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

function replaceAll(hay, needle, next) {
  return hay.split(needle).join(next);
}

/**
 * Rewrite (or revert) the allow-listed call sites.
 * Returns { next, changes:[{index,name,key,from,to,delta}] }.
 * Throws on any ambiguity — the caller must not deploy a partial result.
 */
export function rightsizeChannel(cfg, opts = {}) {
  const revert = !!opts.revert;
  const cj = cfg && cfg.CustomJavaScripts;
  if (!Array.isArray(cj)) throw new Error("config has no CustomJavaScripts[]");
  const next = JSON.parse(JSON.stringify(cfg));
  const changes = [];

  for (const site of SITES) {
    const hits = [];
    for (let i = 0; i < cj.length; i++) {
      if (String(cj[i].Name || "").includes(site.key)) hits.push(i);
    }
    if (hits.length !== 1) {
      throw new Error(
        `site "${site.key}": expected exactly 1 matching snippet, found ${hits.length}`,
      );
    }
    const i = hits[0];
    const body = cj[i].Script || "";
    const from = revert ? applied(site) : site.find;
    const to = revert ? site.find : applied(site);
    const found = countOf(body, from);
    if (found !== site.count) {
      throw new Error(
        `site "${site.key}" (#${i} ${cj[i].Name}): expected ${site.count}x "${from}", found ${found}`,
      );
    }
    // Guard against a body that already contains the destination form: the
    // inverse check below would still pass, but the report would lie.
    if (countOf(body, to) !== 0) {
      throw new Error(
        `site "${site.key}" (#${i}): body already contains the target form`,
      );
    }
    const out = replaceAll(body, from, to);
    // INVERTIBILITY: the only difference must be at the intended sites.
    if (replaceAll(out, to, from) !== body) {
      throw new Error(
        `site "${site.key}" (#${i}): transform is not invertible`,
      );
    }
    next.CustomJavaScripts[i].Script = out;
    changes.push({
      index: i,
      name: cj[i].Name,
      key: site.key,
      from,
      to,
      delta: bytes(out) - bytes(body),
    });
  }
  return { next, changes };
}

/** Fail-closed structural gate. Throws with the reason; returns true on pass. */
export function gate(orig, next, changes, opts = {}) {
  const maxDelta = opts.maxDelta == null ? 200 : opts.maxDelta;
  const cj = orig.CustomJavaScripts;
  const nj = next.CustomJavaScripts;
  const fail = (m) => {
    throw new Error("STRUCTURAL GATE FAIL: " + m);
  };
  if (nj.length !== cj.length) fail("entry count changed");
  if (
    JSON.stringify(orig.PluginJavaScripts) !==
    JSON.stringify(next.PluginJavaScripts)
  )
    fail("PluginJavaScripts mutated");
  const changed = new Map(changes.map((c) => [c.index, c]));
  for (let i = 0; i < cj.length; i++) {
    if (cj[i].Name !== nj[i].Name) fail("Name/order changed at #" + i);
    if (cj[i].Enabled !== nj[i].Enabled) fail("Enabled changed at #" + i);
    if (cj[i].RequiresAuthentication !== nj[i].RequiresAuthentication)
      fail("RequiresAuthentication changed at #" + i);
    if (!changed.has(i)) {
      if (cj[i].Script !== nj[i].Script)
        fail("unchanged entry #" + i + " body drifted");
      continue;
    }
    // Recompute the delta from the bodies rather than trusting the change
    // record — the gate has to hold against a `next` that was tampered with
    // after the transform ran.
    const delta = bytes(nj[i].Script) - bytes(cj[i].Script);
    if (Math.abs(delta) > maxDelta)
      fail(`entry #${i} size delta ${delta} B exceeds +/-${maxDelta} B`);
    try {
      new vm.Script(nj[i].Script, { filename: "snippet-" + i + ".js" });
    } catch (ex) {
      fail(`changed entry #${i} does not parse: ${ex.message}`);
    }
  }
  const channel = nj
    .filter((e) => e.Enabled)
    .map((e) => e.Script)
    .join("\n");
  try {
    new vm.Script(channel, { filename: "public.js" });
  } catch (ex) {
    fail("concatenated channel does not parse: " + ex.message);
  }
  return true;
}

// ---------------------------------------------------------------- CLI ------
function die(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const a = {
    plugin: null,
    out: null,
    snapshot: null,
    config: null,
    deploy: false,
    revert: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--plugin") a.plugin = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--snapshot") a.snapshot = argv[++i];
    else if (k === "--config") a.config = argv[++i];
    else if (k === "--deploy") a.deploy = true;
    else if (k === "--revert") a.revert = true;
    else die("unknown argument " + k);
  }
  if (!a.snapshot) die("--snapshot <path> is required (rollback source)");
  if (!a.config && !a.plugin) die("need --plugin <id> (or --config <file>)");
  return a;
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
    headers: { "X-Emby-Token": token(), "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) die("POST config failed: HTTP " + r.status);
  return r.status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orig = args.config
    ? JSON.parse(readFileSync(args.config, "utf8"))
    : await getConfig(args.plugin);

  // Snapshot the ORIGINAL verbatim FIRST — the rollback source, never gated on
  // anything downstream.
  writeFileSync(args.snapshot, JSON.stringify(orig, null, 2), "utf8");
  console.log(
    "snapshot written: " +
      args.snapshot +
      " (" +
      orig.CustomJavaScripts.length +
      " entries)",
  );

  let next, changes;
  try {
    ({ next, changes } = rightsizeChannel(orig, { revert: args.revert }));
    gate(orig, next, changes);
  } catch (ex) {
    die(ex.message);
  }

  console.log(
    "\n=== " + (args.revert ? "reverted" : "rewritten") + " call sites ===",
  );
  for (const c of changes) {
    console.log(
      `  #${c.index} ${c.name}\n      ${c.from}  ->  ${c.to}   (${c.delta >= 0 ? "+" : ""}${c.delta} B)`,
    );
  }
  const totalDelta = changes.reduce((n, c) => n + c.delta, 0);
  console.log(
    `\nchannel delta: ${totalDelta >= 0 ? "+" : ""}${totalDelta} B over ${changes.length} sites`,
  );
  console.log(
    "gate: PASS (order/Enabled/auth/PluginJavaScripts intact, unchanged bodies identical, transform invertible, channel parses)",
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
    console.log(
      "\nDEPLOYED: POST HTTP " + (await postConfig(args.plugin, next)),
    );
  } else {
    console.log("\n(dry run — pass --deploy to POST)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
