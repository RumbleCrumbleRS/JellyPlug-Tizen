/*
 * JELA-66 (v2.0.24): resume-time config-epoch check — installResumeEpochCheck.
 *
 * With config.xml background-support="enable" the app SUSPENDS instead of
 * dying, so a relaunch is a warm resume that skips every boot-time freshness
 * check. The hook re-runs the config-epoch comparison on each background →
 * foreground transition and reloads through the bootstrap ONLY on a real
 * mismatch. This test drives the shipped shell-core fragment (the parity
 * guard + verify scripts already pin that both shells carry these exact
 * bytes) in a VM with fake window/document/localStorage/fetch, pinning:
 *   - install binds exactly one window-level visibilitychange listener
 *   - hidden transition -> no manifest fetch
 *   - visible with no saved server / no adopted record -> inert
 *   - kill switch resumeEpochDisabled='1' -> inert
 *   - master switch configEpochDisabled='1' (ceGateOn) -> inert
 *   - epoch match -> st=match, DOM kept, no reload
 *   - manifest unreachable -> st=err, DOM kept (offline resume stays instant)
 *   - manifest without configEpoch field -> st=nofield, DOM kept
 *   - epoch mismatch -> ONE location.reload() + resumeReload LS breadcrumb
 *   - mismatch while Lite AVPlay session live -> st=defer, no reload, and
 *     the debounce stamp resets so the NEXT resume retries immediately
 *   - mismatch while an SPA <video> is playing -> st=defer, no reload
 *   - terminal Lite player (closed/err) does NOT defer -> reload proceeds
 *   - 5 s debounce: two visible transitions back-to-back -> one fetch
 * Plus static pins: both committed .min blobs ship the hook literals.
 *
 * Run: node scripts/resume-epoch.test.cjs
 *   or: pnpm --filter @jellyfin-tv/shell-tizen test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const { loadFragments } = require(
  path.join(REPO, "packages", "shell-core", "expand.cjs"),
);
const RETAIL_MIN = path.join(__dirname, "..", "src", "shell.min.js");
const BOOT_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

let fails = 0;
function check(name, cond) {
  console.log((cond ? "OK: " : "FAIL: ") + name);
  if (!cond) fails++;
}

const fragment = loadFragments()["installResumeEpochCheck"];
if (!fragment) {
  console.error("FAIL: shell-core fragment installResumeEpochCheck missing");
  process.exit(1);
}

const S = "http://srv:8096";
const REC_KEY = "jellyfin.shell.configEpoch";

function mkEnv(opts) {
  opts = opts || {};
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const listeners = { visibilitychange: [] };
  const fetchLog = [];
  let manifestBody = null;
  const env = {
    store,
    localStorage,
    fetchLog,
    reloads: 0,
    Date,
    Math,
    JSON,
    String,
    Promise,
    console,
    setManifest: (m) => {
      manifestBody = m;
    },
    window: {
      addEventListener: (ev, fn) => {
        (listeners[ev] = listeners[ev] || []).push(fn);
      },
    },
    document: { hidden: false, getElementsByTagName: () => [] },
    location: {
      reload: function () {
        env.reloads++;
      },
    },
    fetch: (url) => {
      fetchLog.push(url);
      if (manifestBody === "neterr") return Promise.reject(new Error("net"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(manifestBody),
      });
    },
    withBootTimeout: (p) => p,
    ceGateOn: () =>
      localStorage.getItem("jellyfin.shell.configEpochDisabled") !== "1",
    loadServerUrl: () => store.get("jellyfin.shell.serverUrl") || "",
    listeners,
  };
  vm.createContext(env);
  vm.runInContext(
    fragment +
      "\ninstallResumeEpochCheck();\nthis.g = window.__shellResumeEpoch;",
    env,
  );
  return env;
}

function fire(env, hidden) {
  env.document.hidden = hidden;
  for (const fn of env.listeners.visibilitychange) fn();
}
function flush() {
  // Two macrotask turns: withBootTimeout(p).then().then() settles fully.
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}
function seed(env, epoch) {
  env.store.set("jellyfin.shell.serverUrl", S);
  env.store.set(
    REC_KEY,
    JSON.stringify({ origin: S, epoch: epoch, components: {}, ts: Date.now() }),
  );
}

(async () => {
  // install shape
  let e = mkEnv();
  check(
    "install binds exactly one window visibilitychange listener",
    e.listeners.visibilitychange.length === 1 && e.g && e.g.st === "idle",
  );

  // hidden transition is inert
  e = mkEnv();
  seed(e, "E1");
  fire(e, true);
  await flush();
  check("hidden transition -> no manifest fetch", e.fetchLog.length === 0);

  // no saved server
  e = mkEnv();
  e.store.set(REC_KEY, JSON.stringify({ origin: S, epoch: "E1" }));
  fire(e, false);
  await flush();
  check("no saved server URL -> inert", e.fetchLog.length === 0);

  // no adopted record (boot path owns first adoption)
  e = mkEnv();
  e.store.set("jellyfin.shell.serverUrl", S);
  fire(e, false);
  await flush();
  check("no adopted epoch record -> inert", e.fetchLog.length === 0);

  // record for a DIFFERENT origin
  e = mkEnv();
  e.store.set("jellyfin.shell.serverUrl", S);
  e.store.set(
    REC_KEY,
    JSON.stringify({ origin: "http://other:8096", epoch: "E1" }),
  );
  fire(e, false);
  await flush();
  check("record for another origin -> inert", e.fetchLog.length === 0);

  // kill switch
  e = mkEnv();
  seed(e, "E1");
  e.store.set("jellyfin.shell.resumeEpochDisabled", "1");
  fire(e, false);
  await flush();
  check(
    "resumeEpochDisabled='1' kill switch -> inert",
    e.fetchLog.length === 0,
  );

  // master switch
  e = mkEnv();
  seed(e, "E1");
  e.store.set("jellyfin.shell.configEpochDisabled", "1");
  fire(e, false);
  await flush();
  check(
    "configEpochDisabled='1' master switch (ceGateOn) -> inert",
    e.fetchLog.length === 0,
  );

  // match keeps the DOM
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E1" });
  fire(e, false);
  await flush();
  check(
    "epoch match -> st=match, one fetch, NO reload",
    e.g.st === "match" && e.fetchLog.length === 1 && e.reloads === 0,
  );

  // offline keeps the DOM
  e = mkEnv();
  seed(e, "E1");
  e.setManifest("neterr");
  fire(e, false);
  await flush();
  check(
    "manifest unreachable -> st=err, NO reload (offline resume stays instant)",
    e.g.st === "err" && e.reloads === 0,
  );

  // field absent keeps the DOM
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ version: "1.0.14.0", sha256: "x" });
  fire(e, false);
  await flush();
  check(
    "manifest without configEpoch -> st=nofield, NO reload",
    e.g.st === "nofield" && e.reloads === 0,
  );

  // mismatch reloads through the bootstrap + breadcrumb
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E2xxxxxxxx" });
  fire(e, false);
  await flush();
  let crumb = null;
  try {
    crumb = JSON.parse(e.store.get("jellyfin.shell.resumeReload"));
  } catch (_) {}
  check(
    "epoch mismatch -> st=reload, exactly one location.reload()",
    e.g.st === "reload" && e.reloads === 1,
  );
  check(
    "mismatch writes the resumeReload breadcrumb {e,ts}",
    crumb && crumb.e === "E2xxxxxx" && crumb.ts > 0,
  );

  // mismatch mid-Lite-playback defers (and resets the debounce stamp)
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E2" });
  e.window.__shellLite = { player: { st: "playing" } };
  fire(e, false);
  await flush();
  check(
    "mismatch while Lite AVPlay live -> st=defer, NO reload",
    e.g.st === "defer" && e.reloads === 0,
  );
  check("defer resets the debounce stamp for the next resume", e.g.last === 0);
  // playback ends -> the very next resume reloads
  e.window.__shellLite.player.st = "closed";
  fire(e, false);
  await flush();
  check(
    "terminal Lite player (closed) no longer defers -> reload proceeds",
    e.g.st === "reload" && e.reloads === 1,
  );

  // mismatch while an SPA <video> plays defers too
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E2" });
  e.document.getElementsByTagName = () => [{ paused: false, ended: false }];
  fire(e, false);
  await flush();
  check(
    "mismatch while SPA <video> playing -> st=defer, NO reload",
    e.g.st === "defer" && e.reloads === 0,
  );

  // paused video does not defer
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E2" });
  e.document.getElementsByTagName = () => [{ paused: true, ended: false }];
  fire(e, false);
  await flush();
  check(
    "paused SPA <video> does not defer -> reload proceeds",
    e.g.st === "reload" && e.reloads === 1,
  );

  // debounce: two visibles back-to-back -> one fetch
  e = mkEnv();
  seed(e, "E1");
  e.setManifest({ configEpoch: "E1" });
  fire(e, false);
  await flush();
  fire(e, false);
  await flush();
  check(
    "5 s debounce -> back-to-back visible transitions fetch once",
    e.fetchLog.length === 1 && e.g.n === 1,
  );

  // static pins: the shipped .min blobs carry the hook
  for (const [label, p] of [
    ["shell.min.js", RETAIL_MIN],
    ["boot-shell.min.js", BOOT_MIN],
  ]) {
    const min = fs.readFileSync(p, "utf8");
    check(
      label + " ships the resume-epoch hook literals",
      min.indexOf("jellyfin.shell.resumeEpochDisabled") >= 0 &&
        min.indexOf("__shellResumeEpoch") >= 0 &&
        min.indexOf("jellyfin.shell.resumeReload") >= 0,
    );
  }

  console.log(
    fails === 0
      ? "resume-epoch.test.cjs: all assertions passed"
      : fails + " check(s) FAILED",
  );
  process.exit(fails === 0 ? 0 : 1);
})();
