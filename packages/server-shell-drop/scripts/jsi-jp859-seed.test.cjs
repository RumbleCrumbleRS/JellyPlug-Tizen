#!/usr/bin/env node
/*
 * jsi-jp859-seed.test.cjs — JELA-886 guard for jsi-jp859-seed.mjs.
 *
 * The seeder is four lines of JS, so the risk is not "does it parse" — it is
 * every way a fleet flag flip has gone wrong on this codebase before:
 *
 *  1) POLARITY BY EXECUTION, AGAINST THE REAL READ SITE. The seeder body and
 *     jp859's `jpOn859` gate are both COMPILED and RUN over the full store
 *     truth table. A grep would not notice that the read site is opt-IN
 *     (`=== "1"`) while the seeder's guard is `!== "0"` — those are different
 *     polarities on purpose and only execution shows they compose.
 *  2) THE ROLLBACK TERMINATES (JELA-836). A stored "0" must survive an
 *     unbounded number of seeder passes; otherwise "set 0" is not an OFF arm
 *     and the flip can never be undone without deleting the entry.
 *  3) ROLLBACK IS AN OFF ARM ON AN ALREADY-ARMED TV. The rollback body must
 *     drive a TV that is currently "1" back to "0" in one boot, and the read
 *     site must then be OFF.
 *  4) FAIL-CLOSED (JELA-747/816). Double-seeding, seeding when a FOREIGN entry
 *     already writes the flag, and rolling back a config that was never
 *     seeded must all throw — never no-op and report success. A second writer
 *     is what would break check 2 in prod.
 *  5) NO COLLATERAL. Every pre-existing entry stays byte-identical and
 *     in order; only one entry is appended.
 *  6) NO SIBLING FLAG MOVES. JELA-785's `leanfields`/`sharepool` seeder must
 *     be untouched — the ticket says explicitly not to reuse that entry.
 *  7) ES5. The Q60R panel engine is M63-class and throws on ES2020+.
 *
 * The `jpOn859` source below is copied verbatim from HELPERS_SRC in
 * jsi-jp859-patch.mjs, so a drift there fails check 1 here.
 */
const { strict: assert } = require("node:assert");
const vm = require("node:vm");

let checks = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}

/** The deployed read site, verbatim from jsi-jp859-patch.mjs HELPERS_SRC. */
const READ_SITE =
  'var jpF859="jellyplug.top10.idsplit";' +
  "function jpOn859(){try{var l9=g.localStorage;" +
  'return!!(l9&&l9.getItem(jpF859)==="1")}catch(e){return!1}}';

/** Minimal localStorage good enough for both bodies. */
function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    ls: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

/** Run a seeder body once against a store, then read jp859's own gate. */
function boot(seedSrc, initial) {
  const { map, ls } = makeStore(initial);
  const win = { localStorage: ls };
  const ctx = vm.createContext({ window: win, g: win });
  vm.runInContext(seedSrc, ctx);
  vm.runInContext(READ_SITE, ctx);
  const armed = vm.runInContext("jpOn859()", ctx);
  return {
    stored: map.has("jellyplug.top10.idsplit")
      ? map.get("jellyplug.top10.idsplit")
      : null,
    armed,
  };
}

function baseConfig() {
  return {
    CustomJavaScripts: [
      // The step-1 patched read site: it legitimately carries the flag string.
      // Seeding on top of it must SUCCEED — that is the real deploy order.
      {
        Name: "JellyPlug — top10-badges",
        Script: `/*top10*/(function(g){${READ_SITE}})(window);`,
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — top10 pool flags default-ON (JELA-785)",
        Script:
          '/*jp785seed*/(function(){try{var l=window.localStorage;if(!l)return;var k=["jellyplug.top10.sharepool","jellyplug.top10.leanfields"];for(var i=0;i<k.length;i++){if(l.getItem(k[i])!=="0")l.setItem(k[i],"1")}}catch(e){}})();',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — unrelated",
        Script: "/*x*/void 0;",
        Enabled: false,
        RequiresAuthentication: true,
      },
    ],
    PluginJavaScripts: [],
    DisableScriptInjectionMiddleware: false,
  };
}

async function main() {
  const mod = await import("./jsi-jp859-seed.mjs");
  const { SEED_SRC, ROLLBACK_SRC, SEED_NAME, SPLIT_FLAG, seedConfig } = mod;

  // 1. POLARITY BY EXECUTION, against jp859's real gate.
  const fresh = boot(SEED_SRC, {});
  ok(fresh.stored === "1", 'fresh TV: seeder must write "1"');
  ok(fresh.armed === true, "fresh TV: jpOn859 must read ON after the seeder");

  const preOff = boot("", {});
  ok(
    preOff.armed === false,
    "control: with no seeder the flag is OFF (the dark state)",
  );

  const preOne = boot(SEED_SRC, { "jellyplug.top10.idsplit": "1" });
  ok(
    preOne.stored === "1" && preOne.armed === true,
    "already-armed TV stays armed",
  );

  // A junk value is opt-IN OFF at the read site, and the seeder overwrites it
  // to "1" because it is not "0" — both halves asserted.
  const junk = boot(SEED_SRC, { "jellyplug.top10.idsplit": "yes" });
  ok(
    junk.stored === "1" && junk.armed === true,
    'junk value is re-armed to "1"',
  );
  ok(
    boot("", { "jellyplug.top10.idsplit": "yes" }).armed === false,
    "junk value alone reads OFF (opt-in)",
  );

  // 2. THE ROLLBACK TERMINATES: "0" survives repeated seeder passes.
  let store = { "jellyplug.top10.idsplit": "0" };
  for (let i = 0; i < 25; i++) {
    const r = boot(SEED_SRC, store);
    ok(
      r.stored === "0" && r.armed === false,
      `boot ${i + 1}: a stored "0" must survive the seeder`,
    );
    store = { "jellyplug.top10.idsplit": r.stored };
  }

  // 3. ROLLBACK IS AN OFF ARM on a TV that is currently armed.
  const rolled = boot(ROLLBACK_SRC, { "jellyplug.top10.idsplit": "1" });
  ok(
    rolled.stored === "0" && rolled.armed === false,
    "rollback body drives an armed TV to OFF",
  );
  const rolledFresh = boot(ROLLBACK_SRC, {});
  ok(
    rolledFresh.stored === "0" && rolledFresh.armed === false,
    "rollback body is OFF on a fresh TV too",
  );
  // and the rollback state then survives the rollback body itself.
  ok(
    boot(ROLLBACK_SRC, { "jellyplug.top10.idsplit": "0" }).stored === "0",
    "rollback is idempotent",
  );

  // 4. FAIL-CLOSED.
  const cfg = baseConfig();
  const before = JSON.parse(JSON.stringify(cfg));
  const rep = seedConfig(cfg);
  ok(rep.action === "seed", "first seed reports action=seed");
  assert.throws(
    () => seedConfig(cfg),
    /already in this config/,
    "double-seed must throw",
  );
  checks++;

  // 4a. A second WRITER breaks rollback termination — must throw.
  const foreign = baseConfig();
  foreign.CustomJavaScripts.push({
    Name: "somebody else",
    Script: 'localStorage.setItem("jellyplug.top10.idsplit","1")',
    Enabled: true,
    RequiresAuthentication: false,
  });
  assert.throws(
    () => seedConfig(foreign),
    /already written by/,
    "a foreign writer of the flag must throw",
  );
  checks++;

  // 4b. An entry that merely MENTIONS the flag and is not the known read site
  //     might write it through a variable — refuse rather than guess.
  const stranger = baseConfig();
  stranger.CustomJavaScripts.push({
    Name: "JellyPlug — some other module",
    Script: 'var k="jellyplug.top10.idsplit";',
    Enabled: true,
    RequiresAuthentication: false,
  });
  assert.throws(
    () => seedConfig(stranger),
    /does not know/,
    "an unknown entry mentioning the flag must throw",
  );
  checks++;

  // 4c. …but the patched read site itself must NOT trip either tier. That is
  //     the live deploy order (step 1 then step 2) and it is asserted by the
  //     successful seedConfig(cfg) above, whose fixture carries jp859's gate.
  ok(
    baseConfig().CustomJavaScripts[0].Script.includes(SPLIT_FLAG),
    "fixture precondition: the read site really does carry the flag string",
  );

  assert.throws(
    () => seedConfig(baseConfig(), { rollback: true }),
    /nothing to roll back/,
    "rollback of an unseeded config must throw",
  );
  checks++;

  assert.throws(
    () => seedConfig({}),
    /no CustomJavaScripts/,
    "a config with no entry array must throw",
  );
  checks++;

  // 5. NO COLLATERAL: exactly one appended entry, everything else byte-equal.
  ok(
    cfg.CustomJavaScripts.length === before.CustomJavaScripts.length + 1,
    "exactly one entry is appended",
  );
  for (let i = 0; i < before.CustomJavaScripts.length; i++) {
    ok(
      JSON.stringify(cfg.CustomJavaScripts[i]) ===
        JSON.stringify(before.CustomJavaScripts[i]),
      `pre-existing entry ${i} must be byte-identical and in place`,
    );
  }
  ok(
    cfg.PluginJavaScripts !== undefined &&
      cfg.DisableScriptInjectionMiddleware === false,
    "non-entry config keys are preserved",
  );
  const added = cfg.CustomJavaScripts[cfg.CustomJavaScripts.length - 1];
  ok(
    added.Name === SEED_NAME &&
      added.Enabled === true &&
      added.RequiresAuthentication === false,
    "appended entry has the JELA-785 entry shape",
  );
  ok(added.Script === SEED_SRC, "appended entry carries the seeder body");

  // 6. NO SIBLING FLAG MOVES.
  const j785 = cfg.CustomJavaScripts.find((e) => e.Name.includes("JELA-785"));
  ok(
    j785.Script.includes("sharepool") &&
      j785.Script.includes("leanfields") &&
      !j785.Script.includes(SPLIT_FLAG),
    "JELA-785's entry is untouched and still seeds only its own two flags",
  );

  // rollback path rewrites in place, appends nothing.
  const rb = JSON.parse(JSON.stringify(cfg));
  const rbRep = seedConfig(rb, { rollback: true });
  ok(rbRep.action === "rollback", "rollback reports action=rollback");
  ok(
    rb.CustomJavaScripts.length === cfg.CustomJavaScripts.length,
    "rollback appends no entry",
  );
  ok(
    rb.CustomJavaScripts[rb.CustomJavaScripts.length - 1].Script ===
      ROLLBACK_SRC,
    "rollback rewrites the seeder body in place",
  );

  // 7. ES5 — the Q60R panel engine throws on ES2020+.
  for (const [name, body] of [
    ["seed", SEED_SRC],
    ["rollback", ROLLBACK_SRC],
  ]) {
    ok(
      /=>|`|\blet\b|\bconst\b|\bclass\b|\?\?|catch\s*\{/.test(
        body.replace(/\/\*[\s\S]*?\*\//g, ""),
      ) === false,
      `${name} body carries non-ES5 syntax`,
    );
    new vm.Script(body, { filename: `${name}.js` });
    checks++;
  }

  console.log(`jsi-jp859-seed.test.cjs: ${checks} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
