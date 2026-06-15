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
  function withBootTimeout(p, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out reaching server (" + label + ")"));
      }, BOOT_FETCH_TIMEOUT_MS);
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
  // literals (`10n`) the way Chromium 63 actually needs.
  var MODERN_SYNTAX_RE_SRC =
    "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{";
  var MODERN_SYNTAX_RE = new RegExp(MODERN_SYNTAX_RE_SRC);
  // Mirror of babel.transform options used by babelTranspile() and the
  // seed-script transpile(). Any divergence between them or between
  // releases changes this string and busts the cache.
  // JEL-26: chrome 56 -> 63 + loose mode mirrors the bootstrap shell so a
  // server-side shell swap onto the M63 keeps the Splide/iterable fix. The
  // `assumptions` block is part of the transform options but intentionally
  // omitted from this key string to stay byte-identical with the bootstrap
  // shell's BABEL_OPTS_KEY (it derives TX_VER from the same inputs).
  var BABEL_OPTS_KEY =
    "presets:[[env,{targets:{chrome:63},modules:false,loose:true}]];sourceType:script;compact:true;comments:false";
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
  var TX_CACHE_EPOCH = "jel178-2";
  var TX_VER = txFnv1a(
    MODERN_SYNTAX_RE_SRC +
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
  // Gated by `jellyfin.shell.indexCache` localStorage flag: defaults '0'
  // (off) so initial QA is opt-in. Set to '1' post-QA parity smoke to
  // turn on stale-while-revalidate boot.
  var WEB_INDEX_CACHE_KEY = "jellyfin.shell.webIndexHtml";
  var WEB_CONFIG_CACHE_KEY = "jellyfin.shell.webConfig";
  var WEB_CACHE_VER = "__SHELL_VER__";
  var WEB_CACHE_MAX = 262144; // 256 KB cap per body
  var WEB_CACHE_GATE_KEY = "jellyfin.shell.indexCache";

  function webCacheEnabled() {
    try {
      return localStorage.getItem(WEB_CACHE_GATE_KEY) === "1";
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
    return fetch(serverUrl + "/System/Info/Public", {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (info) {
        if (!info || !info.Id) throw new Error("Not a Jellyfin server");
        return info;
      });
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
      '  try{localStorage.setItem("layout","tv");}catch(_){}',
      '  try{(function(){var K={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Up:1,Down:1,Left:1,Right:1,Tab:1},C={9:1,37:1,38:1,39:1,40:1,29460:1,29461:1,29462:1,29463:1},S=\'a[href]:not([tabindex="-1"]),button:not(:disabled):not([tabindex="-1"]),input:not([type=range]):not([type=file]):not([tabindex="-1"]):not(:disabled),select:not([tabindex="-1"]):not(:disabled),textarea:not([tabindex="-1"]):not(:disabled),.focusable:not([tabindex="-1"])\';function vis(n){if(!n)return false;if(n.offsetParent===null&&n.tagName!=="BODY")return false;var r=n.getBoundingClientRect&&n.getBoundingClientRect();return !!(r&&r.width>0&&r.height>0);}function fst(s){if(!s||!s.querySelectorAll)return null;try{var n=s.querySelectorAll(S);for(var i=0;i<n.length;i++)if(vis(n[i]))return n[i];}catch(_){}return null;}function scopes(){var out=[];try{var d=document.querySelectorAll(".dialogContainer .dialog.opened");if(d.length)out.push(d[d.length-1]);}catch(_){}try{var p=document.querySelectorAll(".page:not(.hide)");for(var i=p.length-1;i>=0;i--)if(p[i]&&p[i].offsetParent!==null)out.push(p[i]);}catch(_){}try{var hsel=[".skinHeader",".headerTop",".mainAnimatedPages",".pageContainer","#reactRoot","#appLayer"];for(var hi=0;hi<hsel.length;hi++){var h=document.querySelector(hsel[hi]);if(h)out.push(h);}}catch(_){}out.push(document.body);return out;}function findT(){try{var st=document.getElementById("__shellST");if(st){var r=st.getBoundingClientRect&&st.getBoundingClientRect();if(r&&r.width>0&&r.height>0){window.__shellLastScopeHit=99;return st;}}}catch(_){}var sc=scopes();window.__shellLastScopeN=sc.length;for(var i=0;i<sc.length;i++){var t=fst(sc[i]);if(t){window.__shellLastScopeHit=i;return t;}}window.__shellLastScopeHit=-1;return null;}function isBodyF(){var a=document.activeElement;return !a||a===document.body||a.tagName==="HTML";}function isAuthed(){if(window.__shellAFForceAuth===1)return true;try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return false;var p=JSON.parse(c);return !!(p&&p.Servers&&p.Servers.length&&p.Servers[0].AccessToken);}catch(_){return false;}}window.addEventListener("keydown",function(e){if(!e||!(K[e.key]||C[e.keyCode]||C[e.which]))return;if(!isBodyF())return;window.__shellBodyFocusRescueAttempts=(window.__shellBodyFocusRescueAttempts||0)+1;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellBodyFocusRescues=(window.__shellBodyFocusRescues||0)+1;e.preventDefault();e.stopPropagation();}}}catch(_){}},true);window.__shellBodyFocusRescueBound=1;window.__shellAutoFocusAttempts=0;window.__shellAutoFocusSuccesses=0;window.__shellAutoFocusBudget=24;function bumpAF(){window.__shellAutoFocusBudget=24;}try{window.addEventListener("hashchange",bumpAF,false);}catch(_){}try{window.addEventListener("popstate",bumpAF,false);}catch(_){}var lastBody=true;setInterval(function(){var nowBody=isBodyF();if(nowBody&&!lastBody)bumpAF();lastBody=nowBody;try{var st=document.getElementById("__shellST");if(st){if(document.activeElement!==st){window.__shellAutoFocusAttempts++;try{st.focus();}catch(_){}if(document.activeElement===st){window.__shellAutoFocusSuccesses++;window.__shellLastScopeHit=99;}}return;}}catch(_){}if(!nowBody)return;if((window.__shellAutoFocusBudget||0)<=0)return;if(!isAuthed())return;window.__shellAutoFocusAttempts++;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellAutoFocusSuccesses++;window.__shellAutoFocusBudget=0;return;}}}catch(_){}window.__shellAutoFocusBudget--;},600);})();}catch(_){}',
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
      '  try{(function(){if(localStorage.getItem("jellyfin.shell.rememberMeDefaultDisabled")==="1")return;window.__shellRememberMeChecks=0;var bound=new WeakSet(),userOff=new WeakSet();function nudge(){try{var c=document.querySelector(".manualLoginForm .chkRememberLogin")||document.querySelector(".chkRememberLogin");if(!c)return;if(!bound.has(c)){bound.add(c);c.addEventListener("change",function(){if(!c.checked){userOff.add(c);}else{userOff["delete"](c);}},false);}if(userOff.has(c))return;if(!c.checked){c.checked=true;window.__shellRememberMeChecks++;}}catch(_){}}try{setInterval(nudge,300);}catch(_){}try{document.addEventListener("DOMContentLoaded",nudge,false);}catch(_){}nudge();})();}catch(_){}',
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
      // JEL-554 (v32): same pre-check as static transpileLegacyScripts.
      // Skip babel.transform entirely when no ES2020+ syntax is present —
      // plugin parses fine on Chromium 56 as-is.
      // JEL-26: keep this seed-side pre-check in lockstep with the widget-side
      // MODERN_SYNTAX_RE_SRC above, including the BigInt false-positive anchor.
      "    var __modernRe=/\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{/;",
      '    function needsTx(code){return typeof code==="string"&&__modernRe.test(code);}',
      '    function transpile(code){if(typeof window.Babel==="undefined")return null;try{return window.Babel.transform(code,{presets:[["env",{targets:{chrome:"63"},modules:false,loose:true}]],assumptions:{iterableIsArray:true,arrayLikeIsIterable:true},sourceType:"script",compact:true,comments:false}).code;}catch(_){return null;}}',
      "    function maybeTranspile(code){if(!needsTx(code)){try{window.__shellTxSkipCount=(window.__shellTxSkipCount||0)+1;}catch(_){}return code;}try{window.__shellTxDoCount=(window.__shellTxDoCount||0)+1;}catch(_){}return transpile(code);}",
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
      "    function __txLru(){try{var v=localStorage.getItem(__TXLRUKEY);return v?JSON.parse(v):{};}catch(_){return{};}}",
      "    function __txPersistLru(m){try{localStorage.setItem(__TXLRUKEY,JSON.stringify(m));}catch(_){}}",
      // JEL-554 (v34): record the first 10 missed src URLs alongside the
      // miss counter so QA can compare them against the cached key set in
      // localStorage. v33 showed 54 misses / 1 hit despite 171 cached
      // entries — implies a URL-mismatch (likely query-param drift)
      // rather than a cold-cache problem. Bounded at 10 to keep
      // localStorage/window state small. Mirrors instrumentation added
      // to the static-side cachedTranspile (see TX_PFX).
      '    function __txGet(src){if(String(src).indexOf("?")>=0)return null;try{var k=__txKey(src);var v=localStorage.getItem(__TXPFX+k);if(v!=null){window.__shellTxCacheHits=(window.__shellTxCacheHits||0)+1;var m=__txLru();m[k]=Date.now();__txPersistLru(m);}else{window.__shellTxCacheMisses=(window.__shellTxCacheMisses||0)+1;try{var __miss=window.__shellTxCacheMissUrls;if(!__miss){__miss=[];window.__shellTxCacheMissUrls=__miss;}if(__miss.length<10)__miss.push(src);}catch(_){}}return v;}catch(_){return null;}}',
      "    function __txPrune(){try{var m=__txLru();var keys=Object.keys(m);if(!keys.length)return;keys.sort(function(a,b){return m[a]-m[b];});var n=Math.min(keys.length,10);for(var i=0;i<n;i++){try{localStorage.removeItem(__TXPFX+keys[i]);}catch(_){}delete m[keys[i]];}__txPersistLru(m);}catch(_){}}",
      '    function __txSet(src,body){if(String(src).indexOf("?")>=0)return;if(typeof body!=="string"||body.length>262144)return;var k=__txKey(src);try{localStorage.setItem(__TXPFX+k,body);var m=__txLru();m[k]=Date.now();__txPersistLru(m);}catch(e){__txPrune();try{localStorage.setItem(__TXPFX+k,body);var m2=__txLru();m2[k]=Date.now();__txPersistLru(m2);}catch(__){}}}',
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
      "        .then(function(code){",
      // JEL-554 (v32): only call babel.transform when the body actually
      // contains ES2020+ syntax. Most plugin scripts parse fine on
      // Chromium 56 as-is and don\'t need the ~50–200 ms transpile pass.
      "          var out=maybeTranspile(code);",
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
      "      if(!src||isBundle(src))return null;",
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
      "        .then(function(code){",
      // JEL-554 (v32): fast path for plugin bodies that parse on Chromium 56.
      "          var out=maybeTranspile(code);",
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
      "            if(!isShellInternal(this)&&v&&!isBundle(v)){",
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
      '          if(this.nodeName==="SCRIPT"&&String(name).toLowerCase()==="src"&&!isShellInternal(this)&&value&&!isBundle(value)){',
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
      "    function __txPrimeStart(P){",
      '      var origin="";try{origin=new URL(document.baseURI).origin;}catch(_){}',
      "      var seen={},fq=[],bodies=[],pend=0,busy=false,stopped=false;",
      '      function authed(){try{return !!(window.ApiClient&&typeof window.ApiClient.getCurrentUserId==="function"&&window.ApiClient.getCurrentUserId());}catch(_){return false;}}',
      "      function norm(u){var abs;try{abs=new URL(u,document.baseURI).href;}catch(_){return null;}try{if(origin&&new URL(abs).origin!==origin)return null;}catch(_){return null;}if(isBundle(abs))return null;if(String(abs).indexOf('?')>=0)return null;var k=__txKey(abs);if(seen[k])return null;var hit=null;try{hit=localStorage.getItem(__TXPFX+k);}catch(_){}if(hit!=null)return null;seen[k]=1;return abs;}",
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
      '          var __p=needsTx(it.c)&&typeof window.__ensureBabel==="function"?window.__ensureBabel():Promise.resolve(true);',
      "          __p.then(function(){",
      "            try{",
      "              var out=maybeTranspile(it.c);",
      "              if(out!=null){__txSet(it.u,needsJq(out)?wrapJq(out):out);P.t++;}else P.e++;",
      "            }catch(_){P.e++;}",
      "            busy=false;",
      "            drain();",
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
      "        var name=g.names[0],left=0,best=null;",
      // Warm/partial cache: if names[0] is already cached under one of the
      // candidate dirs, that dir won the probe on an earlier boot — commit
      // to it without any network probe (a fully-warm boot fetches nothing)
      // and let enq's cached-skip fill only the gaps.
      "        for(var w=0;w<g.dirs.length;w++){",
      '          var wAbs;try{wAbs=new URL(g.dirs[w]+"/"+name,document.baseURI).href;}catch(_){continue;}',
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
      "            var uid=null;try{uid=window.ApiClient.getCurrentUserId();}catch(_){}",
      "            clearInterval(__tpT);",
      '            if(uid){__tpP.st="auth";return;}',
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
      "    setTimeout(__shellWalkWebpack,200);",
      "  }catch(_){}",
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
    try {
      return window.Babel.transform(src, {
        presets: [
          ["env", { targets: { chrome: "63" }, modules: false, loose: true }],
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
      "window.__shellT={t0:(window.__shellT0||Date.now()),dcl:0,api:0,card:0};",
      "function __tm(k){if(!window.__shellT[k])window.__shellT[k]=Date.now()-window.__shellT.t0;}",
      'document.addEventListener("DOMContentLoaded",function(){__tm("dcl");});',
      'var __apiPoll=setInterval(function(){if(window.ApiClient){__tm("api");clearInterval(__apiPoll);}},100);',
      "setTimeout(function(){clearInterval(__apiPoll);},30000);",
      'var __cardPoll=setInterval(function(){try{if(document.querySelector(".card")){__tm("card");clearInterval(__cardPoll);}}catch(_){}},200);',
      "setTimeout(function(){clearInterval(__cardPoll);},60000);",
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
      '    "t dcl="+(T.dcl||0)+" api="+(T.api||0)+" card="+(T.card||0)+" now="+nowMs,',
      // JEL-727: surface PM/CM patch state + player roster + force-load
      // outcome on minimal HUD so the "No player found" failure mode is
      // diagnosable from a single screenshot. dpm.roster is populated by
      // __shellPatchPM each dispatch (and at patch time). flv = force-
      // load count / ok / err for the pluginManager.loadPlugin fallback
      // that targets empty Video roster.
      '    (function(){var dpm=(window.__shellDiag&&window.__shellDiag.pm)||{};var r=dpm.roster||{};var first=(r.names&&r.names[0])||"?";return "pm p="+(window.__shellPMPatched||0)+" c="+(window.__shellCMPatched||0)+" r="+(r.count||0)+"/"+(r.video||0)+" mt="+(window.__shellMTDerived||0)+" gs="+(window.__shellGACAuthSwap||0)+" gf="+(window.__shellGACFallback||0)+" pm="+(window.__shellPluginManager?1:0)+" flv="+(window.__shellForceLoadVideoCount||0)+"/"+(window.__shellForceLoadVideoOK||0)+"/"+(window.__shellForceLoadVideoErr?1:0)+" p0="+first;})(),',
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

  function injectQaBeacon(doc) {
    var body = qaBeaconBody();
    if (!body || body === "__QA_BEACON_BODY__") return;
    var beaconTag = doc.createElement("script");
    beaconTag.setAttribute("data-shell-beacon", "1");
    beaconTag.textContent = body;
    doc.head.appendChild(beaconTag);
  }

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
  // JEL-554 (v34): record first 10 missed URLs to expose static/dynamic
  // cache-key drift. QA can read window.__shellTxCacheMissUrlsStatic + the
  // dynamic-side window.__shellTxCacheMissUrls and diff against
  // `Object.keys(localStorage).filter(k=>k.indexOf('shell.tx35:')===0)`.
  function txGetStatic(url) {
    try {
      var v = localStorage.getItem(TX_PFX + txKey(url));
      if (v == null) {
        var miss = window.__shellTxCacheMissUrlsStatic;
        if (!miss) {
          miss = [];
          window.__shellTxCacheMissUrlsStatic = miss;
        }
        if (miss.length < 10) miss.push(url);
      }
      return v;
    } catch (_) {
      return null;
    }
  }
  function txSetStatic(url, body) {
    if (typeof body !== "string" || body.length > 262144) return;
    try {
      localStorage.setItem(TX_PFX + txKey(url), body);
    } catch (_) {
      /* quota — soft fail */
    }
  }

  // JEL-554 (v32): fast pre-check for syntax that Chromium 56 can't parse.
  // babel.transform() takes ~50–200 ms per plugin on a 2019 Q60R panel; with
  // 30–50 plugins that's the bulk of the 25 s post-shellBoot gap. Many
  // plugins are plain ES5/ES6 and parse fine on Chromium 56 — we don't need
  // to transpile them at all. The regex screens for the ES2020+ tokens we
  // actually see breaking on TV: optional chaining (?.), nullish coalescing
  // (??), nullish-assignment (??= / ||= / &&=), private class fields (#x),
  // numeric separators (1_000), and the BigInt suffix (1n at digit boundary).
  // JEL-1150: MODERN_SYNTAX_RE hoisted to top-of-IIFE so its source feeds
  // the derived TX_VER hash.
  function needsTranspile(code) {
    return typeof code === "string" && MODERN_SYNTAX_RE.test(code);
  }

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
            if (
              (c.babelLazyTriggered || 0) === 0 &&
              (c.cachedHits || 0) === c.scriptsFound
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
        var url;
        try {
          url = new URL(src, baseUrl).href;
        } catch (_) {
          return null;
        }
        // JEL-554 (v32): cache short-circuit. Skip fetch + babel entirely
        // if we transpiled this URL on a previous boot.
        var cached = url.indexOf("?") >= 0 ? null : txGetStatic(url);
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
              counts.transpiled++;
              counts.fastPath++;
              shellLog("fast-path+inlined", url, gatedRaw ? "(jq-gated)" : "");
              return;
            }
            // JEL-1034 (v53): slow path triggers lazy babel load.
            counts.babelLazyTriggered++;
            return ensureBabelReady().then(function (ready) {
              if (!ready) {
                counts.transpileFailed++;
                try {
                  console.warn(
                    "shell: babel not available, skip transpile",
                    url,
                  );
                } catch (_) {}
                return;
              }
              counts.babel = true;
              var out = babelTranspile(code);
              if (out == null) {
                counts.transpileFailed++;
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
              shellLog("transpiled+inlined", url, gated ? "(jq-gated)" : "");
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
    var POLL = 150,
      // JEL-101 (ports JEL-99): raised from 5500. On the failing Tizen 5.0
      // (Chromium 63) panel a HEALTHY cold boot installs ApiClient at ~6100 ms
      // (measured on device: dcl=3999, api=6097). The cap must clear that with
      // margin or the rescue clobbers a healthy-but-slow boot. See the tick()
      // note below on why the old readyState trigger was removed.
      CAP = 20000,
      started = Date.now();
    function reinject(reason) {
      try {
        if (typeof window.ApiClient !== "undefined") return;
        if (typeof window.__webpack_require__ !== "undefined") return;
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
        // JEL-101 (ports JEL-99): do NOT treat document.readyState ===
        // "complete" as a hang signal. After document.open/write/close into the
        // already-complete bootstrap document, Chromium 63 reports readyState
        // "complete" almost immediately (measured 638 ms) while the freshly
        // written defer bundles are still healthy and pending — ApiClient did
        // not install until 6097 ms. The old readyState trigger therefore fired
        // at 638 ms, re-injected all 28 scripts, and the real defers then ALSO
        // ran, which double-ran the webpack runtime and wedged the SPA forever
        // (JEL-99). The only sound "defers ran" signals are __webpack_require__
        // / ApiClient (checked above); absent those, wait out the cap before
        // assuming a genuine hang.
        var elapsed = Date.now() - started;
        if (elapsed >= CAP) {
          reinject("cap@" + elapsed + "ms");
          return;
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

  function escAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

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
      progressTag;
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
    window.__shellFastPathHits++;
    return patched;
  }

  // JEL-1974 (v68): stamp `tDocumentWrite` into window.__qaMarks and
  // flush to localStorage just before document.open replaces the shell
  // document. The new /web/ document inherits localStorage; the QA
  // beacon (qa-beacon.js, injected via injectQaBeacon) reads
  // jellyfin.qa.bootMarks.prior on first POST and emits the previous
  // boot's full span set as payload.priorBootMarks.
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
  function loadRemoteWebClient(serverUrl) {
    var baseUrl = serverUrl + "/web/";
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
    var indexFetch = withBootTimeout(
      pf && pf.baseUrl === baseUrl && pf.index
        ? pf.index
        : fetch(baseUrl + "index.html", fetchOpts),
      "web client",
    );
    var configFetch = withBootTimeout(
      pf && pf.baseUrl === baseUrl && pf.config
        ? pf.config
        : fetch(baseUrl + "config.json", fetchOpts),
      "web config",
    );
    // JEL-1977: stale-while-revalidate body cache for /web/index.html +
    // /web/config.json. When the gate flag is on and LS holds a valid
    // entry for this server origin, resolve indexPromise/configPromise
    // immediately from cache and treat the in-flight fetch as background
    // revalidation that updates LS for the next boot. Eliminates the
    // /web/ RTT pair (200–500 ms on cold HTTP cache) from the pre-
    // document.write critical path. Off by default — set
    // `jellyfin.shell.indexCache='1'` post-QA parity smoke.
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
      // head IIFE already kicked off (or that we just issued above) and
      // update LS so the next boot adopts fresh bodies. Errors are
      // non-fatal — stale cache stays in place.
      indexFetch
        .then(function (r) {
          return r && r.ok ? r.text() : null;
        })
        .then(function (txt) {
          if (
            typeof txt === "string" &&
            txt.length &&
            txt !== cachedIndex.body
          ) {
            writeWebIndexCache(serverUrl, txt);
          }
          if (revalStart) {
            try {
              window.__shellIndexCacheSavedMs = Date.now() - revalStart;
            } catch (_) {}
          }
        })
        .catch(function () {});
      configFetch
        .then(function (r) {
          return r && r.ok ? r.text() : null;
        })
        .then(function (txt) {
          if (
            typeof txt === "string" &&
            txt.length &&
            txt !== cachedConfig.body
          ) {
            writeWebConfigCache(serverUrl, txt);
          }
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
      : indexFetch
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
      : configFetch
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
    // JEL-134: vault restore joins the document.write gate so jellyfin-web
    // always boots against restored creds. It overlaps the index/config
    // RTTs (IDB read is ~ms) and is 3 s-bounded, never-rejecting — it can
    // delay boot only when the network is faster than IndexedDB.
    var credsRestorePromise = restoreCredsVault();
    return Promise.all([indexPromise, configPromise, credsRestorePromise]).then(
      function (results) {
        var html = results[0];
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

  function showError(msg) {
    var err = document.getElementById("boot-error");
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

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

  function attachConnectForm() {
    injectConnectStylesheet();
    // JEL-934 (v51): #boot-root is `display:none` by default in
    // index.html so warm boot never paints the unstyled form during
    // the /web/ RTT. Reveal it now: this path runs only when the
    // form actually needs to render (first launch, or saved-server
    // failure recovery after clearServerUrl()).
    var rootEl = document.getElementById("boot-root");
    if (rootEl) rootEl.style.display = "block";
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

    var stored = loadServerUrl();
    if (stored) {
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
