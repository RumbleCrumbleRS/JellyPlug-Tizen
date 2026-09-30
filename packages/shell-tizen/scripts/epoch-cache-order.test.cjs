// Exercise shipped startup through cache selection with a delayed real epoch gate.
// Network/storage are simulated; gate and startup ordering come from both shells.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../..");
const origin = "http://test:8096";
const oldComponents = { web: "w1", scripts: "j1", shell: "s1", branding: "b1" };
for (const file of [
  "packages/shell-tizen/src/shell.js",
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
]) {
  for (const outcome of [
    "changed",
    "match",
    "branding",
    "scripts",
    "offline",
    "missing",
    "disabled",
    "body-timeout",
    "timeout",
  ]) {
    test(`${file}: ${outcome} manifest before cache selection`, async () => {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const gate = src.slice(
        src.indexOf("  function ceGateOn()"),
        src.indexOf("  function ceTxdState("),
      );
      const start = src.indexOf("  function loadRemoteWebClient(serverUrl)");
      const stop = src.indexOf("    // JELA-853: on a cache MISS", start);
      assert.ok(start >= 0 && stop > start);
      // Stop at the selected bodies, before unrelated DOM/transpile work.
      const startup =
        src.slice(start, stop) +
        "\nreturn {cachedIndex:cachedIndex,cachedConfig:cachedConfig};\n}";
      const store = new Map([
        [
          "jellyfin.shell.configEpoch",
          JSON.stringify({
            origin,
            epoch: "E1",
            components: oldComponents,
            ts: Date.now(),
          }),
        ],
        ["index", "old index"],
        ["config", "old config"],
      ]);
      if (outcome === "disabled")
        store.set("jellyfin.shell.configEpochDisabled", "1");
      let resolve,
        reject,
        reads = 0,
        requests = 0;
      const timers = new Map();
      const network = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      const env = {
        window: {},
        Promise,
        Date,
        JSON,
        Math,
        String,
        parseInt,
        jsiChannelCacheClear: () => {},
        localStorage: {
          getItem: (k) => store.get(k) || null,
          setItem: (k, v) => store.set(k, v),
          removeItem: (k) => store.delete(k),
        },
        fetch: () => {
          requests++;
          return network;
        },
        setTimeout: (fn, ms) => {
          const id = {};
          timers.set(id, { fn, ms });
          return id;
        },
        clearTimeout: (id) => timers.delete(id),
        WEB_INDEX_CACHE_KEY: "index",
        WEB_CONFIG_CACHE_KEY: "config",
        BUNDLE_CACHE_KEY: "bundle",
        maybeBootLite: () => false,
        loadTxDropManifest: () => {},
        isLegacyChromium: () => true,
        webCacheEnabled: () => true,
        readWebIndexCache: () => {
          reads++;
          return store.has("index") ? { body: store.get("index") } : null;
        },
        readWebConfigCache: () => {
          reads++;
          return store.has("config") ? { body: store.get("config") } : null;
        },
      };
      vm.createContext(env);
      const timeoutStart = src.indexOf("  function withBootTimeout(");
      const timeoutCode = src.slice(
        timeoutStart,
        src.indexOf("\n  }\n", timeoutStart) + 5,
      );
      vm.runInContext(timeoutCode + "\n" + gate + "\n" + startup, env);
      const boot = Promise.resolve(env.loadRemoteWebClient(origin));
      if (outcome !== "disabled") {
        assert.equal(
          reads,
          0,
          "must not capture stale bodies while hash is pending",
        );
        if (outcome === "body-timeout" || outcome === "timeout") {
          if (outcome === "body-timeout")
            resolve({ ok: true, json: () => new Promise(() => {}) });
          for (let i = 0; i < 8; i++) await Promise.resolve();
          assert.equal(
            timers.size,
            1,
            "deadline must cover both headers and JSON body",
          );
          for (const timer of timers.values()) {
            assert.equal(timer.ms, 3000);
            timer.fn();
          }
        } else if (outcome === "offline")
          reject(new Error("network unavailable"));
        else
          resolve({
            ok: true,
            json: () =>
              Promise.resolve(
                outcome === "missing"
                  ? {}
                  : {
                      configEpoch: ["changed", "branding", "scripts"].includes(
                        outcome,
                      )
                        ? "E2"
                        : "E1",
                      components: {
                        ...oldComponents,
                        web: outcome === "changed" ? "w2" : "w1",
                        branding: outcome === "branding" ? "b2" : "b1",
                        scripts: outcome === "scripts" ? "j2" : "j1",
                      },
                    },
              ),
          });
      }
      const selected = await boot;
      if (outcome === "timeout") {
        resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              configEpoch: "E2",
              components: { ...oldComponents, web: "w2" },
            }),
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(
          store.get("index"),
          "old index",
          "late response must not invalidate after fallback",
        );
        assert.equal(env.window.__shellConfigEpoch.st, "err");
      }
      assert.equal(reads, 2);
      assert.equal(requests, outcome === "disabled" ? 0 : 1);
      if (outcome === "changed") {
        assert.equal(selected.cachedIndex, null);
        assert.equal(selected.cachedConfig, null);
        assert.equal(
          JSON.parse(store.get("jellyfin.shell.configEpoch")).epoch,
          "E1",
          "no early epoch adoption",
        );
      } else if (outcome === "scripts") {
        assert.equal(selected.cachedIndex, null);
        assert.equal(selected.cachedConfig.body, "old config");
      } else {
        assert.equal(selected.cachedIndex.body, "old index");
        assert.equal(selected.cachedConfig.body, "old config");
      }
    });
  }
}
