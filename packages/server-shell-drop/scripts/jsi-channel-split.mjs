#!/usr/bin/env node
/*
 * jsi-channel-split.mjs — JELA-228 (WS-B1): build-time critical/deferred split
 * of the JS-Injector channel (the concatenated public.js the TV shell fetches).
 *
 * WHY. On M63 (the fleet floor) boot cost is PARSE-dominated (JELA-41/50/52).
 * ~32% of the live channel is page-specific snippets that NEVER render the home
 * page — search, item-detail, and player/idle. Deferring their PARSE past the
 * first home card is the biggest remaining payload lever (WS-B1). But the
 * JS-Injector serves only ONE artifact: public.js = concat of the ENABLED
 * CustomJavaScripts[]. To move those bytes off the boot parse path the boot
 * channel must SHRINK; the deferred bytes are then re-delivered after first
 * paint. Step 1 of that (this tool) is a validated build-time split.
 *
 * WHAT. Read-only. Partitions the live enabled channel into two bodies by a
 * name-keyed DEFERRED_SNIPPETS contract (below), runs a FAIL-CLOSED structural
 * gate on the LIVE bytes, and emits the two channel bodies (+ a manifest). It
 * NEVER writes the server — it is the offline validator/artifact-emitter that
 * the eventual serve mechanism (server-side partition task, or a publish step)
 * must match, exactly as build-tx-drop.mjs is the offline validator for the
 * on-device tx-drop. The deferred name-set here is the single source of truth;
 * jsi-channel-split.test.cjs guards its shape and disjointness.
 *
 * The generated theme-css loader (JELA-107) and every boot/home-critical
 * snippet stay on the CRITICAL body by construction (they are simply absent
 * from DEFERRED_SNIPPETS), and the gate re-asserts theme-css is never deferred.
 *
 * Gate (fail-closed — any failure aborts before any file is written past the
 * verbatim snapshot):
 *   1. Every name in DEFERRED_SNIPPETS is present AND enabled in the live
 *      channel (typo / rename drift is a hard error, not a silent no-op).
 *   2. The partition is complete and disjoint: |critical| + |deferred| equals
 *      the enabled-entry count; every enabled entry lands in exactly one body.
 *   3. Body-byte conservation: sum(critical bodies) + sum(deferred bodies)
 *      equals sum(all enabled bodies) — no snippet dropped, duplicated, or
 *      mutated (the split only re-buckets; it never rewrites a body).
 *   4. theme-css / any do-not-edit generated entry is on CRITICAL.
 *   5. Both the critical AND the deferred body parse as valid standalone JS.
 *
 *   node jsi-channel-split.mjs --plugin <id> --snapshot <pre.json>
 *        [--out-critical crit.js] [--out-deferred def.js] [--out-manifest m.json]
 *        [--config <live.json>]     # skip the GET, use a local snapshot
 *        [--allow-missing]          # downgrade gate #1 to a warning
 *
 * Env: JELLYFIN_URL + JELLYFIN_API_KEY (admin token) for the GET.
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

// ---- Deferred-snippet contract (guarded by jsi-channel-split.test.cjs) -----
// Slug is the token after the "— " in a snippet Name ("JellyPlug — search-
// results" -> "search-results"). Every slug here is a page-specific snippet
// that renders ONLY on search / item-detail / playback+idle surfaces and is
// never on the critical path to the first HOME card. Boot- and home-critical
// snippets (netflix-rows, top10-badges, my-list, watch-it-again, top-picks,
// media-bar, the home-resume family, theme-css, tizen-compat, …) are
// deliberately ABSENT so they stay on the critical body.
//
// On-device caveat (WS-B1 flip gate): the detail-page CTAs (next-episode-cta,
// movie-resume-cta, start-over-cta) sit adjacent to the home-resume family in
// channel order; they are treated as detail-only here and MUST be confirmed
// non-home on the settle measurement before the flip lands.
export const DEFERRED_SNIPPETS = Object.freeze({
  // search surface (search box / results page only)
  search: Object.freeze([
    "search-extras",
    "search-results",
    "search-clear",
    "results-filter-bar",
  ]),
  // item-detail page only
  detail: Object.freeze([
    "streaming-availability",
    "person-page",
    "match-score",
    "detail-meta",
    "detail-advisory",
    "detail-tags",
    "detail-languages",
    "detail-top10-rank",
    "detail-logo",
    "detail-backdrop",
    "episode-guide",
    "detail-extras",
    "detail-similar",
    "detail-collection",
    "detail-hero-trailer",
    "next-episode-cta",
    "movie-resume-cta",
    "start-over-cta",
    "taste-rating",
    "detail-buttons-declutter",
    "reviews-empty",
  ]),
  // playback + idle/screensaver surfaces only
  player: Object.freeze([
    "still-watching",
    "ambient-screensaver",
    "postplay-endcard",
    "player-episodes",
    "player-maturity-flash",
  ]),
});

// Flattened lookup set of every deferred slug.
export const DEFERRED_SET = Object.freeze(
  new Set(
    [
      ...DEFERRED_SNIPPETS.search,
      ...DEFERRED_SNIPPETS.detail,
      ...DEFERRED_SNIPPETS.player,
    ].map((s) => s.toLowerCase()),
  ),
);

// The generated theme-css loader and any do-not-edit body must stay critical
// (mirrors jsi-channel-deploy.mjs isExcluded — the CSS ships via its own build
// and must never be re-bucketed onto a deferred, post-first-card path).
export function isGenerated(name) {
  return /do not edit|generated from src\/css/i.test(name || "");
}

// Extract the snippet slug from a CustomJavaScripts Name. Names look like
// "JellyPlug — search-results" or "JellyPlug — focus-popdown (JELA-89)"; the
// slug is the first [a-z0-9-] token after the em-dash. Returns "" when absent.
export function snippetSlug(name) {
  const m = /—\s*([a-z0-9-]+)/.exec(name || "");
  return m ? m[1] : "";
}

// True when an enabled entry belongs on the DEFERRED body.
export function isDeferred(name) {
  if (isGenerated(name)) return false;
  return DEFERRED_SET.has(snippetSlug(name));
}

function die(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function bytes(s) {
  return Buffer.byteLength(s || "", "utf8");
}

function parseArgs(argv) {
  const a = {
    plugin: null,
    snapshot: null,
    outCritical: null,
    outDeferred: null,
    outManifest: null,
    config: null,
    allowMissing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--plugin") a.plugin = argv[++i];
    else if (k === "--snapshot") a.snapshot = argv[++i];
    else if (k === "--out-critical") a.outCritical = argv[++i];
    else if (k === "--out-deferred") a.outDeferred = argv[++i];
    else if (k === "--out-manifest") a.outManifest = argv[++i];
    else if (k === "--config") a.config = argv[++i];
    else if (k === "--allow-missing") a.allowMissing = true;
    else die("unknown argument " + k);
  }
  if (!a.snapshot) die("--snapshot <path> is required (verbatim source copy)");
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

// Core split — pure over a config object. Returned so the test can drive it
// against fixtures without a server. Throws on any gate failure.
export function splitChannel(cfg, { allowMissing = false } = {}) {
  const cj = cfg.CustomJavaScripts;
  if (!Array.isArray(cj)) throw new Error("config has no CustomJavaScripts[]");

  const enabled = cj.filter((e) => e && e.Enabled);
  const critical = [];
  const deferred = [];
  for (const e of enabled) {
    (isDeferred(e.Name) ? deferred : critical).push(e);
  }

  // ---- Gate #1: every listed deferred slug is present and enabled ----------
  const enabledSlugs = new Set(
    enabled.filter((e) => !isGenerated(e.Name)).map((e) => snippetSlug(e.Name)),
  );
  const missing = [...DEFERRED_SET].filter((s) => !enabledSlugs.has(s));
  if (missing.length) {
    const msg =
      "deferred slugs not found enabled in channel: " + missing.join(", ");
    if (allowMissing) console.warn("WARN: " + msg);
    else throw new Error(msg + " (pass --allow-missing to downgrade)");
  }

  // ---- Gate #2: complete + disjoint partition ------------------------------
  if (critical.length + deferred.length !== enabled.length) {
    throw new Error("partition not complete/disjoint");
  }

  // ---- Gate #4: theme-css / generated bodies never deferred ----------------
  if (deferred.some((e) => isGenerated(e.Name))) {
    throw new Error("a do-not-edit/generated body landed on the deferred side");
  }

  const critBody = critical.map((e) => e.Script || "").join("\n");
  const defBody = deferred.map((e) => e.Script || "").join("\n");

  // ---- Gate #3: body-byte conservation -------------------------------------
  const sumEnabled = enabled.reduce((n, e) => n + bytes(e.Script), 0);
  const sumParts =
    critical.reduce((n, e) => n + bytes(e.Script), 0) +
    deferred.reduce((n, e) => n + bytes(e.Script), 0);
  if (sumParts !== sumEnabled) {
    throw new Error(
      "body bytes not conserved: parts=" + sumParts + " enabled=" + sumEnabled,
    );
  }

  // ---- Gate #5: both bodies parse as standalone JS -------------------------
  try {
    new vm.Script(critBody, { filename: "jsi-critical.js" });
  } catch (ex) {
    throw new Error("critical body does not parse: " + ex.message);
  }
  try {
    new vm.Script(defBody, { filename: "jsi-deferred.js" });
  } catch (ex) {
    throw new Error("deferred body does not parse: " + ex.message);
  }

  return {
    critical,
    deferred,
    critBody,
    defBody,
    sumEnabled,
    critBytes: bytes(critBody),
    defBytes: bytes(defBody),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orig = args.config
    ? JSON.parse(readFileSync(args.config, "utf8"))
    : await getConfig(args.plugin);

  // Verbatim snapshot FIRST (parity with jsi-channel-deploy discipline) so an
  // operator always has the exact pre-split source even though this tool never
  // writes the server itself.
  writeFileSync(args.snapshot, JSON.stringify(orig, null, 2), "utf8");
  console.log(
    "snapshot written: " +
      args.snapshot +
      " (" +
      (orig.CustomJavaScripts || []).length +
      " entries)",
  );

  const r = splitChannel(orig, { allowMissing: args.allowMissing });

  // ---- Report --------------------------------------------------------------
  const groups = { search: 0, detail: 0, player: 0 };
  const gcount = { search: 0, detail: 0, player: 0 };
  const slugGroup = new Map();
  for (const [g, slugs] of Object.entries(DEFERRED_SNIPPETS))
    for (const s of slugs) slugGroup.set(s, g);
  for (const e of r.deferred) {
    const g = slugGroup.get(snippetSlug(e.Name));
    if (g) {
      groups[g] += bytes(e.Script);
      gcount[g] += 1;
    }
  }
  console.log("\n=== deferred groups ===");
  for (const g of Object.keys(groups))
    console.log(
      `  ${g.padEnd(8)} ${String(gcount[g]).padStart(2)} snippets  ${String(
        groups[g],
      ).padStart(7)} B`,
    );
  const pct = ((100 * r.defBytes) / r.sumEnabled).toFixed(1);
  console.log(
    "\ntotal enabled: " +
      r.sumEnabled +
      " B  ->  critical " +
      r.critBytes +
      " B + deferred " +
      r.defBytes +
      " B  (deferred = " +
      pct +
      "% off boot parse, " +
      r.deferred.length +
      " snippets)",
  );
  console.log(
    "gate: PASS (list present+enabled, partition complete/disjoint, bytes conserved, theme-css critical, both bodies parse)",
  );

  if (args.outCritical) {
    writeFileSync(args.outCritical, r.critBody, "utf8");
    console.log("critical body written: " + args.outCritical);
  }
  if (args.outDeferred) {
    writeFileSync(args.outDeferred, r.defBody, "utf8");
    console.log("deferred body written: " + args.outDeferred);
  }
  if (args.outManifest) {
    const manifest = {
      generatedFromEntries: (orig.CustomJavaScripts || []).length,
      enabledBytes: r.sumEnabled,
      criticalBytes: r.critBytes,
      deferredBytes: r.defBytes,
      deferredPct: Number(pct),
      deferredNames: r.deferred.map((e) => snippetSlug(e.Name)),
      groups: DEFERRED_SNIPPETS,
    };
    writeFileSync(args.outManifest, JSON.stringify(manifest, null, 2), "utf8");
    console.log("manifest written: " + args.outManifest);
  }
}

// Only run the CLI when invoked directly (the test imports the pure exports).
if (
  process.argv[1] &&
  import.meta.url === "file://" + process.argv[1].replace(/\\/g, "/")
) {
  main().catch((e) => {
    console.error("ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
