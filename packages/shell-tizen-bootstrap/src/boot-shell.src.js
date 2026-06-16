(function () {
  "use strict";
  try {
    window.__shellT0 || (window.__shellT0 = Date.now());
  } catch (_) {}
  var SERVER_URL_KEY = "jellyfin.shell.serverUrl",
    hasTizen = typeof window.tizen != "undefined",
    hasWebapis = typeof window.webapis != "undefined",
    MODERN_SYNTAX_RE_SRC =
      "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{",
    MODERN_SYNTAX_RE = new RegExp(MODERN_SYNTAX_RE_SRC),
    BABEL_OPTS_KEY =
      "presets:[[env,{targets:{chrome:63},modules:false,loose:true}]];sourceType:script;compact:true;comments:false",
    BABEL_FPR =
      "2451554:2166756e6374696f6e2865297b696628766f696420303d3d3d652e70726f6365:6973262628676c6f62616c546869732e426162656c3d6a62292c6a627d28293b";
  function txFnv1a(s) {
    for (var h = 2166136261, i = 0; i < s.length; i++)
      ((h ^= s.charCodeAt(i)),
        (h =
          (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0));
    return h.toString(36);
  }
  // JEL-178: cache-epoch salt. Bumping this string changes TX_VER, which
  // changes TX_PFX, which orphans EVERY prior transpile-cache entry on the
  // next boot (they fall under a dead prefix and get LRU-pruned). Bumped to
  // "jel178-2" alongside the move to content-addressed keying for cache-busted
  // plugin scripts, so any entry an older shell wrote under a URL/path key is
  // abandoned rather than replayed.
  var TX_CACHE_EPOCH = "jel178-2";
  var TX_VER = txFnv1a(
      MODERN_SYNTAX_RE_SRC +
        "|" +
        BABEL_OPTS_KEY +
        "|" +
        BABEL_FPR +
        "|" +
        TX_CACHE_EPOCH,
    ),
    TX_PFX = "shell.tx" + TX_VER + ":";
  try {
    window.__TXVER = TX_VER;
  } catch (_) {}
  var BUNDLE_CACHE_KEY = "jellyfin.shell.bundlePatchState",
    BUNDLE_CACHE_VER = "1.0.87",
    MAIN_BUNDLE_BODY_MAX = 3 * 1024 * 1024;
  function readBundlePatchState() {
    try {
      var raw = localStorage.getItem(BUNDLE_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return !p || p.v !== BUNDLE_CACHE_VER ? null : p;
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
    state.body &&
      state.body.length <= MAIN_BUNDLE_BODY_MAX &&
      ((rec.body = state.body),
      state.needsPatch &&
        typeof state.patches == "number" &&
        (rec.patches = state.patches));
    try {
      localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(rec));
      return;
    } catch (_) {
      try {
        window.__shellMainBundleQuotaErr = 1;
      } catch (__) {}
    }
    if (rec.body) {
      (delete rec.body, delete rec.patches);
      try {
        localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(rec));
      } catch (__) {}
    }
  }
  var VENDORS_BUNDLE_CACHE_KEY = "jellyfin.shell.vendorsBundlePatchState",
    VENDORS_BUNDLE_BODY_MAX = 2 * 1024 * 1024,
    VENDORS_BUNDLE_RE = /(?:^|\/)vendors\.[^/]*\.bundle\.js$/i;
  function readVendorsBundleState() {
    try {
      var raw = localStorage.getItem(VENDORS_BUNDLE_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return !p || p.v !== BUNDLE_CACHE_VER ? null : p;
    } catch (_) {
      return null;
    }
  }
  function writeVendorsBundleState(state) {
    var rec = {
      v: BUNDLE_CACHE_VER,
      url: state.url,
      needsPatch: !!state.needsPatch,
    };
    state.body &&
      state.body.length <= VENDORS_BUNDLE_BODY_MAX &&
      (rec.body = state.body);
    try {
      localStorage.setItem(VENDORS_BUNDLE_CACHE_KEY, JSON.stringify(rec));
      return;
    } catch (_) {
      try {
        window.__shellVendorsBundleQuotaErr = 1;
      } catch (__) {}
    }
    if (rec.body) {
      delete rec.body;
      try {
        localStorage.setItem(VENDORS_BUNDLE_CACHE_KEY, JSON.stringify(rec));
      } catch (__) {}
    }
  }
  var WEB_INDEX_CACHE_KEY = "jellyfin.shell.webIndexHtml",
    WEB_CONFIG_CACHE_KEY = "jellyfin.shell.webConfig",
    // JEL-178: bumped 1.0.87 -> 1.0.88 to orphan any web-index HTML cached
    // before the JS-Injector write-guard landed (those entries may have a
    // stale snippet baked in).
    WEB_CACHE_VER = "1.0.88",
    WEB_CACHE_MAX = 262144,
    WEB_CACHE_GATE_KEY = "jellyfin.shell.indexCache";
  function webCacheEnabled() {
    try {
      return localStorage.getItem(WEB_CACHE_GATE_KEY) === "1";
    } catch (_) {
      return !1;
    }
  }
  function readWebIndexCache(serverOrigin) {
    try {
      var raw = localStorage.getItem(WEB_INDEX_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return !p ||
        p.v !== WEB_CACHE_VER ||
        p.origin !== serverOrigin ||
        typeof p.body != "string" ||
        !p.body.length
        ? null
        : p;
    } catch (_) {
      return null;
    }
  }
  function writeWebIndexCache(serverOrigin, body) {
    if (
      typeof body == "string" &&
      // JEL-178: never persist a web-index HTML that has a transpiled plugin
      // script inlined into it. Any such inline is a point-in-time snapshot of
      // that plugin's body; replaying cached HTML on a later boot would ignore
      // a config change. Plugin-agnostic (keys off the shell's own inline
      // marker, not any plugin name).
      body.indexOf("data-shell-transpiled-from") < 0 &&
      !(body.length < 1024) &&
      !(body.length > WEB_CACHE_MAX) &&
      !(body.indexOf("<html") < 0 && body.indexOf("<HTML") < 0)
    ) {
      var rec = {
        v: WEB_CACHE_VER,
        origin: serverOrigin,
        ts: Date.now(),
        size: body.length,
        body,
      };
      try {
        localStorage.setItem(WEB_INDEX_CACHE_KEY, JSON.stringify(rec));
      } catch (_) {}
    }
  }
  function readWebConfigCache(serverOrigin) {
    try {
      var raw = localStorage.getItem(WEB_CONFIG_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (
        !p ||
        p.v !== WEB_CACHE_VER ||
        p.origin !== serverOrigin ||
        typeof p.body != "string" ||
        !p.body.length
      )
        return null;
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
    if (
      typeof bodyText == "string" &&
      !(bodyText.length < 2 || bodyText.length > WEB_CACHE_MAX)
    ) {
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
  }
  var STYLESHEET_BODIES_KEY = "jellyfin.shell.stylesheetBodies",
    STYLESHEET_CACHE_VER = "1.0.87",
    STYLESHEET_TOTAL_MAX = 262144,
    STYLESHEET_PER_MAX = 196608;
  function readStylesheetBodies(serverOrigin) {
    try {
      var raw = localStorage.getItem(STYLESHEET_BODIES_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return !p ||
        p.v !== STYLESHEET_CACHE_VER ||
        p.origin !== serverOrigin ||
        !p.items ||
        typeof p.items != "object"
        ? null
        : p;
    } catch (_) {
      return null;
    }
  }
  function writeStylesheetBodies(serverOrigin, items) {
    var rec = {
      v: STYLESHEET_CACHE_VER,
      origin: serverOrigin,
      ts: Date.now(),
      items,
    };
    try {
      return (
        localStorage.setItem(STYLESHEET_BODIES_KEY, JSON.stringify(rec)),
        !0
      );
    } catch (_) {
      try {
        window.__shellCssInlineQuota = 1;
      } catch (__) {}
      return !1;
    }
  }
  function recordStylesheetBodies(stylesheetUrls, serverOrigin) {
    if (!(!stylesheetUrls || !stylesheetUrls.length)) {
      var cache = readStylesheetBodies(serverOrigin),
        prevItems = (cache && cache.items) || {},
        keep = {},
        i;
      for (i = 0; i < stylesheetUrls.length; i++) keep[stylesheetUrls[i]] = 1;
      var items = {},
        prevKeys = Object.keys(prevItems);
      for (i = 0; i < prevKeys.length; i++)
        keep[prevKeys[i]] && (items[prevKeys[i]] = prevItems[prevKeys[i]]);
      var misses = [];
      for (i = 0; i < stylesheetUrls.length; i++)
        items[stylesheetUrls[i]] || misses.push(stylesheetUrls[i]);
      if (!misses.length) {
        Object.keys(items).length < prevKeys.length &&
          writeStylesheetBodies(serverOrigin, items);
        return;
      }
      Promise.all(
        misses.map(function (u) {
          return fetch(u, { credentials: "include" })
            .then(function (r) {
              return r.ok ? r.text() : null;
            })
            .then(function (txt) {
              typeof txt != "string" ||
                !txt.length ||
                txt.length > STYLESHEET_PER_MAX ||
                txt.indexOf("</style") >= 0 ||
                (items[u] = { body: txt, size: txt.length, ts: Date.now() });
            })
            .catch(function () {});
        }),
      ).then(function () {
        var keys = Object.keys(items),
          total = 0;
        for (i = 0; i < keys.length; i++)
          total += (items[keys[i]] && items[keys[i]].size) || 0;
        for (; total > STYLESHEET_TOTAL_MAX && keys.length > 0; ) {
          var biggestKey = null,
            biggestSize = 0;
          for (i = 0; i < keys.length; i++) {
            var sz = (items[keys[i]] && items[keys[i]].size) || 0;
            sz > biggestSize && ((biggestSize = sz), (biggestKey = keys[i]));
          }
          if (biggestKey === null) break;
          (delete items[biggestKey],
            (total -= biggestSize),
            keys.splice(keys.indexOf(biggestKey), 1));
        }
        writeStylesheetBodies(serverOrigin, items);
      });
    }
  }
  function rewriteStylesheetsFromCache(doc, baseUrl, serverOrigin) {
    for (
      var cache = readStylesheetBodies(serverOrigin),
        items = (cache && cache.items) || {},
        links = doc.querySelectorAll('link[rel="stylesheet"]'),
        hits = 0,
        misses = 0,
        bytes = 0,
        i = 0;
      i < links.length;
      i++
    ) {
      var ln = links[i],
        href = ln.getAttribute("href");
      if (href && !/^(?:data|blob|javascript):/i.test(href)) {
        var url;
        try {
          url = new URL(href, baseUrl).href;
        } catch (_) {
          continue;
        }
        if (serverOrigin) {
          var origin;
          try {
            origin = new URL(url).origin;
          } catch (_) {
            continue;
          }
          if (origin !== serverOrigin) continue;
        }
        var item = items[url];
        if (
          item &&
          typeof item.body == "string" &&
          item.body.indexOf("</style") < 0
        ) {
          var styleEl = doc.createElement("style");
          (styleEl.setAttribute("data-shell-css-from-cache", "1"),
            styleEl.setAttribute("data-shell-css-url", url),
            (styleEl.textContent = item.body),
            ln.parentNode.replaceChild(styleEl, ln),
            hits++,
            (bytes += item.body.length));
        } else misses++;
      }
    }
    (hits > 0 &&
      ((window.__shellCssInlineAdopted = 1),
      (window.__shellCssInlineHits = (window.__shellCssInlineHits || 0) + hits),
      (window.__shellCssInlineBytes =
        (window.__shellCssInlineBytes || 0) + bytes)),
      misses > 0 &&
        (window.__shellCssInlineMisses =
          (window.__shellCssInlineMisses || 0) + misses));
  }
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
    } catch (e) {}
  }
  function clearServerUrl() {
    try {
      localStorage.removeItem(SERVER_URL_KEY);
    } catch (e) {}
  }
  var BOOT_FETCH_TIMEOUT_MS = 15000;
  var CONNECT_FETCH_TIMEOUT_MS = 5000;
  function withBootTimeout(p, label, ms) {
    return new Promise(function (resolve, reject) {
      var settled = !1,
        timer = setTimeout(function () {
          settled ||
            ((settled = !0),
            reject(new Error("Timed out reaching server (" + label + ")")));
        }, ms || BOOT_FETCH_TIMEOUT_MS);
      Promise.resolve(p).then(
        function (v) {
          settled || ((settled = !0), clearTimeout(timer), resolve(v));
        },
        function (e) {
          settled || ((settled = !0), clearTimeout(timer), reject(e));
        },
      );
    });
  }
  function normalizeServerUrl(input) {
    var url = String(input || "").trim();
    return url
      ? (/^https?:\/\//i.test(url) || (url = "http://" + url),
        url.replace(/\/+$/, ""))
      : "";
  }
  function validateServer(serverUrl) {
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
          if (!info || !info.Id || !info.Version)
            throw new Error("Not a Jellyfin server");
          return info;
        }),
      "connect",
      CONNECT_FETCH_TIMEOUT_MS,
    );
  }
  function registerRemoteKeys() {
    if (!(!hasTizen || !tizen.tvinputdevice)) {
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
        } catch (e) {}
      });
    }
  }
  function installBackHandler() {
    window.addEventListener("keydown", function (ev) {
      if (ev.keyCode === 10009) {
        if (window.__jellyfinShellBootDone) return;
        (ev.preventDefault(), exitApp());
      }
    });
  }
  function exitApp() {
    if (hasTizen && tizen.application)
      try {
        tizen.application.getCurrentApplication().exit();
        return;
      } catch (e) {}
    window.close();
  }
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
      } catch (e) {}
    }
    return id;
  }
  var systeminfo = null;
  function getSystemInfo() {
    return systeminfo
      ? Promise.resolve(systeminfo)
      : !hasTizen || !tizen.systeminfo
        ? ((systeminfo = { resolutionWidth: 1920, resolutionHeight: 1080 }),
          Promise.resolve(systeminfo))
        : new Promise(function (resolve) {
            tizen.systeminfo.getPropertyValue(
              "DISPLAY",
              function (result) {
                var ratio = 1;
                try {
                  hasWebapis &&
                    webapis.productinfo &&
                    (typeof webapis.productinfo.is8KPanelSupported ==
                      "function" && webapis.productinfo.is8KPanelSupported()
                      ? (ratio = 4)
                      : typeof webapis.productinfo.isUdPanelSupported ==
                          "function" &&
                        webapis.productinfo.isUdPanelSupported() &&
                        (ratio = 2));
                } catch (e) {}
                ((systeminfo = {
                  resolutionWidth: Math.floor(result.resolutionWidth * ratio),
                  resolutionHeight: Math.floor(result.resolutionHeight * ratio),
                }),
                  resolve(systeminfo));
              },
              function () {
                ((systeminfo = {
                  resolutionWidth: 1920,
                  resolutionHeight: 1080,
                }),
                  resolve(systeminfo));
              },
            );
          });
  }
  var AppInfo = {
      deviceId: getDeviceId(),
      deviceName: "Tizen TV",
      appName: "Jellyfin for Tizen",
    },
    SupportedFeatures = [
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
  // Resolve deviceName from the TV's BUILD model; fall back to the "Tizen TV"
  // constant on any failure. Runs in parallel with getSystemInfo() before init
  // resolves. Mirrors shell.js.
  var deviceNameResolved = null;
  function resolveDeviceName() {
    if (deviceNameResolved) return deviceNameResolved;
    if (!hasTizen || !tizen.systeminfo)
      return (deviceNameResolved = Promise.resolve(AppInfo.deviceName));
    return (deviceNameResolved = new Promise(function (resolve) {
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
    }));
  }
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
          enableMkvProgressive: !1,
          enableSsaRender: !0,
        });
      },
      getSyncProfile: function (profileBuilder) {
        return profileBuilder({ enableMkvProgressive: !1 });
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
    enableFullscreen: function () {},
    disableFullscreen: function () {},
    openUrl: function () {},
    updateMediaSession: function () {},
    hideMediaSession: function () {},
    getPlugins: function () {
      return [];
    },
    downloadFile: function () {},
    selectServer: function () {
      (clearServerUrl(), window.location.replace("index.html"));
    },
  };
  function buildSeedScript(serverUrl, upstreamCfg) {
    var cfg = Object.assign({}, upstreamCfg || {}, {
        servers: [serverUrl],
        multiserver: !1,
      }),
      SAFE = JSON.stringify(serverUrl),
      CFG_JSON = JSON.stringify(JSON.stringify(cfg));
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
      '  try{localStorage.setItem("layout","tv");}catch(_){}',
      `  try{(function(){var K={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Up:1,Down:1,Left:1,Right:1,Tab:1},C={9:1,37:1,38:1,39:1,40:1,29460:1,29461:1,29462:1,29463:1},S='a[href]:not([tabindex="-1"]),button:not(:disabled):not([tabindex="-1"]),input:not([type=range]):not([type=file]):not([tabindex="-1"]):not(:disabled),select:not([tabindex="-1"]):not(:disabled),textarea:not([tabindex="-1"]):not(:disabled),.focusable:not([tabindex="-1"])';function vis(n){if(!n)return false;if(n.offsetParent===null&&n.tagName!=="BODY")return false;var r=n.getBoundingClientRect&&n.getBoundingClientRect();return !!(r&&r.width>0&&r.height>0);}function fst(s){if(!s||!s.querySelectorAll)return null;try{var n=s.querySelectorAll(S);for(var i=0;i<n.length;i++)if(vis(n[i]))return n[i];}catch(_){}return null;}function scopes(){var out=[];try{var d=document.querySelectorAll(".dialogContainer .dialog.opened");if(d.length)out.push(d[d.length-1]);}catch(_){}try{var p=document.querySelectorAll(".page:not(.hide)");for(var i=p.length-1;i>=0;i--)if(p[i]&&p[i].offsetParent!==null)out.push(p[i]);}catch(_){}try{var hsel=[".skinHeader",".headerTop",".mainAnimatedPages",".pageContainer","#reactRoot","#appLayer"];for(var hi=0;hi<hsel.length;hi++){var h=document.querySelector(hsel[hi]);if(h)out.push(h);}}catch(_){}out.push(document.body);return out;}function findT(){try{var st=document.getElementById("__shellST");if(st){var r=st.getBoundingClientRect&&st.getBoundingClientRect();if(r&&r.width>0&&r.height>0){window.__shellLastScopeHit=99;return st;}}}catch(_){}var sc=scopes();window.__shellLastScopeN=sc.length;for(var i=0;i<sc.length;i++){var t=fst(sc[i]);if(t){window.__shellLastScopeHit=i;return t;}}window.__shellLastScopeHit=-1;return null;}function isBodyF(){var a=document.activeElement;return !a||a===document.body||a.tagName==="HTML";}function isAuthed(){if(window.__shellAFForceAuth===1)return true;try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return false;var p=JSON.parse(c);return !!(p&&p.Servers&&p.Servers.length&&p.Servers[0].AccessToken);}catch(_){return false;}}window.addEventListener("keydown",function(e){if(!e||!(K[e.key]||C[e.keyCode]||C[e.which]))return;if(!isBodyF())return;window.__shellBodyFocusRescueAttempts=(window.__shellBodyFocusRescueAttempts||0)+1;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellBodyFocusRescues=(window.__shellBodyFocusRescues||0)+1;e.preventDefault();e.stopPropagation();}}}catch(_){}},true);window.__shellBodyFocusRescueBound=1;window.__shellAutoFocusAttempts=0;window.__shellAutoFocusSuccesses=0;window.__shellAutoFocusBudget=24;function bumpAF(){window.__shellAutoFocusBudget=24;}try{window.addEventListener("hashchange",bumpAF,false);}catch(_){}try{window.addEventListener("popstate",bumpAF,false);}catch(_){}var lastBody=true;setInterval(function(){var nowBody=isBodyF();if(nowBody&&!lastBody)bumpAF();lastBody=nowBody;try{var st=document.getElementById("__shellST");if(st){if(document.activeElement!==st){window.__shellAutoFocusAttempts++;try{st.focus();}catch(_){}if(document.activeElement===st){window.__shellAutoFocusSuccesses++;window.__shellLastScopeHit=99;}}return;}}catch(_){}if(!nowBody)return;if((window.__shellAutoFocusBudget||0)<=0)return;if(!isAuthed())return;window.__shellAutoFocusAttempts++;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellAutoFocusSuccesses++;window.__shellAutoFocusBudget=0;return;}}}catch(_){}window.__shellAutoFocusBudget--;},600);})();}catch(_){}`,
      // JEL-138: default the login "Remember Me" checkbox to CHECKED.
      // jellyfin-web's `enableAutoLogin` flag is sticky — one unchecked login
      // flips it to "false" and every later login form renders the box
      // unchecked; OSK Enter submits from the password field without passing
      // the (D-pad-only-visible) checkbox, so each Enter-login silently drops
      // the token at the next launch. Board decision (JEL-138 interaction
      // c0b35a10 = "default_checked"): start the box checked each time the
      // login screen appears; an explicit uncheck for that login still works.
      // We touch only the checkbox DOM state, never the stored flag —
      // jellyfin-web reads chkRememberLogin.checked at SUBMIT and writes the
      // flag itself, so restoreCredsVault()'s `enableAutoLogin === "false"`
      // opt-out gate keeps honoring a genuine opt-out. jellyfin-web applies
      // the stored-false state AFTER creating the element, so we re-assert
      // checked on a poll until a real `change` (user toggle; programmatic
      // sets don't fire change) reveals a deliberate uncheck, then back off.
      // Kill switch: localStorage["jellyfin.shell.rememberMeDefaultDisabled"]="1".
      // Diag: window.__shellRememberMeChecks.
      `  try{(function(){if(localStorage.getItem("jellyfin.shell.rememberMeDefaultDisabled")==="1")return;window.__shellRememberMeChecks=0;var bound=new WeakSet(),userOff=new WeakSet();function nudge(){try{var c=document.querySelector(".manualLoginForm .chkRememberLogin")||document.querySelector(".chkRememberLogin");if(!c)return;if(!bound.has(c)){bound.add(c);c.addEventListener("change",function(){if(!c.checked){userOff.add(c);}else{userOff["delete"](c);}},false);}if(userOff.has(c))return;if(!c.checked){c.checked=true;window.__shellRememberMeChecks++;}}catch(_){}}try{setInterval(nudge,300);}catch(_){}try{document.addEventListener("DOMContentLoaded",nudge,false);}catch(_){}nudge();})();}catch(_){}`,
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
      "    var __modernRe=/\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{/;",
      '    function needsTx(code){return typeof code==="string"&&__modernRe.test(code);}',
      '    function transpile(code){if(typeof window.Babel==="undefined")return null;try{return window.Babel.transform(code,{presets:[["env",{targets:{chrome:"63"},modules:false,loose:true}]],assumptions:{iterableIsArray:true,arrayLikeIsIterable:true},sourceType:"script",compact:true,comments:false}).code;}catch(_){return null;}}',
      "    function maybeTranspile(code){if(!needsTx(code)){try{window.__shellTxSkipCount=(window.__shellTxSkipCount||0)+1;}catch(_){}return code;}try{window.__shellTxDoCount=(window.__shellTxDoCount||0)+1;}catch(_){}return transpile(code);}",
      "    var __TXVER=" + JSON.stringify(TX_VER) + ";",
      "    try{window.__TXVER=__TXVER;}catch(_){}",
      '    var __TXPFX="shell.tx"+__TXVER+":";',
      '    var __TXLRUKEY="shell.txLru"+__TXVER;',
      // JEL-178: drop ONLY the per-load epoch-ms cache-buster (JE's
      // ?v=Date.now()); keep config-version tokens (JS-Injector .NET ticks,
      // HomeScreen plugin version) so toggling a plugin's config cache-misses
      // instead of replaying a stale transpiled body. Lockstep with the TV
      // shell's txKey / __txKey (JEL-26).
      '    function __txKey(s){var u=String(s||"");var i=u.indexOf("?");if(i<0)return u;var path=u.substring(0,i);var pairs=u.substring(i+1).split("&");var keep=[];var now=Date.now();for(var pi=0;pi<pairs.length;pi++){var p=pairs[pi];if(!p)continue;var eq=p.indexOf("=");var val=eq<0?p:p.substring(eq+1);if(/^[0-9]{12,14}$/.test(val)){var n=parseInt(val,10);if(n>0&&Math.abs(n-now)<6048e5)continue;}keep.push(p);}return keep.length?path+"?"+keep.join("&"):path;}',
      "    function __txLru(){try{var v=localStorage.getItem(__TXLRUKEY);return v?JSON.parse(v):{};}catch(_){return{};}}",
      "    function __txPersistLru(m){try{localStorage.setItem(__TXLRUKEY,JSON.stringify(m));}catch(_){}}",
      '    function __txGet(src){if(String(src).indexOf("?")>=0)return null;try{var k=__txKey(src);var v=localStorage.getItem(__TXPFX+k);if(v!=null){window.__shellTxCacheHits=(window.__shellTxCacheHits||0)+1;var m=__txLru();m[k]=Date.now();__txPersistLru(m);}else{window.__shellTxCacheMisses=(window.__shellTxCacheMisses||0)+1;try{var __miss=window.__shellTxCacheMissUrls;if(!__miss){__miss=[];window.__shellTxCacheMissUrls=__miss;}if(__miss.length<10)__miss.push(src);}catch(_){}}return v;}catch(_){return null;}}',
      "    function __txPrune(){try{var m=__txLru();var keys=Object.keys(m);if(!keys.length)return;keys.sort(function(a,b){return m[a]-m[b];});var n=Math.min(keys.length,10);for(var i=0;i<n;i++){try{localStorage.removeItem(__TXPFX+keys[i]);}catch(_){}delete m[keys[i]];}__txPersistLru(m);}catch(_){}}",
      '    function __txSet(src,body){if(String(src).indexOf("?")>=0)return;if(typeof body!=="string"||body.length>262144)return;var k=__txKey(src);try{localStorage.setItem(__TXPFX+k,body);var m=__txLru();m[k]=Date.now();__txPersistLru(m);}catch(e){__txPrune();try{localStorage.setItem(__TXPFX+k,body);var m2=__txLru();m2[k]=Date.now();__txPersistLru(m2);}catch(__){}}}',
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
      '          var __p=needsTx(code)&&typeof window.__ensureBabel==="function"?window.__ensureBabel():Promise.resolve(true);',
      "          return __p.then(function(){",
      "            var out=maybeTranspile(code);",
      "            if(out==null){",
      "              try{parent.removeChild(stub);}catch(_){}",
      '              try{console.warn("shell: dynamic transpile failed",src);}catch(_){}',
      '              dispatchEvt(node,"error");',
      "              return;",
      "            }",
      '            node.removeAttribute("src");node.removeAttribute("type");node.removeAttribute("defer");node.removeAttribute("async");',
      "            var gated=needsJq(out);",
      "            var body=gated?wrapJq(out):out;",
      "            node.textContent=body;",
      '            node.setAttribute("data-shell-transpiled-from",src);',
      '            if(gated)node.setAttribute("data-shell-jquery-gated","1");',
      "            try{parent.replaceChild(node,stub);}catch(_){try{parent.appendChild(node);}catch(__){}}",
      "            __txSet(src,body);",
      '            dispatchEvt(node,"load");',
      "          });",
      "        })",
      "        .catch(function(err){",
      "          try{parent.removeChild(stub);}catch(_){}",
      '          try{console.warn("shell: dynamic fetch/transpile failed",src,err&&err.message);}catch(_){}',
      '          dispatchEvt(node,"error");',
      "        });",
      "      return ret;",
      "    }",
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
      "    function srcPipeline(node,src){",
      "      if(node.__shellPiped)return;",
      "      node.__shellPiped=true;",
      "      __recDyn(src);",
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
      '          var __p=needsTx(code)&&typeof window.__ensureBabel==="function"?window.__ensureBabel():Promise.resolve(true);',
      "          return __p.then(function(){",
      "            var out=maybeTranspile(code);",
      '            if(out==null){try{console.warn("shell: setter transpile failed",src);}catch(_){}dispatchEvt(node,"error");return;}',
      '            var ns=document.createElement("script");',
      "            var gated=needsJq(out);",
      "            var body=gated?wrapJq(out):out;",
      "            ns.textContent=body;",
      '            ns.setAttribute("data-shell-transpiled-from",src);',
      '            if(gated)ns.setAttribute("data-shell-jquery-gated","1");',
      "            var parent=node.parentNode||document.head||document.documentElement;",
      "            try{if(node.parentNode)parent.insertBefore(ns,node.nextSibling);else parent.appendChild(ns);}",
      "            catch(_){try{(document.head||document.documentElement).appendChild(ns);}catch(__){}}",
      "            __txSet(src,body);",
      '            dispatchEvt(node,"load");',
      "          });",
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
      // JEL-187: media bar carousel stops auto-rotating on TV after the first
      // slide. The home "media bar" / EditorsChoice spotlight carousel uses
      // Splide (@4.1.4) and never sets pauseOnFocus/pauseOnHover, so both take
      // Splide's defaults of TRUE. On a TV the D-pad focus lands inside the
      // carousel and never leaves (no blur), so Splide's focusin handler pauses
      // autoplay permanently — it advances once (slide 1 -> 2) then is stuck.
      // A desktop browser is pointer-driven (no sticky focus) so it keeps
      // rotating, which is why this only reproduces on the TV. Restore
      // auto-rotation by wrapping the global Splide constructor BEFORE the
      // plugin's `new Splide(...)` runs and forcing pauseOnFocus:false +
      // pauseOnHover:false; with those false Splide never even binds the
      // focus/hover listeners (the `if(options.pauseOnFocus)` guard), so focus
      // can never pause it. Generic: keys only off the `window.Splide` global,
      // no plugin-name coupling. Applies on every Tizen build (the sticky-focus
      // model is TV-wide, not Chromium-version specific). keyboard:true D-pad
      // nav is untouched — only the autoplay timer's pause-on-focus is removed.
      // Kill switch: localStorage["jellyfin.shell.splideFocusPauseDisabled"]="1".
      "  try{(function(){",
      '    try{if(localStorage.getItem("jellyfin.shell.splideFocusPauseDisabled")==="1")return;}catch(_){}',
      "    if(window.__shellSplideFocusShim)return;window.__shellSplideFocusShim=1;",
      "    var _S;",
      "    function wrap(S){",
      "      if(!S||S.__shellNoFocusPause)return S;",
      "      function W(sel,opts){",
      "        opts=opts||{};",
      "        try{opts.pauseOnFocus=false;opts.pauseOnHover=false;}catch(_){}",
      "        try{window.__shellSplideWrapped=(window.__shellSplideWrapped||0)+1;}catch(_){}",
      "        return new S(sel,opts);",
      "      }",
      "      try{W.prototype=S.prototype;}catch(_){}",
      "      try{for(var k in S){if(Object.prototype.hasOwnProperty.call(S,k))W[k]=S[k];}}catch(_){}",
      "      W.__shellNoFocusPause=1;",
      "      return W;",
      "    }",
      "    if(window.Splide){_S=wrap(window.Splide);}",
      "    try{",
      '      Object.defineProperty(window,"Splide",{configurable:true,',
      "        get:function(){return _S;},",
      "        set:function(v){_S=wrap(v);}});",
      "    }catch(_){try{if(window.Splide)window.Splide=_S;}catch(__){}}",
      "  })();}catch(_){}",
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
      '    try{window.addEventListener("error",function(e){try{var m=String((e&&e.message)||(e&&e.error&&e.error.message)||"");if(/serverId|item or serverId|cannot be null/i.test(m)){window.__qaBtnPlay.err=("E:"+m).slice(0,90);}}catch(_){}},true);}catch(_){}',
      '    try{window.addEventListener("unhandledrejection",function(e){try{var r=e&&e.reason;var m=String((r&&r.message)||r||"");if(/serverId|item or serverId|cannot be null/i.test(m)){window.__qaBtnPlay.err=("R:"+m).slice(0,90);if(r&&r.stack){window.__qaBtnPlay.errStack=String(r.stack).slice(0,600);}}}catch(_){}},true);}catch(_){}',
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
      '        "RS:"+((window.__shellBodyFocusRescueAttempts)||0)+"/"+((window.__shellBodyFocusRescues)||0)+" b="+((window.__shellBodyFocusRescueBound)||0),',
      '        "AF:"+((window.__shellAutoFocusAttempts)||0)+"/"+((window.__shellAutoFocusSuccesses)||0)+" sc="+((window.__shellLastScopeHit!=null)?window.__shellLastScopeHit:-1)+"/"+((window.__shellLastScopeN)||0)+" bg="+((window.__shellAutoFocusBudget)||0),',
      '        "RE:"+((window.__shellRegElCalls)||0)+"/"+((window.__shellRegElErrors)||0),',
      '        "ST:"+((window.__shellSelfTest&&window.__shellSelfTest.r)||"-")+" t="+((window.__shellSelfTest&&window.__shellSelfTest.t)||0)+" af="+((window.__shellSelfTest&&window.__shellSelfTest.af)||0)+" sc="+((window.__shellSelfTest&&window.__shellSelfTest.sc!=null)?window.__shellSelfTest.sc:-1),',
      '        "SBP:"+((window.__shellSecondaryBundlePrefetch)||0)+"/"+(function(){try{return JSON.parse(localStorage.getItem("jellyfin.shell.secondaryBundleUrls")||"[]").length;}catch(_){return 0;}})(),',
      '        "SS:"+((window.__shellStylesheetPrefetch)||0)+"/"+(function(){try{return JSON.parse(localStorage.getItem("jellyfin.shell.stylesheetUrls")||"[]").length;}catch(_){return 0;}})(),',
      '        "PL:"+((window.__shellPreloadScripts)||0)+"/"+((window.__shellPreloadSecondaries)||0)+"/"+((window.__shellPreloadStylesheets)||0)+"/"+(((window.__shellPreloadScripts)||0)+((window.__shellPreloadSecondaries)||0)+((window.__shellPreloadStylesheets)||0)),',
      '        "CSS:"+((window.__shellCssInlineAdopted)||0)+"/"+((window.__shellCssInlineHits)||0)+" b="+((window.__shellCssInlineBytes)||0)+" m="+((window.__shellCssInlineMisses)||0)+" q="+((window.__shellCssInlineQuota)||0),',
      '        "FP:"+((window.__shellFastPathHits)||0)+"/"+((window.__shellFastPathFallbacks)||0)+" tx="+((window.__shellFastPathTxInlines)||0)+" lb="+((window.__shellFastPathLastBail)||"-"),',
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
      '    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",schedule);',
      "    else schedule();",
      "  })();}catch(_){}",
      "  window.__shellCMPatched=0;",
      "  window.__shellPMPatched=0;",
      "  window.__shellCMTries=0;",
      "  try{",
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
      '        if(options==null||typeof options!=="object"){',
      '          try{console.warn("shell: pm.play called with no options ("+(options===undefined?"undefined":typeof options)+") \u2014 dispatch ignored");}catch(_){}',
      "          return Promise.resolve();",
      "        }",
      "        try{",
      "          if(options.items&&options.items.length){",
      "            var clean=[];",
      "            for(var ii=0;ii<options.items.length;ii++){if(options.items[ii]!=null)clean.push(options.items[ii]);}",
      "            if(!clean.length&&(!options.ids||!options.ids.length)){",
      '              try{console.warn("shell: pm.play items array had only null/undefined entries \u2014 dispatch ignored");}catch(_){}',
      "              return Promise.resolve();",
      "            }",
      "            options.items=clean;",
      "          } else if((!options.items||!options.items.length)&&(!options.ids||!options.ids.length)){",
      '            try{console.warn("shell: pm.play called with no items[] and no ids[] \u2014 dispatch ignored");}catch(_){}',
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
      '                try{console.warn("shell: pm.play item still missing MediaType (Id="+(mit.Id||"?")+" Type="+(mit.Type||"?")+" Name="+(mit.Name||"?")+") \u2014 getPlayer will return no player. dispatching anyway for diagnostics.");}catch(_){}',
      "              }",
      "            }",
      "          }",
      "        }catch(_){}",
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
      "          if(window.__shellPMPlayCount<=8){try{console.warn(__dispatch);}catch(_){}}",
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
      "            if(!window.__shellForceLoadVideoP){",
      "              window.__shellForceLoadVideoP=true;",
      "              try{window.__shellForceLoadVideoCount=(window.__shellForceLoadVideoCount||0)+1;}catch(_){}",
      '              try{console.warn("shell: roster has 0 Video players \u2014 force-loading htmlVideoPlayer/plugin via pluginManager");}catch(_){}',
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
      '        try{if(typeof cand==="object"&&!window.__shellCMPatched&&__shellLooksLikeCM(cand)&&!cand.__shellWrap){__shellPatchCMInst(cand);window.__shellCMPatched++;found++;}}catch(_){}',
      "        try{if(__shellLooksLikePM(cand)&&!cand.__shellPMWrap){__shellPatchPM(cand);window.__shellPMPatched++;found++;}}catch(_){}",
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
      '          else window.__shellCMErr="noApiClient";',
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
      "        // First, try cache if non-empty (defensive)",
      "        if(wr.c){",
      "          try{for(var id in wr.c){__shellScanModule(wr.c[id]);}}catch(_){}",
      "        }",
      "        // Always walk wr.m \u2014 webpack 5 exposes the factory registry here.",
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
    ].join(`
`);
  }
  function isLegacyChromium() {
    var ua = navigator.userAgent || "",
      m = /(?:Chrome|Chromium)\/(\d+)\./.exec(ua);
    if (m && parseInt(m[1], 10) < 70) return !0;
    try {
      return (new Function("var a={};return a?.b"), !1);
    } catch (e) {
      return !0;
    }
  }
  function isJellyfinWebBundle(src) {
    var bare = String(src || "").split("?")[0];
    return !!(
      /\.bundle\.js$/i.test(bare) ||
      /\.chunk\.js$/i.test(bare) ||
      /(^|\/)serviceworker\.js$/i.test(bare)
    );
  }
  var SHELL_DEBUG = !1;
  try {
    SHELL_DEBUG = localStorage.getItem("jellyfin.shell.debug") === "1";
  } catch (e) {}
  function shellLog() {
    if (SHELL_DEBUG)
      try {
        var args = Array.prototype.slice.call(arguments);
        (args.unshift("[shell]"), console.log.apply(console, args));
      } catch (_) {}
  }
  function babelTranspile(src) {
    try {
      return window.Babel.transform(src, {
        presets: [
          ["env", { targets: { chrome: "63" }, modules: !1, loose: !0 }],
        ],
        assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
        sourceType: "script",
        compact: !0,
        comments: !1,
      }).code;
    } catch (e) {
      try {
        console.warn("shell: babel transpile failed", e && e.message);
      } catch (_) {}
      return null;
    }
  }
  var JQUERY_REF_RE = /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/;
  function needsJQueryGate(code) {
    return JQUERY_REF_RE.test(code);
  }
  function wrapForJQuery(code) {
    return [
      "(function(){",
      "function __run(){",
      code,
      `
}`,
      'if(typeof window.jQuery!=="undefined"){__run();return;}',
      "var __to;",
      "var __t=setInterval(function(){",
      'if(typeof window.jQuery!=="undefined"){clearInterval(__t);clearTimeout(__to);try{__run();}catch(e){try{console.error("shell: deferred plugin failed",e&&e.message);}catch(_){}}}',
      "},20);",
      '__to=setTimeout(function(){clearInterval(__t);try{console.warn("shell: jQuery wait timed out, running anyway");}catch(_){}try{__run();}catch(e){try{console.error("shell: deferred plugin failed",e&&e.message);}catch(_){}}},10000);',
      "})();",
    ].join("");
  }
  function buildDiagSeedScript(shellVersion) {
    return [
      "(function(){",
      "if(window.__shellDiag)return;",
      "var MAX=30;",
      'window.__shellDiag={errors:[],warns:[],stats:{ua:(navigator.userAgent||"").slice(0,80),scriptsFound:0,transpiled:0,transpileFailed:0,skipped:0}};',
      "window.__shellT={t0:(window.__shellT0||Date.now()),dcl:0,api:0,card:0};",
      "function __tm(k){if(!window.__shellT[k])window.__shellT[k]=Date.now()-window.__shellT.t0;}",
      'document.addEventListener("DOMContentLoaded",function(){__tm("dcl");});',
      'var __apiPoll=setInterval(function(){if(window.ApiClient){__tm("api");clearInterval(__apiPoll);}},100);',
      "setTimeout(function(){clearInterval(__apiPoll);},30000);",
      'var __cardPoll=setInterval(function(){try{if(document.querySelector(".card")){__tm("card");clearInterval(__cardPoll);}}catch(_){}},200);',
      "setTimeout(function(){clearInterval(__cardPoll);},60000);",
      'function trimUrl(u){u=String(u||"");var m=/\\/([^\\/?#]+)(\\?|#|$)/.exec(u);return m?m[1]:u.slice(-30);}',
      "function fmt(s){",
      '  if(s==null)return"";',
      '  if(typeof s==="string")return s.length>140?s.slice(0,140)+"\u2026":s;',
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
      '  if(asStr&&asStr!=="[object Object]"&&asStr!=="[object Response]")return asStr.length>140?asStr.slice(0,140)+"\u2026":asStr;',
      '  try{var j=JSON.stringify(s);if(j)return j.length>140?j.slice(0,140)+"\u2026":j;}catch(_){}',
      '  return asStr||"[unstringable]";',
      "}",
      "function pushErr(rec){var d=window.__shellDiag;if(d.errors.length>=MAX)d.errors.shift();d.errors.push(rec);}",
      "function pushWarn(rec){var d=window.__shellDiag;if(d.warns.length>=MAX)d.warns.shift();d.warns.push(rec);}",
      'window.addEventListener("error",function(e){var st="";try{st=(e.error&&e.error.stack)?String(e.error.stack).replace(/\\s+/g," ").slice(0,240):"";}catch(_){}pushErr({f:trimUrl(e.filename),l:(e.lineno||0)+":"+(e.colno||0),m:fmt((e.message)||(e.error&&e.error.message))+(st?" @ "+st:"")});},true);',
      "var origErr=console.error,origWarn=console.warn;",
      'window.addEventListener("unhandledrejection",function(e){',
      "  var r=e&&e.reason;var msg=fmt(r);",
      '  pushErr({f:"reject",l:0,m:msg});',
      "  try{e.preventDefault();}catch(_){}",
      '  try{origErr.call(console,"shell: unhandled rejection:",msg);}catch(_){}',
      "});",
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
      // JEL-131: pr= prime counters f/t/e/q(+stop reason) from
      // window.__shellTxPrime — "-" when the primer is disabled/absent.
      '    "tx h="+(window.__shellTxCacheHits||0)+" m="+(window.__shellTxCacheMisses||0)+" sk="+(window.__shellTxSkipCount||0)+" do="+(window.__shellTxDoCount||0)+" tv="+(window.__TXVER||"?")+" pr="+(function(){var P=window.__shellTxPrime;return P?P.f+"/"+P.t+"/"+P.e+"/"+P.q+(P.st?":"+P.st:""):"-";})(),',
      '    "IC:"+(window.__shellIndexCacheRecords||0)+"/"+(window.__shellIndexCacheHits||0)+" ms="+(window.__shellIndexCacheSavedMs||0)+" a="+(window.__shellWebIndexCacheAdopted||0),',
      '    "MB:"+(window.__shellMainBundleLSAdopted||0)+"/"+(window.__shellMainBundleInlineHits||0)+" b="+(window.__shellMainBundleLSBytes||0)+" q="+(window.__shellMainBundleQuotaErr||0),',
      '    "VB:"+(window.__shellVendorsBundleLSAdopted||0)+"/"+(window.__shellVendorsBundleInlineHits||0)+" b="+(window.__shellVendorsBundleLSBytes||0)+" q="+(window.__shellVendorsBundleQuotaErr||0),',
      '    "CSS:"+(window.__shellCssInlineAdopted||0)+"/"+(window.__shellCssInlineHits||0)+" b="+(window.__shellCssInlineBytes||0)+" m="+(window.__shellCssInlineMisses||0)+" q="+(window.__shellCssInlineQuota||0),',
      '    "BUS:"+(window.__shellBabelUnusedStreak||0)+" bp="+(window.__shellBabelPreload==null?"-":window.__shellBabelPreload)+" be="+(window.__shellBabelEager==null?"-":window.__shellBabelEager)+" sk="+(window.__shellBabelPrimeSkipped||0)+" df="+(window.__shellBabelDeferAppend==null?"-":window.__shellBabelDeferAppend)+" pbl="+((init.pluginBabelLazy)||0)+" bl="+((init.babelLazyTriggered)||0),',
      '    "FP:"+(window.__shellFastPathHits||0)+"/"+(window.__shellFastPathFallbacks||0)+" tx="+(window.__shellFastPathTxInlines||0)+" lb="+(window.__shellFastPathLastBail||"-"),',
      '    "ic="+(window.__shellInterceptCount||0)+" a="+(window.__icAppend||0)+" s="+(window.__icSetter||0)+" sa="+(window.__icSetAttr||0),',
      '    "t dcl="+(T.dcl||0)+" api="+(T.api||0)+" card="+(T.card||0)+" now="+nowMs,',
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
    ].join(`
`);
  }
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
      // JEL-111: the one-shot install proved insufficient on the M63 — the
      // home screen still died with "Invalid attempt to iterate non-iterable
      // instance" / "elements is not iterable" AFTER sign-in (infinite
      // spinner). On-device beacon probes (v2.0.5 QA build) pinned the
      // mechanism: iterators are healthy through boot and login, then the
      // LAZY home-route chunks (76542/56213/73233 on jellyfin-web 10.11.11)
      // rebind the DOM collection constructors during eval —
      // NodeList.prototype[Symbol.iterator] reads `undefined` while
      // window.Symbol stays native — and home renders (and dies) in the
      // same breath. A delayed sweep was observed to restore iterators on
      // 17 prototypes and stop the errors, but any timer-based heal races
      // the render that follows the clobber within the same task. Fix in
      // three layers: (1) DETERMINISTIC setter traps on window.<ctor> —
      // the instant a bundle reassigns a collection constructor, patch the
      // replacement's prototype synchronously, before any render can run;
      // (2) a 250ms sweep interval for the first 90s, then 3s maintenance,
      // as backstop for clobbers that bypass assignment (e.g. defineProperty
      // replacing the trap; JEL-21's details-route throw is this same
      // class); (3) the original install-when-missing sweep at parse + DCL.
      // The `armed` latch keeps a re-executed copy from stacking intervals
      // or nesting traps. Counters on window.__shellIterFix let the QA
      // beacon prove liveness (pass/installed/trapped/trapHits).
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
    ].join(`
`);
  }
  function injectChromium56Polyfills(doc) {
    if (isLegacyChromium()) {
      var polyfillTag = doc.createElement("script");
      ((polyfillTag.textContent = chromium56PolyfillBody()),
        polyfillTag.setAttribute("data-shell-polyfill", "1"));
      var seedTag = doc.querySelector("script[data-shell-seed]");
      seedTag && seedTag.nextSibling
        ? doc.head.insertBefore(polyfillTag, seedTag.nextSibling)
        : seedTag
          ? doc.head.appendChild(polyfillTag)
          : doc.head.insertBefore(polyfillTag, doc.head.firstChild);
    }
  }
  function qaBeaconBody() {
    return "/* JEL-1971: QA HTTP beacon \u2014 outbound DOM telemetry channel for the hourly\n * scout. Replaces `0 debug` AUL handshake (capped at ~2 sessions per TV boot,\n * see JEL-1969) and persistent WebInspector (Samsung silently ignores\n * `web-inspector=\"enable\"` on consumer Tizen 5.0 release-signed WGTs, see\n * JEL-1970).\n *\n * Outbound HTTP works from the Tizen web app sandbox unrestricted because\n * config.xml `<access origin=\"*\">` is already set. The QA host listens on a\n * fixed LAN port and persists each POST as a JSON line; scout polls\n * `GET /latest?serial=...` for current state.\n *\n * Gating:\n *   - off unless localStorage['jellyfin.qa.overlay'] === '1' (same flag as\n *     the QA HUD overlay). Production builds never trip the gate because\n *     index.html sets it only on QA-flavored WGTs.\n *   - beacon URL overridable via localStorage['jellyfin.qa.beaconUrl'];\n *     default `http://192.168.0.20:8731/qa-beacon`.\n *   - tick paused when document.hidden (no telemetry while app backgrounded).\n *   - deferred 5 s post-DOMContentLoaded so cold-boot critical path stays\n *     untouched.\n */\n(function(){\n    try {\n        if (localStorage.getItem('jellyfin.qa.overlay') !== '1') return;\n    } catch (e) { return; }\n\n    var DEFAULT_URL = 'http://192.168.0.20:8731/qa-beacon';\n    var TICK_MS = 4000;\n    var START_DELAY_MS = 5000;\n    var MAX_TEXT_LEN = 120;\n    var MAX_ERRORS = 20;\n\n    var beaconUrl;\n    try { beaconUrl = localStorage.getItem('jellyfin.qa.beaconUrl') || DEFAULT_URL; }\n    catch (e) { beaconUrl = DEFAULT_URL; }\n\n    var serial = null;\n    try {\n        if (typeof webapis !== 'undefined' && webapis.productinfo && typeof webapis.productinfo.getDuid === 'function') {\n            serial = webapis.productinfo.getDuid();\n        }\n    } catch (e) {}\n    if (!serial) {\n        try {\n            serial = localStorage.getItem('jellyfin.qa.beaconSerial');\n            if (!serial) {\n                serial = 'shell-' + Math.random().toString(36).slice(2, 10);\n                try { localStorage.setItem('jellyfin.qa.beaconSerial', serial); } catch (_) {}\n            }\n        } catch (e) { serial = 'shell-unknown'; }\n    }\n\n    var errors = [];\n    var seenErrors = {};\n    function pushError(s) {\n        if (!s) return;\n        s = String(s).slice(0, 400);\n        if (seenErrors[s]) return;\n        seenErrors[s] = 1;\n        errors.push(s);\n        if (errors.length > MAX_ERRORS) errors.shift();\n    }\n    try {\n        window.addEventListener('error', function(ev){\n            try {\n                var msg = ev && ev.error && ev.error.stack ? String(ev.error.stack).split('\\n').slice(0,3).join(' @@ ') : (ev && ev.message) || '';\n                if (msg) pushError(msg);\n            } catch (_) {}\n        }, true);\n        window.addEventListener('unhandledrejection', function(ev){\n            try {\n                var r = ev && ev.reason;\n                var msg = r && r.stack ? String(r.stack).split('\\n').slice(0,3).join(' @@ ') : (r && r.message) || String(r || '');\n                if (msg) pushError('unhandled: ' + msg);\n            } catch (_) {}\n        }, true);\n    } catch (e) {}\n\n    function descActive() {\n        try {\n            var el = document.activeElement;\n            if (!el) return null;\n            var r = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;\n            var txt = '';\n            try { txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN); } catch (_) {}\n            return {\n                tag: el.tagName || null,\n                id: el.id || '',\n                className: (typeof el.className === 'string') ? el.className.slice(0, MAX_TEXT_LEN) : '',\n                textContent: txt,\n                rect: r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null\n            };\n        } catch (_) { return null; }\n    }\n\n    function getHudText() {\n        try {\n            var hud = document.getElementById('__qa_hud');\n            if (!hud) return null;\n            return (hud.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500);\n        } catch (_) { return null; }\n    }\n\n    function getQcState() {\n        try {\n            var creds = localStorage.getItem('jellyfin_credentials');\n            if (creds) {\n                var p = JSON.parse(creds);\n                var s = p && p.Servers && p.Servers[0];\n                if (s && s.AccessToken) return 'loggedIn';\n            }\n        } catch (_) {}\n        try {\n            if (document.querySelector('.btnUseQuickConnect, .qcCode')) return 'quickConnect';\n        } catch (_) {}\n        try {\n            if (document.querySelector('.manualLoginForm, .loginForm, #txtUserName, #txtManualName')) return 'manualLogin';\n        } catch (_) {}\n        try {\n            if (document.querySelector('.userItemContainer, .btnUser')) return 'userPicker';\n        } catch (_) {}\n        return 'unknown';\n    }\n\n    function countCards() {\n        try {\n            var n = document.querySelectorAll('.card, .listItem, .cardScalable').length;\n            return n;\n        } catch (_) { return -1; }\n    }\n\n    // JEL-1974 (v68): one-shot read of `jellyfin.qa.bootMarks.prior` \u2014\n    // the boot-mark IIFE in index.html rotated last boot's marks into\n    // this key. Beacon emits as payload.priorBootMarks on FIRST POST\n    // only, then nulls so subsequent 4 s ticks don't re-send (marks\n    // never change mid-boot). Server collector accepts arbitrary fields\n    // and persists into ndjson, so no schema change needed.\n    var priorBootMarks = null;\n    try {\n        var rawMarks = localStorage.getItem('jellyfin.qa.bootMarks.prior');\n        if (rawMarks) priorBootMarks = JSON.parse(rawMarks);\n    } catch (_) { priorBootMarks = null; }\n\n    function takePriorBootMarks() {\n        var v = priorBootMarks;\n        priorBootMarks = null;\n        return v;\n    }\n\n    function collectProbe() {\n        var p = {};\n        try { p.nl = typeof NodeList.prototype[Symbol.iterator]; } catch (e) { p.nl = 'ERR:' + String((e && e.message) || e).slice(0, 60); }\n        try { p.hc = typeof HTMLCollection.prototype[Symbol.iterator]; } catch (e) { p.hc = 'ERR:' + String((e && e.message) || e).slice(0, 60); }\n        try { p.symNat = String(window.Symbol).indexOf('native code') >= 0 ? 1 : 0; } catch (e) { p.symNat = -1; }\n        try { var nodes = document.querySelectorAll('html'); var seen = 0; for (var node of nodes) seen++; p.forof = 'ok:' + seen; } catch (e) { p.forof = String((e && e.message) || e).slice(0, 120); }\n        try { p.iterFix = window.__shellIterFix || null; } catch (e) { p.iterFix = null; }\n        try { var d = window.__shellDiag; p.diagErrs = d && d.errors && d.errors.length ? d.errors.slice(-3).map(function(r){ return (r.f || '') + ':' + (r.l || '') + ' ' + String(r.m || '').slice(0, 200); }) : null; } catch (e) { p.diagErrs = null; }\n        try { p.spin = document.querySelector('.docspinner, .mdlSpinner, .loading-spinner, .mdl-spinner') ? 1 : 0; } catch (e) { p.spin = -1; }\n        try { p.realCards = document.querySelectorAll('.card[data-id]').length; } catch (e) { p.realCards = -1; }\n        return p;\n    }\n\n    function buildPayload() {\n        var active = descActive();\n        var hud = getHudText();\n        var cards = countCards();\n        var snap = errors.slice(); // copy\n        errors.length = 0;\n        seenErrors = {};\n\n        var focus = null;\n        if (active && active.rect) {\n            focus = {y: active.rect.y, w: active.rect.w};\n        }\n\n        return {\n            ts: Date.now(),\n            serial: serial,\n            url: (location && location.href) || '',\n            title: document.title || '',\n            activeElement: active,\n            focus: focus,\n            hud: hud,\n            cards: cards,\n            errors: snap,\n            qcState: getQcState(),\n            probe: collectProbe(),\n            screenshotBase64: null,\n            ua: (navigator && navigator.userAgent) || '',\n            visibility: document.visibilityState || (document.hidden ? 'hidden' : 'visible'),\n            priorBootMarks: takePriorBootMarks()\n        };\n    }\n\n    var inflight = false;\n    function postOnce() {\n        if (inflight) return;\n        if (document.hidden) return;\n        inflight = true;\n        var body;\n        try { body = JSON.stringify(buildPayload()); }\n        catch (e) { inflight = false; return; }\n        try {\n            var xhr = new XMLHttpRequest();\n            xhr.open('POST', beaconUrl, true);\n            xhr.setRequestHeader('Content-Type', 'application/json');\n            xhr.timeout = 2500;\n            xhr.onloadend = function(){ inflight = false; };\n            xhr.ontimeout = function(){ inflight = false; };\n            xhr.onerror = function(){ inflight = false; };\n            xhr.send(body);\n        } catch (e) { inflight = false; }\n    }\n\n    function start() {\n        try { postOnce(); } catch (_) {}\n        setInterval(postOnce, TICK_MS);\n    }\n\n    if (document.readyState === 'complete' || document.readyState === 'interactive') {\n        setTimeout(start, START_DELAY_MS);\n    } else {\n        document.addEventListener('DOMContentLoaded', function(){ setTimeout(start, START_DELAY_MS); });\n    }\n\n    try {\n        window.__qaBeacon = {\n            post: postOnce,\n            url: function(){ return beaconUrl; },\n            serial: function(){ return serial; }\n        };\n    } catch (_) {}\n})();\n";
  }
  function injectQaBeacon(doc) {
    var body = qaBeaconBody();
    if (!(!body || body === "__QA_BEACON_BODY__")) {
      var beaconTag = doc.createElement("script");
      (beaconTag.setAttribute("data-shell-beacon", "1"),
        (beaconTag.textContent = body),
        doc.head.appendChild(beaconTag));
    }
  }
  // JEL-126: compositor-driven boot progress indicator for the written
  // document — three pulsing dots (CSS transform/opacity keyframes) that
  // keep animating through the ~20 s main-thread blackout while the M63
  // parses+executes the jellyfin-web bundles (JEL-125 decomposition).
  // Additive-defensive (full try/catch, pointer-events:none, aria-hidden),
  // removed by a 500 ms poll when jellyfin-web paints anything real
  // (selectors mirrored from qa-beacon.js; all view-rendered, none static
  // in jellyfin-web's index.html) with a 120 s hard cap. ES5, no
  // `</script>` literal (fast path splices it as HTML). Kill switch:
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
  function injectBootProgress(doc) {
    if (isLegacyChromium()) {
      var progressTag = doc.createElement("script");
      (progressTag.setAttribute("data-shell-boot-progress", "1"),
        (progressTag.textContent = bootProgressBody()),
        doc.head.appendChild(progressTag));
    }
  }
  var BABEL_NEEDED_KEY = "jellyfin.shell.legacy.babelNeeded",
    BABEL_UNUSED_STREAK_KEY = "jellyfin.shell.legacy.babelUnusedStreak";
  function markBabelNeeded() {
    try {
      localStorage.setItem(BABEL_NEEDED_KEY, "1");
    } catch (_) {}
  }
  function txKey(url) {
    var u = String(url || ""),
      i = u.indexOf("?");
    return i < 0 ? u : u.substring(0, i);
  }
  function txGetStatic(url) {
    try {
      var v = localStorage.getItem(TX_PFX + txKey(url));
      if (v == null) {
        var miss = window.__shellTxCacheMissUrlsStatic;
        (miss || ((miss = []), (window.__shellTxCacheMissUrlsStatic = miss)),
          miss.length < 10 && miss.push(url));
      }
      return v;
    } catch (_) {
      return null;
    }
  }
  function txSetStatic(url, body) {
    if (!(typeof body != "string" || body.length > 262144))
      try {
        localStorage.setItem(TX_PFX + txKey(url), body);
      } catch (_) {}
  }
  function needsTranspile(code) {
    return typeof code == "string" && MODERN_SYNTAX_RE.test(code);
  }
  function transpileLegacyScripts(doc, baseUrl) {
    var legacy = isLegacyChromium();
    if (!legacy) return Promise.resolve();
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
          var c = window.__shellDiagInit || {},
            prev = 0;
          try {
            prev =
              parseInt(
                localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0",
                10,
              ) || 0;
          } catch (_) {}
          var next = prev;
          if ((c.scriptsFound || 0) > 0) {
            (c.pluginBabelLazy || 0) === 0 &&
            (c.cachedHits || 0) === c.scriptsFound
              ? (next = prev + 1)
              : (next = 0);
            try {
              localStorage.setItem(BABEL_UNUSED_STREAK_KEY, String(next));
            } catch (_) {}
          }
          window.__shellBabelUnusedStreak = next;
        } catch (_) {}
        return r;
      },
      function (e) {
        throw e;
      },
    );
  }
  function ensureBabelReady() {
    var ensure =
        typeof window.__ensureBabel == "function"
          ? window.__ensureBabel
          : function () {
              return Promise.resolve();
            },
      p;
    try {
      p = ensure();
    } catch (_) {
      p = Promise.resolve();
    }
    return (
      (!p || typeof p.then != "function") && (p = Promise.resolve()),
      p.then(function () {
        var ok = typeof window.Babel != "undefined";
        if (ok)
          try {
            localStorage.setItem(BABEL_NEEDED_KEY, "1");
          } catch (_) {}
        return ok;
      })
    );
  }
  function transpileLegacyScriptsInner(doc, baseUrl) {
    var legacy = isLegacyChromium();
    shellLog(
      "transpile gate: legacy=" +
        legacy +
        " babel(initial)=" +
        (typeof window.Babel != "undefined"),
    );
    var scripts = Array.prototype.slice.call(doc.querySelectorAll("script")),
      counts = (window.__shellDiagInit = window.__shellDiagInit || {});
    ((counts.legacy = legacy),
      (counts.babel = typeof window.Babel != "undefined"),
      (counts.polyfilled = !0),
      (counts.scriptsFound = 0),
      (counts.transpiled = 0),
      (counts.transpileFailed = 0),
      (counts.skipped = 0),
      (counts.cachedHits = 0),
      (counts.fastPath = 0),
      (counts.babelLazyTriggered = 0),
      (counts.pluginBabelLazy = 0),
      (counts.pluginPrefetchAdopted = 0));
    for (
      var pluginPrefetch = window.__shellPluginPrefetch || null,
        pluginUrlsForNextBoot = [],
        pUi = 0;
      pUi < scripts.length && pluginUrlsForNextBoot.length < 100;
      pUi++
    ) {
      var pUs = scripts[pUi];
      if (
        pUs.getAttribute("data-shell-seed") !== "1" &&
        pUs.getAttribute("data-shell-diag") !== "1" &&
        !pUs.getAttribute("data-shell-bundle-patched")
      ) {
        var pUsrc = pUs.getAttribute("src");
        if (
          pUsrc &&
          !/^(?:data|blob|javascript):/i.test(pUsrc) &&
          !isJellyfinWebBundle(pUsrc)
        )
          try {
            var pUurl = new URL(pUsrc, baseUrl).href;
            pluginUrlsForNextBoot.push(pUurl);
          } catch (_) {}
      }
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.pluginUrls",
        JSON.stringify(pluginUrlsForNextBoot),
      );
    } catch (_) {}
    var sbServerOrigin = null;
    try {
      sbServerOrigin = new URL(baseUrl).origin;
    } catch (_) {}
    for (
      var secondaryBundleUrls = [],
        sbSeen = {},
        SB_MAIN_RE = /(?:^|\/)main\.[^/]*\.bundle\.js$/i,
        bUi = 0;
      bUi < scripts.length && secondaryBundleUrls.length < 20;
      bUi++
    ) {
      var bUs = scripts[bUi];
      if (
        bUs.getAttribute("data-shell-seed") !== "1" &&
        bUs.getAttribute("data-shell-diag") !== "1" &&
        !bUs.getAttribute("data-shell-bundle-patched")
      ) {
        var bUsrc = bUs.getAttribute("src");
        if (bUsrc && !/^(?:data|blob|javascript):/i.test(bUsrc)) {
          var bUbare = String(bUsrc).split("?")[0];
          if (/\.bundle\.js$/i.test(bUbare) && !SB_MAIN_RE.test(bUbare)) {
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
            sbSeen[bUurl] ||
              ((sbSeen[bUurl] = 1), secondaryBundleUrls.push(bUurl));
          }
        }
      }
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.secondaryBundleUrls",
        JSON.stringify(secondaryBundleUrls),
      );
    } catch (_) {}
    for (
      var ssLinks = doc.querySelectorAll('link[rel="stylesheet"]'),
        stylesheetUrls = [],
        ssSeen = {},
        lUi = 0;
      lUi < ssLinks.length && stylesheetUrls.length < 20;
      lUi++
    ) {
      var lUh = ssLinks[lUi].getAttribute("href");
      if (lUh && !/^(?:data|blob|javascript):/i.test(lUh)) {
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
        ssSeen[lUurl] || ((ssSeen[lUurl] = 1), stylesheetUrls.push(lUurl));
      }
    }
    try {
      localStorage.setItem(
        "jellyfin.shell.stylesheetUrls",
        JSON.stringify(stylesheetUrls),
      );
    } catch (_) {}
    try {
      recordStylesheetBodies(stylesheetUrls, sbServerOrigin);
    } catch (_) {}
    var jobs = scripts.map(function (s) {
      if (
        s.getAttribute("data-shell-seed") === "1" ||
        s.getAttribute("data-shell-diag") === "1"
      )
        return null;
      if (s.getAttribute("data-shell-bundle-patched"))
        return (counts.skipped++, null);
      var src = s.getAttribute("src");
      if (src) {
        if (isJellyfinWebBundle(src)) return (counts.skipped++, null);
        counts.scriptsFound++;
        var url;
        try {
          url = new URL(src, baseUrl).href;
        } catch (_) {
          return null;
        }
        var cached = url.indexOf("?") >= 0 ? null : txGetStatic(url);
        if (cached != null)
          return (
            s.removeAttribute("src"),
            s.removeAttribute("defer"),
            s.removeAttribute("async"),
            s.removeAttribute("type"),
            (s.textContent = cached),
            s.setAttribute("data-shell-transpiled-from", url),
            s.setAttribute("data-shell-tx-cached", "1"),
            counts.transpiled++,
            counts.cachedHits++,
            shellLog("cache hit", url),
            null
          );
        var pfPlugin = pluginPrefetch && pluginPrefetch[url],
          responsePromise;
        return (
          pfPlugin
            ? ((responsePromise = pfPlugin), counts.pluginPrefetchAdopted++)
            : (responsePromise = fetch(
                // JEL-178: a query string on a plugin script is a cache-buster
                // (?v=<tick/version>), i.e. the body is config-mutable. The M63
                // WebView does NOT honor fetch cache:"no-store" reliably, so
                // append a per-fetch unique token to force a real network read
                // (the server ignores unknown query params). Content-addressed
                // keying below then dedups the transpile, so this only costs a
                // download, not a re-transpile. Plugin-agnostic.
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
              )),
          responsePromise
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.text();
            })
            .then(function (code) {
              // JEL-178: content-addressed transpile cache key. A query-bearing
              // (cache-busted) URL is keyed by a hash of its current source, so
              // ANY plugin's config change yields a new key (re-transpile) while
              // unchanged content reuses the cached transpile. No plugin is
              // special-cased.
              var ck = url.indexOf("?") >= 0 ? "txc:" + txFnv1a(code) : url;
              var pre = txGetStatic(ck);
              if (pre != null) {
                (s.removeAttribute("src"),
                  s.removeAttribute("defer"),
                  s.removeAttribute("async"),
                  s.removeAttribute("type"),
                  (s.textContent = pre),
                  s.setAttribute("data-shell-transpiled-from", url),
                  s.setAttribute("data-shell-tx-cached", "1"),
                  counts.transpiled++,
                  counts.cachedHits++);
                return;
              }
              if (!needsTranspile(code)) {
                (s.removeAttribute("src"),
                  s.removeAttribute("defer"),
                  s.removeAttribute("async"),
                  s.removeAttribute("type"));
                var gatedRaw = needsJQueryGate(code),
                  bodyRaw = gatedRaw ? wrapForJQuery(code) : code;
                ((s.textContent = bodyRaw),
                  s.setAttribute("data-shell-transpiled-from", url),
                  s.setAttribute("data-shell-fast-path", "1"),
                  gatedRaw && s.setAttribute("data-shell-jquery-gated", "1"),
                  txSetStatic(ck, bodyRaw),
                  counts.transpiled++,
                  counts.fastPath++,
                  shellLog(
                    "fast-path+inlined",
                    url,
                    gatedRaw ? "(jq-gated)" : "",
                  ));
                return;
              }
              return (
                counts.babelLazyTriggered++,
                counts.pluginBabelLazy++,
                markBabelNeeded(),
                ensureBabelReady().then(function (ready) {
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
                  counts.babel = !0;
                  var out = babelTranspile(code);
                  if (out == null) {
                    counts.transpileFailed++;
                    return;
                  }
                  (counts.transpiled++,
                    s.removeAttribute("src"),
                    s.removeAttribute("defer"),
                    s.removeAttribute("async"),
                    s.removeAttribute("type"));
                  var gated = needsJQueryGate(out),
                    body = gated ? wrapForJQuery(out) : out;
                  ((s.textContent = body),
                    s.setAttribute("data-shell-transpiled-from", url),
                    gated && s.setAttribute("data-shell-jquery-gated", "1"),
                    txSetStatic(ck, body),
                    shellLog(
                      "transpiled+inlined",
                      url,
                      gated ? "(jq-gated)" : "",
                    ));
                })
              );
            })
            .catch(function (e) {
              counts.transpileFailed++;
              try {
                console.warn("shell: skip transpile", url, e && e.message);
              } catch (_) {}
            })
        );
      }
      var content = s.textContent || "";
      return !content || !content.replace(/\s/g, "")
        ? null
        : needsTranspile(content)
          ? (counts.babelLazyTriggered++,
            markBabelNeeded(),
            ensureBabelReady().then(function (ready) {
              if (!ready) {
                try {
                  console.warn(
                    "shell: babel not available, skip inline transpile",
                  );
                } catch (_) {}
                return;
              }
              counts.babel = !0;
              var transpiled = babelTranspile(content);
              transpiled != null &&
                transpiled !== content &&
                ((s.textContent = transpiled),
                s.setAttribute("data-shell-transpiled-inline", "1"),
                shellLog("transpiled inline script"));
            }))
          : (counts.fastPath++, null);
    });
    return Promise.all(jobs);
  }
  function buildBundleSourcePatcher() {
    var patterns = [
      /(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      /(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      /(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
      /(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['"])item or serverId cannot be null\3\s*\)/g,
    ];
    return function (source) {
      for (var total = 0, p = 0; p < patterns.length; p++)
        source = source.replace(
          patterns[p],
          function (_match, prefix, paramName) {
            return (
              total++,
              prefix +
                "try{if(" +
                paramName +
                "==null&&window.ApiClient)return window.ApiClient;if(" +
                paramName +
                "&&typeof " +
                paramName +
                '==="object"&&!' +
                paramName +
                '.ServerId&&window.ApiClient&&typeof window.ApiClient.serverId==="function")' +
                paramName +
                ".ServerId=window.ApiClient.serverId();}catch(_){}if(!" +
                paramName +
                ')throw new Error("item or serverId cannot be null")'
            );
          },
        );
      return { source, patches: total };
    };
  }
  function patchPlaybackBundles(doc, baseUrl, prefetched) {
    if (
      ((window.__shellBundlePatches = 0),
      (window.__shellBundlesScanned = 0),
      (window.__shellBundlesPatchedFiles = []),
      (window.__shellBundleHits = 0),
      (window.__shellBundleCacheHit = 0),
      (window.__shellBundleCacheBodyHit = 0),
      !isLegacyChromium())
    )
      return ((window.__shellBundlePatchSkipped = 1), Promise.resolve());
    var pfBundleUrl = prefetched && prefetched.url,
      pfBundleFetch = prefetched && prefetched.fetch;
    window.__shellBundlePrefetchAdopted = 0;
    var patcher = buildBundleSourcePatcher(),
      cache = readBundlePatchState(),
      vendorsCache = readVendorsBundleState(),
      scripts = Array.prototype.slice.call(doc.querySelectorAll("script[src]")),
      jobs = scripts.map(function (s) {
        var src = s.getAttribute("src");
        if (!src) return null;
        var bare = String(src).split("?")[0];
        if (!/\.bundle\.js$/i.test(bare) || /serviceworker/i.test(bare))
          return null;
        var isMain =
            /(^|\/)main\.[^/]*\.bundle\.js$/i.test(bare) ||
            /(^|\/)main\.jellyfin\.bundle\.js$/i.test(bare),
          isVendors = VENDORS_BUNDLE_RE.test(bare);
        if (!isMain && !isVendors) return null;
        var url;
        try {
          url = new URL(src, baseUrl).href;
        } catch (_) {
          return null;
        }
        if (isVendors)
          return vendorsCache &&
            vendorsCache.url === url &&
            vendorsCache.body &&
            vendorsCache.body.indexOf("</script") < 0
            ? (s.removeAttribute("src"),
              s.removeAttribute("defer"),
              s.removeAttribute("async"),
              s.removeAttribute("type"),
              (s.textContent = vendorsCache.body),
              s.setAttribute("data-shell-bundle-patched", url),
              s.setAttribute("data-shell-bundle-from-cache", "1"),
              s.setAttribute("data-shell-bundle-patches", "0"),
              window.__shellBundlesPatchedFiles.push(
                bare.split("/").pop() + ":vcache0",
              ),
              window.__shellBundleCacheHit++,
              window.__shellBundleCacheBodyHit++,
              (window.__shellVendorsBundleLSAdopted = 1),
              (window.__shellVendorsBundleInlineHits =
                (window.__shellVendorsBundleInlineHits || 0) + 1),
              (window.__shellVendorsBundleLSBytes = vendorsCache.body.length),
              null)
            : fetch(url, { credentials: "omit" })
                .then(function (r) {
                  if (!r.ok) throw new Error("HTTP " + r.status);
                  return r.text();
                })
                .then(function (code) {
                  (window.__shellBundlesScanned++,
                    writeVendorsBundleState({
                      url,
                      needsPatch: !1,
                      body: code,
                    }));
                })
                .catch(function (e) {
                  try {
                    console.warn(
                      "shell: vendors bundle fetch failed",
                      url,
                      e && e.message,
                    );
                  } catch (_) {}
                });
        if (cache && cache.url === url) {
          if (cache.body && cache.body.indexOf("</script") < 0) {
            (s.removeAttribute("src"),
              s.removeAttribute("defer"),
              s.removeAttribute("async"),
              s.removeAttribute("type"),
              (s.textContent = cache.body),
              s.setAttribute("data-shell-bundle-patched", url),
              s.setAttribute("data-shell-bundle-from-cache", "1"));
            var cachedPatches =
              cache.needsPatch &&
              typeof cache.patches == "number" &&
              cache.patches > 0
                ? cache.patches
                : 0;
            return (
              s.setAttribute(
                "data-shell-bundle-patches",
                String(cachedPatches),
              ),
              cachedPatches > 0 &&
                (window.__shellBundlePatches += cachedPatches),
              window.__shellBundlesPatchedFiles.push(
                bare.split("/").pop() + ":cache" + cachedPatches,
              ),
              window.__shellBundleCacheHit++,
              window.__shellBundleCacheBodyHit++,
              (window.__shellMainBundleLSAdopted = 1),
              (window.__shellMainBundleInlineHits =
                (window.__shellMainBundleInlineHits || 0) + 1),
              (window.__shellMainBundleLSBytes = cache.body.length),
              null
            );
          }
          if (!cache.needsPatch) return (window.__shellBundleCacheHit++, null);
        }
        var bundleFetch;
        return (
          pfBundleFetch && pfBundleUrl === url
            ? ((bundleFetch = pfBundleFetch),
              (window.__shellBundlePrefetchAdopted = 1))
            : (bundleFetch = fetch(url, { credentials: "omit" })),
          bundleFetch
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              try {
                localStorage.setItem("jellyfin.shell.bundleUrl", url);
              } catch (_) {}
              return r.text();
            })
            .then(function (code) {
              if (
                (window.__shellBundlesScanned++,
                code.indexOf("item or serverId cannot be null") < 0)
              ) {
                writeBundlePatchState({ url, needsPatch: !1, body: code });
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
              (s.removeAttribute("src"),
                s.removeAttribute("defer"),
                s.removeAttribute("async"),
                s.removeAttribute("type"),
                (s.textContent = result.source),
                s.setAttribute("data-shell-bundle-patched", url),
                s.setAttribute(
                  "data-shell-bundle-patches",
                  String(result.patches),
                ),
                (window.__shellBundlePatches += result.patches),
                window.__shellBundlesPatchedFiles.push(
                  bare.split("/").pop() + ":" + result.patches,
                ),
                writeBundlePatchState({
                  url,
                  needsPatch: !0,
                  body: result.source,
                  patches: result.patches,
                }));
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
            })
        );
      });
    return Promise.all(jobs);
  }
  function armDeferWatchdog() {
    var POLL = 150,
      // JEL-99: raised from 5500. On the failing Tizen 5.0 (Chromium 63) panel
      // a HEALTHY cold boot installs ApiClient at ~6100 ms (measured on device:
      // dcl=3999, api=6097). The cap must clear that with margin or the rescue
      // clobbers a healthy-but-slow boot. See the tick() note below on why the
      // old readyState trigger was removed.
      CAP = 20000,
      started = Date.now();
    function alreadyRan() {
      return (window.__shellRegElCalls || 0) > 0;
    }
    function reinject(reason) {
      try {
        if (
          typeof window.ApiClient != "undefined" ||
          typeof window.__webpack_require__ != "undefined"
        )
          return;
        if (alreadyRan()) {
          ((window.__shellDeferWatchdogSkipped =
            (window.__shellDeferWatchdogSkipped || 0) + 1),
            (window.__shellDeferWatchdogSkipReason =
              "regEl>" + (window.__shellRegElCalls || 0)));
          return;
        }
        // JEL-137: a partially-executed defer sequence is NOT the JEL-99
        // wedge. Every jellyfin-web bundle starts with
        // `(self.webpackChunk=self.webpackChunk||[]).push(...)`, so the
        // array's existence proves at least one defer already executed and
        // the sequence is alive — just slow. A cold-cache Babel-storm boot
        // blows past the cap with ApiClient/registerElement still pending
        // because those only appear near the END of the sequence.
        // Re-injecting then re-runs every already-run bundle: two webpack
        // runtimes, two module caches, and route chunks bind half-evaluated
        // modules from the stale cache (login tF getter TypeError -> black
        // login page). Only re-inject when NO bundle ever executed.
        var wpc = null;
        try {
          wpc = window.webpackChunk || window.webpackJsonp;
        } catch (_) {}
        if (wpc) {
          ((window.__shellDeferWatchdogSkipped =
            (window.__shellDeferWatchdogSkipped || 0) + 1),
            (window.__shellDeferWatchdogSkipReason = "webpackChunkExists"));
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
        ((window.__shellDeferWatchdogFired = defers.length),
          (window.__shellDeferWatchdogReason = reason),
          (window.__shellDeferWatchdogAtMs = Date.now() - started));
        for (var i = 0; i < defers.length; i++) {
          var src = defers[i].getAttribute("src");
          if (src) {
            // JEL-99: drop the original (still-unrun) defer node before
            // re-injecting so it cannot also execute later and double-run the
            // webpack runtime. The cap only fires while ApiClient /
            // __webpack_require__ are still absent, i.e. these defers provably
            // have NOT executed yet, so removing them cancels them rather than
            // racing a second copy.
            try {
              defers[i].parentNode &&
                defers[i].parentNode.removeChild(defers[i]);
            } catch (_) {}
            var s2 = document.createElement("script");
            ((s2.src = src),
              s2.setAttribute("data-shell-defer-watchdog", "1"),
              document.head.appendChild(s2));
          }
        }
      } catch (e) {
        try {
          console.warn("shell: defer-script watchdog error", e && e.message);
        } catch (_) {}
      }
    }
    function tick() {
      try {
        if (
          typeof window.ApiClient != "undefined" ||
          typeof window.__webpack_require__ != "undefined" ||
          alreadyRan()
        )
          return;
        // JEL-99: do NOT treat document.readyState === "complete" as a hang
        // signal. After document.open/write/close into the already-complete
        // bootstrap document, Chromium 63 reports readyState "complete" almost
        // immediately (measured 638 ms) while the freshly written defer bundles
        // are still healthy and pending — ApiClient did not install until
        // 6097 ms. The old readyState trigger therefore fired at 638 ms,
        // re-injected all 28 scripts, and the real defers then ALSO ran, which
        // double-ran the webpack runtime and wedged the SPA forever (JEL-99).
        // The only sound "defers ran" signals are __webpack_require__ /
        // ApiClient / registerElement (checked above); absent those, wait out
        // the cap before assuming a genuine hang.
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
  var BUNDLE_FAST_RE =
      /<script\b[^>]*\bsrc\s*=\s*["']([^"']*main\.[^"']*\.bundle\.js[^"']*)["'][^>]*>\s*<\/script>/i,
    VENDORS_FAST_RE =
      /<script\b[^>]*\bsrc\s*=\s*["']([^"']*vendors\.[^"']*\.bundle\.js[^"']*)["'][^>]*>\s*<\/script>/i;
  function maybeStringFastPath(html, serverUrl, baseUrl, upstreamCfg) {
    (window.__shellFastPathHits || (window.__shellFastPathHits = 0),
      window.__shellFastPathFallbacks || (window.__shellFastPathFallbacks = 0));
    function bail(reason) {
      return (
        window.__shellFastPathFallbacks++,
        (window.__shellFastPathLastBail = reason),
        null
      );
    }
    if (!isLegacyChromium()) return bail("modern");
    try {
      if (localStorage.getItem("jellyfin.shell.fastPathDisabled") === "1")
        return bail("killSwitch");
    } catch (_) {}
    var babelNeeded = !1;
    try {
      babelNeeded = localStorage.getItem(BABEL_NEEDED_KEY) === "1";
    } catch (_) {}
    var headIdx = html.indexOf("<head>");
    if (headIdx < 0) return bail("noHead");
    var bundleMatch = BUNDLE_FAST_RE.exec(html),
      inlineBundleBody = null,
      bundleUrl = null,
      cachedPatches = 0;
    if (bundleMatch) {
      try {
        bundleUrl = new URL(bundleMatch[1], baseUrl).href;
      } catch (_) {
        return bail("bundleUrlParse");
      }
      var cache = readBundlePatchState();
      if (!cache || cache.url !== bundleUrl) return bail("bundleCacheMiss");
      if (cache.body) {
        if (
          ((inlineBundleBody = cache.body),
          (cachedPatches =
            cache.needsPatch &&
            typeof cache.patches == "number" &&
            cache.patches > 0
              ? cache.patches
              : 0),
          inlineBundleBody.indexOf("</script") >= 0)
        )
          return bail("bundleScriptClose");
      } else if (cache.needsPatch) return bail("bundleBodyMissing");
    }
    var vendorsMatch = VENDORS_FAST_RE.exec(html),
      inlineVendorsBody = null,
      vendorsUrl = null;
    if (vendorsMatch) {
      try {
        vendorsUrl = new URL(vendorsMatch[1], baseUrl).href;
      } catch (_) {
        return bail("vendorsUrlParse");
      }
      var vCache = readVendorsBundleState();
      if (!vCache || vCache.url !== vendorsUrl) return bail("vendorsCacheMiss");
      if (vCache.body) {
        if (
          ((inlineVendorsBody = vCache.body),
          inlineVendorsBody.indexOf("</script") >= 0)
        )
          return bail("vendorsScriptClose");
      } else return bail("vendorsBodyMissing");
    }
    ((window.__shellDiagInit = window.__shellDiagInit || {}),
      (window.__shellDiagInit.legacy = !0),
      (window.__shellDiagInit.babel = typeof window.Babel != "undefined"),
      (window.__shellDiagInit.polyfilled = !0));
    var diagBody = buildDiagSeedScript("1.0.87"),
      seedBody = buildSeedScript(serverUrl, upstreamCfg),
      polyBody = chromium56PolyfillBody(),
      beaconBody = qaBeaconBody(),
      beaconTag =
        beaconBody && beaconBody !== "__QA_BEACON_BODY__"
          ? '<script data-shell-beacon="1">' + beaconBody + "</script>"
          : "",
      progressTag =
        '<script data-shell-boot-progress="1">' +
        bootProgressBody() +
        "</script>",
      injected =
        '<script data-shell-diag="1">' +
        diagBody +
        '</script><base href="' +
        escAttr(baseUrl) +
        '"><script data-shell-seed="1">' +
        seedBody +
        '</script><script data-shell-polyfill="1">' +
        polyBody +
        "</script>" +
        beaconTag +
        progressTag,
      insertAt = headIdx + 6,
      patched = html.slice(0, insertAt) + injected + html.slice(insertAt);
    if (
      ((window.__shellBundlePatches = window.__shellBundlePatches || 0),
      (window.__shellBundlesScanned = window.__shellBundlesScanned || 0),
      (window.__shellBundlesPatchedFiles =
        window.__shellBundlesPatchedFiles || []),
      (window.__shellBundleHits = window.__shellBundleHits || 0),
      (window.__shellBundleCacheHit = window.__shellBundleCacheHit || 0),
      (window.__shellBundleCacheBodyHit =
        window.__shellBundleCacheBodyHit || 0),
      (window.__shellBundlePatchSkipped =
        window.__shellBundlePatchSkipped || 0),
      inlineBundleBody)
    ) {
      var replaced = !1;
      if (
        ((patched = patched.replace(BUNDLE_FAST_RE, function (m) {
          return replaced
            ? m
            : ((replaced = !0),
              '<script data-shell-bundle-patched="' +
                escAttr(bundleUrl) +
                '" data-shell-bundle-from-cache="1" data-shell-bundle-patches="' +
                cachedPatches +
                '">' +
                inlineBundleBody +
                "</script>");
        })),
        !replaced)
      )
        return bail("bundleReplaceFail");
      (cachedPatches > 0 && (window.__shellBundlePatches += cachedPatches),
        window.__shellBundleCacheHit++,
        window.__shellBundleCacheBodyHit++,
        window.__shellBundlesPatchedFiles.push(
          "fastpath:cache" + cachedPatches,
        ),
        (window.__shellMainBundleLSAdopted = 1),
        (window.__shellMainBundleInlineHits =
          (window.__shellMainBundleInlineHits || 0) + 1),
        (window.__shellMainBundleLSBytes = inlineBundleBody.length));
    } else bundleMatch && window.__shellBundleCacheHit++;
    if (inlineVendorsBody) {
      var vReplaced = !1;
      if (
        ((patched = patched.replace(VENDORS_FAST_RE, function (m) {
          return vReplaced
            ? m
            : ((vReplaced = !0),
              '<script data-shell-bundle-patched="' +
                escAttr(vendorsUrl) +
                '" data-shell-bundle-from-cache="1" data-shell-bundle-patches="0">' +
                inlineVendorsBody +
                "</script>");
        })),
        !vReplaced)
      )
        return bail("vendorsReplaceFail");
      (window.__shellBundleCacheHit++,
        window.__shellBundleCacheBodyHit++,
        window.__shellBundlesPatchedFiles.push("fastpath:vcache0"),
        (window.__shellVendorsBundleLSAdopted = 1),
        (window.__shellVendorsBundleInlineHits =
          (window.__shellVendorsBundleInlineHits || 0) + 1),
        (window.__shellVendorsBundleLSBytes = inlineVendorsBody.length));
    }
    if (!0) {
      var TX_SCRIPT_RE =
          /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,
        txInlines = 0,
        txBail = null,
        txRewritten = "",
        txLastIdx = 0,
        txMatch;
      for (
        TX_SCRIPT_RE.lastIndex = 0;
        (txMatch = TX_SCRIPT_RE.exec(patched)) !== null;
      ) {
        var rawSrc = txMatch[1];
        if (!isJellyfinWebBundle(rawSrc)) {
          var txAbsUrl;
          try {
            txAbsUrl = new URL(rawSrc, baseUrl).href;
          } catch (_) {
            txBail = "txUrlParse";
            break;
          }
          if (txAbsUrl.indexOf("?") >= 0) {
            // JEL-178: a query string marks a cache-busted (config-mutable)
            // plugin script. The synchronous fast-path can only replay a cached
            // body (no fetch), which would go stale on a config change, so bail
            // to the async path which re-fetches + content-validates. Plugin-
            // agnostic — no specific plugin is named.
            txBail = "txVolatile";
            break;
          }
          var txBody = null;
          try {
            txBody = localStorage.getItem(TX_PFX + txKey(txAbsUrl));
          } catch (_) {}
          if (txBody == null) {
            txBail = "txCacheMiss";
            break;
          }
          if (txBody.indexOf("</script") >= 0) {
            txBail = "txScriptClose";
            break;
          }
          ((txRewritten += patched.slice(txLastIdx, txMatch.index)),
            (txRewritten +=
              '<script data-shell-transpiled-from="' +
              escAttr(txAbsUrl) +
              '" data-shell-fast="1" data-shell-tx-cached="1">' +
              txBody +
              "</script>"),
            (txLastIdx = TX_SCRIPT_RE.lastIndex),
            txInlines++);
        }
      }
      if (txBail) return bail(txBail);
      (txInlines > 0 &&
        ((txRewritten += patched.slice(txLastIdx)), (patched = txRewritten)),
        (window.__shellFastPathTxInlines =
          (window.__shellFastPathTxInlines || 0) + txInlines));
    }
    return (window.__shellFastPathHits++, patched);
  }
  function markDocumentWrite() {
    try {
      if (!window.__qaMarks) return;
      ((window.__qaMarks.tDocumentWrite = performance.now()),
        typeof window.__qaMarksSave == "function"
          ? window.__qaMarksSave()
          : localStorage.setItem(
              "jellyfin.qa.bootMarks.current",
              JSON.stringify(window.__qaMarks),
            ));
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
    var baseUrl = serverUrl + "/web/",
      babelNeededFlag = !1;
    try {
      babelNeededFlag = localStorage.getItem(BABEL_NEEDED_KEY) === "1";
    } catch (_) {}
    var babelStreakSkip = !1;
    try {
      babelStreakSkip =
        (parseInt(localStorage.getItem(BABEL_UNUSED_STREAK_KEY) || "0", 10) ||
          0) >= 2;
    } catch (_) {}
    window.__shellBabelPrimeSkipped = babelStreakSkip ? 1 : 0;
    var babelDeferGate = !1;
    try {
      var dv = localStorage.getItem("jellyfin.shell.legacy.babelDeferAppend");
      babelDeferGate = dv !== "0" && dv !== "false";
    } catch (_) {
      babelDeferGate = !0;
    }
    if (
      isLegacyChromium() &&
      babelNeededFlag &&
      !babelStreakSkip &&
      !babelDeferGate &&
      typeof window.__ensureBabel == "function"
    )
      try {
        window.__ensureBabel();
      } catch (_) {}
    var pf = window.__shellPrefetch,
      fetchOpts = { credentials: "omit" },
      indexFetch = withBootTimeout(
        pf && pf.baseUrl === baseUrl && pf.index
          ? pf.index
          : fetch(baseUrl + "index.html", fetchOpts),
        "web client",
      ),
      configFetch = withBootTimeout(
        pf && pf.baseUrl === baseUrl && pf.config
          ? pf.config
          : fetch(baseUrl + "config.json", fetchOpts),
        "web config",
      );
    ((window.__shellIndexCacheRecords = window.__shellIndexCacheRecords || 0),
      (window.__shellIndexCacheHits = window.__shellIndexCacheHits || 0),
      (window.__shellIndexCacheSavedMs = window.__shellIndexCacheSavedMs || 0));
    var cacheGateOn = webCacheEnabled(),
      cachedIndex = cacheGateOn ? readWebIndexCache(serverUrl) : null,
      cachedConfig = cacheGateOn ? readWebConfigCache(serverUrl) : null,
      indexCacheHit = !!(cachedIndex && cachedConfig);
    if (indexCacheHit) {
      (window.__shellIndexCacheHits++,
        (window.__shellWebIndexCacheAdopted = 1));
      var revalStart = typeof Date != "undefined" ? Date.now() : 0;
      (indexFetch
        .then(function (r) {
          return r && r.ok ? r.text() : null;
        })
        .then(function (txt) {
          if (
            (typeof txt == "string" &&
              txt.length &&
              txt !== cachedIndex.body &&
              writeWebIndexCache(serverUrl, txt),
            revalStart)
          )
            try {
              window.__shellIndexCacheSavedMs = Date.now() - revalStart;
            } catch (_) {}
        })
        .catch(function () {}),
        configFetch
          .then(function (r) {
            return r && r.ok ? r.text() : null;
          })
          .then(function (txt) {
            typeof txt == "string" &&
              txt.length &&
              txt !== cachedConfig.body &&
              writeWebConfigCache(serverUrl, txt);
          })
          .catch(function () {}));
    }
    var prefetchedBundle =
      pf && pf.baseUrl === baseUrl && pf.bundle && pf.bundleUrl
        ? { url: pf.bundleUrl, fetch: pf.bundle }
        : null;
    try {
      window.__shellPluginPrefetch =
        pf && pf.baseUrl === baseUrl && pf.plugins ? pf.plugins : null;
    } catch (_) {}
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
              return (
                cacheGateOn &&
                  (writeWebIndexCache(serverUrl, txt),
                  window.__shellIndexCacheRecords++),
                txt
              );
            }),
      configPromise = indexCacheHit
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
              cacheGateOn && writeWebConfigCache(serverUrl, txt);
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
        var html = results[0],
          upstreamCfg = results[1],
          fast = maybeStringFastPath(html, serverUrl, baseUrl, upstreamCfg);
        if (fast) {
          ((window.__jellyfinShellBootDone = !0),
            markDocumentWrite(),
            document.open("text/html", "replace"),
            document.write(fast),
            document.close(),
            armDeferWatchdog());
          return;
        }
        var doc = new DOMParser().parseFromString(html, "text/html"),
          existingBase = doc.querySelector("base");
        existingBase && existingBase.remove();
        var baseTag = doc.createElement("base");
        ((baseTag.href = baseUrl),
          doc.head.insertBefore(baseTag, doc.head.firstChild),
          (window.__shellDiagInit = window.__shellDiagInit || {}),
          (window.__shellDiagInit.legacy = isLegacyChromium()),
          (window.__shellDiagInit.babel = typeof window.Babel != "undefined"),
          (window.__shellDiagInit.polyfilled = window.__shellDiagInit.legacy));
        var diagTag = doc.createElement("script");
        (diagTag.setAttribute("data-shell-diag", "1"),
          (diagTag.textContent = buildDiagSeedScript("1.0.87")),
          doc.head.insertBefore(diagTag, baseTag));
        var seedTag = doc.createElement("script");
        return (
          seedTag.setAttribute("data-shell-seed", "1"),
          (seedTag.textContent = buildSeedScript(serverUrl, upstreamCfg)),
          baseTag.nextSibling
            ? doc.head.insertBefore(seedTag, baseTag.nextSibling)
            : doc.head.appendChild(seedTag),
          injectChromium56Polyfills(doc),
          injectQaBeacon(doc),
          injectBootProgress(doc),
          Promise.all([
            patchPlaybackBundles(doc, baseUrl, prefetchedBundle),
            transpileLegacyScripts(doc, baseUrl),
          ]).then(function () {
            try {
              var ssOrigin = null;
              try {
                ssOrigin = new URL(baseUrl).origin;
              } catch (_) {}
              rewriteStylesheetsFromCache(doc, baseUrl, ssOrigin);
            } catch (_) {}
            ((window.__jellyfinShellBootDone = !0),
              markDocumentWrite(),
              document.open("text/html", "replace"),
              document.write("<!DOCTYPE html>" + doc.documentElement.outerHTML),
              document.close(),
              armDeferWatchdog());
          })
        );
      },
    );
  }
  function showError(msg) {
    var err = document.getElementById("boot-error");
    err && ((err.textContent = msg), (err.hidden = !1));
  }
  function injectConnectStylesheet() {
    if (!document.getElementById("shell-connect-css")) {
      var ln = document.createElement("link");
      ((ln.id = "shell-connect-css"),
        (ln.rel = "stylesheet"),
        (ln.href = "connect/connect.css"),
        document.head.appendChild(ln));
    }
  }
  function attachConnectForm() {
    injectConnectStylesheet();
    var rootEl = document.getElementById("boot-root");
    rootEl && (rootEl.style.display = "block");
    var form = document.getElementById("server-form"),
      input = document.getElementById("server-input");
    if (!form || !input) return;
    if (!input.value) {
      var saved = loadServerUrl();
      saved && (input.value = saved);
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var url = normalizeServerUrl(input.value);
      if (!url) {
        showError("Please enter a server URL.");
        return;
      }
      (showError(""),
        validateServer(url)
          .then(function () {
            return (saveServerUrl(url), loadRemoteWebClient(url));
          })
          .catch(function (err) {
            showError(
              "Could not reach server: " +
                (err && err.message ? err.message : "unknown error"),
            );
          }));
    });
  }
  function bootstrap() {
    (registerRemoteKeys(), installBackHandler());
    var stored = loadServerUrl();
    stored
      ? loadRemoteWebClient(stored).catch(function () {
          (attachConnectForm(),
            showError(
              "Could not reach saved server. Check your network and try again.",
            ));
        })
      : attachConnectForm();
  }
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", bootstrap)
    : bootstrap();
})();
