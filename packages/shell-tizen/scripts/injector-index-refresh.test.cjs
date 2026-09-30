// JELA-983: run real gate/cache/boot fetch selection; simulate only I/O/platform.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../..");
function fn(src, name) {
  const start = src.indexOf("  function " + name + "(");
  assert.ok(start >= 0, name);
  return src.slice(start, src.indexOf("\n  }", start) + 4);
}
for (const file of [
  "packages/shell-tizen/src/shell.js",
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
]) {
  for (const scenario of ["scripts", "match", "branding", "fetch-failed"]) {
    test(`${file}: retained index / ${scenario}`, async () => {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const origin = "https://jellyfin.test";
      const components = {
        web: "w1",
        scripts: "s1",
        branding: "b1",
        shell: "h1",
      };
      const changed = scenario === "scripts" || scenario === "fetch-failed";
      const html = (version) =>
        '<html><head><script src="/JavaScriptInjector/public.js?v=' +
        version +
        '"></script></head><body>' +
        "x".repeat(1100) +
        "</body></html>";
      const store = new Map([
        [
          "jellyfin.shell.configEpoch",
          JSON.stringify({ origin, epoch: "E1", components, ts: Date.now() }),
        ],
        ["credentials", "retained-auth"],
        ["settings", "retained-settings"],
      ]);
      const requests = [];
      const env = {
        window: {},
        Promise,
        Date,
        JSON,
        Math,
        String,
        parseInt,
        WEB_INDEX_CACHE_KEY: "jellyfin.shell.webIndexHtml",
        WEB_CONFIG_CACHE_KEY: "jellyfin.shell.webConfig",
        WEB_CACHE_VER: "test",
        WEB_CACHE_MAX: 262144,
        WEB_CACHE_GATE_KEY: "jellyfin.shell.indexCache",
        BUNDLE_CACHE_KEY: "bundle",
        TX_PFX: "tx:",
        localStorage: {
          getItem: (k) => store.get(k) || null,
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
          key: (i) => Array.from(store.keys())[i],
          get length() {
            return store.size;
          },
        },
        maybeBootLite: () => false,
        loadTxDropManifest: () => {},
        isLegacyChromium: () => false,
        seedWebPrefetchSkip: () => {},
        jsiChannelCacheClear: () => {},
        withBootTimeout: (p) => p,
        fetch: async (url) => {
          requests.push(url);
          if (url.includes("/shell/manifest.json"))
            return {
              ok: true,
              json: async () => ({
                configEpoch: scenario === "match" ? "E1" : "E2",
                components: {
                  ...components,
                  scripts: changed ? "s2" : "s1",
                  branding: scenario === "branding" ? "b2" : "b1",
                },
              }),
            };
          if (scenario === "fetch-failed") throw new Error("offline index");
          return {
            ok: true,
            text: async () => (url.endsWith("index.html") ? html("new") : "{}"),
          };
        },
      };
      const gate = src.slice(
        src.indexOf("  function ceGateOn()"),
        src.indexOf("  function ceTxdState("),
      );
      const start = src.indexOf("  function loadRemoteWebClient(serverUrl)");
      const stop = src.indexOf("    // JEL-134: vault restore", start);
      assert.ok(start >= 0 && stop > start);
      const boot =
        src.slice(start, stop) +
        "\nreturn Promise.all([indexPromise, configPromise]);\n}";
      const cache = [
        "webCacheEnabled",
        "readWebIndexCache",
        "writeWebIndexCache",
        "readWebConfigCache",
        "writeWebConfigCache",
      ]
        .map((n) => fn(src, n))
        .join("\n");
      vm.createContext(env);
      vm.runInContext(cache + "\n" + gate + "\n" + boot, env);
      env.writeWebIndexCache(origin, html("old"));
      env.writeWebConfigCache(origin, "{}");
      const priorIndex = store.get(env.WEB_INDEX_CACHE_KEY);
      if (scenario === "fetch-failed") {
        await assert.rejects(env.loadRemoteWebClient(origin), /offline index/);
        assert.equal(store.has(env.WEB_INDEX_CACHE_KEY), false);
      } else {
        const [body] = await env.loadRemoteWebClient(origin);
        assert.equal(
          body,
          html(changed ? "new" : "old"),
          "current boot must consume current producer URL",
        );
        if (changed) {
          assert.equal(
            JSON.parse(store.get(env.WEB_INDEX_CACHE_KEY)).body,
            html("new"),
          );
          assert.ok(requests.some((u) => u.endsWith("/web/index.html")));
        }
        if (scenario === "match") {
          assert.equal(
            requests.length,
            1,
            "matched boot keeps network suppression",
          );
          assert.equal(store.get(env.WEB_INDEX_CACHE_KEY), priorIndex);
        }
      }
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(
        JSON.parse(store.get("jellyfin.shell.configEpoch")).epoch,
        scenario === "fetch-failed" || scenario === "match" ? "E1" : "E2",
      );
      assert.equal(store.get("credentials"), "retained-auth");
      assert.equal(store.get("settings"), "retained-settings");
      assert.ok(store.has(env.WEB_CONFIG_CACHE_KEY));
    });
  }
}
