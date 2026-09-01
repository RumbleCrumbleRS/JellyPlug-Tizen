#!/usr/bin/env node
/*
 * jsi-jp838-patch.test.cjs — JELA-838 guard for jsi-jp838-patch.mjs.
 *
 * jp838 arms eight already-approved fleet-ON levers on the FIRST boot. The
 * dangerous questions are not "does the text swap apply" but "which TVs change
 * behaviour, and can a single TV still opt out". Every check below is a way
 * this has gone wrong before on this codebase:
 *
 *  1) POLARITY BY EXECUTION, ON THE REAL BODY (JELA-827/828). Not by grep: the
 *     arm key is a PREFIX of the kill key for all eight flags, and five of the
 *     twelve read sites take their key through a variable or a parameter, so a
 *     literal-shaped regex sees 8 of 12. Each gate is COMPILED and CALLED
 *     across the full store truth table, before and after the patch.
 *  2) THE BOOT-1 DEFECT IS REPRODUCED FIRST. Every pre-image gate must be OFF
 *     on an empty store — that is the bug. A treatment column means nothing
 *     without it (JELA-827: a capture whose positive control is dark is void).
 *  3) THE KILL PATH SURVIVES THE FLIP (AC3). Five readers had no `*Disabled`
 *     term at all, so under an opt-out read a killed TV would come back armed.
 *     `<flag>Disabled="1"` must win in the same boot, even against an explicit
 *     arm key of "1" — which is a STRICTLY stronger kill than the pre-image
 *     had, and is asserted as such.
 *  4) SEEDER GUARDS CANNOT RE-ARM A DISARMED TV (JELA-827). The three loose
 *     seeders are booted: a stored "0" must survive a seeder pass.
 *  5) ROLLBACK IS AN EXACT INVERSE (JELA-773/789/805). flip -> rollback must
 *     reproduce the fetched config BYTE-FOR-BYTE, which is also the only check
 *     that detects a foreign writer racing our POST.
 *  6) FAIL-CLOSED ANCHORS. Zero hits, a short count, or a foreign entry
 *     carrying the same bytes must throw, never patch nothing and report
 *     success (JELA-747/816).
 *  7) NO COLLATERAL. Every untouched entry stays byte-identical.
 *  8) ES5. The Q60R panel engine is M63-class and throws on ES2020+.
 *  9) NO DOUBLE-FLIP, and no rollback of an unflipped config.
 * 10) SCOPE. Exactly the eight ticket flags move; `genreLazy` (already
 *     opt-out) and every `*Disabled` switch keep their polarity.
 *
 * The entry bodies below are the REGIONS OF THE LIVE CHANNEL the patch
 * touches, copied verbatim from `GET /Plugins/{jsi}/Configuration` on
 * 2026-09-01 (109 entries), with reduced stand-ins around them. If the channel
 * drifts, the patcher's own anchors throw first — this fixture is what proves
 * the anchors still MEAN what the ticket says they mean.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const MOD = path.join(__dirname, "jsi-jp838-patch.mjs");

/* -------------------------------------------------------------------------
 * Verbatim live channel regions
 * ---------------------------------------------------------------------- */
const LIVE = {
  prefetch:
    'var F="jellyplug.rows.prefetch",ST=50,MX=200,R=[],H=null,tr=0,fired=0;' +
    'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}',
  viewgate:
    'var F="jellyplug.rows.viewgate",P=750,MX=800,LK=1080;' +
    "var Q=[],H=null,mxT=null,scr=0,fired=0,polls=0,opened=0,why=null;" +
    'function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}',
  navkeep:
    "function jpOn755(w){try{return!!(w.localStorage&&" +
    'w.localStorage.getItem("jellyplug.rows.navkeep")==="1")}catch(e){return!1}}',
  top10:
    "function jpOn754(f){try{return!!(g.localStorage&&" +
    'g.localStorage.getItem(f)==="1")}catch(e){return!1}}',
  hero:
    "function jp791F(w){try{var l=w.localStorage;return!!(l&&" +
    'l.getItem("jellyplug.mediabar.heroPoolRead")==="1"&&' +
    'l.getItem("jellyplug.mediabar.heroPoolReadDisabled")!=="1")}catch(e){return!1}}',
  pool:
    'jp762On(){return this.jp762Ls("jellyplug.mediabar.poolPrefetch")==="1"&&' +
    'this.jp762Ls("jellyplug.mediabar.poolPrefetchDisabled")!=="1"}',
  pageCache:
    'function jp768On(){return jp768Ls("jellyplug.filterbar.pageCache")==="1"&&' +
    'jp768Ls("jellyplug.filterbar.pageCacheDisabled")!=="1"}',
  seed745:
    '(function(){try{var l=localStorage;\nif(l.getItem("jellyplug.rows.prefetchDisabled")!=="1")' +
    '{l.setItem("jellyplug.rows.prefetch","1");}\n}catch(e){}})();',
  seed791:
    "(function(){try{var l=localStorage;\n" +
    'if(l.getItem("jellyplug.mediabar.poolPrefetchDisabled")!=="1")' +
    '{l.setItem("jellyplug.mediabar.poolPrefetch","1");}\n' +
    'if(l.getItem("jellyplug.mediabar.heroPoolReadDisabled")!=="1")' +
    '{l.setItem("jellyplug.mediabar.heroPoolRead","1");}\n}catch(e){}})();',
  seed768:
    '(function(){try{var k="jellyplug.filterbar.pageCache";' +
    'if(localStorage.getItem(k)!=="1"){localStorage.setItem(k,"1");}}catch(e){}})();',
  // Already opt-out (JELA-828) — the control that must NOT move.
  genreLazy:
    "function jpOn816(){try{var s0=d.localStorage;if(!s0)return!1;" +
    'if(s0.getItem("jellyplug.rows.genreLazyDisabled")==="1")return!1;' +
    'return s0.getItem("jellyplug.rows.genreLazy")!=="0"}catch(e0){return!1}}',
};

/** A config shaped like the live one: the touched entries plus neighbours. */
function makeConfig() {
  return {
    CustomJavaScripts: [
      {
        Name: "JellyPlug — tizen-compat (load first)",
        Script: `(function(s){"use strict";var n={};/*jp745*/n.rowPrefetch=(function(){${LIVE.prefetch};return{on:on}})(),/*jp815*/n.rowViewGate=(function(){${LIVE.viewgate};return{on:on}})();s.JellyPlug=n})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — row prefetch default-ON (JELA-745/747)",
        Script: `/* jp745seed */\n${LIVE.seed745}`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — top10-badges",
        // The two call sites are what bind the parameterised helper to its two
        // flags — without them an audit cannot tell WHICH flags it gates.
        Script:
          `(function(g){"use strict";/*jp754*/${LIVE.top10}` +
          `function jpFlds754(ty){if(!jpOn754("jellyplug.top10.leanfields"))return"PrimaryImageAspectRatio,CriticRating";return"CriticRating"}` +
          `function jpGet754(d,u,t){if(!jpOn754("jellyplug.top10.sharepool"))return null;return null}` +
          `g.__jp754={f:jpFlds754,g:jpGet754}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — my-list",
        Script: `(function(s){"use strict";/*jp755*/${LIVE.navkeep}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — genre-rows",
        Script: `(function(d){"use strict";/*jp816*/${LIVE.genreLazy}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — watch-it-again",
        Script: `(function(c){"use strict";/*jp755*/${LIVE.navkeep}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — top-picks",
        Script: `(function(c){"use strict";/*jp755*/${LIVE.navkeep}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — results-filter-bar",
        Script: `(function(f){"use strict";var jpPC768={};function jp768Ls(k){try{return f.localStorage?f.localStorage.getItem(k):null}catch(x){return null}}${LIVE.pageCache}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — mediabar-tizen5-rescue (JELA-115)",
        Script: `(function(){"use strict";var ApiUtils={/*jp762*/jp762Ls(k){try{return window.localStorage?window.localStorage.getItem(k):null}catch(e){return null}},${LIVE.pool}};window.__ApiUtils=ApiUtils})();`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — hero-runtime",
        Script: `(function(u){"use strict";/*jp791*/${LIVE.hero}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — match-score",
        Script: `(function(b){"use strict";/*jp791*/${LIVE.hero}/*jp755*/${LIVE.navkeep}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — home-resume-left",
        Script: `(function(s){"use strict";/*jp755*/${LIVE.navkeep}})(window);`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — mediabar poolPrefetch+heroPoolRead default-ON (JELA-791)",
        Script: `/* jp791seed */\n${LIVE.seed791}`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — filterbar.pageCache default-ON (JELA-768/801)",
        Script: `/* jp801seed */\n${LIVE.seed768}`,
        Enabled: true,
      },
      {
        Name: "JellyPlug — genreLazy default-ON (JELA-828)",
        Script:
          '/*jp828seed*/(function(){try{var k="jellyplug.rows.genreLazy";' +
          'if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}}catch(e){}})();',
        Enabled: true,
      },
    ],
  };
}

/** A localStorage stub. `mode:"throw"` models a TV whose store is broken. */
function stubLs(initial, mode) {
  if (mode === "throw") {
    return {
      getItem() {
        throw new Error("QuotaExceeded");
      },
      setItem() {
        throw new Error("QuotaExceeded");
      },
    };
  }
  const map = Object.assign(Object.create(null), initial);
  return {
    map,
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = String(v);
    },
    removeItem: (k) => {
      delete map[k];
    },
  };
}

function stubWin(initial, mode) {
  const ls = stubLs(initial, mode);
  return { win: { localStorage: ls }, ls };
}

/* -------------------------------------------------------------------------
 * The truth table. `null` = "this site does not gate that flag".
 * ---------------------------------------------------------------------- */
const READ_SITES = [
  { id: "jp745-read", live: "prefetch", flag: "jellyplug.rows.prefetch" },
  { id: "jp815-read", live: "viewgate", flag: "jellyplug.rows.viewgate" },
  { id: "jp755-read", live: "navkeep", flag: "jellyplug.rows.navkeep" },
  { id: "jp754-read", live: "top10", flag: "jellyplug.top10.sharepool" },
  { id: "jp754-read", live: "top10", flag: "jellyplug.top10.leanfields" },
  { id: "jp791-read", live: "hero", flag: "jellyplug.mediabar.heroPoolRead" },
  { id: "jp762-read", live: "pool", flag: "jellyplug.mediabar.poolPrefetch" },
  {
    id: "jp768-read",
    live: "pageCache",
    flag: "jellyplug.filterbar.pageCache",
  },
];

/** Gates that had NO kill-switch term before this patch. */
const NO_KILL_BEFORE = new Set([
  "jellyplug.rows.prefetch",
  "jellyplug.rows.viewgate",
  "jellyplug.rows.navkeep",
  "jellyplug.top10.sharepool",
  "jellyplug.top10.leanfields",
]);

/** Gates whose helper turns an unreadable store into `null`, not a throw. */
const NULL_ON_THROW = new Set([
  "jellyplug.mediabar.poolPrefetch",
  "jellyplug.filterbar.pageCache",
]);

async function main() {
  const jp838 = await import(MOD);
  const { SITES, TOTAL_HITS, MARKER, FLAGS, patchConfig, reconstructPreImage } =
    jp838;

  let checks = 0;
  const ok = (cond, msg) => {
    assert.ok(cond, msg);
    checks++;
  };

  /* --- 0. shape ------------------------------------------------------- */
  ok(FLAGS.length === 8, `FLAGS has ${FLAGS.length} entries, want 8`);
  ok(TOTAL_HITS === 16, `TOTAL_HITS is ${TOTAL_HITS}, want 16`);
  ok(
    new Set(SITES.map((s) => s.id)).size === SITES.length,
    "duplicate site ids",
  );

  const base = makeConfig();
  const fetched = JSON.parse(JSON.stringify(base));
  const patched = JSON.parse(JSON.stringify(base));
  const report = patchConfig(patched);
  ok(report.rewrites === 16, `rewrites=${report.rewrites}, want 16`);
  ok(report.touched.length === 13, `touched=${report.touched.length}, want 13`);

  const siteById = new Map(SITES.map((s) => [s.id, s]));

  /* --- 1/2/3. polarity by execution, pre-image AND flip ---------------- */
  for (const site of READ_SITES) {
    const S = siteById.get(site.id);
    const KILL = site.flag + "Disabled";
    const call = (text, store, mode) => {
      const { win } = stubWin(store, mode);
      const fn = jp838.bootGate(site.id, text, win);
      return fn(site.flag) === true;
    };
    const before = (store, mode) => call(S.from, store, mode);
    const after = (store, mode) => call(S.to, store, mode);
    const tag = `${site.id}/${site.flag}`;

    // (2) reproduce the defect: a cold boot is OFF today.
    ok(before({}) === false, `${tag}: pre-image should be OFF on empty store`);
    // (1) the fix: a cold boot is ARMED.
    ok(after({}) === true, `${tag}: flipped gate should be ON on empty store`);

    // A seeded TV (every TV from boot 2 today) is unchanged.
    ok(before({ [site.flag]: "1" }) === true, `${tag}: pre-image ON for "1"`);
    ok(after({ [site.flag]: "1" }) === true, `${tag}: flip ON for "1"`);

    // An explicit "0" is OFF both ways.
    ok(before({ [site.flag]: "0" }) === false, `${tag}: pre-image OFF for "0"`);
    ok(after({ [site.flag]: "0" }) === false, `${tag}: flip OFF for "0"`);

    // (3) AC3: the kill switch wins in the same boot, on its own...
    ok(after({ [KILL]: "1" }) === false, `${tag}: ${KILL}=1 must disarm`);
    // ...and against an explicit arm key.
    ok(
      after({ [site.flag]: "1", [KILL]: "1" }) === false,
      `${tag}: ${KILL}=1 must beat ${site.flag}=1`,
    );
    // Five readers ignored `*Disabled` entirely before this patch. Assert the
    // improvement rather than pretending it was always there.
    if (NO_KILL_BEFORE.has(site.flag)) {
      ok(
        before({ [site.flag]: "1", [KILL]: "1" }) === true,
        `${tag}: pre-image was expected to IGNORE ${KILL} (read-time kill is new)`,
      );
    } else {
      ok(
        before({ [site.flag]: "1", [KILL]: "1" }) === false,
        `${tag}: pre-image honoured ${KILL} and must keep doing so`,
      );
    }

    // A broken localStorage: unchanged for the five `getItem` gates (their
    // shipped catch stands down); the two `*Ls` gates cannot tell "unreadable"
    // from "absent", so they take the fleet default. Documented, not silent.
    if (NULL_ON_THROW.has(site.flag)) {
      ok(
        before({}, "throw") === false && after({}, "throw") === true,
        `${tag}: unreadable store should follow the fleet default after the flip`,
      );
    } else {
      ok(
        before({}, "throw") === false && after({}, "throw") === false,
        `${tag}: unreadable store must still stand down`,
      );
    }
  }

  /* --- 10. scope: the control must not move ---------------------------- */
  const genre = (cfg) =>
    cfg.CustomJavaScripts.find((e) => e.Name === "JellyPlug — genre-rows")
      .Script;
  ok(
    genre(patched) === genre(fetched),
    "genreLazy (already opt-out) must be untouched",
  );
  for (const f of FLAGS) {
    const all = patched.CustomJavaScripts.map((e) => e.Script).join(" ");
    ok(
      !all.includes(`getItem("${f}")==="1"`),
      `${f} still has a literal opt-in read`,
    );
    ok(
      all.includes(`${f}Disabled")!=="1"`) ||
        all.includes(`getItem(F+"Disabled")!=="1"`) ||
        all.includes(`getItem(f+"Disabled")!=="1"`),
      `${f} lost its kill-switch term`,
    );
  }
  ok(
    jp838.auditConfig(fetched).length === 12,
    `audit should find 12 boot-1-dead gates on the pre-image, found ${jp838.auditConfig(fetched).length}`,
  );
  ok(
    jp838.auditConfig(patched).length === 0,
    "audit should find 0 boot-1-dead gates after the flip",
  );

  /* --- 4. seeder guards cannot re-arm a disarmed TV --------------------- */
  /*
   * `guardsDisabled` records the SHIPPED convention, which is not uniform:
   * jp745/jp791 skip the write when `*Disabled` is set, jp801 (like JELA-828's
   * own seeder) does not and leaves the kill entirely to the read site. jp838
   * does not unify that — an inert "1" on a killed TV changes nothing, because
   * every flipped read site now tests `*Disabled` FIRST. What jp838 DOES fix
   * is the guard that matters: none of the three may overwrite a stored "0".
   */
  const SEEDERS = [
    {
      entry: "JellyPlug — row prefetch default-ON (JELA-745/747)",
      keys: ["jellyplug.rows.prefetch"],
      guardsDisabled: true,
    },
    {
      entry:
        "JellyPlug — mediabar poolPrefetch+heroPoolRead default-ON (JELA-791)",
      keys: [
        "jellyplug.mediabar.poolPrefetch",
        "jellyplug.mediabar.heroPoolRead",
      ],
      guardsDisabled: true,
    },
    {
      entry: "JellyPlug — filterbar.pageCache default-ON (JELA-768/801)",
      keys: ["jellyplug.filterbar.pageCache"],
      guardsDisabled: false,
    },
  ];
  const vm = require("node:vm");
  const runSeeder = (cfg, entryName, store) => {
    const body = cfg.CustomJavaScripts.find((e) => e.Name === entryName).Script;
    const { ls } = stubWin(store);
    vm.runInNewContext(body, {
      localStorage: ls,
      window: { localStorage: ls },
    });
    return ls.map;
  };
  for (const s of SEEDERS) {
    for (const k of s.keys) {
      // virgin TV: seeded
      ok(
        runSeeder(patched, s.entry, {})[k] === "1",
        `${s.entry}: virgin TV should be seeded "1" for ${k}`,
      );
      // disarmed TV: NOT re-armed
      ok(
        runSeeder(patched, s.entry, { [k]: "0" })[k] === "0",
        `${s.entry}: a stored "0" must survive the seeder for ${k}`,
      );
      // the pre-image is the bug being fixed here
      ok(
        runSeeder(fetched, s.entry, { [k]: "0" })[k] === "1",
        `${s.entry}: pre-image was expected to clobber "0" for ${k}`,
      );
      // kill switch: blocks the write where the seeder shipped that guard;
      // where it did not, the read site is what must hold the line.
      const seeded = runSeeder(patched, s.entry, { [k + "Disabled"]: "1" })[k];
      if (s.guardsDisabled) {
        ok(
          seeded === undefined,
          `${s.entry}: ${k}Disabled=1 must block the seed`,
        );
      } else {
        const site = READ_SITES.find((r) => r.flag === k);
        const { win } = stubWin({ [k]: seeded, [k + "Disabled"]: "1" });
        const gate = jp838.bootGate(site.id, siteById.get(site.id).to, win);
        ok(
          seeded === "1" && gate(k) === false,
          `${s.entry}: seeder writes an inert "1", and ${k}Disabled=1 must still read OFF`,
        );
      }
    }
  }

  /* --- 5. rollback is an exact inverse + pre-image ---------------------- */
  const rolled = JSON.parse(JSON.stringify(patched));
  patchConfig(rolled, { rollback: true });
  ok(
    JSON.stringify(rolled) === JSON.stringify(fetched),
    "rollback must reproduce the fetched config byte-for-byte",
  );
  ok(
    JSON.stringify(reconstructPreImage(patched)) === JSON.stringify(fetched),
    "reconstructPreImage must reproduce the fetched config byte-for-byte",
  );

  /* --- 7. no collateral ------------------------------------------------- */
  const TOUCHED = new Set(report.touched);
  for (let i = 0; i < fetched.CustomJavaScripts.length; i++) {
    const a = fetched.CustomJavaScripts[i];
    const b = patched.CustomJavaScripts[i];
    ok(a.Name === b.Name, `entry ${i} renamed`);
    if (!TOUCHED.has(a.Name)) {
      ok(a.Script === b.Script, `untouched entry "${a.Name}" changed`);
    }
  }
  ok(
    patched.CustomJavaScripts.length === fetched.CustomJavaScripts.length,
    "entry count changed — jp838 adds no entries",
  );

  /* --- 6/9. fail-closed ------------------------------------------------- */
  assert.throws(
    () => patchConfig(JSON.parse(JSON.stringify(patched))),
    /already carries/,
    "double flip must throw",
  );
  checks++;
  assert.throws(
    () => patchConfig(JSON.parse(JSON.stringify(fetched)), { rollback: true }),
    /carries 0 marker/,
    "rollback of an unflipped config must throw",
  );
  checks++;
  {
    const missing = JSON.parse(JSON.stringify(fetched));
    const e = missing.CustomJavaScripts.find(
      (x) => x.Name === "JellyPlug — my-list",
    );
    e.Script = e.Script.replace(LIVE.navkeep, "/* upstream reworded */");
    assert.throws(
      () => patchConfig(missing),
      /matched 4 site\(s\), want 5/,
      "a short hit count must throw, not patch 4 of 5",
    );
    checks++;
  }
  {
    const foreign = JSON.parse(JSON.stringify(fetched));
    foreign.CustomJavaScripts.push({
      Name: "SomeoneElse — copy of the helper",
      Script: `(function(w){${LIVE.navkeep}})(window);`,
      Enabled: true,
    });
    assert.throws(
      () => patchConfig(foreign),
      /foreign entry/,
      "a foreign entry carrying our bytes must throw",
    );
    checks++;
  }
  {
    const noArr = { CustomJavaScripts: null };
    assert.throws(() => patchConfig(noArr), /no CustomJavaScripts/);
    checks++;
  }

  /* --- 8. ES5 ----------------------------------------------------------- */
  for (const s of SITES) {
    ok(jp838.assertEs5(s.to) === true, `${s.id}: non-ES5 rewrite`);
    ok(s.to.includes(MARKER), `${s.id}: rewrite carries no ${MARKER} marker`);
  }
  for (const name of report.touched) {
    const body = patched.CustomJavaScripts.find((e) => e.Name === name).Script;
    ok(
      /=>|`|\blet\b|\bconst\b|\bclass\b|\?\?|catch\s*\{/.test(
        body.replace(/\/\*[\s\S]*?\*\//g, ""),
      ) === false,
      `${name}: patched body carries non-ES5 syntax`,
    );
  }

  console.log(`jsi-jp838-patch.test.cjs: ${checks} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
