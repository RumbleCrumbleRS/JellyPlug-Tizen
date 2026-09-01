/*
 * Jellyfin Tizen browser-shell prototype (JEL-3, milestone M1).
 *
 * Architecture (per JEL-2 roadmap section 3):
 *   - Widget origin owns the document. We never navigate the WebView away from
 *     the widget; tizen.* and webapis.* APIs only bind to widget-origin pages.
 *   - On successful connect we fetch ${server}/web/index.html, set <base href>
 *     to ${server}/web/, inject window.NativeShell first, then write the
 *     remote markup into our document via document.open/write/close. Scripts,
 *     CSS, and runtime XHR resolve to the live server — so server-installed
 *     plugins appear without any vendoring.
 *   - jellyfin-web reads window.NativeShell at boot, so NativeShell must be
 *     defined before the remote bundle's scripts execute.
 */

(function () {
  "use strict";

  // JEL-557: capture shell.js IIFE entry timestamp so the diag HUD can report
  // boot → DCL → ApiClient → first-card deltas. Survives document.write because
  // window persists across the document handoff.
  try {
    if (!window.__shellT0) window.__shellT0 = Date.now();
  } catch (_) {}

  //@@SHELL_CORE:installLsWriteBehind@@

  // JELA-751: arm the write-behind overlay before any cache body can be
  // written this boot (the shell-core declaration above hoists).
  installLsWriteBehind();

  // JEL-617: boot-phase ring. Persists per-boot launch→connect→login→home
  // wall-clock deltas (ms from __shellT0) so before/after baselines for the
  // JEL-616 rehaul can be read on-device without host tooling (Q60R blocks
  // dlog and the inspector). One record per boot, last 10 boots kept in
  // localStorage["jellyfin.shell.bootPhases"]. The record is created HERE at
  // IIFE entry — before connect/transpile — so a boot that dies mid-way still
  // leaves a partial record; each later mark rewrites the same entry. Marks
  // arrive from the shell body (connect) and from the diag seed running in
  // the remote document (dcl/api/login/home/card) — window survives the
  // document.write handoff, so this one recorder covers both documents.
  // `nav` = navigationStart→shell-entry (WebView spin-up + index.html fetch),
  // the pre-shell slice of launch the deltas can't otherwise see.
  // Kill switch: localStorage["jellyfin.shell.bootPhasesDisabled"]="1"
  // (stops ring WRITES; in-memory window.__shellPhases still records).
  try {
    (function () {
      if (window.__shellPhase) return;
      var t0 = window.__shellT0 || Date.now();
      var RK = "jellyfin.shell.bootPhases";
      var off = false;
      try {
        off = localStorage.getItem("jellyfin.shell.bootPhasesDisabled") === "1";
      } catch (_) {}
      var nav = 0;
      try {
        var ns =
          window.performance &&
          performance.timing &&
          performance.timing.navigationStart;
        if (ns && ns > 0 && ns <= t0) nav = t0 - ns;
      } catch (_) {}
      var rec = { ts: t0, nav: nav, ver: "__SHELL_VER__" };
      window.__shellPhases = rec;
      function save() {
        if (off) return;
        try {
          var r;
          try {
            r = JSON.parse(localStorage.getItem(RK) || "[]");
          } catch (_) {
            r = null;
          }
          if (!r || !r.push) r = [];
          if (r.length && r[r.length - 1] && r[r.length - 1].ts === rec.ts) {
            r[r.length - 1] = rec;
          } else {
            r.push(rec);
          }
          while (r.length > 10) r.shift();
          localStorage.setItem(RK, JSON.stringify(r));
        } catch (_) {}
      }
      window.__shellPhase = function (k) {
        if (rec[k]) return;
        rec[k] = Date.now() - t0;
        save();
      };
      save();
    })();
  } catch (_) {}

  var SERVER_URL_KEY = "jellyfin.shell.serverUrl";
  var hasTizen = typeof window.tizen !== "undefined";
  var hasWebapis = typeof window.webapis !== "undefined";

  // JEL-63: bounded boot-fetch timeout. With a saved server URL pointing at
  // an unreachable-but-routable host (SYN gets no reply / packets dropped),
  // a bare fetch() hangs for the platform's default TCP connect timeout —
  // which differs between Tizen Chromium and desktop Chrome (tens of seconds
  // to minutes), so boot recovery time would NOT be parity-equal. Racing the
  // fetch against a fixed timer makes the connect-screen recovery happen at
  // the SAME bounded moment on both platforms. 15 s sits far above any healthy
  // /web/ RTT (200-500 ms typical, a few seconds worst case on slow TV Wi-Fi)
  // so it never fires on a reachable server, yet well below the platform TCP
  // default so an unreachable host recovers promptly. Promise.race only frees
  // the boot promise — the underlying socket keeps draining (we cannot abort
  // on Chromium 56, which predates AbortController), but the UI recovers.
  var BOOT_FETCH_TIMEOUT_MS = 15000;
  // JEL-85/JEL-314: connect-form probe gets a tighter bound than boot. The
  // connect form is interactive (user typed a server and pressed Connect), so
  // a black-hole/firewalled host must surface an error promptly rather than
  // hang for the platform TCP default. 5 s is comfortably above a healthy
  // /System/Info/Public RTT yet well below the platform connect timeout.
  var CONNECT_FETCH_TIMEOUT_MS = 5000;
  function withBootTimeout(p, label, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out reaching server (" + label + ")"));
      }, ms || BOOT_FETCH_TIMEOUT_MS);
      Promise.resolve(p).then(
        function (v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // ---- Transpile cache key (JEL-1150) -----------------------------------
  //
  // Derive TX_VER from the inputs that actually affect babel output:
  //   - MODERN_SYNTAX_RE.source (pre-check regex that decides whether to
  //     transpile)
  //   - babel.transform options literal (preset, targets, sourceType, ...)
  //   - babel.min.js fingerprint (build-time substituted)
  //
  // Prior versions hand-bumped `TX_VER` on every shell release; v52/v53
  // both invalidated the entire localStorage cache despite neither
  // changing babel output. With derivation, cache survives any shell
  // refactor that doesn't touch these inputs. The seed-script `__TXVER`
  // (runs on server origin after document.write) reads the same value
  // so static-side and dynamic-side cache writes hit the same keys.
  // JEL-26: mirror the bootstrap shell's BigInt false-positive guard. The
  // bare `\d+n\b` matched ordinary identifiers ending in a digit+`n`
  // (e.g. `span1n`, hex-ish tokens), forcing needless transpile passes and,
  // worse, sometimes flagging already-legacy code. Anchoring on a
  // non-word/non-`$`/non-`.` boundary restricts it to genuine BigInt
  // literals (`10n`) the way Chromium 56 actually needs.
  // JEL-354: the original denylist only screened ES2020+ tokens, but the
  // runtime floor is Chromium 56 (Tizen 4.0/5.0 Q60R panels), which also
  // lacks several ES2018 syntax forms. A plugin using object-spread but no
  // `?.` was classified ES5-safe and written RAW -> SyntaxError on M56. Add:
  //   `{...x}` / `{a,...r}`  object rest/spread  (Chrome 60)  -> `\{\s*\.\.\.`
  //                                                              + `\.\.\.[\w$]+\s*\}`
  //   `async function*` / `async *m()`  async generators (Chrome 63)
  //   `for await...of`                   async iteration   (Chrome 63)
  // ARRAY/CALL spread (`[...a]`, `f(...a)`) and rest PARAMS (`(a,...r)`) are
  // ES2015 — Chrome 56 parses them natively and Babel passes them through
  // un-lowered, so they MUST NOT match THIS regex (it doubles as the post-
  // transpile "fully lowered" ORACLE; flagging them would falsely claim a
  // clean body is still modern). The two object patterns key off the `{`/`}`
  // braces that distinguish object spread from array/call spread.
  var MODERN_SYNTAX_RE_SRC =
    "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await";
  var MODERN_SYNTAX_RE = new RegExp(MODERN_SYNTAX_RE_SRC);
  // JEL-417: the brace-anchored object-spread alternatives above only catch a
  // spread ADJACENT to a brace — `{...x` (object START) or `...x}` (object
  // END). An INTERIOR spread surrounded by other properties on both sides —
  // `{a:1, ...b, c:2}`, `{p:1, ...a.b, q:2}` — is preceded by `,` and followed
  // by `,`, so it matches NEITHER and the body is mis-classified ES5-safe and
  // written RAW -> SyntaxError on M56 (the exact JEL-354 failure mode, narrower
  // input). Brace-local regex cannot disambiguate object vs array/call spread
  // for an interior `, ...x`, and the oracle above MUST stay precise (matching
  // legal ES2015 `[a, ...b]`/`f(a, ...b)` there would falsely report a lowered
  // body as still-modern). So SPLIT the roles: keep MODERN_SYNTAX_RE as the
  // post-transpile oracle, and gate the PRE-check on this broader regex that
  // also flags comma-prefixed spread. Every object-spread element is either the
  // first property (caught by `\{\s*\.\.\.`) or a non-first one (caught here by
  // `,\s*\.\.\.[\w$]`), so the union is complete. Over-triggering on ES2015
  // array/call spread in the PRE-check only costs one unnecessary — and
  // correct — babel pass; strictly safer than running raw ES2018 on M56.
  var MODERN_PRECHECK_RE_SRC = MODERN_SYNTAX_RE_SRC + "|,\\s*\\.\\.\\.[\\w$]";
  var MODERN_PRECHECK_RE = new RegExp(MODERN_PRECHECK_RE_SRC);
  // JELA-11 (adopting JEL-651 §4): device-native parse probe. Both regexes
  // above only APPROXIMATE the real question — "can this engine parse this
  // source?" — and every approximation gap has been a field incident: a
  // missed token ships a raw SyntaxError to the TV (JEL-354, JEL-417) and
  // each widening forces a TX_EPOCH bump that orphans every cached transpile
  // on every TV in the field. The engine's own parser is ground truth:
  // new Function(code) parses the body EAGERLY without executing it (early
  // errors throw at construction), so a throw === this engine cannot parse
  // it. Detection becomes per-device optimal (an M69 panel transpiles less
  // than the chrome-56 floor), which is correct because the verdict is only
  // consumed on this device and all transpile caches are content-addressed
  // per device. Known caveats, accepted in the JEL-651 review: the Function
  // wrapper legalizes top-level `return`, and each probe compiles + discards
  // a code object (bounded — slow paths only, ~200-400 ms across a full
  // 2 MB plugin set vs the 21-42 s Babel passes it gates).
  // Capability-gated: a CSP/eval restriction makes the Function constructor
  // itself throw, so availability is tested once at parse time with a
  // trivial body — and re-tested independently by the seed script, because
  // the post-document.write SERVER origin can carry a different CSP than
  // the widget origin. When unavailable (or killswitched via the standard
  // lever below), every call site falls back to the regex path unchanged;
  // the regexes also remain the offline coverage pre-filter in
  // build-tx-drop.mjs / jsi-minify-es5.mjs (an offline builder cannot ask
  // an M56 parser).
  var PARSE_PROBE_DISABLED_KEY = "jellyfin.shell.parseProbeDisabled";
  function parseProbeDisabled() {
    try {
      return localStorage.getItem(PARSE_PROBE_DISABLED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  var PARSE_PROBE_OK = (function () {
    try {
      new Function("1");
      return true;
    } catch (_) {
      return false;
    }
  })();
  function parseProbeActive() {
    return PARSE_PROBE_OK && !parseProbeDisabled();
  }
  // QA counters (read alongside __shellTx*): ok=constructor usable,
  // n=probes run, tx=cannot-parse verdicts (detection hits + oracle rejects).
  try {
    window.__shellParseProbe = { ok: PARSE_PROBE_OK, n: 0, tx: 0 };
  } catch (_) {}
  function parsesOnThisEngine(code) {
    var d = window.__shellParseProbe;
    if (d) d.n++;
    try {
      new Function(code);
      return true;
    } catch (_) {
      if (d) d.tx++;
      return false;
    }
  }
  // Mirror of babel.transform options used by babelTranspile() and the
  // seed-script transpile(). Any divergence between them or between
  // releases changes this string and busts the cache.
  // JEL-26 used target chrome:63 + loose mode + the `assumptions` block to fix
  // the Splide iterable/iterator throw on the M63. JEL-354: the target is reset
  // to chrome:56 — the documented runtime floor (see isLegacyChromium and the
  // "Chromium 56" notes throughout). preset-env only lowers syntax the TARGET
  // lacks, so chrome:63 left ES2018 forms Chrome 56 cannot parse (object-spread
  // `{...a}`, async generators, `for await`) un-lowered -> SyntaxError on the
  // 2019 Q60R panels. The iterator fix is carried by the `loose:true` +
  // `assumptions:{iterableIsArray,arrayLikeIsIterable}` block (KEPT) and the
  // runtime __shellIterFix sweep, NOT by the target bump, so chrome:56 does not
  // regress JEL-26. The `assumptions` block is part of the transform options
  // but intentionally omitted from this key string to stay byte-identical with
  // the bootstrap shell's BABEL_OPTS_KEY (it derives TX_VER from the same
  // inputs).
  var BABEL_OPTS_KEY =
    "presets:[[env,{targets:{chrome:56},modules:false,loose:true}]];sourceType:script;compact:true;comments:false";
  // Build-time substituted by build_shell_min.py with
  // `<len>:<first32>:<last32>` of vendored babel.min.js. Unbuilt loads
  // keep the literal placeholder, which is fine: it's stable across
  // those loads and changes only when babel.min.js does.
  var BABEL_FPR = "__BABEL_FPR__";
  function txFnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  // JEL-178: cache-epoch salt (lockstep with boot-shell.src.js). Bumping this
  // changes TX_VER -> TX_PFX, orphaning EVERY prior transpile-cache entry on
  // next boot. Required to flush legacy bare-path JS-Injector entries that the
  // version-keying fix cannot retroactively invalidate; on-device confirmed to
  // drop a disabled snippet's stale rows on the M63. Keep this string in sync
  // with boot-shell.src.js's TX_CACHE_EPOCH.
  // JEL-216: bumped to jel216-1 (lockstep with boot-shell.src.js) alongside
  // making the JS-Injector channel script query-bearing, orphaning any stale
  // bare-public.js-URL transpile entry an older shell wrote and never
  // re-validated on a snippet edit.
  // JEL-354: bumped to jel354-1 (lockstep with boot-shell.src.js) alongside
  // resetting the transpile target to chrome:56 and widening the pre-check.
  // (TX_VER already changes via BABEL_OPTS_KEY + MODERN_SYNTAX_RE_SRC, but the
  // explicit epoch keeps the intent legible: every entry an older chrome:63
  // shell wrote under-transpiled ES2018 syntax and must be re-derived.)
  // JEL-417: bumped to jel417-1 (lockstep with boot-shell.src.js) alongside
  // broadening the PRE-check to interior object spread. Any entry a prior shell
  // wrote for a body whose only modern token was interior `, ...x` spread was
  // cached RAW (fast-path miss); orphaning the prefix forces re-derivation so
  // the now-detected body is transpiled. MODERN_PRECHECK_RE_SRC is also folded
  // into the hash so the pre-check change busts the cache on its own.
  var TX_CACHE_EPOCH = "jel417-1";
  var TX_VER = txFnv1a(
    MODERN_SYNTAX_RE_SRC +
      "|" +
      MODERN_PRECHECK_RE_SRC +
      "|" +
      BABEL_OPTS_KEY +
      "|" +
      BABEL_FPR +
      "|" +
      TX_CACHE_EPOCH,
  );
  var TX_PFX = "shell.tx" + TX_VER + ":";
  try {
    window.__TXVER = TX_VER;
  } catch (_) {}

  // ---- Bundle patch state cache (JEL-1776) -------------------------------
  //
  // patchPlaybackBundles() decodes a ~1.5–2 MB main.*.bundle.js body and
  // runs a CM/PM regex scan on every boot, even when the bundle URL
  // (contenthash) is unchanged from the prior session. The network RTT is
  // overlapped via index.html prefetch (JEL-1289), but the CPU cost of
  // body decode + scan is ~200–500 ms on Chromium 56 and lands on the
  // critical path before document.write.
  //
  // Cache the verdict ({needsPatch, body?}) keyed on absolute bundle URL.
  // Warm boot with matching URL:
  //   - needsPatch=false → leave <script src defer> in place (HTTP cache
  //     serves the body), skip decode + scan entirely.
  //   - needsPatch=true + body present → inline cached patched body, skip
  //     fetch + scan.
  //   - needsPatch=true + body absent (quota fallback) → fall through to
  //     fetch + scan + re-patch (verdict still saves one regex pass had
  //     the bundle been an unmatched one).
  // Bust on shell version change so a release that touches the patcher
  // auto-invalidates. Body persistence is best-effort: if localStorage
  // throws on setItem (quota), fall back to {url, needsPatch} only.
  var BUNDLE_CACHE_KEY = "jellyfin.shell.bundlePatchState";
  var BUNDLE_CACHE_VER = "__SHELL_VER__";
  // JEL-1980: 3 MB cap. main.jellyfin.bundle.js raw is ~1.5–2.5 MB on
  // this server; patched body adds <1 KB. Cap rejects garbage/partial
  // responses without rejecting the real bundle. Combined LS budget
  // (webIndexHtml + webConfig + bundlePatchState.body) stays under ~3.1
  // MB which is well inside Tizen WebKit's 5 MB per-origin LS quota.
  var MAIN_BUNDLE_BODY_MAX = 3 * 1024 * 1024;

  function readBundlePatchState() {
    try {
      var raw = localStorage.getItem(BUNDLE_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== BUNDLE_CACHE_VER) return null;
      return p;
    } catch (_) {
      return null;
    }
  }

  function writeBundlePatchState(state) {
    var rec = {
      v: BUNDLE_CACHE_VER,
      url: state.url,
      needsPatch: !!state.needsPatch,
    };
    // JEL-1776: cache patched body so warm boot skips fetch+scan.
    // JEL-1980: cache RAW body too when needsPatch=false so warm/cold-
    // HTTP-cache boots inline main.jellyfin.bundle.js instead of
    // refetching via <script src>. needsPatch=false is the dominant
    // case on Chromium 69 / Tizen 5.5 where the serverId-null patch
    // isn't required; HTTP-cache eviction (~50 MB Tizen cap, post-
    // power-cycle, Defender wipes) made the post-document.write
    // bundle fetch a ~400–900 ms cold-cache hit on the critical path.
    if (state.body && state.body.length <= MAIN_BUNDLE_BODY_MAX) {
      rec.body = state.body;
      if (state.needsPatch && typeof state.patches === "number")
        rec.patches = state.patches;
    }
    try {
      localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(rec));
      return;
    } catch (_) {
      try {
        window.__shellMainBundleQuotaErr = 1;
      } catch (__) {}
    }
    // Quota — retry without body so the warm-boot verdict survives even
    // when the patched body can't fit. needsPatch=true + no body forces
    // a fetch/scan on next boot but the URL match shortcut still wins
    // for unmatched bundles on later boots.
    if (rec.body) {
      delete rec.body;
      delete rec.patches;
      try {
        localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(rec));
      } catch (__) {}
    }
  }

  // ---- Web index/config body cache (JEL-1977) ----------------------------
  //
  // Head-IIFE in index.html prefetches /web/index.html + /web/config.json,
  // and loadRemoteWebClient awaits both before document.write. On a cold
  // HTTP cache (post-power-cycle, post-OOM, browser-cache eviction, first
  // boot of the day) the LAN RTT pair is 200–500 ms on TV networks and
  // gates document.open. shell.min.js parse (~50–100 ms) plus the
  // optional babel preload (JEL-1973) only partially overlap; on non-
  // babel-needed boots /web/ RTT is THE dominant pre-document.write cost.
  //
  // Mirror the JEL-1289 / JEL-1654 / JEL-1776 / JEL-1924 / JEL-1959 record-
  // and-replay pattern at the /web/ document layer:
  //   - successful fetch → write body to localStorage keyed by server origin
  //   - subsequent boot → resolve indexPromise/configPromise from LS, kick
  //     a background revalidation that updates LS for next boot
  //   - origin mismatch → drop cache (server URL changed)
  //   - shell version bump → invalidate (`v` field carries widget version)
  //   - 256 KB cap per body (LS quota; current index.html ~50 KB, config
  //     ~5 KB, well within)
  //
  // Gated by `jellyfin.shell.indexCache` localStorage flag: ON by default
  // (JEL-622 — SWR passed its QA parity soak, so every boot now skips the
  // pre-document.write /web/ RTT pair). Set '0' to opt out.
  var WEB_INDEX_CACHE_KEY = "jellyfin.shell.webIndexHtml";
  var WEB_CONFIG_CACHE_KEY = "jellyfin.shell.webConfig";
  var WEB_CACHE_VER = "__SHELL_VER__";
  var WEB_CACHE_MAX = 262144; // 256 KB cap per body
  var WEB_CACHE_GATE_KEY = "jellyfin.shell.indexCache";

  function webCacheEnabled() {
    try {
      return localStorage.getItem(WEB_CACHE_GATE_KEY) !== "0";
    } catch (_) {
      return false;
    }
  }

  function readWebIndexCache(serverOrigin) {
    try {
      var raw = localStorage.getItem(WEB_INDEX_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== WEB_CACHE_VER) return null;
      if (p.origin !== serverOrigin) return null;
      if (typeof p.body !== "string" || !p.body.length) return null;
      return p;
    } catch (_) {
      return null;
    }
  }

  function writeWebIndexCache(serverOrigin, body) {
    if (typeof body !== "string") return;
    // JEL-178: never persist a web-index HTML that has a transpiled plugin
    // script inlined into it. Such an inline is a point-in-time snapshot of
    // that plugin's body; replaying cached HTML later would ignore a config
    // change. Plugin-agnostic (keys off the shell's own inline marker).
    if (body.indexOf("data-shell-transpiled-from") >= 0) return;
    // index.html on real Jellyfin servers is ~30–60 KB; <1 KB or no
    // `<html`/`<body` means a truncated/error response (e.g. partial
    // transfer on a flaky TV network). Skip caching to avoid poisoning
    // the next boot.
    if (body.length < 1024) return;
    if (body.length > WEB_CACHE_MAX) return;
    if (body.indexOf("<html") < 0 && body.indexOf("<HTML") < 0) return;
    var rec = {
      v: WEB_CACHE_VER,
      origin: serverOrigin,
      ts: Date.now(),
      size: body.length,
      body: body,
    };
    try {
      localStorage.setItem(WEB_INDEX_CACHE_KEY, JSON.stringify(rec));
    } catch (_) {}
  }

  function readWebConfigCache(serverOrigin) {
    try {
      var raw = localStorage.getItem(WEB_CONFIG_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== WEB_CACHE_VER) return null;
      if (p.origin !== serverOrigin) return null;
      if (typeof p.body !== "string" || !p.body.length) return null;
      // Parsed value cached on the wrapper so each warm boot avoids
      // a second JSON.parse on the upstream config body.
      try {
        p.parsed = JSON.parse(p.body);
      } catch (_) {
        return null;
      }
      return p;
    } catch (_) {
      return null;
    }
  }

  function writeWebConfigCache(serverOrigin, bodyText) {
    if (typeof bodyText !== "string") return;
    if (bodyText.length < 2 || bodyText.length > WEB_CACHE_MAX) return;
    // Reject if body doesn't parse — partial/error response.
    try {
      JSON.parse(bodyText);
    } catch (_) {
      return;
    }
    var rec = {
      v: WEB_CACHE_VER,
      origin: serverOrigin,
      ts: Date.now(),
      size: bodyText.length,
      body: bodyText,
    };
    try {
      localStorage.setItem(WEB_CONFIG_CACHE_KEY, JSON.stringify(rec));
    } catch (_) {}
  }

  // ---- Persistence -------------------------------------------------------

  function loadServerUrl() {
    try {
      return localStorage.getItem(SERVER_URL_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function saveServerUrl(url) {
    try {
      localStorage.setItem(SERVER_URL_KEY, url);
    } catch (e) {
      // localStorage failure is non-fatal for the prototype.
    }
  }

  function clearServerUrl() {
    try {
      localStorage.removeItem(SERVER_URL_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Server validation -------------------------------------------------

  function normalizeServerUrl(input) {
    var url = String(input || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) {
      url = "http://" + url;
    }
    return url.replace(/\/+$/, "");
  }

  function validateServer(serverUrl) {
    // Probe /System/Info/Public — public, unauthenticated, returns JSON
    // with Id + Version on any live Jellyfin server.
    //
    // JEL-85/JEL-314: bound the probe (mirrors boot-shell.src.js). A
    // black-hole/firewalled host (SYN dropped, no RST) typed into the
    // boot-failure recovery connect form would otherwise hang the form
    // forever with no error. Promise.race against CONNECT_FETCH_TIMEOUT_MS
    // recovers the UI promptly (AbortController is unreliable on M63).
    return withBootTimeout(
      fetch(serverUrl + "/System/Info/Public", {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.json();
        })
        .then(function (info) {
          // Require BOTH Id and Version — a pathological {Id:...}-only
          // endpoint is not a Jellyfin server (JEL-85 bug #2).
          if (!info || !info.Id || !info.Version)
            throw new Error("Not a Jellyfin server");
          return info;
        }),
      "connect",
      CONNECT_FETCH_TIMEOUT_MS,
    );
  }

  // ---- TV remote keys ----------------------------------------------------

  function registerRemoteKeys() {
    if (!hasTizen || !tizen.tvinputdevice) return;
    var keys = [
      "MediaPlay",
      "MediaPause",
      "MediaPlayPause",
      "MediaStop",
      "MediaTrackPrevious",
      "MediaTrackNext",
      "MediaRewind",
      "MediaFastForward",
      "ColorF0Red",
      "ColorF1Green",
      "ColorF2Yellow",
      "ColorF3Blue",
    ];
    keys.forEach(function (k) {
      try {
        tizen.tvinputdevice.registerKey(k);
      } catch (e) {
        /* not fatal */
      }
    });
  }

  // BACK on connect screen exits; on the web client jellyfin-web's own
  // history handler runs first (Esc/Back is bound there). We only catch
  // BACK if the web client hasn't taken it.
  function installBackHandler() {
    // Attach to window (not document) so the listener survives the
    // document.open()/write() handoff to the remote web client. After
    // boot, the web client owns BACK; we only catch it as a safety net.
    window.addEventListener("keydown", function (ev) {
      // Tizen BACK = keyCode 10009
      if (ev.keyCode === 10009) {
        if (window.__jellyfinShellBootDone) return; // web client owns it
        // Lite owns BACK while its canvas home is resident or handing
        // off (JELA-67): current lite bytes stop propagation before
        // this backstop can fire, but OLD cached bytes predate that —
        // never let the pre-boot exit path kill a live Lite app.
        var lite = window.__shellLite;
        if (lite && (lite.st === "live" || lite.st === "handoff")) return;
        ev.preventDefault();
        exitApp();
      }
    });
  }

  function exitApp() {
    if (hasTizen && tizen.application) {
      try {
        tizen.application.getCurrentApplication().exit();
        return;
      } catch (e) {
        /* fallthrough */
      }
    }
    window.close();
  }

  //@@SHELL_CORE:installResumeEpochCheck@@

  // ---- NativeShell contract ---------------------------------------------
  //
  // Subset required by jellyfin-web (see jellyfin-web grep on JEL-3):
  //   AppHost: init, appName, deviceId, deviceName, exit,
  //            getDefaultLayout, getDeviceProfile, getSyncProfile, screen,
  //            supports
  //   Top-level: enableFullscreen, disableFullscreen, openUrl,
  //              updateMediaSession, hideMediaSession, downloadFile,
  //              getPlugins
  //
  // We deliberately do NOT implement AppHost.appVersion. jellyfin-web's
  // apphost wrapper falls back to __PACKAGE_JSON_VERSION__ (the bundled
  // web client version) when NativeShell.AppHost.appVersion is absent —
  // see jellyfin-web/src/components/apphost.js. That is what we want the
  // server's Sessions API to report (JEL-12): the actual web client
  // version, not the Tizen widget package version. The widget version in
  // config.xml is package metadata only and intentionally not surfaced
  // through ApiClient.
  //
  // Methods not yet implemented are stubbed to no-ops or sensible defaults.

  function generateDeviceId() {
    return btoa(
      [navigator.userAgent, Date.now(), Math.random()].join("|"),
    ).replace(/=/g, "1");
  }

  function getDeviceId() {
    var id = localStorage.getItem("_deviceId2");
    if (!id) {
      id = generateDeviceId();
      try {
        localStorage.setItem("_deviceId2", id);
      } catch (e) {
        /* ignore */
      }
    }
    return id;
  }

  var systeminfo = null;
  function getSystemInfo() {
    if (systeminfo) return Promise.resolve(systeminfo);
    if (!hasTizen || !tizen.systeminfo) {
      systeminfo = { resolutionWidth: 1920, resolutionHeight: 1080 };
      return Promise.resolve(systeminfo);
    }
    return new Promise(function (resolve) {
      tizen.systeminfo.getPropertyValue(
        "DISPLAY",
        function (result) {
          var ratio = 1;
          try {
            if (hasWebapis && webapis.productinfo) {
              if (
                typeof webapis.productinfo.is8KPanelSupported === "function" &&
                webapis.productinfo.is8KPanelSupported()
              )
                ratio = 4;
              else if (
                typeof webapis.productinfo.isUdPanelSupported === "function" &&
                webapis.productinfo.isUdPanelSupported()
              )
                ratio = 2;
            }
          } catch (e) {
            /* ignore */
          }
          systeminfo = {
            resolutionWidth: Math.floor(result.resolutionWidth * ratio),
            resolutionHeight: Math.floor(result.resolutionHeight * ratio),
          };
          resolve(systeminfo);
        },
        function () {
          systeminfo = { resolutionWidth: 1920, resolutionHeight: 1080 };
          resolve(systeminfo);
        },
      );
    });
  }

  var AppInfo = {
    deviceId: getDeviceId(),
    deviceName: "Tizen TV",
    appName: "Jellyfin for Tizen",
  };

  // Resolve deviceName from the TV's BUILD model (e.g. "UN65MU8000") so the
  // server's Dashboard -> Devices distinguishes panels. Falls back to the
  // "Tizen TV" constant already in AppInfo on any failure (no tizen, throw, or
  // error callback). Runs in parallel with getSystemInfo() before init resolves.
  var deviceNameResolved = null;
  function resolveDeviceName() {
    if (deviceNameResolved) return deviceNameResolved;
    if (!hasTizen || !tizen.systeminfo) {
      deviceNameResolved = Promise.resolve(AppInfo.deviceName);
      return deviceNameResolved;
    }
    deviceNameResolved = new Promise(function (resolve) {
      try {
        tizen.systeminfo.getPropertyValue(
          "BUILD",
          function (info) {
            if (info && info.model) AppInfo.deviceName = info.model;
            resolve(AppInfo.deviceName);
          },
          function () {
            resolve(AppInfo.deviceName);
          },
        );
      } catch (e) {
        resolve(AppInfo.deviceName);
      }
    });
    return deviceNameResolved;
  }

  var SupportedFeatures = [
    "exit",
    "exitmenu",
    "externallinkdisplay",
    "htmlaudioautoplay",
    "htmlvideoautoplay",
    "physicalvolumecontrol",
    "displaylanguage",
    "otherapppromotions",
    "targetblank",
    "screensaver",
    "multiserver",
    "subtitleappearancesettings",
    "subtitleburnsettings",
  ];

  window.NativeShell = {
    AppHost: {
      init: function () {
        return Promise.all([getSystemInfo(), resolveDeviceName()]).then(
          function () {
            return AppInfo;
          },
        );
      },
      appName: function () {
        return AppInfo.appName;
      },
      // appVersion intentionally omitted: see NativeShell contract block above.
      deviceId: function () {
        return AppInfo.deviceId;
      },
      deviceName: function () {
        return AppInfo.deviceName;
      },
      exit: function () {
        exitApp();
      },
      getDefaultLayout: function () {
        return "tv";
      },
      getDeviceProfile: function (profileBuilder) {
        return profileBuilder({
          enableMkvProgressive: false,
          enableSsaRender: true,
        });
      },
      getSyncProfile: function (profileBuilder) {
        return profileBuilder({ enableMkvProgressive: false });
      },
      screen: function () {
        return systeminfo
          ? {
              width: systeminfo.resolutionWidth,
              height: systeminfo.resolutionHeight,
            }
          : null;
      },
      supports: function (cmd) {
        return (
          !!cmd && SupportedFeatures.indexOf(String(cmd).toLowerCase()) !== -1
        );
      },
    },
    enableFullscreen: function () {
      /* no-op: WebView is always fullscreen on TV */
    },
    disableFullscreen: function () {
      /* no-op */
    },
    openUrl: function (/* url, target */) {
      /* TV cannot open external browsers */
    },
    updateMediaSession: function () {
      /* no native media session yet */
    },
    hideMediaSession: function () {
      /* no native media session yet */
    },
    getPlugins: function () {
      return [];
    },
    downloadFile: function () {
      /* offline downloads not in M1 */
    },
    // Multi-server: clear stored URL and reload to connect screen.
    selectServer: function () {
      clearServerUrl();
      window.location.replace("index.html");
    },
  };

  // ---- Remote-client loader (origin-preserving) -------------------------
  //
  // Fetches ${server}/web/index.html, sets <base href>, then writes the
  // markup back into the current document. We stay on widget origin so
  // tizen.*, webapis.*, and window.NativeShell remain accessible to the
  // running web client. Scripts/CSS resolve relative to the remote /web/.

  function buildSeedScript(serverUrl, upstreamCfg) {
    // Runs INSIDE the rewritten document, before jellyfin-web's own scripts.
    // Intercepts XMLHttpRequest + fetch for config.json so jellyfin-web's
    // webSettings.getConfig() sees servers:[serverUrl]. That makes
    // serverAddress() resolve to our server and ServerConnections.initApiClient()
    // get called automatically -- so the user lands directly on the server's
    // login UI without a second "Add Server" entry.
    //
    // We start from the server's actual /web/config.json (upstream) and
    // override only servers + multiserver. Inventing a plugin list here is
    // brittle: jellyfin-web's pluginManager dynamic-imports
    // `../plugins/${spec}`, so plugin specs must match the upstream paths
    // (e.g. "htmlVideoPlayer/plugin", NOT "htmlVideoPlayer"). Drifting
    // from upstream silently drops players and triggers
    // "No player found for the requested media" on playback (JEL-144).
    // JEL-401 (supersedes JEL-206): we no longer strip non-builtin plugin
    // specs on old Chromium. Server plugins are loaded as <script> tags
    // injected into /web/index.html, not via cfg.plugins[]; the strip
    // filter never matched for the upstream-builtin specs in cfg.plugins
    // anyway. Plugin scripts that use ES2020+ syntax are transpiled by
    // transpileLegacyScripts() before document.write — see below.
    var cfg = Object.assign({}, upstreamCfg || {}, {
      servers: [serverUrl],
      multiserver: false,
    });
    var SAFE = JSON.stringify(serverUrl);
    var CFG_JSON = JSON.stringify(JSON.stringify(cfg));
    return [
      "(function(){",
      "  var S=" + SAFE + ";",
      "  var CFG=" + CFG_JSON + ";",
      '  var matches=function(u){return /(^|\\/)config\\.json(\\?|$)/.test(String(u||""));};',
      "  var origOpen=XMLHttpRequest.prototype.open;",
      "  var origSend=XMLHttpRequest.prototype.send;",
      "  XMLHttpRequest.prototype.open=function(m,u){this.__shellSeed=matches(u);return origOpen.apply(this,arguments);};",
      "  XMLHttpRequest.prototype.send=function(){",
      "    if(this.__shellSeed){var x=this;setTimeout(function(){",
      '      try{Object.defineProperty(x,"responseText",{configurable:true,get:function(){return CFG;}});}catch(e){x.responseText=CFG;}',
      '      try{Object.defineProperty(x,"status",{configurable:true,get:function(){return 200;}});}catch(e){}',
      '      try{Object.defineProperty(x,"readyState",{configurable:true,get:function(){return 4;}});}catch(e){}',
      '      if(typeof x.onreadystatechange==="function")x.onreadystatechange();',
      '      if(typeof x.onload==="function")x.onload();',
      "    },0);return;}",
      "    return origSend.apply(this,arguments);",
      "  };",
      "  var origFetch=window.fetch;",
      "  window.fetch=function(i,init){",
      '    var u=typeof i==="string"?i:(i&&i.url)||"";',
      '    if(matches(u))return Promise.resolve(new Response(CFG,{status:200,headers:{"Content-Type":"application/json"}}));',
      "    return origFetch.call(this,i,init);",
      "  };",
      "  window.__shellSeededServer=S;",
      // JELA-695: cross-origin Worker shim.
      //
      // We keep the widget origin and document.write the server's markup in,
      // so every /web/ asset URL is cross-origin to the running document.
      // `new Worker(crossOriginUrl)` is a hard SecurityError in every engine
      // (confirmed on M63: "Script at '<server>/web/blurhash.worker.bundle.js'
      // cannot be accessed from origin '<widget>'"), and jellyfin-web builds
      // its blurhash worker at MODULE SCOPE:
      //
      //   var l=new function(){return new Worker(r.p+"blurhash.worker.bundle.js")},
      //       ... function decls ...
      //       var g={setLazyImage:b,...,getPrimaryImageAspectRatio:v}
      //
      // The throw aborts imageLoader's module body before `var g` is reached,
      // yet webpack has already installed the `r.d` export getters and cached
      // the half-built namespace — so imageLoader.default is permanently
      // undefined for every later importer. cardBuilder's setCardData opens
      // with `h.default.getPrimaryImageAspectRatio(items)`, so EVERY native
      // getCardsHtml() call throws TypeError. On the home that silently kills
      // all Home Screen Sections rows (data arrives, render rejects, the
      // row-reaper then reaps the empty titles).
      //
      // Fix: native-first Worker wrapper. When the native constructor throws
      // we hand back a queueing proxy and asynchronously re-create the worker
      // from a same-origin blob built out of the fetched script (every
      // /web/ asset is served Access-Control-Allow-Origin:*), replaying
      // queued postMessage
      // and re-binding listeners. If even that fails the proxy stays an inert
      // stub — the module body still completes, which is what matters.
      // Kill switch: localStorage["jellyfin.shell.workerShimDisabled"]="1".
      // Diag: window.__shellWorkerShim={st,n,fb,up,why,err}.
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.workerShimDisabled")==="1"){window.__shellWorkerShim={st:"off"};return;}',
      '    var OW=window.Worker;if(typeof OW!=="function")return;',
      '    var D={st:"on",n:0,fb:0,up:0,why:"",err:""};window.__shellWorkerShim=D;',
      "    function msg(e){return String((e&&e.message)||e).slice(0,80);}",
      "    function proxy(url){",
      "      var q=[],ls=[],real=null,dead=0;",
      "      var p={onmessage:null,onerror:null,",
      "        postMessage:function(m){if(real){try{real.postMessage(m);}catch(_){}}else if(!dead&&q.length<200)q.push(m);},",
      "        addEventListener:function(t,f){ls.push([t,f]);if(real){try{real.addEventListener(t,f);}catch(_){}}},",
      "        removeEventListener:function(t,f){if(real){try{real.removeEventListener(t,f);}catch(_){}}for(var i=0;i<ls.length;i++){if(ls[i][0]===t&&ls[i][1]===f){ls.splice(i,1);break;}}},",
      "        terminate:function(){dead=1;q.length=0;if(real){try{real.terminate();}catch(_){}}}};",
      "      function adopt(w){",
      "        if(dead){try{w.terminate();}catch(_){}return;}",
      "        real=w;D.up++;",
      "        for(var i=0;i<ls.length;i++){try{w.addEventListener(ls[i][0],ls[i][1]);}catch(_){}}",
      '        try{w.onmessage=function(e){if(typeof p.onmessage==="function")p.onmessage(e);};}catch(_){}',
      '        try{w.onerror=function(e){if(typeof p.onerror==="function")p.onerror(e);};}catch(_){}',
      "        for(var j=0;j<q.length;j++){try{w.postMessage(q[j]);}catch(_){}}",
      "        q.length=0;",
      "      }",
      "      try{",
      "        var x=new XMLHttpRequest();",
      '        x.open("GET",url,true);',
      '        x.onload=function(){if(x.status<200||x.status>=300){D.err="http"+x.status;return;}try{var b=new Blob([x.responseText],{type:"application/javascript"});adopt(new OW(((window.URL||window.webkitURL)).createObjectURL(b)));}catch(e){D.err=msg(e);}};',
      '        x.onerror=function(){D.err="neterr";};',
      "        x.send();",
      "      }catch(e2){D.err=msg(e2);}",
      "      return p;",
      "    }",
      "    function W(u,o){",
      "      D.n++;",
      "      try{return new OW(u,o);}catch(e){D.fb++;D.why=msg(e);}",
      "      return proxy(String(u));",
      "    }",
      "    W.prototype=OW.prototype;",
      "    try{window.Worker=W;}catch(_){}",
      "  })();}catch(_){}",
      // JEL-623: boot paint-gate. The cosmetic sweeps this seed installs
      // (auto-focus 600ms poll, remember-me 300ms poll, YT-iframe cap
      // sweep + whole-tree MutationObserver, webpack CM/PM walker) used
      // to arm at document.write handoff and then tick through the whole
      // 20-40s legacy bundle fetch/parse blackout, competing for the
      // main thread on Chromium 56 while having nothing to act on (no
      // jellyfin-web DOM exists yet). This gate is the ONE timer allowed
      // to run during the blackout: a 500ms setTimeout chain whose
      // pre-boot tick is a single `typeof window.ApiClient` property
      // check (no DOM access). Two stages:
      //   onApi(cb)   — webpack entry completed (window.ApiClient set).
      //                 Arms the YT-iframe crash-guard sweep: plugins
      //                 cannot build media-bar DOM before app init, so
      //                 this loses zero crash coverage (the passive
      //                 iframe src setter/setAttribute intercepts are
      //                 armed from t0 regardless).
      //   onPaint(cb) — first view painted (.card / login form / user
      //                 picker / quick-connect), or 60 post-api ticks
      //                 (30s) as a fallback. Arms the cosmetic sweeps
      //                 and the webpack walker.
      // Absolute backstop: 240 total ticks (120s, matches the walker's
      // old noApiClient give-up budget) fires BOTH stages so no feature
      // can stay dead on a wedged boot. Registration sites fall back to
      // arming immediately when the gate is absent (defensive, and lets
      // the per-feature tests lift their IIFEs into bare sandboxes).
      // Diag: window.__shellPaintGate = {api,fired,why,t,ta}.
      '  try{(function(){var g={api:0,fired:0,why:"",t:0,ta:0,cbs:[],acbs:[]};window.__shellPaintGate=g;function run(l){var c=l.slice();l.length=0;for(var i=0;i<c.length;i++){try{c[i]();}catch(_){}}}g.onApi=function(cb){if(g.api){try{cb();}catch(_){}}else g.acbs.push(cb);};g.onPaint=function(cb){if(g.fired){try{cb();}catch(_){}}else g.cbs.push(cb);};g.fireApi=function(){if(g.api)return;g.api=1;g.ta=Date.now();run(g.acbs);};g.fire=function(why){g.fireApi();if(g.fired)return;g.fired=1;g.why=why;g.t=Date.now();run(g.cbs);};var ticks=0,dticks=0;function poll(){if(g.fired)return;ticks++;if(ticks>=240){g.fire("giveup");return;}if(!g.api){if(typeof window.ApiClient==="undefined"){setTimeout(poll,500);return;}g.fireApi();}try{if(document.querySelector(".card,.manualLoginForm,.userItemContainer,.btnUseQuickConnect")){g.fire("paint");return;}}catch(_){}dticks++;if(dticks>=60){g.fire("timeout");return;}setTimeout(poll,500);}setTimeout(poll,500);})();}catch(_){}',
      // JEL-132: creds-guard. jellyfin-web 10.11's connection manager
      // (validateAuthentication) nulls UserId/AccessToken on ANY failure of
      // the authenticated GET /System/Info it issues at boot — network blip,
      // DNS hiccup, reverse-proxy 502 — not just a real 401 — and then
      // persists the strip through the credential provider. One transient
      // outage at TV boot permanently logs the TV out: server stays in the
      // list, user is re-asked to log in. Confirmed in the bundle served by
      // the user's 10.11.11 server (the ajax reject handler is
      // `()=>{e.UserId=null,e.AccessToken=null}` with no status check).
      //
      // Guard = observe-only network taps + a localStorage.setItem veto:
      //   - tap fetch/XHR for the /System/Info validate status and for
      //     POST /Sessions/Logout (explicit sign-out marker);
      //   - when a jellyfin_credentials write strips a previously-present
      //     AccessToken for the same server Id, re-attach the token UNLESS
      //     the last observed validate outcome was 401/403 or a logout was
      //     seen (those clears are legitimate and pass through);
      //   - we never fabricate network responses, so the in-memory session
      //     still lands on the login page for that one boot — but the
      //     stored creds keep the token and the NEXT launch signs in. A
      //     genuinely revoked token self-heals: the next validate 401s and
      //     the strip is allowed through.
      //   - a boot trail ring (jellyfin.shell.credsTrail, 8 entries)
      //     records creds presence/token count/localStorage.length per
      //     boot plus every strip/veto, so the next field incident is
      //     attributable: key absent at boot right after a token=1 boot
      //     means store-level loss (the JEL-132 alternate hypothesis),
      //     while a strip event pins the validate-clear path.
      // JEL-134 (JEL-132 v2): creds vault. The on-device trail capture
      // (tooling/tv-validate/creds-guard/jel132-trail-capture.md) proved a
      // hard TV restart rolls localStorage back to the last durable commit
      // (76 -> 16 keys observed), destroying a freshly-saved login token —
      // no setItem veto can survive a storage-level rollback. IndexedDB
      // transactions ARE durable across power cuts, so the guard now also
      // mirrors every tokened jellyfin_credentials write into IDB
      // (jellyfin_shell/kv, key credsBackup) and restoreCredsVault() (the
      // pre-rewrite boot path) writes the token back when localStorage
      // lost it. Tokenless writes sync the vault tokenless ONLY with a
      // legitimate cause (observed POST /Sessions/Logout, or a recent
      // 401/403 validate) so intentional sign-outs and revoked tokens are
      // never resurrected; causeless tokenless writes (rollback-recreated
      // server entries) leave the vault alone. Mirroring is skipped
      // entirely when enableAutoLogin === "false" (user opted out of
      // persistent login — the shell must not out-persist that choice).
      // Token values never appear in trail/diag — presence + counters only
      // (vm = mirrors, vinv = tokenless invalidations on G).
      // Kill switch: localStorage["jellyfin.shell.credsGuardDisabled"]="1".
      // Diag: window.__shellCredsGuard={st,strips,vetoes,vm,vinv,lastVal,lo,boot}.
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.credsGuardDisabled")==="1"){window.__shellCredsGuard={st:"off"};return;}',
      '    var CK="jellyfin_credentials",TRK="jellyfin.shell.credsTrail";',
      '    var G={st:"on",strips:0,vetoes:0,vm:0,vinv:0,lastVal:null,lo:0,boot:null};window.__shellCredsGuard=G;',
      "    function rd(){try{var c=localStorage.getItem(CK);if(c==null)return{p:0,n:0,t:0};var j=JSON.parse(c);var sv=(j&&j.Servers)||[];var t=0;for(var i=0;i<sv.length;i++)if(sv[i]&&sv[i].AccessToken)t++;return{p:1,n:sv.length,t:t};}catch(_){return{p:-1,n:0,t:0};}}",
      '    function trail(ev){try{var r;try{r=JSON.parse(localStorage.getItem(TRK)||"[]");}catch(_){r=null;}if(!r||!r.push)r=[];r.push(ev);while(r.length>8)r.shift();localStorage.setItem(TRK,JSON.stringify(r));}catch(_){}}',
      "    function tokCnt(s){try{var j=JSON.parse(s);var sv=(j&&j.Servers)||[];var t=0;for(var i=0;i<sv.length;i++)if(sv[i]&&sv[i].AccessToken)t++;return t;}catch(_){return -1;}}",
      '    function idbPut(val){try{var rq=indexedDB.open("jellyfin_shell",1);rq.onupgradeneeded=function(){try{rq.result.createObjectStore("kv");}catch(_){}};rq.onsuccess=function(){try{var db=rq.result,tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(val,"credsBackup");tx.oncomplete=tx.onabort=tx.onerror=function(){try{db.close();}catch(_){}};}catch(_){}};rq.onerror=function(){};}catch(_){}}',
      "    function loCause(){if(G.lo&&Date.now()-G.lo<120000)return true;var v=G.lastVal;return !!(v&&Date.now()-v.ts<=60000&&(v.s===401||v.s===403));}",
      '    function vault(v){try{if(localStorage.getItem("enableAutoLogin")==="false")return;var t=tokCnt(v);if(t>0){G.vm++;idbPut({v:String(v),ts:Date.now(),t:t});}else if(t===0&&loCause()){G.vinv++;idbPut({v:String(v),ts:Date.now(),t:0});}}catch(_){}}',
      "    var b=rd(),ln=-1;try{ln=localStorage.length;}catch(_){}",
      '    G.boot={ts:Date.now(),p:b.p,n:b.n,t:b.t,ls:ln};trail({e:"boot",ts:G.boot.ts,p:b.p,n:b.n,t:b.t,ls:ln});',
      // boot-time mirror: converge the vault on a token that was written
      // before the vault existed (e.g. a login on a pre-JEL-134 build).
      "    try{if(b.t>0)vault(localStorage.getItem(CK));}catch(_){}",
      '    function isVal(u){return /\\/System\\/Info(\\?|$)/.test(String(u||""));}',
      '    function isLo(u){return /\\/Sessions\\/Logout(\\?|$)/.test(String(u||""));}',
      "    function mark(u,s){try{if(isVal(u))G.lastVal={s:s|0,ts:Date.now()};}catch(_){}}",
      '    try{var gF=window.fetch;window.fetch=function(i){var u=typeof i==="string"?i:(i&&i.url)||"";if(isLo(u))G.lo=Date.now();var p=gF.apply(this,arguments);if(isVal(u)&&p&&p.then)p.then(function(r){mark(u,r&&r.status);},function(){mark(u,0);});return p;};}catch(_){}',
      '    try{var gO=XMLHttpRequest.prototype.open,gS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__shellCgU=String(u||"");return gO.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var x=this,u=x.__shellCgU||"";if(isLo(u))G.lo=Date.now();if(isVal(u)){try{x.addEventListener("loadend",function(){mark(u,x.status);});}catch(_){}}return gS.apply(this,arguments);};}catch(_){}',
      "    function merge(os,ns){try{if(os==null||ns==null)return null;var o=JSON.parse(os),n=JSON.parse(ns);var ov=(o&&o.Servers)||[],nv=(n&&n.Servers)||[];if(!ov.length||!nv.length)return null;var m={},i;for(i=0;i<ov.length;i++)if(ov[i]&&ov[i].Id&&ov[i].AccessToken)m[ov[i].Id]={t:ov[i].AccessToken,u:ov[i].UserId};var hit=0;for(i=0;i<nv.length;i++){var s=nv[i];if(s&&s.Id&&!s.AccessToken&&m[s.Id]){hit++;s.AccessToken=m[s.Id].t;if(!s.UserId&&m[s.Id].u)s.UserId=m[s.Id].u;}}return hit?JSON.stringify(n):null;}catch(_){return null;}}",
      "    function vetoOk(){if(G.lo&&Date.now()-G.lo<120000)return false;var v=G.lastVal;if(!v)return false;if(Date.now()-v.ts>60000)return false;var s=v.s;if(s===401||s===403)return false;return s===0||s>=500;}",
      '    try{var SP=(window.Storage&&Storage.prototype&&Storage.prototype.setItem)?Storage.prototype:null;var tgt=SP||window.localStorage;var oSet=tgt.setItem;tgt.setItem=function(k,v){if(k===CK&&(!SP||this===window.localStorage)){try{var mg=merge(localStorage.getItem(CK),v);if(mg!=null){G.strips++;if(vetoOk()){G.vetoes++;trail({e:"veto",ts:Date.now(),s:G.lastVal.s});vault(mg);return oSet.call(this,k,mg);}trail({e:"strip",ts:Date.now(),s:G.lastVal?G.lastVal.s:-1,lo:G.lo?1:0});}vault(v);}catch(_){}}return oSet.apply(this,arguments);};}catch(_){}',
      "  })();}catch(_){}",
      // JEL-1580: post-login Home leaves activeElement on <body> on
      // Tizen — focusManager.nav() searches geometrically beyond the
      // body rect so D-pad nav from <body> matches nothing. Seed
      // localStorage.layout="tv" in case appSettings has a stale
      // "desktop" from a prior session, then install a capture-phase
      // keydown that focuses the first visible focusable on the
      // active .page when activeElement is <body>. Codes 37–40 =
      // host arrow keys, 29460–29463 = Tizen TV remote D-pad.
      //
      // v58 (JEL-1580 retry): v57 listener bound but rescue counter
      // stayed 0 in QA. Root cause: scope was only the active .page;
      // Jellyfin web's topnav (.skinHeader) lives OUTSIDE .page so
      // when QC redirect lands on Home with rails still loading
      // (data:0 cards:0) the .page has zero focusables and fst()
      // returns null. v58 widens the scope chain to
      //   opened dialog → active .page → .skinHeader → document
      // and adds two diagnostic counters so QA can pixel-read state:
      //   __shellBodyFocusRescueBound    — set once listener attached
      //   __shellBodyFocusRescueAttempts — incremented BEFORE search
      //   __shellBodyFocusRescues        — incremented on success
      // Both surfaced in HUD row "RS:a/s b=N".
      //
      // v59 (JEL-1580 retry-2): keypress-only rescue requires the
      // user to first press D-pad while focus is stuck on BODY. The
      // bug is that focus NEVER moves off BODY post-login — D-pad
      // arrows hit focusManager.nav() which geometrically searches
      // BEYOND the body rect (entire viewport) and returns null. So
      // first keypress on Home is a no-op, no focus ring appears,
      // user is stuck. v59 adds a PROACTIVE auto-focuser that polls
      // every 600ms with a 24-tick budget (~14s per page). When
      // activeElement is BODY and a focusable target is found via
      // findT(), it auto-focuses without waiting for keypress. Budget
      // resets on hashchange/popstate and on transitions back to
      // BODY focus (modal close, route swap). Guard: only runs once
      // jellyfin_credentials are stored to avoid popping the Samsung
      // keyboard on the user-picker / login form. Diagnostics:
      //   __shellAutoFocusAttempts / __shellAutoFocusSuccesses
      //   __shellLastScopeHit (index into scopes() that returned a
      //     target, -1 if none) / __shellLastScopeN (total scopes)
      // HUD row "AF:a/s sc=h/N" added alongside the v58 RS row.
      // JEL-623: the 600ms proactive poll now arms via
      // __shellPaintGate.onPaint (first view painted) instead of at seed
      // time — during the bundle blackout there is nothing to focus and
      // on warm boots the poll was burning its 24-tick budget against
      // the splash screen. The keydown rescue listener and the
      // hashchange/popstate budget bumps stay armed from t0 (passive).
      '  try{localStorage.setItem("layout","tv");}catch(_){}',
      '  try{(function(){var K={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Up:1,Down:1,Left:1,Right:1,Tab:1},C={9:1,37:1,38:1,39:1,40:1,29460:1,29461:1,29462:1,29463:1},S=\'a[href]:not([tabindex="-1"]),button:not(:disabled):not([tabindex="-1"]),input:not([type=range]):not([type=file]):not([tabindex="-1"]):not(:disabled),select:not([tabindex="-1"]):not(:disabled),textarea:not([tabindex="-1"]):not(:disabled),.focusable:not([tabindex="-1"])\';function vis(n){if(!n)return false;if(n.offsetParent===null&&n.tagName!=="BODY")return false;var r=n.getBoundingClientRect&&n.getBoundingClientRect();return !!(r&&r.width>0&&r.height>0);}function fst(s){if(!s||!s.querySelectorAll)return null;try{var n=s.querySelectorAll(S);for(var i=0;i<n.length;i++)if(vis(n[i]))return n[i];}catch(_){}return null;}function scopes(){var out=[];try{var d=document.querySelectorAll(".dialogContainer .dialog.opened");if(d.length)out.push(d[d.length-1]);}catch(_){}try{var p=document.querySelectorAll(".page:not(.hide)");for(var i=p.length-1;i>=0;i--)if(p[i]&&p[i].offsetParent!==null)out.push(p[i]);}catch(_){}try{var hsel=[".skinHeader",".headerTop",".mainAnimatedPages",".pageContainer","#reactRoot","#appLayer"];for(var hi=0;hi<hsel.length;hi++){var h=document.querySelector(hsel[hi]);if(h)out.push(h);}}catch(_){}out.push(document.body);return out;}function findT(){try{var st=document.getElementById("__shellST");if(st){var r=st.getBoundingClientRect&&st.getBoundingClientRect();if(r&&r.width>0&&r.height>0){window.__shellLastScopeHit=99;return st;}}}catch(_){}var sc=scopes();window.__shellLastScopeN=sc.length;for(var i=0;i<sc.length;i++){var t=fst(sc[i]);if(t){window.__shellLastScopeHit=i;return t;}}window.__shellLastScopeHit=-1;return null;}function isBodyF(){var a=document.activeElement;return !a||a===document.body||a.tagName==="HTML";}function isAuthed(){if(window.__shellAFForceAuth===1)return true;try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return false;var p=JSON.parse(c);return !!(p&&p.Servers&&p.Servers.length&&p.Servers[0].AccessToken);}catch(_){return false;}}window.addEventListener("keydown",function(e){if(!e||!(K[e.key]||C[e.keyCode]||C[e.which]))return;if(!isBodyF())return;window.__shellBodyFocusRescueAttempts=(window.__shellBodyFocusRescueAttempts||0)+1;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellBodyFocusRescues=(window.__shellBodyFocusRescues||0)+1;e.preventDefault();e.stopPropagation();}}}catch(_){}},true);window.__shellBodyFocusRescueBound=1;window.__shellAutoFocusAttempts=0;window.__shellAutoFocusSuccesses=0;window.__shellAutoFocusBudget=24;function bumpAF(){window.__shellAutoFocusBudget=24;}try{window.addEventListener("hashchange",bumpAF,false);}catch(_){}try{window.addEventListener("popstate",bumpAF,false);}catch(_){}var lastBody=true;function __afTick(){var nowBody=isBodyF();if(nowBody&&!lastBody)bumpAF();lastBody=nowBody;try{var st=document.getElementById("__shellST");if(st){if(document.activeElement!==st){window.__shellAutoFocusAttempts++;try{st.focus();}catch(_){}if(document.activeElement===st){window.__shellAutoFocusSuccesses++;window.__shellLastScopeHit=99;}}return;}}catch(_){}if(!nowBody)return;if((window.__shellAutoFocusBudget||0)<=0)return;if(!isAuthed())return;window.__shellAutoFocusAttempts++;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellAutoFocusSuccesses++;window.__shellAutoFocusBudget=0;return;}}}catch(_){}window.__shellAutoFocusBudget--;}function __armAF(){try{setInterval(__afTick,600);}catch(_){}}var pg=window.__shellPaintGate;if(pg&&pg.onPaint){pg.onPaint(__armAF);}else{__armAF();}})();}catch(_){}',
      // JEL-138: default the login "Remember Me" checkbox to CHECKED.
      // Field report + browser-verified root cause (results-JEL-138.md):
      // jellyfin-web's `enableAutoLogin` localStorage flag is sticky — one
      // login with the box unchecked flips it to "false", and every later
      // login form then renders the box unchecked. OSK Enter submits from
      // the password field WITHOUT the user ever passing the (visible-only-
      // on-D-pad) checkbox, so each Enter-login silently reuses the stale
      // "off" state: the token is written then discarded at the next launch.
      // Board decision (JEL-138 interaction c0b35a10 = "default_checked"):
      // make the box start checked each time the login screen appears, while
      // an explicit uncheck for that login still works and is honored.
      //
      // We DO NOT mutate the stored enableAutoLogin flag — only the checkbox
      // DOM state. jellyfin-web reads chkRememberLogin.checked at SUBMIT and
      // writes the flag itself, so the user's actual choice (as submitted)
      // still wins, and restoreCredsVault()'s `enableAutoLogin === "false"`
      // opt-out gate keeps honoring a genuine opt-out (it reads the stored
      // flag, which we leave alone until the user submits a checked login).
      // jellyfin-web applies the stored-false state to the checkbox AFTER
      // creating the element, so a one-shot flip loses the race; we re-assert
      // checked on a poll until a real `change` event (user toggle — emby-
      // checkbox programmatic sets don't fire change) reveals a deliberate
      // uncheck, then we back off for that element. Per-element WeakSets, so
      // a fresh login form (new document) re-defaults checked = no carryover.
      // Kill switch: localStorage["jellyfin.shell.rememberMeDefaultDisabled"]="1".
      // Diag: window.__shellRememberMeChecks (count of corrective flips).
      // JEL-623: the 300ms nudge poll arms via __shellPaintGate.onPaint
      // — the paint selector includes .manualLoginForm, so the poll
      // starts within ~500ms of the login form appearing instead of
      // ticking through the bundle blackout with no form to nudge.
      '  try{(function(){if(localStorage.getItem("jellyfin.shell.rememberMeDefaultDisabled")==="1")return;window.__shellRememberMeChecks=0;var bound=new WeakSet(),userOff=new WeakSet();function nudge(){try{var c=document.querySelector(".manualLoginForm .chkRememberLogin")||document.querySelector(".chkRememberLogin");if(!c)return;if(!bound.has(c)){bound.add(c);c.addEventListener("change",function(){if(!c.checked){userOff.add(c);}else{userOff["delete"](c);}},false);}if(userOff.has(c))return;if(!c.checked){c.checked=true;window.__shellRememberMeChecks++;}}catch(_){}}function __armRM(){nudge();try{setInterval(nudge,300);}catch(_){}}var pg=window.__shellPaintGate;if(pg&&pg.onPaint){pg.onPaint(__armRM);}else{__armRM();}})();}catch(_){}',
      // JEL-238 (defense-in-depth for JEL-237): media-bar YouTube-iframe crash
      // guard, baked natively into the shell so it ships in the signed .wgt and
      // survives any JS-Injector config wipe/re-import. The home media-bar
      // slideshow spawns multiple concurrent YouTube /embed/ trailer iframes as
      // it rotates; on Tizen 6.5 (Chromium 85, e.g. QN85QN90BAFXZA) each decodes
      // video and 2-3 concurrent hardware decoders exhaust native media/GPU
      // memory, crashing the whole app (running->false) ~20-40s after Home
      // loads. JS heap stays ~18MB the whole time, so it is a NATIVE crash,
      // invisible to ordinary JS logging. New to 6.5: on Tizen 5.0 (M63) these
      // iframes returned YouTube error 153 (file:// no Referer) and never
      // actually decoded, so the old TV never crashed. JEL-484 update: capping to
      // ONE was not enough. On-device beacon (QN85QN90B @ Tizen 6.5) caught the
      // process dying at the EXACT millisecond the media-bar's single /embed/
      // iframe was inserted (process death timestamp == first-iframe timestamp,
      // JS heap flat ~14MB, no JS error) — intermittently, even one YouTube embed
      // player initializing its native media pipeline crashes the WebView. And
      // the trailer never actually plays on the TV anyway (file:// origin / err
      // 153), so it is pure crash-risk with zero user benefit. Fix: on Tizen
      // only, cap youtube/embed iframes to ZERO — prevent the src from ever
      // loading (intercept the prototype src setter + setAttribute, blanking
      // youtube srcs to about:blank) AND sweep any node out via a fast
      // MutationObserver (fires before the player media pipeline can spin up).
      // No-op on every non-Tizen client. Content-pattern based (iframe src
      // substrings), NOT plugin-name coupled, so it stays plugin-agnostic
      // (plugin-agnostic-shell.test.cjs). The config knob is named for what it
      // caps (youtube iframes), not for the plugin that spawns them, so no plugin
      // name ships in the .wgt.
      // Kill switch: localStorage["jellyfin.shell.ytIframeCapDisabled"]="1".
      // Diag: window.__shellYtCaps (count of youtube iframes removed).
      // JEL-623: the sweep (MutationObserver + 400ms interval) arms via
      // __shellPaintGate.onApi (webpack entry completed) instead of at
      // seed time; plugins cannot build media-bar DOM before app init,
      // so crash coverage is unchanged while the whole-tree observer no
      // longer fires on every splash/boot DOM mutation. The passive
      // iframe src setter/setAttribute intercepts and the one-shot
      // cap() stay armed from t0 (essential guard).
      '  try{(function(){if(localStorage.getItem("jellyfin.shell.ytIframeCapDisabled")==="1")return;if(!/Tizen/.test(navigator.userAgent||""))return;window.__shellYtCaps=0;function isYt(s){s=s||"";return s.indexOf("youtube")>-1||s.indexOf("youtu.be")>-1||s.indexOf("/embed/")>-1;}try{var P=HTMLIFrameElement.prototype,D=Object.getOwnPropertyDescriptor(P,"src");if(D&&D.set){Object.defineProperty(P,"src",{configurable:true,enumerable:D.enumerable,get:function(){return D.get.call(this);},set:function(v){if(isYt(""+v)){try{D.set.call(this,"about:blank");}catch(_){}return;}D.set.call(this,v);}});}var SA=P.setAttribute;P.setAttribute=function(n,v){if(n&&(""+n).toLowerCase()==="src"&&isYt(""+v)){try{return SA.call(this,"src","about:blank");}catch(_){return;}}return SA.apply(this,arguments);};}catch(_){}function cap(){var a=document.getElementsByTagName("iframe");for(var i=a.length-1;i>=0;i--){var s=a[i].getAttribute("src")||a[i].src||"";if(isYt(s)){try{a[i].parentNode.removeChild(a[i]);window.__shellYtCaps++;}catch(_){}}}}cap();function __armCap(){cap();try{var mo=new MutationObserver(cap);mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});}catch(_){}try{setInterval(cap,400);}catch(_){}}var pg=window.__shellPaintGate;if(pg&&pg.onApi){pg.onApi(__armCap);}else{__armCap();}})();}catch(_){}',
      // JELA-725 (jp725): satisfy the YouTube IFrame API locally instead of
      // fetching it, so boot stops touching the www.youtube.com origin.
      //
      // The media bar's `loadYouTubeAPI()` is awaited UNCONDITIONALLY in its
      // init chain, ahead of slidesInit():
      //   initJellyfinData(async()=>{ await initLocalization();
      //                               await loadYouTubeAPI(); slidesInit(); })
      // and its body opens with
      //   if(window.YT&&window.YT.Player){resolve(window.YT);return}
      // before it ever creates the <script src="…/iframe_api"> tag. So merely
      // having window.YT.Player defined by seed time short-circuits it: the
      // promise resolves synchronously, the tag is never inserted, and a whole
      // origin (DNS + TCP + TLS + 2 requests / 13 KiB, measured at 3,657 ms in
      // the JELA-720 census) leaves the pre-firstCard window. This is strictly
      // FASTER than the ticket's suggested "defer the fetch": deferring would
      // push slidesInit() later, while resolving instantly pulls it earlier.
      // Nothing is merely postponed — the request is never made at all.
      //
      // Why a no-op Player cannot regress trailers ON TIZEN: YouTube trailer
      // playback is already impossible on this fleet, two independent ways.
      // (1) The media bar only derives a videoId under `jpQmNative()`, an
      //     iframe contentWindow.queueMicrotask probe that is native only on
      //     Chrome >= 71 — false on Tizen 5.0 / M63 — so videoId stays null,
      //     `new YT.Player()` is never constructed, and getSkipSegments() is
      //     never reached. (2) JEL-238/484 above blanks every youtube iframe
      //     src to about:blank on Tizen, so even the real API could not load a
      //     player. The stub is therefore only ever consumed by the awaited
      //     resolve, never by a playback path.
      // That reasoning holds exactly while the JEL-238 cap is armed, so this
      // block stands down whenever the cap is disabled — if someone turns the
      // cap off to debug trailers, they get the real API back along with it.
      // Content-pattern based, no plugin name (plugin-agnostic-shell.test.cjs).
      // JELA-827: fleet-ON (opt-OUT). This shipped opt-in as `!== "1"`, but
      // the "1" is written by the JELA-725 JSI channel entry, which only runs
      // AFTER the lite→SPA handoff (JELA-802) — so on every cold boot (fresh
      // install, LS wipe, quota eviction) the key was absent, the stub never
      // installed, and the real YouTube iframe API leaked through for exactly
      // the boot the JEL-238 cap exists to protect. Read for the kill switch
      // instead: an absent key now means ON.
      // Kill switch: localStorage["jellyfin.shell.ytApiStubDisabled"]="1"
      // (this is the DURABLE per-TV kill — the JELA-725 seeder honours it and
      // would otherwise re-write ytApiStub back to "1"). The JEL-238 cap kill
      // "jellyfin.shell.ytIframeCapDisabled"="1" also stands this block down.
      // Diag: window.__shellYtApiStub (1 when the stub was installed).
      '  try{(function(){if(localStorage.getItem("jellyfin.shell.ytApiStub")==="0")return;if(localStorage.getItem("jellyfin.shell.ytApiStubDisabled")==="1")return;if(localStorage.getItem("jellyfin.shell.ytIframeCapDisabled")==="1")return;if(!/Tizen/.test(navigator.userAgent||""))return;if(window.YT&&window.YT.Player)return;function P(){}var n=["playVideo","pauseVideo","stopVideo","seekTo","mute","unMute","setVolume","destroy","loadVideoById","cueVideoById","addEventListener","removeEventListener","setPlaybackQuality"];for(var i=0;i<n.length;i++){P.prototype[n[i]]=function(){};}P.prototype.getPlayerState=function(){return -1;};P.prototype.getCurrentTime=function(){return 0;};P.prototype.getVolume=function(){return 0;};P.prototype.isMuted=function(){return true;};window.YT={loaded:1,Player:P,PlayerState:{UNSTARTED:-1,ENDED:0,PLAYING:1,PAUSED:2,BUFFERING:3,CUED:5}};window.__shellYtApiStub=1;var f=window.onYouTubeIframeAPIReady;if(typeof f==="function"){try{f();}catch(_){}}})();}catch(_){}',
      // JELA-686 (JELA-679/P2): persist the bitrate detection across boots.
      //
      // jellyfin-apiclient's detectBitrate DOES have a cache, with a sane
      // 1-hour TTL (verified against the shipped bundle, not the docs):
      //   detectBitrate(e){if(!e&&this.lastDetectedBitrate&&(new Date).getTime()
      //     -(this.lastDetectedBitrateTime||0)<=36e5)return Promise.resolve(
      //     this.lastDetectedBitrate);...}
      // but lastDetectedBitrate/lastDetectedBitrateTime are plain instance
      // fields on the ApiClient. In a browser tab that is fine. On a TV every
      // app launch is a fresh page, so the instance is rebuilt from nothing and
      // the 1-hour cache can never once be hit — the ladder re-runs in full,
      // every boot, forever: 512 KiB + 1 MiB + 4 MiB = 5.77 MB of throwaway
      // payload, landing at t~13.9-18.3 s i.e. straddling firstCard.
      //
      // The ladder also punishes a GOOD link. It escalates on threshold:
      //   R(e,[{bytes:5e5,threshold:5e5},{bytes:1e6,threshold:2e7},
      //        {bytes:3e6,threshold:5e7}],0)
      // so >20 Mbit/s buys the 1 MB rung and >50 Mbit/s the 3 MB rung. The
      // faster the panel's connection, the more it downloads.
      //
      // Fix: do not patch the vendor's logic — make its OWN cache work by
      // giving it a store that survives the page. We wrap detectBitrate and
      // serve from localStorage on the unforced path.
      //
      // Why a wrap and not a one-shot field assignment at onApi (which is what
      // the ticket originally proposed): it would be silently wiped. The
      // scheduler that fires the boot probe is
      //   function g(e){p(e),e.accessToken()&&!1!==e.enableAutomaticBitrateDetection
      //                 &&(e.detectTimeout=setTimeout(y.bind(e),6e3))}
      //   function y(){this.detectTimeout=null,this.accessToken()&&this.detectBitrate()}
      // and its only caller is onNetworkChange(), whose FIRST act is
      //   this.lastDetectedBitrate=0,this.lastDetectedBitrateTime=0
      // Pre-seeded fields are therefore zeroed by the very call that schedules
      // the probe 6 s later. Reading the store at call time is immune to that.
      //
      // Keyed on serverId()+serverAddress(), so pointing the TV at a different
      // server (or the same server on a different address) misses and
      // re-detects. Deliberately NOT invalidated on onNetworkChange: the
      // serverAddress setter calls it on EVERY set, changed or not
      //   (var t=e!==this._serverAddress;this._serverAddress=e,this.onNetworkChange(),...)
      // so invalidating there would wipe the store on every boot and buy
      // nothing. A same-address link change is covered by the TTL instead.
      //
      // Playback IS served from this store — CORRECTION, the opposite was
      // claimed here and in PR #157 until JELA-684's follow-up re-checked it
      // against the bundle the 10.11.11 server actually serves (main bundle,
      // apiclient bundle, all 927 lazy chunks and every injected plugin
      // script). detectBitrate has exactly two web-client call sites:
      //   - playbackManager's pre-play max-bitrate step (play() chain, for
      //     Video/Audio on a non-local item with automatic bitrate detection
      //     enabled): detectBitrate() — UNFORCED, so it reads this store;
      //   - the quality dialog (setMaxStreamingBitrate):
      //     detectBitrate(!0) — forced, real detection, bypasses the store;
      // plus the apiclient's own unforced boot probe (y() above).
      //
      // So with the flag on, a Direct Play / transcode decision can run on a
      // persisted measurement up to TTL old. That is DELIBERATE — decided on
      // the record, not by accident: vendor-stock already fed playback a
      // boot-time value (the unforced play call hit the vendor's 1 h
      // instance cache whenever play followed the boot probe within the same
      // page), the store is keyed to the server identity, a panel's link is
      // far more stable than a browser tab's, and the quality dialog still
      // forces a fresh measurement as the user-facing remedy. Do NOT "fix"
      // playback by forcing it: that would run the full download ladder at
      // every play start — a cost even stock never paid.
      //
      // Composes with JELA-684 (deferBitrateTest), which holds the same probe
      // until after paint: with both on, boot 1 detects post-paint and
      // persists, boots 2..N short-circuit to zero requests. 684 wraps an
      // instance property (enableAutomaticBitrateDetection), this wraps a
      // prototype method, so neither sees the other.
      //
      // TTL defaults to 24 h, not the vendor's 1 h: a panel's link is far more
      // stable than a browser tab's, and a stale value costs at most a
      // suboptimal bitrate ceiling until the TTL lapses or the user opens
      // the quality dialog, which forces a fresh detection (playback does
      // NOT re-measure — see the call-site inventory above).
      // Tunable via "jellyfin.shell.bitrateTtlMs" so the fleet can be retuned
      // without a shell release.
      //
      // Flag-dark: opt in with localStorage["jellyfin.shell.bitrateCache"]="1".
      // Diag: window.__shellBitrate = {on,armed,hits,miss,saves,bps,age}.
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.bitrateCache")!=="1")return;',
      '    var K="jellyfin.shell.bitrate";',
      "    var G=window.__shellBitrate={on:1,armed:0,hits:0,miss:0,saves:0,bps:0,age:-1};",
      '    function ttl(){var v;try{v=parseInt(localStorage.getItem("jellyfin.shell.bitrateTtlMs")||"",10);}catch(_){}return v>0?v:864e5;}',
      '    function idOf(a){var s="",u="";try{s=String(a.serverId()||"");}catch(_){}try{u=String(a.serverAddress()||"");}catch(_){}return s+"|"+u;}',
      "    function rd(a){",
      '      try{var j=JSON.parse(localStorage.getItem(K)||"null");',
      '      if(!j||typeof j.bps!=="number"||!(j.bps>0)||j.id!==idOf(a))return 0;',
      "      var g=(new Date).getTime()-(j.t||0);",
      "      if(g<0||g>ttl())return 0;",
      "      G.age=g;return j.bps;}catch(_){return 0;}",
      "    }",
      "    function wr(a,v){",
      "      try{if(!(v>0))return;",
      "      localStorage.setItem(K,JSON.stringify({bps:v,t:(new Date).getTime(),id:idOf(a)}));",
      "      G.saves++;}catch(_){}",
      "    }",
      "    function arm(){",
      "      try{var A=window.ApiClient;if(!A)return;",
      "      var P=null;try{P=Object.getPrototypeOf(A);}catch(_){}",
      '      if(!P||typeof P.detectBitrate!=="function")P=A;',
      '      if(typeof P.detectBitrate!=="function"||P.__shellBrWrap)return;',
      "      P.__shellBrWrap=1;",
      "      var orig=P.detectBitrate;",
      "      P.detectBitrate=function(f){",
      "        var t=this;",
      "        if(!f){var c=rd(t);",
      "          if(c){G.hits++;G.bps=c;",
      "            try{t.lastDetectedBitrate=c;t.lastDetectedBitrateTime=(new Date).getTime();}catch(_){}",
      "            return Promise.resolve(c);}",
      "          G.miss++;}",
      "        return orig.apply(t,arguments).then(function(v){wr(t,v);return v;});",
      "      };",
      "      G.armed=1;}catch(_){}",
      "    }",
      "    var pg=window.__shellPaintGate;",
      "    if(pg&&pg.onApi){pg.onApi(arm);}else{arm();}",
      "  })();}catch(_){}",
      // ---- JELA-761: idle-home UserDataChanged gate ------------------------
      //
      // A `UserDataChanged` notification on the jellyfin-web WebSocket makes
      // jellyfin-web rebuild the ENTIRE home tab: the hometab chunk
      // stylesheet, 5 `/Users/{u}/Items` row queries and 6
      // `/HomeScreen/Section/*` calls (BecauseYouWatched three times, one per
      // seed) — ~13 requests plus ~13 CORS preflights and ~230 KB — whether
      // or not any affected item is on screen. Measured per push in JELA-759.
      // The socket itself is free (2,484 B in 240 s); it is the REACTION to
      // one message type that costs.
      //
      // The cost is PER EVENT, not per hour. JELA-759 saw a ~90 s cadence and
      // read it as a steady state; JELA-763 traced that cadence to a sibling
      // harness replaying play/stop on the same account, and showed a truly
      // idle server emits ZERO of these. So do not size this against a timer:
      // every user-data write from ANY device on the account (an episode
      // finished in a phone app, a playback stop on another TV) makes every
      // idle TV rebuild its whole home. Real fleets have real playback stops.
      //
      // The frame carries Data.UserDataList[].ItemId. If none of those ids
      // is rendered anywhere in the document and none appears in the current
      // route (hash/search), nothing the user can see depends on the
      // message, so we swallow it before jellyfin-web's socket handler runs.
      // That test is a strict SUPERSET of "is it on the home" — it is
      // route-agnostic and cannot hide an update for a visible item. Ids are
      // compared dash-stripped and lower-cased because the socket and the
      // DOM do not agree on GUID formatting.
      //
      // Everything else fails OPEN: a non-string frame, unparseable JSON, a
      // different MessageType, an empty/oddly-shaped UserDataList, a
      // querySelectorAll that throws, or a <video> in the document (playback
      // consumes progress pushes for items that need not be in the DOM) all
      // deliver unchanged.
      //
      // Frames that DO hit are coalesced: the first delivers, and within the
      // coalesce window only a frame carrying an id not already delivered
      // re-fires — a rebuild refetches every row anyway, so a burst should
      // cost one refresh, not one each. While the page is hidden the newest
      // surviving frame is held and delivered on visibilitychange.
      //
      // Hooking the prototype accessor rather than the constructor is
      // deliberate: jellyfin-apiclient assigns `socket.onmessage = fn` on a
      // socket it constructs itself, and a wrapped constructor would have to
      // fake native `new` semantics on M63. addEventListener/
      // removeEventListener are wrapped too so a vendor switch of transport
      // cannot silently un-gate this.
      //
      // JELA-827: fleet-ON (opt-OUT). This shipped as `!== "1"` -> bail, but
      // the "1" is written by the jp807seed JSI channel entry, which only
      // runs AFTER the lite→SPA handoff (JELA-802), so on a cold boot the
      // key is absent and every UserDataChanged push landed unswallowed —
      // the JELA-807 prize is 16.00 reqs / 59,680 B per swallowed push, and
      // a fresh install paid all of it. Read for the kill switch instead:
      // absent key means ON.
      // Per-TV kill: localStorage["jellyfin.shell.udcGate"]="0" (the jp807
      // seeder guards on !== "0", so a "0" survives the channel).
      // Tunable: "jellyfin.shell.udcCoalesceMs" (default 3000; 0 = no
      // coalescing, diff only).
      // Diag: window.__shellUdc =
      //   {on,seen,pass,dropNoHit,dropDup,held,ids,err}.
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.udcGate")==="0")return;',
      "    if(window.__shellUdc)return;",
      "    var P=window.WebSocket&&window.WebSocket.prototype;if(!P)return;",
      "    var G=window.__shellUdc={on:1,seen:0,pass:0,dropNoHit:0,dropDup:0,held:0,ids:0,err:0};",
      '    function cw(){var v;try{v=parseInt(localStorage.getItem("jellyfin.shell.udcCoalesceMs")||"",10);}catch(_){}return (v>=0&&v<=600000)?v:3000;}',
      "    var winAt=0,winIds={},pend=null;",
      "    function now(){return (new Date).getTime();}",
      '    function norm(s){return String(s).replace(/-/g,"").toLowerCase();}',
      // Payload ids, or null for "not a UserDataChanged frame we understand".
      "    function udcIds(ev){",
      "      var d=ev&&ev.data;",
      '      if(typeof d!=="string"||d.indexOf("UserDataChanged")===-1)return null;',
      "      var j;try{j=JSON.parse(d);}catch(_){return null;}",
      '      if(!j||j.MessageType!=="UserDataChanged")return null;',
      "      var L=j.Data&&j.Data.UserDataList;",
      "      if(!L||!L.length)return null;",
      "      var out=[];",
      "      for(var i=0;i<L.length;i++){",
      '        var id=L[i]&&L[i].ItemId;if(typeof id!=="string"||!id)continue;',
      "        out.push(norm(id));",
      "      }",
      "      return out.length?out:null;",
      "    }",
      // Every id the user could currently be looking at. null = fail open.
      "    function shown(){",
      "      var m={},n=0,i;",
      "      try{",
      '        var a=document.querySelectorAll("[data-id]");',
      '        for(i=0;i<a.length;i++){var v=a[i].getAttribute("data-id");if(v){m[norm(v)]=1;n++;}}',
      "      }catch(_){return null;}",
      "      try{",
      '        var h=String(location.hash||"")+"|"+String(location.search||"");',
      "        var r=/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}|[0-9a-fA-F]{32}/g,x;",
      "        while((x=r.exec(h)))m[norm(x[0])]=1;",
      "      }catch(_){}",
      "      G.ids=n;return m;",
      "    }",
      "    function decide(ev){",
      '      var L=udcIds(ev);if(!L)return "pass";',
      "      G.seen++;",
      '      try{if(document.getElementsByTagName("video").length){G.pass++;return "pass";}}catch(_){}',
      '      var m=shown();if(!m){G.pass++;return "pass";}',
      "      var hit=[],i;",
      "      for(i=0;i<L.length;i++){if(m[L[i]])hit.push(L[i]);}",
      '      if(!hit.length){G.dropNoHit++;return "drop";}',
      "      var t=now(),w=cw();",
      "      if(w>0&&winAt&&t-winAt<=w){",
      "        var fresh=0;",
      "        for(i=0;i<hit.length;i++){if(!winIds[hit[i]]){fresh=1;winIds[hit[i]]=1;}}",
      '        if(!fresh){G.dropDup++;return "drop";}',
      "      }else{winAt=t;winIds={};for(i=0;i<hit.length;i++)winIds[hit[i]]=1;}",
      '      try{if(document.visibilityState==="hidden"){G.held++;return "hold";}}catch(_){}',
      '      G.pass++;return "pass";',
      "    }",
      // One verdict per frame: a socket with BOTH an onmessage handler and a
      // message listener must not have the frame classified (and coalesced)
      // twice, or one of the two would silently lose it.
      "    function verdict(ev){",
      "      var v;try{v=ev.__shellUdcV;}catch(_){}",
      "      if(v)return v;",
      "      v=decide(ev);",
      "      try{ev.__shellUdcV=v;}catch(_){}",
      "      return v;",
      "    }",
      "    function route(ev,call){",
      "      var v;try{v=verdict(ev);}catch(e){G.err++;call();return;}",
      '      if(v==="drop")return;',
      '      if(v==="hold"){pend=call;return;}',
      "      call();",
      "    }",
      '    try{window.addEventListener("visibilitychange",function(){try{if(document.visibilityState==="hidden")return;var p=pend;pend=null;if(p){G.pass++;p();}}catch(_){}},false);}catch(_){}',
      '    var D=Object.getOwnPropertyDescriptor(P,"onmessage");',
      "    if(D&&D.set&&D.get){",
      '      Object.defineProperty(P,"onmessage",{configurable:true,enumerable:!!D.enumerable,',
      "        get:function(){var h;try{h=this.__shellUdcH;}catch(_){}return h===undefined?D.get.call(this):h;},",
      "        set:function(fn){",
      "          var self=this;try{this.__shellUdcH=fn;}catch(_){}",
      '          if(typeof fn!=="function"){D.set.call(this,fn);return;}',
      "          D.set.call(this,function(ev){var a=arguments;route(ev,function(){fn.apply(self,a);});});",
      "        }});",
      "    }else{G.err++;}",
      "    var AEL=P.addEventListener,REL=P.removeEventListener;",
      "    if(AEL){",
      "      P.addEventListener=function(type,fn,opt){",
      '        if(type==="message"&&typeof fn==="function"){',
      "          var w=fn.__shellUdcW;",
      "          if(!w){w=function(ev){var s=this,a=arguments;route(ev,function(){fn.apply(s,a);});};try{fn.__shellUdcW=w;}catch(_){}}",
      "          return AEL.call(this,type,w,opt);",
      "        }",
      "        return AEL.apply(this,arguments);",
      "      };",
      "    }",
      "    if(REL){",
      "      P.removeEventListener=function(type,fn,opt){",
      '        if(type==="message"&&fn&&fn.__shellUdcW)return REL.call(this,type,fn.__shellUdcW,opt);',
      "        return REL.apply(this,arguments);",
      "      };",
      "    }",
      "  })();}catch(_){}",
      // JELA-684 (JELA-679/P3): hold the playback bitrate probe until after
      // first paint.
      //
      // jellyfin-apiclient schedules a fire-and-forget bandwidth probe 6 s
      // after ANY setAuthenticationInfo()/onNetworkChange()/authenticate call:
      //   function g(e){p(e),e.accessToken()&&!1!==e.enableAutomaticBitrateDetection
      //                 &&(e.detectTimeout=setTimeout(y.bind(e),6e3))}
      //   function y(){this.detectTimeout=null,this.accessToken()&&this.detectBitrate()}
      // On a saved-server cold boot that lands at t~7.7 s — squarely inside the
      // pre-firstCard window (firstCard ~15 s on the virtual M63 target) — and
      // detectBitrate escalates 500 KB -> 1 MB -> 3 MB, which the server rounds
      // up to 512 KiB + 1 MiB + 4 MiB = 5.5 MiB of bulk transfer competing with
      // the home-screen query storm for the same link.
      //
      // (JELA-680's waterfall showed 6 requests / 8.6 MB and read that as the
      // escalation running twice. It does not: each probe is a CORS preflight
      // OPTIONS + the GET, and Chromium 63 records the preflight as its own
      // Resource Timing entry. One escalation, 3 GETs, 5.5 MiB actual.)
      //
      // Nothing on the home screen consumes the result. It exists to seed
      // apiClient.lastDetectedBitrate so that the first playback (minutes away)
      // skips the escalation, and playback re-detects on its own if the cache
      // is cold or stale. So this holds rather than kills: suppress until the
      // release gate opens, then re-arm the vendor's own timer so the cache is
      // still warm before anyone can press play.
      //
      // The hold is an accessor, not `=false`: the connection manager
      // re-assigns enableAutomaticBitrateDetection from its options on every
      // (re)auth and THEN calls the scheduler, so a plain write gets clobbered
      // in the window between onApi and login. Any already-scheduled
      // detectTimeout is cleared on install, and the guard re-runs every 500 ms
      // until release so a replaced window.ApiClient is covered too.
      //
      // JELA-737: first paint is the WRONG release gate. JELA-730 established
      // that firstCard is not when the home is done — the rows keep fetching
      // and rendering for seconds after it — and JELA-736 measured the ladder
      // landing at 7.4-8.5 s in 7/7 captures against settle times of 4.8-12.9 s,
      // i.e. squarely INSIDE the fill window, every time. On a warm boot the
      // ladder is 5,635 KiB of the 11.86 MiB total (46.4%) and renders nothing.
      // Worse, it measures a link it is itself saturating, so it biases the
      // chosen bitrate low. A constant post-paint delay cannot track settle;
      // the trigger has to be the home actually going quiet.
      //
      // So the default gate is now "settle", evaluated on a 500 ms tick:
      //   - `.card` AND `.card[data-id]` counts both unchanged for Q ms
      //     (the same counters rec.js derives `settle` from), with at least
      //     one real `.card[data-id]` on screen, AND
      //   - zero in-flight XHR/fetch and no request start/finish for Q ms
      //     (counted by wrapping XMLHttpRequest.prototype.send and
      //     window.fetch pass-through at seed time), AND
      //   - an authenticated ApiClient (otherwise we are on the login screen
      //     and there is nothing to defer yet — keep holding).
      // Ceiling: M ms after the first authenticated tick, release anyway with
      // why="ceiling", so a deferral can never become a never. Note the vendor
      // ALSO detects on the play path (playbackManager's pre-play
      // detectBitrate()), so even a suppressed ladder cannot break playback.
      //
      // JELA-823: fleet-ON (opt-OUT). The original opt-in gate was never armed
      // on a first boot — the JSI channel that seeds "1" runs only after the
      // lite→SPA handoff (JELA-802), so any cold boot with no prior "1" in LS
      // (fresh install, wipe, eviction) skipped the deferral and paid the full
      // 5.77 MB probe pre-paint. Read for the kill switch instead so a
      // key-absent boot defers. Kill switch: set "jellyfin.shell.deferBitrateTest"
      // to "0" to run the probe undeferred (old opt-in "1" still works too).
      // Settle-gate kill switch: localStorage["jellyfin.shell.deferBitrateTestGate"]="paint".
      // Post-release delay is tunable via "jellyfin.shell.deferBitrateTestMs"
      // (default 4000), the quiet window via "...QuietMs" (default 3000) and
      // the ceiling via "...MaxMs" (default 45000).
      // Diag: window.__shellBT = {on,gate,inst,cleared,sets,armed,fired,tHold,
      // tArm,why,polls,cards,cardsLoose,stable,tAuth,net,inflight,tBusy}.
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.deferBitrateTest")==="0")return;',
      "    var D=4000;",
      '    try{var dv=parseInt(localStorage.getItem("jellyfin.shell.deferBitrateTestMs")||"",10);if(dv>=0&&dv<=600000)D=dv;}catch(_){}',
      '    var G="settle";',
      '    try{if(localStorage.getItem("jellyfin.shell.deferBitrateTestGate")==="paint")G="paint";}catch(_){}',
      "    var Q=3000;",
      '    try{var qv=parseInt(localStorage.getItem("jellyfin.shell.deferBitrateTestQuietMs")||"",10);if(qv>=250&&qv<=120000)Q=qv;}catch(_){}',
      "    var M=45000;",
      '    try{var mv=parseInt(localStorage.getItem("jellyfin.shell.deferBitrateTestMaxMs")||"",10);if(mv>=1000&&mv<=600000)M=mv;}catch(_){}',
      '    var S=window.__shellBT={on:1,gate:G,inst:0,cleared:0,sets:0,armed:0,fired:0,tHold:0,tArm:0,why:"",polls:0,cards:0,cardsLoose:0,stable:0,tAuth:0,net:0,inflight:0,tBusy:0};',
      "    function cur(){try{return window.ApiClient||null;}catch(_){return null;}}",
      "    function hold(){",
      "      var a=cur();",
      "      if(!a||a.__shellBTHeld)return;",
      "      a.__shellBTHeld=1;S.inst++;",
      "      try{if(a.detectTimeout){clearTimeout(a.detectTimeout);a.detectTimeout=null;S.cleared++;}}catch(_){}",
      '      try{Object.defineProperty(a,"enableAutomaticBitrateDetection",{configurable:true,enumerable:true,get:function(){return false;},set:function(){S.sets++;}});}',
      "      catch(_){try{a.enableAutomaticBitrateDetection=false;}catch(__){}}",
      "      if(!S.tHold)S.tHold=Date.now();",
      "    }",
      "    var iv=null;",
      "    function release(w){",
      "      if(S.tArm)return;",
      "      if(iv){try{clearInterval(iv);}catch(_){}iv=null;}",
      '      S.tArm=Date.now();S.why=w||"paint";',
      "      var a=cur();if(!a)return;",
      "      try{delete a.enableAutomaticBitrateDetection;}catch(_){}",
      "      try{a.__shellBTHeld=0;a.enableAutomaticBitrateDetection=true;}catch(_){}",
      "      try{a.detectTimeout=setTimeout(function(){try{a.detectTimeout=null;if(a.accessToken&&a.accessToken()){S.fired=1;a.detectBitrate();}}catch(_){}},D);S.armed=1;}catch(_){}",
      "    }",
      "    function busy(){S.tBusy=Date.now();}",
      "    function net(){",
      "      try{var XP=window.XMLHttpRequest&&window.XMLHttpRequest.prototype;",
      "      if(XP&&XP.send&&!XP.__shellBTNet){XP.__shellBTNet=1;var os=XP.send;",
      "        XP.send=function(){var x=this,d=0;function fin(){if(d)return;d=1;S.inflight--;busy();}",
      "          S.inflight++;S.net++;busy();",
      '          try{x.addEventListener("loadend",fin,false);}catch(_){}',
      "          try{var pr=x.onreadystatechange;x.onreadystatechange=function(){try{if(x.readyState===4)fin();}catch(__){}if(pr)return pr.apply(this,arguments);};}catch(_){}",
      "          try{return os.apply(this,arguments);}catch(e){fin();throw e;}};}}catch(_){}",
      "      try{if(window.fetch&&!window.fetch.__shellBTNet){var of=window.fetch;",
      "        var nf=function(){var p;S.inflight++;S.net++;busy();",
      "          try{p=of.apply(this,arguments);}catch(e){S.inflight--;busy();throw e;}",
      "          try{p.then(function(){S.inflight--;busy();},function(){S.inflight--;busy();});}catch(_){S.inflight--;busy();}",
      "          return p;};",
      "        nf.__shellBTNet=1;window.fetch=nf;}}catch(_){}",
      "    }",
      "    var lc=-1,ld=-1,tS=0;",
      "    function poll(){",
      "      S.polls++;",
      "      var a=cur(),tok=0;",
      "      try{tok=!!(a&&a.accessToken&&a.accessToken());}catch(_){tok=0;}",
      "      if(tok&&!S.tAuth)S.tAuth=Date.now();",
      "      var n=Date.now(),c=null,cd=-1;",
      '      try{c=document.querySelectorAll(".card").length;cd=document.querySelectorAll(".card[data-id]").length;}catch(_){c=null;}',
      "      if(c===null)return;",
      "      S.cardsLoose=c;S.cards=cd;",
      "      if(c!==lc||cd!==ld){lc=c;ld=cd;tS=n;}",
      "      S.stable=tS?n-tS:0;",
      "      if(!S.tAuth)return;",
      '      if(n-S.tAuth>=M){release("ceiling");return;}',
      "      if(ld<=0||!tS)return;",
      "      if(n-tS<Q)return;",
      "      if(S.inflight>0)return;",
      "      if(n-S.tBusy<Q)return;",
      '      release("settle");',
      "    }",
      '    function tick(){hold();if(G==="settle")poll();}',
      "    function arm(){hold();try{iv=setInterval(tick,500);}catch(_){}}",
      "    var pg=window.__shellPaintGate;",
      '    if(G==="settle"){busy();net();if(pg&&pg.onApi){pg.onApi(arm);}else{arm();}}',
      "    else if(pg&&pg.onApi&&pg.onPaint){pg.onApi(arm);pg.onPaint(release);}",
      "    else{arm();setTimeout(release,20000);}",
      "  })();}catch(_){}",
      // JELA-707: paint-gated re-injector for the JellyfinEnhanced script
      // tag(s) that stripJeScriptsForDefer held out of the written markup
      // (URLs parked on window.__shellJeDefer — Window survives the
      // document.write handoff). Waits for __shellPaintGate.onPaint (which
      // always eventually fires: paint/timeout/giveup), then a tunable
      // settle delay ("jellyfin.shell.deferJeMs", default 3000 — firstCard
      // is already behind us at onPaint; the delay keeps JE's fan-out off
      // the row-fill window that follows it), then appends the original
      // <script src> tags. append-then-set-src is JE's own load shape, so
      // the JEL-407 src-setter interceptor routes the body through the
      // same fetch+transpile+cache pipeline as any dynamic plugin script.
      // async=false keeps multi-tag source order. "&amp;" is decoded
      // because the URLs were captured as raw attribute text, not DOM.
      // No-gate fallback injects at 20 s like the JELA-684 hold above.
      // Diag: window.__shellJeDefer {on,held,urls,rel,inj,tRel,tInj}.
      "  try{(function(){",
      "    var J=window.__shellJeDefer;",
      "    if(!J||!J.urls||!J.urls.length)return;",
      "    var D=3000;",
      '    try{var dv=parseInt(localStorage.getItem("jellyfin.shell.deferJeMs")||"",10);if(dv>=0&&dv<=600000)D=dv;}catch(_){}',
      "    function inj(){",
      "      if(J.rel)return;",
      "      J.rel=1;J.tInj=Date.now();",
      "      for(var i=0;i<J.urls.length;i++){",
      "        try{",
      '          var s=document.createElement("script");',
      "          s.async=false;",
      '          s.setAttribute("data-shell-je-deferred","1");',
      "          (document.head||document.documentElement).appendChild(s);",
      '          s.src=String(J.urls[i]).replace(/&amp;/g,"&");',
      "          J.inj++;",
      "        }catch(_){}",
      "      }",
      "    }",
      "    function rel(){if(J.tRel)return;J.tRel=Date.now();setTimeout(inj,D);}",
      "    var pg=window.__shellPaintGate;",
      "    if(pg&&pg.onPaint){pg.onPaint(rel);}else{setTimeout(inj,20000);}",
      "  })();}catch(_){}",
      // JEL-1580 v60: synthetic AF self-test harness. Gated by either
      // localStorage `jellyfin.shell.afSelfTest=1` or url ?shellSelfTest=focus.
      // Injects a stub focusable, forces BODY focus, sets
      // __shellAFForceAuth=1 to bypass the auth gate, then waits up to
      // 10s for the proactive auto-focuser to land on the stub. Result
      // recorded in window.__shellSelfTest = {r:pass|fail|wait, t, af, sc}
      // and rendered as HUD row "ST:R t=Tms af=N sc=H". Decouples AF
      // verification from reaching post-login Home — QA can verify the
      // rescue mechanic on splash / user picker / any page without
      // needing a stable emulator post-login flow.
      "  try{(function(){",
      "    var on=false;",
      '    try{on=(localStorage.getItem("jellyfin.shell.afSelfTest")==="1")||/shellSelfTest=focus/.test(String(location.hash||""))||/shellSelfTest=focus/.test(String(location.search||""));}catch(_){}',
      "    if(!on)return;",
      "    window.__shellAFForceAuth=1;",
      "    function inject(){",
      '      if(document.getElementById("__shellST"))return;',
      '      var d=document.createElement("div");',
      '      d.id="__shellST";d.className="focusable";d.tabIndex=0;',
      '      d.style.cssText="position:fixed;top:200px;left:200px;width:300px;height:60px;background:#003366;color:#fff;text-align:center;line-height:60px;font:bold 14px sans-serif;z-index:99998;";',
      '      d.textContent="SHELL_SELFTEST_TARGET";',
      "      (document.body||document.documentElement).appendChild(d);",
      "      try{document.body&&document.body.focus&&document.body.focus();}catch(_){}",
      "    }",
      "    function go(){",
      // JEL-623: the self-test depends on the now-gated 600ms auto-
      // focus poll; force-fire the paint gate so the harness still
      // runs on splash / user-picker pages where no card ever paints.
      '      try{window.__shellPaintGate&&window.__shellPaintGate.fire("selftest");}catch(_){}',
      "      inject();",
      "      window.__shellSelfTestStart=Date.now();",
      '      window.__shellSelfTest={r:"wait",t:0,af:0,sc:-1};',
      "      var deadline=Date.now()+10000;",
      "      var iv=setInterval(function(){",
      "        try{inject();}catch(_){}",
      "        var ae=document.activeElement;",
      '        var ok=ae&&ae.id==="__shellST";',
      "        if(ok){",
      "          clearInterval(iv);",
      '          window.__shellSelfTest={r:"pass",t:Date.now()-window.__shellSelfTestStart,af:window.__shellAutoFocusSuccesses||0,sc:window.__shellLastScopeHit};',
      "          return;",
      "        }",
      "        if(Date.now()>deadline){",
      "          clearInterval(iv);",
      '          window.__shellSelfTest={r:"fail",t:Date.now()-window.__shellSelfTestStart,af:window.__shellAutoFocusAttempts||0,sc:window.__shellLastScopeHit,bg:window.__shellAutoFocusBudget||0};',
      "        }",
      "      },200);",
      "    }",
      '    if(document.body){go();}else{document.addEventListener("DOMContentLoaded",go,false);}',
      "  })();}catch(_){}",
      // JEL-1779: Tizen 5.5 first-boot hits NotSupportedError when web
      // client (Babel-transpiled) calls document.registerElement
      // ('array-checkbox', …). Splash hangs 10+ min until QA gives
      // up. Custom Elements v0 is gated/broken on Tizen 5.5 WebKit
      // when document state isn't yet `interactive`. Wrap
      // registerElement so NotSupportedError becomes a returned stub
      // constructor — web client's bootstrap proceeds past the
      // throw, custom element renders as inert tag (no behavior) but
      // doesn't block. Diagnostic: __shellRegElCalls /
      // __shellRegElErrors so QA can see how many registrations were
      // rescued vs. succeeded natively.
      "  try{(function(){",
      "    var orig=document.registerElement;",
      "    if(!orig||orig.__shellWrap)return;",
      '    function makeStub(){function S(){if(typeof HTMLElement==="function")try{return Reflect.construct(HTMLElement,[],S);}catch(_){}return this;}S.prototype=Object.create(HTMLElement.prototype);S.prototype.constructor=S;return S;}',
      "    var wrapped=function(name,opts){",
      "      window.__shellRegElCalls=(window.__shellRegElCalls||0)+1;",
      "      try{return orig.apply(document,arguments);}",
      "      catch(e){",
      "        window.__shellRegElErrors=(window.__shellRegElErrors||0)+1;",
      '        try{var d=window.__shellDiag;if(d&&d.errors){if(d.errors.length>=30)d.errors.shift();d.errors.push({f:"regEl",l:0,m:"regEl "+name+": "+(e&&e.message||e)});}}catch(_){}',
      "        return makeStub();",
      "      }",
      "    };",
      "    wrapped.__shellWrap=true;",
      "    try{document.registerElement=wrapped;}catch(_){}",
      "  })();}catch(_){}",
      // JEL-727 v47: Tizen 5.0 (Chrome 56) ships a buggy
      // Array.prototype.flat — body uses `d > 1` instead of `d >= 1`,
      // so `[[item]].flat()` returns `[[item]]` unchanged.
      // playbackmanager.js:2095 (`items = items.flat()`) hands an
      // array-of-arrays to playWithIntros → playInternal → playAfter
      // BitrateDetect, which passes the inner array as `item` to
      // `getPlayer(item, playOptions)`. The array has no MediaType, so
      // every player rejects and web client logs
      // "No player found for the requested media: undefined".
      //
      // v46 fix used Object.defineProperty(..., writable:false) to
      // lock the polyfill. That broke ALL plugins: bundles
      // (JellyfinEnhanced, JavaScriptInjector, core-js) commonly run in
      // strict mode and do `Array.prototype.flat = fn` — non-writable
      // property + strict mode = TypeError thrown during plugin init,
      // killing the plugin module before its registrations run.
      //
      // v47 fix: install as an accessor with a getter that returns the
      // correct function and a setter that silently absorbs writes.
      // Plugin assignments still succeed syntactically (no throw),
      // but our getter keeps returning the fixed function so the
      // broken platform polyfill cannot resurface. Property left
      // configurable:true so anyone using Object.defineProperty
      // explicitly (rare) can still override.
      "  try{(function(){",
      "    function __shellFlat(depth){",
      "      depth=(depth===undefined)?1:Math.floor(depth);",
      "      if(!(depth>0))return Array.prototype.slice.call(this);",
      "      var out=[];",
      "      for(var i=0;i<this.length;i++){",
      "        var v=this[i];",
      "        if(Array.isArray(v)){",
      "          var inner=(depth>1)?v.flat(depth-1):v;",
      "          for(var j=0;j<inner.length;j++)out.push(inner[j]);",
      "        }else{out.push(v);}",
      "      }",
      "      return out;",
      "    }",
      "    function __shellFlatMap(cb,thisArg){",
      "      return Array.prototype.map.call(this,cb,thisArg).flat();",
      "    }",
      "    function __installAccessor(name,fn){",
      "      try{",
      "        Object.defineProperty(Array.prototype,name,{",
      "          configurable:true,",
      "          enumerable:false,",
      "          get:function(){return fn;},",
      "          set:function(_v){}",
      "        });",
      "      }catch(_){try{Array.prototype[name]=fn;}catch(__){}}",
      "    }",
      '    __installAccessor("flat",__shellFlat);',
      '    __installAccessor("flatMap",__shellFlatMap);',
      "    try{window.__shellFlatInstalled=1;}catch(_){}",
      "  })();}catch(_){}",
      // JEL-567 v43: pin the "SyntaxError: Unexpected end of JSON input"
      // seen in QA v42 playback diag. jellyfin-apiclient JSON-parses every
      // response body; an empty 200/204 (e.g. a playbackInfo / item fetch
      // that came back unauthenticated) throws here and the item ends up
      // with no MediaType. Wrap JSON.parse so an empty/invalid input logs
      // the caller stack into __shellDiag.errors — converts the next QA
      // run from "guess the source" to a pinned frame.
      "  try{(function(){",
      "    var oJP=JSON.parse;",
      "    if(oJP.__shellWrap)return;",
      "    var w=function(t){",
      "      try{return oJP.apply(this,arguments);}",
      "      catch(e){",
      "        try{",
      '          if(t==null||t===""){',
      "            var d=window.__shellDiag;",
      "            if(d&&d.errors){",
      '              var st="";try{st=String(new Error().stack||"").replace(/\\s+/g," ").slice(0,220);}catch(_){}',
      "              if(d.errors.length>=30)d.errors.shift();",
      '              d.errors.push({f:"json-empty",l:0,m:"JSON.parse empty input @ "+st});',
      "            }",
      "          }",
      "        }catch(_){}",
      "        throw e;",
      "      }",
      "    };",
      "    w.__shellWrap=true;",
      "    try{JSON.parse=w;}catch(_){}",
      "  })();}catch(_){}",
      // Dynamic-script intercept (JEL-406). Server plugins like JellyfinEnhanced
      // inject more <script src=...> tags AFTER document.open/write, so the
      // initial-DOM transpileLegacyScripts() pass never sees them. On Tizen 5.0
      // (Chromium 56) those scripts SyntaxError on `?.` and other ES2020+ tokens
      // and JE features collapse: translations.js fails to load, helpers/icons/
      // discovery sub-modules fail, and JE's bootstrap warns/blocks downstream.
      // We patch Node.prototype.appendChild + insertBefore to fetch + Babel-
      // transpile + inline any dynamic <script src> that isn't a jellyfin-web
      // bundle, then dispatch load/error so callers awaiting onload still resolve.
      // Babel.min.js is loaded once on the widget origin and survives document
      // .open()/write() because Window persists across the document handoff.
      "  try{(function(){",
      '    var ua=navigator.userAgent||"";',
      "    var m=/(?:Chrome|Chromium)\\/(\\d+)\\./.exec(ua);",
      "    var legacy=!!(m&&parseInt(m[1],10)<70);",
      '    if(!legacy){try{new Function("var a={};return a?.b");}catch(_){legacy=true;}}',
      "    if(!legacy)return;",
      '    function isBundle(src){var b=String(src||"").split("?")[0];return /\\.bundle\\.js$/i.test(b)||/\\.chunk\\.js$/i.test(b)||/(^|\\/)serviceworker\\.js$/i.test(b);}',
      // JEL-184: never intercept cross-origin third-party scripts. The
      // interceptor exists ONLY to transpile same-origin jellyfin-web plugin
      // bodies served from ${server} (document.baseURI origin). A foreign
      // script (e.g. the media bar / EditorsChoice trailer feature loading
      // https://www.youtube.com/iframe_api) cannot be read with our fetch()
      // — youtube.com sends no CORS header for the widget origin — so
      // intercepting it ALWAYS fails the fetch, fires an `error` event, and
      // the YouTube IFrame API never initializes: window.YT stays undefined,
      // onYouTubeIframeAPIReady never resolves, no YT.Player, no muted
      // playVideo(). On TV the media bar trailers then never autoplay, while
      // a real browser (no interceptor) loads the API natively and they do.
      // Fix: let foreign scripts load natively as real <script src>, exactly
      // like a browser. Mirrors the JEL-131 primer's same-origin guard.
      '    function isForeignOrigin(src){try{var o=new URL(document.baseURI).origin;if(!o||o==="null")return false;var a=new URL(String(src),document.baseURI).origin;return a!==o;}catch(_){return false;}}',
      // JEL-554 (v32): same pre-check as static transpileLegacyScripts.
      // Skip babel.transform entirely when no ES2020+ syntax is present —
      // plugin parses fine on Chromium 56 as-is.
      // JEL-26: keep this seed-side pre-check in lockstep with the widget-side
      // MODERN_SYNTAX_RE_SRC above, including the BigInt false-positive anchor.
      // JEL-417: this seed regex is a PRE-check (gates needsTx -> maybeTranspile),
      // so it carries the broader MODERN_PRECHECK_RE_SRC — the trailing
      // `,\s*\.\.\.[\w$]` alternative that also flags interior object spread
      // `{a, ...b, c}`. Lockstep with the widget-side MODERN_PRECHECK_RE_SRC.
      "    var __modernRe=/\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await|,\\s*\\.\\.\\.[\\w$]/;",
      // JELA-11: seed-side device-native parse probe — lockstep with the
      // widget-side parseProbeActive()/parsesOnThisEngine() (same probe, same
      // killswitch key). Capability is re-tested HERE, not interpolated from
      // the widget verdict, because this code runs on the post-document.write
      // SERVER origin whose CSP can differ from the widget origin's.
      '    var __ppOk=(function(){try{new Function("1");return true;}catch(_){return false;}})();',
      '    function __ppOff(){try{return localStorage.getItem("jellyfin.shell.parseProbeDisabled")==="1";}catch(_){return false;}}',
      "    function __ppOn(){return __ppOk&&!__ppOff();}",
      "    try{window.__shellParseProbeSeed={ok:__ppOk,n:0,tx:0};}catch(_){}",
      "    function __ppParses(code){var d=window.__shellParseProbeSeed;if(d)d.n++;try{new Function(code);return true;}catch(_){if(d)d.tx++;return false;}}",
      '    function needsTx(code){if(typeof code!=="string")return false;if(__ppOn())return !__ppParses(code);return __modernRe.test(code);}',
      // JELA-11: Babel output is probe-verified like the widget-side
      // babelTranspile (no regex fallback — probe-less devices keep the
      // pre-JELA-11 accept-anything-Babel-returned behavior).
      '    function transpile(code){if(typeof window.Babel==="undefined")return null;var out;try{out=window.Babel.transform(code,{presets:[["env",{targets:{chrome:"56"},modules:false,loose:true}]],assumptions:{iterableIsArray:true,arrayLikeIsIterable:true},sourceType:"script",compact:true,comments:false}).code;}catch(_){return null;}if(typeof out==="string"&&__ppOn()&&!__ppParses(out))return null;return out;}',
      "    function maybeTranspile(code){if(!needsTx(code)){try{window.__shellTxSkipCount=(window.__shellTxSkipCount||0)+1;}catch(_){}return code;}try{window.__shellTxDoCount=(window.__shellTxDoCount||0)+1;}catch(_){}return transpile(code);}",
      // JEL-621: pre-lowered drop consumption in the dynamic pipelines. The
      // widget-side loadTxDropManifest parks {ok,base,entries,counters} on
      // window.__shellTxDrop (window survives the document.write handoff);
      // on a hash hit the pre-lowered ES5 body is fetched from the server's
      // /shell/ drop and Babel is never invoked for that script. Misses and
      // failures fall back to maybeTranspile unchanged. __txFnv must stay
      // byte-lockstep with the widget-side txFnv1a (same fnv1a the JEL-178
      // `txc:` key uses), and __oracleRe with MODERN_SYNTAX_RE_SRC — the
      // STRICT post-transpile oracle, NOT the broader __modernRe pre-check
      // above, which would false-positive on legal ES2015 `, ...x` array/
      // call spread that preset-env legitimately leaves in lowered output.
      "    var __oracleRe=/\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await/;",
      // JELA-11: seed-side oracle mirrors the widget-side loweredBodyOk() —
      // probe when available, strict __oracleRe token screen as fallback.
      "    function __loweredOk(b){if(__ppOn())return __ppParses(b);return !__oracleRe.test(b);}",
      "    function __txFnv(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0;}return h.toString(36);}",
      "    function __txDropGet(code){",
      '      try{if(localStorage.getItem("jellyfin.shell.txDropDisabled")==="1")return Promise.resolve(null);}catch(_){}',
      "      var d=window.__shellTxDrop;",
      "      if(!d||!d.ok||!d.entries)return Promise.resolve(null);",
      '      var rel=d.entries[__txFnv(String(code||""))];',
      '      if(typeof rel!=="string"||!rel){d.m++;return Promise.resolve(null);}',
      // JELA-833: same coalescer as the widget side — d.want is installed on
      // the shared window.__shellTxDrop by txBundleAttach, so this seed and
      // txDropResolve batch into ONE queue instead of each running their own.
      // d.want absent (kill switch) or resolving null both fall through to
      // the per-body GET below.
      '      var hash=rel.slice(3,-3);var vb=d.want?d.want(hash):Promise.resolve(null);return vb.then(function(pb){if(typeof pb==="string"){if(!pb.length||!__loweredOk(pb)){d.r++;return null;}d.h++;return pb;}return window.fetch(d.base+rel,{credentials:"omit"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();}).then(function(b){if(typeof b!=="string"||!b.length||!__loweredOk(b)){d.r++;return null;}d.h++;return b;}).catch(function(){d.f++;return null;});});',
      "    }",
      // JELA-183: handoff-safe lazy Babel for the dynamic pipelines + primer.
      // The widget-side window.__ensureBabel (bootstrap index.html) loads
      // 'babel.min.js' RELATIVE to the CURRENT document — correct pre-write
      // (WGT sibling), but called from this seed (post-document.write) it
      // resolves against the server's /web/ base, 404s, and settles with
      // window.Babel still undefined. Try the widget hook first (it wins
      // whenever Babel was kicked pre-write and is a no-op re-check after),
      // then fall back to the ABSOLUTE server drop copy via fetch +
      // new Function (works on both origins on M63, same engine the parse
      // probe already exercises; indirect eval = global scope, same as a
      // script tag). A failed attempt resets the cached promise
      // so a later script retries; callers see maybeTranspile's null
      // contract unchanged.
      "    var __ebDyn=null;",
      "    function __ensureBabelDyn(){",
      '      if(typeof window.Babel!=="undefined")return Promise.resolve(true);',
      "      if(__ebDyn)return __ebDyn;",
      '      var w=null;try{w=typeof window.__ensureBabel==="function"?window.__ensureBabel():null;}catch(_){}',
      '      if(!w||typeof w.then!=="function")w=Promise.resolve(null);',
      "      __ebDyn=w.then(function(){",
      '        if(typeof window.Babel!=="undefined")return true;',
      '        return window.fetch(S+"/shell/babel.min.js",{credentials:"omit"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();}).then(function(t){',
      "          try{(0,eval)(t);}catch(_){}",
      '          var ok=typeof window.Babel!=="undefined";',
      "          if(!ok)__ebDyn=null;",
      '          try{console.warn(ok?"shell: babel loaded from server drop (dynamic)":"shell: server-drop babel failed to init");}catch(_){}',
      "          return ok;",
      '        }).catch(function(){__ebDyn=null;try{console.warn("shell: server-drop babel fetch failed");}catch(_){}return false;});',
      "      });",
      "      return __ebDyn;",
      "    }",
      // Async drop-in for the synchronous maybeTranspile at both dynamic
      // call sites (rewrite + srcPipeline): resolves to the same
      // lowered-body-or-null contract, trying the server drop first.
      // JELA-183: on a drop miss, await __ensureBabelDyn() before
      // maybeTranspile, mirroring the bootstrap seed's __dp/pre pattern and
      // the static JEL-1034 lazy path. Without this, a boot whose STATIC
      // scripts all drop-hit never loads Babel, and every dynamically-
      // injected module that misses the drop (e.g. a plugin's versioned
      // submodules) nulls out as "setter transpile failed".
      "    function __txResolve(code){",
      "      if(!needsTx(code)){try{window.__shellTxSkipCount=(window.__shellTxSkipCount||0)+1;}catch(_){}return Promise.resolve(code);}",
      "      return __txDropGet(code).then(function(b){",
      "        if(b!=null)return b;",
      "        return __ensureBabelDyn().then(function(){return maybeTranspile(code);});",
      "      });",
      "    }",
      // JEL-557: cache transpiled plugin bodies in localStorage so warm cold
      // boots skip the fetch+Babel cycle on every dynamic <script src> the
      // server plugins inject. Browser uses a ServiceWorker on server origin;
      // widget origin can\'t, so without this cache the JE-style serial
      // createElement+onload chain re-pays a full RTT + Babel pass per script
      // every cold boot (~50 scripts × ~500 ms = ~25 s of the reported 30 s
      // home-card delay). Key prefix is shell-version-tagged so a shell
      // update auto-busts; plugin URLs already carry ?v= cache-busting.
      // JEL-557 (v36): expose TXVER on window so QA HUD/overlay can read
      // the active cache key prefix without re-parsing shell.js. Previous
      // builds kept this as a local `var`, leaving QA to infer the version
      // from build comments only.
      // JEL-1150: TX_VER is derived from babel inputs at widget parse time
      // (see top-of-IIFE block). Interpolate so widget-side TX_PFX and
      // seed-side __TXPFX always agree.
      "    var __TXVER=" + JSON.stringify(TX_VER) + ";",
      "    try{window.__TXVER=__TXVER;}catch(_){}",
      '    var __TXPFX="shell.tx"+__TXVER+":";',
      '    var __TXLRUKEY="shell.txLru"+__TXVER;',
      // JEL-178: drop ONLY the per-load epoch-ms cache-buster (JE's
      // ?v=Date.now()); keep config-version tokens (JS-Injector .NET ticks,
      // HomeScreen plugin version) so a config change cache-misses instead
      // of replaying a stale body. Behaviourally identical to the widget-
      // side txKey above (JEL-26 lockstep).
      '    function __txKey(s){var u=String(s||"");var i=u.indexOf("?");if(i<0)return u;var path=u.substring(0,i);var pairs=u.substring(i+1).split("&");var keep=[];var now=Date.now();for(var pi=0;pi<pairs.length;pi++){var p=pairs[pi];if(!p)continue;var eq=p.indexOf("=");var val=eq<0?p:p.substring(eq+1);if(/^[0-9]{12,14}$/.test(val)){var n=parseInt(val,10);if(n>0&&Math.abs(n-now)<6048e5)continue;}keep.push(p);}return keep.length?path+"?"+keep.join("&"):path;}',
      // JELA-748 (AC2): seed-side twin of txWriteLost — a swallowed
      // localStorage write bumps the shared window counter reported as tx.qe.
      "    function __qeB(){try{window.__shellLsQuotaErr=(window.__shellLsQuotaErr||0)+1;}catch(_){}}",
      "    function __txLru(){try{var v=localStorage.getItem(__TXLRUKEY);return v?JSON.parse(v):{};}catch(_){return{};}}",
      "    function __txPersistLru(m){try{localStorage.setItem(__TXLRUKEY,JSON.stringify(m));}catch(_){__qeB();}}",
      // JELA-799 (a): proactive generation sweep for SEED-WRITTEN
      // version-keyed slots. __txKey deliberately KEEPS a ?v=<version> token
      // (only 12-14 digit epoch busters are stripped), so every plugin
      // version bump writes a brand-new key and ORPHANS the previous one:
      // the seed maintains no index, and the widget-side one-generation
      // cleanup (txRecordQuerySlot's "vqk:") only ever runs for URLs the
      // WIDGET fetched. Census of an aged rig profile (JELA-797): 3 vqk:
      // entries against 163 plain slots / 1,882,682 chars, essentially all
      // carrying ?v=<plugin version>. One JellyfinEnhanced bump therefore
      // lays a fresh ~1.84M-char generation on top of the old one — enough
      // on its own to pin a 3.67M-char store at the 5,242,880 UTF-16 code
      // unit quota, after which the ONLY eviction is __txPrune firing
      // REACTIVELY out of __txSet's quota catch, 10 keys at a time.
      // Fix: a per-FAMILY index ("gqk:"), the family being the key with its
      // version-ish tokens removed. Keying on the family rather than the
      // bare path keeps concurrent NON-version generations of one path
      // distinct (/HomeScreen/x.js?v=<ver>&c=1 vs &c=2 are two families, not
      // one slot the two thrash over). A write whose family already points
      // at a DIFFERENT key drops that key (and its "ts:" sibling) BEFORE the
      // new body is stored, so the space is freed proactively instead of at
      // quota. Class-1 URLs (epoch buster only) have family === key and are
      // skipped entirely — nothing to sweep, no index cost. Content-
      // addressed "txc:" bodies are deliberately NOT dropped here: they are
      // keyed by SOURCE HASH, so a byte-identical body legitimately survives
      // a version bump and dropping it could kill a live entry. Reaching
      // those is JELA-799 (b)'s LRU work.
      // Flag-dark: localStorage["jellyfin.shell.txGenSweep"]="1" enables it,
      // "jellyfin.shell.txGenSweepDisabled"="1" is the kill switch. QA
      // counter: window.__shellTxGenDrop (diag beacon "gd=").
      '    var __TXGENK="jellyfin.shell.txGenSweep";',
      '    function __txGenOn(){try{return localStorage.getItem(__TXGENK)==="1"&&localStorage.getItem(__TXGENK+"Disabled")!=="1";}catch(_){return false;}}',
      // Version-ish token test — lockstep with __txQC's `pin` arm below and
      // with the widget-side txQueryClass: >=15-digit ticks, a dotted a.b.c
      // version, or a long hex hash.
      "    function __txVerTok(v){return /^[0-9]{15,}$/.test(v)||/^\\d+(\\.\\d+){2,}/.test(v)||(/^[0-9a-fA-F]{12,}$/.test(v)&&/[a-fA-F]/.test(v));}",
      '    function __txFam(k){var i=k.indexOf("?");if(i<0)return k;var path=k.substring(0,i);var pairs=k.substring(i+1).split("&");var keep=[];for(var pi=0;pi<pairs.length;pi++){var p=pairs[pi];if(!p)continue;var eq=p.indexOf("=");var val=eq<0?p:p.substring(eq+1);if(__txVerTok(val))continue;keep.push(p);}return keep.length?path+"?"+keep.join("&"):path;}',
      '    function __txGenRec(k){if(!__txGenOn())return;try{var f=__txFam(k);if(f===k)return;var fk=__TXPFX+"gqk:"+f;var prev=null;try{prev=localStorage.getItem(fk);}catch(_){}if(prev===k)return;if(prev){try{localStorage.removeItem(__TXPFX+prev);}catch(_){}try{localStorage.removeItem(__TXPFX+"ts:"+prev);}catch(_){}try{var m=__txLru();if(m[prev]!=null){delete m[prev];__txPersistLru(m);}}catch(_){}try{window.__shellTxGenDrop=(window.__shellTxGenDrop||0)+1;}catch(_){}}localStorage.setItem(fk,k);}catch(_){__qeB();}}',
      // JEL-619: version-keyed plugin fetch caching in the DYNAMIC pipeline
      // (JE-style createElement+src submodules). Class 2 = a kept query token
      // carries version info (>=15-digit ticks / dotted a.b.c / long hex) ->
      // cache until the token changes; class 1 = only a per-load epoch-ms
      // buster (stripped by __txKey) -> cache with a 24 h TTL ("ts:" sibling
      // key); class 0 = static marker query (?_jsi=1) -> never cached, fetch
      // stays busted every boot. Epoch test lockstep with __txKey/txKey.
      // "@@shellref:" values are pointers the STATIC layer writes into the
      // shared keyspace (body lives once under its txc: slot) — deref on
      // read, treat a pruned target as a miss. Kill-switch (shared with the
      // widget side): jellyfin.shell.pluginFetchCacheDisabled='1'.
      '    var __TXREF="@@shellref:";',
      '    function __txQC(u){var i=u.indexOf("?");if(i<0)return 0;var pairs=u.substring(i+1).split("&");var now=Date.now();var pin=false,bust=false;for(var pi=0;pi<pairs.length;pi++){var p=pairs[pi];if(!p)continue;var eq=p.indexOf("=");var val=eq<0?p:p.substring(eq+1);if(/^[0-9]{12,14}$/.test(val)){var n=parseInt(val,10);if(n>0&&Math.abs(n-now)<6048e5){bust=true;continue;}}if(/^[0-9]{15,}$/.test(val)||/^\\d+(\\.\\d+){2,}/.test(val)||(/^[0-9a-fA-F]{12,}$/.test(val)&&/[a-fA-F]/.test(val)))pin=true;}return pin?2:bust?1:0;}',
      '    function __txQGate(s){if(localStorage.getItem("jellyfin.shell.pluginFetchCacheDisabled")==="1")return 0;return __txQC(s);}',
      // JEL-554 (v34): record the first 10 missed src URLs alongside the
      // miss counter so QA can compare them against the cached key set in
      // localStorage. v33 showed 54 misses / 1 hit despite 171 cached
      // entries — implies a URL-mismatch (likely query-param drift)
      // rather than a cold-cache problem. Bounded at 10 to keep
      // localStorage/window state small. Mirrors instrumentation added
      // to the static-side cachedTranspile (see TX_PFX).
      '    function __txGet(src){try{var s=String(src||"");var k=__txKey(s);if(s.indexOf("?")>=0){var qc=__txQGate(s);if(qc===0)return null;if(qc===1){var ts=parseInt(localStorage.getItem(__TXPFX+"ts:"+k),10)||0;if(Date.now()-ts>864e5&&window.__shellCfgEM!==1)return null;}}var v=localStorage.getItem(__TXPFX+k);if(v!=null&&v.lastIndexOf(__TXREF,0)===0)v=localStorage.getItem(__TXPFX+v.substring(__TXREF.length));if(v!=null){window.__shellTxCacheHits=(window.__shellTxCacheHits||0)+1;if(s.indexOf("?")>=0)window.__shellQvHits=(window.__shellQvHits||0)+1;var m=__txLru();m[k]=Date.now();__txPersistLru(m);}else{window.__shellTxCacheMisses=(window.__shellTxCacheMisses||0)+1;try{var __miss=window.__shellTxCacheMissUrls;if(!__miss){__miss=[];window.__shellTxCacheMissUrls=__miss;}if(__miss.length<10)__miss.push(src);}catch(_){}}return v;}catch(_){return null;}}',
      "    function __txPrune(){try{var m=__txLru();var keys=Object.keys(m);if(!keys.length)return;keys.sort(function(a,b){return m[a]-m[b];});var n=Math.min(keys.length,10);for(var i=0;i<n;i++){try{localStorage.removeItem(__TXPFX+keys[i]);}catch(_){}delete m[keys[i]];}__txPersistLru(m);}catch(_){}}",
      '    function __txSet(src,body){if(typeof body!=="string"||body.length>262144)return;var s=String(src||"");var k=__txKey(s);if(s.indexOf("?")>=0){var qc=__txQGate(s);if(qc===0)return;if(qc===1)try{localStorage.setItem(__TXPFX+"ts:"+k,String(Date.now()));}catch(_){}__txGenRec(k);}try{localStorage.setItem(__TXPFX+k,body);var m=__txLru();m[k]=Date.now();__txPersistLru(m);}catch(e){__txPrune();try{localStorage.setItem(__TXPFX+k,body);var m2=__txLru();m2[k]=Date.now();__txPersistLru(m2);}catch(__){__qeB();}}}',
      // JELA-749: drop bare slots SHADOWED by a version-keyed sibling. The
      // JELA-183 primer's scrape path minted `<url>` keys for modules the
      // runtime only ever asks for as `<url>?v=<token>`; __txKey keeps a
      // class-2 token, so the bare slot is unreachable and just holds quota
      // (JELA-746 measured 49.5 KB of them on a store already at 70%).
      // Deleting one is safe by construction: a "@@shellref:" pointer only
      // ever targets a `txc:` body, never a URL slot, so nothing can deref
      // through the key being removed — and the presence of a `<url>?…`
      // sibling is itself the proof that the runtime asks WITH a query. A
      // path whose query is fully stripped by __txKey (class 1) has no `?`
      // sibling, so its bare key IS its live key and is never touched. Worst
      // case if some other caller did want the bare URL: one cache miss and
      // a refetch. Deferred well past the boot window; ~200 keys, one pass.
      "    function __txSweepBare(){try{",
      "      var n=0;try{n=localStorage.length;}catch(_){return;}",
      "      var i,k,ks=[];",
      "      for(i=0;i<n;i++){try{k=localStorage.key(i);}catch(_){continue;}if(k&&k.lastIndexOf(__TXPFX,0)===0)ks.push(k.substring(__TXPFX.length));}",
      "      var q={},b=[],j,kk,qi;",
      '      for(j=0;j<ks.length;j++){kk=ks[j];qi=kk.indexOf("?");if(qi>=0)q[kk.substring(0,qi)]=1;else if(/^https?:\\/\\//.test(kk))b.push(kk);}',
      "      var m=__txLru(),cut=0,by=0,dirty=false;",
      "      for(j=0;j<b.length;j++){",
      "        if(!q[b[j]])continue;",
      "        var v=null;try{v=localStorage.getItem(__TXPFX+b[j]);}catch(_){}",
      "        if(v==null)continue;",
      "        cut++;by+=v.length;",
      "        try{localStorage.removeItem(__TXPFX+b[j]);}catch(_){}",
      '        try{localStorage.removeItem(__TXPFX+"ts:"+b[j]);}catch(_){}',
      "        if(m[b[j]]!=null){delete m[b[j]];dirty=true;}",
      "      }",
      "      if(dirty)__txPersistLru(m);",
      "      try{window.__shellTxSweep={n:cut,b:by};}catch(_){}",
      "    }catch(_){}}",
      // JEL-405: dynamic-injection paths inline plugin bodies via textContent,
      // so a plugin that references `$`/`jQuery` may execute before the
      // jellyfin-web jQuery bundle (`<script src>`) finishes evaluating on
      // Chromium 56. Wrap any inlined body that touches jQuery in a tiny
      // poller so it defers until window.jQuery exists. Mirrors the static
      // wrapForJQuery() used by transpileLegacyScripts().
      "    var __jqRe=/\\bjQuery\\b|(?:^|[^A-Za-z0-9_$.])\\$\\s*\\(/;",
      "    function needsJq(code){return __jqRe.test(code);}",
      '    function wrapJq(code){return "(function(){function __run(){"+code+"\\n}if(typeof window.jQuery!=\\"undefined\\"){__run();return;}var __to;var __t=setInterval(function(){if(typeof window.jQuery!=\\"undefined\\"){clearInterval(__t);clearTimeout(__to);try{__run();}catch(e){try{console.error(\\"shell: deferred plugin failed\\",e&&e.message);}catch(_){}}}},20);__to=setTimeout(function(){clearInterval(__t);try{console.warn(\\"shell: jQuery wait timed out, running anyway\\");}catch(_){}try{__run();}catch(e){try{console.error(\\"shell: deferred plugin failed\\",e&&e.message);}catch(_){}}},10000);})();";}',
      '    function dispatchEvt(node,type){try{var ev=document.createEvent("Event");ev.initEvent(type,false,false);node.dispatchEvent(ev);}catch(_){}try{var fn=node["on"+type];if(typeof fn==="function")fn.call(node,{type:type,target:node});}catch(_){}}',
      "    function rewrite(parent,node,ref,origMethod){",
      '      var src=node.getAttribute("src");',
      "      __recDyn(src);",
      '      node.setAttribute("data-shell-rewriting","1");',
      '      var stub=document.createComment("shell-pending:"+src);',
      "      var ret;",
      "      try{if(ref)ret=origMethod.call(parent,stub,ref);else ret=origMethod.call(parent,stub);}catch(_){ret=node;}",
      // JEL-557: cache short-circuit before network fetch.
      "      var __cb=__txGet(src);",
      "      if(__cb!=null){",
      '        node.removeAttribute("src");node.removeAttribute("type");node.removeAttribute("defer");node.removeAttribute("async");',
      "        node.textContent=__cb;",
      '        node.setAttribute("data-shell-transpiled-from",src);',
      '        node.setAttribute("data-shell-tx-cached","1");',
      "        try{parent.replaceChild(node,stub);}catch(_){try{parent.appendChild(node);}catch(__){}}",
      '        setTimeout(function(){dispatchEvt(node,"load");},0);',
      "        return ret;",
      "      }",
      '      window.fetch(String(src).indexOf("?")>=0?src+"&__sb="+Date.now()+"."+(window.__sbN=(window.__sbN||0)+1):src,String(src).indexOf("?")>=0?{credentials:"omit",cache:"no-store"}:{credentials:"omit"})',
      '        .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();})',
      // JEL-554 (v32): only call babel.transform when the body actually
      // contains ES2020+ syntax. Most plugin scripts parse fine on
      // Chromium 56 as-is and don\'t need the ~50–200 ms transpile pass.
      // JEL-621: __txResolve tries the server's pre-lowered drop first,
      // then falls back to the same maybeTranspile contract.
      "        .then(function(code){return __txResolve(code);})",
      "        .then(function(out){",
      "          if(out==null){",
      "            try{parent.removeChild(stub);}catch(_){}",
      '            try{console.warn("shell: dynamic transpile failed",src);}catch(_){}',
      '            dispatchEvt(node,"error");',
      "            return;",
      "          }",
      '          node.removeAttribute("src");node.removeAttribute("type");node.removeAttribute("defer");node.removeAttribute("async");',
      "          var gated=needsJq(out);",
      "          var body=gated?wrapJq(out):out;",
      "          node.textContent=body;",
      '          node.setAttribute("data-shell-transpiled-from",src);',
      '          if(gated)node.setAttribute("data-shell-jquery-gated","1");',
      "          try{parent.replaceChild(node,stub);}catch(_){try{parent.appendChild(node);}catch(__){}}",
      "          __txSet(src,body);",
      '          dispatchEvt(node,"load");',
      "        })",
      "        .catch(function(err){",
      "          try{parent.removeChild(stub);}catch(_){}",
      '          try{console.warn("shell: dynamic fetch/transpile failed",src,err&&err.message);}catch(_){}',
      '          dispatchEvt(node,"error");',
      "        });",
      "      return ret;",
      "    }",
      // JEL-557 (v36): intercept telemetry. v33 QA reported only 3 of the
      // ~109 plugin scripts were captured — but the report measured
      // `__shellDeferQLen`, which only counts items still queued at sample
      // time, not total intercepts. Expose two running counters so QA can
      // distinguish "intercept never fired" (real bug) from "intercept
      // fired and drained" (working as designed).
      "    function shouldIntercept(node){",
      '      if(!node||node.nodeName!=="SCRIPT"||!node.getAttribute)return null;',
      '      if(node.getAttribute("data-shell-rewriting"))return null;',
      '      if(node.getAttribute("data-shell-transpiled-from"))return null;',
      '      if(node.getAttribute("data-shell-seed")==="1")return null;',
      '      if(node.getAttribute("data-shell-diag")==="1")return null;',
      '      if(node.getAttribute("data-shell-polyfill")==="1")return null;',
      '      var src=node.getAttribute("src");',
      "      if(!src||isBundle(src)||isForeignOrigin(src))return null;",
      "      try{window.__shellInterceptCount=(window.__shellInterceptCount||0)+1;window.__icAppend=(window.__icAppend||0)+1;}catch(_){}",
      "      return src;",
      "    }",
      "    var origAppend=Node.prototype.appendChild;",
      "    Node.prototype.appendChild=function(node){",
      "      try{if(shouldIntercept(node))return rewrite(this,node,null,origAppend);}catch(_){}",
      "      return origAppend.call(this,node);",
      "    };",
      "    var origInsert=Node.prototype.insertBefore;",
      "    Node.prototype.insertBefore=function(node,ref){",
      "      try{if(shouldIntercept(node))return rewrite(this,node,ref,origInsert);}catch(_){}",
      "      return origInsert.call(this,node,ref);",
      "    };",
      // JEL-407: appendChild/insertBefore hooks above only fire when src is
      // already on the element at insertion time. JellyfinEnhanced + others
      // do `var s=createElement("script"); head.appendChild(s); s.src=URL;`
      // — src-after-append, browser starts the load via the IDL src setter
      // without going through Node.prototype. Result: 30 SyntaxError(?.)
      // entries on Tizen 5.0 from plugin sub-modules (discovery-filter-utils,
      // seamless-scroll, bookmarks-library, ...). Patch the src setter and
      // setAttribute("src",...) directly so we catch the load-trigger
      // regardless of insertion order. Pipeline: suppress the actual src
      // (browser never fetches), fetch+transpile ourselves, insert a sibling
      // inline <script> with the transpiled body, dispatch load on the
      // original node so callers awaiting onload still resolve.
      "    function srcPipeline(node,src){",
      "      if(node.__shellPiped)return;",
      "      node.__shellPiped=true;",
      "      __recDyn(src);",
      // JEL-557: cache short-circuit before network fetch.
      "      var __cb=__txGet(src);",
      "      if(__cb!=null){",
      '        var ns0=document.createElement("script");',
      "        ns0.textContent=__cb;",
      '        ns0.setAttribute("data-shell-transpiled-from",src);',
      '        ns0.setAttribute("data-shell-tx-cached","1");',
      "        var p0=node.parentNode||document.head||document.documentElement;",
      "        try{if(node.parentNode)p0.insertBefore(ns0,node.nextSibling);else p0.appendChild(ns0);}",
      "        catch(_){try{(document.head||document.documentElement).appendChild(ns0);}catch(__){}}",
      '        setTimeout(function(){dispatchEvt(node,"load");},0);',
      "        return;",
      "      }",
      '      window.fetch(String(src).indexOf("?")>=0?src+"&__sb="+Date.now()+"."+(window.__sbN=(window.__sbN||0)+1):src,String(src).indexOf("?")>=0?{credentials:"omit",cache:"no-store"}:{credentials:"omit"})',
      '        .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();})',
      // JEL-554 (v32): fast path for plugin bodies that parse on Chromium 56.
      // JEL-621: server pre-lowered drop attempt first (see __txResolve).
      "        .then(function(code){return __txResolve(code);})",
      "        .then(function(out){",
      '          if(out==null){try{console.warn("shell: setter transpile failed",src);}catch(_){}dispatchEvt(node,"error");return;}',
      '          var ns=document.createElement("script");',
      "          var gated=needsJq(out);",
      "          var body=gated?wrapJq(out):out;",
      "          ns.textContent=body;",
      '          ns.setAttribute("data-shell-transpiled-from",src);',
      '          if(gated)ns.setAttribute("data-shell-jquery-gated","1");',
      "          var parent=node.parentNode||document.head||document.documentElement;",
      "          try{if(node.parentNode)parent.insertBefore(ns,node.nextSibling);else parent.appendChild(ns);}",
      "          catch(_){try{(document.head||document.documentElement).appendChild(ns);}catch(__){}}",
      "          __txSet(src,body);",
      '          dispatchEvt(node,"load");',
      "        })",
      '        .catch(function(err){try{console.warn("shell: setter fetch/transpile failed",src,err&&err.message);}catch(_){}dispatchEvt(node,"error");});',
      "    }",
      "    function isShellInternal(node){",
      "      if(!node||!node.getAttribute)return false;",
      '      return !!(node.getAttribute("data-shell-seed")==="1"||node.getAttribute("data-shell-diag")==="1"||node.getAttribute("data-shell-polyfill")==="1"||node.getAttribute("data-shell-transpiled-from")||node.getAttribute("data-shell-rewriting"));',
      "    }",
      "    try{",
      "      var SP=window.HTMLScriptElement&&HTMLScriptElement.prototype;",
      '      var srcDesc=SP&&Object.getOwnPropertyDescriptor(SP,"src");',
      "      if(SP&&srcDesc&&srcDesc.configurable&&srcDesc.set){",
      '        Object.defineProperty(SP,"src",{configurable:true,enumerable:srcDesc.enumerable,get:function(){return this.__shellOrigSrc||srcDesc.get.call(this);},set:function(v){',
      "          try{",
      "            if(!isShellInternal(this)&&v&&!isBundle(v)&&!isForeignOrigin(v)){",
      "              try{window.__shellInterceptCount=(window.__shellInterceptCount||0)+1;window.__icSetter=(window.__icSetter||0)+1;}catch(_){}",
      "              this.__shellOrigSrc=String(v);",
      '              try{this.setAttribute("data-shell-rewriting","1");}catch(_){}',
      "              srcPipeline(this,this.__shellOrigSrc);",
      "              return;",
      "            }",
      "          }catch(_){}",
      "          return srcDesc.set.call(this,v);",
      "        }});",
      "      }",
      "    }catch(_){}",
      "    try{",
      "      var origSetAttr=Element.prototype.setAttribute;",
      "      Element.prototype.setAttribute=function(name,value){",
      "        try{",
      '          if(this.nodeName==="SCRIPT"&&String(name).toLowerCase()==="src"&&!isShellInternal(this)&&value&&!isBundle(value)&&!isForeignOrigin(value)){',
      "            try{window.__shellInterceptCount=(window.__shellInterceptCount||0)+1;window.__icSetAttr=(window.__icSetAttr||0)+1;}catch(_){}",
      "            this.__shellOrigSrc=String(value);",
      '            origSetAttr.call(this,"data-shell-rewriting","1");',
      "            srcPipeline(this,this.__shellOrigSrc);",
      "            return;",
      "          }",
      "        }catch(_){}",
      "        return origSetAttr.call(this,name,value);",
      "      };",
      "    }catch(_){}",
      // JEL-131: cold tx-cache priming. On a FRESH install the JEL-557 cache
      // is empty, so JellyfinEnhanced's post-login PARALLEL load of ~54
      // sub-module scripts (loadScripts() fires them all at once — the
      // serial-RTT model in the JEL-557 comment above is outdated) costs
      // ~1.9 MB of Babel.transform serialized on the M63 main thread
      // (~21-42 s, measured offline 2026-06-11) and starves the home
      // render — the user-reported ~30 s login→home. JE only starts once
      // ApiClient.getCurrentUserId() is truthy, so the login idle window
      // (user typing credentials on a TV remote) is free main-thread time
      // that ends exactly when the storm begins. Use it:
      //   1. __recDyn persists intercepted dynamic URLs (JEL-1654 pattern,
      //      dynamic side) for next-boot priming after TX_VER bumps;
      //   2. on a true first boot, scrape the statically-inlined plugin
      //      bodies (script[data-shell-transpiled-from]) for module-list
      //      literals; probe-then-commit candidate dirs so wrong guesses
      //      cost ~4 probe 404s, not a combinatorial spray;
      //   3. prime only while ApiClient exists (bundles executed — never
      //      competes with the parse blackout) and the user is logged out;
      //      abort the moment auth appears. Fetches run 4-wide; transforms
      //      run one per 120 ms macrotask to keep the login form usable.
      // Cache writes mirror the on-demand pipelines (maybeTranspile + jq
      // gate + __txSet) so primed entries are byte-identical, same TX_VER
      // prefix, same LRU. Counters: window.__shellTxPrime {q,f,t,e,st,done}
      // (q=queued, f=fetched, t=transpiled+cached, e=errors, st=stop
      // reason). Kill switch: localStorage["jellyfin.shell.txPrimeDisabled"]
      // ="1" (recording stays on — it is inert without the primer).
      '    var __DYNKEY="jellyfin.shell.dynPluginUrls";',
      "    var __dynRec=null,__dynRecT=null;",
      "    function __recDyn(src){try{",
      "      if(!src)return;",
      "      var abs;try{abs=new URL(src,document.baseURI).href;}catch(_){return;}",
      '      if(!__dynRec){__dynRec={};try{var prev=JSON.parse(localStorage.getItem(__DYNKEY)||"[]");for(var i=0;i<prev.length;i++)__dynRec[prev[i]]=1;}catch(_){}}',
      "      if(__dynRec[abs])return;",
      "      __dynRec[abs]=1;",
      "      if(__dynRecT)return;",
      "      __dynRecT=setTimeout(function(){__dynRecT=null;try{var ks=Object.keys(__dynRec);if(ks.length>100)ks=ks.slice(ks.length-100);localStorage.setItem(__DYNKEY,JSON.stringify(ks));}catch(_){}},1000);",
      "    }catch(_){}}",
      // Scrape: relative .js names need a base dir. Collect quoted absolute
      // dir literals from the same body (capped 6, ranked /js|/scripts|
      // /modules last-segment first) plus the script's own directory; the
      // primer probes names[0] across them and commits to the dir that
      // answers 200. Absolute .js literals are exact candidates as-is.
      "    function __txScrapeBodies(items){",
      "      var REL=/([\"'])(\\/?[A-Za-z0-9_@%-]+(?:\\/[A-Za-z0-9_@%.-]+)*\\.js)(\\?[^\"']*)?\\1/g;",
      "      var ABS=/([\"'])(\\/[A-Za-z0-9_@%-]+(?:\\/[A-Za-z0-9_@%-]+){0,4})\\1/g;",
      "      var groups=[],exact=[],gi,m;",
      "      for(gi=0;gi<items.length;gi++){",
      '        var body=String(items[gi].body||""),from=String(items[gi].src||"");',
      "        var names=[],seenN={},dirs=[],seenD={};",
      "        REL.lastIndex=0;",
      '        while((m=REL.exec(body))&&names.length<80){var nm=m[2];if(seenN[nm])continue;seenN[nm]=1;if(nm.charAt(0)==="/")exact.push(nm);else names.push(nm);}',
      "        if(!names.length)continue;",
      "        ABS.lastIndex=0;",
      '        while((m=ABS.exec(body))&&dirs.length<6){var d=m[2];if(d.indexOf(".")>=0||d.length>64||seenD[d])continue;seenD[d]=1;dirs.push(d);}',
      "        dirs.sort(function(a,b){return (/\\/(js|scripts|modules)$/.test(a)?0:1)-(/\\/(js|scripts|modules)$/.test(b)?0:1);});",
      '        if(from){var qi=from.indexOf("?");var fp=qi<0?from:from.slice(0,qi);var sl=fp.lastIndexOf("/");if(sl>0&&!seenD[fp.slice(0,sl)])dirs.push(fp.slice(0,sl));}',
      "        if(dirs.length)groups.push({dirs:dirs,names:names});",
      "      }",
      "      return {exact:exact,groups:groups};",
      "    }",
      // JELA-749: the primer's "prime only while logged out" contract used
      // to be `ApiClient.getCurrentUserId()` alone, which RACES the SPA's
      // async credential restore: on a credentialed boot ApiClient exists
      // for a few hundred ms before it can answer with a user, and the
      // 500 ms arming poll landed in that window on every boot measured in
      // JELA-746. The primer started, scraped, fired a probe fan-out and
      // ~24 module fetches, and only then saw auth appear and set st="auth"
      // — so the end-state counter reads "never ran" while the downloads
      // already happened. Consult the stored credential too: it is the
      // durable signal that ApiClient is merely still deriving a user we
      // already have. Same shape as instantHomeBody's authed() (a logged-out
      // server entry keeps its address but loses AccessToken/UserId, so this
      // stays false on a real login-screen boot — the window the primer is
      // actually for). Plugin-agnostic: jellyfin-web's own credential key.
      "    function __txAuthed(){",
      '      try{if(window.ApiClient&&typeof window.ApiClient.getCurrentUserId==="function"&&window.ApiClient.getCurrentUserId())return true;}catch(_){}',
      '      try{var c=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null");var sv=c&&c.Servers;for(var ai=0;sv&&ai<sv.length;ai++){if(sv[ai]&&sv[ai].UserId&&sv[ai].AccessToken)return true;}}catch(_){}',
      "      return false;",
      "    }",
      "    function __txPrimeStart(P){",
      '      var origin="";try{origin=new URL(document.baseURI).origin;}catch(_){}',
      "      var seen={},fq=[],bodies=[],pend=0,busy=false,stopped=false;",
      "      function authed(){return __txAuthed();}",
      // JELA-183: version-pinned query URLs (class 2 per __txQC — e.g. a
      // plugin's ?v=<a.b.c> submodules) are cache-stable until the version
      // token changes, so the primer may pre-cache them under their __txKey
      // (token kept). Class 0/1 (marker / epoch-buster) stay rejected —
      // those bodies are config-mutable and must be fetched fresh at boot.
      // __txQGate (not __txQC) so the fetch-cache kill switch also stops
      // priming entries the runtime would then refuse to read.
      // JELA-749: the SCRAPE path can only ever yield BARE paths — a plugin
      // that version-stamps its modules reads that token from a DOM
      // attribute at runtime, so it is nowhere in the body we scrape. But
      // __txKey KEEPS a class-2 token, so a bare-primed slot and the
      // runtime's versioned slot can never match: priming bare costs a full
      // download now and a dead slot forever after. __DYNKEY already holds
      // the REAL URLs the dynamic interceptor saw, so inherit their query —
      // exact path first, then any sibling recorded in the same directory
      // (a plugin stamps its whole module tree with one token). Never
      // invent a token: a path with no recorded evidence stays bare, and an
      // inherited query that is not class 2 drops the candidate through the
      // gate below rather than falling back to the unreadable bare key.
      // Three tiers, each strictly evidence-backed: the exact path, then any
      // sibling recorded in the same directory, then — only when EVERY
      // query-bearing record agrees on one token — that token. Tier 3 is
      // what covers a module whose whole directory is new this boot
      // (JELA-746 saw js/others/ and js/extras/ in exactly that state); a
      // store that mixes tokens (e.g. a second plugin's ?_jsi=1 marker) is
      // not unanimous, so tier 3 stays empty and the candidate stays bare.
      "      var __dqP={},__dqD={},__dqU=null,__dqUok=true;",
      '      try{var __ds=JSON.parse(localStorage.getItem(__DYNKEY)||"[]");for(var __di=0;__di<__ds.length;__di++){var __du=String(__ds[__di]||"");var __dqi=__du.indexOf("?");if(__dqi<0)continue;var __dp=__du.substring(0,__dqi),__dqs=__du.substring(__dqi);__dqP[__dp]=__dqs;var __dsl=__dp.lastIndexOf("/");if(__dsl>0&&!__dqD[__dp.substring(0,__dsl)])__dqD[__dp.substring(0,__dsl)]=__dqs;if(__dqU===null)__dqU=__dqs;else if(__dqU!==__dqs)__dqUok=false;}}catch(_){}',
      '      function __dqFor(abs){try{var q=__dqP[abs];if(q)return q;var sl=abs.lastIndexOf("/");if(sl>0){q=__dqD[abs.substring(0,sl)];if(q)return q;}if(__dqUok&&__dqU)return __dqU;}catch(_){}return "";}',
      '      function __dqAdd(abs){if(String(abs).indexOf("?")>=0)return abs;var q=__dqFor(abs);return q?abs+q:abs;}',
      "      function norm(u){var abs;try{abs=new URL(u,document.baseURI).href;}catch(_){return null;}try{if(origin&&new URL(abs).origin!==origin)return null;}catch(_){return null;}if(isBundle(abs))return null;abs=__dqAdd(abs);if(String(abs).indexOf('?')>=0&&__txQGate(abs)!==2)return null;var k=__txKey(abs);if(seen[k])return null;var hit=null;try{hit=localStorage.getItem(__TXPFX+k);}catch(_){}if(hit!=null)return null;seen[k]=1;return abs;}",
      "      function enq(u){var abs=norm(u);if(abs&&P.q<220){P.q++;fq.push(abs);}}",
      '      function stopAuth(){stopped=true;P.st="auth";}',
      "      function finishMaybe(){if(!stopped&&!fq.length&&!pend&&!bodies.length&&!busy)P.done=1;}",
      "      function drain(){",
      "        if(busy||stopped)return;",
      "        var it=bodies.shift();",
      "        if(!it){finishMaybe();return;}",
      "        busy=true;",
      "        setTimeout(function(){",
      "          if(authed()){stopAuth();busy=false;return;}",
      // JEL-621: try the pre-lowered drop before priming Babel — on a drop
      // hit the primer caches the server-lowered body and Babel stays cold.
      "          var __dp=needsTx(it.c)?__txDropGet(it.c):Promise.resolve(null);",
      "          __dp.then(function(pre){",
      "            var __p=pre==null&&needsTx(it.c)?__ensureBabelDyn():Promise.resolve(true);",
      "            __p.then(function(){",
      "              try{",
      "                var out=pre!=null?pre:maybeTranspile(it.c);",
      "                if(out!=null){__txSet(it.u,needsJq(out)?wrapJq(out):out);P.t++;}else P.e++;",
      "              }catch(_){P.e++;}",
      "              busy=false;",
      "              drain();",
      "            });",
      "          });",
      "        },120);",
      "      }",
      "      function pump(){",
      "        if(stopped)return;",
      "        if(authed()){stopAuth();return;}",
      "        while(pend<4&&fq.length){",
      "          (function(u){",
      "            pend++;",
      '            window.fetch(u,{credentials:"omit"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();}).then(function(code){pend--;P.f++;bodies.push({u:u,c:code});drain();pump();}).catch(function(){pend--;P.e++;pump();});',
      "          })(fq.shift());",
      "        }",
      "        finishMaybe();",
      "      }",
      "      function probe(g){",
      // JELA-749: probe() was the one fetch site with no stop/auth guard, so
      // a dir fan-out could fire (and 404 once per wrong dir) after auth had
      // already appeared. Every other fetch site checks; this one now does.
      "        if(stopped)return;",
      "        if(authed()){stopAuth();return;}",
      "        var name=g.names[0],left=0,best=null;",
      // Warm/partial cache: if names[0] is already cached under one of the
      // candidate dirs, that dir won the probe on an earlier boot — commit
      // to it without any network probe (a fully-warm boot fetches nothing)
      // and let enq's cached-skip fill only the gaps.
      "        for(var w=0;w<g.dirs.length;w++){",
      // JELA-749: look the warm hit up under the SAME key norm() would
      // enqueue (query inherited) — otherwise inheritance turns every warm
      // boot back into a full probe fan-out.
      '          var wAbs;try{wAbs=__dqAdd(new URL(g.dirs[w]+"/"+name,document.baseURI).href);}catch(_){continue;}',
      "          var wHit=null;try{wHit=localStorage.getItem(__TXPFX+__txKey(wAbs));}catch(_){}",
      "          if(wHit!=null){",
      '            for(var w2=1;w2<g.names.length;w2++)enq(g.dirs[w]+"/"+g.names[w2]);',
      "            pump();",
      "            return;",
      "          }",
      "        }",
      "        function settle(){",
      "          if(best!=null&&!stopped){",
      "            bodies.push({u:best.abs,c:best.code});drain();",
      '            for(var j=1;j<g.names.length;j++)enq(g.dirs[best.rank]+"/"+g.names[j]);',
      "          }",
      "          pump();",
      "        }",
      "        for(var i=0;i<g.dirs.length;i++){",
      '          var cand=norm(g.dirs[i]+"/"+name);',
      "          if(cand==null)continue;",
      "          left++;P.q++;",
      "          (function(rank,abs){",
      "            pend++;",
      '            window.fetch(abs,{credentials:"omit"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text();}).then(function(code){pend--;P.f++;if(best==null||rank<best.rank)best={rank:rank,code:code,abs:abs};if(--left===0)settle();}).catch(function(){pend--;P.e++;if(--left===0)settle();});',
      "          })(i,cand);",
      "        }",
      "        if(!left)pump();",
      "      }",
      '      try{var stored=JSON.parse(localStorage.getItem(__DYNKEY)||"[]");for(var si=0;si<stored.length;si++)enq(stored[si]);}catch(_){}',
      "      var scraped={exact:[],groups:[]};",
      "      try{",
      '        var sc=document.querySelectorAll("script[data-shell-transpiled-from]");',
      "        var items=[];",
      '        for(var ii=0;ii<sc.length;ii++)items.push({body:sc[ii].textContent||"",src:sc[ii].getAttribute("data-shell-transpiled-from")||""});',
      "        scraped=__txScrapeBodies(items);",
      "      }catch(_){}",
      "      for(var ei=0;ei<scraped.exact.length;ei++)enq(scraped.exact[ei]);",
      "      for(var pi=0;pi<scraped.groups.length;pi++)probe(scraped.groups[pi]);",
      "      pump();",
      "    }",
      // JELA-749: store hygiene runs on EVERY boot, independent of the
      // primer's kill switch — the residue it clears outlives whichever boot
      // wrote it. 12 s is well past the boot window this program measures.
      "    try{setTimeout(__txSweepBare,12000);}catch(_){}",
      "    try{",
      '      if(localStorage.getItem("jellyfin.shell.txPrimeDisabled")!=="1"){',
      '        var __tpP={q:0,f:0,t:0,e:0,st:"",done:0};',
      "        window.__shellTxPrime=__tpP;",
      "        var __tpN=0;",
      "        var __tpT=setInterval(function(){",
      "          try{",
      "            __tpN++;",
      '            if(__tpN>360){clearInterval(__tpT);__tpP.st="cap";return;}',
      '            if(!window.ApiClient||typeof window.ApiClient.getCurrentUserId!=="function")return;',
      "            clearInterval(__tpT);",
      // JELA-749: __txAuthed, not getCurrentUserId() alone — see the helper.
      '            if(__txAuthed()){__tpP.st="auth";return;}',
      "            __txPrimeStart(__tpP);",
      "          }catch(_){try{clearInterval(__tpT);}catch(__){}}",
      "        },500);",
      "      }",
      "    }catch(_){}",
      "  })();}catch(_){}",
      // JEL-129: late window.onload rescue (legacy Chromium only). After the
      // document.open/write handoff on Chromium 56, deferred jellyfin-web
      // bundles never auto-execute (JEL-99) — the rewritten document's
      // `load` event fires long before the defer-watchdog runs the bundles,
      // so an inlined/jQuery-gated plugin body that assigns
      // `window.onload = fn` (e.g. EditorsChoice, the home "media bar"
      // spotlight) registers AFTER load already fired and the handler is
      // silently dead: no MutationObserver, no setup(), no Splide, no UI —
      // exactly the JEL-88 telemetry (tx executed, ecAdded=0,
      // splide=undefined). In a real browser the same plugin runs as a true
      // deferred <script> BEFORE load, so it works. Restore browser parity:
      // take over window.onload dispatch and invoke late-registered load
      // handlers (property assignment or addEventListener) once, async.
      // Kill switch: localStorage["jellyfin.shell.lateOnloadDisabled"]="1".
      "  try{(function(){",
      '    try{if(localStorage.getItem("jellyfin.shell.lateOnloadDisabled")==="1")return;}catch(_){}',
      '    var ua=navigator.userAgent||"";',
      "    var m=/(?:Chrome|Chromium)\\/(\\d+)\\./.exec(ua);",
      "    var legacy=!!(m&&parseInt(m[1],10)<70);",
      '    if(!legacy){try{new Function("var a={};return a?.b");}catch(_){legacy=true;}}',
      "    if(!legacy)return;",
      "    if(window.__shellLateOnloadShim)return;window.__shellLateOnloadShim=1;",
      "    var fired=false;",
      '    function isFired(){return fired||document.readyState==="complete";}',
      "    function invoke(fn){",
      "      try{fn.__shellLateRan=1;}catch(_){}",
      '      var ev;try{ev=document.createEvent("Event");ev.initEvent("load",false,false);}catch(_){ev={type:"load",target:window};}',
      "      try{",
      '        if(typeof fn==="function")fn.call(window,ev);',
      '        else if(fn&&typeof fn.handleEvent==="function")fn.handleEvent(ev);',
      '      }catch(e){try{console.error("shell: late onload handler failed",e&&e.message);}catch(_){}}',
      "    }",
      "    function callLate(fn){",
      "      try{window.__shellLateOnloadAssigns=(window.__shellLateOnloadAssigns||0)+1;}catch(_){}",
      "      setTimeout(function(){",
      "        try{window.__shellLateOnloadRuns=(window.__shellLateOnloadRuns||0)+1;}catch(_){}",
      "        invoke(fn);",
      "      },0);",
      "    }",
      "    var cur=null;",
      // Single native dispatcher: marks load-fired and runs the property-
      // assigned handler (we shadow window.onload below, so the native
      // event system no longer dispatches it).
      '    try{window.addEventListener("load",function(){fired=true;if(cur&&!cur.__shellLateRan)invoke(cur);},true);}catch(_){}',
      "    try{",
      '      Object.defineProperty(window,"onload",{configurable:true,',
      "        get:function(){return cur;},",
      "        set:function(fn){cur=fn;if(fn&&isFired()&&!fn.__shellLateRan)callLate(fn);}});",
      "    }catch(_){}",
      "    try{",
      "      var origAddL=window.addEventListener;",
      "      window.addEventListener=function(type,fn){",
      "        var r=origAddL.apply(window,arguments);",
      '        if(type==="load"&&fn&&isFired())callLate(fn);',
      "        return r;",
      "      };",
      "    }catch(_){}",
      "  })();}catch(_){}",
      // QA debug overlay — opt-in via localStorage item "jellyfin.qa.overlay" === "1".
      // JEL-202: also dumps Settings form-field IDs so PowerShell+PIL can OCR
      // a DOM-evidence list off the emulator. Activates when the active page
      // looks like a settings/preferences/dashboard view; otherwise no IDS line.
      '  try{if(localStorage.getItem("jellyfin.qa.overlay")==="1"){',
      "    function __qaIsSettingsView(){",
      '      var h=String(location.hash||"").toLowerCase();',
      "      if(/(preferences|displaysettings|languagesettings|playbacksettings|subtitlesettings|homesettings|quicksettings|dashboard|userprofile|usersettings|settings\\.html)/.test(h))return true;",
      '      var b=document.body?document.body.className:"";',
      "      if(/(dashboardDocument|userPreferencesPage|preferencesContainer)/.test(b))return true;",
      "      return false;",
      "    }",
      "    function __qaActivePage(){",
      '      return document.querySelector(".page:not(.hide)")||document.querySelector(".mainAnimatedPage:not(.hide)")||document.body;',
      "    }",
      "    function __qaCollectFieldIds(){",
      "      if(!__qaIsSettingsView())return [];",
      "      var p=__qaActivePage();if(!p)return [];",
      '      var els=p.querySelectorAll("input[id],select[id],textarea[id],input[name],select[name],textarea[name]");',
      "      var ids=[],seen={};",
      "      for(var i=0;i<els.length;i++){",
      "        var e=els[i];",
      '        var id=e.id||e.name||"";',
      "        if(!id||seen[id])continue;",
      '        if(e.type==="hidden")continue;',
      "        seen[id]=1;ids.push(id);",
      "        if(ids.length>=24)break;",
      "      }",
      "      return ids;",
      "    }",
      "    function __qaChunk(s,n){var out=[];for(var i=0;i<s.length;i+=n)out.push(s.slice(i,i+n));return out;}",
      // JEL-436 followup: capture btnPlay click context so QA can screenshot HUD
      // to see currentItem / ApiClient / viewshow state at click time. Same
      // out-of-band evidence channel as Settings IDS dump above.
      "    window.__qaBtnPlay=window.__qaBtnPlay||{count:0,last:null,err:null,lastViewshow:null};",
      '    try{document.addEventListener("viewshow",function(ev){try{var t=ev&&ev.target;window.__qaBtnPlay.lastViewshow={t:Date.now(),cls:(t&&t.className)||"?",rest:!!(ev.detail&&ev.detail.isRestored)};}catch(_){}},true);}catch(_){}',
      '    try{document.addEventListener("click",function(ev){',
      "      var n=ev.target;var hit=null;",
      '      while(n&&n!==document.body){if(n.classList&&(n.classList.contains("btnPlay")||n.classList.contains("btnReplay"))){hit=n;break;}n=n.parentNode;}',
      "      if(!hit)return;",
      "      try{",
      "        var ac=window.ApiClient;",
      '        var dp=document.querySelector(".itemDetailPage:not(.hide)");',
      '        var nameEl=dp&&dp.querySelector(".nameContainer .itemName");',
      "        var info={",
      "          t:Date.now(),",
      '          action:hit.getAttribute("data-action")||"?",',
      "          dpExists:!!dp,",
      '          dpName:nameEl?String(nameEl.textContent||"").trim().slice(0,30):"?",',
      "          acExists:!!ac,",
      '          acServerId:ac&&typeof ac.serverId==="function"?String(ac.serverId()||"").slice(0,8):"?",',
      '          acUserId:ac&&typeof ac.getCurrentUserId==="function"?String(ac.getCurrentUserId()||"").slice(0,8):"?",',
      "          embyPage:!!(window.Emby&&window.Emby.Page),",
      '          hash:String(location.hash||"").slice(0,40)',
      "        };",
      "        window.__qaBtnPlay.count++;",
      "        window.__qaBtnPlay.last=info;",
      "      }catch(e){window.__qaBtnPlay.err=String(e&&e.message||e).slice(0,80);}",
      "    },true);}catch(_){}",
      // Capture uncaught errors and unhandled rejections that reference
      // serverId/item so QA HUD shows the failing message verbatim.
      '    try{window.addEventListener("error",function(e){try{var m=String((e&&e.message)||(e&&e.error&&e.error.message)||"");if(/serverId|item or serverId|cannot be null/i.test(m)){window.__qaBtnPlay.err=("E:"+m).slice(0,90);}}catch(_){}},true);}catch(_){}',
      // JEL-530 followup: also capture .stack from unhandledrejection so HUD
      // shows the immediate call site that threw "item or serverId cannot
      // be null". Bundle line/col already known to be getApiClient throw —
      // need the FRAME ABOVE to identify which jellyfin-web call passed
      // undefined ServerId. Stack chunked into HUD lines.
      '    try{window.addEventListener("unhandledrejection",function(e){try{var r=e&&e.reason;var m=String((r&&r.message)||r||"");if(/serverId|item or serverId|cannot be null/i.test(m)){window.__qaBtnPlay.err=("R:"+m).slice(0,90);if(r&&r.stack){window.__qaBtnPlay.errStack=String(r.stack).slice(0,600);}}}catch(_){}},true);}catch(_){}',
      // JEL-513 followup: wrap window.ApiClient.getItem once it appears,
      // so the HUD can prove whether the response had ServerId at reload-
      // time. If getItem returns ServerId but currentItem-derived play
      // still fails, the gap is between getItem and currentItem-assignment
      // (transformer, plugin, alternate controller instance, etc.).
      "    (function pollWrapAC(){",
      "      try{",
      '        if(window.ApiClient&&typeof window.ApiClient.getItem==="function"&&!window.ApiClient.__qaWrap){',
      "          window.ApiClient.__qaWrap=true;",
      "          var orig=window.ApiClient.getItem;",
      "          window.ApiClient.getItem=function(){",
      "            var p=orig.apply(this,arguments);",
      "            try{",
      '              if(p&&typeof p.then==="function"){',
      "                p.then(function(it){try{",
      "                  window.__qaBtnPlay.lastGetItem={",
      "                    t:Date.now(),",
      '                    id:it&&it.Id?String(it.Id).slice(0,8):"?",',
      '                    sid:it&&it.ServerId?String(it.ServerId).slice(0,8):"?",',
      '                    hasSid:!!(it&&Object.prototype.hasOwnProperty.call(it,"ServerId")),',
      '                    name:it&&it.Name?String(it.Name).slice(0,20):"?"',
      "                  };",
      "                }catch(_){}});",
      "              }",
      "            }catch(_){}",
      "            return p;",
      "          };",
      "          return;",
      "        }",
      "      }catch(_){}",
      "      setTimeout(pollWrapAC,200);",
      "    })();",
      "    function __qaOverlayUpdate(){",
      '      var el=document.getElementById("__qa_hud");',
      "      if(!el){",
      '        el=document.createElement("div");',
      '        el.id="__qa_hud";',
      '        el.style.cssText="position:fixed;top:0;right:0;z-index:999999;background:#000;color:#0f0;font:bold 13px monospace;padding:4px 6px;pointer-events:none;white-space:pre;text-align:right;";',
      "        document.body&&document.body.appendChild(el);",
      "      }",
      '      var cc=document.querySelectorAll("#childrenCollapsible .card").length;',
      '      var dc=document.querySelectorAll("#childrenCollapsible [data-id]").length;',
      '      var tt=(document.querySelector("#childrenTitle")||{}).innerText||"?";',
      "      var ae=document.activeElement;",
      "      var aeBox=ae&&ae.getBoundingClientRect?ae.getBoundingClientRect():{};",
      "      var lines=[",
      '        "QA cards:"+cc+" dataId:"+dc,',
      '        "title:"+tt.trim().slice(0,20),',
      '        "focus:"+((ae&&ae.tagName)||"?")+":y="+Math.round(aeBox.top||0)+":w="+Math.round(aeBox.width||0),',
      // JEL-1580 v58: surface rescue listener state for QA pixel-read.
      // RS:a/s b=N where a=attempts (listener fired), s=successes
      // (focus moved), b=bound (listener attached at least once).
      // JEL-1580 v59: AF:a/s sc=h/N where a/s=auto-focuser attempts
      // /successes (no keypress required), h=last scope index that
      // returned a target (-1=none), N=total scopes searched.
      '        "RS:"+((window.__shellBodyFocusRescueAttempts)||0)+"/"+((window.__shellBodyFocusRescues)||0)+" b="+((window.__shellBodyFocusRescueBound)||0),',
      '        "AF:"+((window.__shellAutoFocusAttempts)||0)+"/"+((window.__shellAutoFocusSuccesses)||0)+" sc="+((window.__shellLastScopeHit!=null)?window.__shellLastScopeHit:-1)+"/"+((window.__shellLastScopeN)||0)+" bg="+((window.__shellAutoFocusBudget)||0),',
      '        "RE:"+((window.__shellRegElCalls)||0)+"/"+((window.__shellRegElErrors)||0),',
      // JEL-1580 v60: synthetic AF self-test status row. "-" when off.
      '        "ST:"+((window.__shellSelfTest&&window.__shellSelfTest.r)||"-")+" t="+((window.__shellSelfTest&&window.__shellSelfTest.t)||0)+" af="+((window.__shellSelfTest&&window.__shellSelfTest.af)||0)+" sc="+((window.__shellSelfTest&&window.__shellSelfTest.sc!=null)?window.__shellSelfTest.sc:-1),',
      // JEL-1924: secondary .bundle.js prefetch counter. SBP:N/B where
      // N=fetches fired by head IIFE this boot, B=URLs recorded in
      // localStorage from last boot (0 = first boot, nothing to prefetch).
      '        "SBP:"+((window.__shellSecondaryBundlePrefetch)||0)+"/"+(function(){try{return JSON.parse(localStorage.getItem("jellyfin.shell.secondaryBundleUrls")||"[]").length;}catch(_){return 0;}})(),',
      // JEL-1959: /web/ <link rel=stylesheet> prefetch counter. Same
      // shape as SBP. SS:N/B where N=fetches fired by head IIFE this
      // boot, B=URLs recorded in localStorage from last boot.
      '        "SS:"+((window.__shellStylesheetPrefetch)||0)+"/"+(function(){try{return JSON.parse(localStorage.getItem("jellyfin.shell.stylesheetUrls")||"[]").length;}catch(_){return 0;}})(),',
      // JEL-1967: <link rel=preload> counters from head IIFE.
      // PL:S/B/C/T where S=script preloads (main bundle + plugin URLs),
      // B=secondary .bundle.js preloads, C=stylesheet preloads, T=total.
      // Lets QA pixel-confirm the preload pipeline fired without DOM
      // walks. All four numbers stay 0 on modern Chromium (legacy
      // branch only).
      '        "PL:"+((window.__shellPreloadScripts)||0)+"/"+((window.__shellPreloadSecondaries)||0)+"/"+((window.__shellPreloadStylesheets)||0)+"/"+(((window.__shellPreloadScripts)||0)+((window.__shellPreloadSecondaries)||0)+((window.__shellPreloadStylesheets)||0)),',
      // JEL-131: login-idle tx-cache primer status. TP:f/t/e/q(:stop)
      // d=N where f=fetched, t=transpiled+cached, e=errors, q=queued,
      // stop=auth|cap when the primer aborted, d=done flag, plus the
      // tx hit/miss pair so one row answers cold-vs-warm on a beacon
      // screenshot. "-" when the kill switch disabled the primer.
      '        "TP:"+(function(){var P=window.__shellTxPrime;return P?P.f+"/"+P.t+"/"+P.e+"/"+P.q+(P.st?":"+P.st:"")+" d="+P.done:"-";})()+" txh="+(window.__shellTxCacheHits||0)+"/"+(window.__shellTxCacheMisses||0)',
      "      ];",
      "      var ids=__qaCollectFieldIds();",
      "      if(ids.length){",
      '        lines.push("IDS#"+ids.length);',
      '        var joined=ids.join(",");',
      "        var chunks=__qaChunk(joined,38);",
      '        for(var c=0;c<chunks.length&&c<8;c++)lines.push("ID:"+chunks[c]);',
      "      }",
      // JEL-436 followup: render btnPlay capture state when present.
      "      var bp=window.__qaBtnPlay;",
      "      if(bp){",
      "        var vs=bp.lastViewshow;",
      '        if(vs)lines.push("VS:"+(Date.now()-vs.t)+"ms r="+(vs.rest?1:0));',
      "        if(bp.count>0){",
      '          lines.push("BP#"+bp.count+" "+((Date.now()-bp.last.t)/1000|0)+"s");',
      "          var l=bp.last;",
      '          lines.push("BP act:"+l.action+" dp:"+(l.dpExists?1:0));',
      '          lines.push("BP name:"+l.dpName);',
      '          lines.push("BP ac:"+(l.acExists?1:0)+" sid:"+l.acServerId);',
      '          lines.push("BP uid:"+l.acUserId+" emby:"+(l.embyPage?1:0));',
      "        }",
      // JEL-513 followup: render last getItem response info.
      "        var gi=bp.lastGetItem;",
      "        if(gi){",
      '          lines.push("GI#"+((Date.now()-gi.t)/1000|0)+"s id:"+gi.id);',
      '          lines.push("GI sid:"+gi.sid+" has:"+(gi.hasSid?1:0));',
      "        }",
      '        lines.push("BP:"+(window.__shellBundlePatches||0)+" scan:"+(window.__shellBundlesScanned||0)+" hit:"+(window.__shellBundleHits||0));',
      '        var bpf=window.__shellBundlesPatchedFiles;if(bpf&&bpf.length){for(var bi=0;bi<bpf.length&&bi<2;bi++)lines.push("BPf:"+bpf[bi]);}',
      '        lines.push("CM:"+(window.__shellCMPatched||0)+" PM:"+(window.__shellPMPatched||0)+" t:"+(window.__shellCMTries||0));',
      '        if(window.__shellCMErr)lines.push("CMe:"+window.__shellCMErr);',
      '        if(bp.err){var es=bp.err;var ec=__qaChunk(es,38);for(var k=0;k<ec.length&&k<3;k++)lines.push("ERR:"+ec[k]);}',
      // JEL-530 followup: stack trace from unhandledrejection.
      "        if(bp.errStack){",
      "          var stackLines=String(bp.errStack).split(/\\n/).slice(0,6);",
      "          for(var sl=0;sl<stackLines.length;sl++){",
      '            var line=String(stackLines[sl]||"").trim();',
      "            if(!line)continue;",
      "            var sc=__qaChunk(line,38);",
      '            for(var sci=0;sci<sc.length&&sci<2;sci++)lines.push("ST"+sl+":"+sc[sci]);',
      "          }",
      "        }",
      "      }",
      '      el.textContent=lines.join("\\n");',
      "    }",
      "    setInterval(__qaOverlayUpdate,800);",
      '    document.addEventListener("DOMContentLoaded",__qaOverlayUpdate);',
      "  }}catch(_){}",
      // JEL-436 workaround: on Tizen 5.0 (Chromium 56), navigating to a
      // detail page hash does NOT fire the `viewshow` lifecycle event
      // on the active `.mainAnimatedPage`. The page DOM renders, but the
      // itemDetails controller's viewshow listener never runs reload(),
      // so `currentItem` stays undefined. When the user clicks btnPlay,
      // the resume handler invokes playbackManager.play with an item
      // lacking ServerId — ConnectionManager.getApiClient throws
      // `item or serverId cannot be null` and playback silently fails
      // (no `<video>` element ever created).
      //
      // Confirmed by HUD evidence on QN82Q60RAFXZA (v1.0.18):
      //   VS:10878546ms r=0  -> last viewshow was 3hr ago (app startup
      //                         home page), never refired on detail nav
      //   BP act:resume dp:1 -> detail page mounted in DOM
      //   ERR:R:item or serverId cannot be null  -> resume handler throws
      //
      // Root cause inside jellyfin-web is unclear (suspected webpack
      // chunk-load promise hang or React-router useEffect skip on
      // Chromium 56). Shell-side workaround: on every hashchange, after a
      // short delay, synthesize a `viewshow` CustomEvent on the active
      // `.mainAnimatedPage` view. The controller's viewshow listener
      // calls reload() which fetches the item, populates `currentItem`,
      // and wires the click handlers correctly. Idempotent: if jellyfin-
      // web ever does fire viewshow itself, the extra synth fire just
      // re-runs reload() with the same params (one extra GET /Items/{id}).
      //
      // Browser path: this hook only takes effect on legacy Chromium
      // (Tizen <70). Modern browsers fire viewshow natively and skip
      // here entirely.
      "  try{(function(){",
      '    var ua=navigator.userAgent||"";',
      "    var m=/(?:Chrome|Chromium)\\/(\\d+)\\./.exec(ua);",
      "    var legacy=!!(m&&parseInt(m[1],10)<70);",
      '    if(!legacy){try{new Function("var a={};return a?.b");}catch(_){legacy=true;}}',
      "    if(!legacy)return;",
      "    function parseHash(){",
      '      var h=String(location.hash||"");',
      '      var qIdx=h.indexOf("?");',
      "      var params={};",
      "      if(qIdx>=0){",
      "        var qs=h.substring(qIdx+1);",
      '        var parts=qs.split("&");',
      "        for(var i=0;i<parts.length;i++){",
      '          var kv=parts[i].split("=");',
      '          if(kv[0])params[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||"");',
      "        }",
      "      }",
      "      return params;",
      "    }",
      "    function findActiveView(){",
      '      return document.querySelector(".mainAnimatedPage:not(.hide)")||document.querySelector(".page:not(.hide)");',
      "    }",
      "    function synthViewshow(){",
      "      try{",
      "        var view=findActiveView();",
      "        if(!view)return;",
      "        if(view.__shellLastSynthFor===location.hash)return;",
      "        view.__shellLastSynthFor=location.hash;",
      "        var bp=window.__qaBtnPlay;",
      "        var vs=bp&&bp.lastViewshow;",
      "        if(vs&&(Date.now()-vs.t)<1500&&!vs.rest)return;",
      "        var params=parseHash();",
      '        var ev=new CustomEvent("viewshow",{',
      "          bubbles:true,cancelable:false,",
      '          detail:{type:view.getAttribute("data-type"),properties:[],params:params,isRestored:false,state:null,options:{}}',
      "        });",
      "        view.dispatchEvent(ev);",
      "      }catch(_){}",
      "    }",
      "    var t1=null;",
      "    function schedule(){if(t1)clearTimeout(t1);t1=setTimeout(synthViewshow,250);}",
      '    window.addEventListener("hashchange",schedule);',
      '    window.addEventListener("popstate",schedule);',
      // Also try once on first DOM-ready in case initial nav already
      // landed on detail/preferences/etc. before our listener.
      '    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",schedule);',
      "    else schedule();",
      "  })();}catch(_){}",
      // JEL-436 v23: walk webpack module cache to find connectionManager
      // and playbackManager. JEL-534 confirmed window.connectionManager is
      // NOT a global — it lives inside a webpack closure. Push a fake
      // chunk into the webpackChunk* array to capture __webpack_require__,
      // then walk .c (module cache) for modules whose exports look like
      // connectionManager (.getApiClient) or playbackManager (.play+.stop).
      //
      // Patching strategy (defense in depth):
      //   - connectionManager.getApiClient: when called with null/undef
      //     return window.ApiClient directly (bypass throw). When called
      //     with an item lacking ServerId, inject it from ApiClient.serverId.
      //     If origGAC still throws (multi-server edge), fall back to
      //     window.ApiClient.
      //   - playbackManager.play: inject ServerId into every options.items[*]
      //     before dispatch — covers the stale-item path identified in
      //     JEL-530 where getItem returned ServerId but a different item
      //     object reached play().
      //
      // Module detection uses two passes:
      //   1. Regex match on minified function source for "serverId" or
      //      "cannot be null" — catches connectionManager class shape.
      //   2. Shape probe — singleton with .play+.stop+.getCurrentPlayer
      //      catches playbackManager. Singleton with .getApiClient and
      //      either .connectToAddress / .currentApiClient catches
      //      connectionManager when regex misses.
      "  window.__shellCMPatched=0;",
      "  window.__shellPMPatched=0;",
      "  window.__shellCMTries=0;",
      "  try{",
      // JEL-567 v43: an ApiClient is "authenticated" when it carries an
      // access token. Used to reject token-less instances handed back by
      // connectionManager.getApiClient.
      "    function __shellAcAuthed(ac){",
      "      try{",
      "        if(!ac)return false;",
      '        var t=typeof ac.accessToken==="function"?ac.accessToken():ac.accessToken;',
      "        return !!t;",
      "      }catch(_){return false;}",
      "    }",
      "    function __shellWrapGAC(orig,thisArg){",
      "      return function(itemOrSid){",
      "        try{",
      "          var ac=window.ApiClient;",
      "          if(itemOrSid==null){if(ac)return ac;}",
      '          else if(typeof itemOrSid==="object"&&!itemOrSid.ServerId){',
      '            var sid=ac&&typeof ac.serverId==="function"?ac.serverId():null;',
      "            if(sid)itemOrSid.ServerId=sid;",
      "          }",
      "        }catch(_){}",
      "        var res;",
      "        try{res=orig.call(thisArg||this,itemOrSid);}",
      "        catch(e){var ac2=window.ApiClient;if(ac2){try{window.__shellGACFallback=(window.__shellGACFallback||0)+1;}catch(_){}return ac2;}throw e;}",
      // JEL-567 v43: connectionManager can return a token-less ApiClient
      // when its credential store holds a bare server entry — the seed
      // creates the server row before jellyfin-web's login attaches the
      // token, or there is a ServerId mismatch. The web client then logs
      // "[ConnectionRequired] unauthenticated user attempted to access
      // user route" and playback item/playbackInfo fetches come back
      // empty (SyntaxError: Unexpected end of JSON input -> item has no
      // MediaType -> getPlayer returns nothing -> "No player found").
      // Home/detail render fine because they go through the authenticated
      // window.ApiClient. If orig hands back an unauthenticated client for
      // the same (or an unknown) server, prefer the authenticated
      // window.ApiClient instead.
      "        try{",
      "          var win=window.ApiClient;",
      "          if(res&&win&&res!==win&&!__shellAcAuthed(res)&&__shellAcAuthed(win)){",
      '            var rsid=res&&typeof res.serverId==="function"?res.serverId():null;',
      '            var wsid=typeof win.serverId==="function"?win.serverId():null;',
      "            if(!rsid||!wsid||rsid===wsid){",
      "              try{window.__shellGACAuthSwap=(window.__shellGACAuthSwap||0)+1;}catch(_){}",
      "              return win;",
      "            }",
      "          }",
      "        }catch(_){}",
      "        return res;",
      "      };",
      "    }",
      "    function __shellPatchCMProto(cand){",
      "      cand.prototype.__shellWrap=true;",
      "      var orig=cand.prototype.getApiClient;",
      "      cand.prototype.getApiClient=__shellWrapGAC(orig,null);",
      "    }",
      "    function __shellPatchCMInst(cand){",
      "      cand.__shellWrap=true;",
      "      var orig=cand.getApiClient.bind(cand);",
      "      cand.getApiClient=__shellWrapGAC(orig,cand);",
      "    }",
      // JEL-567 v43: read the registered-player roster off the
      // playbackManager singleton. getPlayer() filters
      // getPlayers().filter(isAutomaticPlayer) by canPlayMediaType, so an
      // empty/Video-less roster is itself a "No player found" root cause
      // distinct from a missing MediaType. Surfaced into __shellDiag.pm.
      "    function __shellPlayerRoster(cand){",
      "      try{",
      '        if(!cand||typeof cand.getPlayers!=="function")return null;',
      "        var ps=cand.getPlayers()||[];",
      "        var names=[],video=0;",
      "        for(var i=0;i<ps.length;i++){",
      "          var p=ps[i]||{};",
      '          names.push(String(p.name||p.id||"?"));',
      '          try{if(typeof p.canPlayMediaType==="function"&&p.canPlayMediaType("Video"))video++;}catch(_){}',
      "        }",
      "        return {count:ps.length,video:video,names:names.slice(0,12)};",
      "      }catch(_){return null;}",
      "    }",
      "    function __shellDiagPM(){",
      "      try{var d=window.__shellDiag;if(!d)return null;if(!d.pm)d.pm={};return d.pm;}catch(_){return null;}",
      "    }",
      "    function __shellPatchPM(cand){",
      "      cand.__shellPMWrap=true;",
      "      var origPlay=cand.play.bind(cand);",
      "      try{var dpm=__shellDiagPM();if(dpm){dpm.pmPatched=1;dpm.roster=__shellPlayerRoster(cand);}}catch(_){}",
      "      cand.play=function(options){",
      // JEL-562: guard against undefined / empty-items dispatch. Without
      // this, web client logs "No player found for the requested media:
      // undefined" with no actionable hint.
      '        if(options==null||typeof options!=="object"){',
      '          try{console.warn("shell: pm.play called with no options ("+(options===undefined?"undefined":typeof options)+") — dispatch ignored");}catch(_){}',
      "          return Promise.resolve();",
      "        }",
      "        try{",
      "          if(options.items&&options.items.length){",
      "            var clean=[];",
      "            for(var ii=0;ii<options.items.length;ii++){if(options.items[ii]!=null)clean.push(options.items[ii]);}",
      "            if(!clean.length&&(!options.ids||!options.ids.length)){",
      '              try{console.warn("shell: pm.play items array had only null/undefined entries — dispatch ignored");}catch(_){}',
      "              return Promise.resolve();",
      "            }",
      "            options.items=clean;",
      "          } else if((!options.items||!options.items.length)&&(!options.ids||!options.ids.length)){",
      '            try{console.warn("shell: pm.play called with no items[] and no ids[] — dispatch ignored");}catch(_){}',
      "            return Promise.resolve();",
      "          }",
      "        }catch(_){}",
      "        try{",
      "          var ac=window.ApiClient;",
      '          var sid=ac&&typeof ac.serverId==="function"?ac.serverId():null;',
      "          if(sid){",
      "            if(options.items&&options.items.length){",
      "              for(var i=0;i<options.items.length;i++){",
      "                var it=options.items[i];",
      '                if(it&&typeof it==="object"&&!it.ServerId)it.ServerId=sid;',
      "              }",
      "            }",
      "            if(options.ids&&options.ids.length&&!options.serverId)options.serverId=sid;",
      "          }",
      "        }catch(_){}",
      // JEL-562 (v41): derive MediaType from Type when missing.
      // Upstream `getPlayer(item)` at playbackmanager.js:2942 filters
      // registered players by `p.canPlayMediaType(item.MediaType)`. If
      // MediaType is undefined, every player rejects and the upstream
      // code logs "No player found for the requested media: ${item.Url}"
      // (item.Url is undefined for server items — hence the "undefined"
      // string seen by QA on v40). Map Type→MediaType using the same
      // table the server uses so a stub item from a plugin/SPA caller
      // still resolves to a registered player.
      "        try{",
      "          var __t2m={",
      '            Movie:"Video",Episode:"Video",Trailer:"Video",Video:"Video",',
      '            MusicVideo:"Video",TvChannel:"Video",LiveTvChannel:"Video",',
      '            Program:"Video",Recording:"Video",',
      '            Audio:"Audio",MusicAlbum:"Audio",MusicArtist:"Audio",',
      '            AudioBook:"Audio",AudioPodcast:"Audio",',
      '            Photo:"Photo",PhotoAlbum:"Photo",',
      '            Book:"Book"',
      "          };",
      "          if(options.items&&options.items.length){",
      "            for(var mi=0;mi<options.items.length;mi++){",
      "              var mit=options.items[mi];",
      '              if(!mit||typeof mit!=="object")continue;',
      "              if(!mit.MediaType&&mit.Type&&__t2m[mit.Type]){",
      "                mit.MediaType=__t2m[mit.Type];",
      "                try{window.__shellMTDerived=(window.__shellMTDerived||0)+1;}catch(_){}",
      "              }",
      "              if(!mit.MediaType){",
      '                try{console.warn("shell: pm.play item still missing MediaType (Id="+(mit.Id||"?")+" Type="+(mit.Type||"?")+" Name="+(mit.Name||"?")+") — getPlayer will return no player. dispatching anyway for diagnostics.");}catch(_){}',
      "              }",
      "            }",
      "          }",
      "        }catch(_){}",
      // JEL-562 (v41): diagnostic log of first 5 dispatches. Captures
      // item Id/Type/MediaType/ServerId so QA can correlate any
      // "No player found" failure with the actual item shape that
      // reached origPlay.
      "        try{",
      "          window.__shellPMPlayCount=(window.__shellPMPlayCount||0)+1;",
      "          var __d=[];",
      "          if(options.items){",
      "            for(var di=0;di<options.items.length&&di<3;di++){",
      "              var dx=options.items[di]||{};",
      '              __d.push("["+di+"] Id="+(dx.Id||"?")+" Type="+(dx.Type||"?")+" MediaType="+(dx.MediaType||"?")+" ServerId="+(dx.ServerId?"y":"n"));',
      "            }",
      "          }",
      '          var __dispatch="shell: pm.play dispatch #"+window.__shellPMPlayCount+" items="+(options.items?options.items.length:0)+" ids="+(options.ids?options.ids.length:0)+" "+__d.join(" | ");',
      // JEL-567 v43: emit via console.warn (not console.log) so the
      // dispatch line lands in __shellDiag.warns — QA's standard dump is
      // __shellDiag.errors/warns; a console.log was invisible to it,
      // which is why v40-v42 runs could never confirm the wrap even ran.
      "          if(window.__shellPMPlayCount<=8){try{console.warn(__dispatch);}catch(_){}}",
      // JEL-567 v43: fold the conclusive playback state into __shellDiag.pm
      // so a single QA dump answers: did the wrap run, was MediaType
      // derived, is the player roster empty, did getApiClient swap to the
      // authenticated client.
      "          try{",
      "            var dpm=__shellDiagPM();",
      "            if(dpm){",
      "              dpm.pmPatched=1;",
      "              dpm.playCount=window.__shellPMPlayCount;",
      "              dpm.cmPatched=window.__shellCMPatched||0;",
      "              dpm.mtDerived=window.__shellMTDerived||0;",
      "              dpm.gacFallback=window.__shellGACFallback||0;",
      "              dpm.gacAuthSwap=window.__shellGACAuthSwap||0;",
      "              dpm.lastDispatch=__dispatch;",
      "              dpm.roster=__shellPlayerRoster(cand);",
      "            }",
      "          }catch(_){}",
      "        }catch(_){}",
      // JEL-727: defensive force-load of built-in media players when the
      // playbackManager roster has no player matching the dispatched
      // MediaType. Board reported "No player found for the requested
      // media: undefined" on Tizen 5.0 with our pm.play wrap firing
      // correctly (Type=Movie MediaType=Video ServerId=y) — that only
      // happens when getAutomaticPlayers() returns 0 matches, i.e.
      // htmlVideoPlayer never registered with pluginManager. Causes
      // include silent webpack chunk-load failure and plugin constructor
      // throws on Chromium 56. Trigger pluginManager.loadPlugin for
      // htmlVideoPlayer / htmlAudioPlayer if pluginsList lacks them,
      // then retry origPlay so the user's click still produces playback.
      // Cheap on subsequent calls: pluginManager short-circuits when an
      // instance with the same id is already in pluginsList.
      "        try{",
      "          var dmt=null;",
      '          if(options.items&&options.items.length){var mit0=options.items[0]||{};dmt=String(mit0.MediaType||"").toLowerCase();}',
      "          var roster=__shellPlayerRoster(cand)||{};",
      "          var matches=0;",
      "          if(dmt){",
      '            try{var ps=cand.getPlayers()||[];for(var pi=0;pi<ps.length;pi++){var p=ps[pi]||{};try{if(typeof p.canPlayMediaType==="function"&&p.canPlayMediaType(dmt))matches++;}catch(_){}}}catch(_){}',
      "          }",
      "          var pm=window.__shellPluginManager;",
      '          var needLoad=(matches===0&&dmt==="video"&&pm);',
      "          if(needLoad){",
      // Skip if we already kicked off a load in this session — avoid
      // re-entering loadPlugin on every dispatch while the first import
      // is in flight.
      "            if(!window.__shellForceLoadVideoP){",
      "              window.__shellForceLoadVideoP=true;",
      "              try{window.__shellForceLoadVideoCount=(window.__shellForceLoadVideoCount||0)+1;}catch(_){}",
      '              try{console.warn("shell: roster has 0 Video players — force-loading htmlVideoPlayer/plugin via pluginManager");}catch(_){}',
      '              var lp=pm.loadPlugin("htmlVideoPlayer/plugin");',
      '              var lpa=pm.loadPlugin("htmlAudioPlayer/plugin");',
      "              return Promise.all([lp,lpa]).then(function(){",
      "                try{window.__shellForceLoadVideoOK=(window.__shellForceLoadVideoOK||0)+1;}catch(_){}",
      "                try{var dpm2=__shellDiagPM();if(dpm2)dpm2.roster=__shellPlayerRoster(cand);}catch(_){}",
      "                return origPlay(options);",
      "              }).catch(function(err){",
      "                try{window.__shellForceLoadVideoErr=String((err&&err.message)||err).slice(0,80);}catch(_){}",
      '                try{console.warn("shell: force-load htmlVideoPlayer failed",err&&err.message);}catch(_){}',
      "                return origPlay(options);",
      "              });",
      "            }",
      "          }",
      "        }catch(_){}",
      "        return origPlay(options);",
      "      };",
      "    }",
      "    function __shellLooksLikeCM(o){",
      '      if(!o||typeof o!=="object")return false;',
      '      if(typeof o.getApiClient!=="function")return false;',
      '      return typeof o.connectToAddress==="function"||typeof o.currentApiClient==="function"||typeof o.user==="function";',
      "    }",
      "    function __shellLooksLikePM(o){",
      '      if(!o||typeof o!=="object")return false;',
      '      if(typeof o.play!=="function"||typeof o.stop!=="function")return false;',
      '      return typeof o.getCurrentPlayer==="function"||typeof o.currentPlayer==="function"||typeof o.getPlayerInfo==="function";',
      "    }",
      // JEL-727: pluginManager singleton shape. loadPlugin + ofType +
      // pluginsList array uniquely identify it. Capturing the reference
      // lets us defensively re-load htmlVideoPlayer/plugin when the
      // playbackManager player roster is empty at pm.play dispatch
      // (a "No player found for the requested media: undefined" failure
      // reported by the board on Tizen 5.0).
      "    function __shellLooksLikePluginManager(o){",
      '      if(!o||typeof o!=="object")return false;',
      '      if(typeof o.loadPlugin!=="function"||typeof o.ofType!=="function")return false;',
      "      var list=o.pluginsList||o.plugins;",
      '      return list&&typeof list.length==="number";',
      "    }",
      '    var __shellCMTarget="item or serverId cannot be null";',
      "    function __shellScanProto(cand){",
      "      if(!cand||!cand.prototype||cand.prototype.__shellWrap)return false;",
      "      try{",
      "        var proto=cand.prototype;",
      "        var names=Object.getOwnPropertyNames(proto);",
      "        for(var ni=0;ni<names.length;ni++){",
      "          try{",
      "            var fn=proto[names[ni]];",
      '            if(typeof fn!=="function")continue;',
      "            if(String(fn).indexOf(__shellCMTarget)!==-1){",
      "              __shellPatchCMProto(cand);window.__shellCMPatched++;return true;",
      "            }",
      "          }catch(_){}",
      "        }",
      "      }catch(_){}",
      "      return false;",
      "    }",
      "    function __shellScanInst(cand){",
      '      if(!cand||typeof cand!=="object"||cand.__shellWrap)return false;',
      "      try{",
      "        var proto=Object.getPrototypeOf(cand);",
      "        while(proto&&proto!==Object.prototype){",
      "          var names=Object.getOwnPropertyNames(proto);",
      "          for(var ni=0;ni<names.length;ni++){",
      "            try{",
      "              var fn=proto[names[ni]];",
      '              if(typeof fn!=="function")continue;',
      "              if(String(fn).indexOf(__shellCMTarget)!==-1){",
      "                __shellPatchCMInst(cand);window.__shellCMPatched++;return true;",
      "              }",
      "            }catch(_){}",
      "          }",
      "          proto=Object.getPrototypeOf(proto);",
      "        }",
      "      }catch(_){}",
      "      return false;",
      "    }",
      "    function __shellScanExports(ex){",
      "      if(!ex)return 0;",
      "      var found=0;",
      "      var seen=[];",
      "      var fixed=[ex,ex.default,ex.connectionManager,ex.ConnectionManager,ex.ServerConnections,ex.serverConnections];",
      "      var allKeys=[];",
      "      try{allKeys=Object.keys(ex);}catch(_){}",
      "      var cands=fixed.slice();",
      "      for(var ki=0;ki<allKeys.length;ki++){try{cands.push(ex[allKeys[ki]]);}catch(_){}}",
      "      for(var ci=0;ci<cands.length;ci++){",
      "        var cand=cands[ci];",
      "        if(!cand)continue;",
      "        var dup=false;",
      "        for(var si=0;si<seen.length;si++){if(seen[si]===cand){dup=true;break;}}",
      "        if(dup)continue;",
      "        seen.push(cand);",
      '        try{if(typeof cand==="function"&&__shellScanProto(cand))found++;}catch(_){}',
      '        try{if(typeof cand==="object"&&!window.__shellCMPatched&&__shellScanInst(cand))found++;}catch(_){}',
      // JEL-535 v24: shape-based CM detection fallback. Prototype string',
      // scan misses CMs whose error throw is in a sibling factory module.',
      // QA confirmed CM at wr("84138").A matches __shellLooksLikeCM().',
      '        try{if(typeof cand==="object"&&!window.__shellCMPatched&&__shellLooksLikeCM(cand)&&!cand.__shellWrap){__shellPatchCMInst(cand);window.__shellCMPatched++;found++;}}catch(_){}',
      "        try{if(__shellLooksLikePM(cand)&&!cand.__shellPMWrap){__shellPatchPM(cand);window.__shellPMPatched++;found++;}}catch(_){}",
      // JEL-727: capture pluginManager singleton so pm.play wrap can
      // force-load missing built-in players (htmlVideoPlayer/plugin)
      // when the roster comes up empty for Video MediaType.
      "        try{if(__shellLooksLikePluginManager(cand)&&!window.__shellPluginManager){window.__shellPluginManager=cand;}}catch(_){}",
      "      }",
      "      return found;",
      "    }",
      "    function __shellScanModule(m){",
      "      if(!m||!m.exports)return 0;",
      "      return __shellScanExports(m.exports);",
      "    }",
      "    function __shellWalkWebpack(){",
      "      window.__shellCMTries++;",
      "      try{",
      // JEL-137: never force-require modules before the webpack entry
      // completed (window.ApiClient is set by the entry). A premature
      // wr(mid) mid-bundle-sequence throws on missing cross-bundle deps
      // (swallowed by the per-module catch below) and leaves
      // ServerConnections/its consumers half-evaluated in the module cache
      // forever => login route tF getter TypeError => black login page.
      // The CM/PM/PluginManager instances this walker hunts only exist
      // after the entry ran anyway, so waiting loses nothing.
      '        if(typeof window.ApiClient==="undefined"){',
      "          if(window.__shellCMTries<240)setTimeout(__shellWalkWebpack,500);",
      '          else window.__shellCMErr=\"noApiClient\";',
      "          return;",
      "        }",
      "        var chunkKey=null;",
      "        for(var k in window){if(/^webpackChunk/.test(k)){chunkKey=k;break;}}",
      "        if(!chunkKey){setTimeout(__shellWalkWebpack,300);return;}",
      "        var chunks=window[chunkKey];",
      '        if(!chunks||typeof chunks.push!=="function"){setTimeout(__shellWalkWebpack,300);return;}',
      "        var wr=null;",
      '        try{chunks.push([["__shellProbe_"+Date.now()+"_"+window.__shellCMTries],{},function(r){wr=r;}]);}catch(e){window.__shellCMErr="push:"+String(e.message).slice(0,40);setTimeout(__shellWalkWebpack,500);return;}',
      "        if(!wr){setTimeout(__shellWalkWebpack,300);return;}",
      // JEL-535 v24: webpack 5 wr.c exists but is empty (closure-bound',
      // module cache is invisible). Walk wr.m factory registry instead.',
      // QA verified on physical TV QN82Q60RAFXZA: wr.m has 1447 entries,',
      // wr(id) returns initialized singletons. CM at wr("84138").A,',
      // PM at wr("39738").f. The exact error-string filter used in v23',
      // ("item or serverId cannot be null") rejected those modules,',
      // since the throw site is in a sibling factory. Use a looser',
      // shape-keyword filter and instantiate every matching factory.',
      "        // First, try cache if non-empty (defensive)",
      "        if(wr.c){",
      "          try{for(var id in wr.c){__shellScanModule(wr.c[id]);}}catch(_){}",
      "        }",
      "        // Always walk wr.m — webpack 5 exposes the factory registry here.",
      "        if(wr.m){",
      "          for(var mid in wr.m){",
      "            try{",
      "              var fs=String(wr.m[mid]);",
      "              // Loose keyword pre-filter: factories that mention any of",
      "              // these tokens are candidates for CM / PM / API client.",
      '              if(fs.indexOf("getApiClient")===-1&&',
      '                 fs.indexOf("playbackManager")===-1&&',
      '                 fs.indexOf("getCurrentPlayer")===-1&&',
      '                 fs.indexOf("connectionManager")===-1&&',
      '                 fs.indexOf("currentApiClient")===-1&&',
      // JEL-727: also pick factories that look like pluginManager so we
      // can find the singleton.
      '                 fs.indexOf("pluginsList")===-1&&',
      '                 fs.indexOf("loadPlugin")===-1)continue;',
      "              var modEx=null;",
      "              try{modEx=wr(mid);}catch(e){window.__shellCMReqErrs=(window.__shellCMReqErrs||0)+1;continue;}",
      "              if(modEx)__shellScanExports(modEx);",
      "              if(window.__shellCMPatched&&window.__shellPMPatched&&window.__shellPluginManager)break;",
      "            }catch(_){}",
      "          }",
      "        }",
      "        if((!window.__shellCMPatched||!window.__shellPMPatched||!window.__shellPluginManager)&&window.__shellCMTries<240)setTimeout(__shellWalkWebpack,500);",
      '      }catch(e){window.__shellCMErr="walk:"+String(e.message).slice(0,40);setTimeout(__shellWalkWebpack,500);}',
      "    }",
      // JEL-623: kick the walker on first paint instead of at seed time.
      // Pre-paint it was just a 500ms ApiClient wait loop (the paint
      // gate now owns that wait with a cheaper property check), and
      // kicking at entry-completion made the expensive wr.m factory-
      // registry scan compete with the first home render. The CM/PM/
      // pluginManager patches it installs are playback-path only, so
      // first-paint is early enough by seconds.
      "    (function(){function kick(){setTimeout(__shellWalkWebpack,200);}var pg=window.__shellPaintGate;if(pg&&pg.onPaint){pg.onPaint(kick);}else{kick();}})();",
      "  }catch(_){}",
      // JELA-753: reuse the home tab controller across a route change.
      //
      // Pressing Back from an item detail page rebuilds the ENTIRE home from
      // the network — 47-59 requests, 227-300 KB and a ~2.1-2.4 s network
      // span per press, measured n=6 on the JELA-112 rig. Back-to-home is the
      // single most common navigation on a remote, so ~3.5 browsed items cost
      // a second entire boot; under the JELA-713 concurrency-queueing model
      // that is exactly the regime that queues.
      //
      // The cause is upstream, and it is NOT a missing cache — the cheap path
      // already exists and is simply unreachable. `hometab`'s controller has
      // it:
      //
      //   onResume(e){ if(this.sectionsRendered) return sections.resume(...);
      //                this.destroyHomeSections(); this.sectionsRendered=1;
      //                return apiClient.getCurrentUser().then(loadSections); }
      //
      // but the `home` chunk parks that controller in
      // `var m = useMemo(() => [], [])` — an array scoped to the Home REACT
      // COMPONENT INSTANCE. Navigating to /details unmounts the Home route, so
      // `m` dies with it; coming back constructs a brand-new controller whose
      // `sectionsRendered` is undefined and the resume branch is never
      // reachable across a navigation. It only ever helps a tab switch inside
      // one mount.
      //
      // So the fix is to move the cache OUT of the React instance: a
      // module-level (here: seed-level) map keyed by user id + tab index,
      // exactly as the controller's own author would have written it had the
      // owning component not been the storage.
      //
      // Two halves, because the controller alone is not enough:
      //
      //   1. CONTROLLER REUSE. Wrap the hometab module's default export. A
      //      constructor that returns an object wins over `this`, so
      //      `new Wrapped(view,params)` hands the home component back the
      //      cached instance verbatim — no upstream call site changes, and
      //      `refreshed` is already true on it so `E()` passes refresh:false
      //      and `sections.resume` takes the no-op branch per container.
      //   2. DOM RE-ADOPTION. The cached controller's `sectionsContainer` is
      //      the OLD `.sections` node, which React detached on unmount (its
      //      children survive — nothing calls destroyHomeSections()). The new
      //      mount renders a fresh, EMPTY `.sections`. Reusing the controller
      //      without moving the rendered rows across would resume a container
      //      that is not in the document. So adopt(): copy the class list the
      //      old container accumulated (`.sections` IS the
      //      `.homeSectionsContainer` — Home Screen Sections stamps that class
      //      on React's own node, so a fresh mount does not have it until
      //      loadSections runs), move every child over, re-bind the
      //      `settingschange` listener the constructor installed on the old
      //      node, and re-point the controller.
      //
      // Interception point. `__webpack_require__` is not global (verified on
      // the rig: `typeof window.__webpack_require__ === "undefined"`), and the
      // hometab chunk is executed one microtask after its chunk lands — so a
      // poll of `wr.m` cannot get in front of the first construction, and
      // missing the FIRST construction is precisely missing the instance worth
      // caching. The one hook with the right ordering is the chunk-loading
      // global: webpack's `webpackJsonpCallback` installs the incoming
      // modules into `wr.m`, then calls the ORIGINAL `push` it captured as its
      // parent, and only then resolves the chunk promise that executes them.
      // We create `self.webpackChunk` first (the seed runs before every
      // jellyfin-web script) so our push becomes that parent, and wrap the
      // hometab factory in the window between registration and execution.
      // `wr` itself comes from the JEL-535 probe-push idiom (QA-verified on a
      // physical QN82Q60RAFXZA), captured lazily on the first real chunk.
      //
      // FRESHNESS (stated policy, both halves enforced):
      //   - TTL, default 5 min, tunable via
      //     `jellyfin.shell.homeResumeTtlMs`. NOT sliding — the stamp is the
      //     time of the last full build, so the home is rebuilt from the
      //     network at least every TTL however much the user bounces.
      //   - DIRTY invalidation. Any non-GET request to a user-data mutation
      //     route (PlayedItems / FavoriteItems / Rating / UserData /
      //     Sessions/Playing) bumps a counter; a cache entry is only reused
      //     while the counter is unchanged. Mark something watched on the
      //     detail page and the return to home is a full rebuild, which is
      //     what makes the stale-watched-state case impossible rather than
      //     unlikely. Playback start counts, so finishing an episode also
      //     invalidates.
      // Anything not matching those routes (browsing, scrolling, backing out)
      // is exactly the case this exists for.
      //
      // JELA-827: fleet-ON (opt-OUT). This shipped as `!== "1"` -> bail, but
      // the "1" is written by the jp789seed JSI channel entry, which only
      // runs AFTER the lite→SPA handoff (JELA-802). That seeder's own header
      // says it: "The shell reads the key BEFORE this channel executes, so
      // the seed takes effect on the NEXT boot." On a cold boot (fresh
      // install, LS wipe, quota eviction) the key is absent, so the JELA-789
      // ring (21 reqs/138 KB per Back -> 5-10 reqs/<9 KB) was never paid
      // back. Read for the kill switch instead: absent key means ON.
      // Per-TV kill: localStorage["jellyfin.shell.homeResume"]="0" (the
      // jp789 seeder guards on !== "0", so a "0" survives the channel).
      // TTL knob: "jellyfin.shell.homeResumeTtlMs" (default 300000).
      // Diag/proof-of-arm: window.__shellHR =
      // {on,push,wr,found,mid,wrap,ctor,hits,miss,stale,dirty,moved,err,why}.
      // An arm reporting hits:0 has not fired and must be discarded (JELA-690).
      "  try{(function(){",
      '    if(localStorage.getItem("jellyfin.shell.homeResume")==="0")return;',
      "    var W=window;",
      '    var D=W.__shellHR={on:1,push:0,wr:0,found:0,mid:"",wrap:0,ctor:0,hits:0,miss:0,stale:0,dirty:0,moved:0,err:0,why:""};',
      "    var TTL=300000;",
      '    try{var tv=parseInt(localStorage.getItem("jellyfin.shell.homeResumeTtlMs")||"",10);if(tv>0&&tv<=3600000)TTL=tv;}catch(_){}',
      "    var CACHE={},wr=null,DIRTY=0;",
      "    function now(){return (new Date).getTime();}",
      // Dirty tracking. Both transports are wrapped because jellyfin-web's
      // apiclient uses fetch on modern engines and XHR on the legacy path.
      "    var MUT=/(PlayedItems|FavoriteItems|\\/Rating|UserData|Sessions\\/Playing)/i;",
      "    function note(m,u){try{",
      '      m=String(m||"GET").toUpperCase();',
      '      if(m==="GET"||m==="HEAD"||m==="OPTIONS")return;',
      '      if(MUT.test(String(u||"")))DIRTY++;',
      "    }catch(_){}}",
      "    try{var XO=XMLHttpRequest.prototype.open;",
      "      XMLHttpRequest.prototype.open=function(m,u){note(m,u);return XO.apply(this,arguments);};}catch(_){D.err++;}",
      "    try{var OF=W.fetch;",
      '      if(typeof OF==="function")W.fetch=function(i,init){',
      '        try{note((init&&init.method)||(i&&i.method)||"GET",typeof i==="string"?i:(i&&i.url)||"");}catch(_){}',
      "        return OF.apply(this,arguments);};}catch(_){D.err++;}",
      // Cache key: user id + tab index, so a user switch never inherits the
      // previous user's home and the favorites tab can never collide with it.
      '    function uid(){try{var a=W.ApiClient;return a&&a.getCurrentUserId?String(a.getCurrentUserId()||""):"";}catch(_){return "";}}',
      "    function keyOf(v){",
      '      var ix="0";try{ix=String((v&&v.getAttribute&&v.getAttribute("data-index"))||"0");}catch(_){}',
      '      return uid()+"|"+ix;',
      "    }",
      // Verbatim re-implementation of the `settingschange` handler the
      // upstream constructor bound to the container it was handed.
      "    function bindSettings(inst,el){",
      '      try{el.addEventListener("settingschange",function(){',
      "        try{inst.sectionsRendered=false;if(!inst.paused)inst.onResume({refresh:true});}catch(_){}",
      "      },false);}catch(_){D.err++;}",
      "    }",
      "    function adopt(inst,view,params){",
      '      var nu=view&&view.querySelector?view.querySelector(".sections"):null;',
      "      var old=inst.sectionsContainer;",
      "      if(!nu||!old)return false;",
      "      if(nu!==old){",
      "        try{nu.className=old.className;}catch(_){}",
      "        while(old.firstChild)nu.appendChild(old.firstChild);",
      "        bindSettings(inst,nu);",
      "        D.moved++;",
      "      }",
      "      inst.view=view;inst.params=params;inst.sectionsContainer=nu;",
      "      return true;",
      "    }",
      // Returns "" when the entry may be reused, else the reason it may not.
      "    function usable(ent,view){",
      '      if(!ent||!ent.inst)return "none";',
      '      if(!ent.inst.sectionsRendered)return "unrendered";',
      '      if(now()-ent.t>TTL)return "ttl";',
      '      if(ent.dirty!==DIRTY)return "dirty";',
      "      var c=ent.inst.sectionsContainer;",
      '      if(!c||!c.firstChild)return "empty";',
      '      if(!view||!view.querySelector)return "noview";',
      '      return "";',
      "    }",
      "    function wrapCtor(Orig){",
      '      if(!Orig||typeof Orig!=="function"||Orig.__shellHR)return Orig;',
      "      function HR(view,params){",
      "        D.ctor++;",
      "        var k=keyOf(view),ent=CACHE[k],why=usable(ent,view);",
      "        if(!why){",
      "          try{",
      "            if(adopt(ent.inst,view,params)){D.hits++;return ent.inst;}",
      '            why="adopt";',
      '          }catch(e){D.err++;why="throw:"+String((e&&e.message)||e).slice(0,40);}',
      "        }",
      '        if(why==="ttl")D.stale++;else if(why==="dirty")D.dirty++;',
      "        D.miss++;D.why=why;",
      // The stamp is deliberately the build time, never refreshed on reuse:
      // TTL must bound how old the SHOWN rows can be, not how long the user
      // has been idle.
      "        var inst=new Orig(view,params);",
      "        CACHE[k]={inst:inst,t:now(),dirty:DIRTY};",
      "        return inst;",
      "      }",
      "      try{HR.prototype=Orig.prototype;}catch(_){}",
      "      HR.__shellHR=1;D.wrap++;",
      "      return HR;",
      "    }",
      // JEL-535 probe-push: a chunk with no modules whose runtime callback is
      // handed __webpack_require__. Re-entrant from inside our own push hook —
      // webpackJsonpCallback runs the runtime fn synchronously, so `wr` is set
      // before the outer call resumes.
      "    var capturing=0;",
      "    function capture(){",
      "      if(wr||capturing)return;",
      "      capturing=1;",
      "      try{",
      "        var a=W.webpackChunk;",
      '        if(a&&typeof a.push==="function")a.push([["__shellHR"+now()],{},function(r){wr=r;D.wr=1;}]);',
      "      }catch(_){D.err++;}",
      "      capturing=0;",
      "    }",
      // Anchored on the two names that define the controller. Both must be
      // present, so an unrelated module mentioning one of them cannot match
      // and a renamed upstream degrades to a silent skip (shipped behaviour),
      // never to a wrong wrap.
      "    function scan(data){",
      "      try{",
      "        if(!wr||D.found)return;",
      "        var mods=data&&data[1];if(!mods)return;",
      "        for(var id in mods){",
      "          if(!Object.prototype.hasOwnProperty.call(mods,id))continue;",
      '          var f=mods[id];if(typeof f!=="function")continue;',
      '          var s="";try{s=String(f);}catch(_){continue;}',
      '          if(s.indexOf("destroyHomeSections")<0||s.indexOf("sectionsRendered")<0)continue;',
      '          var base=wr.m&&wr.m[id];if(typeof base!=="function")continue;',
      "          (function(mid,orig){",
      "            wr.m[mid]=function(mod,exp,req){",
      "              orig(mod,exp,req);",
      "              try{",
      "                var ex=(mod&&mod.exports)||exp;",
      '                if(ex&&typeof ex.default==="function")ex.default=wrapCtor(ex.default);',
      "              }catch(_){D.err++;}",
      "            };",
      "          })(id,base);",
      "          D.found=1;D.mid=String(id);",
      "          return;",
      "        }",
      "      }catch(_){D.err++;}",
      "    }",
      "    function hook(a){",
      "      try{",
      '        if(!a||a.__shellHR||typeof a.push!=="function")return;',
      "        a.__shellHR=1;",
      "        var np=a.push;",
      "        a.push=function(d){D.push++;try{capture();scan(d);}catch(_){D.err++;}return np.apply(a,arguments);};",
      "      }catch(_){D.err++;}",
      "    }",
      // The seed runs before every jellyfin-web script, so this array IS the
      // one webpack adopts (`self.webpackChunk=self.webpackChunk||[]`).
      "    try{hook(W.webpackChunk=W.webpackChunk||[]);}catch(_){D.err++;}",
      // Belt and braces for a build that renames the chunk-loading global: the
      // window scan is capped at 3 s (it is not cheap on M63) and the whole
      // interval stops the moment the factory is wrapped.
      "    var tries=0,iv=null;",
      "    function tick(){",
      "      try{",
      "        tries++;",
      "        if(D.found||tries>240){if(iv)clearInterval(iv);return;}",
      "        if(tries<=12){for(var k in W){if(/^webpackChunk/.test(k))hook(W[k]);}}",
      "        capture();",
      "      }catch(_){D.err++;}",
      "    }",
      "    try{iv=setInterval(tick,250);}catch(_){D.err++;}",
      "  })();}catch(_){}",
      "})();",
    ].join("\n");
  }

  // ---- Plugin script transpilation (JEL-401) ----------------------------
  //
  // Tizen 5.0 / 5.5 ship Chromium 56 / 69 which cannot parse ES2020+
  // syntax (?., ??, ||=, private fields, etc.). jellyfin-web's own bundles
  // are transpiled for these targets at build time, but server-installed
  // Jellyfin plugins (Editor's Choice, JellyfinEnhanced, NotifySync, ...)
  // are served raw — a single ?. token throws SyntaxError at parse time and
  // the entire plugin module silently fails to register. We pre-fetch any
  // <script> tag the server has injected into index.html that is NOT a
  // jellyfin-web webpack bundle, run it through @babel/standalone targeting
  // Chrome 56, and substitute a Blob URL containing the transpiled code.
  // Defer ordering is preserved because the replacement <script> still
  // carries the original defer attribute.
  //
  // On Chrome >=70 the index.html bootstrap skips loading babel.min.js
  // entirely, so this code path is a no-op (typeof Babel === 'undefined').

  // Match Chrome/N or Chromium/N. Some Samsung Tizen WebViews report
  // `Chromium/56` instead of `Chrome/56` (Q60R 2019 panels seen in JEL-401),
  // so match both. Fall back to a feature-probe of optional chaining (?.)
  // so we still trigger transpilation even if a future TV ships an
  // unexpected UA shape — parse failure is the actual failure mode.
  function isLegacyChromium() {
    var ua = navigator.userAgent || "";
    var m = /(?:Chrome|Chromium)\/(\d+)\./.exec(ua);
    if (m && parseInt(m[1], 10) < 70) return true;
    try {
      // eslint-disable-next-line no-new-func
      new Function("var a={};return a?.b");
      return false;
    } catch (e) {
      return true;
    }
  }

  //@@SHELL_CORE:isJellyfinWebBundle@@

  var SHELL_DEBUG = false;
  try {
    SHELL_DEBUG = localStorage.getItem("jellyfin.shell.debug") === "1";
  } catch (e) {
    /* ignore */
  }
  function shellLog() {
    if (!SHELL_DEBUG) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[shell]");
      console.log.apply(console, args);
    } catch (_) {}
  }

  function babelTranspile(src) {
    var out;
    try {
      out = window.Babel.transform(src, {
        presets: [
          // JEL-354: chrome:56 (runtime floor), not 63 — lowers all ES2018
          // syntax (object-spread, async generators) the Q60R Chromium-56
          // panels can't parse. loose+assumptions retained for JEL-26 iterator.
          ["env", { targets: { chrome: "56" }, modules: false, loose: true }],
        ],
        assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
        sourceType: "script",
        compact: true,
        comments: false,
      }).code;
    } catch (e) {
      // Plugin author may ship intentionally invalid syntax (e.g. trailing
      // comma in old Node). Keep original — better a parse error in the
      // plugin than no transpiled output at all.
      try {
        console.warn("shell: babel transpile failed", e && e.message);
      } catch (_) {}
      return null;
    }
    // JELA-11: same oracle as the drop path — never inline a Babel body this
    // engine cannot parse (e.g. BigInt literals survive lowering by design;
    // see plugin-syntax-transpile.test.cjs). Callers treat null as transform
    // failure and neutralize, which contains the damage to one script.
    // Probe-gated ON PURPOSE (no regex fallback here): pre-JELA-11 shells
    // never oracle-checked Babel output, and probe-less devices must keep
    // that behavior exactly.
    if (
      typeof out === "string" &&
      parseProbeActive() &&
      !parsesOnThisEngine(out)
    ) {
      try {
        console.warn("shell: babel output failed parse probe, dropped");
      } catch (_) {}
      return null;
    }
    return out;
  }

  // JEL-405: when we XHR-fetch a plugin <script src> and inline it,
  // the script loses its async-load ordering. jQuery itself is loaded
  // by the jellyfin-web bundle (`node_modules.jquery.bundle.js`),
  // which we deliberately skip transpiling, so it remains a normal
  // <script src>. On Tizen 5.0 (Chromium 56) the jQuery bundle has
  // not finished evaluating when an inlined plugin body executes,
  // producing `ReferenceError: $ is not defined` at parse time and
  // breaking JellyfinEnhanced sub-modules. Detect references to `$`
  // or `jQuery` and wrap the body in a tiny poller that defers
  // execution until `window.jQuery` is present.
  var JQUERY_REF_RE = /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/;
  function needsJQueryGate(code) {
    return JQUERY_REF_RE.test(code);
  }

  function wrapForJQuery(code) {
    return [
      "(function(){",
      "function __run(){",
      code,
      "\n}",
      'if(typeof window.jQuery!=="undefined"){__run();return;}',
      "var __to;",
      "var __t=setInterval(function(){",
      'if(typeof window.jQuery!=="undefined"){clearInterval(__t);clearTimeout(__to);try{__run();}catch(e){try{console.error("shell: deferred plugin failed",e&&e.message);}catch(_){}}}',
      "},20);",
      '__to=setTimeout(function(){clearInterval(__t);try{console.warn("shell: jQuery wait timed out, running anyway");}catch(_){}try{__run();}catch(e){try{console.error("shell: deferred plugin failed",e&&e.message);}catch(_){}}},10000);',
      "})();",
    ].join("");
  }

  // ---- Shell diagnostic HUD (JEL-401 followup) --------------------------
  // Q60R retail TVs lock down `sdb dlog` (secure_protocol) and the Web
  // Inspector port (no debug-launch path on production firmware), so we
  // cannot read JS errors from the host. This injects an always-on overlay
  // that captures `error`, `unhandledrejection`, and `console.error/warn`
  // and renders the last few entries top-left so the board can screenshot
  // an actual error name instead of guessing at the next polyfill.
  function buildDiagSeedScript(shellVersion) {
    return [
      "(function(){",
      "if(window.__shellDiag)return;",
      "var MAX=30;",
      'window.__shellDiag={errors:[],warns:[],stats:{ua:(navigator.userAgent||"").slice(0,80),scriptsFound:0,transpiled:0,transpileFailed:0,skipped:0}};',
      // JEL-557: timing milestones for boot → first-card. window.__shellT0 is
      // set on shell.js IIFE entry; we record DCL + first .card observation.
      // JEL-617: connect/login/home phase marks added; every __tm() also
      // forwards into the boot-phase ring recorder installed at IIFE entry
      // (window.__shellPhase) so the localStorage ring gets the same deltas.
      "window.__shellT={t0:(window.__shellT0||Date.now()),dcl:0,api:0,card:0,connect:(window.__shellPhases&&window.__shellPhases.connect)||0,login:0,home:0};",
      "function __tm(k){if(!window.__shellT[k]){window.__shellT[k]=Date.now()-window.__shellT.t0;try{if(window.__shellPhase)window.__shellPhase(k);}catch(_){}}}",
      'document.addEventListener("DOMContentLoaded",function(){__tm("dcl");});',
      'var __apiPoll=setInterval(function(){if(window.ApiClient){__tm("api");clearInterval(__apiPoll);}},100);',
      "setTimeout(function(){clearInterval(__apiPoll);},30000);",
      'var __cardPoll=setInterval(function(){try{if(document.querySelector(".card")){__tm("card");clearInterval(__cardPoll);}}catch(_){}},200);',
      "setTimeout(function(){clearInterval(__cardPoll);},60000);",
      // JEL-617: route-phase poll. jellyfin-web is hash-routed on both TV
      // Chromiums (#/login.html, #/selectserver.html, #/home.html), so a
      // cheap hash sniff marks login/home; selectserver counts as connect
      // (server picker = choosing a connection, same phase as the shell's
      // own form). Stops once home+card are both marked, hard-stop 180 s.
      'var __phPoll=setInterval(function(){try{var h=String(location.hash||""),T=window.__shellT;if(!T.connect&&h.indexOf("selectserver")!==-1)__tm("connect");if(!T.login&&h.indexOf("login")!==-1)__tm("login");if(!T.home&&h.indexOf("home")!==-1)__tm("home");if(T.home&&T.card)clearInterval(__phPoll);}catch(_){}},200);',
      "setTimeout(function(){clearInterval(__phPoll);},180000);",
      'function trimUrl(u){u=String(u||"");var m=/\\/([^\\/?#]+)(\\?|#|$)/.exec(u);return m?m[1]:u.slice(-30);}',
      // JEL-562: detect Response via Object.prototype.toString tag so prior
      // property-accessor branch can no longer miss it on Tizen 5.0
      // (Response.url getter occasionally returns "" / undefined and the
      // s.url check fell through to String(s)="[object Response]").
      "function fmt(s){",
      '  if(s==null)return"";',
      '  if(typeof s==="string")return s.length>140?s.slice(0,140)+"…":s;',
      '  var asStr;try{asStr=String(s);}catch(_){asStr="[unstringable]";}',
      '  var tag="";try{tag=Object.prototype.toString.call(s);}catch(_){}',
      "  try{",
      '    if(tag==="[object Response]"||asStr==="[object Response]"||(s.status!=null&&(typeof s.url!=="undefined"||typeof s.statusText!=="undefined"))){',
      '      var st="?";try{st=s.status;}catch(_){}',
      '      var u="";try{u=s.url==null?"":String(s.url);}catch(_){}',
      '      var sm="";try{if(s.statusText)sm=" "+s.statusText;}catch(_){}',
      '      return "HTTP "+st+sm+(u?" "+trimUrl(u):"");',
      "    }",
      '    if(s instanceof Error||(s.name&&s.message&&typeof s.stack==="string")){',
      '      return (s.name||"Error")+":"+(s.message||"");',
      "    }",
      "  }catch(_){}",
      '  if(asStr&&asStr!=="[object Object]"&&asStr!=="[object Response]")return asStr.length>140?asStr.slice(0,140)+"…":asStr;',
      '  try{var j=JSON.stringify(s);if(j)return j.length>140?j.slice(0,140)+"…":j;}catch(_){}',
      '  return asStr||"[unstringable]";',
      "}",
      "function pushErr(rec){var d=window.__shellDiag;if(d.errors.length>=MAX)d.errors.shift();d.errors.push(rec);}",
      "function pushWarn(rec){var d=window.__shellDiag;if(d.warns.length>=MAX)d.warns.shift();d.warns.push(rec);}",
      // JEL-567: capture column + stack, not just file:line. Minified
      // bundles are one line, so lineno alone is useless for pinning a
      // failure; colno + a trimmed stack let QA identify the exact
      // bundle and offset (e.g. the `elements is not iterable` site).
      'window.addEventListener("error",function(e){var st="";try{st=(e.error&&e.error.stack)?String(e.error.stack).replace(/\\s+/g," ").slice(0,240):"";}catch(_){}pushErr({f:trimUrl(e.filename),l:(e.lineno||0)+":"+(e.colno||0),m:fmt((e.message)||(e.error&&e.error.message))+(st?" @ "+st:"")});},true);',
      "var origErr=console.error,origWarn=console.warn;",
      // JEL-562: preventDefault on unhandledrejection AFTER recording so
      // the native Tizen dlog stops printing "reject:[object Response]".
      // Re-emit via origErr with the fmt-resolved text so dlog still has
      // a readable record of the failure.
      'window.addEventListener("unhandledrejection",function(e){',
      "  var r=e&&e.reason;var msg=fmt(r);",
      '  pushErr({f:"reject",l:0,m:msg});',
      "  try{e.preventDefault();}catch(_){}",
      '  try{origErr.call(console,"shell: unhandled rejection:",msg);}catch(_){}',
      "});",
      // JEL-562: fmt every arg BEFORE delegating to native console so dlog
      // receives readable text (was: native console saw raw Response and
      // toString-stringified it as "[object Response]" into dlog).
      'console.error=function(){var a;try{a=Array.prototype.map.call(arguments,fmt);}catch(_){a=arguments;}try{pushErr({f:"console",l:0,m:Array.prototype.slice.call(a).join(" ")});}catch(_){}return origErr.apply(this,a);};',
      'console.warn=function(){var a;try{a=Array.prototype.map.call(arguments,fmt);}catch(_){a=arguments;}try{pushWarn({f:"console",l:0,m:Array.prototype.slice.call(a).join(" ")});}catch(_){}return origWarn.apply(this,a);};',
      "function render(){",
      "  if(!document.body)return;",
      '  var el=document.getElementById("__shell_diag");',
      "  if(!el){",
      '    el=document.createElement("div");',
      '    el.id="__shell_diag";',
      '    el.style.cssText="position:fixed;top:0;left:0;z-index:2147483647;background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.2 monospace;padding:4px 6px;max-width:55vw;max-height:90vh;overflow:hidden;white-space:pre;pointer-events:none;border-bottom-right-radius:4px;";',
      "    document.body.appendChild(el);",
      "  }",
      "  var d=window.__shellDiag,s=d.stats,init=window.__shellDiagInit||{};",
      "  var T=window.__shellT||{};",
      "  var nowMs=T.t0?(Date.now()-T.t0):0;",
      '  var lines=["shell v' +
        shellVersion +
        ' legacy="+(init.legacy?"1":"0")+" babel="+(init.babel?"1":"0")+" poly="+(init.polyfilled?"1":"0"),',
      '    "plugins found="+(init.scriptsFound||0)+" tr="+(init.transpiled||0)+" fail="+(init.transpileFailed||0)+" skip="+(init.skipped||0)+" pp="+(init.pluginPrefetchAdopted||0)+" ppk="+(window.__shellPluginPrefetch?Object.keys(window.__shellPluginPrefetch).length:0),',
      // JEL-557 cache + timing readout: tx hit/miss + boot milestone deltas ms.
      // v36: also surface intercept counter + TXVER so QA can confirm v36
      // bytes loaded and quantify plugin-script coverage on Tizen.
      // JEL-131: pr= prime counters f/t/e/q(+stop reason) from
      // window.__shellTxPrime — "-" when the primer is disabled/absent.
      '    "tx h="+(window.__shellTxCacheHits||0)+" m="+(window.__shellTxCacheMisses||0)+" sk="+(window.__shellTxSkipCount||0)+" do="+(window.__shellTxDoCount||0)+" tv="+(window.__TXVER||"?")+" pr="+(function(){var P=window.__shellTxPrime;return P?P.f+"/"+P.t+"/"+P.e+"/"+P.q+(P.st?":"+P.st:""):"-";})(),',
      // JEL-1977: /web/ index.html + config.json body cache status.
      // IC:N/h ms=N where N=writeWebIndexCache records this boot,
      // h=cache adoptions this boot (0|1), ms=revalidation round-trip
      // measured when the background fetch resolves on a cache-hit
      // boot. Stays 0/0/0 when the gate flag is off (default).
      '    "IC:"+(window.__shellIndexCacheRecords||0)+"/"+(window.__shellIndexCacheHits||0)+" ms="+(window.__shellIndexCacheSavedMs||0)+" a="+(window.__shellWebIndexCacheAdopted||0),',
      // JEL-1980: main.jellyfin.bundle.js body LS-cache status.
      // MB:a/h b=N q=N where a=__shellMainBundleLSAdopted (0|1 this
      // boot — 1 when bundle inlined from LS instead of <script src>),
      // h=__shellMainBundleInlineHits (cumulative inlines, should
      // match a on a single bundle page), b=bytes inlined (cache body
      // size), q=quota error flag (1 = setItem QuotaExceeded; 2 =
      // pre-write budget reject reserved for future use).
      '    "MB:"+(window.__shellMainBundleLSAdopted||0)+"/"+(window.__shellMainBundleInlineHits||0)+" b="+(window.__shellMainBundleLSBytes||0)+" q="+(window.__shellMainBundleQuotaErr||0),',
      // JEL-1984: babel-preload soft-skip state. BUS=babelUnusedStreak
      // (consecutive full-cache-coverage transpile passes). bp/be=eager
      // preload/eager-kick flags set by the head IIFEs in index.html
      // (1 when they ran, 0 when soft-skipped because streak>=2). sk=1
      // when shell.js loadRemoteWebClient speculative prime was also
      // skipped this boot — should always equal `bp==0` on a babel-
      // needed legacy boot, mirrored here so a single HUD row tells
      // QA whether all three paths agreed.
      '    "BUS:"+(window.__shellBabelUnusedStreak||0)+" bp="+(window.__shellBabelPreload==null?"-":window.__shellBabelPreload)+" be="+(window.__shellBabelEager==null?"-":window.__shellBabelEager)+" sk="+(window.__shellBabelPrimeSkipped||0),',
      '    "ic="+(window.__shellInterceptCount||0)+" a="+(window.__icAppend||0)+" s="+(window.__icSetter||0)+" sa="+(window.__icSetAttr||0),',
      // JEL-617: cn/lg/hm = connect/login/home phase marks; prev = the
      // previous boot's record from the localStorage ring so one screenshot
      // carries a boot-over-boot comparison.
      '    "t cn="+(T.connect||0)+" dcl="+(T.dcl||0)+" api="+(T.api||0)+" lg="+(T.login||0)+" hm="+(T.home||0)+" card="+(T.card||0)+" now="+nowMs,',
      '    (function(){try{var r=JSON.parse(localStorage.getItem("jellyfin.shell.bootPhases")||"[]");var p=r.length>1?r[r.length-2]:null;return p?("prev cn="+(p.connect||0)+" dcl="+(p.dcl||0)+" api="+(p.api||0)+" lg="+(p.login||0)+" hm="+(p.home||0)+" card="+(p.card||0)+" nav="+(p.nav||0)):"prev -";}catch(_){return "prev ?";}})(),',
      // JEL-727: surface PM/CM patch state + player roster + force-load
      // outcome on minimal HUD so the "No player found" failure mode is
      // diagnosable from a single screenshot. dpm.roster is populated by
      // __shellPatchPM each dispatch (and at patch time). flv = force-
      // load count / ok / err for the pluginManager.loadPlugin fallback
      // that targets empty Video roster.
      '    (function(){var dpm=(window.__shellDiag&&window.__shellDiag.pm)||{};var r=dpm.roster||{};var first=(r.names&&r.names[0])||"?";return "pm p="+(window.__shellPMPatched||0)+" c="+(window.__shellCMPatched||0)+" r="+(r.count||0)+"/"+(r.video||0)+" mt="+(window.__shellMTDerived||0)+" gs="+(window.__shellGACAuthSwap||0)+" gf="+(window.__shellGACFallback||0)+" pm="+(window.__shellPluginManager?1:0)+" flv="+(window.__shellForceLoadVideoCount||0)+"/"+(window.__shellForceLoadVideoOK||0)+"/"+(window.__shellForceLoadVideoErr?1:0)+" p0="+first;})(),',
      // JELA-65: config-epoch row. `cache=` is the persisted
      // localStorage['jellyfin.shell.configEpoch'] epoch — the device-side
      // hash the gate compares against the server manifest's requested
      // configEpoch (`srv=`, first 8). st/ad/em mirror the
      // window.__shellConfigEpoch QA counters (JELA-59) so a single debug
      // HUD screenshot answers "what hash does this TV hold vs the server".
      '    (function(){var g=window.__shellConfigEpoch||{};var rec=null;try{rec=JSON.parse(localStorage.getItem("jellyfin.shell.configEpoch"));}catch(_){}var c=(rec&&rec.epoch)?String(rec.epoch):"-";return "CE:"+(g.st||"?")+" srv="+(g.e||"-")+" ad="+(g.ad||0)+" em="+(window.__shellCfgEM||0)+" cache="+c;})(),',
      '    "err="+d.errors.length+" warn="+d.warns.length+" ua="+s.ua.slice(0,40)];',
      "  var es=d.errors.slice(-8);",
      '  for(var i=0;i<es.length;i++){lines.push("E "+es[i].f+":"+es[i].l+" "+es[i].m);}',
      "  var ws=d.warns.slice(-3);",
      '  for(var j=0;j<ws.length;j++){lines.push("W "+ws[j].f+":"+ws[j].l+" "+ws[j].m);}',
      '  el.textContent=lines.join("\\n");',
      "}",
      "function start(){try{render();}catch(_){}setInterval(function(){try{render();}catch(_){}},800);}",
      // JEL-98: the visible on-screen overlay is opt-in via the same debug flag
      // as shellLog(). Error/warn/stat capture above still runs unconditionally
      // so harnesses can read window.__shellDiag, but retail users never see the
      // green diagnostics box unless localStorage['jellyfin.shell.debug']==='1'.
      'var __diagShow=false;try{__diagShow=localStorage.getItem("jellyfin.shell.debug")==="1";}catch(_){}',
      'if(__diagShow){if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start);}else{start();}}',
      "})();",
    ].join("\n");
  }

  // JEL-1832: polyfill body extracted from injectChromium56Polyfills so the
  // string fast path can inject it directly without DOMParser.
  function chromium56PolyfillBody() {
    return [
      "(function(){",
      'if(!Promise.allSettled){Promise.allSettled=function(ps){return Promise.all(ps.map(function(p){return Promise.resolve(p).then(function(v){return{status:"fulfilled",value:v};},function(r){return{status:"rejected",reason:r};});}));};}',
      "if(!Object.fromEntries){Object.fromEntries=function(it){var o={};Array.from(it).forEach(function(kv){o[kv[0]]=kv[1];});return o;};}",
      "if(!Array.prototype.flat){Array.prototype.flat=function(d){d=d===undefined?1:Math.floor(d);if(d<1)return Array.prototype.slice.call(this);return [].concat.apply([],Array.prototype.map.call(this,function(v){return Array.isArray(v)&&d>1?v.flat(d-1):[v];}));};}",
      "if(!Array.prototype.flatMap){Array.prototype.flatMap=function(f,t){return Array.prototype.map.call(this,f,t).flat(1);};}",
      "if(!window.queueMicrotask){window.queueMicrotask=function(fn){Promise.resolve().then(fn);};}",
      'if(typeof globalThis==="undefined"){Object.defineProperty(Object.prototype,"__globalThis__",{get:function(){return this;},configurable:true});globalThis=__globalThis__;delete Object.prototype.__globalThis__;}',
      'if(!String.prototype.replaceAll){String.prototype.replaceAll=function(s,r){if(Object.prototype.toString.call(s)==="[object RegExp]"){if(!s.global)throw new TypeError("replaceAll must be called with a global RegExp");return this.replace(s,r);}return this.split(String(s)).join(typeof r==="function"?"":String(r));};}',
      'if(!String.prototype.matchAll){String.prototype.matchAll=function(re){var flags=re.flags||((re.global?"g":"")+(re.ignoreCase?"i":"")+(re.multiline?"m":""));if(flags.indexOf("g")<0)throw new TypeError("matchAll requires a global RegExp");var s=String(this),r=new RegExp(re.source,flags),out=[],m;while((m=r.exec(s))!==null){out.push(m);if(m[0]==="")r.lastIndex++;}var i=0;return{next:function(){return i<out.length?{value:out[i++],done:false}:{value:undefined,done:true};}};};}',
      "if(!Array.prototype.at){Array.prototype.at=function(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return n<0||n>=this.length?undefined:this[n];};}",
      "if(!String.prototype.at){String.prototype.at=function(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return n<0||n>=this.length?undefined:this.charAt(n);};}",
      'if(!Object.hasOwn){Object.hasOwn=function(o,k){if(o==null)throw new TypeError("Cannot convert undefined or null to object");return Object.prototype.hasOwnProperty.call(Object(o),k);};}',
      'if(!Promise.any){Promise.any=function(ps){return new Promise(function(resolve,reject){var arr=Array.from(ps),n=arr.length,errs=new Array(n),left=n;if(n===0)return reject(new (window.AggregateError||Error)([],"All promises were rejected"));arr.forEach(function(p,i){Promise.resolve(p).then(resolve,function(e){errs[i]=e;if(--left===0)reject(new (window.AggregateError||Error)(errs,"All promises were rejected"));});});});};}',
      'if(typeof Element!=="undefined"&&!Element.prototype.replaceChildren){Element.prototype.replaceChildren=function(){while(this.firstChild)this.removeChild(this.firstChild);if(arguments.length>0)this.append.apply(this,arguments);};}',
      'if(typeof Element!=="undefined"&&!Element.prototype.toggleAttribute){Element.prototype.toggleAttribute=function(name,force){var has=this.hasAttribute(name);if(arguments.length>1){if(force&&!has){this.setAttribute(name,"");return true;}if(!force&&has){this.removeAttribute(name);return false;}return !!force;}if(has){this.removeAttribute(name);return false;}this.setAttribute(name,"");return true;};}',
      // Intl.RelativeTimeFormat — added in Chrome 71. Tizen 5.0 ships
      // Chromium 56, so plugins that call `new Intl.RelativeTimeFormat(...)`
      // throw `TypeError: not a constructor` (JEL-404). Hand-rolled
      // English-default polyfill: covers .format / .formatToParts /
      // .resolvedOptions / supportedLocalesOf well enough for plugin
      // timestamp rendering. Localized output not provided — plugins fall
      // back to readable English strings on legacy TVs instead of
      // crashing.
      "if(!window.Intl)window.Intl={};",
      "if(!Intl.RelativeTimeFormat){",
      '  var __rtfShort={year:"yr.",quarter:"qtr.",month:"mo.",week:"wk.",day:"day",hour:"hr.",minute:"min.",second:"sec."};',
      '  var __rtfNarrow={year:"y",quarter:"q",month:"mo",week:"w",day:"d",hour:"h",minute:"m",second:"s"};',
      '  function __RTF(locale,options){if(!(this instanceof __RTF))return new __RTF(locale,options);options=options||{};this._locale=String(locale||"en");this._numeric=options.numeric||"always";this._style=options.style||"long";}',
      "  __RTF.prototype.format=function(value,unit){",
      '    if(typeof value!=="number"||!isFinite(value))return String(value);',
      '    var u=String(unit||"").replace(/s$/,"");',
      '    if(this._numeric==="auto"){',
      '      if(value===0){if(u==="day")return "today";if(u==="hour")return "this hour";if(u==="minute")return "this minute";if(u==="second")return "now";if(u==="week")return "this week";if(u==="month")return "this month";if(u==="quarter")return "this quarter";if(u==="year")return "this year";}',
      '      if(value===-1&&u==="day")return "yesterday";',
      '      if(value===1&&u==="day")return "tomorrow";',
      '      if(value===-1&&u==="week")return "last week";',
      '      if(value===1&&u==="week")return "next week";',
      '      if(value===-1&&u==="month")return "last month";',
      '      if(value===1&&u==="month")return "next month";',
      '      if(value===-1&&u==="year")return "last year";',
      '      if(value===1&&u==="year")return "next year";',
      "    }",
      "    var abs=Math.abs(value);",
      "    var label;",
      '    if(this._style==="short")label=__rtfShort[u]||u;',
      '    else if(this._style==="narrow")label=__rtfNarrow[u]||u;',
      '    else label=abs===1?u:u+"s";',
      '    if(this._style==="narrow")return value<0?abs+label+" ago":"in "+abs+label;',
      '    return value<0?abs+" "+label+" ago":"in "+abs+" "+label;',
      "  };",
      '  __RTF.prototype.formatToParts=function(value,unit){return [{type:"literal",value:this.format(value,unit)}];};',
      '  __RTF.prototype.resolvedOptions=function(){return {locale:this._locale,numberingSystem:"latn",numeric:this._numeric,style:this._style};};',
      "  __RTF.supportedLocalesOf=function(locales){if(locales==null)return [];return Array.isArray(locales)?locales.slice():[String(locales)];};",
      "  Intl.RelativeTimeFormat=__RTF;",
      "}",
      // JEL-567: Jellyfin 10.11.8 ships a React/MUI web client. Its
      // webpack vendor bundles iterate DOM collections with native
      // for-of / spread / array-destructuring. Several legacy WebKit
      // builds (incl. the Tizen 5.0 "Version/5.0 TV Safari" engine)
      // do NOT expose Symbol.iterator on HTMLCollection and other
      // collection prototypes, so `for (const x of someCollection)`
      // throws `TypeError: <name> is not iterable` — observed as the
      // `elements is not iterable` failure that breaks home render and
      // playback dispatch. Add a generic index-walk iterator to every
      // length-indexed DOM collection prototype that lacks one. Guarded
      // (only installed when missing) so modern engines are untouched.
      // JEL-111: one-shot install proved insufficient on the M63 — home
      // still died with iterate-non-iterable AFTER sign-in (infinite
      // spinner). On-device beacon probes (v2.0.5 QA build) pinned the
      // mechanism: iterators are healthy through boot and login, then the
      // LAZY home-route chunks rebind the DOM collection constructors
      // during eval — NodeList.prototype[Symbol.iterator] reads
      // `undefined` while window.Symbol stays native — and home renders
      // (and dies) in the same breath. Timer-based heals race the render
      // that follows the clobber within the same task. Fix in three
      // layers: (1) DETERMINISTIC setter traps on window.<ctor> — the
      // instant a bundle reassigns a collection constructor, patch the
      // replacement's prototype synchronously, before any render can run;
      // (2) a 250ms sweep interval for the first 90s, then 3s
      // maintenance, as backstop for clobbers that bypass assignment
      // (JEL-21's details-route throw is this same class); (3) the
      // original install-when-missing sweep at parse + DCL. The `armed`
      // latch keeps a re-executed copy from stacking intervals or nesting
      // traps. Counters on window.__shellIterFix let the QA beacon prove
      // liveness (pass/installed/trapped/trapHits).
      "(function(){",
      '  var names=["NodeList","HTMLCollection","HTMLFormControlsCollection","HTMLOptionsCollection","HTMLAllCollection","DOMTokenList","NamedNodeMap","FileList","DOMRectList","DOMStringList","CSSRuleList","StyleSheetList","MediaList","DataTransferItemList","TouchList","SVGLengthList","SVGNumberList","SVGPointList","SVGTransformList","SVGStringList"];',
      "  var st=window.__shellIterFix=window.__shellIterFix||{pass:0,installed:0,fails:0,noSym:0,trapped:0,trapFails:0,trapHits:0};",
      "  function makeIterable(proto){",
      "    if(!proto||proto[Symbol.iterator])return;",
      "    try{Object.defineProperty(proto,Symbol.iterator,{configurable:true,writable:true,value:function(){var i=0,self=this;return {next:function(){return i<self.length?{value:self[i++],done:false}:{value:undefined,done:true};}};}});st.installed++;}catch(_){st.fails++;}",
      "  }",
      "  function sweep(){",
      '    if(typeof Symbol==="undefined"||!Symbol.iterator){st.noSym++;return;}',
      "    st.pass++;",
      "    for(var i=0;i<names.length;i++){try{var C=window[names[i]];if(C&&C.prototype)makeIterable(C.prototype);}catch(_){}}",
      "  }",
      "  function trap(name){",
      "    var cur=window[name];",
      "    Object.defineProperty(window,name,{configurable:true,enumerable:false,",
      "      get:function(){return cur;},",
      "      set:function(v){cur=v;st.trapHits++;try{if(v&&v.prototype)makeIterable(v.prototype);}catch(_){}}",
      "    });",
      "    st.trapped++;",
      "  }",
      "  sweep();",
      '  try{document.addEventListener("DOMContentLoaded",sweep);}catch(_){}',
      "  if(st.armed)return;",
      "  st.armed=1;",
      "  for(var t=0;t<names.length;t++){try{if(window[names[t]])trap(names[t]);}catch(_){st.trapFails++;}}",
      "  try{",
      "    var fast=setInterval(sweep,250);",
      "    setTimeout(function(){",
      "      try{clearInterval(fast);}catch(_){}",
      "      try{setInterval(sweep,3000);}catch(_){}",
      "    },90000);",
      "  }catch(_){}",
      "})();",
      "})();",
    ].join("\n");
  }

  //@@SHELL_CORE:injectChromium56Polyfills@@

  // JEL-1971: QA HTTP beacon body. Replaces `0 debug` AUL handshake
  // (JEL-1969: ~2 sessions per TV boot) + persistent WebInspector
  // (JEL-1970: silently ignored on consumer release-signed Tizen 5.0)
  // as the DOM-telemetry channel for the hourly QA scout. Inert in
  // production: gated on localStorage['jellyfin.qa.overlay'] === '1'.
  // Body string is substituted at build time by build_shell_min.py
  // from the canonical source at qa-beacon.js (kept editable as a
  // separate file for readability). Placeholder kept on raw shell.js
  // so unbuilt loads no-op cleanly. Body must not contain `</script>`
  // literal because the fast path splices it as HTML.
  function qaBeaconBody() {
    return "__QA_BEACON_BODY__";
  }

  //@@SHELL_CORE:injectQaBeacon@@

  // JEL-126: compositor-driven boot progress indicator for the written
  // document. The M63 spends ~40 s parsing + executing the jellyfin-web
  // bundles after the document.write handoff, including a ~20 s
  // main-thread blackout where the splash sits frozen and the boot looks
  // hung (JEL-125 decomposition). This inline script runs at head parse
  // time in the written document and overlays three pulsing dots above
  // the splash, animated purely via CSS transform/opacity keyframes so
  // the compositor keeps them moving while the main thread is blocked.
  // Additive-defensive: the whole body is try/caught, the overlay is
  // pointer-events:none + aria-hidden (never intercepts input), and a
  // 500 ms poll removes it the moment jellyfin-web paints anything real
  // (login / user-picker / card / spinner / dialog selectors mirrored
  // from qa-beacon.js getQcState+collectProbe — none are statically
  // present in jellyfin-web's index.html, all are view-rendered), with a
  // 120 s hard-cap so the overlay can never outlive a boot. The overlay
  // is appended to documentElement because <body> does not exist yet at
  // head parse time; fixed positioning renders it regardless. Body must
  // not contain a `</script>` literal (the fast path splices it as HTML)
  // and stays ES5 (runs pre-polyfill on Chromium 56/63). Kill switch:
  // localStorage['jellyfin.shell.bootProgressDisabled'] = '1'.
  function bootProgressBody() {
    return (
      "(function(){try{" +
      "if(window.__shellBootProgressOn)return;" +
      'try{if(localStorage.getItem("jellyfin.shell.bootProgressDisabled")==="1")return}catch(_){}' +
      "var de=document.documentElement;" +
      "if(!de||!de.appendChild)return;" +
      "window.__shellBootProgressOn=1;" +
      'var st=document.createElement("style");' +
      'st.id="__shell_boot_progress_css";' +
      'st.textContent="' +
      "#__shell_boot_progress{position:fixed;left:0;right:0;bottom:8vh;text-align:center;pointer-events:none;z-index:2147483647}" +
      "#__shell_boot_progress span{display:inline-block;width:14px;height:14px;margin:0 9px;border-radius:50%;background:#fff;opacity:.25;will-change:transform,opacity;animation:__sbp-pulse 1.2s ease-in-out infinite both}" +
      "#__shell_boot_progress span:nth-child(2){animation-delay:.15s}" +
      "#__shell_boot_progress span:nth-child(3){animation-delay:.3s}" +
      "@keyframes __sbp-pulse{0%,80%,100%{transform:scale(.55);opacity:.25}40%{transform:scale(1);opacity:1}}" +
      '";' +
      "(document.head||de).appendChild(st);" +
      'var el=document.createElement("div");' +
      'el.id="__shell_boot_progress";' +
      'el.setAttribute("aria-hidden","true");' +
      'el.innerHTML="<span></span><span></span><span></span>";' +
      "de.appendChild(el);" +
      "var t0=+new Date(),timer=null,done=false;" +
      "function clear(){if(done)return;done=true;" +
      "try{timer&&clearInterval(timer)}catch(_){}" +
      "try{el.parentNode&&el.parentNode.removeChild(el)}catch(_){}" +
      "try{st.parentNode&&st.parentNode.removeChild(st)}catch(_){}" +
      "try{window.__shellBootProgressClearedMs=+new Date()-t0}catch(_){}}" +
      "try{window.__shellBootProgressClear=clear}catch(_){}" +
      'var SEL=".userItemContainer,.btnUser,.manualLoginForm,.loginForm,#txtUserName,#txtManualName,.btnUseQuickConnect,.qcCode,.card,.itemsContainer,.docspinner,.mdlSpinner,.loading-spinner,.mdl-spinner,.dialogContainer";' +
      "timer=setInterval(function(){try{" +
      "if(+new Date()-t0>120000)return clear();" +
      "if(document.querySelector(SEL))clear()" +
      "}catch(_){clear()}},500);" +
      "}catch(_){}})();"
    );
  }

  // Legacy-only: modern engines parse the bundles in ~1 s and the dots
  // would just flash. The string fast path is legacy-gated upstream, so
  // only the DOMParser path needs this check.
  function injectBootProgress(doc) {
    if (!isLegacyChromium()) return;
    var progressTag = doc.createElement("script");
    progressTag.setAttribute("data-shell-boot-progress", "1");
    progressTag.textContent = bootProgressBody();
    doc.head.appendChild(progressTag);
  }

  // JEL-647: Instant-Home. Netflix paints a cached snapshot of the last
  // menu immediately at launch and then refreshes; the shell does the same.
  // Measured on QN90B (Tizen 6.5) warm reload the first live home section
  // paints at 9.3-13.5 s — this closes the visible gap by painting a static
  // NON-interactive overlay rebuilt from a localStorage snapshot of the
  // last settled home (above-fold section titles + card art URLs +
  // geometry; art itself comes from the WebView disk cache, uncached art
  // shows a dark skeleton tile).
  //
  // One body, three injection sites, all sharing window-level state
  // (window.__shellIH survives the document.write handoff):
  //   1. bootstrap() injects into the WIDGET document when a saved server
  //      exists, so the snapshot is on-screen within the shell's first
  //      ~second — long before /web/index.html is even fetched;
  //   2. the DOMParser write path and 3. the string fast path both carry
  //      the same script tag in the written document, because timer
  //      survival across document.open is not guaranteed on every TV
  //      Chromium — a generation counter (G.gen) makes the newest copy own
  //      the watch/capture intervals and older ones self-cancel, so the
  //      re-injection can never double-paint or double-capture.
  //
  // Paint: only when authed (jellyfin_credentials AccessToken — an
  // unauthenticated boot lands on login, never home), snapshot server
  // matches the saved server, and the snapshot is within the bounded
  // max-age (JELA-32: default 48 h, operator-tunable via
  // jellyfin.shell.instantHomeMaxAgeMs — a stale library must not paint
  // forever). When no valid snapshot exists (first-ever boot, expired,
  // corrupt, or server-mismatch) the paint FALLS BACK to a synthetic
  // skeleton (JELA-32/WS-B: title bar + two card rows sized to the
  // viewport) so the very first launch is never blank; the skeleton is
  // content-free (no library data), server-agnostic, and never captured.
  // Killswitch for the skeleton alone: jellyfin.shell.instantHomeSkeletonDisabled.
  // The overlay is a fixed full-screen div: pointer-events:none, aria-hidden,
  // zero tabbables (divs only) — it can never intercept focus or nav.
  // First paint records boot-phase ring mark "snap" (JEL-617 recorder);
  // window.__shellIH.skeleton flags a placeholder paint and .snapAgeMs the
  // painted snapshot's age (-1 for the skeleton).
  //
  // Dismiss (crossfade 400 ms): live home hydrated above-fold (>= 4
  // visible .card rects in-viewport), first remote keypress (keydown,
  // capture phase — pointer/mouse listeners are forbidden by the
  // playback-controls pin: seek/OSD clicks must pass through untouched),
  // a non-home route (login / selectserver /
  // wizard), partial hydration stall (> 8 s after first card), or a 90 s
  // absolute cap. The watch tick also re-creates the overlay after
  // document.write wipes the DOM (getElementById re-entry guard makes the
  // repaint idempotent and free on every other tick).
  //
  // JELA-43 (JELA-41 WS-1+2) — default ON since JELA-49 (JELA-48 ACCEPT);
  // per-behavior opt-out kill-switches:
  //
  // WS-1 input shield — ON unless
  // localStorage['jellyfin.shell.instantHomeInputShieldDisabled'] = '1'.
  // While the overlay is painted, keydowns are SWALLOWED (capture
  // phase preventDefault + stop(Immediate)Propagation; G.eaten counts them)
  // instead of dismissing into the still-shifting live page. Back/Return/Esc
  // (10009/461/27) is the mandatory escape hatch: always eaten AND dismisses
  // immediately (G.backEsc). If the Direct-Home grid is painted the shield
  // stands down (the grid owns input; the watch tick hands off via "dh").
  // JELA-54: with hold-cover on (default) the grid never paints and the "dh"
  // handoff is skipped, so the shield owns input for the full covered hold.
  // After any dismissal a 10 s moving-target Enter guard arms: a 200 ms
  // poller tracks document.activeElement's rect, and Enter (13) is eaten +
  // re-armed while that rect changed within the last 400 ms (G.entHeld), so
  // a late layout shift can never redirect a click onto the wrong card.
  // Pointer/mouse listeners remain forbidden (playback-controls pin).
  //
  // WS-2 settle-gated dismissal — ON unless
  // localStorage['jellyfin.shell.instantHomeSettleDismissDisabled'] = '1'.
  // Replaces
  // the >=4-cards-only "hydrated" dismissal with layout-settled: >= 4
  // above-fold cards AND document.styleSheets.length stable for 1.5 s AND no
  // above-fold DOM mutations (MutationObserver on documentElement, childList
  // + subtree + class/style/src attributes, target rect intersecting the
  // viewport) for 1.5 s -> dismiss("settled"), G.settleMs. Overlay hold is
  // hard-capped -> dismiss("settlecap") at 23 s (JELA-56 CEO decision,
  // Option B, 22 s + the sanctioned ±1 s re-QA tune: 2/4 hold boots
  // cap-forced at 22 s with settle missing by <1.5 s — measured
  // settle-after-flush is ~19–23+ s wall on the Q60R), tunable ONLY DOWN via
  // localStorage['jellyfin.shell.instantHomeSettleCapMs'] (1000..23000 ms;
  // anything else falls back to 23000 — never above). The partial-stall path
  // only fires below 4 cards while WS-2 is active (>= 4 unsettled must hold
  // to settle or cap, never "partial"). Without MutationObserver the mutation
  // gate degrades open (cards + stylesheet stability still gate). The 90 s
  // absolute cap stays as the kill-switched backstop.
  //
  // Capture: 1.5 s poll, armed in every document but only ever fires on
  // #/home with >= 5 above-fold cards stable across two consecutive ticks,
  // window scrollY <= 8 px (JELA-22: only ever snapshot the pristine
  // above-fold — the hero spotlight + first card row — never a scrolled-down
  // row like "Adventure", so the boot overlay always matches the settled,
  // unscrolled home the live client paints into), and our own overlay gone
  // (so it never snapshots itself). Serializes
  // above-fold .sectionTitle text + all visible img/background-image art
  // (http(s) only, deduped by rect) into localStorage, chunked at 24 KiB,
  // hard-capped at 300 KiB, meta written LAST and removed on any write
  // failure so a quota abort can never leave a torn snapshot. One capture
  // per boot; 5 min hard stop.
  //
  // Body constraints: ES5 only (runs pre-polyfill on Chromium 56/63), no
  // "</script" literal (string fast path splices it as raw HTML), every
  // section try/caught (additive-defensive; failures count into
  // window.__shellIH.err instead of breaking boot).
  // Kill switch: localStorage['jellyfin.shell.instantHomeDisabled'] = '1'.
  function instantHomeBody() {
    return (
      "(function(){try{" +
      'try{if(localStorage.getItem("jellyfin.shell.instantHomeDisabled")==="1")return}catch(_){}' +
      'var W=window,MK="jellyfin.shell.instantHome",OID="__shell_instant_home";' +
      "var G=W.__shellIH;" +
      'if(!G)G=W.__shellIH={gen:0,painted:0,paintMs:0,dismissed:0,why:"",dismissMs:0,captured:0,capMs:0,items:0,err:0,skeleton:0,snapAgeMs:-1,eaten:0,backEsc:0,entHeld:0,settleMs:-1};' +
      "var gen=++G.gen;" +
      "var t0=+new Date();" +
      "function el0(){try{return document.getElementById(OID)}catch(_){return null}}" +
      'function srv(){try{return localStorage.getItem("jellyfin.shell.serverUrl")||""}catch(_){return""}}' +
      'function authed(){try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return!1;var p=JSON.parse(c);return!!(p&&p.Servers&&p.Servers.length&&p.Servers[0].AccessToken)}catch(_){return!1}}' +
      // JELA-49: WS-1+2 default ON (JELA-48 ACCEPT); the "…Disabled" keys are
      // per-behavior opt-out kill-switches (plan §3 house rule). capLim()
      // accepts ONLY 1000..23000 ms (JELA-56 CEO decision — 22 s plus the
      // sanctioned ±1 s re-QA tune — for the hold-cover settled reveal;
      // still tunable DOWN only, never above 23000).
      // JELA-54 (user decision, JELA-52 ask 00d36d8f): HC = hold-cover. The
      // snapshot cover holds to the settled reveal (Netflix-splash) instead of
      // handing off to the Direct-Home grid mid-boot; the "dh" dismissal below
      // is skipped while HC is on (directHomeBody also stands down — see
      // __shellDHHeld there). Reveal timing: settled or the <= 23 s
      // settlecap; Back/Return/Esc stays the mandatory escape hatch.
      'function flg(k){try{return localStorage.getItem(k)==="1"}catch(_){return!1}}' +
      // Opt-OUT companion to flg (JELA-827 shape): an ABSENT key means ON, and
      // only the literal "0" stands the feature down. Fail-closed on a THROWING
      // localStorage — not for symmetry with flg, but because a device whose
      // getItem throws can never read its own kill switch, and an un-killable
      // feature is the one state no rollback can reach.
      'function flgO(k){try{return localStorage.getItem(k)!=="0"}catch(_){return!1}}' +
      'var SH=!flg("jellyfin.shell.instantHomeInputShieldDisabled"),SD=!flg("jellyfin.shell.instantHomeSettleDismissDisabled"),HC=!flg("jellyfin.shell.instantHomeHoldCoverDisabled");' +
      'function capLim(){try{var v=parseInt(localStorage.getItem("jellyfin.shell.instantHomeSettleCapMs"),10);if(v>=1000&&v<=23000)return v}catch(_){}return 23000}' +
      "function eatK(ev){try{ev.preventDefault&&ev.preventDefault()}catch(_){}try{ev.stopPropagation&&ev.stopPropagation()}catch(_){}try{ev.stopImmediatePropagation&&ev.stopImmediatePropagation()}catch(_){}}" +
      'function rk(e){try{if(!e||!e.getBoundingClientRect)return"";var r=e.getBoundingClientRect();return Math.round(r.left)+"_"+Math.round(r.top)+"_"+Math.round(r.width)+"_"+Math.round(r.height)}catch(_){return""}}' +
      // JELA-32 (WS-B): bounded snapshot max-age. Default 48 h so a stale
      // library never paints forever; operator-tunable via
      // localStorage["jellyfin.shell.instantHomeMaxAgeMs"] (any positive ms;
      // e.g. restore the old 7 d = 604800000) without a shell release. An
      // expired snapshot falls through to the first-boot skeleton below, so
      // the paint is bounded-fresh yet never blank.
      'function maxAge(){try{var v=parseInt(localStorage.getItem("jellyfin.shell.instantHomeMaxAgeMs"),10);if(v>0)return v}catch(_){}return 172800000}' +
      // JELA-32 (WS-B): first-boot skeleton killswitch (independent of the
      // master instantHomeDisabled) so the placeholder can be turned off while
      // real-snapshot repaint stays on.
      'function skOff(){try{return localStorage.getItem("jellyfin.shell.instantHomeSkeletonDisabled")==="1"}catch(_){return!1}}' +
      // JELA-32 (WS-B): synthetic above-fold placeholder (title bar + two card
      // rows w/ row labels) sized to the current viewport, painted ONLY when
      // authed and no valid snapshot exists (first-ever boot, expired, corrupt
      // or server-mismatch) so the very first launch is never blank. Content-
      // free (sk-tiles carry no library data), so it is server-agnostic and is
      // never itself captured.
      "function skel(){var vw=W.innerWidth||1920,vh=W.innerHeight||1080,it=[],mx=Math.round(vw*.035),gp=Math.round(vw*.014);" +
      "it.push({x:mx,y:Math.round(vh*.06),w:Math.round(vw*.34),h:Math.round(vh*.05),sk:1,r:6});" +
      "var cols=6,cw=Math.round((vw-2*mx-(cols-1)*gp)/cols),chh=Math.round(cw*.56),y0=Math.round(vh*.18),rg=chh+Math.round(vh*.1),r,c;" +
      "for(r=0;r<2;r++){var ry=y0+r*rg;it.push({x:mx,y:ry-Math.round(vh*.045),w:Math.round(vw*.16),h:Math.round(vh*.03),sk:1,r:4});" +
      "for(c=0;c<cols;c++)it.push({x:mx+c*(cw+gp),y:ry,w:cw,h:chh,sk:1,r:6})}return it}" +
      "function readSnap(){try{" +
      'var m=JSON.parse(localStorage.getItem(MK)||"null");' +
      "if(!m||m.v!==1||!m.n||m.n>40)return null;" +
      "if(m.srv&&m.srv!==srv())return null;" +
      "if(!m.ts)return null;" +
      "var age=+new Date()-m.ts;if(age>maxAge())return null;" +
      'var s="",i;' +
      'for(i=0;i<m.n;i++){var c=localStorage.getItem(MK+"."+i);if(c==null)return null;s+=c}' +
      "var d=JSON.parse(s);" +
      "if(!d||!d.items||d.items.length<4)return null;" +
      "d.w=m.w||1920;d.h=m.h||1080;d.age=age;" +
      "return d}catch(_){return null}}" +
      "function dismiss(why){" +
      "if(G.dismissed)return;" +
      "G.dismissed=1;G.why=why;G.dismissMs=+new Date()-(W.__shellT0||t0);" +
      "try{mo&&mo.disconnect()}catch(_){}" +
      "armEG();" +
      'try{var e=el0();if(e){e.style.opacity="0";setTimeout(function(){try{e.parentNode&&e.parentNode.removeChild(e)}catch(_){}},450)}}catch(_){}}' +
      // JELA-43 (WS-1): moving-target Enter guard, armed at dismissal (the
      // crossfade reveals a live page that can still be reflowing). For 10 s
      // a 200 ms poller fingerprints document.activeElement's rect; Enter is
      // eaten + re-armed while the focused rect changed within the last
      // 400 ms, so a shifting layout can never redirect the press onto a
      // moved card. The listener goes inert past the 10 s window (and on
      // gen turnover) instead of being removed — the window stub used by the
      // instant-home tests exposes no removeEventListener, and a per-gen
      // inert listener matches the oi lifecycle. Stands down while the
      // Direct-Home grid is painted (its own capture handler owns Enter).
      "function armEG(){if(!SH)return;try{" +
      'var dT=+new Date(),le=null,lk="",mvT=dT;' +
      "var gIv=setInterval(function(){try{var n2=+new Date();if(n2-dT>10000){clearInterval(gIv);return}var a=document.activeElement||null,k2=rk(a);if(a!==le||k2!==lk){mvT=n2;le=a;lk=k2}}catch(_){}},200);" +
      "var oe=function(ev){try{if(G.gen!==gen)return;if(+new Date()-dT>10000)return;if(W.__shellDH&&W.__shellDH.painted&&!W.__shellDH.dismissed)return;var k3=0;try{k3=ev.keyCode||ev.which||0}catch(_){}if(k3!==13)return;if(+new Date()-mvT<400){eatK(ev);G.entHeld=(G.entHeld||0)+1}}catch(_){G.err++}};" +
      'W.addEventListener("keydown",oe,!0)' +
      "}catch(_){G.err++}}" +
      "function paint(){try{" +
      "if(G.dismissed||el0())return;" +
      "var de=document.documentElement;" +
      "if(!de||!de.appendChild)return;" +
      "if(!authed())return;" +
      "var d=readSnap(),sk=0;" +
      "if(!d){if(skOff())return;d={items:skel(),age:-1};sk=1}" +
      "var vw=W.innerWidth||1920,vh=W.innerHeight||1080;" +
      "d.w=d.w||vw;d.h=d.h||vh;var rx=vw/d.w,ry=vh/d.h;" +
      'var e=document.createElement("div");' +
      "e.id=OID;" +
      'e.setAttribute("aria-hidden","true");' +
      'e.style.cssText="position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;background:#101010;pointer-events:none;overflow:hidden;opacity:1;transition:opacity .4s";' +
      "for(var i=0;i<d.items.length;i++){" +
      'var it=d.items[i],n=document.createElement("div");' +
      'var cs="position:absolute;left:"+Math.round(it.x*rx)+"px;top:"+Math.round(it.y*ry)+"px;width:"+Math.round(it.w*rx)+"px;height:"+Math.round(it.h*ry)+"px;";' +
      'if(it.sk){cs+="background:#1c1c1c;border-radius:"+((it.r|0)||6)+"px"}' +
      'else if(it.u){cs+="background:#1f1f1f url(\\""+String(it.u).replace(/["\\\\]/g,"")+"\\") center center no-repeat;background-size:cover;border-radius:"+((it.r|0)||4)+"px"}' +
      'else{n.textContent=it.s||"";cs+="color:#ccc;font:500 "+Math.round((it.fs||26)*ry)+"px/1.25 sans-serif;white-space:nowrap;overflow:hidden"}' +
      "n.style.cssText=cs;" +
      "e.appendChild(n)}" +
      "de.appendChild(e);" +
      'if(!G.painted){G.painted=1;G.skeleton=sk;G.snapAgeMs=d.age;G.paintMs=+new Date()-(W.__shellT0||t0);try{W.__shellPhase&&W.__shellPhase("snap")}catch(_){}}' +
      "}catch(_){G.err++}}" +
      'function folds(){var n=0;try{var cs=document.querySelectorAll(".card"),vh=W.innerHeight||1080;for(var i=0;i<cs.length&&n<12;i++){var r=cs[i].getBoundingClientRect();if(r.width>0&&r.height>0&&r.top<vh&&r.bottom>0)n++}}catch(_){}return n}' +
      // JELA-22 (JEL-647): window scroll offset, so capture only snapshots the
      // pristine above-fold (scrollY~0) and never a scrolled-down card row.
      "function scy(){try{var y=W.pageYOffset;if(y==null){var de=document.documentElement;y=de&&de.scrollTop}return+y||0}catch(_){return 0}}" +
      // JELA-37: document.open() (the SPA index handoff) wipes ALL window
      // listeners, and this body re-runs once per written document (gen++),
      // so the keydown bind must be per-run, not once-per-G — the old
      // persistent G.inputBound gate skipped the rebind after the swap,
      // leaving the post-swap overlay deaf to input until hydration (same
      // defect PR #82 fixed for Direct-Home). One body run per document
      // means no same-window double-bind; the gen guard in oi turns any
      // engine-quirk survivor listener inert instead of dismissing a newer
      // generation's overlay. G.inputBound stays as a bind-count diagnostic.
      // JELA-43 (WS-1): with the input shield on, keydowns are swallowed
      // while the overlay is up (never handed to the still-shifting live
      // page) instead of dismissing; Back/Return/Esc is the mandatory
      // always-works escape hatch (eaten + immediate dismiss). Shield stands
      // down when the overlay is absent (pass through untouched) or the
      // Direct-Home grid is painted (grid owns input; tick hands off "dh").
      // Flag off keeps the pre-JELA-43 first-keydown dismiss("input") path.
      "var oi=function(ev){if(G.gen!==gen)return;" +
      'if(!SH){dismiss("input");return}' +
      "if(G.dismissed||!el0())return;" +
      "if(W.__shellDH&&W.__shellDH.painted&&!W.__shellDH.dismissed)return;" +
      "var k=0;try{k=ev.keyCode||ev.which||0}catch(_){}" +
      'if(k===10009||k===461||k===27){G.backEsc=(G.backEsc||0)+1;eatK(ev);dismiss("back");return}' +
      "G.eaten=(G.eaten||0)+1;eatK(ev)};" +
      "G.inputBound=(G.inputBound||0)+1;" +
      'try{W.addEventListener("keydown",oi,!0)}catch(_){}' +
      "paint();" +
      // JELA-43 (WS-2): settle instrumentation. muT = last above-fold DOM
      // mutation (observer target rect intersects the viewport; text nodes
      // resolve to their parent; a throwing check counts as a mutation so
      // the gate fails closed). ssN/ssT track document.styleSheets.length
      // stability. Without MutationObserver (old engines, test stub) muT
      // stays t0 and the mutation gate degrades open. Observer armed AFTER
      // the initial paint so our own overlay append never resets the clock;
      // watch-tick repaints only happen mid document.write churn.
      "var mo=null,muT=t0,ssN=-1,ssT=t0;" +
      'if(SD){try{var MO=W.MutationObserver||W.WebKitMutationObserver;if(MO){mo=new MO(function(ms){try{var vh2=W.innerHeight||1080;for(var mi=0;mi<ms.length;mi++){var mt=ms[mi].target;if(mt&&mt.nodeType===3)mt=mt.parentNode;if(!mt||!mt.getBoundingClientRect){muT=+new Date();break}var mr=mt.getBoundingClientRect();if(mr.top<vh2&&mr.bottom>0){muT=+new Date();break}}}catch(_){muT=+new Date()}});mo.observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["class","style","src"]})}}catch(_){G.err++}}' +
      "var fc=0;" +
      "var wIv=setInterval(function(){try{" +
      "if(G.gen!==gen||G.dismissed){try{mo&&mo.disconnect()}catch(_){}clearInterval(wIv);return}" +
      'if(+new Date()-t0>90000){dismiss("cap");clearInterval(wIv);return}' +
      'var h="";try{h=String(location.hash||"")}catch(_){}' +
      'if(h.indexOf("login")!==-1||h.indexOf("selectserver")!==-1||h.indexOf("wizard")!==-1){dismiss("route");clearInterval(wIv);return}' +
      // JELA-33 (A3 fusion): the live Direct-Home grid replaces the static
      // crossfade — the snapshot hands off the moment the grid paints. In the
      // baked boot-shell __shellDH never exists, so this is a structural no-op
      // there (kept byte-identical for the cross-shell mirror guard).
      // JELA-54: skipped while HC (hold-cover) is on — the cover holds to the
      // settled reveal instead of the early "dh" handoff.
      'if(!HC&&W.__shellDH&&W.__shellDH.painted&&!W.__shellDH.dismissed){dismiss("dh");clearInterval(wIv);return}' +
      "paint();" +
      "var n=folds();" +
      // JELA-43 (WS-2): settle-gated dismissal replaces >=4-cards-only when
      // the flag is on — >=4 cards AND no above-fold mutation for 1.5 s AND
      // stylesheet count stable for 1.5 s -> "settled"; overlay hold is
      // hard-capped at capLim() (<= 23 s) -> "settlecap". The partial-stall
      // path fires only BELOW 4 cards here (>= 4 unsettled holds to settle
      // or cap). Flag off keeps the pre-JELA-43 "hydrated" dismissal.
      "if(SD){" +
      "var nw=+new Date();" +
      'if(nw-t0>capLim()){dismiss("settlecap");clearInterval(wIv);return}' +
      "var s2=0;try{s2=document.styleSheets?document.styleSheets.length:0}catch(_){}" +
      "if(s2!==ssN){ssN=s2;ssT=nw}" +
      'if(n>=4&&nw-muT>=1500&&nw-ssT>=1500){G.settleMs=nw-t0;dismiss("settled");clearInterval(wIv);return}' +
      "}else{" +
      'if(n>=4){dismiss("hydrated");clearInterval(wIv);return}' +
      "}" +
      'if((!SD||n<4)&&n>0){if(!fc)fc=+new Date();else if(+new Date()-fc>8000){dismiss("partial");clearInterval(wIv);return}}' +
      "}catch(_){G.err++}},700);" +
      "function capture(){try{" +
      "if(el0())return;" +
      "if(scy()>8)return;" +
      "var vw=W.innerWidth||1920,vh=W.innerHeight||1080,fold=vh*1.05,items=[],i,r;" +
      'var ts=document.querySelectorAll(".sectionTitle");' +
      "for(i=0;i<ts.length;i++){r=ts[i].getBoundingClientRect();" +
      "if(r.width>0&&r.height>0&&r.bottom>0&&r.top<fold){" +
      'var s=String(ts[i].textContent||"").replace(/^\\s+|\\s+$/g,"").slice(0,60);' +
      "var fs=24;try{fs=parseInt(getComputedStyle(ts[i]).fontSize,10)||24}catch(_){}" +
      "if(s)items.push({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),s:s,fs:fs})}}" +
      "var seen={},imgs=0;" +
      "var ns=document.querySelectorAll('img,[style*=\"background-image\"]');" +
      "for(i=0;i<ns.length&&items.length<90;i++){" +
      "r=ns[i].getBoundingClientRect();" +
      "if(!(r.width>=40&&r.height>=40&&r.bottom>0&&r.top<fold))continue;" +
      'var u="";' +
      'try{if(String(ns[i].tagName).toUpperCase()==="IMG")u=ns[i].currentSrc||ns[i].src||"";' +
      'else{var m=/url\\(([\'"]?)([^)]*?)\\1\\)/.exec(String(ns[i].style.backgroundImage||""));if(m)u=m[2]}}catch(_){}' +
      "if(!u||!/^https?:/.test(u)||u.length>600)continue;" +
      'var k=Math.round(r.left)+"_"+Math.round(r.top)+"_"+Math.round(r.width);' +
      "if(seen[k])continue;" +
      "seen[k]=1;" +
      "var rad=0;try{rad=parseInt(getComputedStyle(ns[i]).borderTopLeftRadius,10)||0}catch(_){}" +
      "items.push({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),u:u,r:rad});" +
      "imgs++}" +
      "if(imgs<4)return;" +
      "var body=JSON.stringify({items:items});" +
      "if(body.length>307200)return;" +
      "var CH=24576,n2=Math.ceil(body.length/CH);" +
      "try{" +
      'for(i=0;i<n2;i++)localStorage.setItem(MK+"."+i,body.substr(i*CH,CH));' +
      'for(var j=n2;j<64;j++){if(localStorage.getItem(MK+"."+j)==null)break;localStorage.removeItem(MK+"."+j)}' +
      "localStorage.setItem(MK,JSON.stringify({v:1,ts:+new Date(),n:n2,w:vw,h:vh,srv:srv()}));" +
      "}catch(e2){try{localStorage.removeItem(MK)}catch(_){}G.err++;return}" +
      "G.captured=1;G.capMs=+new Date()-(W.__shellT0||t0);G.items=items.length" +
      "}catch(_){G.err++}}" +
      "G.capGen=gen;" +
      "var st=0,ln=-1;" +
      "var cIv=setInterval(function(){try{" +
      "if(G.capGen!==gen||G.captured){clearInterval(cIv);return}" +
      "if(+new Date()-t0>300000){clearInterval(cIv);return}" +
      'var h="";try{h=String(location.hash||"")}catch(_){}' +
      'if(h.indexOf("home")===-1){st=0;ln=-1;return}' +
      "if(scy()>8){st=0;ln=-1;return}" +
      "var n=folds();" +
      "if(n<5){st=0;ln=n;return}" +
      "if(n===ln)st++;else{st=0;ln=n}" +
      "if(st>=2)capture()" +
      "}catch(_){G.err++}},1500);" +
      // JELA-44 (JELA-41 WS-3, opt-in, default OFF): cold-boot chunk/CSS
      // HTTP-cache warm under the boot cover.
      // localStorage['jellyfin.shell.chunkWarm'] = '1' fires bounded-parallel
      // (4-wide: Chromium 56 allows 6 connections/origin — two stay free so
      // the live page's own requests are never starved) server-origin GETs
      // (JELA-47: keyed on srv()'s ASSET origin, never the page origin — the
      // production Tizen app runs at file:///index.html, which made the old
      // page-origin guard permanently false on-device; every queued URL is
      // absolutized against srv() and cross-origin URLs are dropped) for
      // the lazy webpack chunks/CSS + stable-path plugin assets jellyfin-web
      // requests discovery-serially later in the boot (JELA-42 WS-0 list), so
      // a COLD boot's WAN waterfall collapses into the overlay window. Warm
      // boots already fetch everything by ~7 s (WS-0) — this targets the
      // first boot after a jellyfin-web/plugin update or a cache eviction.
      // Chunk URLs resolve LIVE: a fake chunk pushed into webpackChunk*
      // (JEL-436 precedent) captures __webpack_require__, then p + u(id) /
      // miniCssF(id) map the WS-0 chunk-id seed to the CURRENT build's hashed
      // filenames; ids absent from the live maps stringify with "undefined"
      // and are skipped (never a guessed hash, never a 404 storm — a future
      // build renaming ids degrades to a silent skip). The static seed keeps
      // only stable UNVERSIONED paths (?v= cache-busters would warm dead
      // URLs). One attempt per URL, response read+discarded (HTTP-cache warm
      // only, never eval'd), URLs already carried by a script/link tag (or a
      // data-shell-transpiled-from marker) are skipped so an in-flight page
      // request is never duplicated. Runs while the boot cover is up — the
      // Instant-Home overlay OR the A3-fused Direct-Home grid (production
      // directHome boots hand the snapshot off to the grid at G1 ~1.5-3 s,
      // BEFORE webpackChunk exists, so warming must survive the "dh"
      // dismissal); once BOTH are gone (user reached the live page) no new
      // fetch is issued and the <= 4 in-flight just complete (Chromium 56
      // has no AbortController). Counters: window.__shellCW
      // {on,started,q,f,e,sk,st,done,ms,wpc}; st: "done" | "dismiss"
      // (cover gone) | "cap" (60 s webpackChunk wait) | "push"
      // (fake-chunk push threw). Kill switch is the flag itself (default
      // OFF).
      "function cwCover(){try{var D=W.__shellDH;return!!((G.painted&&!G.dismissed)||(D&&D.painted&&!D.dismissed))}catch(_){return!1}}" +
      "function cwStart(cw,wr){try{" +
      "cw.started=1;cw.wpc=1;" +
      "var q=[],seen={},pend=0;" +
      // JELA-47: queue ABSOLUTE URLs only. Root-relative paths get srv()'s
      // origin (cwo) prefixed — the file:// page would otherwise resolve
      // them to dead file:/// URLs; already-absolute URLs (webpack auto
      // publicPath on the file:// deployment) must sit on cwo's origin;
      // anything else (cross-origin, protocol-relative, path-relative) is
      // dropped — never a cross-origin warm, never a guessed base.
      'function add(u2){u2=String(u2||"");var a2="";if(u2.charAt(0)==="/"&&u2.charAt(1)!=="/")a2=cwo+u2;else if(u2.indexOf(cwo+"/")===0)a2=u2;if(a2&&!seen[a2]){seen[a2]=1;q.push(a2)}}' +
      'var p="";try{p=String(wr.p||"")}catch(_){}' +
      "var cf=null;try{cf=wr.miniCssF||wr.k||null}catch(_){}" +
      'var CWI=["59258","en-us-json","84501","playAccessValidation-plugin","experimentalWarnings-plugin","htmlAudioPlayer-plugin","htmlVideoPlayer-plugin","photoPlayer-plugin","comicsPlayer-plugin","bookPlayer-plugin","youtubePlayer-plugin","backdropScreensaver-plugin","pdfPlayer-plugin","logoScreensaver-plugin","syncPlay-core-PlaybackCore","19907","syncPlay-core-Manager","syncPlay-ui-players-NoActivePlayer","syncPlay-plugin","45568","73233","32721","68603","69881","76542","4113","81954","home","home-html","hometab","node_modules.sortablejs","12011","24468"];' +
      // JELA-716: media-bar css warms the JELA-710 self-hosted URL; the old
      // root-relative /gh/ jsdelivr pin resolved against the server origin
      // and 404ed on prod — a spurious warm every CWS boot.
      // JELA-771: the 27 bare /JellyfinEnhanced/js/* module entries and the
      // /gh/ ratings.css pin are deleted — unreachable by construction: JE's
      // loadScripts always requests modules versioned (?v=<cachekey>), and
      // the JEL-406/407 legacy interceptor fetches versioned modules with
      // cache:"no-store", so nothing can ever read an HTTP-cache entry
      // warmed under the bare URL; the root-relative /gh/ pin 404ed on prod
      // (same class as the JELA-716 note above).
      'var CWS=["/web/themes/dark/theme.css","/web/blurhash.worker.bundle.js","/shell/fonts/mediabar-slideshowpure.css"];' +
      "var ci,r2;" +
      "for(ci=0;ci<CWI.length;ci++){" +
      'try{if(wr.u){r2=wr.u(CWI[ci]);if(typeof r2==="string"&&r2.indexOf("undefined")<0)add(p+r2)}}catch(_){}' +
      'try{if(cf){r2=cf(CWI[ci]);if(typeof r2==="string"&&r2.indexOf("undefined")<0)add(p+r2)}}catch(_){}}' +
      "for(ci=0;ci<CWS.length;ci++)add(CWS[ci]);" +
      "cw.q=q.length;" +
      'function fin(){if(!q.length&&!pend&&!cw.done){cw.done=1;cw.ms=+new Date()-(W.__shellT0||t0);if(!cw.st)cw.st="done"}}' +
      "function pump(){try{" +
      "if(cw.done)return;" +
      'if(!cwCover()&&q.length){q.length=0;if(!cw.st)cw.st="dismiss"}' +
      "var la=null;" +
      "while(pend<4&&q.length){" +
      "var u3=q.shift();" +
      'if(la===null){la=[];try{var es=document.querySelectorAll("script[src],link[href],script[data-shell-transpiled-from]");for(var li=0;li<es.length;li++){var ea=es[li];if(ea&&ea.getAttribute)la.push(String(ea.getAttribute("src")||ea.getAttribute("href")||ea.getAttribute("data-shell-transpiled-from")||""))}}catch(_){}}' +
      // JELA-47: match tags on the server-relative path — page tags carry
      // absolute URLs on the file:// deployment and root-relative ones on
      // same-origin pages; every queued URL is cwo+path, so slicing cwo off
      // matches both attr shapes.
      "var u5=u3.slice(cwo.length),hit=0;for(var hi=0;hi<la.length;hi++){if(la[hi].indexOf(u5)>=0){hit=1;break}}" +
      "if(hit){cw.sk++;continue}" +
      "(function(u4){pend++;" +
      'W.fetch(u4,{credentials:"omit"}).then(function(rs){if(!rs.ok)throw 0;return rs.text()}).then(function(){pend--;cw.f++;fin();pump()},function(){pend--;cw.e++;fin();pump()})' +
      "})(u3)}" +
      "fin()" +
      "}catch(_){G.err++}}" +
      "pump()" +
      "}catch(_){G.err++}}" +
      'if(flg("jellyfin.shell.chunkWarm")&&typeof W.fetch==="function"){try{' +
      // JELA-47: gate on the ASSET origin — cwo = srv()'s scheme://host[:port]
      // (empty/unparseable serverUrl keeps the warm inert). The page origin is
      // irrelevant: the production app boots at file:///index.html and
      // fetch() from there to srv()'s https origin works (ACAO via the Cache
      // Headers plugin, verified on-device in JELA-45). The old
      // page-origin===srv-origin comparison was permanently false on file://
      // and left the warm inert in production (unit jsdom origin masked it).
      'var cwo="";try{var cm=/^https?:\\/\\/[^\\/]+/.exec(srv()||"");if(cm)cwo=cm[0]}catch(_){}' +
      "if(cwo){" +
      "var cw0=W.__shellCW;" +
      'if(!cw0)cw0=W.__shellCW={on:1,started:0,q:0,f:0,e:0,sk:0,st:"",done:0,ms:-1,wpc:0};' +
      "var cwIv=setInterval(function(){try{" +
      "if(G.gen!==gen||cw0.started||cw0.done){clearInterval(cwIv);return}" +
      'if(+new Date()-t0>60000){if(!cw0.st)cw0.st="cap";cw0.done=1;clearInterval(cwIv);return}' +
      'if(G.dismissed&&!cwCover()){if(!cw0.st)cw0.st="dismiss";cw0.done=1;clearInterval(cwIv);return}' +
      "if(!cwCover())return;" +
      "var ck=null;for(var ki in W){if(/^webpackChunk/.test(ki)){ck=ki;break}}" +
      "if(!ck)return;" +
      'var ch=W[ck];if(!ch||typeof ch.push!=="function")return;' +
      "var wr0=null;" +
      'try{ch.push([["__shellCW_"+gen+"_"+(+new Date())],{},function(rq){wr0=rq}])}catch(_){if(!cw0.st)cw0.st="push";cw0.done=1;clearInterval(cwIv);return}' +
      "if(!wr0)return;" +
      "clearInterval(cwIv);" +
      "cwStart(cw0,wr0)" +
      "}catch(_){G.err++}},500)" +
      "}" +
      "}catch(_){G.err++}}" +
      // JELA-740 (accepted CEO confirmation 45f50c90): query-param auth for
      // API GETs. Shipped opt-in under JELA-740, seeded fleet-wide by the
      // JSI channel under JELA-788, and FLEET-ON / opt-OUT since JELA-839
      // (see the flip note at the bottom of this block).
      // Every jellyfin-web API call is cross-origin and carries
      // `Authorization` (measured: NOT X-Emby-Authorization), which is not
      // CORS-safelisted, so every GET costs preflight + request = two
      // serialized round trips (~94 OPTIONS per cold boot, 38-39 of them
      // before firstCard). Moving the token to the api_key query param
      // (accepted by the server on every probed boot endpoint: 200 +
      // ACAO:*, 401 without; server-side cost equal to header auth) makes
      // the GET a CORS-simple request - no preflight at all. Measured on
      // the M63 rig through a +50 ms/req h2 delay proxy, n=7/arm:
      // OPTIONS 94->7, firstCard median -600..-818 ms (p=0.006-0.010) and
      // variance collapse (6/7 shim boots inside a 31 ms band); prize
      // scales with RTT x critical-chain depth. Non-GETs, relative URLs,
      // Request-object fetch inputs, auth-header-less calls and URLs
      // already carrying api_key/ApiKey all pass through untouched
      // (= today's path); a request whose token cannot be parsed or whose
      // headers cannot be copied also falls through untouched (sk++), so
      // worst case is always today's boot. Installed FIRST in this body -
      // innermost under the hssPin/apiWarm wrappers - so it rewrites the
      // final URL the outer layers produce while their store keys/pins
      // keep matching pre-auth URLs. XHR path: open() records
      // method/url/async, setRequestHeader() buffers instead of applying
      // (headers cannot precede open, so buffering at the instance is
      // order-safe), send() re-opens on the rewritten URL (open resets
      // headers, none were applied yet) and replays the non-auth buffer.
      // One install per WINDOW (survives the document.write handoff).
      // Referer mitigation per the accepted tradeoff: a no-referrer meta
      // is (re)inserted per DOCUMENT under the same flag. Counters:
      // window.__shellQA {on,fr,xr,sw,sk,err} = fetch rewrites, xhr
      // rewrites, swallowed headers, skips, errors.
      //
      // JELA-839: FLEET-ON, opt-OUT — an ABSENT key now means ON. This could
      // not stay opt-in. The read site is here in instantHomeBody(), which
      // runs at shell boot, while the jp788seed entry that writes the "1"
      // lands only AFTER the lite->SPA handoff (JELA-802), so a seeded flag
      // arms ONE BOOT LATE (JELA-821/827/831). JELA-788's own rollout
      // recorded it and shipped anyway: boot 1 = 70 OPTIONS with __shellQA
      // absent, boot 2 = 3. Re-measured on the JELA-838 acceptance ring
      // (5 fresh-profile cold boots, live channel, live shell): 65-78
      // OPTIONS and ZERO api_key GETs on boot 1, against 10-13 OPTIONS on
      // the same profile's later boots — ~53 wasted round trips, ~16% of a
      // 411-request cold boot and 948 ms of aggregate server handling time,
      // every one of them on the critical path of a first install, a
      // re-install or a storage eviction. The preflight cache (JELA-709
      // Access-Control-Max-Age) is what makes boot 2 cheap, but a cache
      // cannot be warm on the boot that fills it, and its key is the full
      // URL including query — so a cold boot is exactly where this lever's
      // prize lives, and opt-in shipped the lever with its effect removed.
      // Both per-TV kills survive the flip and are independent:
      // localStorage['jellyfin.shell.queryAuth'] = '0' (a SET, never a
      // removeItem — an absent key is now an ON arm) and
      // ['jellyfin.shell.queryAuthDisabled'] = '1'. flgO fails CLOSED on a
      // throwing localStorage, so a device that cannot read its own kill
      // switch does not arm.
      'if(flgO("jellyfin.shell.queryAuth")&&!flg("jellyfin.shell.queryAuthDisabled")){try{' +
      'try{if(document.head&&!document.getElementById("__shellQAMeta")){var qMt=document.createElement("meta");qMt.id="__shellQAMeta";qMt.name="referrer";qMt.content="no-referrer";document.head.insertBefore(qMt,document.head.firstChild)}}catch(_){}' +
      "if(!W.__shellQA){" +
      "var qa=W.__shellQA={on:1,fr:0,xr:0,sw:0,sk:0,err:0};" +
      'var qaHN=["Authorization","X-Emby-Authorization","X-Emby-Token"];' +
      'var qaHdr=function(n){n=String(n||"").toLowerCase();return n==="authorization"||n==="x-emby-authorization"||n==="x-emby-token"};' +
      'var qaTok=function(n,v){n=String(n||"").toLowerCase();v=String(v||"");if(n==="x-emby-token")return v;var qm=/Token="([^"]*)"/.exec(v);return qm&&qm[1]?qm[1]:""};' +
      "var qaUrl=function(u){return/^https?:\\/\\//.test(u)&&!/[?&]api_?key=/i.test(u)};" +
      'var qaAdd=function(u,t){return u+(u.indexOf("?")<0?"?":"&")+"api_key="+encodeURIComponent(t)};' +
      'if(typeof W.fetch==="function"){try{var qF=W.fetch;W.fetch=function(qu,qo){try{' +
      'var qMm=qo&&qo.method?String(qo.method).toUpperCase():"GET";' +
      'if(qMm==="GET"&&typeof qu==="string"&&qo&&qo.headers&&qaUrl(qu)){' +
      'var qh=qo.headers,qt="",qp=0,qn=0,qh2=null,qi,qv,qk;' +
      'if(typeof qh.get==="function"&&typeof qh["delete"]==="function"){' +
      "for(qi=0;qi<3;qi++){qv=null;try{qv=qh.get(qaHN[qi])}catch(_){}if(qv){qp=1;if(!qt)qt=qaTok(qaHN[qi],qv)}}" +
      'if(qt){try{qh2=new W.Headers(qh);for(qi=0;qi<3;qi++){if(qh2.get(qaHN[qi])){qh2["delete"](qaHN[qi]);qn++}}}catch(_){qh2=null}}' +
      "}else{" +
      "for(qk in qh){if(qaHdr(qk)){qp=1;if(!qt)qt=qaTok(qk,qh[qk])}}" +
      "if(qt){qh2={};for(qk in qh){if(qaHdr(qk)){qn++;continue}qh2[qk]=qh[qk]}}" +
      "}" +
      "if(qt&&qh2){var qo2={},qk2;for(qk2 in qo)qo2[qk2]=qo[qk2];qo2.headers=qh2;qa.fr++;qa.sw+=qn;return qF.call(W,qaAdd(qu,qt),qo2)}" +
      "if(qp)qa.sk++" +
      "}" +
      "}catch(_){qa.err++}" +
      "return qF.apply(W,arguments)}}catch(_){qa.err++}}" +
      "try{var QP=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;" +
      "if(QP&&QP.open&&QP.setRequestHeader&&QP.send){" +
      "var qOp=QP.open,qSh=QP.setRequestHeader,qSe=QP.send;" +
      'QP.open=function(qm3,qu3){try{this.__qaM=String(qm3||"").toUpperCase();this.__qaU=String(qu3||"");this.__qaA=arguments.length>2?!!arguments[2]:!0;this.__qaB=null}catch(_){qa.err++}return qOp.apply(this,arguments)};' +
      'QP.setRequestHeader=function(qn3,qv3){try{if(this.__qaM==="GET"&&qaUrl(this.__qaU||"")){if(!this.__qaB)this.__qaB=[];this.__qaB.push([qn3,qv3]);return}}catch(_){qa.err++}return qSh.apply(this,arguments)};' +
      "QP.send=function(){try{" +
      "var qb=this.__qaB;" +
      "if(qb){this.__qaB=null;" +
      'var qt3="",qp3=0,qi3;' +
      "for(qi3=0;qi3<qb.length;qi3++){if(qaHdr(qb[qi3][0])){qp3=1;if(!qt3)qt3=qaTok(qb[qi3][0],qb[qi3][1])}}" +
      'if(qt3){try{qOp.call(this,this.__qaM,qaAdd(this.__qaU,qt3),this.__qaA)}catch(_){qt3="";qa.err++}}' +
      "if(qp3&&!qt3)qa.sk++;" +
      "for(qi3=0;qi3<qb.length;qi3++){if(qt3&&qaHdr(qb[qi3][0])){qa.sw++;continue}try{qSh.call(this,qb[qi3][0],qb[qi3][1])}catch(_){qa.err++}}" +
      "if(qt3)qa.xr++}" +
      "}catch(_){qa.err++}" +
      "return qSe.apply(this,arguments)};" +
      "}}catch(_){qa.err++}" +
      "}}catch(_){G.err++}}" +
      // JELA-703 (JELA-693 mitigation; upstream home-sections#269, drop this
      // if upstream fixes the key derivation): opt-in pinned pageHash for
      // /HomeScreen/Sections, default OFF via
      // localStorage['jellyfin.shell.hssPin']='1'. Patches window fetch/XHR
      // to append PageHash=<uuid>&Page=1&NumResultsPerPage=1000 to any GET
      // whose path ends /HomeScreen/Sections, so the request takes the
      // plugin's caching branch instead of the Guid.NewGuid() always-miss
      // path (measured on prod: median 2,943 ms fresh key -> 4 ms pinned,
      // n=12/arm, zero overlap — docs/hss-sections-cache-diagnosis.md).
      // SERVER-HEALTH lever only: the endpoint does not gate firstCard
      // (rho=0.145, n=17). The key is FNV-1a(userId + ":" + bucket) formatted
      // as a Guid — DETERMINISTIC so every load in a bucket presents the same
      // key, PER-USER because the plugin's cache reads are not user-scoped
      // (two users presenting one value would share a section list),
      // TIME-BUCKETED (default 3600 s; 'jellyfin.shell.hssPinBucketSecs'
      // accepts 60..86400) because nothing ever evicts entries — the bucket
      // bounds the frozen section list, the pinned shuffle order, and the
      // one leaked ~4 KB entry per (user,bucket). A URL already carrying a
      // PageHash (the plugin's own pagination mode) is never touched;
      // non-string fetch inputs pass through unpinned (= today's path).
      // Installed BEFORE the JELA-51/685 apiWarm patches in this same body
      // run, so the warm's Sections XHR is pinned too (its first hit seeds
      // the entry the SPA's pinned request then finds) while apiWarm records
      // pre-rewrite URLs and its store keys keep matching. One install per
      // WINDOW (survives the document.write handoff); counters:
      // window.__shellPH {on,n,b,u}.
      'if(flg("jellyfin.shell.hssPin")&&!W.__shellPH){try{' +
      'var ph=W.__shellPH={on:1,n:0,b:0,u:""};' +
      'var phB=3600;try{var pb0=parseInt(localStorage.getItem("jellyfin.shell.hssPinBucketSecs")||"",10);if(pb0>=60&&pb0<=86400)phB=pb0}catch(_){}' +
      "var phH=function(s,h){for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h};" +
      'var phX=function(n){return("0000000"+n.toString(16)).slice(-8)};' +
      'var phKey=function(){try{var c1=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null"),s1=c1&&c1.Servers&&c1.Servers[0],u1=s1&&s1.UserId;if(!u1)return"";' +
      'var bk=Math.floor(+new Date()/(phB*1000)),sd=String(u1)+":"+bk;' +
      'var ha=phH(sd+"#0",2166136261),hb=phH(sd+"#1",2166136261),hc=phH(sd+"#2",2166136261),hd=phH(sd+"#3",2166136261);' +
      'ph.b=bk;ph.u=phX(ha)+"-"+phX(hb).slice(0,4)+"-"+phX(hb).slice(4)+"-"+phX(hc).slice(0,4)+"-"+phX(hc).slice(4)+phX(hd);return ph.u}catch(_){return""}};' +
      'var phRw=function(u){try{u=String(u||"");var pq=u.indexOf("?"),pp=pq<0?u:u.slice(0,pq);' +
      "if(!/\\/HomeScreen\\/Sections$/.test(pp))return u;" +
      "if(/[?&][Pp]age[Hh]ash=/.test(u))return u;" +
      "var k=phKey();if(!k)return u;ph.n++;" +
      'return u+(pq<0?"?":"&")+"PageHash="+k+"&Page=1&NumResultsPerPage=1000"}catch(_){return u}};' +
      'if(typeof W.fetch==="function"){try{var pF=W.fetch;W.fetch=function(pu,po){try{' +
      'var pm=po&&po.method?String(po.method).toUpperCase():"GET";' +
      'if(pm==="GET"&&typeof pu==="string")pu=phRw(pu)' +
      "}catch(_){G.err++}" +
      "return pF.call(W,pu,po)}}catch(_){G.err++}}" +
      "try{var PX=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(PX&&PX.open){var pO2=PX.open;" +
      'PX.open=function(pm2,pu2){var pa=arguments,pn=arguments.length;try{if(String(pm2||"").toUpperCase()==="GET"){var pr2=phRw(String(pu2||""));if(pr2!==String(pu2||"")){pa=[pm2,pr2];for(var pj2=2;pj2<pn;pj2++)pa.push(arguments[pj2])}}}catch(_){G.err++}return pO2.apply(this,pa)}}}catch(_){G.err++}' +
      "}catch(_){G.err++}}" +
      // JELA-724: in-flight GET coalescer for allowlisted API paths.
      //
      // Plugin Pages 2.4.11.0 (/PluginPages/inject.js) drives its sidebar
      // from a MutationObserver whose `initialized` guard is tested ONCE per
      // callback, at the top of mutationHandler — but populateSidebar() is
      // called from INSIDE the mutationRecords.forEach / addedNodes.some
      // walk, with no guard of its own. Every added node in the batch that
      // first carries .mainDrawer-scrollContainer > .userMenuOptions
      // therefore issues its own ApiClient.getJSON('PluginPages/User'). The
      // JELA-720 census caught SIX identical GETs inside a 6 ms window on
      // both cold boots — 12 round trips (getJSON sets X-Emby-Authorization,
      // so each GET drags its own CORS preflight) for one 345-byte body that
      // is byte-stable across all six responses and across both boots.
      //
      // Why nothing we already ship absorbs it:
      //   - JELA-709's Access-Control-Max-Age cannot: all six preflights are
      //     in flight before any of them returns, so there is no cached
      //     preflight for five of them to hit.
      //   - The JELA-51 api-warm store below is ONE-SHOT (chk() deletes the
      //     slot it serves), so even with the full AWL enabled — which lists
      //     /PluginPages/User — it would absorb request 1 and let 2..6 out.
      // It needs true in-flight coalescing, the same shape HomeScreenSections
      // does server-side (JELA-685); this does it client-side.
      //
      // Contract: concurrent identical GETs to an allowlisted path share ONE
      // network request. Every caller — the leader included — gets its OWN
      // Response synthesized from the leader's snapshotted status/headers/
      // body, so a body is never consumed twice and no caller can drain
      // another's. Nothing was cached in the JELA-724 shape: the slot was
      // released the moment the leader's body was read, so a later GET always
      // re-fetched. JELA-752 adds a bounded replay window on top of that —
      // see change 4 below. A leader that rejects replays each waiter on the
      // real network (worst case = today's behaviour).
      //
      // Allowlisted rather than global on purpose. The leader's body is
      // snapshotted to text, so a global list would buffer arbitrary
      // payloads; and GETs that differ only in headers (Range) must never
      // share one response. For the same reason a Request object, a body, or
      // an AbortSignal opts the call out entirely — we only coalesce a plain
      // string-URL GET whose every parameter is in the URL.
      //
      // Field-tunable without a shell release:
      // localStorage['jellyfin.shell.fetchCoalescePaths'] appends
      // comma-separated paths (each must start with "/", 32 max).
      // localStorage['jellyfin.shell.fetchCoalesceWindowMs'] sets the JELA-752
      // replay window in ms (0..2000; 0 = in-flight only, the JELA-724 shape).
      // Kill-switch: localStorage['jellyfin.shell.fetchCoalesceDisabled']='1'.
      // Counters: window.__shellFC {on,n,w,lead,join,win,serve,rep,hdr,fl,err}.
      // Installed BEFORE the api-warm patch below, so the warm store still
      // gets first refusal and only its fallthrough reaches the coalescer.
      // JELA-752: the SAME machinery, widened to the item-detail route.
      //
      // A CDP census of 5 detail opens (JELA-750, 4 primed profiles) found the
      // detail route re-issuing 19-44% of its requests to the byte-identical
      // URL, against a 4.4-5.8% baseline for the rest of the app. The worst
      // offender is GET /Users/{u}/Items/{id} — FOUR concurrent copies of one
      // 6.2-8.9 KB body on every open, all inside ~250 ms — and a series open
      // adds SIX concurrent /JellyfinEnhanced/jellyseerr/user-status. Because
      // every one is cross-origin the true cost is ~2x that (each duplicate
      // drags its own preflight): one series open cost 73 requests / 690 KB.
      //
      // 29 of the 30 duplicate extras measured genuinely OVERLAP in flight, so
      // an in-flight join collapses them. (This is the opposite of JELA-742,
      // whose alias pair is 300-874 ms apart and explicitly NOT joinable.)
      //
      // Three changes to the JELA-724 shape, all of them measurement-driven:
      //
      //  1. Segment wildcards. The detail set is keyed by user and item id, so
      //     a plain suffix list cannot express it. A pattern containing "*"
      //     matches per SEGMENT against the tail of the path ("/Users/*/Items/*"),
      //     which keeps the suffix semantics that make the list base-path safe.
      //     "*" never matches an empty segment, so "/Users/*/Items/*" does not
      //     also swallow the (different, and separately listed) "/Users/*/Items".
      //
      //  2. The key carries credentials + mode, not just the URL. The census
      //     showed the SAME url fetched with credentials:"same-origin" and with
      //     credentials unset (/System/Info/Public, /JellyfinEnhanced/version) —
      //     those are the same mode, so the key normalises unset to the fetch
      //     defaults ("same-origin"/"cors") and they still join. Mode is in the
      //     key for the reverse reason: a no-cors fetch yields an OPAQUE
      //     response, and handing that to a cors caller would be a silent
      //     miscompare — the same request-mode collision JELA-707 hit in the
      //     HTTP cache.
      //
      //  3. Conditional/ranged GETs opt out. Two callers may send the same URL
      //     with different Range / If-None-Match / If-Modified-Since and get
      //     legitimately different bodies (or a 304 only one of them can read),
      //     so those never share a slot. Anything we cannot parse counts as
      //     unsafe and passes through.
      //
      //  4. A bounded REPLAY WINDOW, because a pure in-flight join is
      //     self-limiting. Measured: with the join on, the /Users/{u}/Items/{id}
      //     responses get FASTER (152 -> 70 ms), so the surviving calls stop
      //     overlapping at all (spans 0-70 / 78-139 / 217-274 ms) and the later
      //     two can no longer be joined — a faster leader releases its slot
      //     sooner, which is exactly why "concurrent today" does not mean
      //     "collapsible to 1". A/B arm=on n=9 opens stalled at 4 extras per
      //     movie open against an AC2 target of <=2. So the leader's snapshot
      //     is now HELD in its slot for a short window after it settles
      //     (default 400 ms; the whole duplicate burst spans ~274 ms) and
      //     replayed to any later identical GET.
      //
      //     The staleness this buys is bounded three ways: only 2xx snapshots
      //     are held (an opaque no-cors response has status 0 and is dropped
      //     at once), the window is <= 2 s and is disabled entirely by setting
      //     localStorage['jellyfin.shell.fetchCoalesceWindowMs']='0' (which
      //     restores the exact JELA-724 behaviour), and ANY mutation flushes
      //     the whole map — a non-GET/HEAD request over fetch OR over XHR, so
      //     a "mark watched" POST followed by a re-read of /Users/*/Items/*
      //     cannot be served the pre-mutation body. XHR is hooked here only
      //     for that flush; joining XHR itself is out of scope.
      //
      // Not fixed here, deliberately: /Items/{id}/ThemeMedia is issued twice
      // per open over XMLHttpRequest, not fetch (confirmed by an in-page
      // transport probe), so a fetch-level join cannot see it. It is the single
      // residual duplicate per open and is left for an XHR-level pass.
      'if(!flg("jellyfin.shell.fetchCoalesceDisabled")&&!W.__shellFC&&typeof W.fetch==="function"&&typeof Response==="function"){try{' +
      'var FCL=["/PluginPages/User","/Users/*/Items/*","/Users/*/Items","/Items/*/Similar","/JellyfinEnhanced/tag-cache/*","/JellyfinEnhanced/user-settings/*/settings.json","/JellyfinEnhanced/tmdb/*/*/reviews","/JellyfinEnhanced/jellyseerr/user-status","/Shows/*/Seasons","/Shows/NextUp","/LiveTv/Programs"];' +
      'try{var fcx=String(localStorage.getItem("jellyfin.shell.fetchCoalescePaths")||"").replace(/\\s+/g,"").split(","),fci;for(fci=0;fci<fcx.length;fci++)if(fcx[fci].charAt(0)==="/"&&FCL.length<32)FCL.push(fcx[fci])}catch(_){}' +
      // JELA-752 replay window, ms. Anything unparseable or out of range keeps
      // the default; "0" restores the JELA-724 in-flight-only behaviour.
      'var fcW=400;try{var fcwv=localStorage.getItem("jellyfin.shell.fetchCoalesceWindowMs");' +
      'if(fcwv!==null&&fcwv!==""){fcwv=parseInt(fcwv,10);if(fcwv>=0&&fcwv<=2000)fcW=fcwv}}catch(_){}' +
      // JELA-758: a SECOND, much longer window for pure DELTA POLLS.
      //
      // /JellyfinEnhanced/tag-cache/{u}?since=<ts> is the only exact-URL
      // duplicate on the search route — a JELA-756 census of three typed
      // six-character queries found it NINE times per session in 3/3 samples,
      // every one carrying the byte-identical `since=` cursor (the plugin
      // never advances it), so all nine ask the server the same question and
      // get the same answer. The bursts are ~700 ms apart, not concurrent, so
      // neither the JELA-724 in-flight join nor the JELA-752 400 ms replay
      // window can see them: by the time poll N+1 arrives, poll N's slot is
      // long gone.
      //
      // Kept as a separate knob rather than raising fcW because the two are
      // different bets. fcW is a duplicate-burst absorber and its staleness is
      // measured in one render frame; this is a poll damper whose staleness is
      // "how late may a tag edit appear on screen". 15 s is well inside the
      // plugin's own refresh cadence, and every bound that makes fcW safe
      // still applies unchanged: 2xx only, and ANY mutation over fetch or XHR
      // flushes the whole map. Setting fetchCoalesceWindowMs='0' disables this
      // too, so that key still restores the exact JELA-724 behaviour.
      'var fcWL=15000;try{var fclv=localStorage.getItem("jellyfin.shell.fetchCoalesceDeltaWindowMs");' +
      'if(fclv!==null&&fclv!==""){fclv=parseInt(fclv,10);if(fclv>=0&&fclv<=300000)fcWL=fclv}}catch(_){}' +
      "var fcDR=/\\/JellyfinEnhanced\\/tag-cache\\//;" +
      "var FC=W.__shellFC={on:1,n:FCL.length,w:fcW,lead:0,join:0,win:0,serve:0,rep:0,hdr:0,fl:0,err:0},fcQ={},fcS={};" +
      // Any mutation drops every held snapshot — see change 4 above. In-flight
      // leaders are dropped from the map too; they still settle, and fcRel's
      // identity check keeps them from evicting a slot they no longer own.
      "var fcFl=function(){try{fcQ={};fcS={};FC.fl++}catch(_){FC.err++}};" +
      // Precompute the matcher once: plain entries keep the JELA-724 suffix
      // test, "*" entries become a segment array matched against the path tail.
      'var FCP=[],fcb,fcp,fca;for(fcb=0;fcb<FCL.length;fcb++){fcp=FCL[fcb];if(fcp.indexOf("*")<0){FCP.push({w:0,p:fcp})}else{fca=fcp.split("/");if(fca[0]==="")fca=fca.slice(1);FCP.push({w:1,a:fca})}}' +
      // A GET whose response varies by request header must never share a slot.
      // Headers may arrive as a Headers instance, an array of pairs, or a plain
      // object; anything we cannot walk is treated as unsafe (return 1).
      "var fcRe=/^(range|if-none-match|if-modified-since)$/i;" +
      "var fcUns=function(fo){try{if(!fo||!fo.headers)return 0;var fh=fo.headers,fb=0,fi3,fn3;" +
      'if(Object.prototype.toString.call(fh)==="[object Array]"){for(fi3=0;fi3<fh.length;fi3++)if(fh[fi3]&&fcRe.test(String(fh[fi3][0])))fb=1;return fb}' +
      'if(typeof fh.forEach==="function"){fh.forEach(function(fv3,fk3){if(fcRe.test(String(fk3)))fb=1});return fb}' +
      "for(fn3 in fh)if(fcRe.test(fn3))fb=1;return fb}catch(_){return 1}};" +
      'var fcK=function(u){var fh=u.indexOf("#");if(fh>=0)u=u.slice(0,fh);' +
      'var fq=u.indexOf("?"),fp=fq<0?u:u.slice(0,fq),fbs=fp.split("/");' +
      "for(var fi2=0;fi2<FCP.length;fi2++){var fe2=FCP[fi2];" +
      "if(!fe2.w){var fs2=fe2.p;if(fp===fs2||fp.length>fs2.length&&fp.slice(-fs2.length)===fs2)return u;continue}" +
      "var fa2=fe2.a;if(fbs.length<fa2.length)continue;var fof=fbs.length-fa2.length,fok=1,fj2;" +
      'for(fj2=0;fj2<fa2.length;fj2++){var fx2=fa2[fj2],fy2=fbs[fof+fj2];if(fx2==="*"){if(!fy2){fok=0;break}continue}if(fx2!==fy2){fok=0;break}}' +
      'if(fok)return u}return""};' +
      "var fcSnap=function(fr){return fr.text().then(function(ft){var fhs={};" +
      'try{fr.headers.forEach(function(fv,fn2){fhs[fn2]=fv})}catch(_){try{var fct=fr.headers.get("content-type");if(fct)fhs["content-type"]=fct}catch(__){}}' +
      'return{s:fr.status,x:fr.statusText||"",h:fhs,b:ft}})};' +
      "var fcMk=function(fd){var fst=fd.s||200;" +
      "return new Response(fst===204||fst===205||fst===304?null:fd.b,{status:fst,statusText:fd.x,headers:fd.h})};" +
      // Slot release. Only a 2xx snapshot is held, and only for fcW ms; every
      // other outcome frees the slot at once, exactly as JELA-724 did. The
      // fcQ[fkx]!==fex guard is what makes fcFl() safe: once a flush (or an
      // earlier expiry) has replaced the map, this leader owns nothing and
      // must not evict whoever does.
      // JELA-758: delta-poll paths hold for fcWL instead of fcW, but only while
      // fcW itself is enabled — "0" must keep meaning "no replay at all".
      "var fcRel=function(fkx,fex,fd){try{if(fcQ[fkx]!==fex)return;" +
      "var fww=fcW?(fcDR.test(fkx)?fcWL:fcW):0;" +
      "if(!fww||!(fd.s>=200&&fd.s<300)){delete fcQ[fkx];return}" +
      "fcS[fkx]=1;setTimeout(function(){try{if(fcQ[fkx]===fex){delete fcQ[fkx];delete fcS[fkx]}}catch(_){FC.err++}},fww)}" +
      "catch(_){FC.err++;try{delete fcQ[fkx]}catch(__){}}};" +
      "var fcF=W.fetch;W.fetch=function(fu,fo){try{" +
      'var fcm=fo&&fo.method?String(fo.method).toUpperCase():"GET";' +
      'if(fcm!=="GET"&&fcm!=="HEAD"){fcFl()}' +
      'else if(fcm==="GET"&&typeof fu==="string"&&!(fo&&(fo.body||fo.signal))){' +
      "var fk=fcK(fu);" +
      'if(fk&&fcUns(fo)){FC.hdr++;fk=""}' +
      // (method, credentials, mode, full URL) — unset credentials/mode
      // normalise to the fetch defaults so they join their explicit twins.
      'if(fk)fk="GET "+(fo&&fo.credentials?String(fo.credentials):"same-origin")+" "+(fo&&fo.mode?String(fo.mode):"cors")+" "+fk;' +
      "if(fk){var fe=fcQ[fk];" +
      "if(fe){if(fcS[fk])FC.win++;else FC.join++;" +
      "return fe.then(function(fd){FC.serve++;return fcMk(fd)},function(){FC.rep++;return fcF.call(W,fu,fo)})}" +
      "FC.lead++;" +
      "fe=fcQ[fk]=fcF.call(W,fu,fo).then(fcSnap).then(function(fd){fcRel(fk,fe,fd);return fd},function(fer){if(fcQ[fk]===fe)delete fcQ[fk];throw fer});" +
      "return fe.then(function(fd){FC.serve++;return fcMk(fd)})}}" +
      "}catch(_){FC.err++}" +
      "return fcF.apply(W,arguments)};" +
      // XHR is hooked ONLY so a non-GET over XHR flushes the held snapshots —
      // the legacy apiclient does not send every mutation over fetch. Joining
      // XHR GETs is deliberately out of scope (see ThemeMedia below).
      "try{var FPX=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(FPX&&FPX.open){var fxO=FPX.open;" +
      'FPX.open=function(fxm){try{var fxv=String(fxm||"").toUpperCase();if(fxv!=="GET"&&fxv!=="HEAD")fcFl()}catch(_){FC.err++}' +
      "return fxO.apply(this,arguments)}}}catch(_){FC.err++}" +
      "}catch(_){G.err++}}" +
      // JELA-830: coalesce the boot `Ids=` hydration burst by ID-UNION, not by
      // byte-identical URL.
      //
      // The JELA-829 census (ATTR-b1-boot, shell a171f117, fleet flag state)
      // found ELEVEN boot GETs carrying `Ids=`. Between them they ask for 339
      // item ids of which only 144 are distinct — the same items fetched 2.35x
      // over. Three of them (+30 407 / +30 436 / +30 469 ms) land inside 62 ms
      // of each other with pairwise 100% id overlap: the same 21 items, three
      // times, differing ONLY in which `Fields` are asked for.
      //
      // The coalescer above cannot see any of them. `/Users/*/Items` is already
      // on its allowlist, but its key is the byte-identical URL and no two of
      // these eleven URLs are identical — every one carries a different `Ids=`
      // list. So this is not a wider window or another allowlist entry; it is a
      // different key.
      //
      // Shape: a short BATCH window per (route, credentials, mode, headers,
      // non-unionable query). Requests that land in the window are held, their
      // id lists are unioned into ONE request, and each waiter is served a
      // response sliced back down to exactly the ids it asked for. Simulated
      // against the census capture: 11 -> 8 at a 150 ms window, 11 -> 6 at
      // 250 ms (the default), 11 -> 5 at 800 ms.
      //
      // The window is a real delay — the batch is NOT sent until it closes —
      // so this is only affordable because the whole burst fires at +19 s to
      // +30 s, long after firstCard. It is post-paint hydration latency, never
      // paint latency. A batch that closes with ONE member is re-issued with
      // its ORIGINAL url and init, untouched: a singleton pays the window but
      // takes on no rewrite risk at all.
      //
      // What may be unioned, and why each is safe (Jellyfin defaults matter
      // here — for several of these "absent" is the PERMISSIVE value, so a
      // naive union would RESTRICT a caller that asked for nothing):
      //
      //   Ids                    unioned; that is the whole point.
      //   Limit                  set to the union's id count. MUST be >= it or
      //                          the server truncates somebody's items.
      //   Fields                 unioned. `Fields` is purely additive on top of
      //                          the base DTO, so a union is always a superset.
      //   EnableUserData         absent means TRUE -> OR. Superset.
      //   EnableTotalRecordCount forced FALSE on the wire and SYNTHESIZED per
      //                          slice — see below.
      //
      // Everything else — api_key, SortBy, IncludeItemTypes, ParentId, AND THE
      // THREE IMAGE-SHAPE PARAMETERS (EnableImages, EnableImageTypes,
      // ImageTypeLimit) — is part of the batch key, so it is never merged
      // across and is carried onto the union URL verbatim. The base path is in
      // the key too, which is what keeps `/Items?Ids=` and
      // `/Users/{u}/Items?Ids=` — different routes, one of which ignores user
      // data — in separate batches.
      //
      // The image parameters are in the KEY and not in the union because the
      // first rig A/B measured what unioning them costs. `EnableImageTypes`
      // absent means ALL image types and `ImageTypeLimit` absent means
      // unlimited, so a union has to DROP them whenever one member omits them —
      // unioning "Primary" with "absent" would strip Backdrop/Logo from the
      // member that asked for everything. Dropping them is correct, and it is
      // also expensive: the boot tail (21 + 21 + 6 ids at 171 / 213 / 204 B per
      // item, 9,298 B in three requests) came back as ONE 24-id union at 493 B
      // per item — 11,835 B. Two requests saved, 2.5 KB paid. That is the wrong
      // trade, and it is not a tuning problem: an unrestricted image shape is
      // ~2.5x the per-item cost. Keyed instead, the same tail merges the two
      // members that share an image shape and leaves the third alone — one
      // request saved and bytes DOWN.
      //
      // EnableTotalRecordCount: the census listed "only merge ETRC=false" as a
      // constraint, on the grounds that a caller wanting the count cannot be
      // served from a filtered slice. That constraint is DISCHARGED here rather
      // than obeyed, because for an `Ids=`-bounded query the count is derivable
      // exactly: `Ids` caps the result set at |Ids|, so whenever `Limit` >=
      // |Ids| and `StartIndex` is 0 the server cannot truncate, and
      // TotalRecordCount is identically Items.length. The slice therefore sets
      // TotalRecordCount = its own length and is byte-for-byte what the server
      // would have answered. Both preconditions are ENFORCED: a member with
      // StartIndex > 0, or with a Limit below its own id count, is refused the
      // batch and goes to the network alone. (Obeying the constraint literally
      // would have left requests 0/1/2/4 — none of which sends ETRC at all —
      // unmergeable, for 11 -> 8 instead of 11 -> 6.)
      //
      // Ordering: the union response is sliced by walking the SERVER's item
      // order and keeping the member's ids, so each waiter sees its items in
      // the same relative order the server would have returned them (sort is
      // consistent, and `SortBy` is in the key so a batch never mixes sorts).
      //
      // Opt-outs, all matching the coalescer above: a Request object, a body or
      // an AbortSignal opts the call out; Range / If-None-Match /
      // If-Modified-Since opt it out; request headers are part of the key, and
      // headers we cannot walk opt the call out entirely.
      //
      // Fallback: a non-2xx union, a body that will not parse, or a body with
      // no `Items` array replays EVERY waiter on the real network — worst case
      // is today's behaviour plus one wasted request. Slices are all built
      // BEFORE any waiter is resolved, so a mid-slice throw cannot leave half
      // the batch resolved and half replayed.
      //
      // JELA-831: FLEET-ON, opt-OUT. This shipped opt-in under JELA-830 and
      // was seeded nowhere. It could not stay opt-in: the read site is here in
      // instantHomeBody(), which runs at shell boot, while any JSI-channel seed
      // lands only AFTER the lite->SPA handoff (JELA-802), so a seeded "1"
      // would arm ONE BOOT LATE (JELA-821/827). The burst this coalesces is a
      // COLD-boot burst, so boot-1-dark is precisely where the prize lives —
      // arming by seeder would have shipped the flip with its effect removed.
      // An absent key therefore now means ON.
      // Per-TV kill: localStorage['jellyfin.shell.fcIdsUnion'] = '0' — a SET,
      // never a removeItem, which is now an ON arm. Setting the window to '0'
      // (below) is a second, independent stand-down.
      // Window: localStorage['jellyfin.shell.fcIdsUnionWindowMs']
      // (0..2000, default 250; 0 stands the shim down).
      // Counters: window.__shellFCU {on,w,seen,skip,batch,fire,sing,serve,
      // items,short,absent,fb,err}. The saving is (batch - fire - sing);
      // `short` is the correctness invariant and must stay 0 — it counts ids a
      // waiter asked for that WERE in the union response and yet did not reach
      // its slice, which is the only way the id normalisation could be wrong.
      'if(flgO("jellyfin.shell.fcIdsUnion")&&!W.__shellFCU&&typeof W.fetch==="function"&&typeof Response==="function"&&typeof Promise==="function"){try{' +
      'var iuW=250;try{var iuwv=localStorage.getItem("jellyfin.shell.fcIdsUnionWindowMs");' +
      'if(iuwv!==null&&iuwv!==""){iuwv=parseInt(iuwv,10);if(iuwv>=0&&iuwv<=2000)iuW=iuwv}}catch(_){}' +
      "if(iuW>0){" +
      // Caps. iuMx bounds the union's id count; iuUL bounds the generated URL
      // so a batch can never outgrow Kestrel's request-line limit.
      "var iuMx=200,iuUL=6000;" +
      "var IU=W.__shellFCU={on:1,w:iuW,seen:0,skip:0,batch:0,fire:0,sing:0,serve:0,items:0,short:0,absent:0,fb:0,err:0},iuB={};" +
      // Ids may arrive dashed or undashed and in either case; the response's
      // .Id is undashed lower hex. Normalise both sides before matching.
      'var iuNz=function(s){return String(s).toLowerCase().replace(/-/g,"")};' +
      'var iuDe=function(s){try{return decodeURIComponent(String(s).replace(/\\+/g," "))}catch(_){return String(s)}};' +
      "var iuRe=/^(range|if-none-match|if-modified-since)$/;" +
      // Header digest: identical headers join, different headers never do, and
      // anything we cannot walk (or that varies the body) returns null = skip.
      'var iuHd=function(o2){try{if(!o2||!o2.headers)return"";var h2=o2.headers,a2=[],i2,n2;' +
      'var pu=function(n3,v3){n3=String(n3).toLowerCase();if(iuRe.test(n3))a2=null;else if(a2)a2.push(n3+":"+String(v3))};' +
      'if(Object.prototype.toString.call(h2)==="[object Array]"){for(i2=0;i2<h2.length;i2++)if(h2[i2])pu(h2[i2][0],h2[i2][1])}' +
      'else if(typeof h2.forEach==="function"){h2.forEach(function(v3,n3){pu(n3,v3)})}' +
      "else{for(n2 in h2)pu(n2,h2[n2])}" +
      'if(!a2)return null;a2.sort();return a2.join("|")}catch(_){return null}};' +
      "var iuUn=/^(ids|limit|fields|enableuserdata|enabletotalrecordcount|startindex)$/;" +
      // Parse one candidate URL. Returns null for anything not an /Items route
      // with a non-empty Ids list, or anything whose Limit/StartIndex would
      // make the synthesized TotalRecordCount wrong (see the note above).
      'var iuPr=function(u){var h3=u.indexOf("#");if(h3>=0)u=u.slice(0,h3);' +
      'var q3=u.indexOf("?");if(q3<0)return null;var bs=u.slice(0,q3);' +
      'if(bs.length<7||bs.slice(-6)!=="/Items")return null;' +
      "var o={b:bs,ids:[],lim:null,si:null,fl:[],eu:1,ot:[]};" +
      'var ps=u.slice(q3+1).split("&"),i3,e3,k3,v3,lk;' +
      "for(i3=0;i3<ps.length;i3++){if(!ps[i3])continue;" +
      'e3=ps[i3].indexOf("=");k3=e3<0?ps[i3]:ps[i3].slice(0,e3);v3=e3<0?"":ps[i3].slice(e3+1);lk=k3.toLowerCase();' +
      'if(!iuUn.test(lk)){o.ot.push(k3+"="+v3);continue}' +
      'if(lk==="ids"){o.ids=iuDe(v3).split(",")}' +
      'else if(lk==="limit"){o.lim=parseInt(iuDe(v3),10)}' +
      'else if(lk==="startindex"){o.si=parseInt(iuDe(v3),10)}' +
      'else if(lk==="fields"){o.fl=iuDe(v3).split(",")}' +
      'else if(lk==="enableuserdata"){o.eu=iuDe(v3)==="false"?0:1}}' +
      "var il=[],j3;for(j3=0;j3<o.ids.length;j3++)if(o.ids[j3])il.push(o.ids[j3]);" +
      "if(!il.length)return null;o.ids=il;" +
      // NaN fails both tests, which is the intent: unparseable = do not batch.
      "if(o.si!==null&&o.si!==0)return null;" +
      "if(o.lim!==null&&!(o.lim>=il.length))return null;return o};" +
      // Build the union URL from the batch's merged parameter state.
      "var iuMk=function(b){var qs=b.ot.slice();" +
      'qs.push("Ids="+encodeURIComponent(b.ids.join(",")));' +
      'qs.push("Limit="+b.ids.length);' +
      'qs.push("EnableTotalRecordCount=false");' +
      'if(b.fl.length)qs.push("Fields="+encodeURIComponent(b.fl.join(",")));' +
      'if(!b.eu)qs.push("EnableUserData=false");' +
      'return b.b+"?"+qs.join("&")};' +
      // 34 = a GUID plus its %2C separator; the constant only has to be an
      // over-estimate for the length guard to be conservative.
      "var iuLn=function(b,ex){return b.b.length+b.otl+(b.ids.length+ex)*34+160};" +
      "var iuRp=function(ms){var i4;for(i4=0;i4<ms.length;i4++)(function(m4){" +
      "iuF.call(W,m4.u,m4.o).then(function(r4){m4.res(r4)},function(e4){m4.rej(e4)})})(ms[i4])};" +
      "var iuFi=function(k4){var b=iuB[k4];if(!b)return;delete iuB[k4];" +
      "try{clearTimeout(b.t)}catch(_){}var ms=b.m;" +
      // One member left: re-issue it verbatim. It paid the window; it takes on
      // none of the rewrite risk.
      "if(ms.length<2){if(ms.length){IU.sing++;iuRp(ms)}return}" +
      "IU.fire++;" +
      "iuF.call(W,iuMk(b),b.o).then(function(r5){" +
      'if(!(r5.status>=200&&r5.status<300))throw new Error("iu-status");' +
      "return r5.text().then(function(t5){return{r:r5,t:t5}})" +
      "}).then(function(z){" +
      "var d=JSON.parse(z.t),rw=d&&d.Items,i5,j5,kk;" +
      'if(!rw||typeof rw.length!=="number")throw new Error("iu-shape");' +
      "var hh={};try{z.r.headers.forEach(function(hv,hn){hn=String(hn);var lh=hn.toLowerCase();" +
      'if(lh!=="content-length"&&lh!=="content-encoding")hh[hn]=hv})}catch(_){hh["content-type"]="application/json"}' +
      "var seen={};for(i5=0;i5<rw.length;i5++)if(rw[i5])seen[iuNz(rw[i5].Id)]=1;" +
      // Build every slice BEFORE resolving anyone, so a throw here replays the
      // whole batch instead of half-resolving it.
      "var outs=[];for(i5=0;i5<ms.length;i5++){var m5=ms[i5],ou=[],go={};" +
      "for(j5=0;j5<rw.length;j5++){var it=rw[j5];if(it&&m5.set[iuNz(it.Id)]){ou.push(it);go[iuNz(it.Id)]=1}}" +
      "for(j5=0;j5<m5.ids.length;j5++){var nz=iuNz(m5.ids[j5]);if(!go[nz]){if(seen[nz])IU.short++;else IU.absent++}}" +
      "var od={};for(kk in d)if(Object.prototype.hasOwnProperty.call(d,kk))od[kk]=d[kk];" +
      "od.Items=ou;od.TotalRecordCount=ou.length;od.StartIndex=0;" +
      "outs.push(JSON.stringify(od));IU.items+=ou.length}" +
      "for(i5=0;i5<ms.length;i5++){IU.serve++;" +
      'ms[i5].res(new Response(outs[i5],{status:z.r.status,statusText:z.r.statusText||"",headers:hh}))}' +
      "}).then(null,function(){try{IU.fb++;iuRp(ms)}catch(_){IU.err++}})};" +
      "var iuAd=function(u,o2){var p=iuPr(u);if(!p)return null;" +
      "var hd=iuHd(o2);if(hd===null){IU.skip++;return null}IU.seen++;" +
      'var k4=p.b+"\\u0000"+(o2&&o2.credentials?String(o2.credentials):"same-origin")+"\\u0000"+' +
      '(o2&&o2.mode?String(o2.mode):"cors")+"\\u0000"+hd+"\\u0000"+p.ot.slice().sort().join("&");' +
      "var b=iuB[k4],j4;" +
      "if(b&&(b.ids.length+p.ids.length>iuMx||iuLn(b,p.ids.length)>iuUL)){iuFi(k4);b=null}" +
      'if(!b){b=iuB[k4]={b:p.b,ot:p.ot,otl:p.ot.join("&").length,ids:[],set:{},fl:[],' +
      "eu:p.eu,m:[],o:o2,t:null};" +
      "b.t=setTimeout(function(){try{iuFi(k4)}catch(_){IU.err++}},iuW)}" +
      "for(j4=0;j4<p.ids.length;j4++){var nz4=iuNz(p.ids[j4]);if(!b.set[nz4]){b.set[nz4]=1;b.ids.push(p.ids[j4])}}" +
      "for(j4=0;j4<p.fl.length;j4++)if(p.fl[j4]&&b.fl.indexOf(p.fl[j4])<0)b.fl.push(p.fl[j4]);" +
      "b.eu=b.eu||p.eu;" +
      "var m4={ids:p.ids,set:{},u:u,o:o2,res:null,rej:null};" +
      "for(j4=0;j4<p.ids.length;j4++)m4.set[iuNz(p.ids[j4])]=1;" +
      "b.m.push(m4);IU.batch++;" +
      "return new Promise(function(rs,rj){m4.res=rs;m4.rej=rj})};" +
      "var iuF=W.fetch;W.fetch=function(fu,fo){try{" +
      'if((fo&&fo.method?String(fo.method).toUpperCase():"GET")==="GET"&&typeof fu==="string"&&' +
      '!(fo&&(fo.body||fo.signal))&&fu.indexOf("Ids=")>=0){var ip=iuAd(fu,fo);if(ip)return ip}' +
      "}catch(_){IU.err++}return iuF.apply(W,arguments)};" +
      "}}catch(_){G.err++}}" +
      // JELA-757: play-path replay — stop the play chain re-downloading the
      // item the detail page is already standing on, and stop /Intros gating
      // PlaybackInfo.
      //
      // Pressing Play does not fan out. The JELA-756 census (n=4 clean
      // samples, 2 profile lineages) measured FOUR strictly serial round
      // trips between the click and the <video> element, each hop sent only
      // after the previous one landed:
      //
      //   GET  /Users/{u}/Items/{id}/Intros
      //     -> GET  /Users/{u}/Items/{id}          full item body
      //       -> POST /Items/{id}/PlaybackInfo
      //         -> GET  /videos/{id}/master.m3u8
      //
      // Click -> <video> measured 1,270 / 504 / 557 / 239 ms; the spread is
      // server CPU, not a fixed cost. Serialisation proof (PB1, ms from
      // click): Intros sent 6, ENDS 362 -> item sent 426, ends 479 ->
      // PlaybackInfo sent 486. Same shape 4/4.
      //
      // Hop 2 is pure waste. main.jellyfin.bundle.js playbackManager
      // playAfterBitrateDetect does
      //   m = p.getItem(p.getCurrentUserId(), f||t.Id).then(e=>e.MediaStreams)
      //   return Promise.all([s, u.getDeviceProfile(t), p.getCurrentUser(), m])
      // — it downloads the ENTIRE item solely to read .MediaStreams, and it
      // sits inside the Promise.all that gates PlaybackInfo, so PlaybackInfo
      // cannot even be SENT until that redundant body lands. The detail page
      // the user is standing on already has that item, MediaStreams included:
      // across ONE detail-open + ONE play the same body is fetched 6-7 times
      // (~314 KB for one 44.9 KB series title).
      //
      // Why the JELA-752 coalescer above cannot absorb it: its replay window
      // is 400 ms (2 s ceiling) because a held snapshot is a staleness
      // window. The play click is ~18 s after the detail open. A join can
      // never reach that far, so this needs a different shape — not a longer
      // window, but a window that opens only around a play click.
      //
      // Shape: a small ARMED replay store, installed OUTSIDE the coalescer so
      // it gets first refusal on the two URLs it owns.
      //
      //  1. RECORD the item the user is STANDING ON. A 2xx GET of
      //     /Users/*/Items/{id} (32-hex or dashed GUID id, no query — that is
      //     exactly the getItem shape, and the id test is what keeps
      //     /Users/*/Items/Latest|Resume|Root out) or of that item's /Intros
      //     is snapshotted to text and kept, at most 8 entries, each expiring
      //     after playReplayTtlMs (default 300 s). Recording alone changes no
      //     behaviour. Gated on the id appearing in location.hash at REQUEST
      //     time, because the first rig run showed why breadth is not free:
      //     it recorded NINE item bodies — four of them home-row cards fetched
      //     during boot — which both wasted four boot requests on their
      //     intros prefetches and evicted the detail item from the store
      //     before the play click could use it (srv:0). The detail route puts
      //     the id in the hash before it fetches the body, so the hash test
      //     keeps the store at the one item that matters.
      //
      //  2. SERVE each entry exactly ONCE, to whoever asks next, and only
      //     after it has been settled for playReplayMinAgeMs (default 2 s).
      //     That is the play chain by construction: the route gate means the
      //     entry can only be the item the user is standing on, the min-age
      //     floor hands the detail route's own concurrent burst back to
      //     JELA-752 where it belongs, and the next reader after that is
      //     playAfterBitrateDetect ~18 s later. The second ask gets the
      //     network, so this can never become a general cache.
      //
      //  3. RE-OPEN the budget on a play click, as an enhancement only. A
      //     capture-phase listener (window AND document) for
      //     .btnPlay/.btnResume/.btnReplay/.btnShuffle or
      //     data-action=play|resume|resumemixed|instantmix|shuffle clears
      //     every live entry's replay budget, so a SECOND play in the same
      //     dwell is served too.
      //
      //     This is deliberately not load-bearing. The design originally
      //     served only inside a window opened by such a click; the rig came
      //     back arm:0 ev:0 twice over — on this engine a capture-phase click
      //     listener never fires, neither on document (wiped by the
      //     document.write handoff) nor on window. Nor can the chain's own
      //     /Intros GET stand in for it: it leads the chain on the cinema-mode
      //     path but is absent entirely on the resume path, and one rig run
      //     saw it only AFTER PlaybackInfo, as part of the failure ladder.
      //     Hence the budget in 2, which depends on neither.
      //
      //  4. PREFETCH the intros off the critical path. Hop 1 is guarded by
      //     upstream's enableCinemaMode(); it fired in 3/4 samples, returned
      //     an EMPTY Items[] (89-114 B) and still cost a full serial RTT
      //     (350 ms server-side worst case). Rather than cache an "intros are
      //     empty" verdict — which is a guess about another item, and about
      //     library config we do not own — recording an item body schedules
      //     the REAL /Intros GET for that same item playReplayIntrosMs later
      //     (default 1.5 s, so it never competes with the detail render),
      //     capped at playReplayIntrosMax (12) per window. With the hash gate
      //     above that is exactly ONE request per detail page opened, and it
      //     buys back a whole serial RTT at play time. At play time the answer
      //     is a genuine server response for the exact URL asked, at most one
      //     dwell old. It replays the observed item GET's own init object, so
      //     credentials/mode/auth headers match by construction and the key it
      //     stores under is the one upstream will ask for; a GET with no
      //     headers to replay is skipped rather than guessed at.
      //
      // Staleness is bounded the same three ways as JELA-752: only 2xx is
      // held, entries expire, and ANY mutation over fetch OR XHR flushes the
      // whole store, so a "mark watched" POST can never be followed by a
      // replayed pre-mutation body. A miss — nothing recorded, expired,
      // flushed, or a series whose Play button starts an EPISODE the detail
      // route never fetched — falls through to the network untouched: worst
      // case = today's chain.
      //
      // Field-tunable without a shell release, all with the same clamp-or-
      // keep-the-default parse: jellyfin.shell.playReplayTtlMs (0..1800000;
      // 0 disables recording, and so serving), playReplayMinAgeMs (0..30000),
      // playReplayArmMs (0..30000; 0 disables only the click re-open, leaving
      // one replay per entry), playReplayIntrosMs (0..60000),
      // playReplayIntrosMax (0..64). playReplayFlushAll='1' restores the
      // blanket JELA-752 mutation flush.
      // Kill-switch: localStorage['jellyfin.shell.playReplayDisabled']='1'.
      // Counters: window.__shellPA
      // {on,t,w,d,m,a,cl,arm,ev,rec,ric,skip,srv,sri,pf,pfh,pfe,fl,fs,err};
      // skip counts GETs of our shape that were off-route and so left
      // untouched, fs counts mutations that did NOT flush, and cl counts every
      // click the listener saw at all (cl:0 with a play that plainly happened
      // is the signature of the wiped-listener trap).
      'if(!flg("jellyfin.shell.playReplayDisabled")&&!W.__shellPA&&typeof W.fetch==="function"&&typeof Response==="function"){try{' +
      'var paT=300000;try{var pa1=localStorage.getItem("jellyfin.shell.playReplayTtlMs");if(pa1!==null&&pa1!==""){pa1=parseInt(pa1,10);if(pa1>=0&&pa1<=1800000)paT=pa1}}catch(_){}' +
      'var paW=6000;try{var pa2=localStorage.getItem("jellyfin.shell.playReplayArmMs");if(pa2!==null&&pa2!==""){pa2=parseInt(pa2,10);if(pa2>=0&&pa2<=30000)paW=pa2}}catch(_){}' +
      'var paD=1500;try{var pa3=localStorage.getItem("jellyfin.shell.playReplayIntrosMs");if(pa3!==null&&pa3!==""){pa3=parseInt(pa3,10);if(pa3>=0&&pa3<=60000)paD=pa3}}catch(_){}' +
      'var paM=12;try{var pa4=localStorage.getItem("jellyfin.shell.playReplayIntrosMax");if(pa4!==null&&pa4!==""){pa4=parseInt(pa4,10);if(pa4>=0&&pa4<=64)paM=pa4}}catch(_){}' +
      // Minimum age before an entry may be replayed. This is the line between
      // this change and JELA-752 above, and it is load-bearing: the detail
      // route issues its item GET FOUR times inside ~250 ms, and without a
      // floor those calls spend the single replay budget among themselves
      // (call 2 served, call 3 re-records, call 4 served...) so whether the
      // play click 18 s later finds a budget left comes down to parity. The
      // coalescer owns the concurrent burst — that is what its 400 ms window
      // is for — and this owns the long-gap re-read. They no longer overlap.
      'var paA=2000;try{var pa5=localStorage.getItem("jellyfin.shell.playReplayMinAgeMs");if(pa5!==null&&pa5!==""){pa5=parseInt(pa5,10);if(pa5>=0&&pa5<=30000)paA=pa5}}catch(_){}' +
      "var PA=W.__shellPA={on:1,t:paT,w:paW,d:paD,m:paM,a:paA,cl:0,arm:0,ev:0,rec:0,ric:0,skip:0,srv:0,sri:0,pf:0,pfh:0,pfe:0,fl:0,fs:0,err:0};" +
      'var paQ={},paL=[],paP={},paCi="";' +
      // A mutation that can touch an ITEM drops the whole store — see the
      // staleness note above. paP goes with it, so a post-mutation re-record
      // may prefetch again.
      //
      // Narrower than JELA-752's flush-on-anything, because the two guard
      // different spans. Over a 400 ms join window "any mutation" is free;
      // over an 18 s dwell it is fatal — the rig showed a third-party
      // POST /JellyfinEnhanced/user-settings/{u}/settings.json landing
      // mid-dwell and emptying the store every time, so the play chain always
      // missed. So: flush on the paths that can change an item body or its
      // UserData, and count the rest as skipped. Unknown paths flush, because
      // a false flush costs one round trip and a missed one serves stale
      // bytes — so a mutation we cannot read a URL for (a Request object,
      // say) flushes too. jellyfin.shell.playReplayFlushAll='1' restores the blanket
      // JELA-752 behaviour if this list ever proves too narrow in the field.
      'var paFa=flg("jellyfin.shell.playReplayFlushAll");' +
      'var paFx=["/Items","/PlayedItems","/FavoriteItems","/UserItems","/Sessions/Playing","/Users/"];' +
      'var paFm=function(pw){try{if(paFa)return 1;pw=String(pw||"");if(!pw)return 1;' +
      'var pq3=pw.indexOf("?");if(pq3>=0)pw=pw.slice(0,pq3);' +
      "var pi3;for(pi3=0;pi3<paFx.length;pi3++)if(pw.indexOf(paFx[pi3])>=0)return 1;return 0}catch(_){return 1}};" +
      "var paFl=function(pw){try{if(!paFm(pw)){PA.fs++;return}paQ={};paL=[];paP={};PA.fl++}catch(_){PA.err++}};" +
      // Jellyfin item ids are Guids: 32 hex ("N" format, what the API emits)
      // or the dashed form. Requiring one is what separates a real getItem
      // URL from the named /Users/*/Items/<verb> endpoints.
      "var paId=/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;" +
      // 0 = not ours, 1 = the full item body, 2 = that item's intros. Any
      // query string disqualifies: getItem/getIntros send none, and the
      // /Items/{id}?userId= alias is a different projection (JELA-742).
      // Also parks the matched id in paCi for the route test below — read
      // immediately by the one caller, which is the only call in flight.
      'var paCl=function(pu2){paCi="";var ph2=pu2.indexOf("#");if(ph2>=0)pu2=pu2.slice(0,ph2);' +
      'if(pu2.indexOf("?")>=0)return 0;var sg=pu2.split("/"),nn=sg.length;' +
      'if(nn>=5&&sg[nn-2]==="Items"&&sg[nn-4]==="Users"&&paId.test(sg[nn-1])){paCi=sg[nn-1];return 1}' +
      'if(nn>=6&&sg[nn-1]==="Intros"&&sg[nn-3]==="Items"&&sg[nn-5]==="Users"&&paId.test(sg[nn-2])){paCi=sg[nn-2];return 2}' +
      "return 0};" +
      // Only the item the user is STANDING ON is worth keeping. The first rig
      // run recorded 9 item bodies — four of them home-row cards fetched
      // during boot — and prefetched intros for all of them, which both wasted
      // four boot requests and evicted the detail item from the store before
      // the play click could use it (srv:0 with an 8-slot cap). The detail
      // route puts the id in the hash (#!/details?id=<id>) before it fetches
      // the body, so testing the hash at REQUEST time keeps the store at the
      // one item that matters and makes the prefetch exactly one request per
      // detail page opened. No hash match => record nothing, prefetch nothing,
      // i.e. today's behaviour.
      'var paHs=function(pid){try{return pid&&String(location.hash||"").indexOf(pid)>=0?1:0}catch(_){return 0}};' +
      "var paSn=function(pr){return pr.text().then(function(pt){var ph={};" +
      'try{pr.headers.forEach(function(pv,pn){ph[pn]=pv})}catch(_){try{var pct=pr.headers.get("content-type");if(pct)ph["content-type"]=pct}catch(__){}}' +
      'return{s:pr.status,x:pr.statusText||"",h:ph,b:pt}})};' +
      "var paMk=function(pd){var ps=pd.s||200;" +
      "return new Response(ps===204||ps===205||ps===304?null:pd.b,{status:ps,statusText:pd.x,headers:pd.h})};" +
      // Insertion-ordered, capped at 8, every entry self-expiring. The identity
      // check is what makes paFl() safe: a timer whose entry has already been
      // flushed or replaced must not evict whoever owns the key now.
      //
      // pd.u is the replay budget, and it is what makes this work AT ALL on
      // the real engine. The design started out serving only inside a window
      // opened by a play click; the rig then came back arm:0 ev:0 twice over —
      // a capture-phase click listener never fires here, on document (wiped by
      // the document.write handoff) OR on window. So an entry is instead
      // replayable exactly ONCE, to whoever asks next. That is the play chain
      // by construction: the route gate means the entry can only be the item
      // the user is standing on, JELA-752 already collapses the detail route's
      // own burst to one GET, and the very next reader of that URL is
      // playAfterBitrateDetect. A click, when we do see one, re-opens the
      // budget (paArm) so a second play in the same dwell is served too.
      "var paPut=function(pk,pd){try{pd.u=1;if(!paQ[pk])paL.push(pk);paQ[pk]=pd;" +
      "setTimeout(function(){try{if(paQ[pk]===pd)pd.u=0}catch(_){PA.err++}},paA);" +
      "while(paL.length>8){var pv2=paL.shift();if(pv2!==pk)delete paQ[pv2]}" +
      "setTimeout(function(){try{if(paQ[pk]===pd)delete paQ[pk]}catch(_){PA.err++}},paT)}catch(_){PA.err++}};" +
      // Re-open every live entry for one more replay. This is now an
      // ENHANCEMENT, not a prerequisite — see the "serve once per entry" note
      // in paPut above — so a play click that we fail to see costs the second
      // play of a dwell, never the first.
      "var paArm=function(){try{if(!paW)return;PA.arm++;var pi4;" +
      "for(pi4=0;pi4<paL.length;pi4++){var pn4=paQ[paL[pi4]];if(pn4)pn4.u=0}}catch(_){PA.err++}};" +
      // Off-critical-path /Intros prefetch for an item we just recorded. Uses
      // the item GET's OWN init (auth headers, credentials, mode) so the key
      // it stores under is exactly the one upstream will ask for, and issues
      // it through paF — the inner fetch — so it is never recorded twice nor
      // mistaken for the play chain arming.
      // paP is what stops a DOUBLE prefetch: the detail route issues its item
      // GET several times over, so without a scheduled-set every one of them
      // queues its own /Intros and they all find paQ[ik] still empty when they
      // fire (the first rig run issued two).
      "var paPre=function(pu2,po2,pk){try{if(PA.pf>=paM)return;if(!(po2&&po2.headers))return;" +
      'var iu=pu2+"/Intros",ik=pk.slice(0,pk.length-pu2.length)+iu;if(paQ[ik]||paP[ik])return;paP[ik]=1;PA.pf++;' +
      "setTimeout(function(){try{if(paQ[ik])return;" +
      "paF.call(W,iu,po2).then(paSn).then(function(pd){if(pd.s>=200&&pd.s<300){paPut(ik,pd);PA.pfh++}else PA.pfe++},function(){PA.pfe++})" +
      "}catch(_){PA.err++;PA.pfe++}},paD)}catch(_){PA.err++}};" +
      "var paF=W.fetch;W.fetch=function(pu,po){try{" +
      'var pm=po&&po.method?String(po.method).toUpperCase():"GET";' +
      'if(pm!=="GET"&&pm!=="HEAD"){paFl(typeof pu==="string"?pu:(pu&&pu.url))}' +
      'else if(pm==="GET"&&typeof pu==="string"&&!(po&&(po.body||po.signal))){' +
      "var pc=paCl(pu);" +
      // (method, credentials, mode, full URL), normalised to the fetch
      // defaults exactly as the coalescer above does.
      'if(pc){var pk="GET "+(po&&po.credentials?String(po.credentials):"same-origin")+" "+(po&&po.mode?String(po.mode):"cors")+" "+pu;' +
      // Route test at REQUEST time — the hash can change while the body is in
      // flight, and the question we are asking is "is this the page the user
      // is on", not "was it still that page when the bytes landed".
      "var phz=paHs(paCi);" +
      // One replay per entry, to whoever asks next — pd.u in paPut above.
      "var pe=paQ[pk];" +
      "if(pe&&!pe.u){var pz=paMk(pe);pe.u=1;if(pc===1)PA.srv++;else PA.sri++;return Promise.resolve(pz)}" +
      "if(paT&&phz)return paF.call(W,pu,po).then(function(pr){return paSn(pr).then(function(pd){" +
      "if(pd.s>=200&&pd.s<300){paPut(pk,pd);if(pc===1){PA.rec++;paPre(pu,po,pk)}else PA.ric++}" +
      "return paMk(pd)})});" +
      "if(paT)PA.skip++}}" +
      "}catch(_){PA.err++}" +
      "return paF.apply(W,arguments)};" +
      // XHR is hooked ONLY for the mutation flush, same as JELA-752.
      "try{var PXA=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(PXA&&PXA.open){var paO=PXA.open;" +
      'PXA.open=function(pxm,pxu){try{var pxv=String(pxm||"").toUpperCase();if(pxv!=="GET"&&pxv!=="HEAD")paFl(pxu)}catch(_){PA.err++}' +
      "return paO.apply(this,arguments)}}}catch(_){PA.err++}" +
      // Bound to WINDOW, not document. The shell hands off to jellyfin-web with
      // document.write(), which implicitly calls document.open() and drops
      // every listener registered on the document — the first rig run came
      // back ev:0 for exactly that reason, and only the /Intros arm above
      // saved it. Window listeners survive the handoff on M63 (the engine this
      // ships to; cf. the JEL-66 note that Chrome 68+ is the one that wipes
      // them), and a click reaches window last, so capture phase costs
      // nothing extra. document is kept as a second registration for engines
      // where the reverse holds, deduped on event identity so the two
      // registrations cannot both count (and re-open) one click.
      'try{var paBt=" btnPlay btnResume btnReplay btnShuffle ";' +
      'var paAt=" play resume resumemixed instantmix shuffle ",paLe=null;' +
      "var paCk=function(pv){try{if(pv&&pv===paLe)return;paLe=pv;PA.cl++;var nd=pv&&pv.target,dp=0;" +
      'while(nd&&dp<8){var ca=nd.getAttribute?String(nd.getAttribute("data-action")||""):"";' +
      'if(ca&&paAt.indexOf(" "+ca+" ")>=0){PA.ev++;paArm();return}' +
      'var cn=typeof nd.className==="string"?nd.className:"";' +
      'if(cn){var cs=cn.split(/\\s+/),ci;for(ci=0;ci<cs.length;ci++)if(cs[ci]&&paBt.indexOf(" "+cs[ci]+" ")>=0){PA.ev++;paArm();return}}' +
      "nd=nd.parentNode;dp++}}catch(_){PA.err++}};" +
      'if(W.addEventListener)W.addEventListener("click",paCk,true);' +
      'if(document&&document.addEventListener)document.addEventListener("click",paCk,true)}catch(_){PA.err++}' +
      // JELA-758 (opt-in, default OFF): search fan-out idle gate.
      //
      // Typing ONE six-character query on the search route costs 55-68
      // requests and 0.6-1.6 MB (JELA-756 census, n=3, warm primed profiles,
      // 700 ms keystroke cadence). A whole warm boot on the same rig is
      // 311-320 requests, so typing a single word is ~18-22% of a boot and it
      // repeats on every search.
      //
      // The cost is NOT the last query — it is every PREFIX on the way to it.
      // Upstream's search chunk debounces at well under a TV keystroke gap, so
      // each accepted prefix pays a full five-request fan-out (/Items limit=800
      // across 13 item types, /Persons, /Artists, two differently-filtered
      // /Items limit=100, plus an injected plugin's /Users/{u}/Items). Measured
      // byte split for "matrix": searchTerm=m cost 1,386,089 B, and searchTerm=
      // matr / matri / matrix cost 89 / 89 / 90 B each. 81% of the session's
      // bytes were spent on the ONE-character prefix — a query the user never
      // asked for and never saw. "batman" split the same way (1,387,156 B on
      // "b"). The shorter the prefix the more it matches, so the waste is
      // front-loaded onto exactly the terms with no information in them.
      //
      // Upstream does pass an AbortSignal, but aborting a request already on
      // the wire does not un-send it: across the three samples exactly ONE of
      // the superseded fan-outs was actually cancelled (net::ERR_ABORTED), and
      // it was cancelled after the server had already done the work. Every
      // other stale prefix completed in full and was thrown away. The fix has
      // to happen BEFORE the request is issued, which is what this does.
      //
      // Contract: a GET to an allowlisted search path whose URL carries a
      // searchTerm/SearchTerm parameter is HELD, not sent. Arrival of any
      // request bearing a DIFFERENT term marks the held ones stale and settles
      // them at once; the survivors go to the network once no new term has
      // appeared for searchGateMs. So a word costs one fan-out instead of one
      // per accepted prefix, and the fan-out that runs is the one the user
      // actually typed.
      //
      // BOTH transports are gated, and that is the whole ballgame. The ticket
      // reads as a fetch problem because upstream's source passes an
      // AbortSignal, but @jellyfin/sdk issues these through axios, whose
      // adapter on this engine is XMLHttpRequest. An in-page transport probe
      // over one typed word caught 20/20 of the limit=800 sweep, both
      // limit=100 reads, /Persons and /Artists on XHR and ZERO on fetch; only
      // the injected plugin's /Users/{u}/Items uses fetch. A fetch-only gate
      // measured as a clean null on the rig — 5 limit=800 sweeps in both arms.
      //
      // Stale requests are rejected with an AbortError rather than resolved
      // with a synthetic empty body ON PURPOSE. Abort is a path upstream
      // already drives and already handles (it attaches its own signal and we
      // measured it firing); an empty 200 is not — it would render "no
      // results" for a prefix that has plenty, so the rows would blink empty
      // between keystrokes. This gate only makes the app's own cancellation
      // happen a few hundred ms earlier, on our side of the socket.
      //
      // Deliberately NOT done here: clamping upstream's limit=800. It reads
      // like the obvious byte lever and it is a trap — the same shape as the
      // JELA-754 candidateLimit regression. Replaying the worst measured
      // response (searchTerm=ma, 461,334 B) shows the server returned only
      // 282 items, so limit=800 truncates nothing today; and because the page
      // partitions that one array by Type in JavaScript, the types are
      // INTERLEAVED (Movie first appears at index 40 and last at index 281,
      // BoxSet last at 269). Any clamp below the true result count therefore
      // deletes whole item types off the tail of the list rather than
      // shortening each row. The bytes are per-item weight, not row count:
      // ImageBlurHashes alone is 27.2% of that body and no query parameter
      // exposed to the client suppresses it (JELA-754 reached the same wall).
      // Gating the prefixes removes three of those four responses outright,
      // which is the same saving with none of the truncation risk.
      //
      // Installed AFTER the coalescer above so it wraps OUTSIDE it: a stale
      // prefix is dropped before it can occupy a coalescer slot. Field-tunable
      // via localStorage['jellyfin.shell.searchGateMs'] (0..5000, default 800;
      // 0 keeps the supersede-and-drop behaviour but releases on the next
      // tick). Counters: window.__shellSG {on,ms,n,rel,sup,ab,drop,err,t}.
      'if(flg("jellyfin.shell.searchGate")&&!W.__shellSG&&typeof Promise==="function"){try{' +
      'var sgMs=800;try{var sgv=localStorage.getItem("jellyfin.shell.searchGateMs");' +
      'if(sgv!==null&&sgv!==""){sgv=parseInt(sgv,10);if(sgv>=0&&sgv<=5000)sgMs=sgv}}catch(_){}' +
      'var SG=W.__shellSG={on:1,ms:sgMs,n:0,fn:0,xn:0,rel:0,sup:0,ab:0,drop:0,err:0,t:""},sgQ=[],sgT=null,sgL=null;' +
      "var sgRe=/[?&][Ss]earch[Tt]erm=([^&]*)/;" +
      // PATH-scoped, not "any URL with a search term". /Genres?SearchTerm=
      // is JELA-738's bulk genre-name read: eight lookups with FIXED terms
      // ("Action", "Comedy", ...) issued together, so a term-only rule reads
      // each as a new query, supersedes the previous seven, and leaves only
      // the last genre resolved. Measured on the rig before this list existed.
      // Suffix-matched, so "/Items" also covers "/Users/{u}/Items".
      'var SGL=["/Items","/Persons","/Artists"];' +
      'try{var sgp=String(localStorage.getItem("jellyfin.shell.searchGatePaths")||"").replace(/\\s+/g,"").split(","),sgi;' +
      'for(sgi=0;sgi<sgp.length;sgi++)if(sgp[sgi].charAt(0)==="/"&&SGL.length<16)SGL.push(sgp[sgi])}catch(_){}' +
      'var sgOk=function(su){try{var sh=su.indexOf("#");if(sh>=0)su=su.slice(0,sh);' +
      'var sq2=su.indexOf("?");if(sq2<0)return 0;var sp=su.slice(0,sq2),si2;' +
      "for(si2=0;si2<SGL.length;si2++){var ss=SGL[si2];" +
      "if(sp===ss||sp.length>ss.length&&sp.slice(-ss.length)===ss)return 1}return 0}catch(_){return 0}};" +
      'var sgAb=function(){var se;try{se=new DOMException("The user aborted a request.","AbortError")}catch(_){se=new Error("The user aborted a request.");se.name="AbortError"}return se};' +
      'var sgEv=function(){var se;try{se=new Event("abort")}catch(_){try{se=document.createEvent("Event");se.initEvent("abort",!1,!1)}catch(__){se=null}}return se};' +
      "var sgSup=function(){try{var sq=sgQ,si3,se2;sgQ=[];" +
      "for(si3=0;si3<sq.length;si3++){se2=sq[si3];if(se2.t===sgL)sgQ.push(se2);else{SG.sup++;se2.j()}}}catch(_){SG.err++}};" +
      "var sgGo=function(){sgT=null;try{var sq=sgQ,si4,se2;sgQ=[];" +
      "for(si4=0;si4<sq.length;si4++){se2=sq[si4];if(se2.t===sgL){SG.rel++;se2.r()}else{SG.sup++;se2.j()}}}catch(_){SG.err++}};" +
      "var sgAdd=function(st,sr,sj){if(st!==sgL){sgL=st;SG.t=st.slice(0,40);sgSup()}" +
      "var se3={t:st,r:sr,j:sj};sgQ.push(se3);" +
      "if(sgT)clearTimeout(sgT);sgT=setTimeout(sgGo,sgMs);return se3};" +
      'if(typeof W.fetch==="function"){var sgF=W.fetch;W.fetch=function(su,so){try{' +
      'var sgm=so&&so.method?String(so.method).toUpperCase():"GET";' +
      'if(sgm==="GET"&&typeof su==="string"&&!(so&&so.body)&&sgOk(su)){var sgx=sgRe.exec(su);' +
      "if(sgx&&sgQ.length<64){SG.n++;SG.fn++;" +
      "if(so&&so.signal&&so.signal.aborted){SG.ab++;return Promise.reject(sgAb())}" +
      "return new Promise(function(sres,srej){var sen=sgAdd(sgx[1]," +
      "function(){sres(sgF.call(W,su,so))},function(){srej(sgAb())});" +
      'try{if(so&&so.signal&&typeof so.signal.addEventListener==="function")so.signal.addEventListener("abort",function(){try{var sk=sgQ.indexOf(sen);if(sk>=0){sgQ.splice(sk,1);SG.ab++;srej(sgAb())}}catch(_){SG.err++}})}catch(_){SG.err++}' +
      "})}" +
      "if(sgx)SG.drop++}" +
      "}catch(_){SG.err++}" +
      "return sgF.apply(W,arguments)}}" +
      "try{var SPX=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;" +
      "if(SPX&&SPX.open&&SPX.send){var sgO=SPX.open,sgS=SPX.send,sgA=SPX.abort;" +
      'SPX.open=function(sm2,su2){try{this.__sgM=String(sm2||"").toUpperCase();this.__sgU=String(su2||"")}catch(_){SG.err++}' +
      "return sgO.apply(this,arguments)};" +
      "SPX.send=function(sb){var sx=this;try{" +
      'if(sx.__sgM==="GET"&&sb==null&&sgOk(sx.__sgU)){var sgx2=sgRe.exec(sx.__sgU);' +
      "if(sgx2&&sgQ.length<64){SG.n++;SG.xn++;var sar=arguments;" +
      "sx.__sgE=sgAdd(sgx2[1],function(){sx.__sgE=null;sgS.apply(sx,sar)}," +
      "function(){sx.__sgE=null;var sev=sgEv();if(sev)try{sx.dispatchEvent(sev)}catch(_){SG.err++}});" +
      "return}" +
      "if(sgx2)SG.drop++}" +
      "}catch(_){SG.err++}return sgS.apply(sx,arguments)};" +
      "if(sgA)SPX.abort=function(){var sx=this;try{if(sx.__sgE){var sk2=sgQ.indexOf(sx.__sgE);" +
      "if(sk2>=0)sgQ.splice(sk2,1);sx.__sgE=null;SG.ab++;" +
      "var sev2=sgEv();if(sev2)try{sx.dispatchEvent(sev2)}catch(_){SG.err++}}}catch(_){SG.err++}" +
      "return sgA.apply(sx,arguments)}}}catch(_){SG.err++}" +
      "}catch(_){SG.err++}}" +
      "}catch(_){G.err++}}" +
      // JELA-51 (JELA-41 WS-5, opt-in, default OFF): home-sections API data
      // prefetch + SPA intercept. localStorage['jellyfin.shell.apiWarm']='1'
      // fires the DETERMINISTIC home-sections request list (JELA-50 WS-4
      // spec: config preamble, HomeScreen/Sections + the Section/* fan-out
      // chained off its OWN response — the server randomizes Genre /
      // BecauseYouWatched picks per call, so the SPA must be served the same
      // Sections body the fan-out was derived from — plus JellyfinEnhanced
      // tag-cache, the single biggest lever: ~13 s server time, completion
      // coincides with layout-stable on every WS-4 boot) at body-run
      // (~0.5 s, ~8 s before the SPA can ask) with the stored token, into an
      // in-memory ONE-SHOT store (TTL 60 s), and serves the SPA's matching
      // fetch/XHR GETs from it. Every prefetch is issued against srv()'s
      // SERVER origin (JELA-47: the page origin is file:// on-device and is
      // never consulted); SPA URLs are matched server-relative with query
      // params sorted and the NextUpDateCutoff + "_" cache-buster params
      // dropped (WS-4 fuzz spec). A miss (consumed / expired / errored /
      // never prefetched — incl. the data-dependent Items?Ids= hydration and
      // item-detail tier, deliberately fallthrough) goes to the network
      // untouched: worst case = today's boot. A prefetch still in flight
      // when the SPA asks parks the SPA on the SAME request (the tag-cache
      // case: issued ~0.5 s, SPA asks ~9 s, data lands ~14 s instead of
      // ~22.5 s); if it then errors the SPA request replays on the network.
      // A token change flushes the store (st:"auth") so stale-user data is
      // never served. One warm per WINDOW (not per document): the fetch/XHR
      // patches live on window and survive the document.write handoff and
      // the "dh" dismissal; a re-run body (gen turnover) is a no-op while
      // __shellAW exists. Counters: window.__shellAW
      // {on,started,q,f,e,hits,misses,st,ms}; st: "" (running) | "done" |
      // "auth". jellyfin.shell.apiWarmDisabled is honored NOW as the
      // kill-switch reserved for the WS-6 default-ON flip.
      //
      // JELA-685 (JELA-679/P1) adds a SECOND, much narrower entry point:
      // localStorage['jellyfin.shell.apiWarmSectionsOnly']='1' turns the warm
      // on by itself and reduces the request list to exactly ONE URL,
      // /HomeScreen/Sections?UserId=<uid>, with no chained fan-out.
      //
      // Why a separate mode rather than the full WS-5 list. On a COLD server
      // that one call costs 5-19 s of server CPU (measured against production
      // 2026-08-23: 4,926 / 7,285 / 8,657 / 12,656 / 16,097 ms of
      // x-response-time-ms cold, 39-170 ms warm) and it is the EXCLUSIVE gate:
      // the SPA cannot issue any /HomeScreen/Section/* until it returns, so
      // round 1 and round 2 latencies add. The remaining WS-5 URLs are not on
      // that exclusive path (JELA-433/434/435 each killed one), and firing
      // ~35 of them at t~0.5 s competes for the very server CPU the Sections
      // computation needs. Sections-only buys the head start without the
      // storm.
      //
      // Why it works even though JELA-433 correctly killed client-side
      // pre-warming: this does not need an HTTP cache or any client-side
      // reuse. HomeScreenSections COALESCES concurrent identical in-flight
      // requests server-side (measured: request B issued 4 s after request A
      // returned at the byte-identical instant as A, xrt 6,401 vs 8,657 ms,
      // i.e. B attached to A's computation instead of starting its own). So
      // the head start survives even when the SPA's URL misses canon() and
      // goes to the network; the in-store parking path is the faster of two
      // working routes, not a precondition.
      //
      // Sizing: the shell issues at ~0.5 s, the SPA at ~5.9 s (JELA-679
      // waterfall), so round 1 completes up to ~5.4 s earlier and everything
      // downstream shifts with it. Not a byte lever - see [[m63-boot-cost-truth]].
      'var awSO=flg("jellyfin.shell.apiWarmSectionsOnly");' +
      'if((flg("jellyfin.shell.apiWarm")||awSO)&&!flg("jellyfin.shell.apiWarmDisabled")&&!W.__shellAW){try{' +
      'var aC=null;try{var ac0=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null"),as0=ac0&&ac0.Servers&&ac0.Servers[0];if(as0&&as0.AccessToken&&as0.UserId)aC={t:as0.AccessToken,u:as0.UserId,a:String(as0.ManualAddress||as0.LocalAddress||"")}}catch(_){}' +
      'var aB="";try{aB=String(srv()||(aC&&aC.a)||"").replace(/\\/+$/,"")}catch(_){}' +
      'if(aC&&/^https?:\\/\\//.test(aB)&&typeof W.XMLHttpRequest==="function"){' +
      'var aw=W.__shellAW={on:1,so:awSO?1:0,started:0,q:0,f:0,e:0,hits:0,misses:0,st:"",ms:-1};' +
      "var sto={},uK={},sn={},PQ=[],pnd=0;" +
      'var bL=[aB];try{var ab2=String(aC.a||"").replace(/\\/+$/,"");if(ab2&&ab2!==aB)bL.push(ab2)}catch(_){}' +
      'var canon=function(u){try{u=String(u||"");for(var bi=0;bi<bL.length;bi++){if(u.indexOf(bL[bi]+"/")===0){u=u.slice(bL[bi].length);break}}' +
      'if(u.charAt(0)!=="/"||u.charAt(1)==="/")return"";' +
      'var qi=u.indexOf("?");if(qi<0)return u;' +
      'var ps=u.slice(qi+1).split("&"),ks=[],pi;for(pi=0;pi<ps.length;pi++){var nm=ps[pi].split("=")[0];if(nm==="_"||nm==="NextUpDateCutoff")continue;ks.push(ps[pi])}' +
      'if(!ks.length)return u.slice(0,qi);ks.sort();return u.slice(0,qi)+"?"+ks.join("&")}catch(_){return""}};' +
      'var tokOk=function(){try{var c2=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null"),s2=c2&&c2.Servers&&c2.Servers[0];return!!(s2&&s2.AccessToken===aC.t)}catch(_){return!1}};' +
      // chk: resolve a canonical key to a servable entry. Consuming DELETES
      // the store slot (one-shot) but callers keep the entry ref — a parked
      // pending waiter is fed by the in-flight XHR through that ref.
      "var chk=function(k){if(!k)return null;var e2=sto[k];" +
      "if(!e2){if(uK[k])aw.misses++;return null}" +
      'if(!tokOk()){sto={};aw.st="auth";aw.misses++;return null}' +
      "if(e2.st===2||+new Date()>e2.x){delete sto[k];aw.misses++;return null}" +
      "aw.hits++;delete sto[k];return e2};" +
      'var fin=function(){if(!PQ.length&&!pnd&&aw.ms<0){aw.ms=+new Date()-(W.__shellT0||t0);if(!aw.st)aw.st="done"}};' +
      'var enq=function(p){var k=canon(aB+p);if(!k||sn[k])return;sn[k]=1;uK[k]=1;var e0={st:0,x:+new Date()+60000,s:0,t:"",cb:[]};sto[k]=e0;PQ.push([p,e0]);aw.q++};' +
      "var sK=null;" +
      // chain: mirror the Home Screen Sections plugin's fan-out URL
      // construction from the Sections response we just stored. NextUp gets
      // a live NextUpDateCutoff + EnableRewatching=false exactly like the
      // plugin issues it (the cutoff is fuzz-dropped at match time).
      'var chain=function(tx){try{var d2=JSON.parse(tx),it2=d2&&d2.Items;if(!it2)return;for(var ci2=0;ci2<it2.length;ci2++){var se=it2[ci2],n3=String((se&&se.Section)||"");if(!/^[A-Za-z0-9_-]+$/.test(n3))continue;' +
      'var u6="/HomeScreen/Section/"+n3+"?UserId="+aC.u;var ad=se.AdditionalData;if(ad!=null&&ad!=="")u6+="&AdditionalData="+encodeURIComponent(String(ad));' +
      'if(n3==="NextUp")u6+="&NextUpDateCutoff="+encodeURIComponent(new Date().toISOString())+"&EnableRewatching=false";' +
      "enq(u6)}pump()}catch(_){G.err++}};" +
      "var issue=function(p,e0){pnd++;aw.started=1;try{" +
      'var x=new W.XMLHttpRequest();x.__awI=1;x.open("GET",aB+p,!0);' +
      "try{x.timeout=30000}catch(_){}" +
      'try{x.setRequestHeader("X-Emby-Token",aC.t);x.setRequestHeader("Accept","application/json")}catch(_){}' +
      "x.onreadystatechange=function(){try{if(x.readyState!==4)return;" +
      "var ok=x.status>=200&&x.status<300;" +
      'if(ok){aw.f++;if(e0.st===0){e0.st=1;e0.s=x.status;e0.t=String(x.responseText||"");e0.x=+new Date()+60000}}else{aw.e++;if(e0.st===0)e0.st=2}' +
      "if(ok&&canon(aB+p)===sK)chain(x.responseText);" +
      "var cbs=e0.cb;e0.cb=[];for(var fi=0;fi<cbs.length;fi++){try{cbs[fi]()}catch(_){G.err++}}" +
      "pnd--;fin();pump()}catch(_){G.err++}};" +
      "x.send()}catch(_){pnd--;aw.e++;if(e0.st===0)e0.st=2;fin()}};" +
      "var pump=function(){while(pnd<8&&PQ.length){var pr=PQ.shift();issue(pr[0],pr[1])}fin()};" +
      // Serve fetch() hits as synthesized Response objects (Chromium 56 has
      // the Response constructor); a 204 keeps its null body. Anything that
      // throws mid-serve degrades to the real fetch.
      'var mkR=null;try{if(typeof Response==="function")mkR=function(e2){return new Response(e2.s===204?null:e2.t,{status:e2.s||200,headers:{"Content-Type":"application/json"}})}}catch(_){}' +
      'if(typeof W.fetch==="function"&&mkR){try{var oF=W.fetch;W.fetch=function(u7,o7){try{' +
      'var m7=o7&&o7.method?String(o7.method).toUpperCase():"GET";' +
      'if(m7==="GET"){var e7=chk(canon(typeof u7==="string"?u7:String((u7&&u7.url)||"")));' +
      "if(e7){if(e7.st===1)return Promise.resolve(mkR(e7));" +
      "var oF2=oF;return new Promise(function(rs7){e7.cb.push(function(){if(e7.st===1){try{rs7(mkR(e7));return}catch(_){}}rs7(oF2.call(W,u7,o7))})})}}" +
      "}catch(_){G.err++}" +
      "return oF.apply(W,arguments)}}catch(_){G.err++}}" +
      // XHR delivery: own-property shadows over the prototype accessors +
      // readystatechange/load/loadend. dispatchEvent(new Event(...)) reaches
      // addEventListener listeners AND on* handlers on a real XHR; engines
      // without it get the on* handlers called directly.
      "var awD=function(x,e2){try{" +
      "var df=function(n4,v4){try{Object.defineProperty(x,n4,{configurable:!0,value:v4})}catch(_){try{x[n4]=v4}catch(__){}}};" +
      'df("readyState",4);df("status",e2.s||200);df("statusText","OK");' +
      'var rt="";try{rt=String(x.responseType||"")}catch(_){}' +
      'if(rt===""||rt==="text")df("responseText",e2.t);' +
      'if(rt==="json"){var pj=null;try{pj=JSON.parse(e2.t)}catch(_){}df("response",pj)}else df("response",e2.t);' +
      'df("getAllResponseHeaders",function(){return"content-type: application/json\\r\\n"});' +
      'df("getResponseHeader",function(h4){return String(h4||"").toLowerCase()==="content-type"?"application/json":null});' +
      'var evs=["readystatechange","load","loadend"];for(var ei=0;ei<evs.length;ei++){var fired=0;' +
      'try{if(typeof Event==="function"&&x.dispatchEvent){x.dispatchEvent(new Event(evs[ei]));fired=1}}catch(_){}' +
      'if(!fired){try{var h5=x["on"+evs[ei]];if(typeof h5==="function")h5.call(x,{type:evs[ei],target:x})}catch(_){G.err++}}}' +
      "}catch(_){G.err++}};" +
      "try{var XP=W.XMLHttpRequest.prototype;if(XP&&XP.open&&XP.send){" +
      "var oO=XP.open,oS=XP.send,oA=XP.abort;" +
      'XP.open=function(m9,u9){if(!this.__awI){try{this.__awM=String(m9||"").toUpperCase();this.__awU=String(u9||"")}catch(_){}}return oO.apply(this,arguments)};' +
      "if(oA)XP.abort=function(){try{this.__awA=1}catch(_){}return oA.apply(this,arguments)};" +
      'XP.send=function(){if(!this.__awI&&this.__awM==="GET"){var e9=null;try{e9=chk(canon(this.__awU))}catch(_){}' +
      "if(e9){var x9=this;var go=function(){try{if(x9.__awA)return;if(e9.st===1){awD(x9,e9)}else{oS.call(x9)}}catch(_){G.err++}};" +
      "if(e9.st===1){setTimeout(go,0)}else{e9.cb.push(go)}" +
      "return}}" +
      "return oS.apply(this,arguments)}}}catch(_){G.err++}" +
      // The WS-4 deterministic request list. tag-cache FIRST (13 s server
      // time — every ms of head start counts), Sections SECOND (unlocks the
      // chained fan-out); the genre set was byte-identical across all three
      // WS-4 boots (a stale name = one cheap query + fallthrough, never a
      // wrong serve). Truncated-in-capture tier-2 Items URLs are NOT guessed.
      //
      // JELA-685 sections-only: one URL, and sK deliberately stays null so
      // chain() never runs. Chaining the fan-out here would buy nothing - the
      // SPA is handed the same Sections body at the same instant and issues
      // its own fan-out then, so round 2 gets no head start - while doubling
      // round-2 load on a server we are trying to unblock.
      'if(awSO){enq("/HomeScreen/Sections?UserId="+aC.u);pump()}else{' +
      'sK=canon(aB+"/HomeScreen/Sections?UserId="+aC.u);' +
      'var AWL=["/JellyfinEnhanced/tag-cache/"+aC.u,"/HomeScreen/Sections?UserId="+aC.u,"/System/Info/Public","/System/Info","/Users/"+aC.u,"/UserViews?userId="+aC.u,"/DisplayPreferences/usersettings?userId="+aC.u+"&client=emby","/Branding/Configuration","/Plugins","/System/Configuration","/PluginPages/User","/CustomTabs/Config","/HomeScreen/Meta","/MediaBar/WebConfig","/JellyfinEnhanced/public-config","/JellyfinEnhanced/private-config","/JellyfinEnhanced/version","/JellyfinEnhanced/locales/en-US.json"];' +
      'var AWU=["settings","shortcuts","bookmark","elsewhere","hidden-content"],ui;for(ui=0;ui<AWU.length;ui++)AWL.push("/JellyfinEnhanced/user-settings/"+aC.u+"/"+AWU[ui]+".json");' +
      'AWL.push("/Users/"+aC.u+"/Items/Latest?IncludeItemTypes=Movie%2CSeries&Fields=DateCreated%2CPrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary&Limit=20");' +
      'AWL.push("/Shows/NextUp?Fields=DateCreated%2CPrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary&Limit=20&UserId="+aC.u);' +
      'var AWG=["Action","Adventure","Animation","Comedy","Crime","Documentary","Drama","Family","Fantasy","Horror","Mystery","Romance","Science%20Fiction","Thriller"],gi;for(gi=0;gi<AWG.length;gi++)AWL.push("/Genres?SearchTerm="+AWG[gi]+"&Limit=12&userId="+aC.u);' +
      "for(ui=0;ui<AWL.length;ui++)enq(AWL[ui]);" +
      "pump()" +
      "}" +
      "}}catch(_){G.err++}}" +
      // JELA-742 (opt-in, default OFF via
      // localStorage['jellyfin.shell.aliasCoalesce']='1'; kill-switch
      // 'jellyfin.shell.aliasCoalesceDisabled' reserved for the default-ON
      // flip): collapse the two ALIAS PAIRS the home fetches twice per boot.
      //
      // The defect (JELA-741 captures w1/w2/w3, all three boots identical):
      // the media bar fetches every slide item from BOTH /Items/{id} and
      // /Users/{u}/Items/{id}, ~300-740 ms apart, and repeats the pair on the
      // ~15.5 s rotation for as long as the home is on screen. Each carries
      // its own CORS preflight, so one slide costs 4 requests. The boot pair
      // lands at ~3,042 ms on a home whose last card change is ~5,663 ms —
      // inside the fill window, where [[boot-concurrency-queueing]] says
      // request COUNT, not bytes, sets latency. Same shape for the views
      // pair: /UserViews?userId={u} and /Users/{u}/Views, 6,612 B each.
      //
      // Why serving one from the other is sound. Measured against the live
      // server with the USER token the SPA actually holds (not a server API
      // key — a bare /Items/{id} 400s without a user context, which is why
      // the endpoint takes its user from the token):
      //   /Items/{id}          22,962 / 22,806 / 65,798 B
      //   /Users/{u}/Items/{id} 22,962 / 22,806 / 65,798 B   md5-identical
      // and the CDP capture agrees — DECODED length matches on all 5 pairs of
      // w3 (the small `encoded` deltas are header size, not body). The views
      // pair differs in exactly one field, ChildCount, and that field is
      // non-deterministic SERVER-SIDE: two consecutive calls to the SAME
      // endpoint return different counts (measured n=3: Movies 6/5/3 on
      // /UserViews alone), so coalescing loses no information that was not
      // already noise.
      //
      // Scope is deliberately narrow — a key is derived ONLY for the four
      // exact path shapes above, and only when the user id in the path/query
      // matches the stored credential's. The residual query string (minus
      // `userId` and the `_` cache-buster) is part of the key, so a caller
      // that passes Fields=/other params never coalesces with one that does
      // not — differing params mean differing bodies, and a non-matching key
      // is simply today's path. Anything unrecognised returns "" and goes to
      // the network untouched: worst case = today's boot.
      //
      // Entries are ONE-SHOT (a read deletes the slot, as apiWarm does) with a
      // 10 s TTL — 13x the widest gap observed between siblings (740 ms) and
      // comfortably under the 15.5 s rotation, so a slide's pair collapses but
      // nothing survives to the next slide. That bounds staleness exposure to
      // at most one served response per id. A token change flushes the store,
      // so another user's data is never served. Bodies over 256 KiB are not
      // stored (observed max 65,798 B) and the store is capped at 8 slots,
      // FIFO — an entry whose sibling never arrives cannot accumulate. (Under
      // the JELA-760 flag below the item shapes become multi-read on a longer
      // TTL and the ring grows to 32; the views pair keeps this one-shot 10 s.)
      //
      // A sibling that asks while the first is still IN FLIGHT parks on it and
      // is fed by the same response rather than issuing a second request; if
      // that request errors, the parked caller replays on the network.
      //
      // Installed LAST in this body, so these patches wrap OUTSIDE the
      // JELA-703 hssPin and JELA-51/685 apiWarm patches: this one sees the
      // call first (to serve it) and still records the body whether it was
      // answered by apiWarm's store or by the network. apiWarm's own prefetch
      // XHRs (__awI) are skipped so the two mechanisms stay independent.
      // One install per WINDOW (survives the document.write handoff).
      //
      // JELA-760 widens this same store into the series drill-down, behind its
      // OWN flag localStorage['jellyfin.shell.itemCache']='1' (kill-switch
      // 'jellyfin.shell.itemCacheDisabled'), so either mechanism can be flown
      // without the other.
      //
      // The defect (JELA-759 capture, home -> series -> season -> episode and
      // back out on a primed warm profile): 87 of the drill's 165 non-preflight
      // requests (52.7%) go to a byte-identical URL, carrying 713,686 B — 40.7%
      // of every byte the drill moves — against a 5.5% duplicate rate for the
      // warm boot in the SAME capture. The drill refetches its own ancestors at
      // every level: /Users/{u}/Items/{seriesId} x14 (x16 counting the alias),
      // /Shows/{seriesId}/Episodes x4 (53.7 KB each — the single largest byte
      // item in the drill), /Users/{u}/Items/{seasonId} x8,
      // /Users/{u}/Items/{episodeId} x4, plus the per-route pollers that refire
      // on every route change (tag-cache x9, user-settings x7,
      // jellyseerr/user-status x6, NotifySync/Data x6). Every one is
      // cross-origin, so each duplicate also buys a CORS preflight.
      //
      // Why this needs a CACHE and not another join. JELA-724/752's coalescer
      // joins requests that are concurrent, and JELA-742's slots are one-shot
      // because its siblings are 300-874 ms apart. The drill's re-reads are
      // SECONDS TO TENS OF SECONDS apart and separated by route changes, so
      // nothing is in flight to join and one shot covers one of fourteen. The
      // drill shapes are therefore MULTI-READ with their own TTL: the slot
      // survives every read until it ages out or a write retires it.
      //
      // Latency is explicitly NOT the target (JELA-759 measured hashChanged
      // 62-253 ms, detailUp 512 ms — a null, as in JELA-750). The lever is
      // request COUNT and wasted bytes; cf. [[boot-concurrency-queueing]].
      //
      // Counters: window.__shellACo {on,ic,rec,hit,miss,ev,err,mh,fl,sv}.
      'var cAL=flg("jellyfin.shell.aliasCoalesce")&&!flg("jellyfin.shell.aliasCoalesceDisabled");' +
      'var cIC=flg("jellyfin.shell.itemCache")&&!flg("jellyfin.shell.itemCacheDisabled");' +
      "if((cAL||cIC)&&!W.__shellACo){try{" +
      'var cC=null;try{var cc0=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null"),cs0=cc0&&cc0.Servers&&cc0.Servers[0];if(cs0&&cs0.AccessToken&&cs0.UserId)cC={t:cs0.AccessToken,u:String(cs0.UserId).toLowerCase(),a:String(cs0.ManualAddress||cs0.LocalAddress||"")}}catch(_){}' +
      'var cB="";try{cB=String(srv()||(cC&&cC.a)||"").replace(/\\/+$/,"")}catch(_){}' +
      "if(cC&&/^https?:\\/\\//.test(cB)){" +
      "var co=W.__shellACo={on:1,ic:cIC?1:0,rec:0,hit:0,miss:0,ev:0,err:0,mh:0,fl:0,sv:0};" +
      'var cTTL=10000;try{var ct0=parseInt(localStorage.getItem("jellyfin.shell.aliasCoalesceTtlMs")||"",10);if(ct0>=1000&&ct0<=60000)cTTL=ct0}catch(_){}' +
      // JELA-760 TTLs. 30 s spans the drill's own re-reads (its longest step
      // is 9.3 s and the whole six-step walk is ~30 s of wall clock) without
      // outliving the visit; plugin config gets 60 s because it is read once
      // per route change and only its own namespace can write it.
      'var cITTL=30000;try{var ci0=parseInt(localStorage.getItem("jellyfin.shell.itemCacheTtlMs")||"",10);if(ci0>=1000&&ci0<=300000)cITTL=ci0}catch(_){}' +
      'var cCTTL=60000;try{var cg0=parseInt(localStorage.getItem("jellyfin.shell.itemCacheCfgTtlMs")||"",10);if(cg0>=1000&&cg0<=600000)cCTTL=cg0}catch(_){}' +
      // A drill touches a series, up to 4 seasons and their episodes plus the
      // pollers, so the 8-slot alias ring would thrash; 32 covers the walk and
      // is still bounded by the same 256 KiB body cap (largest observed body
      // is the 53.7 KB episode list).
      "var cSto={},cOrd=[],cMAX=cIC?32:8,cCAP=262144;" +
      'var cBL=[cB];try{var cb2=String(cC.a||"").replace(/\\/+$/,"");if(cb2&&cb2!==cB)cBL.push(cb2)}catch(_){}' +
      // cKey: URL -> alias key, or "" for "do not touch". Server-relative,
      // user-checked, residual query sorted into the key.
      'var cKey=function(u){try{u=String(u||"");' +
      'for(var bi=0;bi<cBL.length;bi++){if(u.indexOf(cBL[bi]+"/")===0){u=u.slice(cBL[bi].length);break}}' +
      'if(u.charAt(0)!=="/"||u.charAt(1)==="/")return"";' +
      'var qi=u.indexOf("?"),pp=qi<0?u:u.slice(0,qi),qs=qi<0?"":u.slice(qi+1);' +
      'var ps=qs?qs.split("&"):[],res=[],uid="",pi;' +
      "for(pi=0;pi<ps.length;pi++){var nm=ps[pi].split(\"=\")[0];if(nm==='_')continue;" +
      'if(nm.toLowerCase()==="userid"){try{uid=decodeURIComponent(ps[pi].slice(ps[pi].indexOf("=")+1)||"").toLowerCase()}catch(_){uid="?"}continue}' +
      "res.push(ps[pi])}" +
      'res.sort();var rq=res.join("&");' +
      "var m=/^\\/Users\\/([0-9a-fA-F]{32})\\/Items\\/([0-9a-fA-F]{32})$/.exec(pp);" +
      'if(m){if(m[1].toLowerCase()!==cC.u||(uid&&uid!==cC.u))return"";return"I:"+m[2].toLowerCase()+"?"+rq}' +
      "m=/^\\/Items\\/([0-9a-fA-F]{32})$/.exec(pp);" +
      'if(m){if(uid&&uid!==cC.u)return"";return"I:"+m[1].toLowerCase()+"?"+rq}' +
      "if(cAL){m=/^\\/Users\\/([0-9a-fA-F]{32})\\/Views$/.exec(pp);" +
      'if(m){if(m[1].toLowerCase()!==cC.u||(uid&&uid!==cC.u))return"";return"V:?"+rq}' +
      'if(pp==="/UserViews")return uid===cC.u?"V:?"+rq:""}' +
      // JELA-760 drill shapes, armed only under itemCache so a JELA-742 fleet
      // flip cannot pick them up. Same discipline as the alias keys above: the
      // residual query (userId and the `_` buster removed, the rest sorted) is
      // part of the key, so a caller asking for different Fields never reads
      // another caller's projection, and an unrecognised path returns "" and
      // goes to the network untouched.
      "if(cIC){" +
      "m=/^\\/Shows\\/([0-9a-fA-F]{32})\\/Episodes$/.exec(pp);" +
      'if(m){if(uid&&uid!==cC.u)return"";return"E:"+m[1].toLowerCase()+"?"+rq}' +
      "m=/^\\/Items\\/([0-9a-fA-F]{32})\\/ThemeMedia$/.exec(pp);" +
      'if(m){if(uid&&uid!==cC.u)return"";return"T:"+m[1].toLowerCase()+"?"+rq}' +
      'if(pp==="/Shows/NextUp")return uid&&uid!==cC.u?"":"N:?"+rq;' +
      // A C: key carries the PLUGIN ROOT it came from ("C:<root>/<what>?…") so
      // cFl can retire one plugin's config without touching another's — see
      // the invalidation note below.
      "m=/^\\/JellyfinEnhanced\\/tag-cache\\/([0-9a-fA-F]{32})$/.exec(pp);" +
      'if(m)return m[1].toLowerCase()===cC.u?"C:JellyfinEnhanced/tag?"+rq:"";' +
      "m=/^\\/JellyfinEnhanced\\/user-settings\\/([0-9a-fA-F]{32})\\/([A-Za-z0-9._-]{1,64})$/.exec(pp);" +
      'if(m)return m[1].toLowerCase()===cC.u?"C:JellyfinEnhanced/us/"+m[2]+"?"+rq:"";' +
      'if(pp==="/JellyfinEnhanced/jellyseerr/user-status")return"C:JellyfinEnhanced/jsr?"+rq;' +
      'if(pp==="/NotifySync/Data")return"C:NotifySync/data?"+rq}' +
      'return""}catch(_){co.err++;return""}};' +
      'var cTok=function(){try{var c2=JSON.parse(localStorage.getItem("jellyfin_credentials")||"null"),s2=c2&&c2.Servers&&c2.Servers[0];return!!(s2&&s2.AccessToken===cC.t)}catch(_){return!1}};' +
      // cGet consumes a ONE-SHOT slot: it is deleted, and the caller keeps the
      // ref (an in-flight entry still feeds its parked waiter through that
      // ref). A JELA-760 slot is MULTI-READ (e.m) and survives the read, so
      // one recorded body answers the whole drill until its TTL expires or a
      // write retires it. `mh` counts served multi-reads and `sv` the bytes
      // they kept off the wire — read those, never a request count, to decide
      // whether the cache fired (cf. [[jela742-alias-coalesce]]).
      "var cGet=function(k){if(!k)return null;var e=cSto[k];if(!e)return null;" +
      "if(!cTok()){cSto={};cOrd=[];return null}" +
      "if(e.st===2||+new Date()>e.x){delete cSto[k];return null}" +
      "if(!e.m)delete cSto[k];else if(e.st===1){co.mh++;co.sv+=e.t.length}" +
      "co.hit++;return e};" +
      // Which shapes are multi-read, and for how long. The alias/views pair
      // keeps JELA-742's one-shot 10 s exactly as measured; everything JELA-760
      // adds is multi-read.
      'var cMul=function(k){if(!cIC)return 0;var p=k.charAt(0);return p==="I"||p==="E"||p==="N"||p==="T"||p==="C"?1:0};' +
      'var cDur=function(k){if(!cIC)return cTTL;var p=k.charAt(0);if(p==="C")return cCTTL;return p==="V"?cTTL:cITTL};' +
      "var cNew=function(k){if(!k||cSto[k])return null;" +
      'var d=cDur(k),e={st:0,s:0,t:"",cb:[],m:cMul(k),d:d,x:+new Date()+d};cSto[k]=e;cOrd.push(k);co.miss++;' +
      "while(cOrd.length>cMAX){var k0=cOrd.shift();if(cSto[k0]){delete cSto[k0];co.ev++}}return e};" +
      "var cDone=function(e,ok,st,tx){try{if(!e||e.st!==0)return;" +
      "if(ok&&tx&&tx.length<=cCAP){e.st=1;e.s=st||200;e.t=String(tx);e.x=+new Date()+(e.d||cTTL);co.rec++}else e.st=2;" +
      "var cbs=e.cb;e.cb=[];for(var i=0;i<cbs.length;i++){try{cbs[i]()}catch(_){co.err++}}}catch(_){co.err++}};" +
      // JELA-760 invalidation. A multi-read slot must retire when the body it
      // holds can have changed, but a BLANKET non-GET flush is fatal over a
      // drill dwell: JELA-757 measured a third-party
      // POST /JellyfinEnhanced/user-settings/{u}/settings.json landing inside
      // EVERY ~18 s dwell, which emptied that store on 3/3 runs. So the flush
      // is CLASSED by namespace: a write under a plugin namespace retires only
      // the C: config slots, and anything else — item writes, play-state
      // writes, and every unrecognised path — retires the item slots and
      // leaves config alone. Only writes that provably cannot touch an item
      // body or its UserData are exempt outright. Unknown still flushes, so a
      // shape we have not seen fails toward correctness.
      //
      // The config half is scoped one step further, to the WRITING PLUGIN'S
      // ROOT. Replaying the JELA-759 capture through this shim showed why: the
      // seven settings.json POSTs are all JellyfinEnhanced's, yet a root-blind
      // config flush also retired NotifySync's slot — a different plugin, a
      // different controller, a body the write cannot reach. Scoping recovers
      // 16 of the drill's requests (78 -> 94 eliminated) and closes a real
      // cross-plugin coupling. It stays conservative WITHIN a plugin: a
      // JellyfinEnhanced write still retires every JellyfinEnhanced slot,
      // because one plugin's endpoints can legitimately share state.
      'var cFl=function(u){try{if(!cIC)return;var p=String(u||"");' +
      'for(var fi=0;fi<cBL.length;fi++){if(p.indexOf(cBL[fi]+"/")===0){p=p.slice(cBL[fi].length);break}}' +
      'var fq=p.indexOf("?");if(fq>=0)p=p.slice(0,fq);' +
      "if(/^\\/(DisplayPreferences|QuickConnect|Sessions\\/Capabilities|Sessions\\/Viewing)/.test(p))return;" +
      "var fm=/^\\/(JellyfinEnhanced|NotifySync|CustomTabs|MediaBar)\\//.exec(p);" +
      'var fc=!!fm,fp=fm?"C:"+fm[1]+"/":"",n=0,k,no=[],oi;' +
      "for(k in cSto){if(!Object.prototype.hasOwnProperty.call(cSto,k))continue;" +
      "if(fc){if(k.indexOf(fp)===0){delete cSto[k];n++}}" +
      'else if(k.charAt(0)!=="C"){delete cSto[k];n++}}' +
      "if(n){co.fl+=n;for(oi=0;oi<cOrd.length;oi++)if(cSto[cOrd[oi]])no.push(cOrd[oi]);cOrd=no}" +
      "}catch(_){co.err++}};" +
      // fetch: serve a completed entry as a synthesized Response, park on an
      // in-flight one, else record the real response off a clone().
      'var cMk=null;try{if(typeof Response==="function")cMk=function(e){return new Response(e.s===204?null:e.t,{status:e.s||200,headers:{"Content-Type":"application/json"}})}}catch(_){}' +
      'if(typeof W.fetch==="function"&&cMk){try{var cF=W.fetch;W.fetch=function(cu,cop){try{' +
      'if(!(cop&&cop.method)||String(cop.method).toUpperCase()==="GET"){' +
      'var ck=cKey(typeof cu==="string"?cu:String((cu&&cu.url)||""));' +
      "if(ck){var ce=cGet(ck);" +
      "if(ce){if(ce.st===1)return Promise.resolve(cMk(ce));" +
      "var cF2=cF,car=arguments;return new Promise(function(rs){ce.cb.push(function(){" +
      "if(ce.st===1){try{rs(cMk(ce));return}catch(_){}}rs(cF2.apply(W,car))})})}" +
      "var cn=cNew(ck);if(cn){var cp=cF.apply(W,arguments);" +
      "try{cp.then(function(r){try{" +
      "if(r&&r.status>=200&&r.status<300)r.clone().text().then(function(tx){cDone(cn,1,r.status,tx)},function(){cDone(cn,0)});" +
      "else cDone(cn,0)}catch(_){cDone(cn,0)}},function(){cDone(cn,0)})}catch(_){cDone(cn,0)}" +
      "return cp}}}" +
      'else{var cmm=String(cop.method).toUpperCase();if(cmm!=="HEAD")cFl(typeof cu==="string"?cu:String((cu&&cu.url)||""))}' +
      "}catch(_){co.err++}" +
      "return cF.apply(W,arguments)}}catch(_){co.err++}}" +
      // XHR delivery: own-property shadows over the prototype accessors, then
      // the three completion events (same shape as the apiWarm serve above).
      "var cD=function(x,e){try{" +
      "var df=function(n,v){try{Object.defineProperty(x,n,{configurable:!0,value:v})}catch(_){try{x[n]=v}catch(__){}}};" +
      'df("readyState",4);df("status",e.s||200);df("statusText","OK");' +
      'var rt="";try{rt=String(x.responseType||"")}catch(_){}' +
      'if(rt===""||rt==="text")df("responseText",e.t);' +
      'if(rt==="json"){var pj=null;try{pj=JSON.parse(e.t)}catch(_){}df("response",pj)}else df("response",e.t);' +
      'df("getAllResponseHeaders",function(){return"content-type: application/json\\r\\n"});' +
      'df("getResponseHeader",function(h){return String(h||"").toLowerCase()==="content-type"?"application/json":null});' +
      'var evs=["readystatechange","load","loadend"];for(var ei=0;ei<evs.length;ei++){var fd=0;' +
      'try{if(typeof Event==="function"&&x.dispatchEvent){x.dispatchEvent(new Event(evs[ei]));fd=1}}catch(_){}' +
      'if(!fd){try{var h5=x["on"+evs[ei]];if(typeof h5==="function")h5.call(x,{type:evs[ei],target:x})}catch(_){co.err++}}}' +
      "}catch(_){co.err++}};" +
      "try{var CXP=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(CXP&&CXP.open&&CXP.send){" +
      "var cO=CXP.open,cS=CXP.send,cAb=CXP.abort;" +
      'CXP.open=function(cm2,cu2){try{this.__acM=String(cm2||"").toUpperCase();this.__acU=String(cu2||"")}catch(_){}return cO.apply(this,arguments)};' +
      "if(cAb)CXP.abort=function(){try{this.__acA=1}catch(_){}return cAb.apply(this,arguments)};" +
      'CXP.send=function(){var cx=this;try{if(!cx.__awI&&cx.__acM==="GET"){var ck2=cKey(cx.__acU);' +
      "if(ck2){var ce2=cGet(ck2);" +
      "if(ce2){var cgo=function(){try{if(cx.__acA)return;if(ce2.st===1)cD(cx,ce2);else cS.call(cx)}catch(_){co.err++}};" +
      "if(ce2.st===1)setTimeout(cgo,0);else ce2.cb.push(cgo);return}" +
      "var cn2=cNew(ck2);" +
      'if(cn2)cx.addEventListener("loadend",function(){try{' +
      'var ok=cx.status>=200&&cx.status<300,tx="";' +
      'if(ok){var rt2="";try{rt2=String(cx.responseType||"")}catch(_){}' +
      'if(rt2===""||rt2==="text"){try{tx=String(cx.responseText||"")}catch(_){ok=0}}else ok=0}' +
      "cDone(cn2,ok?1:0,cx.status,tx)}catch(_){cDone(cn2,0)}})}}" +
      'else if(cx.__acM&&cx.__acM!=="GET"&&cx.__acM!=="HEAD")cFl(cx.__acU)}catch(_){co.err++}' +
      "return cS.apply(cx,arguments)}}}catch(_){co.err++}" +
      "}}catch(_){G.err++}}" +
      "}catch(_){}})();"
    );
  }

  // JEL-647: NOT legacy-gated (unlike injectBootProgress) — the 9-13 s warm
  // first-paint gap this covers was measured on QN90B's Chromium 85. Called
  // with the widget document (bootstrap), the DOMParser-path doc, and
  // mirrored as a string splice in the fast path.
  function injectInstantHome(doc) {
    var ihTag = doc.createElement("script");
    ihTag.setAttribute("data-shell-instant-home", "1");
    ihTag.textContent = instantHomeBody();
    doc.head.appendChild(ihTag);
  }

  // JELA-29 (WS-A / JELA-24 Lever 1): Direct-Home render prototype.
  //
  // OPT-IN measurement prototype (default OFF). When
  // localStorage['jellyfin.shell.directHome']==='1' AND the boot is an authed
  // saved-server auto-login, this paints REAL home-section cards (Continue
  // Watching / Next Up / Latest) fetched straight from the Jellyfin API with
  // the stored AccessToken — BEFORE/without the full web-client SPA bundle
  // parsing+executing. It exists to answer the JELA-24 Lever-1 measurement
  // gate: how much of the warm-live ~9 s launch->first-card floor is removable
  // by skipping the bundle parse/eval on the M63 SoC.
  //
  // JELA-33 (WS-A/C2, A2+A3 — C1/JELA-29 A1 gate returned GO): the overlay is
  // now NAVIGABLE and fused with Instant-Home.
  //
  // A2 — navigation. The grid keeps item Ids alongside art URLs and paints a
  // synthetic focus ring (outline on the focused tile; still divs only, no
  // tabbables — keys arrive via the same capture-phase window keydown the A1
  // dismiss used). While the overlay is painted:
  //   Left/Right/Up/Down (37/39/38/40)  move focus (clamped), mark G.navved
  //   Enter (13)                        open item: SPA routed via
  //                                     location.hash="#/details?id=..&serverId=.."
  //                                     then dismiss("open") — jellyfin-web
  //                                     honors the initial hash when it boots
  //   MediaPlay/PlayPause (415/10252)   same as Enter + G.playIntent: a bounded
  //                                     20 s poll clicks the details page's
  //                                     .btnPlay once it hydrates (best-effort)
  //   Back (10009/461/27)               dismiss("back") — reveals the SPA
  //   any other key                     dismiss("input") NOT eaten (A1 escape
  //                                     hatch; SPA still sees the key)
  // Handled keys are preventDefault+stopPropagation'd so the booting SPA never
  // double-acts on them; when the overlay is absent/empty the handler returns
  // WITHOUT eating, so non-home flows and playback keys pass through untouched.
  // Once G.navved, SPA hydration no longer auto-dismisses (the user is driving
  // the grid; Enter/Back/route are the exits) and the 90 s idle cap stretches
  // to a 15 min absolute cap. Un-navigated boots keep the exact A1 contract:
  // crossfade on >=4 .card hydration / route / 90 s.
  //
  // A3 — Instant-Home fusion. The cached snapshot stays the 0-RTT first paint;
  // this grid fades in OVER it (opacity 0->1 .3s on first creation, opaque
  // #101010 above the snapshot's z-index) and instantHomeBody's watch tick
  // dismisses the snapshot with why:"dh" the moment G.painted is set — the
  // static crossfade-to-SPA is replaced by snapshot->live-grid->SPA.
  //
  // JELA-54 (user decision, JELA-52 ask 00d36d8f): the A3 flow above is now
  // the OPT-OUT path. With hold-cover on (default) this body stands down
  // right after the directHome opt-in gate (window.__shellDHHeld=1) and the
  // boot is snapshot->settled-SPA-reveal; set
  // localStorage['jellyfin.shell.instantHomeHoldCoverDisabled']='1' (or
  // disable Instant-Home) to restore the grid.
  //
  // Timing readout (no CDP needed): launch->first-real-card is recorded as
  // window.__shellDH.firstCardMs AND as the "dhcard" boot-phase (persisted in
  // the jellyfin.shell.bootPhases ring), so a >=3-boot A1 measurement is
  // readable from the SAME channel the SPA "card" phase uses. The focus ring
  // is painted in the same repaint that records dhcard, so dhcard IS the
  // "navigable card" mark for the JELA-33 G1 gate (mirrored as G.navReadyMs);
  // Enter records the "dhopen" phase + G.{opened,openId,openMs,playIntent}.
  // window.__shellDH also carries {fetchMs, sections, cards, err,
  // http:{path:status}, why, focusR, focusC, navved, played}.
  //
  // A0 spike (verified 2026-07-07 against the live 10.11.11 server): the
  // standalone handoff is serverUrl=localStorage['jellyfin.shell.serverUrl'],
  // token+userId=jellyfin_credentials.Servers[0].{AccessToken,UserId}, auth
  // header X-Emby-Token; GET /Users/{u}/Items/Resume, /Shows/NextUp,
  // /UserViews (+ /Users/{u}/Items/Latest?ParentId=) all 401 without the token
  // and 200 with it; /Items/{id}/Images/Primary is public (no token) so card
  // art paints directly. No ApiClient dependency — the bundle need not run.
  //
  // Body constraints (identical to instantHomeBody): ES5 only (pre-polyfill
  // Chromium 56/63), no "</script" literal, every section try/caught, divs
  // only (no tabbables), overlay pointer-events:none + aria-hidden.
  // Opt-in/kill switch: localStorage['jellyfin.shell.directHome'] (='1' ON).
  // shell.js-only: the hosted /shell/ the TV loads is this file's min; the
  // baked bootstrap fallback is not the measurement target, so directHome is
  // deliberately NOT mirrored into boot-shell.src.js (cross-shell-parity only
  // guards names SHARED by both shells).
  function directHomeBody() {
    return (
      "(function(){try{" +
      'try{if(localStorage.getItem("jellyfin.shell.directHome")!=="1")return}catch(_){return}' +
      // JELA-54 hold-cover: while the Instant-Home cover is active AND
      // hold-cover is on (both default states), the grid stands down entirely —
      // it paints ABOVE the snapshot (z 2147483100 > 2147483000), so merely
      // skipping the "dh" dismissal would not hold the cover visually, and a
      // covered grid must never own input. __shellDHHeld is the QA marker.
      // Grid behavior is fully restored by either opt-out
      // (instantHomeDisabled=1 or instantHomeHoldCoverDisabled=1).
      'try{if(localStorage.getItem("jellyfin.shell.instantHomeDisabled")!=="1"&&localStorage.getItem("jellyfin.shell.instantHomeHoldCoverDisabled")!=="1"){window.__shellDHHeld=1;return}}catch(_){}' +
      'var W=window,OID="__shell_direct_home";' +
      "var G=W.__shellDH;" +
      'if(!G)G=W.__shellDH={gen:0,enabled:1,fetched:0,painted:0,fetchMs:0,firstCardMs:0,navReadyMs:0,cards:0,sections:0,err:0,dismissed:0,why:"",dismissMs:0,rows:[],http:{},grid:[],shown:0,fadeDone:0,focusR:-1,focusC:0,navved:0,opened:0,openId:"",openMs:0,playIntent:0,played:0};' +
      "var gen=++G.gen;" +
      "var t0=+new Date();" +
      "var T0=W.__shellT0||t0;" +
      'function srv(){try{return localStorage.getItem("jellyfin.shell.serverUrl")||""}catch(_){return""}}' +
      'function creds(){try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return null;var p=JSON.parse(c);var s=p&&p.Servers&&p.Servers[0];if(!s||!s.AccessToken||!s.UserId)return null;return{t:s.AccessToken,u:s.UserId,sid:String(s.Id||""),a:(s.ManualAddress||s.LocalAddress||"")}}catch(_){return null}}' +
      "var cr=creds();var base=srv()||(cr&&cr.a)||'';" +
      'if(!cr||!base){G.why="nocreds";return}' +
      'base=String(base).replace(/\\/+$/,"");' +
      "function el0(){try{return document.getElementById(OID)}catch(_){return null}}" +
      'function dismiss(why){if(G.dismissed)return;G.dismissed=1;G.why=why;G.dismissMs=+new Date()-T0;try{var e=el0();if(e){e.style.opacity="0";setTimeout(function(){try{e.parentNode&&e.parentNode.removeChild(e)}catch(_){}},400)}}catch(_){}}' +
      'function folds(){var n=0;try{var cs=document.querySelectorAll(".card"),vh=W.innerHeight||1080;for(var i=0;i<cs.length&&n<8;i++){var r=cs[i].getBoundingClientRect();if(r.width>0&&r.height>0&&r.top<vh&&r.bottom>0)n++}}catch(_){}return n}' +
      'function imgUrl(it){try{var id=it.Id,tag=it.ImageTags&&it.ImageTags.Primary;if(!tag&&it.SeriesId){id=it.SeriesId;tag=it.SeriesPrimaryImageTag}if(!id)return"";var u=base+"/Items/"+id+"/Images/Primary?fillHeight=330&quality=90"+(tag?("&tag="+tag):"");return u.replace(/["\'()\\\\\\s]/g,"")}catch(_){return""}}' +
      // JELA-33 A2: synthetic focus ring — pure style on the focused tile, so
      // the overlay stays divs-only/no-tabbables and never steals DOM focus.
      'function ring(){try{var R=G.grid,i,j;for(i=0;i<R.length;i++)for(j=0;j<R[i].length;j++){var n=R[i][j].el;if(!n||!n.style)continue;if(i===G.focusR&&j===G.focusC){n.style.outline="4px solid #00a4dc";n.style.outlineOffset="-4px"}else{n.style.outline="";n.style.outlineOffset=""}}}catch(_){G.err++}}' +
      "function repaint(){try{" +
      "if(G.dismissed||!G.rows.length)return;" +
      "var de=document.documentElement;if(!de||!de.appendChild)return;" +
      "var e=el0();if(e&&e.__n===G.rows.length)return;" +
      "if(e){try{e.parentNode&&e.parentNode.removeChild(e)}catch(_){}}" +
      'e=document.createElement("div");e.id=OID;e.setAttribute("aria-hidden","true");' +
      'e.style.cssText="position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483100;background:#101010;pointer-events:none;overflow:hidden;opacity:"+(G.fadeDone?"1":"0")+";transition:opacity .3s;font-family:sans-serif";' +
      "var vw=W.innerWidth||1920,vh=W.innerHeight||1080,y=64,painted=0,r,i;G.grid=[];" +
      "for(r=0;r<G.rows.length;r++){var row=G.rows[r],its=row.items||[];if(!its.length)continue;" +
      'var tt=document.createElement("div");tt.textContent=row.title||"";' +
      'tt.style.cssText="position:absolute;left:48px;top:"+y+"px;color:#e8e8e8;font:600 28px sans-serif;white-space:nowrap;overflow:hidden";' +
      "e.appendChild(tt);y+=44;" +
      "var x=48,cw=210,ch=310,gap=16,ge=[];" +
      "for(i=0;i<its.length;i++){var u=its[i];if(!u||!u.u)continue;" +
      'var c=document.createElement("div");' +
      'c.style.cssText="position:absolute;left:"+x+"px;top:"+y+"px;width:"+cw+"px;height:"+ch+"px;border-radius:6px;background:#1f1f1f url("+u.u+") center center no-repeat;background-size:cover";' +
      'e.appendChild(c);ge.push({el:c,id:u.id||""});x+=cw+gap;painted++;if(x+cw>vw)break}' +
      "if(ge.length)G.grid.push(ge);" +
      "y+=ch+36;if(y>vh)break}" +
      "e.__n=G.rows.length;de.appendChild(e);" +
      // JELA-33 A3: the grid fades in over the Instant-Home snapshot beneath
      // (0-RTT first paint -> live grid crossfade). One-shot timer armed on
      // the first creation; it flips whatever the NEWEST overlay is (rows
      // arriving mid-fade rebuild it) and later rebuilds reappear opaque.
      'if(!G.shown){G.shown=1;setTimeout(function(){try{G.fadeDone=1;var f=el0();if(f&&!G.dismissed)f.style.opacity="1"}catch(_){}},30)}' +
      "if(G.grid.length){if(G.focusR<0){G.focusR=0;G.focusC=0}else{if(G.focusR>=G.grid.length)G.focusR=G.grid.length-1;if(G.focusC>=G.grid[G.focusR].length)G.focusC=G.grid[G.focusR].length-1}ring()}" +
      'if(painted){G.cards=painted;if(!G.painted){G.painted=1;G.firstCardMs=+new Date()-T0;G.navReadyMs=G.firstCardMs;try{W.__shellPhase&&W.__shellPhase("dhcard")}catch(_){}}}' +
      "}catch(_){G.err++}}" +
      'function addRow(title,items){try{if(G.dismissed||!items||!items.length)return;var os=[],i;for(i=0;i<items.length&&os.length<12;i++){var u=imgUrl(items[i]);if(u)os.push({u:u,id:String(items[i].Id||"")})}if(!os.length)return;G.rows.push({title:title,items:os});G.sections++;repaint()}catch(_){G.err++}}' +
      'function get(path,cb){try{var x=new XMLHttpRequest();x.open("GET",base+path,!0);x.setRequestHeader("X-Emby-Token",cr.t);x.setRequestHeader("Accept","application/json");x.onreadystatechange=function(){if(x.readyState===4){try{G.http[path]=x.status}catch(_){}if(x.status>=200&&x.status<300){var d=null;try{d=JSON.parse(x.responseText)}catch(_){}cb(d)}else{cb(null)}}};x.send()}catch(_){G.err++;try{cb(null)}catch(__){}}}' +
      // JELA-33 A2: D-pad navigation + open/play. Handled keys are eaten so
      // the SPA booting underneath never double-acts; anything unhandled keeps
      // the A1 dismiss-and-pass-through escape hatch.
      "function eat(ev){try{ev&&ev.preventDefault&&ev.preventDefault();ev&&ev.stopPropagation&&ev.stopPropagation()}catch(_){}}" +
      "function nav(k){try{var R=G.grid;if(!R.length)return;var r=G.focusR<0?0:G.focusR,c=G.focusC<0?0:G.focusC;" +
      "if(k===37){if(c>0)c--}else if(k===39){if(c<R[r].length-1)c++}else if(k===38){if(r>0)r--}else if(k===40){if(r<R.length-1)r++}" +
      "if(c>=R[r].length)c=R[r].length-1;if(c<0)c=0;" +
      "G.focusR=r;G.focusC=c;G.navved=1;ring()}catch(_){G.err++}}" +
      // Best-effort play: once the SPA hydrates the details route we sent it
      // to, click its primary .btnPlay exactly once (bounded 20 s, abandons if
      // the user routed elsewhere). Failure degrades to the details page.
      "function armPlay(id){try{var t1=+new Date(),pIv=setInterval(function(){try{" +
      "if(+new Date()-t1>20000){clearInterval(pIv);return}" +
      'var h="";try{h=String(location.hash||"")}catch(_){}' +
      "if(h.indexOf(id)===-1){clearInterval(pIv);return}" +
      'var b=document.querySelector&&document.querySelector(".btnPlay");' +
      "if(b&&!b.disabled){clearInterval(pIv);G.played=1;try{b.click()}catch(_){}}" +
      "}catch(_){G.err++}},700)}catch(_){G.err++}}" +
      "function open(play){try{var R=G.grid;if(G.focusR<0||!R[G.focusR])return;var it=R[G.focusR][G.focusC];if(!it||!it.id)return;" +
      "G.opened=1;G.openId=it.id;G.openMs=+new Date()-T0;if(play)G.playIntent=1;" +
      'try{location.hash="#/details?id="+encodeURIComponent(it.id)+(cr.sid?"&serverId="+encodeURIComponent(cr.sid):"")}catch(_){}' +
      'try{W.__shellPhase&&W.__shellPhase("dhopen")}catch(_){}' +
      'dismiss(play?"play":"open");' +
      "if(play)armPlay(it.id)}catch(_){G.err++}}" +
      "function onKey(ev){try{if(G.gen!==gen)return;if(G.dismissed)return;if(!el0()||!G.grid.length){return}" +
      "var k=(ev&&(ev.keyCode||ev.which))||0;" +
      "if(k===37||k===38||k===39||k===40){eat(ev);nav(k);return}" +
      "if(k===13){eat(ev);open(0);return}" +
      "if(k===415||k===10252){eat(ev);open(1);return}" +
      'if(k===10009||k===461||k===27){eat(ev);dismiss("back");return}' +
      'dismiss("input")}catch(_){G.err++}}' +
      // JELA-33 G1 fix: document.open() (the SPA index handoff) wipes ALL
      // window listeners, and this body re-runs once per written document
      // (gen++), so the keydown bind must be per-run, not once-per-G. The old
      // persistent G.inputBound gate left post-swap boots with a painted grid
      // and DEAD keys (a navved overlay could then sit for the full 15 min
      // cap; measured on the Q60R: swap lands ~1-3 s after T0, i.e. before a
      // real user's first keypress). One body run per document means no
      // same-window double-bind; the gen guard in onKey turns any
      // engine-quirk survivor listener inert instead of double-acting.
      // G.inputBound stays as a bind-count diagnostic.
      'G.inputBound=(G.inputBound||0)+1;try{W.addEventListener("keydown",onKey,!0)}catch(_){}' +
      "if(!G.fetched){G.fetched=1;G.fetchMs=+new Date()-T0;" +
      'get("/Users/"+cr.u+"/Items/Resume?Limit=12&MediaTypes=Video&Recursive=true&EnableImageTypes=Primary&Fields=PrimaryImageAspectRatio",function(d){addRow("Continue Watching",d&&d.Items)});' +
      'get("/Shows/NextUp?UserId="+cr.u+"&Limit=16&EnableImageTypes=Primary&Fields=PrimaryImageAspectRatio",function(d){addRow("Next Up",d&&d.Items)});' +
      'get("/UserViews?userId="+cr.u,function(d){var v=d&&d.Items;if(!v||!v.length)return;var pv=null,i;for(i=0;i<v.length;i++){var ct=v[i].CollectionType;if(ct==="movies"||ct==="tvshows"){pv=v[i];break}}if(!pv)pv=v[0];get("/Users/"+cr.u+"/Items/Latest?ParentId="+pv.Id+"&Limit=16&EnableImageTypes=Primary&Fields=PrimaryImageAspectRatio",function(l){addRow("Latest "+(pv.Name||""),l)})});' +
      "}" +
      "repaint();" +
      "var wIv=setInterval(function(){try{" +
      "if(G.gen!==gen||G.dismissed){clearInterval(wIv);return}" +
      // JELA-33 A2: once the user is driving the grid (navved) the SPA
      // hydrating underneath must not yank it away — Enter/Back/route are the
      // exits; the idle 90 s cap stretches to a 15 min absolute cap.
      'var age=+new Date()-t0;if(age>900000||(age>90000&&!G.navved)){dismiss("cap");clearInterval(wIv);return}' +
      'var h="";try{h=String(location.hash||"")}catch(_){}' +
      'if(h.indexOf("login")!==-1||h.indexOf("selectserver")!==-1||h.indexOf("wizard")!==-1){dismiss("route");clearInterval(wIv);return}' +
      'if(!G.navved&&folds()>=4){dismiss("hydrated");clearInterval(wIv);return}' +
      "repaint();" +
      "}catch(_){G.err++}},700);" +
      "}catch(_){}})();"
    );
  }

  // JELA-30 (WS-C/C3): opt-in boot-ring diag beacon. Posts the persisted
  // JEL-617 bootPhases ring (last 10 boots) + this boot's __shellTx* counters
  // to the server-plugin's POST /shell/diag, so an operator can read a fielded
  // TV's boot health over HTTP — no sdb session, no CDP, no power-cycle (the
  // recurring cost across JELA-13/21/26/27).
  //
  // JELA-827: fleet-ON (opt-OUT). This shipped OPT-IN — inert unless
  // localStorage['jellyfin.shell.diagBeacon'] === '1' — and the "1" is written
  // by the JEL-197 JS-Injector snippet channel, which only runs AFTER the
  // lite→SPA handoff (JELA-802). The key is therefore ABSENT on every cold
  // boot (fresh install, LS wipe, quota eviction), so the beacon was dead for
  // exactly the boots an operator most needs reported: first install and
  // post-eviction. Read for the kill switch instead — an absent key now means
  // ON. Per-TV kill: localStorage['jellyfin.shell.diagBeacon'] = '0'.
  // NOTE: the standing JELA-34 channel seeder re-writes "1" whenever the key
  // is not already "1", so a per-TV "0" survives only the boot it is set in
  // until that seeder's guard is changed to `!== "0"` (tracked separately).
  // Egress is unchanged and still self-only: the target is the user's own
  // server (see the redaction paragraph below); the fleet is already seeded
  // "1", so this changes behaviour ONLY on key-absent boots.
  //
  // Redaction / egress (JEL-139, WS-F folded into JELA-30): the payload is
  // built ONLY from (a) the numeric bootPhases ring records, (b) numeric
  // __shellTx* counters, (c) the __SHELL_VER__ version string already inside
  // each ring record, and (d) an OPAQUE device id — an fnv1a-base36 hash of a
  // once-generated random seed persisted at jellyfin.shell.diagId; never the
  // DUID/serial/MAC, so the id is unlinkable to hardware or account. The
  // serverUrl is used as the POST TARGET only and never appears in the body:
  // the beacon reports the user's own server TO that same server (zero
  // third-party egress). The server re-sanitizes everything anyway
  // (DiagIngestService whitelists + extracts; nothing here is trusted).
  //
  // Send discipline: one POST per boot (armed latch on window — survives the
  // document.write handoff), fired from a 3 s poll once the current boot's
  // home/card mark lands (so the freshest ring record and tx counters are
  // filled in) or at a 60 s cap for boots that never reach home. Prior boots'
  // completed records ride along every time; the server dedupes by (id, boot
  // ts) keeping the most complete copy, so re-posting is free and a boot that
  // died mid-way is reported by the NEXT healthy boot. A failed POST is not
  // retried this boot for the same reason. Content-Type text/plain keeps the
  // POST a CORS "simple request" from the file:// widget origin (the
  // controller parses the body as JSON regardless).
  //
  // Injected into the WRITTEN document only (DOMParser path + string fast
  // path): the widget document's timers may not survive document.open, and a
  // boot that never reaches the written document has no reachable server to
  // post to anyway. Body constraints: ES5 only, every step try/caught, no
  // "</script" literal (the fast path splices it as HTML).
  function diagBeaconPostBody() {
    return (
      "(function(){try{" +
      'try{if(localStorage.getItem("jellyfin.shell.diagBeacon")==="0")return}catch(_){return}' +
      "var W=window;" +
      "if(W.__shellDiagBeaconArmed)return;W.__shellDiagBeaconArmed=1;" +
      "var st=W.__shellDiagBeacon={sent:0,http:0,tries:0,err:0};" +
      'function base(){try{return String(localStorage.getItem("jellyfin.shell.serverUrl")||"").replace(/\\/+$/,"")}catch(_){return""}}' +
      "function oid(){try{" +
      'var IK="jellyfin.shell.diagId";var v=localStorage.getItem(IK)||"";' +
      "if(/^[0-9a-z]{6,24}$/.test(v))return v;" +
      'var s=String(Math.random())+":"+(+new Date())+":"+String(Math.random());' +
      "var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0}" +
      "v=h.toString(36)+(+new Date()).toString(36);" +
      "localStorage.setItem(IK,v);return v" +
      '}catch(_){return""}}' +
      "function payload(){try{" +
      'var ring=JSON.parse(localStorage.getItem("jellyfin.shell.bootPhases")||"[]");' +
      "if(!ring||!ring.length)return null;" +
      "var d=W.__shellTxDrop||{};" +
      // JELA-223 (WS-B2): warm-boot payload-elision counters, all numeric so
      // the DiagIngestService whitelist passes them verbatim. ch/cm = the
      // JEL-619/178 tx-cache hit/miss ratio (a plugin <script src> served from
      // localStorage vs re-downloaded+transpiled); jc = the JEL-618 JSI
      // snippet channel (~1.2 MB) — 1 inlined from cache (zero fetch), 0
      // re-fetched, -1 channel absent/disabled. These make "measure fetch cost
      // separately" answerable per fielded boot without an sdb session.
      // JELA-748 (AC2): priming state. ls = chars in use (key+value summed;
      // -1 if the census threw), lk = key count, qe = swallowed localStorage
      // writes this boot. ch/cm say "this boot ran un-primed"; ls/lk/qe say
      // WHY — a store that is full or has stopped accepting writes reads
      // identically to a working one otherwise. The census is O(store) and
      // copies every value, so it runs ONCE, here, on the opt-in beacon path
      // only (default OFF) and always after the home/card mark — never on a
      // boot's critical path.
      "function lsz(){try{var L=localStorage,n=L.length,t=0;for(var i=0;i<n;i++){var k=L.key(i);t+=k.length+(L.getItem(k)||'').length}return[t,n]}catch(_){return[-1,-1]}}" +
      "var p={id:oid(),ring:ring,tx:{skip:W.__shellTxSkipCount||0,done:W.__shellTxDoCount||0,ch:W.__shellTxCacheHits||0,cm:W.__shellTxCacheMisses||0,jc:W.__shellJsiChannelCache==='hit'?1:(W.__shellJsiChannelCache==='miss'?0:-1),drop:{ok:d.ok?1:0,h:d.h||0,m:d.m||0,r:d.r||0,f:d.f||0}}};" +
      // Census AFTER oid(), so the id key it may have just minted is counted,
      // and in its own try so a census failure can never cost us the payload.
      // JELA-799: gd = version generations swept by the seed sweep, ps =
      // keys evicted by the widget-side pruner. Both read 0 with the flags
      // dark, and together with ls/lk/qe they say whether a fielded store is
      // recycling its version-keyed slots or just accreting them.
      "try{var z=lsz();p.tx.ls=z[0];p.tx.lk=z[1];p.tx.qe=W.__shellLsQuotaErr||0;p.tx.gd=W.__shellTxGenDrop||0;p.tx.ps=W.__shellTxPruneStatic||0}catch(_){}" +
      "var v=W.__shellPhases&&W.__shellPhases.ver;if(v)p.ver=String(v);" +
      "if(!p.id)return null;return p" +
      "}catch(_){st.err++;return null}}" +
      "function send(){if(st.sent)return;var b=base();var p=payload();if(!b||!p)return;st.sent=1;" +
      "try{var x=new XMLHttpRequest();" +
      'x.open("POST",b+"/shell/diag",!0);' +
      'x.setRequestHeader("Content-Type","text/plain");' +
      "x.onreadystatechange=function(){try{if(x.readyState===4)st.http=x.status}catch(_){}};" +
      "x.send(JSON.stringify(p))}catch(_){st.err++}}" +
      "var t0=+new Date();" +
      "var iv=setInterval(function(){try{" +
      "st.tries++;" +
      "if(st.sent){clearInterval(iv);return}" +
      "var ph=W.__shellPhases||{};" +
      "if(ph.card||ph.home||+new Date()-t0>60000){send();clearInterval(iv)}" +
      "}catch(_){st.err++}},3000);" +
      "}catch(_){}})();"
    );
  }

  // JELA-29: mirror of injectInstantHome for the Direct-Home prototype. Same
  // three injection sites (widget doc, DOMParser path, string fast path) so the
  // opt-in overlay survives document.write; a no-op unless directHome=1.
  function injectDirectHome(doc) {
    var dhTag = doc.createElement("script");
    dhTag.setAttribute("data-shell-direct-home", "1");
    dhTag.textContent = directHomeBody();
    doc.head.appendChild(dhTag);
  }

  // JELA-30: written-document injector (DOMParser path; the string fast path
  // splices the same body). No-op when diagBeacon==='0' — gate is inside
  // the body so injection stays unconditional and cheap.
  function injectDiagBeaconPost(doc) {
    var dbTag = doc.createElement("script");
    dbTag.setAttribute("data-shell-diag-beacon", "1");
    dbTag.textContent = diagBeaconPostBody();
    doc.head.appendChild(dbTag);
  }

  // JEL-197: shell-side JS-Injector snippet channel (parent JEL-196).
  // The Tizen shell bakes its own connect-form body and, once connected,
  // document.writes the server's /web/index.html. The JellyPlug snippets
  // (netflix rows, top-10 badges, hover-trailer, focus-preview, age-badge,
  // my-list) historically reached the TV ONLY via the JellyPlug Shell
  // Loader .NET plugin, which File-Transformation-appends them to the
  // shared runtime.bundle.js. JEL-196 retires that plugin: the snippets
  // move into the JS Injector plugin's public.js (Phase 1) and the shell
  // fetches public.js itself so the TV runs the SAME source a browser does.
  //
  // The channel inserts ONE <script src="${server}/JavaScriptInjector/
  // public.js"> into the fetched index.html before the transpile pass, so
  // it flows through the exact same fetch + Babel + jQuery-gate + error-
  // tolerant pipeline ("tizen-compat firewall") as any other plugin
  // <script src> (transpileLegacyScripts), with content-addressed tx-
  // caching (JEL-178) honouring public.js's ?v= config-version query.
  //
  // Idempotency (JEL-197): if the document already references a public.js
  // tag (e.g. the JS Injector plugin's own browser-side injection into
  // index.html), the channel leaves it alone — transpileLegacyScripts runs
  // that copy — so public.js never executes twice. This also lets the
  // channel coexist with the still-installed Shell Loader FT blob during
  // the JEL-196 cutover: the two carry independent content today, and once
  // Phase 1 moves the snippets into public.js the snippets' own single-run
  // guards (theme repo) keep them idempotent across both channels.
  // Killswitch: localStorage['jellyfin.shell.jsiChannelDisabled']='1'.
  // JEL-204 (parent JEL-203 audit): the delivery route is overridable via
  // localStorage['jellyfin.shell.jsiChannelPath'] so the snippet-channel path
  // is not a hardcoded plugin constant baked into the shell. Default stays the
  // JS Injector plugin's public.js; an override future-proofs against a
  // delivery-plugin change without a shell release. jsiChannelPath() is the
  // single resolver used by the injector, the idempotency guard and the fast-
  // path bail so all three agree on the active route.
  var JSI_CHANNEL_DISABLED_KEY = "jellyfin.shell.jsiChannelDisabled";
  var JSI_CHANNEL_PATH_KEY = "jellyfin.shell.jsiChannelPath";
  var JSI_PUBLIC_PATH = "/JavaScriptInjector/public.js";
  function jsiChannelDisabled() {
    try {
      return localStorage.getItem(JSI_CHANNEL_DISABLED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function jsiChannelPath() {
    try {
      var p = localStorage.getItem(JSI_CHANNEL_PATH_KEY);
      if (p) return p;
    } catch (_) {}
    return JSI_PUBLIC_PATH;
  }
  // JEL-618: channel body cache. The channel is the aggregate of EVERY
  // enabled JS-Injector snippet (~1.2 MB live), and txSetStatic refuses
  // bodies > 256 KiB — so pre-JEL-618 the TV re-downloaded AND re-babeled
  // the whole channel on every boot (the txc: content key deduped nothing
  // for it), and its presence alone forced the slow DOMParser boot path.
  // The FINAL executable body (post-transpile, post-jQuery-gate) is
  // persisted in its own chunked localStorage record: one key per 128 KiB
  // slice + a meta record carrying {v: TX_VER, t: writtenAt, n: chunks,
  // l: length, h: fnv1a}. The record deliberately bypasses the shared tx
  // cache (whose 256 KiB ceiling guards it against exactly this payload).
  // Freshness contract: a cached body is served for at most
  // JSI_CHANNEL_MAXAGE_DEFAULT (6 h; override via
  // localStorage['jellyfin.shell.jsiChannelMaxAgeMs'], '0' disables the
  // cache = pre-JEL-618 refetch-every-boot behaviour) and only while
  // TX_VER matches (a transpiler/epoch change re-derives it, same rule as
  // the tx cache). Within the window a snippet-config edit is NOT picked
  // up: the JEL-178 one-boot-lag contract widens to a bounded TTL for
  // this one aggregate — a deliberate trade, since only JellyPlug deploys
  // (not the user) edit snippet config, and a deploy needing immediate
  // effect can clear the record on-device or wait out the window.
  // Chunks are written first and meta last, so a mid-write quota failure
  // can never leave a meta adopting missing/foreign chunks; the joined
  // body is length- and hash-checked on read regardless. Plugin-agnostic:
  // keyed on our own record keys, never on a plugin name or route.
  var JSI_CHANNEL_META_KEY = "jellyfin.shell.jsiChannel.meta";
  var JSI_CHANNEL_CHUNK_PFX = "jellyfin.shell.jsiChannel.c";
  var JSI_CHANNEL_MAXAGE_KEY = "jellyfin.shell.jsiChannelMaxAgeMs";
  var JSI_CHANNEL_MAXAGE_DEFAULT = 21600000;
  var JSI_CHANNEL_CHUNK_LEN = 131072;
  var JSI_CHANNEL_MAX_CHUNKS = 32;
  function jsiChannelMaxAge() {
    try {
      var v = localStorage.getItem(JSI_CHANNEL_MAXAGE_KEY);
      if (v != null && /^[0-9]+$/.test(v)) return parseInt(v, 10);
    } catch (_) {}
    return JSI_CHANNEL_MAXAGE_DEFAULT;
  }
  function jsiChannelCacheClear() {
    try {
      localStorage.removeItem(JSI_CHANNEL_META_KEY);
      for (var i = 0; i < JSI_CHANNEL_MAX_CHUNKS; i++)
        localStorage.removeItem(JSI_CHANNEL_CHUNK_PFX + i);
    } catch (_) {}
  }
  function jsiChannelCacheGet() {
    try {
      var maxAge = jsiChannelMaxAge();
      if (maxAge <= 0) return null;
      var meta = JSON.parse(localStorage.getItem(JSI_CHANNEL_META_KEY));
      if (!meta || meta.v !== TX_VER) return null;
      // Math.abs: a TV clock jump in EITHER direction bounds staleness
      // instead of making a backdated record immortal.
      if (!(meta.t > 0)) return null;
      if (Math.abs(Date.now() - meta.t) > maxAge) {
        // JELA-59: an epoch-matched boot waives the age bound (the server
        // attests the snippet config is unchanged); integrity checks stay.
        if (window.__shellCfgEM !== 1) return null;
        ceSup("jsi");
      }
      if (!(meta.n >= 1) || meta.n > JSI_CHANNEL_MAX_CHUNKS) return null;
      var parts = [];
      for (var i = 0; i < meta.n; i++) {
        var c = localStorage.getItem(JSI_CHANNEL_CHUNK_PFX + i);
        if (c == null) return null;
        parts.push(c);
      }
      var body = parts.join("");
      if (body.length !== meta.l || txFnv1a(body) !== meta.h) return null;
      return body;
    } catch (_) {
      return null;
    }
  }
  function jsiChannelCacheSet(body) {
    try {
      if (typeof body !== "string" || !body) return;
      if (body.length > JSI_CHANNEL_CHUNK_LEN * JSI_CHANNEL_MAX_CHUNKS) return;
      if (jsiChannelMaxAge() <= 0) return;
      var n = Math.ceil(body.length / JSI_CHANNEL_CHUNK_LEN);
      for (var i = 0; i < n; i++)
        localStorage.setItem(
          JSI_CHANNEL_CHUNK_PFX + i,
          body.slice(
            i * JSI_CHANNEL_CHUNK_LEN,
            (i + 1) * JSI_CHANNEL_CHUNK_LEN,
          ),
        );
      for (var j = n; j < JSI_CHANNEL_MAX_CHUNKS; j++)
        localStorage.removeItem(JSI_CHANNEL_CHUNK_PFX + j);
      localStorage.setItem(
        JSI_CHANNEL_META_KEY,
        JSON.stringify({
          v: TX_VER,
          t: Date.now(),
          n: n,
          l: body.length,
          h: txFnv1a(body),
        }),
      );
    } catch (_) {
      // Quota mid-write: drop the whole record so a later boot can never
      // pair a surviving meta with half-written chunks.
      jsiChannelCacheClear();
    }
  }
  function injectJsInjectorChannel(doc, serverUrl) {
    try {
      if (jsiChannelDisabled()) return;
      if (!doc || !doc.body) return;
      var channelPath = jsiChannelPath();
      // Idempotent: don't add a second public.js if the document already
      // carries one (server- or plugin-injected). The existing copy is
      // fetched, transpiled and run by transpileLegacyScripts.
      if (doc.querySelector('script[src*="' + channelPath + '"]')) return;
      // JEL-618: a fresh cached channel body (already transpiled + gated on
      // a prior boot) is inlined directly — no <script src>, no download,
      // no babel. transpileLegacyScripts skips it via data-shell-jsi-cached,
      // and a body that is already lowered needs no babel eager-kick.
      var cachedBody = jsiChannelCacheGet();
      try {
        window.__shellJsiChannelCache = cachedBody != null ? "hit" : "miss";
      } catch (_) {}
      if (cachedBody != null) {
        var sc = doc.createElement("script");
        sc.textContent = cachedBody;
        sc.setAttribute("data-shell-jsi-channel", "1");
        sc.setAttribute("data-shell-jsi-cached", "1");
        doc.body.appendChild(sc);
        return;
      }
      var s = doc.createElement("script");
      // JEL-216: the channel aggregates arbitrary user JS-Injector snippets, so
      // its body is config-mutable AND may carry modern syntax the M63 firewall
      // must down-compile. Append a stable marker query so the URL is
      // query-bearing: transpileLegacyScripts then routes it through the JEL-178
      // path (per-fetch cache-buster + content-addressed `txc:` key) instead of
      // the bare-URL cache that was never re-validated on a snippet edit, so the
      // TV always runs the CURRENT snippets. channelPath stays a substring of
      // src, so the idempotency guard above still fires. Plugin-agnostic.
      s.src =
        serverUrl +
        channelPath +
        (channelPath.indexOf("?") < 0 ? "?_jsi=1" : "&_jsi=1");
      s.setAttribute("data-shell-jsi-channel", "1");
      // End of <body> so the snippets load after jellyfin-web's bundles —
      // the same position the JS Injector plugin uses on a browser. The
      // snippets self-defer (window.onload / MutationObserver) for ApiClient
      // and rendered DOM, so document-order execution is safe.
      doc.body.appendChild(s);
      // JEL-216: an active channel on a legacy engine used to GUARANTEE a
      // transpile; kick the babel load now (idempotent cached promise) so it
      // isn't started lazily inside the pre-write critical path where a cold
      // parse can lose the give-up race and let raw `?.`/`??` reach the engine.
      // JEL-620: the channel body routes through the content-addressed
      // tx-cache (JEL-178/JEL-618), so honor the JEL-1984 unused-streak
      // soft-skip — streak >= 2 means the last two full passes (channel
      // included) were cache/drop-covered and Babel went unused; a miss
      // resets the streak so the next boot kicks eagerly again. A genuine
      // per-script miss still lazy-loads Babel in the slow path (JEL-216
      // neutralize fail-safe unchanged).
      // JELA-183: the JEL-621 `__shellTxDrop.ok` skip is gone. It fired the
      // moment the manifest resolved, even when DYNAMICALLY injected module
      // bodies (never enumerated by the drop builder) still needed Babel —
      // with every static body drop-hitting, Babel stayed cold and all ~56
      // JE submodules died as "setter transpile failed". The streak already
      // self-tunes the eager load away on fully-covered servers (drop hits
      // count as coverage), so the drop gate bought nothing the streak
      // doesn't.
      var jsiStreakSkip = false;
      try {
        jsiStreakSkip =
          (parseInt(localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0", 10) ||
            0) >= 2;
      } catch (_) {}
      if (
        isLegacyChromium() &&
        !jsiStreakSkip &&
        typeof window.__ensureBabel === "function"
      )
        try {
          window.__ensureBabel();
        } catch (_) {}
    } catch (_) {}
  }

  // JEL-554 (v32): tx cache constants shared with the in-document seed
  // script. transpileLegacyScripts (widget-origin, runs before document.write)
  // and srcPipeline/rewrite (runs inside the rewritten document) both write
  // to the same localStorage keys, so a static-DOM plugin transpiled on cold
  // boot hits cache when the SAME plugin URL is later loaded dynamically by
  // JE/etc on warm boot, and vice versa.
  // JEL-1150: TX_VER + TX_PFX hoisted to top-of-IIFE so they're derived
  // from babel inputs (not a hand-bumped version string).
  // JEL-1034 (v53): persistent flag — set true on any boot that triggered
  // the babel slow path. loadRemoteWebClient reads it to decide whether to
  // speculatively prime ensureBabel() in parallel with /web/ RTT. Plugin-
  // light legacy servers never set this and stay on the fully-lazy path.
  var BABEL_NEEDED_KEY = "jellyfin.shell.legacy.babelNeeded";
  // JELA-187: sibling flag — set true when the static walk adopts a pre-
  // lowered drop body (txDropResolve hit). Such a hit proves a static
  // <script> on this server cannot run raw on this engine, yet the drop
  // serves it without ever loading Babel, so BABEL_NEEDED_KEY stays unset.
  // The JEL-1832 warm-boot string fast path used babelNeeded as its "every
  // static parses raw" proxy; on a fully drop-covered server (JEL-621)
  // that proxy is false-negative and warm replayed boots executed raw
  // <script src> tags — every modern-syntax plugin died as a parse-time
  // SyntaxError. maybeStringFastPath bails on this flag exactly like it
  // bails on babelNeeded; the DOMParser walk then re-inlines lowered
  // bodies from the version-keyed tx cache (zero network on unchanged
  // tokens). Sticky like babelNeeded: a later cache-served walk reports
  // cachedHits (not txDropHits) and cannot tell drop-lowered bodies from
  // raw fast-path ones, so nothing may clear this short of an LS wipe.
  var DROP_NEEDED_KEY = "jellyfin.shell.legacy.dropNeeded";
  // JEL-1984: sibling counter to BABEL_NEEDED_KEY. Incremented at the end
  // of each transpileLegacyScriptsInner pass that observed full tx-cache
  // coverage (every static plugin <script src> resolved via txGetStatic,
  // no babel slow path triggered, scriptsFound > 0). Reset to 0 the moment
  // a cache miss forces a babel transform. The head-IIFE preload and
  // eager-kick gates treat `streak >= 2` as a soft-skip signal so warm
  // boots on a babel-needed-but-fully-cached server skip the 3.13 MB
  // babel.min.js fetch + ~500-800 ms V8 parse. Two-boot dwell prevents
  // flap when a plugin set changes once; on the next boot after a real
  // miss the eager preload runs again. The lazy `__ensureBabel` path
  // (defined in index.html line 92) remains intact: a NEW plugin URL
  // appearing after a soft-skip still triggers on-demand babel load via
  // ensureBabelReady, and the post-pass counter increment+miss reset
  // keeps the gate self-healing without manual intervention.
  var BABEL_UNUSED_STREAK_KEY = "jellyfin.shell.legacy.babelUnusedStreak";
  // JEL-554 (v35): normalize cache key by stripping the per-load cache-buster.
  // v33/v34 QA confirmed JellyfinEnhanced appends ?v=<Date.now()> to its
  // dynamically-loaded sub-module URLs, so a full-URL key changed every cold
  // boot (54 misses / 1 hit despite 171 cached entries). v35 fixed that by
  // stripping the ENTIRE query — but that over-corrected (JEL-178): plugins
  // whose script BODY is config-dependent serve it at a stable path with a
  // content-version query that bumps when the config changes —
  //   JavaScript Injector: /JavaScriptInjector/public.js?v=<.NET cfg ticks>
  //   Home Screen Sections: /HomeScreen/...js?v=<plugin version>&c=N
  // Stripping the whole query keyed every revision to the same slot, so once
  // public.js was cached the TV kept running the STALE body — e.g. disabled
  // JS-Injector snippets still executed on TV while the browser (which honours
  // the ?v= change via HTTP cache) correctly dropped them.
  // Fix: drop a query token ONLY when it is a per-load epoch-ms cache-buster
  // (a 12–14 digit value within ~7 days of the device clock — the Date.now()
  // shape); keep every other token (config-ticks are 18 digits, versions are
  // non-numeric), so a config bump changes the key → cache miss → re-fetch.
  // Self-invalidating: the new key never collides with a v35 stripped-path
  // entry, so old stale slots are simply orphaned (LRU-pruned) with no TX_VER
  // bump. Must stay behaviourally identical to the seed-side __txKey
  // (JEL-26 lockstep) — both run on the same localStorage tx-cache.
  function txKey(url) {
    var u = String(url || "");
    var i = u.indexOf("?");
    if (i < 0) return u;
    var path = u.substring(0, i);
    var pairs = u.substring(i + 1).split("&");
    var keep = [];
    var now = Date.now();
    for (var pi = 0; pi < pairs.length; pi++) {
      var p = pairs[pi];
      if (!p) continue;
      var eq = p.indexOf("=");
      var val = eq < 0 ? p : p.substring(eq + 1);
      if (/^[0-9]{12,14}$/.test(val)) {
        var n = parseInt(val, 10);
        if (n > 0 && Math.abs(n - now) < 6048e5) continue;
      }
      keep.push(p);
    }
    return keep.length ? path + "?" + keep.join("&") : path;
  }
  // JEL-619: version-keyed plugin FETCH caching. JEL-178's per-boot &__sb=
  // buster forced a FULL re-download of every query-bearing plugin script on
  // every boot (JellyfinEnhanced ~54 submodules, the JSI channel); the
  // content-addressed `txc:` key deduped only the TRANSPILE. Serving from a
  // version-keyed slot closes the download: when a URL's txKey() identity is
  // unchanged vs the boot that cached it, the body is inlined with ZERO
  // network; ANY token change still misses -> busted fetch (the JEL-178
  // staleness contract is intact). Query-bearing URLs fall in three classes:
  //   2 = version-pinned: a kept query token carries real version info
  //       (config ticks, >=15 digits; a dotted a.b.c version; a long hex
  //       hash). Served until the token changes — exactly the freshness a
  //       browser's HTTP cache gets from honouring ?v=.
  //   1 = epoch-busted: txKey() strips a per-load Date.now() buster and no
  //       version-ish token remains (JellyfinEnhanced submodules). The bare
  //       path is the identity, so nothing tracks a plugin UPDATE — bound
  //       staleness with a 24 h TTL (sibling "ts:" key).
  //   0 = unpinned marker: a kept query with NO version signal (the JSI
  //       channel's static ?_jsi=1). The body is config-mutable and nothing
  //       tracks the config, so it is NEVER served from this cache — every
  //       boot stays a fresh busted read (pre-JEL-619 behaviour).
  // Storage: the body lives ONCE under the content-addressed `txc:` slot;
  // the version-keyed slot holds a tiny "@@shellref:txc:<hash>" pointer
  // (txRecordQuerySlot) so a large aggregate body is not duplicated. A
  // per-path "vqk:" index drops the previous generation's slots on a token
  // change so LS can't accumulate dead bodies. Plugin-agnostic throughout.
  // Kill-switch: localStorage['jellyfin.shell.pluginFetchCacheDisabled']='1'
  // restores the fetch-every-boot behaviour.
  var TX_QUERY_TTL_MS = 864e5;
  var TX_REF_PFX = "@@shellref:";
  // JELA-748 (AC2): count localStorage writes that were SWALLOWED. Every
  // tx-cache writer soft-fails into catch(_){} so a boot never breaks on a
  // full store — but that also makes "the store stopped accepting writes"
  // indistinguishable from "the store is working" in the fleet beacon, where
  // only ch/cm are visible. Bump at the point the write is finally lost, and
  // report as tx.qe. Widget side and seed side share the window counter.
  function txWriteLost() {
    try {
      window.__shellLsQuotaErr = (window.__shellLsQuotaErr || 0) + 1;
    } catch (_) {}
  }
  // JELA-799 (b): make content-addressed `txc:` bodies reachable by the
  // pruner. The seed's __txPrune evicts the 10 LRU-oldest keys from the
  // shared "shell.txLru<TX_VER>" map — but ONLY __txGet/__txSet (the seed's
  // dynamic pipeline) ever populate that map. txSetStatic and
  // txRecordQuerySlot never touch it, so a txc: body can never be evicted no
  // matter how large or how cold. On the JELA-797 census rig the single
  // biggest key in the store was shell.tx1t1at4s:txc:<hash> at 901,582
  // chars = 24.5% of the whole store, permanently unprunable, while the
  // pruner dropped small seed entries around it. txSetStatic's own quota
  // catch made it worse: it counted the lost write and gave up, with no
  // prune-and-retry like __txSet has.
  // Fix: track BODY keys in the same map (never the tiny "@@shellref:"
  // POINTER keys — an evicted pointer with a live body is a leak, whereas an
  // evicted body with a live pointer is already a self-healing miss), touch
  // them on a static hit, and give txSetStatic __txSet's prune-and-retry.
  // The touch is coarse — a stamp under an hour old is left alone — so a
  // hit-heavy boot does not rewrite the whole map JSON once per read.
  // Flag-dark: localStorage["jellyfin.shell.txLruStatic"]="1" enables it,
  // "jellyfin.shell.txLruStaticDisabled"="1" is the kill switch. With the
  // flag off the map never gains a txc: entry, so the seed-side pruner
  // behaves exactly as it does today. QA counter:
  // window.__shellTxPruneStatic (diag beacon "ps=").
  var TX_LRU_KEY = "shell.txLru" + TX_VER;
  var TX_LRU_STATIC_KEY = "jellyfin.shell.txLruStatic";
  var TX_LRU_TOUCH_MS = 36e5;
  function txLruStaticOn() {
    try {
      return (
        localStorage.getItem(TX_LRU_STATIC_KEY) === "1" &&
        localStorage.getItem(TX_LRU_STATIC_KEY + "Disabled") !== "1"
      );
    } catch (_) {
      return false;
    }
  }
  function txLruRead() {
    try {
      var v = localStorage.getItem(TX_LRU_KEY);
      return v ? JSON.parse(v) : {};
    } catch (_) {
      return {};
    }
  }
  function txLruWrite(m) {
    try {
      localStorage.setItem(TX_LRU_KEY, JSON.stringify(m));
    } catch (_) {
      txWriteLost();
    }
  }
  function txLruTouch(k) {
    if (!txLruStaticOn()) return;
    try {
      var m = txLruRead();
      var now = Date.now();
      if (m[k] && now - m[k] < TX_LRU_TOUCH_MS) return;
      m[k] = now;
      txLruWrite(m);
    } catch (_) {}
  }
  // Drop a key the caller just removed from the store, so the pruner does
  // not spend its 10-key budget on removeItem() no-ops for dead entries
  // (which sort OLDEST and would therefore go first).
  function txLruForget(k) {
    if (!txLruStaticOn()) return;
    try {
      var m = txLruRead();
      if (m[k] == null) return;
      delete m[k];
      txLruWrite(m);
    } catch (_) {}
  }
  // Widget-side twin of the seed's __txPrune: drop the 10 LRU-oldest tracked
  // keys. Returns true only when something was actually removed, so the
  // caller retries a failed write only when there is fresh room for it.
  function txPruneStatic() {
    try {
      var m = txLruRead();
      var keys = Object.keys(m);
      if (!keys.length) return false;
      keys.sort(function (a, b) {
        return m[a] - m[b];
      });
      var n = Math.min(keys.length, 10);
      for (var i = 0; i < n; i++) {
        try {
          localStorage.removeItem(TX_PFX + keys[i]);
        } catch (_) {}
        delete m[keys[i]];
      }
      txLruWrite(m);
      try {
        window.__shellTxPruneStatic = (window.__shellTxPruneStatic || 0) + n;
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }
  var PLUGIN_FETCH_CACHE_DISABLED_KEY =
    "jellyfin.shell.pluginFetchCacheDisabled";
  function pluginFetchCacheDisabled() {
    try {
      return localStorage.getItem(PLUGIN_FETCH_CACHE_DISABLED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  // Classify a query-bearing URL (see block comment above). The epoch-buster
  // test (12-14 digit value within ~7 days of the device clock) must stay in
  // lockstep with txKey()/__txKey — it decides "stripped buster" the same way.
  function txQueryClass(u) {
    var i = u.indexOf("?");
    if (i < 0) return 0;
    var pairs = u.substring(i + 1).split("&");
    var now = Date.now();
    var pinned = false;
    var busted = false;
    for (var pi = 0; pi < pairs.length; pi++) {
      var p = pairs[pi];
      if (!p) continue;
      var eq = p.indexOf("=");
      var val = eq < 0 ? p : p.substring(eq + 1);
      if (/^[0-9]{12,14}$/.test(val)) {
        var n = parseInt(val, 10);
        if (n > 0 && Math.abs(n - now) < 6048e5) {
          busted = true;
          continue;
        }
      }
      if (
        /^[0-9]{15,}$/.test(val) ||
        /^\d+(\.\d+){2,}/.test(val) ||
        (/^[0-9a-fA-F]{12,}$/.test(val) && /[a-fA-F]/.test(val))
      )
        pinned = true;
    }
    return pinned ? 2 : busted ? 1 : 0;
  }
  // Record the version-keyed slot for a query-bearing URL after its body was
  // downloaded and stored under `ck` (the content-addressed txc: slot). Also
  // maintains the one-generation-per-path "vqk:" index for ALL classes so a
  // token change (or a class-0 body change) frees the previous generation's
  // txc: body instead of leaking it.
  function txRecordQuerySlot(url, ck) {
    try {
      var u = String(url || "");
      var qi = u.indexOf("?");
      if (qi < 0) return;
      var k = txKey(u);
      var pathKey = TX_PFX + "vqk:" + u.substring(0, qi);
      var prev = null;
      try {
        prev = JSON.parse(localStorage.getItem(pathKey) || "null");
      } catch (_) {}
      if (prev) {
        if (prev.c && prev.c !== ck) {
          localStorage.removeItem(TX_PFX + prev.c);
          // JELA-799 (b): the body is gone — stop the LRU from carrying a
          // dead key that would sort oldest and waste a prune slot.
          txLruForget(prev.c);
        }
        if (prev.k && prev.k !== k) {
          localStorage.removeItem(TX_PFX + prev.k);
          localStorage.removeItem(TX_PFX + "ts:" + prev.k);
        }
      }
      localStorage.setItem(pathKey, JSON.stringify({ k: k, c: ck }));
      var qc = txQueryClass(u);
      if (qc > 0 && !pluginFetchCacheDisabled()) {
        localStorage.setItem(TX_PFX + k, TX_REF_PFX + ck);
        if (qc === 1)
          localStorage.setItem(TX_PFX + "ts:" + k, String(Date.now()));
      }
    } catch (_) {
      /* quota — soft fail (JELA-748: counted, not silent) */
      txWriteLost();
    }
  }
  // JEL-554 (v34): record first 10 missed URLs to expose static/dynamic
  // cache-key drift. QA can read window.__shellTxCacheMissUrlsStatic + the
  // dynamic-side window.__shellTxCacheMissUrls and diff against
  // `Object.keys(localStorage).filter(k=>k.indexOf('shell.tx35:')===0)`.
  function txGetStatic(url) {
    try {
      var u = String(url || "");
      var k;
      if (u.indexOf("?") >= 0) {
        // JEL-619: version-keyed eligibility gate (see txQueryClass above).
        if (pluginFetchCacheDisabled()) return null;
        var qc = txQueryClass(u);
        if (qc === 0) return null;
        k = txKey(u);
        if (qc === 1) {
          var ts = 0;
          try {
            ts = parseInt(localStorage.getItem(TX_PFX + "ts:" + k), 10) || 0;
          } catch (_) {}
          if (Date.now() - ts > TX_QUERY_TTL_MS) {
            // JELA-59: an epoch-matched boot attests the plugin config is
            // unchanged — waive the 24 h staleness bound.
            if (window.__shellCfgEM !== 1) return null;
            ceSup("q");
          }
        }
      } else {
        k = txKey(u);
      }
      var v = localStorage.getItem(TX_PFX + k);
      // JEL-619: deref a version-slot pointer to its content-addressed body.
      // A pruned/absent target reads as a miss (self-healing refetch).
      // JELA-799 (b): `bk` is the key the BODY actually lives under — the
      // deref target for a pointer, otherwise k itself. That is the key the
      // LRU tracks; the pointer is left untracked on purpose.
      var bk = k;
      if (v != null && v.lastIndexOf(TX_REF_PFX, 0) === 0) {
        bk = v.substring(TX_REF_PFX.length);
        v = localStorage.getItem(TX_PFX + bk);
      }
      if (v == null) {
        var miss = window.__shellTxCacheMissUrlsStatic;
        if (!miss) {
          miss = [];
          window.__shellTxCacheMissUrlsStatic = miss;
        }
        if (miss.length < 10) miss.push(url);
      } else {
        // JELA-799 (b): a static hit is the ONLY recency signal a txc: body
        // ever gets — without it every content-addressed body looks eternally
        // cold and would prune first once it becomes prunable at all.
        txLruTouch(bk);
        // JEL-619: download-skip telemetry (a query-bearing hit means a
        // plugin re-download was avoided this boot).
        if (u.indexOf("?") >= 0)
          window.__shellQvHits = (window.__shellQvHits || 0) + 1;
      }
      return v;
    } catch (_) {
      return null;
    }
  }
  // JEL-619: cap raised 262144 -> 2097152 so the JSI channel aggregate
  // (>1 MB on snippet-heavy servers) can cache its transpile under txc:
  // (above the old cap it re-Babel'd EVERY boot). Quota pressure is bounded
  // by txRecordQuerySlot's one-generation-per-path cleanup; a failing
  // setItem still soft-fails to the fetch-every-boot behaviour.
  // JELA-799 (b): prune-and-retry on quota, mirroring __txSet. The retry is
  // gated on txPruneStatic() actually having evicted something — with the
  // flag off (empty static LRU tracking) it returns false and this collapses
  // to the pre-799 "count the lost write and give up" path.
  function txSetStatic(url, body) {
    if (typeof body !== "string" || body.length > 2097152) return;
    var k = txKey(url);
    try {
      localStorage.setItem(TX_PFX + k, body);
      txLruTouch(k);
      return;
    } catch (_) {
      /* quota — fall through to prune-and-retry */
    }
    if (txLruStaticOn() && txPruneStatic()) {
      try {
        localStorage.setItem(TX_PFX + k, body);
        txLruTouch(k);
        return;
      } catch (_) {}
    }
    /* quota — soft fail (JELA-748: counted, not silent) */
    txWriteLost();
  }

  // ---- Config-epoch boot gate (JELA-59, parent JELA-57 WS-2) -------------
  //
  // The server plugin (JELA-58, v1.0.13.0+) publishes a config fingerprint
  // in /shell/manifest.json as additive fields: `configEpoch` (aggregate
  // sha256) + `components` {web,shell,scripts,branding} (per-group sha256).
  // The gate fetches the manifest once per boot (3 s bound, off the critical
  // path — background revalidation waits for it, primary fetches never do)
  // and compares it against the record persisted by the last adopted boot:
  //   MATCH    -> window.__shellCfgEM=1, a boot-scoped flag whose
  //               suppression points (a) skip the /web/ index+config SWR
  //               revalidation pair, (b) skip the stylesheet miss-populate
  //               pass (baked shell only), (c) serve the tx-drop manifest
  //               from a persisted copy instead of the per-boot ?__sb=
  //               busted fetch, (d) waive the JSI channel max-age and the
  //               JEL-619 class-1 24 h TTL so plugin bodies (incl. the
  //               JellyfinEnhanced skin aggregate) keep serving from the
  //               EXISTING bounded LS caches instead of refetching.
  //   MISMATCH -> per-component diff invalidates ONLY the affected cache
  //               groups (web -> index/config/bundle/stylesheet bodies;
  //               scripts -> JSI channel + JEL-619 version-keyed slots;
  //               branding -> stylesheet bodies; shell -> nothing, the
  //               bootstrap's manifest-sha path already adopts new shell
  //               bytes), then today's refetch machinery repopulates and
  //               the NEW record is committed only after this boot's /web/
  //               pair settled successfully (write-after-adopt: a failed
  //               refresh keeps the old record so the next boot re-runs
  //               the same invalidation instead of wedging on a stale
  //               epoch — invalidation is remove-first, so nothing stale
  //               can be served meanwhile).
  //   Manifest unreachable / field absent / record absent -> exactly
  //   today's behavior (match stays 0, nothing is invalidated).
  // Soft TTL: even on a match, a full-revalidation boot runs every 20
  // boots or 7 days so a fingerprint bug cannot pin caches forever.
  // Rollout (JELA-61 flip, JELA-54 settle-dismiss precedent): DEFAULT-ON
  // with the opt-out kill switch 'jellyfin.shell.configEpochDisabled'='1'
  // (drill-verified on-device in WS-3 before the flip; the WS-2 opt-in key
  // 'jellyfin.shell.configEpochGate' is retired and ignored). QA counters
  // (WS-3) live on
  // window.__shellConfigEpoch {st,e,inv,sup:{idx,txm,jsi,q,css}} plus the
  // boot-scoped match flag window.__shellCfgEM (1 = suppression active).
  function ceGateOn() {
    try {
      return localStorage.getItem("jellyfin.shell.configEpochDisabled") !== "1";
    } catch (_) {
      return false;
    }
  }
  function ceRecWrite(r) {
    try {
      localStorage.setItem("jellyfin.shell.configEpoch", JSON.stringify(r));
    } catch (_) {}
  }
  function ceSup(f) {
    // Bump a suppression counter (QA surface for WS-3).
    var g = window.__shellConfigEpoch;
    if (g && g.sup) g.sup[f] = (g.sup[f] || 0) + 1;
  }
  function ceReady() {
    var p = window.__shellEpochReady;
    return p && typeof p.then === "function" ? p : Promise.resolve(null);
  }
  function ceInvalidate(pv, nx) {
    // Component-selective cache-group invalidation. `pv` null (no record
    // yet) invalidates nothing — with no adopted generation there is no
    // suppression, so every cache already revalidates on its own contract.
    var inv = [];
    if (!pv) return inv;
    var SS_KEY = "jellyfin.shell.stylesheetBodies";
    function ch(grp, keys) {
      if (pv.components[grp] === nx[grp]) return false;
      inv.push(grp);
      for (var i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]);
      return true;
    }
    try {
      ch("web", [
        WEB_INDEX_CACHE_KEY,
        WEB_CONFIG_CACHE_KEY,
        BUNDLE_CACHE_KEY,
        SS_KEY,
      ]);
      if (ch("scripts", [])) {
        jsiChannelCacheClear();
        // Drop the JEL-619 version-keyed slots via the per-path vqk: index
        // so every query-bearing plugin body refetches with a fresh buster.
        // Content-addressed txc: bodies stay — they only serve through a
        // matching source hash, so they cannot go stale.
        // JELA-799 (a): the seed's per-family "gqk:" index is the same kind
        // of pointer for seed-written slots (value = the version key, not
        // JSON), so a scripts-component change drops that generation too
        // instead of leaving a stale index behind. Unconditional: with the
        // sweep flag off no gqk: key exists, so this is a no-op.
        var drop = [];
        var dropG = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k) continue;
          if (k.lastIndexOf(TX_PFX + "vqk:", 0) === 0) drop.push(k);
          else if (k.lastIndexOf(TX_PFX + "gqk:", 0) === 0) dropG.push(k);
        }
        for (var j = 0; j < drop.length; j++) {
          var vq = null;
          try {
            vq = JSON.parse(localStorage.getItem(drop[j]));
          } catch (_) {}
          localStorage.removeItem(drop[j]);
          if (vq && vq.k) {
            localStorage.removeItem(TX_PFX + vq.k);
            localStorage.removeItem(TX_PFX + "ts:" + vq.k);
          }
        }
        for (var g = 0; g < dropG.length; g++) {
          var gq = localStorage.getItem(dropG[g]);
          localStorage.removeItem(dropG[g]);
          if (gq) {
            localStorage.removeItem(TX_PFX + gq);
            localStorage.removeItem(TX_PFX + "ts:" + gq);
            txLruForget(gq);
          }
        }
      }
      ch("branding", [SS_KEY]);
      ch("shell", []);
    } catch (_) {}
    return inv;
  }
  function ceAdopt() {
    // Write-after-adopt commit point: called once this boot's /web/
    // index+config pair settled successfully (fresh fetch or revalidation),
    // which is always AFTER ceInvalidate ran (the commit call sites chain
    // on window.__shellEpochReady).
    var g = window.__shellConfigEpoch;
    if (!g || !g.pend) return;
    ceRecWrite(g.pend);
    g.pend = null;
    g.ad = 1;
  }
  function loadConfigEpoch(u) {
    // Parks a never-rejecting promise on window.__shellEpochReady and the
    // gate state on window.__shellConfigEpoch. Suppression points key on
    // the sync flag window.__shellCfgEM===1 (window survives
    // document.write, so the in-document seed pipelines see it too).
    var g = { st: "off", sup: {} };
    window.__shellConfigEpoch = g;
    window.__shellCfgEM = 0;
    if (!ceGateOn()) return (window.__shellEpochReady = Promise.resolve(null));
    // The HSB bootstrap fetches manifest.json each boot too, but persists
    // only version/sha256/shellUrl and cannot be updated on installed WGTs
    // — so gated boots pay one extra small manifest GET (~1 KB).
    var p = withBootTimeout(
      fetch(u + "/shell/manifest.json?__sb=" + Date.now(), {
        credentials: "omit",
        cache: "no-store",
      }),
      "cfg epoch",
      3000,
    )
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (m) {
        if (!m || !m.configEpoch || !m.components) {
          g.st = m ? "nofield" : "err";
          return g;
        }
        g.e = String(m.configEpoch).slice(0, 8);
        var rec = null;
        try {
          rec = JSON.parse(localStorage.getItem("jellyfin.shell.configEpoch"));
        } catch (_) {}
        if (!rec || rec.origin !== u || !rec.components) rec = null;
        var pend = {
          origin: u,
          epoch: m.configEpoch,
          components: m.components,
          ts: Date.now(),
        };
        if (rec && rec.epoch === m.configEpoch) {
          // Soft-TTL: even on a perpetual match, a full-revalidation boot
          // runs every 7 days; the refreshed record commits only after the
          // /web/ pair adopted (same write-after-adopt as a mismatch).
          if (!(rec.ts > 0) || Math.abs(pend.ts - rec.ts) > 6048e5) {
            g.st = "ttl";
            g.pend = pend;
            return g;
          }
          g.st = "match";
          window.__shellCfgEM = 1;
          return g;
        }
        g.st = rec ? "mismatch" : "fresh";
        g.inv = ceInvalidate(rec, m.components);
        g.pend = pend;
        return g;
      })
      .catch(function () {
        g.st = "err";
        return g;
      });
    return (window.__shellEpochReady = p);
  }
  function ceTxdState(u, e) {
    var d = {
      ok: true,
      base: u + "/shell/",
      entries: e,
      h: 0,
      m: 0,
      r: 0,
      f: 0,
    };
    window.__shellTxDrop = d;
    txBundleAttach(d, u);
    return d;
  }
  // ---- JELA-833: tx-bundle request coalescer -----------------------------
  //
  // JELA-824 shipped a bundle that POSTed Object.keys(manifest) — the whole
  // 192-entry manifest, 18.8 MB on the wire — because the needed set is
  // discovered lazily and unioning was the only way to know it up front.
  // That traded a once-ever ~200 KB of `immutable` per-body GETs for an
  // 18.8 MB `no-store` download on EVERY boot (85-97x; see the JELA-833 QA
  // verdict on JELA-824).
  //
  // The needed set really is discovered lazily — but it is not discovered
  // SLOWLY. Measured on the JELA-112 rig against served shell f3fdc2df: the
  // 68 tx hashes of a cold boot land in 7 distinct 100 ms buckets, median
  // inter-arrival 2 ms, with 62 of the 68 inside a single ~300 ms burst,
  // because the SPA splices its script tags in bursts. So batching what was
  // ACTUALLY discovered keeps the baseline byte profile and still collapses
  // the round trips. Never speculate: any hash we ask for and do not use is
  // a byte we did not owe.
  //
  // Shape:
  //   * one POST in flight at a time — hashes discovered while a POST is out
  //     ride the next one for free, so a slow round trip widens batches
  //     instead of multiplying them;
  //   * the debounce window DOUBLES per batch (60 ms -> 1000 ms cap), which
  //     bounds the batch count by the log of the discovery span rather than
  //     linearly in the hash count;
  //   * a batch below TXB_MIN falls back to the per-body GET. One `no-store`
  //     POST and one `immutable` GET cost the same round trip, and only the
  //     GET is still there on the next boot — so a lone hash must never
  //     become a bundle request. This is also what keeps the JEL-621 primer
  //     (serial drain, one hash at a time) on the cacheable path.
  //
  // QA counters on window.__shellTxDrop: bulkBatches (POSTs issued),
  // bulkWanted (hashes offered to the batcher), bulkSolo (batches dropped to
  // per-body for being under TXB_MIN), bulkBodies (map of fetched bodies).
  var TXB_W0 = 60; // first debounce window, ms
  var TXB_WMAX = 1000; // window cap after doubling, ms
  var TXB_MAX = 64; // ids per POST — bounds one response
  var TXB_MIN = 2; // below this, use the immutable per-body GET
  function txBundleAttach(d, serverUrl) {
    // Leaves d.want undefined when the kill switch is set, which is exactly
    // what txDropResolve reads to take the per-body path (AC4 differential).
    if (txBundleDisabled()) return;
    var url = serverUrl + "/shell/tx-bundle";
    var q = {}; // hash -> {cbs:[resolve...], sent:0|1}
    var bodies = {}; // hash -> lowered body text
    var busy = 0;
    var timer = null;
    var due = 0;
    var win = TXB_W0;
    d.bulkBodies = bodies;
    d.bulkBatches = 0;
    d.bulkWanted = 0;
    d.bulkSolo = 0;
    function anyPending() {
      for (var k in q) if (q[k] && !q[k].sent) return true;
      return false;
    }
    function settle(ids, map) {
      // A hash the server omitted resolves null — the caller falls back to
      // the per-body GET, so a partial or failed bundle is never fatal.
      for (var i = 0; i < ids.length; i++) {
        var h = ids[i];
        var w = q[h];
        var body = map && typeof map[h] === "string" ? map[h] : null;
        if (body !== null) bodies[h] = body;
        delete q[h];
        if (w) {
          for (var j = 0; j < w.cbs.length; j++) {
            try {
              w.cbs[j](body);
            } catch (_) {}
          }
        }
      }
      busy = 0;
      if (anyPending()) arm(win);
    }
    function flush() {
      timer = null;
      due = 0;
      if (busy) return; // settle() re-arms
      var ids = [];
      for (var k in q) {
        if (q[k] && !q[k].sent) {
          ids.push(k);
          if (ids.length >= TXB_MAX) break;
        }
      }
      if (!ids.length) return;
      if (ids.length < TXB_MIN) {
        d.bulkSolo++;
        settle(ids, null);
        return;
      }
      for (var i = 0; i < ids.length; i++) q[ids[i]].sent = 1;
      busy = 1;
      d.bulkBatches++;
      win = Math.min(win * 2, TXB_WMAX);
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(ids),
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (m) {
          settle(ids, m && typeof m === "object" ? m : null);
        })
        .catch(function () {
          settle(ids, null);
        });
    }
    function arm(ms) {
      var at = Date.now() + ms;
      if (timer && due <= at) return; // an earlier flush is already armed
      if (timer) clearTimeout(timer);
      due = at;
      timer = setTimeout(flush, ms);
    }
    // Promise<string|null>. null means "not from the bundle" — the caller
    // falls back to the per-body GET. Never rejects.
    d.want = function (hash) {
      if (typeof bodies[hash] === "string")
        return Promise.resolve(bodies[hash]);
      var w = q[hash];
      if (!w) {
        w = q[hash] = { cbs: [], sent: 0 };
        d.bulkWanted++;
      }
      var p = new Promise(function (res) {
        w.cbs.push(res);
      });
      if (!w.sent) arm(win);
      return p;
    };
  }
  function ceTxmRead(u) {
    try {
      var p = JSON.parse(localStorage.getItem("jellyfin.shell.txDropCache"));
      if (!p || p.o !== u || p.v !== BABEL_OPTS_KEY || !p.e) return null;
      return p.e;
    } catch (_) {
      return null;
    }
  }
  function ceTxmWrite(u, e) {
    try {
      var s = JSON.stringify({ o: u, v: BABEL_OPTS_KEY, e: e });
      if (s.length > 131072) return;
      localStorage.setItem("jellyfin.shell.txDropCache", s);
    } catch (_) {}
  }

  // ---- Pre-lowered transpile drop (JEL-621) ------------------------------
  //
  // THE dominant cold-boot cost on Tizen 5.0 is Babel itself: the shell
  // serially transforms ~1.9 MB of plugin JS on the TV main thread (21-42 s
  // measured — see the JEL-131 primer comment in buildSeedScript). The
  // server can do that work ONCE, offline: the /shell/ drop
  // (packages/server-shell-drop, build-tx-drop.mjs) may publish pre-lowered
  // ES5 bodies keyed by the fnv1a hash of the ORIGINAL source text — the
  // same txFnv1a the JEL-178 `txc:` cache key already uses. At boot the
  // shell fetches ${server}/shell/tx-manifest.json in parallel with the
  // /web/ RTT; each slow-path script then hashes its fetched source and, on
  // a manifest hit, downloads the pre-lowered body instead of loading Babel
  // at all. localStorage caching downstream is unchanged, so bodies within
  // the 256 KB cap short-circuit before even the drop fetch on later boots.
  //   Safety: a drop body is accepted ONLY if the STRICT post-transpile
  //   oracle passes (loweredBodyOk — JELA-11 parse probe when available,
  //   MODERN_SYNTAX_RE token screen as fallback), so an incompatible or
  //   corrupt drop entry falls back to the on-device Babel path — never
  //   to raw modern source reaching the M56 parser. The manifest must also
  //   carry this shell's exact BABEL_OPTS_KEY so transform semantics (loose
  //   iterables, JEL-26 assumptions) match what the TV would produce.
  //   Kill switch: localStorage["jellyfin.shell.txDropDisabled"]="1".
  //   Counters (QA): window.__shellTxDrop {h:hits, m:manifest-misses,
  //   r:oracle-rejects, f:drop-fetch-fails}.
  var TXDROP_DISABLED_KEY = "jellyfin.shell.txDropDisabled";
  // JELA-824: absent or !== "1" means bulk ON (opt-out polarity, per convention).
  var TXBUNDLE_DISABLED_KEY = "jellyfin.shell.txBundleDisabled";
  var TXDROP_MANIFEST_PATH = "/shell/tx-manifest.json";
  function txDropDisabled() {
    try {
      return localStorage.getItem(TXDROP_DISABLED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function txBundleDisabled() {
    try {
      return localStorage.getItem(TXBUNDLE_DISABLED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function loadTxDropManifest(serverUrl) {
    // Parks a never-rejecting promise on window.__shellTxDropReady and the
    // resolved {ok,base,entries,...} state on window.__shellTxDrop (read by
    // the in-document seed pipelines — window survives document.write).
    // Non-legacy engines and disabled boots resolve null immediately; a
    // missing/invalid manifest (today's servers: /shell/ 404) resolves null
    // after one small bounded fetch, and every consumer falls back to the
    // on-device transpile path unchanged.
    if (!isLegacyChromium() || txDropDisabled()) {
      window.__shellTxDropReady = Promise.resolve(null);
      return window.__shellTxDropReady;
    }
    // JELA-59: the decision waits for the epoch gate (resolved immediately
    // when the gate is off). An epoch-matched boot serves the persisted
    // last-good manifest — the per-boot busted fetch is exactly the
    // revalidation the gate suppresses; every other state fetches as today.
    var p = ceReady()
      .then(function () {
        if (window.__shellCfgEM === 1) {
          var ce = ceTxmRead(serverUrl);
          if (ce) {
            ceSup("txm");
            return ceTxdState(serverUrl, ce);
          }
        }
        return withBootTimeout(
          fetch(
            // JEL-178: M63's WebView doesn't honor fetch cache:"no-store"
            // reliably; a per-fetch unique token forces a real network read
            // so a freshly regenerated drop is picked up on the next boot.
            serverUrl + TXDROP_MANIFEST_PATH + "?__sb=" + Date.now(),
            { credentials: "omit", cache: "no-store" },
          ),
          "tx drop manifest",
          4000,
        )
          .then(function (r) {
            if (!r.ok) return null;
            return r.json();
          })
          .then(function (mf) {
            if (!mf || typeof mf !== "object" || !mf.entries) return null;
            // Different transform semantics (target/loose/assumptions drift
            // between the drop builder and this shell) could pass the syntax
            // oracle yet behave differently at runtime; require exact match.
            if (mf.babelOptsKey !== BABEL_OPTS_KEY) return null;
            if (ceGateOn()) ceTxmWrite(serverUrl, mf.entries);
            return ceTxdState(serverUrl, mf.entries);
          });
      })
      .catch(function () {
        return null;
      });
    window.__shellTxDropReady = p;
    return p;
  }
  // JELA-11: STRICT post-transform oracle. A pre-lowered drop body (and any
  // on-TV Babel output — see babelTranspile) is accepted only if it actually
  // parses on THIS engine; the MODERN_SYNTAX_RE token screen is the fallback
  // when the probe is unavailable/disabled. The probe also retires the
  // regex oracle's known false-positive class (modern-looking tokens inside
  // string literals reading a correctly-lowered body as "still modern").
  function loweredBodyOk(body) {
    if (parseProbeActive()) return parsesOnThisEngine(body);
    return !MODERN_SYNTAX_RE.test(body);
  }
  function txDropResolve(code) {
    // Promise<loweredBody|null>. null means "no usable drop body" — the
    // caller falls back to the Babel slow path. Never rejects.
    var ready = window.__shellTxDropReady;
    if (!ready || typeof ready.then !== "function")
      return Promise.resolve(null);
    return ready
      .then(function (d) {
        if (!d || !d.ok || !d.entries) return null;
        var rel = d.entries[txFnv1a(String(code || ""))];
        if (typeof rel !== "string" || !rel) {
          d.m++;
          return null;
        }
        // JELA-833: offer this hash to the coalescer and wait only for ITS
        // batch — never for a single all-or-nothing fetch of everything
        // (JELA-824 serialised the whole slow-path transpile behind one
        // 18.8 MB download). d.want is absent when the kill switch is set,
        // and resolves null whenever the bundle did not carry the body, so
        // both cases land on the per-body GET below.
        var hash = rel.slice(3, -3); // strip leading "tx/" and trailing ".js"
        var viaBundle = d.want ? d.want(hash) : Promise.resolve(null);
        return viaBundle.then(function (bundled) {
          if (typeof bundled === "string") {
            if (!bundled.length || !loweredBodyOk(bundled)) {
              d.r++;
              return null;
            }
            d.h++;
            // JELA-187: a drop hit means this static body needs lowering.
            try {
              localStorage.setItem(DROP_NEEDED_KEY, "1");
            } catch (_) {}
            return bundled;
          }
          return fetch(d.base + rel, { credentials: "omit" })
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.text();
            })
            .then(function (body) {
              if (
                typeof body !== "string" ||
                !body.length ||
                !loweredBodyOk(body)
              ) {
                d.r++;
                return null;
              }
              d.h++;
              // JELA-187: a drop hit means this static body needs lowering —
              // the warm-boot string fast path must never replay its raw src.
              try {
                localStorage.setItem(DROP_NEEDED_KEY, "1");
              } catch (_) {}
              return body;
            })
            .catch(function () {
              d.f++;
              return null;
            });
        });
      })
      .catch(function () {
        return null;
      });
  }

  // JEL-554 (v32): fast pre-check for syntax that Chromium 56 can't parse.
  // babel.transform() takes ~50–200 ms per plugin on a 2019 Q60R panel; with
  // 30–50 plugins that's the bulk of the 25 s post-shellBoot gap. Many
  // plugins are plain ES5/ES6 and parse fine on Chromium 56 — we don't need
  // to transpile them at all. The regex screens for the post-Chrome-56 tokens
  // we actually see breaking on TV: optional chaining (?.), nullish coalescing
  // (??), nullish-assignment (??= / ||= / &&=), private class fields (#x),
  // numeric separators (1_000), the BigInt suffix (1n at digit boundary), and
  // (JEL-354) the ES2018 forms Chrome 56 also lacks: object rest/spread
  // ({...a} / {a,...r}), async generators (async function* / async *m()), and
  // `for await...of`. Array/call spread and rest params are ES2015 and stay
  // unmatched so a fully-lowered body no longer trips the regex.
  // JEL-1150: MODERN_SYNTAX_RE hoisted to top-of-IIFE so its source feeds
  // the derived TX_VER hash.
  // JEL-417: the PRE-check gates on MODERN_PRECHECK_RE (broader — also catches
  // interior `, ...x` object spread), not the precise MODERN_SYNTAX_RE oracle.
  // JELA-11: when the device-native parse probe is available (see
  // PARSE_PROBE_OK top-of-IIFE) the engine's own parser answers instead —
  // no false negatives by construction, no wasted Babel passes on regex
  // false positives (`span1n`, tokens inside string literals). The regex
  // pre-check is the capability/killswitch fallback.
  function needsTranspile(code) {
    if (typeof code !== "string") return false;
    if (parseProbeActive()) return !parsesOnThisEngine(code);
    return MODERN_PRECHECK_RE.test(code);
  }
  // JEL-216: turn a modern-syntax external script we could not transpile into
  // an inert node so its raw `?.`/`??` can't SyntaxError the M63 engine (which
  // would take down the whole concatenated script). src/defer/async/type are
  // removed and the body emptied; the URL is preserved in a marker attribute.
  //@@SHELL_CORE:neutralizeUntranspiled@@

  function transpileLegacyScripts(doc, baseUrl) {
    var legacy = isLegacyChromium();
    if (!legacy) return Promise.resolve();
    // JEL-1034 (v53): babel is lazy. Don't gate the whole pipeline on
    // __babelReady — fast-path plugins (no ES2020+ syntax) skip babel
    // entirely. The per-script call site in transpileLegacyScriptsInner
    // invokes window.__ensureBabel() ONLY when needsTranspile(code) ===
    // true, so plugin-light servers never trigger the 3 MB load.
    // JEL-1984: settle babelUnusedStreak after the per-script jobs
    // resolve. Pre-init `__shellBabelUnusedStreak` so the HUD can
    // render a value before the inner pass completes.
    try {
      var prevStreakInit =
        parseInt(localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0", 10) || 0;
      window.__shellBabelUnusedStreak = prevStreakInit;
    } catch (_) {
      window.__shellBabelUnusedStreak = window.__shellBabelUnusedStreak || 0;
    }
    return transpileLegacyScriptsInner(doc, baseUrl).then(
      function (r) {
        try {
          var c = window.__shellDiagInit || {};
          var prev = 0;
          try {
            prev =
              parseInt(
                localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0",
                10,
              ) || 0;
          } catch (_) {}
          var next = prev;
          if ((c.scriptsFound || 0) > 0) {
            // JEL-621: a script served by the pre-lowered drop needed no
            // Babel either — count it toward full coverage so drop-covered
            // servers reach streak>=2 and stop the eager babel preload.
            if (
              (c.babelLazyTriggered || 0) === 0 &&
              (c.cachedHits || 0) + (c.txDropHits || 0) === c.scriptsFound
            ) {
              next = prev + 1;
            } else {
              next = 0;
            }
            try {
              localStorage.setItem(BABEL_UNUSED_STREAK_KEY, String(next));
            } catch (_) {}
          }
          window.__shellBabelUnusedStreak = next;
        } catch (_) {}
        return r;
      },
      function (e) {
        // On hard failure keep the prior streak — a thrown pass tells us
        // nothing about cache coverage. Re-throw so the existing pipeline
        // error path is unchanged.
        throw e;
      },
    );
  }

  // JEL-1034 (v53): unified lazy-babel gate. Resolves to true if
  // window.Babel is usable after awaiting __ensureBabel; false if the
  // loader is missing or babel failed to load. Per-script slow-path calls
  // await this before Babel.transform(). On first resolution, persist the
  // "babel was needed" flag so the next cold boot speculatively primes.
  function ensureBabelReady() {
    var ensure =
      typeof window.__ensureBabel === "function"
        ? window.__ensureBabel
        : function () {
            return Promise.resolve();
          };
    var p;
    try {
      p = ensure();
    } catch (_) {
      p = Promise.resolve();
    }
    if (!p || typeof p.then !== "function") p = Promise.resolve();
    return p.then(function () {
      var ok = typeof window.Babel !== "undefined";
      if (ok) {
        try {
          localStorage.setItem(BABEL_NEEDED_KEY, "1");
        } catch (_) {}
      }
      return ok;
    });
  }

  function transpileLegacyScriptsInner(doc, baseUrl) {
    var legacy = isLegacyChromium();
    shellLog(
      "transpile gate: legacy=" +
        legacy +
        " babel(initial)=" +
        (typeof window.Babel !== "undefined"),
    );
    // JEL-1034 (v53): babel may not be loaded yet — it's lazy. Do NOT
    // early-return on missing Babel. Per-script slow path (needsTranspile
    // true) calls ensureBabelReady() to trigger the load on demand.
    // Plugin-light servers skip babel entirely.
    var scripts = Array.prototype.slice.call(doc.querySelectorAll("script"));
    var counts = (window.__shellDiagInit = window.__shellDiagInit || {});
    counts.legacy = legacy;
    counts.babel = typeof window.Babel !== "undefined";
    counts.polyfilled = true;
    counts.scriptsFound = 0;
    counts.transpiled = 0;
    counts.transpileFailed = 0;
    counts.skipped = 0;
    counts.cachedHits = 0;
    counts.fastPath = 0;
    counts.babelLazyTriggered = 0;
    counts.pluginPrefetchAdopted = 0;
    counts.txDropHits = 0;
    // JEL-1654: record plugin <script src> URLs for next-boot prefetch.
    // Mirrors the JEL-1289 bundle-URL pattern: index.html head IIFE will
    // kick off these fetches in parallel with shell.min.js parse + babel
    // lazy load + /web/ RTT, so transpileLegacyScripts adopts the in-
    // flight responses instead of waiting on the DOM walk to finish
    // before starting per-script fetches. Cap at 100 URLs to bound the
    // localStorage write; same-origin (baseUrl) gate happens in the IIFE.
    var pluginPrefetch = window.__shellPluginPrefetch || null;
    var pluginUrlsForNextBoot = [];
    for (
      var pUi = 0;
      pUi < scripts.length && pluginUrlsForNextBoot.length < 100;
      pUi++
    ) {
      var pUs = scripts[pUi];
      if (pUs.getAttribute("data-shell-seed") === "1") continue;
      if (pUs.getAttribute("data-shell-diag") === "1") continue;
      if (pUs.getAttribute("data-shell-bundle-patched")) continue;
      var pUsrc = pUs.getAttribute("src");
      if (!pUsrc) continue;
      if (/^(?:data|blob|javascript):/i.test(pUsrc)) continue;
      if (isJellyfinWebBundle(pUsrc)) continue;
      // JEL-619: skip query-bearing (cache-busted) plugin URLs — preloading
      // them is ALWAYS wasted bandwidth: a version-keyed cache hit needs no
      // network at all, and a miss is fetched with a fresh &__sb= buster
      // that can never match the preloaded URL (so the preload downloaded
      // the body twice per boot before this).
      if (pUsrc.indexOf("?") >= 0) continue;
      try {
        var pUurl = new URL(pUsrc, baseUrl).href;
        pluginUrlsForNextBoot.push(pUurl);
      } catch (_) {}
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.pluginUrls",
        JSON.stringify(pluginUrlsForNextBoot),
      );
    } catch (_) {}
    // JEL-1924: record secondary .bundle.js URLs (runtime/vendors/jquery/
    // noto/lang/etc.) for next-boot prefetch. Extends JEL-1289 (main
    // bundle only) + JEL-1654 (plugin <script src>). Without this,
    // every other webpack chunk referenced in /web/index.html waits
    // a full RTT past document.write before its serial fetch starts.
    // Main bundle stays in SHELL_BUNDLE_URL_KEY for patcher cache
    // invariant; this list is prefetch-only (no adoption — browser
    // HTTP cache coalesces the IIFE fetch with the post-document.write
    // re-fetch). Same-origin gate (server origin, not /web/ path) to
    // keep CDN-hosted assets out. Cap 20.
    var sbServerOrigin = null;
    try {
      sbServerOrigin = new URL(baseUrl).origin;
    } catch (_) {}
    var secondaryBundleUrls = [];
    var sbSeen = {};
    var SB_MAIN_RE = /(?:^|\/)main\.[^/]*\.bundle\.js$/i;
    for (
      var bUi = 0;
      bUi < scripts.length && secondaryBundleUrls.length < 20;
      bUi++
    ) {
      var bUs = scripts[bUi];
      if (bUs.getAttribute("data-shell-seed") === "1") continue;
      if (bUs.getAttribute("data-shell-diag") === "1") continue;
      if (bUs.getAttribute("data-shell-bundle-patched")) continue;
      var bUsrc = bUs.getAttribute("src");
      if (!bUsrc) continue;
      if (/^(?:data|blob|javascript):/i.test(bUsrc)) continue;
      var bUbare = String(bUsrc).split("?")[0];
      if (!/\.bundle\.js$/i.test(bUbare)) continue;
      if (SB_MAIN_RE.test(bUbare)) continue;
      var bUurl;
      try {
        bUurl = new URL(bUsrc, baseUrl).href;
      } catch (_) {
        continue;
      }
      if (sbServerOrigin) {
        var bUorigin;
        try {
          bUorigin = new URL(bUurl).origin;
        } catch (_) {
          continue;
        }
        if (bUorigin !== sbServerOrigin) continue;
      }
      if (sbSeen[bUurl]) continue;
      sbSeen[bUurl] = 1;
      secondaryBundleUrls.push(bUurl);
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.secondaryBundleUrls",
        JSON.stringify(secondaryBundleUrls),
      );
    } catch (_) {}
    // JEL-1959: record /web/ <link rel=stylesheet> URLs for next-boot
    // prefetch. Cold boot post-document.write blocks first paint on the
    // 3 render-blocking <link> elements (46967.<hash>.css, main.jellyfin
    // .<hash>.css, /HomeScreen/home-screen-sections.css). On TV networks
    // (200-500ms RTT) + HTTP/1.1 6-conn limit shared with secondary
    // bundles + plugin scripts, serialized cost ~400-1200ms render-block.
    // Mirrors JEL-1924 shape: no adoption (browser HTTP cache coalesces
    // the IIFE fetch with the post-document.write <link> fetch). Same-
    // origin gate against server origin (NOT /web/ prefix — JellyfinEnhanced
    // + HomeScreen serve from /PluginName/, JEL-1580 v58 lesson). Cap 20.
    var ssLinks = doc.querySelectorAll('link[rel="stylesheet"]');
    var stylesheetUrls = [];
    var ssSeen = {};
    for (
      var lUi = 0;
      lUi < ssLinks.length && stylesheetUrls.length < 20;
      lUi++
    ) {
      var lUh = ssLinks[lUi].getAttribute("href");
      if (!lUh) continue;
      if (/^(?:data|blob|javascript):/i.test(lUh)) continue;
      var lUurl;
      try {
        lUurl = new URL(lUh, baseUrl).href;
      } catch (_) {
        continue;
      }
      if (sbServerOrigin) {
        var lUorigin;
        try {
          lUorigin = new URL(lUurl).origin;
        } catch (_) {
          continue;
        }
        if (lUorigin !== sbServerOrigin) continue;
      }
      if (ssSeen[lUurl]) continue;
      ssSeen[lUurl] = 1;
      stylesheetUrls.push(lUurl);
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.stylesheetUrls",
        JSON.stringify(stylesheetUrls),
      );
    } catch (_) {}
    var jobs = scripts.map(function (s) {
      // Skip our own seed/diag scripts; hand-written ES5, run before
      // anything else by design.
      if (s.getAttribute("data-shell-seed") === "1") return null;
      if (s.getAttribute("data-shell-diag") === "1") return null;
      // JEL-618: an inlined cached channel body is FINAL executable output
      // (transpiled + jQuery-gated on a prior boot). Running the modern-
      // syntax pre-check over ~1 MB — or worse, a string-literal false
      // positive re-babeling it — would refund the entire caching win.
      if (s.getAttribute("data-shell-jsi-cached") === "1") {
        counts.skipped++;
        return null;
      }
      if (s.getAttribute("data-shell-bundle-patched")) {
        counts.skipped++;
        return null;
      }
      var src = s.getAttribute("src");
      if (src) {
        if (isJellyfinWebBundle(src)) {
          counts.skipped++;
          return null;
        }
        counts.scriptsFound++;
        // JEL-618: adopt the finished channel body into the channel cache.
        // Attribute-matched (our own injected tag), never URL-matched, so a
        // server-injected public.js is never recorded. Plugin-agnostic.
        var isJsiChannelTag = s.getAttribute("data-shell-jsi-channel") === "1";
        var url;
        try {
          url = new URL(src, baseUrl).href;
        } catch (_) {
          return null;
        }
        // JEL-554 (v32): cache short-circuit. Skip fetch + babel entirely
        // if we transpiled this URL on a previous boot.
        // JEL-619: query-bearing URLs are eligible too — txGetStatic serves
        // them from the version-keyed slot (config-version token unchanged
        // -> ZERO network; token change / TTL expiry / unpinned marker ->
        // miss -> the busted fetch below, JEL-178 staleness intact).
        var cached = txGetStatic(url);
        if (cached != null) {
          s.removeAttribute("src");
          s.removeAttribute("defer");
          s.removeAttribute("async");
          s.removeAttribute("type");
          s.textContent = cached;
          s.setAttribute("data-shell-transpiled-from", url);
          s.setAttribute("data-shell-tx-cached", "1");
          counts.transpiled++;
          counts.cachedHits++;
          shellLog("cache hit", url);
          return null;
        }
        // Use HTTP cache (not no-store). The same URL is loaded a second
        // time when document.write replays unpatched <script src=...>;
        // forcing no-store would double the bytes over the wire.
        // JEL-1654: adopt the in-flight prefetch from the head IIFE
        // when the URL matches a recorded last-boot plugin URL.
        // Falls back to a fresh fetch on miss (stale recording or
        // first cold boot). IIFE filters by server origin (JEL-1580
        // v58) so map keys are always absolute same-origin URLs.
        var pfPlugin = pluginPrefetch && pluginPrefetch[url];
        var responsePromise;
        if (pfPlugin) {
          responsePromise = pfPlugin;
          counts.pluginPrefetchAdopted++;
        } else {
          responsePromise = fetch(
            // JEL-178: a query string marks a cache-busted (config-mutable)
            // plugin script. M63's WebView does not honor fetch cache:"no-store"
            // reliably, so append a per-fetch unique token to force a real
            // network read (the server ignores unknown query params). The
            // content-addressed key below dedups the transpile, so this costs
            // only a download, not a re-transpile. Plugin-agnostic.
            // JEL-619: this busted fetch now runs only on a version-key MISS
            // (token changed / TTL expired / unpinned ?_jsi=1-style marker /
            // cold cache) — an unchanged version token was served above with
            // zero network. The buster still matters here: a token flip-flop
            // (A->B->A) or a TTL revalidation re-uses a URL M63's HTTP cache
            // may hold a stale body for.
            url.indexOf("?") >= 0
              ? url +
                  "&__sb=" +
                  Date.now() +
                  "." +
                  (window.__sbN = (window.__sbN || 0) + 1)
              : url,
            url.indexOf("?") >= 0
              ? { credentials: "omit", cache: "no-store" }
              : { credentials: "omit" },
          );
        }
        return responsePromise
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.text();
          })
          .then(function (code) {
            // JEL-178: content-addressed transpile cache key. A query-bearing
            // (cache-busted) URL is keyed by a hash of its current source, so
            // ANY plugin's config change yields a new key (re-transpile) while
            // unchanged content reuses the cached transpile. No plugin named.
            var ck = url.indexOf("?") >= 0 ? "txc:" + txFnv1a(code) : url;
            var pre = txGetStatic(ck);
            if (pre != null) {
              s.removeAttribute("src");
              s.removeAttribute("defer");
              s.removeAttribute("async");
              s.removeAttribute("type");
              s.textContent = pre;
              s.setAttribute("data-shell-transpiled-from", url);
              s.setAttribute("data-shell-tx-cached", "1");
              counts.transpiled++;
              counts.cachedHits++;
              if (isJsiChannelTag) jsiChannelCacheSet(pre);
              // JEL-619: promote the content-hash hit to the version-keyed
              // slot so the NEXT boot skips the download too (the token
              // changed but the body didn't — e.g. an unrelated config edit
              // bumped a shared ticks token).
              if (url.indexOf("?") >= 0) txRecordQuerySlot(url, ck);
              return;
            }
            // JEL-554 (v32): fast path for plugins that don't use
            // any ES2020+ syntax — inline raw, skip babel CPU cost.
            if (!needsTranspile(code)) {
              s.removeAttribute("src");
              s.removeAttribute("defer");
              s.removeAttribute("async");
              s.removeAttribute("type");
              var gatedRaw = needsJQueryGate(code);
              var bodyRaw = gatedRaw ? wrapForJQuery(code) : code;
              s.textContent = bodyRaw;
              s.setAttribute("data-shell-transpiled-from", url);
              s.setAttribute("data-shell-fast-path", "1");
              if (gatedRaw) s.setAttribute("data-shell-jquery-gated", "1");
              txSetStatic(ck, bodyRaw);
              if (isJsiChannelTag) jsiChannelCacheSet(bodyRaw);
              // JEL-619: version-keyed slot so an unchanged ?v= token skips
              // the download entirely next boot.
              if (url.indexOf("?") >= 0) txRecordQuerySlot(url, ck);
              counts.transpiled++;
              counts.fastPath++;
              shellLog("fast-path+inlined", url, gatedRaw ? "(jq-gated)" : "");
              return;
            }
            // JEL-621: pre-lowered drop attempt before the Babel slow path.
            // On a manifest hit the server already ran this exact transform
            // offline — inline the drop body (same jq gate + tx-cache write
            // as the Babel path) and never touch Babel for this script.
            return txDropResolve(code).then(function (dropped) {
              if (dropped != null) {
                s.removeAttribute("src");
                s.removeAttribute("defer");
                s.removeAttribute("async");
                s.removeAttribute("type");
                var gatedD = needsJQueryGate(dropped);
                var bodyD = gatedD ? wrapForJQuery(dropped) : dropped;
                s.textContent = bodyD;
                s.setAttribute("data-shell-transpiled-from", url);
                s.setAttribute("data-shell-tx-drop", "1");
                if (gatedD) s.setAttribute("data-shell-jquery-gated", "1");
                txSetStatic(ck, bodyD);
                // JEL-618 x JEL-621: the drop already carries the transpiled
                // JSI-channel body, so seed the channel-body cache here too —
                // otherwise a drop hit would bypass the next-boot fast splice.
                if (isJsiChannelTag) jsiChannelCacheSet(bodyD);
                counts.transpiled++;
                counts.txDropHits++;
                shellLog("tx-drop+inlined", url, gatedD ? "(jq-gated)" : "");
                return;
              }
              // JEL-1034 (v53): slow path triggers lazy babel load.
              counts.babelLazyTriggered++;
              return ensureBabelReady().then(function (ready) {
                if (!ready) {
                  counts.transpileFailed++;
                  // JEL-216 fail-safe: this body matched MODERN_SYNTAX_RE, so
                  // leaving the raw external <script src> would let un-transpiled
                  // `?.`/`??` reach the M63 engine — a SyntaxError that kills the
                  // ENTIRE script (e.g. the whole concatenated JS-Injector
                  // public.js). Drop the src so it can't execute raw;
                  // markBabelNeeded primes babel for the next boot.
                  neutralizeUntranspiled(s, url);
                  try {
                    console.warn(
                      "shell: babel not available, dropped untranspiled",
                      url,
                    );
                  } catch (_) {}
                  return;
                }
                counts.babel = true;
                var out = babelTranspile(code);
                if (out == null) {
                  counts.transpileFailed++;
                  // JEL-216: same fail-safe for a transform that threw.
                  neutralizeUntranspiled(s, url);
                  return;
                }
                counts.transpiled++;
                // Inline the transpiled code instead of swapping `src`
                // to a blob: URL. Two reasons (JEL-401 follow-up):
                //   1. Chromium 56's document.open()/document.write()
                //      handoff can invalidate Blob URL bindings created
                //      on the prior document, so <script src="blob:...">
                //      resolves to about:blank and the plugin silently
                //      never executes.
                //   2. The default Tizen widget CSP (`default-src 'self'`)
                //      blocks `blob:` and `data:` script sources unless
                //      the widget opts in, which we don't.
                // Inline scripts execute at parse time; defer/async on
                // the original tag are dropped, but server plugins are
                // typically self-contained DOM/CSS injectors and
                // tolerate earlier execution. Original src is preserved
                // on a data attribute for diagnostics.
                s.removeAttribute("src");
                s.removeAttribute("defer");
                s.removeAttribute("async");
                s.removeAttribute("type");
                var gated = needsJQueryGate(out);
                var body = gated ? wrapForJQuery(out) : out;
                s.textContent = body;
                s.setAttribute("data-shell-transpiled-from", url);
                if (gated) s.setAttribute("data-shell-jquery-gated", "1");
                txSetStatic(ck, body);
                // JEL-618: cache the transpiled JSI-channel body for the
                // next-boot fast-path splice (mirrors the fast-path/drop paths).
                if (isJsiChannelTag) jsiChannelCacheSet(body);
                // JEL-619: version-keyed slot so an unchanged ?v= token skips
                // the download entirely next boot.
                if (url.indexOf("?") >= 0) txRecordQuerySlot(url, ck);
                shellLog("transpiled+inlined", url, gated ? "(jq-gated)" : "");
              });
            });
          })
          .catch(function (e) {
            counts.transpileFailed++;
            try {
              console.warn("shell: skip transpile", url, e && e.message);
            } catch (_) {}
          });
      }
      // Inline script — transpile in place. Preserve original on failure.
      var content = s.textContent || "";
      if (!content || !content.replace(/\s/g, "")) return null;
      if (!needsTranspile(content)) {
        counts.fastPath++;
        return null;
      }
      // JEL-621: pre-lowered drop attempt before the Babel slow path —
      // inline bodies hash the same way as fetched external sources.
      return txDropResolve(content).then(function (droppedInline) {
        if (droppedInline != null) {
          s.textContent = droppedInline;
          s.setAttribute("data-shell-transpiled-inline", "1");
          s.setAttribute("data-shell-tx-drop", "1");
          counts.txDropHits++;
          shellLog("tx-drop inline script");
          return;
        }
        // JEL-1034 (v53): slow path triggers lazy babel load.
        counts.babelLazyTriggered++;
        return ensureBabelReady().then(function (ready) {
          if (!ready) {
            try {
              console.warn("shell: babel not available, skip inline transpile");
            } catch (_) {}
            return;
          }
          counts.babel = true;
          var transpiled = babelTranspile(content);
          if (transpiled != null && transpiled !== content) {
            s.textContent = transpiled;
            s.setAttribute("data-shell-transpiled-inline", "1");
            shellLog("transpiled inline script");
          }
        });
      });
    });
    return Promise.all(jobs);
  }

  // ---- Bundle source patcher (JEL-436 v24) ------------------------------
  //
  // JEL-534/JEL-536 confirmed two failed in-process strategies:
  //   * window.connectionManager — not a global (lives in webpack closure)
  //   * webpack module walk via fake chunk push — chunk push doesn't capture
  //     __webpack_require__ in our callback (CM:0 t:374 with no CMe error)
  //
  // The error `item or serverId cannot be null` is thrown from a minified
  // method on connectionManager.getApiClient inside main.jellyfin.bundle.js.
  // The throw fires when an item is passed without ServerId, even though
  // getItem() returned ServerId in the same session (JEL-530 confirmed
  // GI has:1). The item used at play time is a different/stale object.
  //
  // Strategy: patch the bundle source DIRECTLY at fetch time. The error
  // string `"item or serverId cannot be null"` is preserved verbatim in
  // minification, so it's locatable in the source. The throwing function
  // has a consistent shape `function(X){if(!X||!X.ServerId)throw new
  // Error("item or serverId cannot be null")...}`. Rewrite that prefix
  // with `function(X){if(window.ApiClient){X=X||{};if(!X.ServerId){X.
  // ServerId=window.ApiClient.serverId();}}if(!X||!X.ServerId)throw...}`
  // so a missing ServerId is auto-filled from the authenticated ApiClient
  // before the null-check fires.

  function buildBundleSourcePatcher() {
    // QA confirmed the actual minified function in main.jellyfin.bundle.js
    // (JEL-537):
    //   function(e){if(!e)throw new Error("item or serverId cannot be null");return e.ServerId&&(e=e.ServerId),this._apiClients.filter(...)
    // Single `!e` check, NOT `!e||!e.ServerId`. Param accepts either item or
    // serverId string. v24's stricter regex missed it. Patterns below match
    // both the single-check (current jellyfin-web shape) and the older
    // double-check (defensive, in case server runs an older bundle).
    //
    // Replacement injects three recoveries before falling through to the
    // original throw:
    //   1. If X is null/undefined → return window.ApiClient (single-server
    //      shell: the global apiClient is always valid for playback)
    //   2. If X is object missing ServerId → inject from ApiClient.serverId()
    //   3. If neither path works, original throw still fires
    var patterns = [
      // function(X){if(!X)throw new Error("...")  [v25 single-check match]
      /(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      // (X)=>{if(!X)throw new Error("...")
      /(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      // function(X){if(!X||!X.ServerId)throw new Error("...")  [legacy]
      /(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      // (X)=>{if(!X||!X.ServerId)throw new Error("...")  [legacy]
      /(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
    ];
    return function patch(source) {
      var total = 0;
      for (var p = 0; p < patterns.length; p++) {
        source = source.replace(
          patterns[p],
          function (_match, prefix, paramName) {
            total++;
            return (
              prefix +
              "try{" +
              "if(" +
              paramName +
              "==null&&window.ApiClient)return window.ApiClient;" +
              "if(" +
              paramName +
              "&&typeof " +
              paramName +
              '==="object"&&!' +
              paramName +
              '.ServerId&&window.ApiClient&&typeof window.ApiClient.serverId==="function")' +
              paramName +
              ".ServerId=window.ApiClient.serverId();" +
              "}catch(_){}" +
              "if(!" +
              paramName +
              ')throw new Error("item or serverId cannot be null")'
            );
          },
        );
      }
      return { source: source, patches: total };
    };
  }

  function patchPlaybackBundles(doc, baseUrl, prefetched) {
    window.__shellBundlePatches = 0;
    window.__shellBundlesScanned = 0;
    window.__shellBundlesPatchedFiles = [];
    window.__shellBundleHits = 0;
    // JEL-1776: warm-boot cache counters. CacheHit = URL match (any
    // verdict). CacheBodyHit = patched body served from localStorage
    // (no fetch, no scan). Surfaced for HUD/QA timing comparisons.
    window.__shellBundleCacheHit = 0;
    window.__shellBundleCacheBodyHit = 0;
    // JEL-554 (v29): the `item or serverId cannot be null` throw is
    // triggered by a viewshow-not-firing race that is specific to
    // Chromium <70 (see JEL-436 root-cause analysis above). On modern
    // Chromium TVs / emulator the bundle patch is dead weight — it
    // adds a full main.*.bundle.js fetch + regex pass to the boot
    // critical path before document.write with zero playback benefit.
    // Skip the entire scan on modern Chromium; the seed-side viewshow
    // synth + CM/PM in-process patches are also already legacy-gated.
    if (!isLegacyChromium()) {
      window.__shellBundlePatchSkipped = 1;
      return Promise.resolve();
    }
    // JEL-1289 (v55): speculative bundle prefetch. The main.*.bundle.js
    // fetch is the single biggest critical-path RTT before document.write
    // on legacy cold boot (~1.5–2 MB body, 500–1500 ms on TV networks).
    // index.html's prefetch IIFE now kicks a fetch for the LAST-SEEN
    // bundle URL (recorded below) alongside /web/index.html so the
    // network overlaps shell.js parse + Babel load instead of running
    // serially after them. Stale URL (server upgrade → new bundle hash)
    // costs one wasted ~2 MB fetch on the upgrade boot only; the next
    // boot re-records the new URL and the prefetch overlaps again.
    var pfBundleUrl = prefetched && prefetched.url;
    var pfBundleFetch = prefetched && prefetched.fetch;
    window.__shellBundlePrefetchAdopted = 0;
    var patcher = buildBundleSourcePatcher();
    // JEL-1776: read once outside the loop; verdict is per-URL but the
    // record is single-entry (only main.*.bundle.js is ever scanned).
    var cache = readBundlePatchState();
    var scripts = Array.prototype.slice.call(
      doc.querySelectorAll("script[src]"),
    );
    var jobs = scripts.map(function (s) {
      var src = s.getAttribute("src");
      if (!src) return null;
      var bare = String(src).split("?")[0];
      if (!/\.bundle\.js$/i.test(bare)) return null;
      // ServiceWorker runs in its own realm; skip.
      if (/serviceworker/i.test(bare)) return null;
      // JEL-555: the `item or serverId cannot be null` throw lives in
      // main.*.bundle.js (per JEL-537). Scanning every bundle on every
      // cold start adds N extra full-file fetches with no possible
      // patch — the dominant cause of the 15s startup. Restrict to the
      // bundle that can actually match.
      if (
        !/(^|\/)main\.[^/]*\.bundle\.js$/i.test(bare) &&
        !/(^|\/)main\.jellyfin\.bundle\.js$/i.test(bare)
      )
        return null;
      var url;
      try {
        url = new URL(src, baseUrl).href;
      } catch (_) {
        return null;
      }
      // JEL-1776: warm-boot cache hit. URL match means the bundle
      // contenthash hasn't changed since the prior session.
      // JEL-1980: body cache covers BOTH patched (needsPatch=true)
      // and raw (needsPatch=false) bodies — inline whenever body is
      // present and free of </script literals, eliminating the
      // post-document.write network fetch on cold HTTP cache.
      if (cache && cache.url === url) {
        if (cache.body && cache.body.indexOf("</script") < 0) {
          s.removeAttribute("src");
          s.removeAttribute("defer");
          s.removeAttribute("async");
          s.removeAttribute("type");
          s.textContent = cache.body;
          s.setAttribute("data-shell-bundle-patched", url);
          s.setAttribute("data-shell-bundle-from-cache", "1");
          var cachedPatches =
            cache.needsPatch &&
            typeof cache.patches === "number" &&
            cache.patches > 0
              ? cache.patches
              : 0;
          s.setAttribute("data-shell-bundle-patches", String(cachedPatches));
          if (cachedPatches > 0) window.__shellBundlePatches += cachedPatches;
          window.__shellBundlesPatchedFiles.push(
            bare.split("/").pop() + ":cache" + cachedPatches,
          );
          window.__shellBundleCacheHit++;
          window.__shellBundleCacheBodyHit++;
          window.__shellMainBundleLSAdopted = 1;
          window.__shellMainBundleInlineHits =
            (window.__shellMainBundleInlineHits || 0) + 1;
          window.__shellMainBundleLSBytes = cache.body.length;
          return null;
        }
        if (!cache.needsPatch) {
          // No-patch verdict with no/unsafe body — leave <script
          // src defer> in place so HTTP cache serves it. Skips
          // decode + scan; loses the network round-trip win.
          window.__shellBundleCacheHit++;
          return null;
        }
        // needsPatch=true but body was dropped (quota fallback on
        // prior boot). Fall through to fetch + scan + re-patch.
      }
      // JEL-1289: adopt the in-flight prefetch when the URL matches
      // the recorded last-seen bundle. Falls back to a fresh fetch
      // when the hash changed (server upgrade) or no prior record.
      var bundleFetch;
      if (pfBundleFetch && pfBundleUrl === url) {
        bundleFetch = pfBundleFetch;
        window.__shellBundlePrefetchAdopted = 1;
      } else {
        bundleFetch = fetch(url, { credentials: "omit" });
      }
      // HTTP cache OK — patched bodies are inlined; unmatched bundles
      // still need to load again via document.write and benefit from
      // disk cache.
      return bundleFetch
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          // Record successful URL for next-boot prefetch. Done
          // here (not after patch) so even when the bundle has
          // no error string and we skip patching, the document.write
          // <script src> still benefits from a primed HTTP cache.
          try {
            localStorage.setItem("jellyfin.shell.bundleUrl", url);
          } catch (_) {}
          return r.text();
        })
        .then(function (code) {
          window.__shellBundlesScanned++;
          if (code.indexOf("item or serverId cannot be null") < 0) {
            // JEL-1776: record no-patch verdict so the next warm
            // boot skips the decode + scan entirely.
            // JEL-1980: also persist raw body so the next boot
            // can inline it without refetching (eliminates the
            // post-document.write <script src> round-trip on
            // cold HTTP cache).
            writeBundlePatchState({ url: url, needsPatch: false, body: code });
            return;
          }
          window.__shellBundleHits++;
          var result = patcher(code);
          if (result.patches === 0) {
            try {
              console.warn(
                "shell: bundle has error string but no pattern matched",
                url,
              );
            } catch (_) {}
            return;
          }
          s.removeAttribute("src");
          s.removeAttribute("defer");
          s.removeAttribute("async");
          s.removeAttribute("type");
          s.textContent = result.source;
          s.setAttribute("data-shell-bundle-patched", url);
          s.setAttribute("data-shell-bundle-patches", String(result.patches));
          window.__shellBundlePatches += result.patches;
          window.__shellBundlesPatchedFiles.push(
            bare.split("/").pop() + ":" + result.patches,
          );
          // JEL-1776: cache patched body so the next warm boot
          // serves it without re-running the regex pass. Body is
          // ~2 MB so writeBundlePatchState quota-falls-back to the
          // verdict-only record when localStorage is full.
          writeBundlePatchState({
            url: url,
            needsPatch: true,
            body: result.source,
            patches: result.patches,
          });
          try {
            console.log(
              "shell: patched bundle",
              url,
              "patches=" + result.patches,
            );
          } catch (_) {}
        })
        .catch(function (e) {
          try {
            console.warn(
              "shell: bundle patch fetch failed",
              url,
              e && e.message,
            );
          } catch (_) {}
        });
    });
    return Promise.all(jobs);
  }

  // JEL-554 (v32) defer-script watchdog. Extracted JEL-1832 so both the
  // DOMParser path and the string fast path arm the same recovery timer.
  // See JEL-723 history above for poll vs blind-timer rationale.
  function armDeferWatchdog() {
    // JELA-142: engine-aware recovery. Legacy (sub-70) Chromium keeps the
    // proven flat 20 s cap; modern (C85-class) engines get a 10 s cap plus a
    // positive wedge signal (see tick()). Detection is self-contained (same
    // semantics as isLegacyChromium: UA major, then an optional-chaining
    // parse probe) because defer-watchdog.test.cjs extracts this function
    // standalone.
    var legacyEngine = (function () {
      try {
        var ua = (window.navigator && window.navigator.userAgent) || "";
        var m = /(?:Chrome|Chromium)\/(\d+)\./.exec(ua);
        if (m && parseInt(m[1], 10) < 70) return true;
        // eslint-disable-next-line no-new-func
        new Function("var a={};return a?.b");
        return false;
      } catch (e) {
        return true;
      }
    })();
    var POLL = 150,
      // JEL-101 (ports JEL-99): raised from 5500. On the failing Tizen 5.0
      // (Chromium 63) panel a HEALTHY cold boot installs ApiClient at ~6100 ms
      // (measured on device: dcl=3999, api=6097). The cap must clear that with
      // margin or the rescue clobbers a healthy-but-slow boot. See the tick()
      // note below on why the old readyState trigger was removed.
      // JELA-142: on a modern engine a healthy handoff installs ApiClient at
      // ~3-5 s after arm (QN90B fast class: api 5.7-7.0 s from t0, handoff at
      // ~2-3 s), so 10 s still clears healthy boots with ~2x margin while
      // halving the flat-cap stall penalty when the wedge signal cannot
      // trigger (e.g. resource-timing unavailable or buffer overflowed).
      CAP = legacyEngine ? 20000 : 10000,
      // JELA-142 positive wedge signal (modern engines only). The QN90B C85
      // stall signature — reproduced 1:1 in the local C85 harness via a
      // style-blocked defer queue — is: every written <script defer src>
      // fetch has COMPLETED (resource-timing entry with responseEnd) yet ZERO
      // bundles ever executed and DCL never fires. On a healthy boot the gap
      // between the last bundle fetch completing and the first bundle
      // executing is tens of ms, so requiring the full signature to hold
      // 2 s (after a 3 s arm delay) cannot clip a healthy boot; a genuinely
      // slow bundle fetch keeps the signal false (its resource entry is
      // missing until completion) and falls through to the cap instead.
      STALL_MIN_MS = 3000,
      STALL_HOLD_MS = 2000,
      stallSince = 0,
      started = Date.now();
    // JEL-631 (ports JEL-137 guard, lockstep with boot-shell.src.js):
    // registerElement calls prove the web client bundle already executed, so
    // re-injection would double-run it even though ApiClient may not be
    // installed yet on a slow boot.
    function alreadyRan() {
      return (window.__shellRegElCalls || 0) > 0;
    }
    // JELA-142: true only when EVERY written defer bundle has a completed
    // resource-timing entry (fetch done, bytes in hand). Any missing entry —
    // fetch still in flight, never started, or evicted by buffer overflow —
    // returns false so the caller falls back to the cap. window.performance
    // (not the bare global) so the test harness can inject a mock.
    function allDefersFetched(defers) {
      try {
        var perf = window.performance;
        if (!perf || !perf.getEntriesByName) return false;
        for (var i = 0; i < defers.length; i++) {
          var src = defers[i].getAttribute("src");
          if (!src) return false;
          var abs = src;
          try {
            abs = new URL(src, document.baseURI).href;
          } catch (e) {}
          var es = perf.getEntriesByName(abs, "resource");
          if (!es || !es.length) return false;
          if (!(es[es.length - 1].responseEnd > 0)) return false;
        }
        return defers.length > 0;
      } catch (e) {
        return false;
      }
    }
    function reinject(reason) {
      try {
        if (typeof window.ApiClient !== "undefined") return;
        if (typeof window.__webpack_require__ !== "undefined") return;
        if (alreadyRan()) {
          window.__shellDeferWatchdogSkipped =
            (window.__shellDeferWatchdogSkipped || 0) + 1;
          window.__shellDeferWatchdogSkipReason =
            "regEl>" + (window.__shellRegElCalls || 0);
          return;
        }
        // JEL-137: a partially-executed defer sequence is NOT the JEL-99
        // wedge. Every jellyfin-web bundle starts with
        // `(self.webpackChunk=self.webpackChunk||[]).push(...)`, so the
        // array's existence proves at least one defer already executed and
        // the sequence is alive — just slow. Re-injecting then re-runs every
        // already-run bundle: two webpack runtimes, two module caches, and
        // route chunks bind half-evaluated modules from the stale cache
        // (login tF getter TypeError -> black login page). Only re-inject
        // when NO bundle ever executed.
        var wpc = null;
        try {
          wpc = window.webpackChunk || window.webpackJsonp;
        } catch (_) {}
        if (wpc) {
          window.__shellDeferWatchdogSkipped =
            (window.__shellDeferWatchdogSkipped || 0) + 1;
          window.__shellDeferWatchdogSkipReason = "webpackChunkExists";
          return;
        }
        var defers = document.querySelectorAll("script[defer][src]");
        if (!defers || !defers.length) return;
        try {
          console.warn(
            "shell: defer-script watchdog firing (" +
              reason +
              "); re-injecting",
            defers.length,
            "scripts",
          );
        } catch (_) {}
        window.__shellDeferWatchdogFired = defers.length;
        window.__shellDeferWatchdogReason = reason;
        window.__shellDeferWatchdogAtMs = Date.now() - started;
        for (var i = 0; i < defers.length; i++) {
          var src = defers[i].getAttribute("src");
          if (!src) continue;
          // JEL-101 (ports JEL-99): drop the original (still-unrun) defer node
          // before re-injecting so it cannot also execute later and double-run
          // the webpack runtime. The cap only fires while ApiClient /
          // __webpack_require__ are still absent, i.e. these defers provably
          // have NOT executed yet, so removing them cancels them rather than
          // racing a second copy.
          try {
            defers[i].parentNode && defers[i].parentNode.removeChild(defers[i]);
          } catch (_) {}
          var s2 = document.createElement("script");
          s2.src = src;
          // JELA-142: dynamically-inserted scripts default to async (load-order
          // execution). async=false puts the rescues on the in-order list so
          // the webpack bundles execute in source order, exactly like the defer
          // queue they replace (C85 harness showed load-order interleaving
          // without it). In-order dynamic scripts are also immune to the
          // style-blocking that wedges the parser-inserted defer queue.
          s2.async = false;
          s2.setAttribute("data-shell-defer-watchdog", "1");
          document.head.appendChild(s2);
        }
      } catch (e) {
        try {
          console.warn("shell: defer-script watchdog error", e && e.message);
        } catch (_) {}
      }
    }
    function tick() {
      try {
        if (typeof window.ApiClient !== "undefined") return;
        if (typeof window.__webpack_require__ !== "undefined") return;
        if (alreadyRan()) return;
        // JEL-101 (ports JEL-99): do NOT treat document.readyState ===
        // "complete" as a hang signal. After document.open/write/close into the
        // already-complete bootstrap document, Chromium 63 reports readyState
        // "complete" almost immediately (measured 638 ms) while the freshly
        // written defer bundles are still healthy and pending — ApiClient did
        // not install until 6097 ms. The old readyState trigger therefore fired
        // at 638 ms, re-injected all 28 scripts, and the real defers then ALSO
        // ran, which double-ran the webpack runtime and wedged the SPA forever
        // (JEL-99). The only sound "defers ran" signals are __webpack_require__
        // / ApiClient / registerElement (checked above); absent those, wait
        // out the cap before assuming a genuine hang.
        var elapsed = Date.now() - started;
        if (elapsed >= CAP) {
          reinject("cap@" + elapsed + "ms");
          return;
        }
        // JELA-142: modern-engine positive wedge signal. All defer fetches
        // complete + zero bundles executed, held for STALL_HOLD_MS, proves the
        // defer queue was abandoned (the C85 doc.open/write/close stall) —
        // rescue now instead of waiting out the cap. webpackChunk is checked
        // here (not just in reinject) so a live-but-slow sequence resets the
        // hold instead of accumulating it.
        if (!legacyEngine && elapsed >= STALL_MIN_MS) {
          var wedged = false;
          try {
            var wpc2 = null;
            try {
              wpc2 = window.webpackChunk || window.webpackJsonp;
            } catch (_) {}
            if (!wpc2) {
              var defers2 = document.querySelectorAll("script[defer][src]");
              wedged = !!(
                defers2 &&
                defers2.length &&
                allDefersFetched(defers2)
              );
            }
          } catch (_) {}
          if (wedged) {
            if (!stallSince) stallSince = Date.now();
            window.__shellDeferStallHeldMs = Date.now() - stallSince;
            if (Date.now() - stallSince >= STALL_HOLD_MS) {
              reinject("stall@" + elapsed + "ms");
              return;
            }
          } else {
            stallSince = 0;
          }
        }
        setTimeout(tick, POLL);
      } catch (e) {
        try {
          console.warn(
            "shell: defer-script watchdog tick error",
            e && e.message,
          );
        } catch (_) {}
      }
    }
    setTimeout(tick, POLL);
  }

  //@@SHELL_CORE:escAttr@@

  // JEL-1832: warm-boot string fast path.
  //
  // DOMParser.parseFromString + doc.documentElement.outerHTML round-trip
  // costs ~200–500 ms on Chromium 56 for a plugin-heavy /web/index.html
  // and lands on the critical path between Promise.all([index, config])
  // and document.write. When all caches are primed (no transpile slow
  // path ever fired on this server, bundle cache hit), the heavy DOM
  // mutations the cold path does aren't needed: head injections (base +
  // diag + seed + polyfill) and bundle inline can be done via string
  // splice + a single regex replace.
  //
  // Returns the patched HTML on success, or null to fall back to the
  // DOMParser path. Increments __shellFastPathHits / __shellFastPathFallbacks
  // so QA can read warm-boot path mix from the HUD. Killable per-device
  // via `localStorage.jellyfin.shell.fastPathDisabled='1'` (no re-flash).
  var BUNDLE_FAST_RE =
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']*main\.[^"']*\.bundle\.js[^"']*)["'][^>]*>\s*<\/script>/i;
  function maybeStringFastPath(html, serverUrl, baseUrl, upstreamCfg) {
    if (!window.__shellFastPathHits) window.__shellFastPathHits = 0;
    if (!window.__shellFastPathFallbacks) window.__shellFastPathFallbacks = 0;
    function bail(reason) {
      window.__shellFastPathFallbacks++;
      window.__shellFastPathLastBail = reason;
      return null;
    }
    if (!isLegacyChromium()) return bail("modern");
    try {
      if (localStorage.getItem("jellyfin.shell.fastPathDisabled") === "1")
        return bail("killSwitch");
    } catch (_) {}
    // If ANY plugin ever hit the babel slow path on this server, the
    // tx cache holds transpiled (not raw) bodies and we MUST inline
    // them. The DOM walk is the only path that knows which URLs need
    // it, so fall back. Plugin-light legacy servers (babel flag never
    // set) can safely let the browser fetch+execute originals from
    // HTTP cache — they parse as-is on Chromium 56.
    var babelNeeded = false;
    try {
      babelNeeded = localStorage.getItem(BABEL_NEEDED_KEY) === "1";
    } catch (_) {}
    if (babelNeeded) return bail("babelNeeded");
    // JELA-187: same reasoning for drop-lowered statics. A tx-drop hit on
    // any prior walk proved at least one static body cannot run raw on
    // this engine, but the drop serves it Babel-free so babelNeeded never
    // trips. Replaying the cached index as-is would execute the raw
    // <script src> (observed on-fleet: the JE loader, NotifySync and
    // media-bar all die as SyntaxErrors on every warm replayed boot and
    // the server's injected features silently vanish). Fall back to the
    // DOMParser walk, which re-inlines from the version-keyed tx cache.
    var dropNeeded = false;
    try {
      dropNeeded = localStorage.getItem(DROP_NEEDED_KEY) === "1";
    } catch (_) {}
    if (dropNeeded) return bail("dropNeeded");
    // JEL-197: the JS-Injector snippet channel must inject + transpile
    // public.js, which only the DOMParser path can do. JEL-618: unless a
    // fresh cached channel body exists — then the fast path splices it
    // inline before </body> (the same position the DOM path appends it)
    // and the slow walk isn't needed for the channel at all. A stale or
    // absent cache still bails so injectJsInjectorChannel + the walk
    // refresh it. Killswitch (jsiChannelDisabled) keeps the fast path on
    // with no channel at all.
    var jsiInlineTag = null;
    if (!jsiChannelDisabled() && html.indexOf(jsiChannelPath()) < 0) {
      var jsiBody = jsiChannelCacheGet();
      if (jsiBody == null) return bail("jsiChannel");
      // A "</script" literal inside a snippet body would terminate the
      // spliced inline tag and corrupt the document (same guard as the
      // bundle path). The DOM path tolerates such a body via textContent;
      // only the string splice can't.
      if (jsiBody.indexOf("</script") >= 0)
        return bail("jsiChannelScriptClose");
      jsiInlineTag =
        '<script data-shell-jsi-channel="1" data-shell-jsi-cached="1">' +
        jsiBody +
        "</script>";
      try {
        window.__shellJsiChannelCache = "hit";
      } catch (_) {}
    }
    var headIdx = html.indexOf("<head>");
    if (headIdx < 0) return bail("noHead");
    // Bundle precheck: only legal fast-path verdicts are
    //   (a) no main.*.bundle.js src in HTML (modern server layout)
    //   (b) URL match + !needsPatch (leave src=, browser HTTP-cache hit)
    //   (c) URL match + needsPatch + body cached (inline replace)
    var bundleMatch = BUNDLE_FAST_RE.exec(html);
    var inlineBundleBody = null;
    var bundleUrl = null;
    var cachedPatches = 0;
    if (bundleMatch) {
      try {
        bundleUrl = new URL(bundleMatch[1], baseUrl).href;
      } catch (_) {
        return bail("bundleUrlParse");
      }
      var cache = readBundlePatchState();
      if (!cache || cache.url !== bundleUrl) return bail("bundleCacheMiss");
      // JEL-1980: inline body whenever present (raw or patched).
      // needsPatch=false + body present is the dominant Chromium 69
      // path; previously fell through to <script src> reliance on
      // HTTP cache.
      if (cache.body) {
        inlineBundleBody = cache.body;
        cachedPatches =
          cache.needsPatch &&
          typeof cache.patches === "number" &&
          cache.patches > 0
            ? cache.patches
            : 0;
        // Defensive: a </script> literal in the body would terminate
        // the inline <script>. Minified bundles never contain that
        // sequence, but bail rather than corrupt the document.
        if (inlineBundleBody.indexOf("</script") >= 0)
          return bail("bundleScriptClose");
      } else if (cache.needsPatch) {
        return bail("bundleBodyMissing");
      }
    }
    // Pre-seed diag init counters that the DOMParser path also sets
    // before document.write. The fast path skips transpileLegacyScripts
    // entirely, so those counts stay zero (HUD reflects "no walk ran").
    window.__shellDiagInit = window.__shellDiagInit || {};
    window.__shellDiagInit.legacy = true;
    window.__shellDiagInit.babel = typeof window.Babel !== "undefined";
    window.__shellDiagInit.polyfilled = true;
    // Build head injection. Order mirrors the DOMParser path:
    // diag → base → seed → polyfill, inserted immediately after <head>.
    var diagBody = buildDiagSeedScript("__SHELL_VER__");
    var seedBody = buildSeedScript(serverUrl, upstreamCfg);
    var polyBody = chromium56PolyfillBody();
    // JEL-1971: beacon body comes last so it picks up the seed-installed
    // ApiClient / credentials before its first tick. Inert when the build
    // step left the placeholder in place (unbuilt dev load).
    var beaconBody = qaBeaconBody();
    var beaconTag =
      beaconBody && beaconBody !== "__QA_BEACON_BODY__"
        ? '<script data-shell-beacon="1">' + beaconBody + "</script>"
        : "";
    // JEL-126: fast path is legacy-only by construction (bailed "modern"
    // above), so the boot progress dots are always spliced here.
    var progressTag =
      '<script data-shell-boot-progress="1">' +
      bootProgressBody() +
      "</script>";
    // JEL-647: instant-home overlay must survive the fast path too — the
    // widget-document copy's timers may not outlive document.open, so the
    // written document always carries its own copy (generation counter in
    // the body makes the duplicate injection idempotent).
    var instantHomeTag =
      '<script data-shell-instant-home="1">' + instantHomeBody() + "</script>";
    // JELA-29: opt-in Direct-Home prototype (no-op unless directHome=1).
    var directHomeTag =
      '<script data-shell-direct-home="1">' + directHomeBody() + "</script>";
    // JELA-30: boot-ring diag beacon (JELA-827: opt-OUT) (no-op when diagBeacon==='0').
    var diagBeaconTag =
      '<script data-shell-diag-beacon="1">' +
      diagBeaconPostBody() +
      "</script>";
    var injected =
      '<script data-shell-diag="1">' +
      diagBody +
      "</script>" +
      '<base href="' +
      escAttr(baseUrl) +
      '">' +
      '<script data-shell-seed="1">' +
      seedBody +
      "</script>" +
      '<script data-shell-polyfill="1">' +
      polyBody +
      "</script>" +
      beaconTag +
      progressTag +
      instantHomeTag +
      directHomeTag +
      diagBeaconTag;
    var insertAt = headIdx + 6;
    var patched = html.slice(0, insertAt) + injected + html.slice(insertAt);
    // Init bundle counters so HUD reads consistent values whether or
    // not the bundle path ran.
    window.__shellBundlePatches = window.__shellBundlePatches || 0;
    window.__shellBundlesScanned = window.__shellBundlesScanned || 0;
    window.__shellBundlesPatchedFiles = window.__shellBundlesPatchedFiles || [];
    window.__shellBundleHits = window.__shellBundleHits || 0;
    window.__shellBundleCacheHit = window.__shellBundleCacheHit || 0;
    window.__shellBundleCacheBodyHit = window.__shellBundleCacheBodyHit || 0;
    window.__shellBundlePatchSkipped = window.__shellBundlePatchSkipped || 0;
    if (inlineBundleBody) {
      var replaced = false;
      patched = patched.replace(BUNDLE_FAST_RE, function (m) {
        if (replaced) return m;
        replaced = true;
        return (
          '<script data-shell-bundle-patched="' +
          escAttr(bundleUrl) +
          '" data-shell-bundle-from-cache="1" data-shell-bundle-patches="' +
          cachedPatches +
          '">' +
          inlineBundleBody +
          "</script>"
        );
      });
      if (!replaced) return bail("bundleReplaceFail");
      if (cachedPatches > 0) window.__shellBundlePatches += cachedPatches;
      window.__shellBundleCacheHit++;
      window.__shellBundleCacheBodyHit++;
      window.__shellBundlesPatchedFiles.push("fastpath:cache" + cachedPatches);
      // JEL-1980: fast-path body-cache adoption — main.jellyfin
      // .bundle.js inlined, post-document.write <script src> fetch
      // skipped entirely.
      window.__shellMainBundleLSAdopted = 1;
      window.__shellMainBundleInlineHits =
        (window.__shellMainBundleInlineHits || 0) + 1;
      window.__shellMainBundleLSBytes = inlineBundleBody.length;
    } else if (bundleMatch) {
      // Body cache empty (quota fallback / first boot post-upgrade):
      // browser fetches via <script src> from HTTP cache, same as
      // patchPlaybackBundles' window.__shellBundleCacheHit branch.
      window.__shellBundleCacheHit++;
    }
    // JEL-618: splice the cached channel body in last, immediately before
    // </body> — after the bundle replace so its position mirrors the DOM
    // path's body.appendChild ordering (channel executes after bundles).
    if (jsiInlineTag) {
      var jsiAt = patched.lastIndexOf("</body>");
      if (jsiAt < 0) return bail("jsiChannelNoBody");
      patched = patched.slice(0, jsiAt) + jsiInlineTag + patched.slice(jsiAt);
    }
    window.__shellFastPathHits++;
    return patched;
  }

  // JEL-1974 (v68): stamp `tDocumentWrite` into window.__qaMarks and
  // flush to localStorage just before document.open replaces the shell
  // document. The new /web/ document inherits localStorage; the QA
  // beacon (qa-beacon.js, injected via injectQaBeacon) reads
  // jellyfin.qa.bootMarks.prior on first POST and emits the previous
  // boot's full span set as payload.priorBootMarks.
  //@@SHELL_CORE:markDocumentWrite@@

  function restoreCredsVault() {
    // JEL-134 (JEL-132 v2): boot-time restore from the IndexedDB creds
    // vault. A hard TV restart rolls localStorage back to the last durable
    // commit (on-device evidence: 76 -> 16 keys), destroying a
    // freshly-saved login token; the seed's creds-guard mirrors tokened
    // jellyfin_credentials writes into IDB (durable across power cuts).
    // This runs in the async pre-rewrite boot path — gated into the
    // document.write Promise.all — so jellyfin-web always boots against
    // the restored creds. Policy:
    //   - no-op when localStorage already holds any AccessToken, when the
    //     vault is tokenless/absent, when enableAutoLogin === "false", or
    //     when the shared kill switch jellyfin.shell.credsGuardDisabled=1;
    //   - merge by server Id (a vaulted token never attaches to a
    //     different server); creds key absent entirely -> restore whole
    //     vault value (the observed post-rollback state);
    //   - records trail event {e:"restore"} + window.__shellCredsRestored.
    // No restore loop: a restored token the next validate 401s gets
    // stripped (guard allows legit clears) AND that strip syncs the vault
    // tokenless, so the next boot has nothing to restore.
    // Always resolves (never rejects, 3 s bound) so a wedged IndexedDB
    // cannot stall boot. Token values never logged.
    return new Promise(function (resolve) {
      var done = false;
      function fin() {
        if (!done) {
          done = true;
          resolve();
        }
      }
      setTimeout(fin, 3000);
      try {
        if (
          localStorage.getItem("jellyfin.shell.credsGuardDisabled") === "1" ||
          localStorage.getItem("enableAutoLogin") === "false"
        )
          return fin();
        var CK = "jellyfin_credentials";
        var cur = null;
        try {
          cur = localStorage.getItem(CK);
        } catch (_) {}
        var curJ = null;
        var curT = 0;
        try {
          curJ = cur == null ? null : JSON.parse(cur);
          var sv = (curJ && curJ.Servers) || [];
          for (var i = 0; i < sv.length; i++)
            if (sv[i] && sv[i].AccessToken) curT++;
        } catch (_) {
          curJ = null;
        }
        if (curT > 0) return fin();
        var rq = indexedDB.open("jellyfin_shell", 1);
        rq.onupgradeneeded = function () {
          try {
            rq.result.createObjectStore("kv");
          } catch (_) {}
        };
        rq.onerror = fin;
        rq.onsuccess = function () {
          var db = rq.result;
          function settle() {
            try {
              db.close();
            } catch (_) {}
            fin();
          }
          try {
            var get = db
              .transaction("kv", "readonly")
              .objectStore("kv")
              .get("credsBackup");
            get.onerror = settle;
            get.onsuccess = function () {
              try {
                var rec = get.result;
                if (rec && rec.t > 0 && typeof rec.v === "string") {
                  var next = null;
                  var vj = JSON.parse(rec.v);
                  var vsv = (vj && vj.Servers) || [];
                  if (curJ && curJ.Servers && curJ.Servers.length) {
                    var m = {};
                    var hit = 0;
                    var k;
                    for (k = 0; k < vsv.length; k++)
                      if (vsv[k] && vsv[k].Id && vsv[k].AccessToken)
                        m[vsv[k].Id] = vsv[k];
                    for (k = 0; k < curJ.Servers.length; k++) {
                      var s = curJ.Servers[k];
                      if (s && s.Id && !s.AccessToken && m[s.Id]) {
                        s.AccessToken = m[s.Id].AccessToken;
                        if (!s.UserId && m[s.Id].UserId)
                          s.UserId = m[s.Id].UserId;
                        hit++;
                      }
                    }
                    if (hit) next = JSON.stringify(curJ);
                  } else if (vsv.length) {
                    next = rec.v;
                  }
                  if (next != null) {
                    localStorage.setItem(CK, next);
                    window.__shellCredsRestored =
                      (window.__shellCredsRestored || 0) + 1;
                    try {
                      var TRK = "jellyfin.shell.credsTrail";
                      var r;
                      try {
                        r = JSON.parse(localStorage.getItem(TRK) || "[]");
                      } catch (_) {
                        r = null;
                      }
                      if (!r || !r.push) r = [];
                      r.push({ e: "restore", ts: Date.now(), t: rec.t });
                      while (r.length > 8) r.shift();
                      localStorage.setItem(TRK, JSON.stringify(r));
                    } catch (_) {}
                  }
                }
              } catch (_) {}
              settle();
            };
          } catch (_) {
            settle();
          }
        };
      } catch (_) {
        fin();
      }
    });
  }
  // ---- JellyPlug Lite (JELA-67) ------------------------------------------
  //
  // Netflix-style canvas home: ~12 KB of purpose-built ES5
  // (packages/jellyplug-lite, served by the server plugin at
  // /shell/lite.min.js) draws the home rows on a single <canvas> — the
  // multi-MB jellyfin-web SPA never parses on the boot path. Strictly
  // opt-in per TV: localStorage["jellyfin.shell.liteEnabled"]="1" (default
  // OFF); any miss/failure falls through to the normal SPA boot unchanged.
  //
  // Delivery is the JELA-66 byte-cache shape: the blob rides a sha-keyed
  // localStorage record (jellyfin.lite.body = {v,sha,len,h,ts,body};
  // h = txFnv1a corruption check, sha = the manifest's liteSha256 the
  // bytes were fetched under) and boots from LS with ZERO Lite network on
  // the critical path. A background revalidate compares rec.sha against
  // the live manifest and restocks for the NEXT boot — stale-one-boot by
  // design, the same SWR stance as the HSB shell cache. The first flagged
  // boot has no record: the SPA boots as today while the restock chain
  // fills the cache, so Lite appears from boot 2 on.
  //
  // The restock chain schedules every attempt on window-level timers
  // (JELA-66 v2.0.23 lesson: the SPA handoff's document.open ABORTS this
  // document's in-flight fetches — a timer re-issued fetch survives).
  //
  // Diag: window.__shellLite = {st, sha, ms, restock, warm, bgwarm,
  // bgwarmMs, native} with st one of
  // off|miss|exec-err|no-session|live|handoff.
  // QA recipe: st==="live" and no /web/ traffic on the critical path;
  // ~4s after settle the M2 pre-warm fetches /web/index.html+config.json
  // into __shellPrefetch (warm=1, reset to 0 when the slot clears) so
  // OK/Back/Red hand off without paying that RTT pair; after ~5s of
  // remote-input idle the bg-warm boots the full SPA once in a hidden
  // iframe (bgwarm: warming->warm->done) so the handoff's document.write
  // boot hits warm HTTP/code caches. OK on a card deep-links the SPA to
  // #/details?id=…&serverId=… while the canvas shows an "Opening…"
  // overlay until document.write clears it.
  //
  // M3 (docs/lite-m3-avplay-design.md): a second opt-in flag,
  // localStorage["jellyfin.lite.native"]="1" (default OFF), forks OK on
  // a card to the lite bytes' native AVPlay path (app.openNative) BEFORE
  // the SPA deep-link. openNative returning true means the native
  // pipeline took the press (d.native counts the takes, st stays
  // "live" — Lite home remains resident under the video plane); false,
  // a throw, or old cached bytes without openNative fall through to the
  // deep-link below unchanged, so the worst case is exactly the M2
  // behaviour. Both flags dark fleet-wide until the v2.0.25 widget
  // (avplay privilege + webapis.js include) is on the panels.
  var LITE_FLAG_KEY = "jellyfin.shell.liteEnabled";
  var LITE_NATIVE_FLAG_KEY = "jellyfin.lite.native";
  // JELA-152: consumed by the lite bytes (Lite.subsEnabled), listed here so
  // the JELA-141 defaults filter below recognizes it on the wire.
  var LITE_SUBS_FLAG_KEY = "jellyfin.lite.subs";
  var LITE_REC_KEY = "jellyfin.lite.body";
  // JELA-141 (C5/WS-5): fleet flag defaults. The manifest's additive
  // `flagDefaults` map ({"jellyfin.shell.liteEnabled":"1", ...}) is cached
  // one boot behind (stale-one-boot, the Lite byte-cache contract) and
  // consulted ONLY when the device has no explicit value for a key —
  // explicit "1"/"0" always wins, so QA opt-ins and per-device kills
  // survive fleet flips. Adoption rides liteRestock's per-boot manifest
  // fetch when Lite runs (that is the fleet KILL path: default revoked ->
  // next boot is SPA again) plus one deferred post-settle fetch when it
  // does not (the turn-ON path, off the boot path by construction). A
  // reachable manifest WITHOUT the field clears the cache — rolling the
  // server plugin back to a version predating flagDefaults is itself a
  // working kill switch — while an unreachable manifest keeps it, so
  // offline boots keep their behavior. QA surface: window.__shellLiteDef.
  var LITE_DEFAULTS_KEY = "jellyfin.shell.flagDefaults";
  // Distinct from every bg-warm delay (5000/20000/45000) so timer-driven QA
  // can address it unambiguously; past the 13.4-15.8s SPA settle window.
  var LITE_DEFAULTS_SYNC_MS = 25000;
  var LITE_RESTOCK_MS = [0, 12000, 30000];
  // M2 handoff pre-warm: fire after Lite settles (off the boot path),
  // expire so a long-lived Lite session never adopts a stale index.html.
  var LITE_WARM_MS = 4000;
  var LITE_WARM_TTL_MS = 600000;
  // M2 bg-warm (JELA-67 jank spike on the Q60R M63): a hidden-iframe
  // /web/ warm costs ~4-5s of cumulative main-thread stall in a ~7s
  // window, so warm-on-boot was REJECTED — the warm may start only after
  // this much remote-input idle (any keydown re-arms the countdown) and
  // runs once per boot. The iframe is dropped after a post-load linger
  // (the payoff is the warmed HTTP/code caches, not the live document)
  // and abandoned outright if a wedged server never fires load.
  var LITE_BGWARM_IDLE_MS = 5000;
  var LITE_BGWARM_LINGER_MS = 20000;
  var LITE_BGWARM_TIMEOUT_MS = 45000;
  // Boot-scoped defaults map (null until liteDefaultsInit ran, or when the
  // cached record is absent/invalid/for another server). Refreshed in place
  // by a same-boot adopt so a fleet kill takes effect on the NEXT OK, not
  // just the next boot.
  var liteDefaults = null;
  function liteDefaultsInit(serverUrl) {
    liteDefaults = null;
    var d = (window.__shellLiteDef = { st: "none" });
    try {
      var rec = JSON.parse(localStorage.getItem(LITE_DEFAULTS_KEY));
      if (
        rec &&
        rec.v === 1 &&
        rec.o === serverUrl &&
        rec.f &&
        typeof rec.f === "object"
      ) {
        liteDefaults = rec.f;
        d.st = "cached";
        d.f = rec.f;
      }
    } catch (_) {}
  }
  function liteAdoptDefaults(m, serverUrl) {
    // Feed any freshly-fetched manifest object here; a failed fetch
    // (m == null) never touches the cache. Only the three known keys are
    // accepted, values coerced to "0"/"1" — a compromised or garbled map
    // can flip Lite flags and nothing else.
    if (!m) return;
    var d = window.__shellLiteDef || (window.__shellLiteDef = {});
    try {
      var fd = m.flagDefaults;
      if (!fd || typeof fd !== "object") {
        localStorage.removeItem(LITE_DEFAULTS_KEY);
        liteDefaults = null;
        d.st = "cleared";
        d.f = null;
        return;
      }
      var keys = [LITE_FLAG_KEY, LITE_NATIVE_FLAG_KEY, LITE_SUBS_FLAG_KEY];
      var f = {};
      for (var i = 0; i < keys.length; i++) {
        if (fd[keys[i]] !== undefined) {
          f[keys[i]] = String(fd[keys[i]]) === "1" ? "1" : "0";
        }
      }
      localStorage.setItem(
        LITE_DEFAULTS_KEY,
        JSON.stringify({ v: 1, o: serverUrl, f: f, ts: +new Date() }),
      );
      liteDefaults = f;
      d.st = "adopted";
      d.f = f;
    } catch (_) {}
  }
  function liteDefaultsSyncSoon(serverUrl) {
    // The turn-ON half of the JELA-141 contract: when Lite is NOT running,
    // no liteRestock manifest fetch happens, so one deferred read per boot
    // keeps the cached defaults tracking the server. Parked well past SPA
    // settle so the ~1 KB GET never competes with the boot path.
    if (window.__shellLiteDefSync) return;
    window.__shellLiteDefSync = 1;
    setTimeout(function () {
      try {
        fetch(serverUrl + "/shell/manifest.json?__fd=" + Date.now(), {
          credentials: "omit",
          cache: "no-store",
        })
          .then(function (r) {
            return r && r.ok ? r.json() : null;
          })
          .then(function (m) {
            liteAdoptDefaults(m, serverUrl);
          })
          .catch(function () {});
      } catch (_) {}
    }, LITE_DEFAULTS_SYNC_MS);
  }
  function liteFlagWanted(key) {
    // Precedence: explicit device-local "1"/"0" -> that; anything else ->
    // the fleet default cached from the manifest (absent record = off).
    // Unreadable storage stays hard-off, matching the pre-JELA-141 shape.
    var v = null;
    try {
      v = localStorage.getItem(key);
    } catch (_) {
      return false;
    }
    if (v === "1") return true;
    if (v === "0") return false;
    return !!liteDefaults && liteDefaults[key] === "1";
  }
  function liteWanted() {
    return liteFlagWanted(LITE_FLAG_KEY);
  }
  function liteNativeWanted() {
    return liteFlagWanted(LITE_NATIVE_FLAG_KEY);
  }
  function liteReadRec() {
    try {
      var rec = JSON.parse(localStorage.getItem(LITE_REC_KEY));
      if (!rec || rec.v !== 1 || !rec.sha || typeof rec.body !== "string") {
        return null;
      }
      if (rec.body.length !== rec.len || txFnv1a(rec.body) !== rec.h) {
        return null;
      }
      return rec;
    } catch (_) {
      return null;
    }
  }
  function liteRestock(serverUrl, haveSha) {
    if (window.__shellLitePending) return;
    window.__shellLitePending = 1;
    var attempt = 0;
    function note(s) {
      try {
        if (window.__shellLite) window.__shellLite.restock = s;
      } catch (_) {}
    }
    function fail(why) {
      attempt++;
      if (attempt >= LITE_RESTOCK_MS.length) {
        note("failed:" + why);
        window.__shellLitePending = 0;
        return;
      }
      note("retry" + attempt + ":" + why);
      setTimeout(run, LITE_RESTOCK_MS[attempt]);
    }
    function run() {
      fetch(serverUrl + "/shell/manifest.json?__lt=" + Date.now(), {
        credentials: "omit",
        cache: "no-store",
      })
        .then(function (r) {
          return r && r.ok ? r.json() : null;
        })
        .then(function (m) {
          // JELA-141: every restock manifest read also refreshes the fleet
          // flag defaults — with Lite running this is the fetch that lands
          // a fleet kill (or a native/subs flip) for the next boot.
          liteAdoptDefaults(m, serverUrl);
          var sha = m && m.liteSha256;
          if (!sha || sha === haveSha) {
            // Up to date, or the server plugin predates Lite — stop quietly.
            note(sha ? "fresh" : "no-lite");
            window.__shellLitePending = 0;
            return null;
          }
          return fetch(serverUrl + "/shell/lite.min.js?v=" + sha, {
            credentials: "omit",
          })
            .then(function (r2) {
              if (!r2 || !r2.ok) throw new Error("http");
              return r2.text();
            })
            .then(function (body) {
              try {
                localStorage.setItem(
                  LITE_REC_KEY,
                  JSON.stringify({
                    v: 1,
                    sha: sha,
                    len: body.length,
                    h: txFnv1a(body),
                    ts: +new Date(),
                    body: body,
                  }),
                );
                note("stored b=" + body.length);
              } catch (_) {
                note("failed:setitem");
              }
              window.__shellLitePending = 0;
              return null;
            });
        })
        .catch(function () {
          fail("net");
        });
    }
    setTimeout(run, LITE_RESTOCK_MS[0]);
  }
  function maybeBootLite(serverUrl) {
    liteDefaultsInit(serverUrl);
    if (!liteWanted() || window.__shellLiteHandled) {
      // SPA boot (flag off, or post-handoff re-entry): keep the cached
      // defaults tracking the server with one deferred manifest read.
      liteDefaultsSyncSoon(serverUrl);
      return false;
    }
    var d = (window.__shellLite = { st: "off" });
    var rec = liteReadRec();
    if (!rec) {
      d.st = "miss";
      liteRestock(serverUrl, null);
      return false;
    }
    var app = null;
    try {
      if (!window.JellyPlugLite) {
        new Function(rec.body)();
      }
      var L = window.JellyPlugLite;
      app = L && L.boot ? L.boot(window, document) : null;
    } catch (_) {
      d.st = "exec-err";
      // The cached bytes are proven bad on THIS engine — restock with
      // haveSha=null so the chain replaces them even though rec.sha still
      // matches what it fetched them under. Without this a TV that cached
      // a bad blob was stuck on exec-err every boot (found live on the
      // Q60R when the pre-es5-target build cached its catch{} blob).
      liteRestock(serverUrl, null);
      return false;
    }
    if (!app) {
      // No stored session — the SPA owns login; Lite re-engages next boot.
      // Still revalidate so the cache tracks the server while logged out.
      d.st = "no-session";
      liteRestock(serverUrl, rec.sha);
      return false;
    }
    window.__shellLiteHandled = 1;
    d.st = "live";
    d.sha = rec.sha;
    d.ms = +new Date() - (window.__shellT0 || 0);
    d.app = app; // exposed for CDP key-nav counter QA
    // The widget-document instant-home snapshot (injected by bootstrap()
    // before this ran) would sit above the canvas and its input shield
    // would eat the remote keys — dismiss it exactly like a settle would.
    try {
      var ih = document.getElementById("__shell_instant_home");
      if (ih && ih.parentNode) ih.parentNode.removeChild(ih);
      var g = window.__shellIH;
      if (g && !g.dismissed) {
        g.dismissed = 1;
        g.why = "lite";
      }
    } catch (_) {}
    // M2 bg-warm plumbing shared with toSpa below: the warm iframe and
    // its pending timer die the moment a handoff starts, so the SPA boot
    // never competes with its own warm-up for the single M63 main thread.
    var bgw = { fr: null, t: 0, arm: null };
    var bgwKill = function (why) {
      try {
        if (bgw.arm) {
          document.removeEventListener("keydown", bgw.arm, true);
          bgw.arm = null;
        }
        if (bgw.t) {
          clearTimeout(bgw.t);
          bgw.t = 0;
        }
        if (bgw.fr) {
          if (bgw.fr.parentNode) bgw.fr.parentNode.removeChild(bgw.fr);
          bgw.fr = null;
          if (why) d.bgwarm = why;
        }
      } catch (_) {}
    };
    var toSpa = function (hash, msg) {
      if (d.st === "handoff") return;
      d.st = "handoff";
      bgwKill(null);
      // M2 deep link: set the SPA route BEFORE the client loads. Hash
      // routing survives the document.write teardown (same-document URL
      // mutation), so the SPA router boots straight to the target
      // instead of #/home. No hash = the normal home boot.
      if (hash) {
        try {
          window.location.hash = hash;
        } catch (_) {}
      }
      try {
        // Slice-4+ lite bytes keep the canvas up with an "Opening…"
        // overlay until document.write clears it (no black screen while
        // the SPA loads); older cached bytes only have destroy().
        if (app.handoff) {
          app.handoff(msg);
        } else {
          app.destroy();
        }
      } catch (_) {
        try {
          app.destroy();
        } catch (_2) {}
      }
      // __shellLiteHandled stays set: this loadRemoteWebClient run takes
      // the normal SPA path.
      loadRemoteWebClient(serverUrl).catch(function () {});
    };
    app.onOpen = function (item) {
      // M3 native fork (design doc §1), flag-dark behind
      // jellyfin.lite.native: when the lite bytes' native path takes
      // the OK (openNative === true) the SPA never loads — Lite home
      // stays resident and the AVPlay plane plays under it. ANY other
      // outcome (decline, throw, old cached bytes without openNative)
      // falls through to the M2 deep-link unchanged.
      if (liteNativeWanted() && app.openNative && d.st !== "handoff") {
        var took = false;
        try {
          took = app.openNative(item) === true;
        } catch (_) {
          took = false;
        }
        if (took) {
          d.native = (d.native || 0) + 1;
          return;
        }
      }
      // OK on a card deep-links into the SPA at the item's details page
      // (Play is the default focus there); OK on nothing = generic
      // handoff, same as Back.
      var id = item && item.id;
      var sid = app.serverId;
      toSpa(
        id
          ? "#/details?id=" +
              encodeURIComponent(id) +
              (sid ? "&serverId=" + encodeURIComponent(sid) : "")
          : null,
        item && item.name ? "Opening " + item.name + "…" : null,
      );
    };
    app.onBack = function () {
      toSpa(null, null);
    };
    app.onMenu = function () {
      // menu-key SPA escape hatch (search/settings/admin)
      toSpa(null, null);
    };
    liteRestock(serverUrl, rec.sha);
    // M2 pre-warm: populate the same __shellPrefetch slot the head-IIFE
    // fills, so a later handoff ADOPTS an already-resolved /web/ RTT
    // pair (mkIdxF/mkCfgF) instead of paying it live. Off the boot path
    // (timer), skipped when the head prefetch is still unconsumed, and
    // TTL-capped so an hours-long Lite session can't hand a stale
    // index.html to the SPA boot. A failed warm clears the slot so the
    // handoff falls back to a fresh fetch instead of adopting a
    // rejected promise.
    setTimeout(function () {
      try {
        if (window.__shellPrefetch) return;
        var wb = serverUrl + "/web/";
        var pf = {
          baseUrl: wb,
          index: fetch(wb + "index.html", { credentials: "omit" }),
          config: fetch(wb + "config.json", { credentials: "omit" }),
        };
        var clear = function () {
          if (window.__shellPrefetch === pf) {
            window.__shellPrefetch = null;
            // A cleared slot means a dead warm (fetch failed or TTL
            // expired) — flip the diag back so QA never reads warm=1
            // against an empty slot (PR #116 review nit).
            d.warm = 0;
          }
        };
        pf.index.catch(clear);
        pf.config.catch(clear);
        window.__shellPrefetch = pf;
        d.warm = 1;
        setTimeout(clear, LITE_WARM_TTL_MS);
      } catch (_) {}
    }, LITE_WARM_MS);
    // M2 bg-warm: boot the full SPA once in a hidden iframe so the later
    // handoff's document.write boot hits warm HTTP/code caches instead of
    // cold ones. Idle-deferred per the jank-spike verdict: the warm costs
    // ~4-5s of main-thread stall on the M63, so it kicks only after
    // LITE_BGWARM_IDLE_MS with no remote input — every keydown re-arms
    // the countdown, and a handoff first (or one earlier this boot)
    // cancels it entirely.
    var bgwKick = function () {
      bgw.t = 0;
      // JELA-137: a live native AVPlay session owns the single M63 main
      // thread — the iframe warm mid-movie stalled the webview ~4-5s
      // (one M3 G1 inflated to 4.1s). While the lite bytes report a
      // non-terminal player state, DEFER: poll again after another idle
      // window without consuming the once-per-boot latch or the keydown
      // re-arm listener. Old lite bytes never set d.player → unchanged.
      var pl = d.player;
      if (pl && pl.st && pl.st !== "closed" && pl.st !== "err") {
        d.bgwarm = "defer-native";
        bgw.t = setTimeout(bgwKick, LITE_BGWARM_IDLE_MS);
        return;
      }
      if (bgw.arm) {
        document.removeEventListener("keydown", bgw.arm, true);
        bgw.arm = null;
      }
      if (window.__shellLiteBgWarm || d.st === "handoff") return;
      window.__shellLiteBgWarm = 1;
      var t0 = +new Date();
      try {
        var fr = document.createElement("iframe");
        // The exact geometry the jank spike measured: hidden 1280x720 so
        // the SPA lays out at TV size and pulls the same lazy chunks and
        // images a real boot would, all landing in cache.
        fr.setAttribute(
          "style",
          "position:absolute;left:0;top:0;width:1280px;height:720px;" +
            "visibility:hidden;pointer-events:none;border:0;",
        );
        fr.onload = function () {
          if (bgw.fr !== fr) return;
          d.bgwarm = "warm";
          d.bgwarmMs = +new Date() - t0;
          if (bgw.t) clearTimeout(bgw.t);
          // Linger past load so the SPA finishes its lazy chunk + skin
          // fetches, then drop the live document — an evening-long Lite
          // session must not carry a whole SPA in memory when the warmed
          // caches are the only part the handoff reuses.
          bgw.t = setTimeout(function () {
            bgwKill("done");
          }, LITE_BGWARM_LINGER_MS);
        };
        fr.src = serverUrl + "/web/index.html";
        bgw.fr = fr;
        document.body.appendChild(fr);
        d.bgwarm = "warming";
        // An unreachable or wedged server never fires load — abandon the
        // iframe rather than keep a half-loading SPA alive all session.
        bgw.t = setTimeout(function () {
          bgwKill("timeout");
        }, LITE_BGWARM_TIMEOUT_MS);
      } catch (_) {
        d.bgwarm = "err";
      }
    };
    bgw.arm = function () {
      if (bgw.t) clearTimeout(bgw.t);
      bgw.t = setTimeout(bgwKick, LITE_BGWARM_IDLE_MS);
    };
    try {
      document.addEventListener("keydown", bgw.arm, true);
      bgw.arm();
    } catch (_) {}
    return true;
  }
  // JELA-710: Google Fonts UA-sniffs the Tizen UA to TrueType (771 KiB of
  // font bytes per boot for an M63 engine that has read WOFF2 since Chrome
  // 36), and the chain starts in markup we document.write: the Media Bar
  // plugin pins slideshowpure.css on cdn.jsdelivr.net in the server's
  // /web/index.html, and that stylesheet's first line @imports Archivo
  // Narrow from fonts.googleapis.com — render-blocking, across serial
  // third-party origins. The server plugin self-hosts a patched copy (local
  // woff2 @font-face in place of the @import) under /shell/fonts/, so point
  // the <link> there before either write path parses the markup.
  //
  // String-level on purpose: it has to cover both the JEL-1832 string fast
  // path and the DOMParser path, and it runs AFTER the localStorage index
  // cache is read, so the cached markup stays pristine upstream bytes.
  // The Inter/Sora half of the boot's font pull lives in the JS-Injector
  // theme-css entry and is repointed there (jsi-jp710-patch.mjs), not here.
  //
  // Kill switch: localStorage["jellyfin.shell.selfFontsDisabled"]="1"
  // restores the stock jsdelivr/Google chain — also the escape hatch if the
  // plugin serving this shell somehow predates /shell/fonts/ (that mismatch
  // otherwise costs the media-bar skin its stylesheet, not the boot).
  function rewriteFontThirdPartyCss(html, serverUrl) {
    try {
      if (localStorage.getItem("jellyfin.shell.selfFontsDisabled") === "1") {
        return html;
      }
    } catch (_) {}
    try {
      return String(html).replace(
        /https:\/\/cdn\.jsdelivr\.net\/[^"' ]*slideshowpure[^"' ]*\.css/g,
        String(serverUrl).replace(/\/+$/, "") +
          "/shell/fonts/mediabar-slideshowpure.css",
      );
    } catch (_) {
      return html;
    }
  }
  // JELA-707 (JELA-699 follow-up): defer the JellyfinEnhanced injection until
  // after firstCard. JELA-699 ring A on the calibrated JELA-690 harness
  // measured blocking JE's script injection at firstCard −3,340 ms
  // [−4,589, −2,338], p=0.0024 (−41.7%) — the JE fan-out (197 requests /
  // 3.2 MB on the capture that sized it) contends with the boot's own
  // request burst, and boot latency tracks in-flight REQUEST COUNT
  // (TTFB 194 ms below 25 concurrent → 2,789 ms at 125-149), so moving the
  // fan-out off the pre-paint window is the lever. Do NOT remove JE — hold
  // it: strip its <script src> tag(s) out of the fetched /web/index.html
  // string before either write path parses the markup (same choke point as
  // rewriteFontThirdPartyCss above — covers the JEL-1832 string fast path
  // AND the DOMParser path, and runs after the index cache read so cached
  // markup stays pristine), park the stripped URLs on
  // window.__shellJeDefer (Window survives the document.write handoff),
  // and let the seed's paint-gated re-injector (see buildSeedScript) put
  // them back once __shellPaintGate.onPaint fires. The re-injected tags
  // flow through the JEL-406/407 dynamic-script interceptors, so legacy
  // engines still get the same transpile + JEL-557 cache treatment as the
  // static walk. Nothing on the boot-to-home path consumes JE: its
  // features (card tags, jellyseerr rows, shortcuts) decorate the home
  // AFTER render, and JE's own loader already waits for auth before its
  // module fan-out — deferring to paint+delay moves that start by seconds,
  // not the features' existence.
  //
  // JELA-821: the gate is opt-OUT, not opt-in. It shipped opt-in and the
  // jp773 channel seed of "jellyfin.shell.deferJe"="1" arms ONE BOOT LATE —
  // the JSI channel only runs after the lite->SPA handoff (JELA-802), while
  // this read site runs on the boot BEFORE it. So any boot that starts with
  // the key absent — a first install, a re-install, any localStorage
  // eviction — read null !== "1" and paid the whole JE module storm
  // pre-paint (measured 152 modules / 670,857 B, 36% of a cold boot's
  // requests, in 9/9 valid boots across two rigs; JELA-813/819). Reading for
  // the "0" kill switch instead changes behaviour ONLY on those boots: the
  // fleet seed is already "1", and an explicit "0" still opts a device out.
  // A throwing localStorage now defers as well (same shape as
  // stripDeadMediaBarJs below) — unreadable storage is exactly the case the
  // fleet default is meant to cover. Adding the key to liteAdoptDefaults'
  // flagDefaults whitelist would NOT fix this: that map is itself cached one
  // boot behind (LITE_DEFAULTS_KEY is stale-one-boot by contract), so it is
  // absent on a true first boot too.
  //
  // Kill switch: localStorage["jellyfin.shell.deferJe"]="0" restores the
  // stock pre-paint injection (post-paint delay still tunable via
  // "jellyfin.shell.deferJeMs", default 3000).
  // Diag/counter (perf-protocol rule 4 — the ring's ON arm must prove the
  // lever fired): window.__shellJeDefer = {on,held,urls,rel,inj,tRel,tInj}.
  function stripJeScriptsForDefer(html) {
    try {
      if (localStorage.getItem("jellyfin.shell.deferJe") === "0") return html;
    } catch (_) {}
    var d = (window.__shellJeDefer = {
      on: 1,
      held: 0,
      urls: [],
      rel: 0,
      inj: 0,
      tRel: 0,
      tInj: 0,
    });
    try {
      var out = String(html).replace(
        /<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["'][^>]*>\s*<\/script>/gi,
        function (tag, src) {
          if (!/jellyfinenhanced|jellyfin-enhanced/i.test(src)) return tag;
          d.held++;
          d.urls.push(src);
          return "";
        },
      );
      return d.held ? out : html;
    } catch (_) {
      return html;
    }
  }
  // JELA-716: the Media Bar plugin pins slideshowpure.js on cdn.jsdelivr.net
  // in the server's /web/index.html, and that copy carries 13 optional-chaining
  // sites — on engines whose parser predates `?.` (Tizen 5.0 / Chromium 63)
  // the tag can never execute; the hero there is the vendored es2017 copy in
  // the JS-Injector channel (JELA-115). The fetch + parse-fail is pure waste
  // on the boot path, so drop the tag from the html STRING before either
  // write path parses the markup (same choke point as the two helpers above;
  // covers the JEL-1832 string fast path AND the DOMParser path, and runs
  // after the index cache read so cached markup stays pristine). The probe
  // must PARSE-test, not feature-test: engines that parse `?.` run the CDN
  // copy and must keep the tag. The stylesheet <link> is NOT stripped — it
  // is repointed by rewriteFontThirdPartyCss above.
  //
  // Kill switch: localStorage["jellyfin.shell.keepCdnMediaBarJs"]="1"
  // restores the stock tag. Diag: window.__shellMbStrip = {on,held,urls}.
  function stripDeadMediaBarJs(html) {
    try {
      if (localStorage.getItem("jellyfin.shell.keepCdnMediaBarJs") === "1") {
        return html;
      }
    } catch (_) {}
    try {
      new Function("void 0?" + ".x");
      return html;
    } catch (_) {}
    var d = (window.__shellMbStrip = { on: 1, held: 0, urls: [] });
    try {
      var out = String(html).replace(
        /<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["'][^>]*>\s*<\/script>/gi,
        function (tag, src) {
          if (!/cdn\.jsdelivr\.net\/[^"']*slideshowpure[^"']*\.js/i.test(src)) {
            return tag;
          }
          d.held++;
          d.urls.push(src);
          return "";
        },
      );
      return d.held ? out : html;
    } catch (_) {
      return html;
    }
  }
  function loadRemoteWebClient(serverUrl) {
    // JELA-67: opt-in Lite canvas home — when it boots from the LS byte
    // cache, the SPA below never loads this boot (OK/Back hands off).
    try {
      if (maybeBootLite(serverUrl)) {
        return Promise.resolve();
      }
    } catch (_) {}
    var baseUrl = serverUrl + "/web/";
    // JELA-59: kick the config-epoch probe first — loadTxDropManifest and
    // the SWR revalidation below chain on window.__shellEpochReady.
    try {
      loadConfigEpoch(serverUrl);
    } catch (_) {}
    // JEL-621: kick the pre-lowered drop manifest fetch first so it overlaps
    // the /web/ RTT pair below. Tiny bounded fetch; resolves null on servers
    // without a /shell/ drop and every consumer falls back to Babel.
    try {
      loadTxDropManifest(serverUrl);
    } catch (_) {}
    // JEL-1034 (v53): speculative babel prime, flag-gated.
    // The lazy loader is call-site triggered (transpileLegacyScriptsInner
    // slow path), but if first transpile-needed plugin lands before
    // /web/ DCL, document.write blocks on the babel fetch and stalls
    // paint. We avoid that by priming early on legacy Chromium IF a
    // prior boot recorded that this server actually needs babel.
    // First cold boot on a plugin-heavy server pays the stall once,
    // then the flag is set and subsequent boots overlap the fetch with
    // the /web/ RTT. Plugin-light legacy servers never set the flag,
    // never load babel — keeping the 3.13 MB / ~500 ms savings.
    var babelNeededFlag = false;
    try {
      babelNeededFlag = localStorage.getItem(BABEL_NEEDED_KEY) === "1";
    } catch (_) {}
    // JEL-1984: align the speculative prime with the head-IIFE soft-skip
    // gate. If the last two transpile passes hit babelUnusedStreak >= 2
    // every static plugin came from tx-cache and babel was never invoked,
    // so the prime fetch + V8 parse are dead weight. Keep `__ensureBabel`
    // defined (the index.html IIFE still installs it) so the per-script
    // slow path can lazy-load when a NEW plugin URL appears mid-boot.
    var babelStreakSkip = false;
    try {
      babelStreakSkip =
        (parseInt(localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0", 10) ||
          0) >= 2;
    } catch (_) {}
    window.__shellBabelPrimeSkipped = babelStreakSkip ? 1 : 0;
    if (
      isLegacyChromium() &&
      babelNeededFlag &&
      !babelStreakSkip &&
      typeof window.__ensureBabel === "function"
    ) {
      try {
        window.__ensureBabel();
      } catch (_) {}
    }
    // Adopt the in-flight prefetch from index.html when it targets the
    // same baseUrl. Saves one full RTT pair on cold start by overlapping
    // network with shell.js parse + Babel load. Falls back to a fresh
    // fetch when the prefetch is missing or stale (e.g. user changed
    // server URL on the connect screen).
    // JEL-554 (v29): drop `cache:'no-store'`. Forcing no-store re-downloads
    // index.html + config.json on every warm start (~100-500 ms on TV
    // networks) with no safety benefit — the server only changes them on
    // a real Jellyfin upgrade, and the HTTP cache layer revalidates.
    var pf = window.__shellPrefetch;
    var fetchOpts = { credentials: "omit" };
    // JEL-63: race both critical-path boot fetches against a bounded timer so
    // an unreachable saved server recovers to the connect screen at the same
    // moment on TV and browser (see withBootTimeout). Wrapping the *consumed*
    // promise covers both the fresh-fetch and adopted-prefetch sources (the
    // head-IIFE prefetch is itself an un-timed fetch).
    // JELA-59: creation is lazy (thunks) so an epoch-matched cache-hit boot
    // can skip issuing the SWR revalidation pair entirely; the cache-miss
    // primary path calls them synchronously below, exactly as before.
    var mkIdxF = function () {
      return withBootTimeout(
        pf && pf.baseUrl === baseUrl && pf.index
          ? pf.index
          : fetch(baseUrl + "index.html", fetchOpts),
        "web client",
      );
    };
    var mkCfgF = function () {
      return withBootTimeout(
        pf && pf.baseUrl === baseUrl && pf.config
          ? pf.config
          : fetch(baseUrl + "config.json", fetchOpts),
        "web config",
      );
    };
    // JEL-1977: stale-while-revalidate body cache for /web/index.html +
    // /web/config.json. When the gate flag is on and LS holds a valid
    // entry for this server origin, resolve indexPromise/configPromise
    // immediately from cache and treat the in-flight fetch as background
    // revalidation that updates LS for the next boot. Eliminates the
    // /web/ RTT pair (200–500 ms on cold HTTP cache) from the pre-
    // document.write critical path. On by default (JEL-622) — set
    // `jellyfin.shell.indexCache='0'` to opt out.
    window.__shellIndexCacheRecords = window.__shellIndexCacheRecords || 0;
    window.__shellIndexCacheHits = window.__shellIndexCacheHits || 0;
    window.__shellIndexCacheSavedMs = window.__shellIndexCacheSavedMs || 0;
    var cacheGateOn = webCacheEnabled();
    var cachedIndex = cacheGateOn ? readWebIndexCache(serverUrl) : null;
    var cachedConfig = cacheGateOn ? readWebConfigCache(serverUrl) : null;
    var indexCacheHit = !!(cachedIndex && cachedConfig);
    if (indexCacheHit) {
      window.__shellIndexCacheHits++;
      window.__shellWebIndexCacheAdopted = 1;
      var revalStart = typeof Date !== "undefined" ? Date.now() : 0;
      // Background revalidation: drain the in-flight fetches that the
      // head IIFE already kicked off (or issue fresh ones) and update LS
      // so the next boot adopts fresh bodies. Errors are non-fatal —
      // stale cache stays in place.
      // JELA-59: the pair now waits for the epoch gate. A matched boot
      // skips it (suppression point (a)); any other state revalidates as
      // today, and a successful pair commits a pending epoch record
      // (write-after-adopt). Chaining on __shellEpochReady also orders
      // the writes AFTER a mismatch invalidation.
      var drain = function (mk, c, w) {
        return mk()
          .then(function (r) {
            return r && r.ok ? r.text() : null;
          })
          .then(function (txt) {
            var ok = typeof txt === "string" && !!txt.length;
            if (ok && txt !== c.body) w(serverUrl, txt);
            return ok;
          })
          .catch(function () {
            return false;
          });
      };
      ceReady()
        .then(function () {
          if (window.__shellCfgEM === 1) {
            ceSup("idx");
            return;
          }
          var iOk = drain(mkIdxF, cachedIndex, writeWebIndexCache).then(
            function (ok) {
              if (revalStart) {
                try {
                  window.__shellIndexCacheSavedMs = Date.now() - revalStart;
                } catch (_) {}
              }
              return ok;
            },
          );
          var cOk = drain(mkCfgF, cachedConfig, writeWebConfigCache);
          Promise.all([iOk, cOk]).then(function (r) {
            if (r[0] && r[1]) ceAdopt();
          });
        })
        .catch(function () {});
    }
    // JEL-1289 (v55): also capture the speculative bundle prefetch
    // (legacy-only; primed in index.html from the last-seen bundle URL).
    // patchPlaybackBundles adopts it when the URL matches.
    var prefetchedBundle =
      pf && pf.baseUrl === baseUrl && pf.bundle && pf.bundleUrl
        ? { url: pf.bundleUrl, fetch: pf.bundle }
        : null;
    // JEL-1654: park plugin prefetch promises on a stable global so
    // transpileLegacyScriptsInner can adopt them after __shellPrefetch
    // is nulled. Keyed by absolute URL; only set when baseUrl matches.
    try {
      window.__shellPluginPrefetch =
        pf && pf.baseUrl === baseUrl && pf.plugins ? pf.plugins : null;
    } catch (_) {}
    // Release prefetch refs so the connect-screen retry path issues fresh
    // fetches against the new server.
    try {
      window.__shellPrefetch = null;
    } catch (_) {}
    var indexPromise = indexCacheHit
      ? Promise.resolve(cachedIndex.body)
      : mkIdxF()
          .then(function (r) {
            if (!r.ok)
              throw new Error(
                "Failed to fetch web client (HTTP " + r.status + ")",
              );
            return r.text();
          })
          .then(function (txt) {
            // JEL-1977: record body for next-boot stale-while-
            // revalidate. Skipped when the cache adopted this boot
            // (revalidation branch above handles the update path).
            if (cacheGateOn) {
              writeWebIndexCache(serverUrl, txt);
              window.__shellIndexCacheRecords++;
            }
            return txt;
          });
    var configPromise = indexCacheHit
      ? Promise.resolve(cachedConfig.parsed)
      : mkCfgF()
          .then(function (r) {
            if (!r.ok)
              throw new Error(
                "Failed to fetch web config (HTTP " + r.status + ")",
              );
            return r.text();
          })
          .then(function (txt) {
            if (cacheGateOn) writeWebConfigCache(serverUrl, txt);
            try {
              return JSON.parse(txt);
            } catch (e) {
              throw new Error("Failed to parse web config");
            }
          });
    // JELA-59 write-after-adopt, cache-miss path: the primary /web/ pair
    // succeeding IS the adoption; commit once the epoch probe also settled
    // (so a mismatch invalidation always precedes the commit).
    if (!indexCacheHit)
      Promise.all([indexPromise, configPromise])
        .then(function () {
          ceReady().then(ceAdopt);
        })
        .catch(function () {});
    // JEL-134: vault restore joins the document.write gate so jellyfin-web
    // always boots against restored creds. It overlaps the index/config
    // RTTs (IDB read is ~ms) and is 3 s-bounded, never-rejecting — it can
    // delay boot only when the network is faster than IndexedDB.
    var credsRestorePromise = restoreCredsVault();
    return Promise.all([indexPromise, configPromise, credsRestorePromise]).then(
      function (results) {
        // JELA-707: JE-defer strip runs after the font rewrite, same
        // string-level contract (both write paths covered, cache pristine).
        // JELA-716: then drop the parse-dead CDN media-bar tag.
        var html = stripDeadMediaBarJs(
          stripJeScriptsForDefer(
            rewriteFontThirdPartyCss(results[0], serverUrl),
          ),
        );
        var upstreamCfg = results[1];
        // JEL-1832: warm-boot fast path skips DOMParser+outerHTML
        // (~200-500 ms on Chromium 56) when caches are primed.
        var fast = maybeStringFastPath(html, serverUrl, baseUrl, upstreamCfg);
        if (fast) {
          window.__jellyfinShellBootDone = true;
          markDocumentWrite();
          document.open("text/html", "replace");
          document.write(fast);
          document.close();
          armDeferWatchdog();
          return;
        }
        var doc = new DOMParser().parseFromString(html, "text/html");
        // Force <base href> so relative links resolve to the server.
        var existingBase = doc.querySelector("base");
        if (existingBase) existingBase.remove();
        var baseTag = doc.createElement("base");
        baseTag.href = baseUrl;
        doc.head.insertBefore(baseTag, doc.head.firstChild);
        // Diagnostic HUD seed runs before EVERYTHING else so it can
        // capture parse-time errors from polyfills, plugins, and
        // jellyfin-web itself. Pre-seed init values now; transpile
        // counts are filled in below before document.write.
        window.__shellDiagInit = window.__shellDiagInit || {};
        window.__shellDiagInit.legacy = isLegacyChromium();
        window.__shellDiagInit.babel = typeof window.Babel !== "undefined";
        window.__shellDiagInit.polyfilled = window.__shellDiagInit.legacy;
        var diagTag = doc.createElement("script");
        diagTag.setAttribute("data-shell-diag", "1");
        // JEL-1034 (v53): lazy-load babel; defer 3.13 MB fetch until
        // first plugin actually needs transpile.
        // JEL-1215: '__SHELL_VER__' is build-time substituted by
        // build_shell_min.py with config.xml's widget version so the
        // HUD reports the deployed widget version (single source of
        // truth = config.xml). Unbuilt loads keep the placeholder.
        diagTag.textContent = buildDiagSeedScript("__SHELL_VER__");
        doc.head.insertBefore(diagTag, baseTag);
        // Seed config.json BEFORE any jellyfin-web script runs so the
        // user only enters the server URL once (in the shell).
        var seedTag = doc.createElement("script");
        seedTag.setAttribute("data-shell-seed", "1");
        seedTag.textContent = buildSeedScript(serverUrl, upstreamCfg);
        if (baseTag.nextSibling)
          doc.head.insertBefore(seedTag, baseTag.nextSibling);
        else doc.head.appendChild(seedTag);
        injectChromium56Polyfills(doc);
        // JEL-1971: append QA HTTP beacon script tag (no-op in prod;
        // gated inside the body on localStorage['jellyfin.qa.overlay']).
        injectQaBeacon(doc);
        // JEL-126: boot progress dots that survive the ~20 s main-thread
        // blackout while jellyfin-web parses+executes (legacy-only).
        injectBootProgress(doc);
        // JEL-647: instant-home snapshot overlay (repaint + dismiss +
        // capture) in the written document — see instantHomeBody().
        injectInstantHome(doc);
        // JELA-29: opt-in Direct-Home render prototype (no-op unless
        // directHome=1) — see directHomeBody().
        injectDirectHome(doc);
        // JELA-30: boot-ring diag beacon (JELA-827: opt-OUT) posts the JEL-617 ring +
        // tx counters to POST /shell/diag (no-op when diagBeacon==='0').
        injectDiagBeaconPost(doc);
        // JEL-197: ensure the JS-Injector snippet channel (public.js) is
        // present so transpileLegacyScripts below fetches + runs it through
        // the tizen-compat firewall (idempotent vs a server-injected copy).
        injectJsInjectorChannel(doc, serverUrl);
        // JEL-554 (v29): run bundle patch + legacy transpile in parallel.
        // They touch disjoint <script> sets (bundle patcher gates on
        // main.*.bundle.js, transpileLegacyScripts skips bundles via
        // isJellyfinWebBundle) so there's no contention.
        return Promise.all([
          patchPlaybackBundles(doc, baseUrl, prefetchedBundle),
          transpileLegacyScripts(doc, baseUrl),
        ]).then(function () {
          window.__jellyfinShellBootDone = true;
          markDocumentWrite();
          document.open("text/html", "replace");
          document.write("<!DOCTYPE html>" + doc.documentElement.outerHTML);
          document.close();
          // JEL-554 (v32): Chromium 56 defer-script lifecycle bug.
          //
          // QA on JEL-555 v29 (verdict reassigned to FoundingEngineer)
          // proved that after document.open + document.write +
          // document.close on Tizen 5.0 (Chromium 56), <script defer
          // src=...> tags in the freshly-written document silently
          // NEVER execute. readyState reaches "complete" but the
          // webpack runtime is never installed; the SPA hangs at
          // splashLogo and never reaches mainPage.
          //
          // The original verdict explained the trigger as inline
          // bundles (patchPlaybackBundles cache hit) racing the defer
          // queue. v31 still inlines main.jellyfin.bundle.js on
          // legacy Chromium (the serverId patch path) and the QA
          // re-run on physical TV shows warm boot still hangs after
          // shellBoot. Reproducer-confirmed unblock: manually
          // appending the deferred runtime.bundle.js as a fresh
          // <script> immediately resumes the SPA.
          //
          // Watchdog: 5.5 s after document.close, if window.ApiClient
          // and __webpack_require__ are both undefined, re-inject
          // every <script defer src> in source order as a NON-defer
          // script. Safe on modern Chromium (ApiClient will be
          // present, watchdog no-ops). Safe on cold boot success
          // (same no-op exit). Fires only when the defer queue
          // genuinely failed.
          //
          // JEL-554 (v34): timeout was 2000 ms. QA confirmed normal
          // cold-boot defers on physical TV take 2.5-3.5 s to install
          // ApiClient — the 2 s watchdog fired BEFORE healthy defers
          // finished and double-injected all 28 scripts, adding
          // 5-10 s of CPU overhead (cold hasCards 30.98 s with
          // double-inject vs 26.20 s without). Bumped to 5500 ms so
          // the watchdog only fires for the genuine warm-boot hang
          // (which is permanent — 5.5 s still catches it).
          //
          // JEL-723: the fixed 5500 ms blind wait was the wrong
          // signal. The defer hang is INTERMITTENT (profiled on
          // physical TV: one cold boot self-ran defers, api=2948 ms,
          // watchdog never fired; another hung, watchdog fired at
          // ~5.5 s). On the hung boots the 5500 ms timer is pure
          // dead time — and you cannot shorten a blind timer without
          // risking the v34 double-inject on slow-but-healthy boots
          // (re-injecting at setTimeout(0) races the browser's own
          // defer queue and double-runs the webpack runtime — JEL-723
          // v45/v46 confirmed that breaks boot outright).
          //
          // Replace the blind timer with a POSITIVE hang signal:
          // poll every 150 ms; the defer queue has provably been
          // abandoned once document.readyState === 'complete' while
          // __webpack_require__ is still undefined (per the v32
          // analysis above — readyState reaches complete but the
          // runtime is never installed). Require the signal to hold
          // for 2 consecutive polls (~300 ms grace) so a healthy
          // defer that runs a tick after 'complete' is not mistaken
          // for a hang. The instant __webpack_require__/ApiClient
          // appears the poll cancels with no re-inject (healthy
          // boot, zero cost — identical to the old timer no-op).
          // 5500 ms stays as the hard-cap fallback.
          armDeferWatchdog();
        });
      },
    );
  }

  // ---- Connect screen flow ----------------------------------------------

  // JELA-224 (WS-C, C2): boot-failure overlay clear. The shell paints two
  // boot-time covers before /web/ hydrates — the Instant-Home cached-home /
  // skeleton (JEL-647, id #__shell_instant_home) and the boot-progress dots
  // (JEL-126, cleared via window.__shellBootProgressClear) — both full-screen
  // at z-index max. When the boot instead falls back to the shell's own
  // connect form (first launch, or a saved server that is slow / dead /
  // JWT-expired / channel-404), those covers are STALE: they mask the
  // connect-form error for up to the 23 s Instant-Home settlecap, so the boot
  // reads as a blank hold rather than a clear "could not reach server" state.
  // Tear them down the moment the connect form is revealed. Flag-dark
  // (JELA-141): opt-in via jellyfin.shell.bootFailOverlayClear='1'; default OFF
  // leaves the pre-existing self-dismiss timing untouched. Every step is
  // try/caught + existence-guarded so it can never break boot.
  function clearBootOverlays() {
    try {
      if (localStorage.getItem("jellyfin.shell.bootFailOverlayClear") !== "1")
        return;
    } catch (_) {
      return;
    }
    // Instant-Home (JEL-647): flag dismissed so the watch/paint ticks stop
    // re-creating the overlay (both gate on G.dismissed), then remove the node.
    try {
      var ih = window.__shellIH;
      if (ih) ih.dismissed = 1;
      var ihEl = document.getElementById("__shell_instant_home");
      if (ihEl && ihEl.parentNode) ihEl.parentNode.removeChild(ihEl);
    } catch (_) {}
    // Direct-Home (JELA-29, opt-in; structurally absent in the baked boot
    // shell — a no-op there, kept for the cross-shell mirror guard).
    try {
      var dh = window.__shellDH;
      if (dh) dh.dismissed = 1;
      var dhEl = document.getElementById("__shell_direct_home");
      if (dhEl && dhEl.parentNode) dhEl.parentNode.removeChild(dhEl);
    } catch (_) {}
    // Boot-progress dots (JEL-126): its own idempotent clear hook removes the
    // overlay div + its <style> and records __shellBootProgressClearedMs.
    try {
      if (window.__shellBootProgressClear) window.__shellBootProgressClear();
    } catch (_) {}
  }

  function showError(msg) {
    var err = document.getElementById("boot-error");
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

  //@@SHELL_CORE:injectConnectStylesheet@@

  function attachConnectForm() {
    injectConnectStylesheet();
    // JEL-934 (v51): #boot-root is `display:none` by default in
    // index.html so warm boot never paints the unstyled form during
    // the /web/ RTT. Reveal it now: this path runs only when the
    // form actually needs to render (first launch, or saved-server
    // failure recovery after clearServerUrl()).
    var rootEl = document.getElementById("boot-root");
    if (rootEl) rootEl.style.display = "block";
    // JELA-224 (WS-C, C2): the shell's own connect form is about to paint —
    // tear down any stale boot cover first (flag-dark; see clearBootOverlays)
    // so a slow / dead / expired-JWT saved-server boot surfaces the error
    // immediately instead of holding a stale cached-home for up to 23 s.
    clearBootOverlays();
    // JEL-617: boot-phase mark — the shell's own connect form is now
    // on-screen (first launch / saved-server recovery; warm boots skip it).
    try {
      if (window.__shellPhase) window.__shellPhase("connect");
    } catch (_) {}
    var form = document.getElementById("server-form");
    var input = document.getElementById("server-input");
    if (!form || !input) return;

    // JEL-63: pre-fill the saved server URL (if any) so the boot-failure
    // recovery path lets the user retry the same address with one Connect
    // press instead of retyping it. Only when the field is empty so we never
    // clobber what the user is actively typing.
    if (!input.value) {
      var saved = loadServerUrl();
      if (saved) input.value = saved;
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var url = normalizeServerUrl(input.value);
      if (!url) {
        showError("Please enter a server URL.");
        return;
      }
      showError("");
      validateServer(url)
        .then(function () {
          saveServerUrl(url);
          return loadRemoteWebClient(url);
        })
        .catch(function (err) {
          showError(
            "Could not reach server: " +
              (err && err.message ? err.message : "unknown error"),
          );
        });
    });
  }

  function bootstrap() {
    registerRemoteKeys();
    installBackHandler();
    installResumeEpochCheck();

    var stored = loadServerUrl();
    if (stored) {
      // JEL-647: paint the cached home snapshot in the WIDGET document
      // before the /web/ fetch even starts — this is what makes the
      // time-to-first-visible-menu target (< 2.5 s warm) reachable; the
      // written document re-injects the same body to survive
      // document.open. No-op unless authed with a fresh snapshot.
      try {
        injectInstantHome(document);
      } catch (_) {}
      // JELA-29: opt-in Direct-Home prototype in the widget document too;
      // the written document re-injects the same body (no-op unless
      // directHome=1). Cached rows survive document.open via window.__shellDH.
      try {
        injectDirectHome(document);
      } catch (_) {}
      // JEL-555: skip the /System/Info/Public pre-flight on resume.
      // loadRemoteWebClient fetches index.html + config.json anyway; if
      // those fail the catch below clears state and shows the connect
      // form. The pre-flight added a serial round trip (~hundreds of ms
      // on TV networks) on every cold start with no additional safety.
      loadRemoteWebClient(stored).catch(function () {
        // JEL-63: do NOT clear the saved server URL on a boot-time network
        // failure. The host is often only *temporarily* unreachable (TV just
        // woke from standby, router mid-reboot, Wi-Fi reassociating). Wiping
        // the URL forced the user to retype the full address every time.
        // Keep it and re-show the connect form with the address pre-filled
        // (attachConnectForm) so a single Connect press retries the SAME
        // server. The text below is emitted from this single, UA-independent
        // path, so it is byte-identical on TV and browser.
        attachConnectForm();
        showError(
          "Could not reach saved server. Check your network and try again.",
        );
      });
    } else {
      attachConnectForm();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
