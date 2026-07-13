/*!
 * packages/shell-core — single-source-of-truth for functions mirrored across
 * shell.js (retail, hosted /shell/ drop) and boot-shell.src.js (HSB baked
 * fallback). See JEL-644.
 *
 * This is a RAW JS FRAGMENT, not a module:
 *   - no wrapping IIFE, no top-level "use strict" (those live in each entry
 *     file's wrapper);
 *   - no `import`/`export` (the shells are single-file IIFE bundles built with
 *     `esbuild --minify-whitespace --minify-syntax` and NO bundler — adding
 *     imports would force esbuild --bundle and change IIFE/public-symbol
 *     semantics the parity + verify guards rely on).
 *
 * Each function lives between `//@@BEGIN:name@@` / `//@@END:name@@` delimiters.
 * Both entry files carry a `//@@SHELL_CORE:name@@` marker line where the
 * function used to be; a shared expand() step (expand.py for the Python
 * build/verify scripts, expand.cjs for the JS parity guard + test loader)
 * splices the fragment in place BEFORE esbuild runs. Because the text here is
 * retail's canonical raw style and every function was build-minify
 * byte-identical across both shells before extraction, re-minifying the
 * expanded entry files reproduces the committed shell.min.js / boot-shell.min.js
 * blobs byte-for-byte — zero-shipped-byte, no on-device re-validation gate.
 *
 * To change a shared function, edit it HERE only. To add one, extract it from
 * shell.js (canonical), drop a marker in both entry files, and re-run the
 * build/verify guards (they must stay byte-identical) and cross-shell-parity.
 */

//@@BEGIN:isJellyfinWebBundle@@
  function isJellyfinWebBundle(src) {
    // jellyfin-web webpack chunks served from /web/. They are deliberately
    // transpiled to the browserslist that includes Chrome 56, so we leave
    // them alone. Same for the service worker which runs in its own realm.
    // Also skip async webpack chunks (*.chunk.js, chunkFilename pattern
    // from webpack.common.js: [name].[contenthash].chunk.js) — they are
    // already transpiled by the build and must not be re-fetched/inlined
    // or chunk-load promises (e.g. import('./style.scss') in htmlVideoPlayer)
    // will reject, preventing <video> element creation on Tizen 5.0 (JEL-436).
    var bare = String(src || "").split("?")[0];
    if (/\.bundle\.js$/i.test(bare)) return true;
    if (/\.chunk\.js$/i.test(bare)) return true;
    if (/(^|\/)serviceworker\.js$/i.test(bare)) return true;
    return false;
  }
//@@END:isJellyfinWebBundle@@

//@@BEGIN:injectChromium56Polyfills@@
  function injectChromium56Polyfills(doc) {
    if (!isLegacyChromium()) return;
    var polyfillTag = doc.createElement("script");
    polyfillTag.textContent = chromium56PolyfillBody();
    polyfillTag.setAttribute("data-shell-polyfill", "1");
    var seedTag = doc.querySelector("script[data-shell-seed]");
    if (seedTag && seedTag.nextSibling)
      doc.head.insertBefore(polyfillTag, seedTag.nextSibling);
    else if (seedTag) doc.head.appendChild(polyfillTag);
    else doc.head.insertBefore(polyfillTag, doc.head.firstChild);
  }
//@@END:injectChromium56Polyfills@@

//@@BEGIN:injectQaBeacon@@
  function injectQaBeacon(doc) {
    var body = qaBeaconBody();
    if (!body || body === "__QA_BEACON_BODY__") return;
    var beaconTag = doc.createElement("script");
    beaconTag.setAttribute("data-shell-beacon", "1");
    beaconTag.textContent = body;
    doc.head.appendChild(beaconTag);
  }
//@@END:injectQaBeacon@@

//@@BEGIN:neutralizeUntranspiled@@
  function neutralizeUntranspiled(s, url) {
    try {
      s.removeAttribute("src");
      s.removeAttribute("defer");
      s.removeAttribute("async");
      s.removeAttribute("type");
      s.textContent = "";
      s.setAttribute("data-shell-tx-dropped", url || "1");
    } catch (_) {}
  }
//@@END:neutralizeUntranspiled@@

//@@BEGIN:escAttr@@
  function escAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }
//@@END:escAttr@@

//@@BEGIN:markDocumentWrite@@
  function markDocumentWrite() {
    try {
      if (!window.__qaMarks) return;
      window.__qaMarks.tDocumentWrite = performance.now();
      if (typeof window.__qaMarksSave === "function") window.__qaMarksSave();
      else
        localStorage.setItem(
          "jellyfin.qa.bootMarks.current",
          JSON.stringify(window.__qaMarks),
        );
    } catch (_) {}
  }
//@@END:markDocumentWrite@@

//@@BEGIN:injectConnectStylesheet@@
  function injectConnectStylesheet() {
    // JEL-739: connect.css moved off the critical path. Warm saved-server
    // boot replaces #boot-root via document.write before paint, so the
    // stylesheet was fetched + parsed on every boot but used only on
    // first launch. Inject the <link> here, the only path that actually
    // renders the connect form.
    if (document.getElementById("shell-connect-css")) return;
    var ln = document.createElement("link");
    ln.id = "shell-connect-css";
    ln.rel = "stylesheet";
    ln.href = "connect/connect.css";
    document.head.appendChild(ln);
  }
//@@END:injectConnectStylesheet@@


//@@BEGIN:installResumeEpochCheck@@
  function installResumeEpochCheck() {
    // JELA-66 (v2.0.24): config.xml now ships background-support="enable",
    // so leaving the app SUSPENDS it instead of killing it — a relaunch is
    // a warm resume (~1-2 s) that skips every boot-time freshness check.
    // This hook re-runs the config-epoch comparison on each background →
    // foreground transition: fetch /shell/manifest.json (3 s bound) and
    // compare configEpoch against the record the last adopted boot
    // persisted (write-after-adopt, see loadConfigEpoch). Only a REAL
    // mismatch tears the resumed document down — the reload re-enters
    // the widget's index.html (document.write never changed the
    // URL), so the bootstrap re-runs the full per-component invalidation
    // and repopulate machinery. Every other outcome — match, manifest
    // unreachable, configEpoch field absent, no adopted record, no saved
    // server — keeps the resumed DOM untouched: offline resumes must stay
    // instant.
    //
    // Attached to window, not document, so the listener survives the
    // document.open()/write() handoff (same contract as
    // installBackHandler); visibilitychange fires at the document with
    // bubbles=true, so it reaches window from the written document too.
    //
    // Never reloads out from under active playback: a live Lite AVPlay
    // session (window.__shellLite.player.st not terminal) or a playing
    // SPA <video> defers the reload to the next resume or cold boot.
    // Kill switch: 'jellyfin.shell.resumeEpochDisabled'='1' (this hook
    // alone); the config-epoch master switch (ceGateOn) is honored too.
    // QA surface: window.__shellResumeEpoch {n,st,last} — st
    // idle|check|match|nofield|err|defer|reload.
    var g = { n: 0, st: "idle", last: 0 };
    window.__shellResumeEpoch = g;
    var inflight = false;
    function resumeCheckOff() {
      try {
        return (
          localStorage.getItem("jellyfin.shell.resumeEpochDisabled") === "1"
        );
      } catch (_) {
        return true;
      }
    }
    function playbackLive() {
      try {
        var lp = window.__shellLite && window.__shellLite.player;
        if (lp && lp.st && lp.st !== "closed" && lp.st !== "err") return true;
      } catch (_) {}
      try {
        var vids = document.getElementsByTagName("video");
        for (var i = 0; i < vids.length; i++) {
          if (!vids[i].paused && !vids[i].ended) return true;
        }
      } catch (_) {}
      return false;
    }
    window.addEventListener("visibilitychange", function () {
      try {
        if (document.hidden) return;
      } catch (_) {
        return;
      }
      if (inflight || resumeCheckOff() || !ceGateOn()) return;
      var now = Date.now();
      if (g.last && now - g.last < 5000) return;
      var url = loadServerUrl();
      if (!url) return;
      var rec = null;
      try {
        rec = JSON.parse(localStorage.getItem("jellyfin.shell.configEpoch"));
      } catch (_) {}
      if (!rec || rec.origin !== url || !rec.epoch) return;
      inflight = true;
      g.n++;
      g.last = now;
      g.st = "check";
      withBootTimeout(
        fetch(url + "/shell/manifest.json?__sb=" + now, {
          credentials: "omit",
          cache: "no-store",
        }),
        "resume epoch",
        3000,
      )
        .then(function (r) {
          return r && r.ok ? r.json() : null;
        })
        .then(function (m) {
          inflight = false;
          if (!m || !m.configEpoch) {
            g.st = m ? "nofield" : "err";
            return;
          }
          if (String(m.configEpoch) === String(rec.epoch)) {
            g.st = "match";
            return;
          }
          if (playbackLive()) {
            g.st = "defer";
            g.last = 0;
            return;
          }
          g.st = "reload";
          try {
            localStorage.setItem(
              "jellyfin.shell.resumeReload",
              JSON.stringify({
                e: String(m.configEpoch).slice(0, 8),
                ts: Date.now(),
              }),
            );
          } catch (_) {}
          location.reload();
        })
        .catch(function () {
          inflight = false;
          g.st = "err";
        });
    });
  }
//@@END:installResumeEpochCheck@@
