#!/usr/bin/env node
/*
 * jsi-channel-split.test.cjs — JELA-228 (WS-B1) guard for jsi-channel-split.mjs.
 *
 * 1) CONTRACT: the DEFERRED_SNIPPETS name-set is the single source of truth for
 *    what leaves the boot parse path. A boot/home-critical snippet slipping in
 *    would silently defer a snippet the FIRST home card needs — so the test
 *    pins the set's shape (slug form, no duplicates, disjoint groups) and
 *    asserts a denylist of known boot/home slugs never appears in it.
 * 2) FUNCTION: splitChannel() over fixtures produces a complete + disjoint
 *    partition, conserves body bytes, keeps do-not-edit/theme-css on the
 *    critical side, parses both bodies, and fails closed on a missing slug.
 *
 * Run: node scripts/jsi-channel-split.test.cjs
 *   or: pnpm --filter @jellyfin-tv/server-shell-drop test
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");

// Fixtures deliberately carry only a few deferred slugs, so allowMissing runs
// emit an expected WARN for every absent slug. Mute it around those calls so
// CI logs stay readable — the assertions, not the warning, are the signal.
function quiet(fn) {
  const w = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = w;
  }
}

// Slugs that MUST always render (or be available for) the first home card:
// boot chain, home rows, media bar, and the home-resume family. If any of
// these ever lands in DEFERRED_SNIPPETS the split would push a home-critical
// snippet past first paint.
const HOME_CRITICAL_DENYLIST = [
  "tizen-compat",
  "theme-css",
  "locale-guard",
  "boot-splash",
  "pre-theme-guard",
  "scroll-restore-guard",
  "doc-x-guard",
  "netflix-rows",
  "row-reaper",
  "vertical-cards",
  "top10-badges",
  "my-list",
  "genre-rows",
  "row-see-all",
  "watch-it-again",
  "top-picks",
  "media-bar",
  "mediabar-guard",
  "mediabar-tizen5",
  "notifysync-tizen5",
  "hero-runtime",
  "header-scroll",
  "tv-row-nav",
  "new-hot",
  "play-something",
  "home-episode-caption",
  "home-resume-left",
  "resume-cover-art",
  "resume-dismiss",
  "diag-beacon",
];

async function main() {
  const tool = await import(
    "file://" + path.join(__dirname, "jsi-channel-split.mjs")
  );
  const {
    DEFERRED_SNIPPETS,
    DEFERRED_SET,
    splitChannel,
    snippetSlug,
    isDeferred,
    isGenerated,
  } = tool;

  // ---- 1) contract shape ---------------------------------------------------
  const flat = [
    ...DEFERRED_SNIPPETS.search,
    ...DEFERRED_SNIPPETS.detail,
    ...DEFERRED_SNIPPETS.player,
  ];
  assert.ok(flat.length >= 20, "expected a substantial deferred set");
  assert.strictEqual(
    DEFERRED_SET.size,
    flat.length,
    "DEFERRED_SET size must equal the flattened group count (no cross-group dupes)",
  );
  for (const s of flat) {
    assert.ok(
      /^[a-z0-9-]+$/.test(s),
      "slug must be lowercase kebab: " + JSON.stringify(s),
    );
  }
  // groups disjoint (already implied by the size check, asserted explicitly)
  const seen = new Set();
  for (const s of flat) {
    assert.ok(!seen.has(s), "duplicate deferred slug: " + s);
    seen.add(s);
  }
  // no home/boot-critical slug is ever deferred
  for (const s of HOME_CRITICAL_DENYLIST) {
    assert.ok(
      !DEFERRED_SET.has(s),
      "home/boot-critical slug must never be deferred: " + s,
    );
  }

  // ---- 2) helpers ----------------------------------------------------------
  assert.strictEqual(
    snippetSlug("JellyPlug — search-results"),
    "search-results",
  );
  assert.strictEqual(
    snippetSlug("JellyPlug — focus-popdown (JELA-89)"),
    "focus-popdown",
  );
  assert.strictEqual(snippetSlug("no dash here"), "");
  assert.ok(isDeferred("JellyPlug — search-results"));
  assert.ok(!isDeferred("JellyPlug — netflix-rows"));
  assert.ok(
    isGenerated(
      "JellyPlug — theme-css (JELA-107, generated from src/css — do not edit)",
    ),
  );
  // a generated body is never deferred even if its slug matched
  assert.ok(
    !isDeferred("JellyPlug — theme-css (generated from src/css — do not edit)"),
  );

  // ---- 3) splitChannel over a fixture --------------------------------------
  const cfg = {
    PluginJavaScripts: [],
    CustomJavaScripts: [
      {
        Name: "JellyPlug — tizen-compat (load first)",
        Enabled: true,
        Script: "var boot=1;",
      },
      {
        Name: "JellyPlug — theme-css (generated from src/css — do not edit)",
        Enabled: true,
        Script: 'var css="body{}";',
      },
      {
        Name: "JellyPlug — netflix-rows",
        Enabled: true,
        Script: "function rows(){return 2;}",
      },
      {
        Name: "JellyPlug — search-results",
        Enabled: true,
        Script: "function sr(){return 3;}",
      },
      { Name: "JellyPlug — detail-meta", Enabled: true, Script: "var dm=4;" },
      {
        Name: "JellyPlug — postplay-endcard",
        Enabled: true,
        Script: "var pp=5;",
      },
      // disabled entries are ignored entirely
      {
        Name: "JellyPlug — search-clear",
        Enabled: false,
        Script: "var IGNORED=6;",
      },
    ],
  };
  // the fixture only exercises a few deferred slugs, so allowMissing.
  const r = quiet(() => splitChannel(cfg, { allowMissing: true }));

  const critSlugs = r.critical.map((e) => snippetSlug(e.Name)).sort();
  const defSlugs = r.deferred.map((e) => snippetSlug(e.Name)).sort();
  assert.deepStrictEqual(critSlugs, [
    "netflix-rows",
    "theme-css",
    "tizen-compat",
  ]);
  assert.deepStrictEqual(defSlugs, [
    "detail-meta",
    "postplay-endcard",
    "search-results",
  ]);

  // complete + disjoint over ENABLED entries (6 enabled: 3 + 3)
  assert.strictEqual(r.critical.length + r.deferred.length, 6);

  // body-byte conservation over enabled bodies
  const b = (s) => Buffer.byteLength(s, "utf8");
  const expected =
    b("var boot=1;") +
    b('var css="body{}";') +
    b("function rows(){return 2;}") +
    b("function sr(){return 3;}") +
    b("var dm=4;") +
    b("var pp=5;");
  assert.strictEqual(
    r.sumEnabled,
    expected,
    "sumEnabled must cover all enabled bodies",
  );

  // generated theme-css is on the critical side
  assert.ok(r.critBody.includes('var css="body{}";'));
  assert.ok(!r.defBody.includes("var css"));

  // both bodies parse (splitChannel already asserts; re-check they are non-empty)
  assert.ok(r.critBytes > 0 && r.defBytes > 0);

  // ---- 4) fail-closed on a missing slug ------------------------------------
  const bad = {
    CustomJavaScripts: [
      { Name: "JellyPlug — netflix-rows", Enabled: true, Script: "var a=1;" },
    ],
  };
  assert.throws(
    () => splitChannel(bad, { allowMissing: false }),
    /not found enabled/,
    "must fail closed when a deferred slug is absent from the channel",
  );

  // ---- 5) a deferred body that does not parse is rejected ------------------
  const broken = {
    CustomJavaScripts: [
      { Name: "JellyPlug — netflix-rows", Enabled: true, Script: "var ok=1;" },
      {
        Name: "JellyPlug — search-results",
        Enabled: true,
        Script: "function(",
      },
    ],
  };
  assert.throws(
    () => quiet(() => splitChannel(broken, { allowMissing: true })),
    /deferred body does not parse/,
    "must reject a deferred partition that is not valid standalone JS",
  );

  console.log("jsi-channel-split.test.cjs: all assertions passed");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
