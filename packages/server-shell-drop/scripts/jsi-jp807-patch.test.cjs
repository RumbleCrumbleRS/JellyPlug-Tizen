#!/usr/bin/env node
/*
 * jsi-jp807-patch.test.cjs — JELA-807 guard for jsi-jp807-patch.mjs.
 *
 * This patch is a SEEDER, not a body patch, so the risks are different from
 * jp768's anchor drift. What can actually go wrong here:
 *
 *  1) DOUBLE-SEED. The config POST replaces all entries, and sibling runs
 *     deploy on overlapping schedules. Re-running the patcher against a config
 *     that already carries the seeder must throw, never append a second copy.
 *  2) COLLATERAL. The patcher must not touch any of the other 100+ entries.
 *     Asserted by byte-comparing every pre-existing entry after the patch.
 *  3) ES5. The Q60R engine is M63-class and throws on ES2020+.
 *  4) POLARITY, against the REAL shell gate. The seeder must arm a virgin TV
 *     and must NOT override an explicit per-TV "0". Asserted by running the
 *     seeder and the shell's verbatim gate expression against a stub
 *     localStorage — the JELA-802/806 technique. Grepping the bundle instead
 *     would also match the rollback branch, which writes the same key with "0".
 *  5) ROLLBACK IS A REMOVER (JELA-789). Deleting the entry leaves every TV
 *     latched ON; the rollback must actively write "0" and must survive a
 *     subsequent seeder pass (the seeder's own `!== "0"` guard).
 *  6) PRE-IMAGE RECONSTRUCTION (JELA-805). Stripping our entry from the
 *     patched config must reproduce the fetched config byte-for-byte, which is
 *     the only check that detects a foreign writer racing our POST.
 *
 * Note the shell gate here is a SINGLE key with no separate kill switch — the
 * per-TV opt-out is `udcGate="0"`, which the `!== "1"` gate rejects. jp806's
 * kill-switch case therefore has no analogue; case 4 covers the "0" path.
 */
const assert = require("node:assert");
const vm = require("node:vm");

/**
 * The gate copied VERBATIM out of the SERVED shell.min.js
 * (sha 8724caf369089db93c83ab4e9a134cbd2b775413c7c51e3d37db1e43bcc9521b,
 * server-plugin v1.0.41.0). In the shell it reads
 *     if(localStorage.getItem("jellyfin.shell.udcGate")!=="1")return;
 * so "armed" is the negation of that early return.
 */
const SHELL_GATE = 'localStorage.getItem("jellyfin.shell.udcGate")==="1"';

function stubLs(initial) {
  const map = Object.assign(Object.create(null), initial);
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = String(v);
    },
    removeItem: (k) => {
      delete map[k];
    },
    _map: map,
  };
}

/** Run a channel snippet, then evaluate the shell's gate, on one stub store. */
function runSeedThenGate(snippet, initial) {
  const localStorage = stubLs(initial);
  const ctx = vm.createContext({ localStorage });
  new vm.Script(snippet).runInContext(ctx);
  const armed = new vm.Script(SHELL_GATE).runInContext(ctx);
  return { armed, store: localStorage._map };
}

function fakeCfg(n) {
  return {
    CustomJavaScripts: Array.from({ length: n }, (_, i) => ({
      Name: `existing-${i}`,
      Script: `/* existing ${i} */ (function(){ var x = ${i}; })();`,
      Enabled: true,
      RequiresAuthentication: false,
    })),
    PluginJavaScripts: [],
    DisableScriptInjectionMiddleware: false,
  };
}

(async () => {
  const mod = await import("./jsi-jp807-patch.mjs");
  const { SEED_SRC, ROLLBACK_SRC, MARKER, ENTRY_NAME, patchConfig, reconstructPreImage, assertEs5 } = mod;

  // --- 3) ES5 ---------------------------------------------------------------
  assert.strictEqual(assertEs5(SEED_SRC), true, "seeder must be ES5");
  assert.strictEqual(assertEs5(ROLLBACK_SRC), true, "rollback must be ES5");
  assert.ok(!/=>|`|\blet\b|\bconst\b/.test(SEED_SRC.replace(/\/\*[\s\S]*?\*\//g, "")),
    "seeder body must not use ES6+ syntax");

  // --- 4) POLARITY against the real shell gate ------------------------------
  {
    const virgin = runSeedThenGate(SEED_SRC, {});
    assert.strictEqual(virgin.store["jellyfin.shell.udcGate"], "1",
      "virgin TV must be seeded to \"1\"");
    assert.strictEqual(virgin.armed, true, "virgin TV must arm on the next boot");
  }
  {
    const optOut = runSeedThenGate(SEED_SRC, { "jellyfin.shell.udcGate": "0" });
    assert.strictEqual(optOut.store["jellyfin.shell.udcGate"], "0",
      "an explicit per-TV \"0\" must survive the seed");
    assert.strictEqual(optOut.armed, false, "an explicit \"0\" must not arm");
  }
  {
    // Idempotent on a TV that already has the flag: still "1", still armed.
    const again = runSeedThenGate(SEED_SRC, { "jellyfin.shell.udcGate": "1" });
    assert.strictEqual(again.armed, true, "re-seeding an armed TV is a no-op");
  }
  {
    // Any other pre-existing value must not arm — the gate is strict `=== "1"`.
    const junk = runSeedThenGate(SEED_SRC, { "jellyfin.shell.udcGate": "true" });
    assert.strictEqual(junk.store["jellyfin.shell.udcGate"], "1",
      "a non-\"0\" value is not an opt-out and must be normalised to \"1\"");
    assert.strictEqual(junk.armed, true);
  }
  {
    // Fail-open: a throwing localStorage must not propagate out of the snippet.
    const ctx = vm.createContext({
      localStorage: {
        getItem() { throw new Error("SecurityError"); },
        setItem() { throw new Error("SecurityError"); },
      },
    });
    assert.doesNotThrow(() => new vm.Script(SEED_SRC).runInContext(ctx),
      "seeder must fail open when localStorage throws");
  }

  // --- 1) DOUBLE-SEED + 2) COLLATERAL ---------------------------------------
  const cfg = fakeCfg(103);
  const pristine = JSON.parse(JSON.stringify(cfg));
  const r = patchConfig(cfg);
  assert.strictEqual(r.action, "seed");
  assert.strictEqual(r.entries, 104, "exactly one entry must be appended");
  assert.strictEqual(cfg.CustomJavaScripts[103].Name, ENTRY_NAME);
  assert.strictEqual(cfg.CustomJavaScripts[103].Enabled, true);
  assert.strictEqual(cfg.CustomJavaScripts[103].RequiresAuthentication, false,
    "the seeder must be a PUBLIC entry — an authenticated entry is unprovable on the file:// rig");
  for (let i = 0; i < 103; i++) {
    assert.deepStrictEqual(cfg.CustomJavaScripts[i], pristine.CustomJavaScripts[i],
      `entry ${i} must be untouched`);
  }
  assert.deepStrictEqual(cfg.PluginJavaScripts, pristine.PluginJavaScripts);
  assert.strictEqual(cfg.DisableScriptInjectionMiddleware,
    pristine.DisableScriptInjectionMiddleware);

  assert.throws(() => patchConfig(cfg), /refusing to double-seed/,
    "a second pass over an already-seeded config must throw");

  // --- 6) PRE-IMAGE RECONSTRUCTION -----------------------------------------
  const pre = reconstructPreImage(cfg);
  assert.strictEqual(JSON.stringify(pre), JSON.stringify(pristine),
    "stripping our entry must reproduce the fetched config byte-for-byte");

  // A foreign writer that also landed an entry must break reconstruction.
  {
    const raced = JSON.parse(JSON.stringify(cfg));
    raced.CustomJavaScripts.push({
      Name: "sibling-run-entry", Script: "/* someone else */", Enabled: true,
      RequiresAuthentication: false,
    });
    assert.notStrictEqual(JSON.stringify(reconstructPreImage(raced)), JSON.stringify(pristine),
      "pre-image reconstruction must detect a foreign writer");
  }

  // --- 5) ROLLBACK IS A REMOVER --------------------------------------------
  {
    const rb = patchConfig(cfg, { rollback: true });
    assert.strictEqual(rb.action, "rollback");
    assert.strictEqual(cfg.CustomJavaScripts.length, 104,
      "rollback must REPLACE the body, not delete the entry");
    const body = cfg.CustomJavaScripts[103].Script;
    assert.ok(!body.includes(MARKER), "rollback body must not still be the seeder");
    assert.strictEqual(cfg.CustomJavaScripts[103].Enabled, true,
      "the remover must stay enabled or it never runs");

    // An already-ON TV must be actively disarmed.
    const disarmed = runSeedThenGate(body, { "jellyfin.shell.udcGate": "1" });
    assert.strictEqual(disarmed.store["jellyfin.shell.udcGate"], "0");
    assert.strictEqual(disarmed.armed, false, "rollback must disarm a latched-ON TV");

    // And the disarm must survive a later seeder pass on the same TV.
    const ctx = vm.createContext({ localStorage: stubLs({}) });
    new vm.Script(body).runInContext(ctx);
    new vm.Script(SEED_SRC).runInContext(ctx);
    assert.strictEqual(new vm.Script(SHELL_GATE).runInContext(ctx), false,
      "the seeder's !== \"0\" guard must not undo a rollback");
  }

  // Rollback against a config with no jp807 entry must fail closed.
  assert.throws(() => patchConfig(fakeCfg(3), { rollback: true }), /found 0 jp807 entries/);

  console.log("jsi-jp807-patch.test.cjs: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
