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
      seedTag.textContent = buildSeedScript(serverUrl, baseConfig);
      if (baseTag.nextSibling)
        doc.head.insertBefore(seedTag, baseTag.nextSibling);
      else doc.head.appendChild(seedTag);
      window.__jellyfinShellBootDone = true;
      document.open("text/html", "replace");
      document.write("<!DOCTYPE html>" + doc.documentElement.outerHTML);
      document.close();
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
