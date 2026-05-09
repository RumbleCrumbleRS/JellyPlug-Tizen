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

  var SERVER_URL_KEY = "jellyfin.shell.serverUrl";
  var hasTizen = typeof window.tizen !== "undefined";
  var hasWebapis = typeof window.webapis !== "undefined";

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
  //   AppHost: init, appName, appVersion, deviceId, deviceName, exit,
  //            getDefaultLayout, getDeviceProfile, getSyncProfile, screen,
  //            supports
  //   Top-level: enableFullscreen, disableFullscreen, openUrl,
  //              updateMediaSession, hideMediaSession, downloadFile,
  //              getPlugins
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

  function appVersion() {
    try {
      return tizen.application.getCurrentApplication().appInfo.version;
    } catch (e) {
      return "0.0.1";
    }
  }

  var AppInfo = {
    deviceId: getDeviceId(),
    deviceName: "Samsung Smart TV",
    appName: "Jellyfin Shell for Tizen",
    appVersion: appVersion(),
  };

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
        return getSystemInfo().then(function () {
          return AppInfo;
        });
      },
      appName: function () {
        return AppInfo.appName;
      },
      appVersion: function () {
        return AppInfo.appVersion;
      },
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

  // Per JEL-144: NEVER hand-author the plugins[] list. Bare names without the
  // `/plugin` suffix don't resolve in pluginManager.loadPlugin (which does
  // `import('../plugins/${spec}')`), and a hand-rolled list also drops any
  // server-installed web plugins. Always fetch the real `${server}/web/config.json`
  // and override only `servers` + `multiserver`.
  function buildSeedScript(serverUrl, baseConfig) {
    // Runs INSIDE the rewritten document, before jellyfin-web's own scripts.
    // Intercepts XMLHttpRequest + fetch for config.json so jellyfin-web's
    // webSettings.getConfig() sees servers:[serverUrl]. That makes
    // serverAddress() resolve to our server and ServerConnections.initApiClient()
    // get called automatically -- so the user lands directly on the server's
    // login UI without a second "Add Server" entry.
    var merged = {};
    if (baseConfig && typeof baseConfig === "object") {
      for (var k in baseConfig) {
        if (Object.prototype.hasOwnProperty.call(baseConfig, k)) {
          merged[k] = baseConfig[k];
        }
      }
    }
    merged.servers = [serverUrl];
    merged.multiserver = false;
    // JEL-401 (supersedes JEL-206): we no longer strip non-builtin plugin
    // specs on old Chromium. Server plugins are loaded as <script> tags
    // injected into /web/index.html, not via cfg.plugins[]; the strip
    // filter never matched for the upstream-builtin specs in cfg.plugins
    // anyway. Plugin scripts that use ES2020+ syntax are transpiled by
    // transpileLegacyScripts() before document.write — see below.
    var SAFE = JSON.stringify(serverUrl);
    var CFG_JSON = JSON.stringify(merged);
    return [
      "(function(){",
      "  var S=" + SAFE + ";",
      "  var CFG=" + JSON.stringify(CFG_JSON) + ";",
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
      "})();",
    ].join("\n");
  }

  // Fetch the real web/config.json so we can preserve the server's
  // plugins[], themes[], menuLinks[] and any other future fields. The
  // shell only ever overrides `servers` + `multiserver`. If the fetch
  // fails (older server, network blip), fall back to an empty base
  // object — jellyfin-web will treat missing fields as defaults rather
  // than crashing.
  function loadRemoteConfig(serverUrl) {
    return fetch(serverUrl + "/web/config.json", {
      cache: "no-store",
      credentials: "omit",
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function () {
        return {};
      });
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
    // Feature probe: build a script that uses ES2020 optional chaining.
    // If the engine cannot parse it, we are on a legacy WebView regardless
    // of what the UA string claims.
    try {
      // eslint-disable-next-line no-new-func
      new Function("var a={};return a?.b");
      return false;
    } catch (e) {
      return true;
    }
  }

  function isJellyfinWebBundle(src) {
    var bare = String(src || "").split("?")[0];
    if (/\.bundle\.js$/i.test(bare)) return true;
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
        presets: [["env", { targets: { chrome: "56" }, modules: false }]],
        sourceType: "script",
        compact: true,
        comments: false,
      }).code;
    } catch (e) {
      try {
        console.warn("shell: babel transpile failed", e && e.message);
      } catch (_) {}
      return null;
    }
  }

  // Inject runtime polyfills for Web APIs that Chromium 56 lacks but that
  // server plugins (JellyfinEnhanced etc.) call at runtime. Babel handles
  // syntax (?.  ??) but cannot polyfill built-ins; we must add them here.
  // Only injected when isLegacyChromium() is true so modern TVs see no cost.
  //
  // Confirmed needed (JEL-401 follow-up):
  //   Promise.allSettled  — Chrome 76; used in /JellyfinEnhanced/script
  //   Object.fromEntries  — Chrome 73; common in plugin init code
  //   Array.prototype.flat/flatMap — Chrome 69; data-pipeline helpers
  //   queueMicrotask      — Chrome 71; async scheduling in plugins
  //   globalThis          — Chrome 71; module compat shim
  function injectChromium56Polyfills(doc) {
    if (!isLegacyChromium()) return;
    var polyfillTag = doc.createElement("script");
    polyfillTag.textContent = [
      "(function(){",
      // Promise.allSettled
      "if(!Promise.allSettled){",
      "  Promise.allSettled=function(ps){",
      "    return Promise.all(ps.map(function(p){",
      "      return Promise.resolve(p).then(",
      "        function(v){return{status:'fulfilled',value:v};},",
      "        function(r){return{status:'rejected',reason:r};});",
      "    }));};",
      "}",
      // Object.fromEntries
      "if(!Object.fromEntries){",
      "  Object.fromEntries=function(it){",
      "    var o={};",
      "    Array.from(it).forEach(function(kv){o[kv[0]]=kv[1];});",
      "    return o;};",
      "}",
      // Array.prototype.flat
      "if(!Array.prototype.flat){",
      "  Array.prototype.flat=function(d){",
      "    d=d===undefined?1:Math.floor(d);",
      "    if(d<1)return Array.prototype.slice.call(this);",
      "    return [].concat.apply([],Array.prototype.map.call(this,function(v){",
      "      return Array.isArray(v)&&d>1?v.flat(d-1):[v];}));};",
      "}",
      // Array.prototype.flatMap
      "if(!Array.prototype.flatMap){",
      "  Array.prototype.flatMap=function(f,t){",
      "    return Array.prototype.map.call(this,f,t).flat(1);};",
      "}",
      // queueMicrotask
      "if(!window.queueMicrotask){",
      "  window.queueMicrotask=function(fn){Promise.resolve().then(fn);};",
      "}",
      // globalThis
      "if(typeof globalThis==='undefined'){",
      "  Object.defineProperty(Object.prototype,'__globalThis__',{get:function(){return this;},configurable:true});",
      "  globalThis=__globalThis__;",
      "  delete Object.prototype.__globalThis__;",
      "}",
      "})();",
    ].join("\n");
    polyfillTag.setAttribute("data-shell-polyfill", "1");
    // Insert directly after the seed script (which is after the base tag).
    var seedTag = doc.querySelector("script[data-shell-seed]");
    if (seedTag && seedTag.nextSibling) {
      doc.head.insertBefore(polyfillTag, seedTag.nextSibling);
    } else if (seedTag) {
      doc.head.appendChild(polyfillTag);
    } else {
      doc.head.insertBefore(polyfillTag, doc.head.firstChild);
    }
    shellLog("injected polyfills for Chromium 56");
  }

  function transpileLegacyScripts(doc, baseUrl) {
    var legacy = isLegacyChromium();
    var hasBabel = typeof window.Babel !== "undefined";
    shellLog("transpile gate: legacy=" + legacy + " babel=" + hasBabel);
    if (!legacy) return Promise.resolve();
    if (!hasBabel) {
      try {
        console.warn(
          "shell: legacy Chromium detected but Babel not loaded — server plugins using ES2020+ syntax will fail to parse",
        );
      } catch (_) {}
      return Promise.resolve();
    }
    var scripts = Array.prototype.slice.call(doc.querySelectorAll("script"));
    var jobs = scripts.map(function (s) {
      if (s.getAttribute("data-shell-seed") === "1") return null;
      var src = s.getAttribute("src");
      if (src) {
        if (isJellyfinWebBundle(src)) return null;
        var url;
        try {
          url = new URL(src, baseUrl).href;
        } catch (_) {
          return null;
        }
        return fetch(url, { cache: "no-store", credentials: "omit" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.text();
          })
          .then(function (code) {
            var out = babelTranspile(code);
            if (out == null) return;
            // Inline the transpiled code instead of swapping `src` to a blob:
            // URL. Two reasons (JEL-401 follow-up):
            //   1. Chromium 56's document.open()/document.write() handoff can
            //      invalidate Blob URL bindings created on the prior document,
            //      so <script src="blob:..."> resolves to about:blank and the
            //      plugin silently never executes.
            //   2. The default Tizen widget CSP (`default-src 'self'`) blocks
            //      `blob:` and `data:` script sources unless the widget opts
            //      in, which we don't.
            // Inline scripts execute at parse time; defer/async on the
            // original tag are dropped, but server plugins are typically
            // self-contained DOM/CSS injectors and tolerate earlier
            // execution. Original src is preserved on a data attribute for
            // diagnostics.
            s.removeAttribute("src");
            s.removeAttribute("defer");
            s.removeAttribute("async");
            s.removeAttribute("type");
            s.textContent = out;
            s.setAttribute("data-shell-transpiled-from", url);
            shellLog("transpiled+inlined", url);
          })
          .catch(function (e) {
            try {
              console.warn("shell: skip transpile", url, e && e.message);
            } catch (_) {}
          });
      }
      var content = s.textContent || "";
      if (!content || !content.replace(/\s/g, "")) return null;
      var transpiled = babelTranspile(content);
      if (transpiled != null && transpiled !== content) {
        s.textContent = transpiled;
        s.setAttribute("data-shell-transpiled-inline", "1");
        shellLog("transpiled inline script");
      }
      return null;
    });
    return Promise.all(jobs);
  }

  function loadRemoteWebClient(serverUrl) {
    var baseUrl = serverUrl + "/web/";
    return Promise.all([
      fetch(baseUrl + "index.html", {
        cache: "no-store",
        credentials: "omit",
      }).then(function (r) {
        if (!r.ok)
          throw new Error("Failed to fetch web client (HTTP " + r.status + ")");
        return r.text();
      }),
      loadRemoteConfig(serverUrl),
    ]).then(function (results) {
      var html = results[0];
      var baseConfig = results[1];
      var doc = new DOMParser().parseFromString(html, "text/html");
      // Force <base href> so relative links resolve to the server.
      var existingBase = doc.querySelector("base");
      if (existingBase) existingBase.remove();
      var baseTag = doc.createElement("base");
      baseTag.href = baseUrl;
      doc.head.insertBefore(baseTag, doc.head.firstChild);
      // Seed config.json BEFORE any jellyfin-web script runs so the
      // user only enters the server URL once (in the shell).
      var seedTag = doc.createElement("script");
      seedTag.setAttribute("data-shell-seed", "1");
      seedTag.textContent = buildSeedScript(serverUrl, baseConfig);
      if (baseTag.nextSibling)
        doc.head.insertBefore(seedTag, baseTag.nextSibling);
      else doc.head.appendChild(seedTag);
      injectChromium56Polyfills(doc);
      return transpileLegacyScripts(doc, baseUrl).then(function () {
        window.__jellyfinShellBootDone = true;
        document.open("text/html", "replace");
        document.write("<!DOCTYPE html>" + doc.documentElement.outerHTML);
        document.close();
      });
    });
  }

  // ---- Connect screen flow ----------------------------------------------

  function showError(msg) {
    var err = document.getElementById("boot-error");
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

  function attachConnectForm() {
    var form = document.getElementById("server-form");
    var input = document.getElementById("server-input");
    if (!form || !input) return;

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
      // Try to resume directly; on failure fall back to the connect screen.
      validateServer(stored)
        .then(function () {
          return loadRemoteWebClient(stored);
        })
        .catch(function () {
          clearServerUrl();
          attachConnectForm();
          showError("Saved server is unreachable. Enter a new address.");
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
