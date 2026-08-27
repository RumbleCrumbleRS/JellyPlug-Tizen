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
    // Attached to window, not document — visibilitychange fires at the
    // document with bubbles=true, so it reaches window from the written
    // document too. BUT window listeners do NOT reliably survive the
    // document.open()/write() SPA handoff: engines on the Chrome 68+
    // spec (QN90B Tizen 6.5 — proven on-device 2026-07-13) wipe window
    // listeners at document.open(), while Chromium 63 (Q60R Tizen 5.0)
    // keeps them. So the listener is re-armed on a window TIMER (timers
    // DO survive the handoff on both engines — the same contract the
    // HSB store-retry chain ships on): remove-then-add of the same
    // function ref is idempotent, so old engines never accumulate
    // duplicate listeners.
    //
    // Never reloads out from under active playback: a live Lite AVPlay
    // session (window.__shellLite.player.st not terminal) or a playing
    // SPA <video> defers the reload to the next resume or cold boot.
    // Kill switch: 'jellyfin.shell.resumeEpochDisabled'='1' (this hook
    // alone); the config-epoch master switch (ceGateOn) is honored too.
    // QA surface: window.__shellResumeEpoch {n,st,last,armN} — st
    // idle|check|match|nofield|err|defer|reload.
    var g = { n: 0, st: "idle", last: 0, armN: 0 };
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
    function onVisible() {
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
    }
    function arm() {
      try {
        window.removeEventListener("visibilitychange", onVisible);
      } catch (_) {}
      try {
        window.addEventListener("visibilitychange", onVisible);
        g.armN++;
      } catch (_) {}
    }
    arm();
    setInterval(arm, 5000);
  }
//@@END:installResumeEpochCheck@@

//@@BEGIN:installLsWriteBehind@@
  function installLsWriteBehind() {
    // JELA-751: write-behind overlay for large localStorage cache bodies.
    //
    // Chromium's per-origin localStorage commit persists "what is pending
    // when a commit fires", and the boot-cadence first commit fires ~5 s
    // after the session's first write. A first boot streams ~3.6 M chars
    // of cache bodies (152 version-keyed tx slots, the txc: aggregates,
    // bundlePatchState) over ~25 s, so only the head of the stream is
    // pending at that commit and the tail never reaches disk — that is
    // the whole JELA-748 0->39->86->152 three-boot priming curve.
    // Shrinking the bytes does NOT move it (0.28x-0.52x arms persisted
    // the IDENTICAL key set as control), and neither does a longer
    // session (a 400 s boot persisted FEWER slots than a 45 s one). A
    // single LATE burst, though, persists 152/152 (synthetic arm F-late):
    // commit TIMING is the lever. So: hold every large cache body in a
    // memory overlay during the boot burst (reads stay consistent via the
    // wrapped getItem), then flush the whole set in ONE synchronous pass
    // once held writes have been quiet for LSWB_QUIET_MS (hard cap
    // LSWB_CAP_MS after the first hold) — a single commit captures the
    // full set.
    //
    // Scope: string values >= LSWB_MIN chars whose key starts with
    // "shell.tx" (version slots, txc: bodies, the LRU map) or equals
    // "jellyfin.shell.bundlePatchState". Everything else — flags, creds,
    // settings, the small ts:/vqk: siblings, hsbShellBody (written by the
    // WGT bootstrap index.html before this installer can run) — writes
    // through untouched. Storage.prototype is wrapped, NOT the
    // localStorage instance, so the seed-side __txGet/__txSet running in
    // the remote document after the document.write handoff (same realm,
    // same prototype) hit the same overlay; sessionStorage traffic passes
    // through (this !== localStorage). No lifecycle listeners (the
    // lifecycle-resume contract) — timers only, and timers survive the
    // handoff on both engine generations. A body still held when the app
    // dies is lost, which is exactly its fate today past the first
    // commit; readers see a cache miss and refetch (self-healing, same
    // contract as a pruned slot).
    //
    // Flag-dark: opt-in localStorage["jellyfin.shell.lsWriteBehind"]="1";
    // kill switch ["jellyfin.shell.lsWriteBehindDisabled"]="1". QA
    // surface: window.__shellLsWB {st:"hold"|"flushed", q, qc (held
    // count/chars), fl, fc (flushed count/chars), qe (flush quota
    // errors), ms (flush wall-clock)}.
    var LSWB_MIN = 4096;
    var LSWB_QUIET_MS = 6000;
    var LSWB_CAP_MS = 60000;
    try {
      if (window.__shellLsWB) return;
      if (!Object.create) return;
      var enabled = false;
      try {
        enabled =
          localStorage.getItem("jellyfin.shell.lsWriteBehind") === "1" &&
          localStorage.getItem("jellyfin.shell.lsWriteBehindDisabled") !== "1";
      } catch (_) {}
      if (!enabled) return;
      var proto = window.Storage && Storage.prototype;
      var LS = window.localStorage;
      if (!proto || !proto.setItem || !proto.getItem || !proto.removeItem)
        return;
      if (!LS) return;
      var oSet = proto.setItem;
      var oGet = proto.getItem;
      var oRem = proto.removeItem;
      // Null-prototype map: held keys are attacker-free (our own cache
      // keys) but getItem probes it with ARBITRARY keys, so inherited
      // props ("constructor") must not read as hits.
      var held = Object.create(null);
      var st = { st: "hold", q: 0, qc: 0, fl: 0, fc: 0, qe: 0, ms: 0 };
      window.__shellLsWB = st;
      var quietT = null;
      var capT = null;
      function holds(k, v) {
        return (
          v.length >= LSWB_MIN &&
          (k.lastIndexOf("shell.tx", 0) === 0 ||
            k === "jellyfin.shell.bundlePatchState")
        );
      }
      function flush() {
        if (st.st !== "hold") return;
        st.st = "flushed";
        try {
          if (quietT) clearTimeout(quietT);
          if (capT) clearTimeout(capT);
        } catch (_) {}
        var t0 = Date.now();
        for (var k in held) {
          try {
            oSet.call(LS, k, held[k]);
            st.fl++;
            st.fc += held[k].length;
          } catch (_) {
            // Quota — soft fail, same contract as txSetStatic: the slot
            // reads as a miss next boot and refetches.
            st.qe++;
          }
        }
        held = Object.create(null);
        st.q = 0;
        st.qc = 0;
        st.ms = Date.now() - t0;
      }
      function rearm() {
        try {
          if (quietT) clearTimeout(quietT);
          quietT = setTimeout(flush, LSWB_QUIET_MS);
          if (!capT) capT = setTimeout(flush, LSWB_CAP_MS);
        } catch (_) {
          flush();
        }
      }
      proto.setItem = function (k, v) {
        if (this === LS && st.st === "hold") {
          var key = String(k);
          var val = String(v);
          if (holds(key, val)) {
            if (held[key] !== undefined) st.qc -= held[key].length;
            else st.q++;
            held[key] = val;
            st.qc += val.length;
            rearm();
            return;
          }
        }
        return oSet.apply(this, arguments);
      };
      proto.getItem = function (k) {
        if (this === LS) {
          var hv = held[String(k)];
          if (hv !== undefined) return hv;
        }
        return oGet.apply(this, arguments);
      };
      proto.removeItem = function (k) {
        if (this === LS) {
          var key = String(k);
          if (held[key] !== undefined) {
            st.qc -= held[key].length;
            st.q--;
            delete held[key];
          }
        }
        return oRem.apply(this, arguments);
      };
    } catch (_) {}
  }
//@@END:installLsWriteBehind@@
