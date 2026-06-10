(function () {
  "use strict";
  try {
    window.__shellT0 || (window.__shellT0 = Date.now());
  } catch (_) {}
  var SERVER_URL_KEY = "jellyfin.shell.serverUrl",
    hasTizen = typeof window.tizen != "undefined",
    hasWebapis = typeof window.webapis != "undefined",
    MODERN_SYNTAX_RE_SRC =
      "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{",
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
  var TX_VER = txFnv1a(
      MODERN_SYNTAX_RE_SRC + "|" + BABEL_OPTS_KEY + "|" + BABEL_FPR,
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
    WEB_CACHE_VER = "1.0.87",
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
  function withBootTimeout(p, label) {
    return new Promise(function (resolve, reject) {
      var settled = !1,
        timer = setTimeout(function () {
          settled ||
            ((settled = !0),
            reject(new Error("Timed out reaching server (" + label + ")")));
        }, BOOT_FETCH_TIMEOUT_MS);
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
      '  try{localStorage.setItem("layout","tv");}catch(_){}',
      `  try{(function(){var K={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Up:1,Down:1,Left:1,Right:1,Tab:1},C={9:1,37:1,38:1,39:1,40:1,29460:1,29461:1,29462:1,29463:1},S='a[href]:not([tabindex="-1"]),button:not(:disabled):not([tabindex="-1"]),input:not([type=range]):not([type=file]):not([tabindex="-1"]):not(:disabled),select:not([tabindex="-1"]):not(:disabled),textarea:not([tabindex="-1"]):not(:disabled),.focusable:not([tabindex="-1"])';function vis(n){if(!n)return false;if(n.offsetParent===null&&n.tagName!=="BODY")return false;var r=n.getBoundingClientRect&&n.getBoundingClientRect();return !!(r&&r.width>0&&r.height>0);}function fst(s){if(!s||!s.querySelectorAll)return null;try{var n=s.querySelectorAll(S);for(var i=0;i<n.length;i++)if(vis(n[i]))return n[i];}catch(_){}return null;}function scopes(){var out=[];try{var d=document.querySelectorAll(".dialogContainer .dialog.opened");if(d.length)out.push(d[d.length-1]);}catch(_){}try{var p=document.querySelectorAll(".page:not(.hide)");for(var i=p.length-1;i>=0;i--)if(p[i]&&p[i].offsetParent!==null)out.push(p[i]);}catch(_){}try{var hsel=[".skinHeader",".headerTop",".mainAnimatedPages",".pageContainer","#reactRoot","#appLayer"];for(var hi=0;hi<hsel.length;hi++){var h=document.querySelector(hsel[hi]);if(h)out.push(h);}}catch(_){}out.push(document.body);return out;}function findT(){try{var st=document.getElementById("__shellST");if(st){var r=st.getBoundingClientRect&&st.getBoundingClientRect();if(r&&r.width>0&&r.height>0){window.__shellLastScopeHit=99;return st;}}}catch(_){}var sc=scopes();window.__shellLastScopeN=sc.length;for(var i=0;i<sc.length;i++){var t=fst(sc[i]);if(t){window.__shellLastScopeHit=i;return t;}}window.__shellLastScopeHit=-1;return null;}function isBodyF(){var a=document.activeElement;return !a||a===document.body||a.tagName==="HTML";}function isAuthed(){if(window.__shellAFForceAuth===1)return true;try{var c=localStorage.getItem("jellyfin_credentials");if(!c)return false;var p=JSON.parse(c);return !!(p&&p.Servers&&p.Servers.length&&p.Servers[0].AccessToken);}catch(_){return false;}}window.addEventListener("keydown",function(e){if(!e||!(K[e.key]||C[e.keyCode]||C[e.which]))return;if(!isBodyF())return;window.__shellBodyFocusRescueAttempts=(window.__shellBodyFocusRescueAttempts||0)+1;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellBodyFocusRescues=(window.__shellBodyFocusRescues||0)+1;e.preventDefault();e.stopPropagation();}}}catch(_){}},true);window.__shellBodyFocusRescueBound=1;window.__shellAutoFocusAttempts=0;window.__shellAutoFocusSuccesses=0;window.__shellAutoFocusBudget=24;function bumpAF(){window.__shellAutoFocusBudget=24;}try{window.addEventListener("hashchange",bumpAF,false);}catch(_){}try{window.addEventListener("popstate",bumpAF,false);}catch(_){}var lastBody=true;setInterval(function(){var nowBody=isBodyF();if(nowBody&&!lastBody)bumpAF();lastBody=nowBody;try{var st=document.getElementById("__shellST");if(st){if(document.activeElement!==st){window.__shellAutoFocusAttempts++;try{st.focus();}catch(_){}if(document.activeElement===st){window.__shellAutoFocusSuccesses++;window.__shellLastScopeHit=99;}}return;}}catch(_){}if(!nowBody)return;if((window.__shellAutoFocusBudget||0)<=0)return;if(!isAuthed())return;window.__shellAutoFocusAttempts++;try{var t=findT();if(t){t.focus();if(document.activeElement===t){window.__shellAutoFocusSuccesses++;window.__shellAutoFocusBudget=0;return;}}}catch(_){}window.__shellAutoFocusBudget--;},600);})();}catch(_){}`,
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
      "    var __modernRe=/\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{/;",
      '    function needsTx(code){return typeof code==="string"&&__modernRe.test(code);}',
      '    function transpile(code){if(typeof window.Babel==="undefined")return null;try{return window.Babel.transform(code,{presets:[["env",{targets:{chrome:"63"},modules:false,loose:true}]],assumptions:{iterableIsArray:true,arrayLikeIsIterable:true},sourceType:"script",compact:true,comments:false}).code;}catch(_){return null;}}',
      "    function maybeTranspile(code){if(!needsTx(code)){try{window.__shellTxSkipCount=(window.__shellTxSkipCount||0)+1;}catch(_){}return code;}try{window.__shellTxDoCount=(window.__shellTxDoCount||0)+1;}catch(_){}return transpile(code);}",
      "    var __TXVER=" + JSON.stringify(TX_VER) + ";",
      "    try{window.__TXVER=__TXVER;}catch(_){}",
      '    var __TXPFX="shell.tx"+__TXVER+":";',
      '    var __TXLRUKEY="shell.txLru"+__TXVER;',
      '    function __txKey(s){var u=String(s||"");var i=u.indexOf("?");return i<0?u:u.substring(0,i);}',
      "    function __txLru(){try{var v=localStorage.getItem(__TXLRUKEY);return v?JSON.parse(v):{};}catch(_){return{};}}",
      "    function __txPersistLru(m){try{localStorage.setItem(__TXLRUKEY,JSON.stringify(m));}catch(_){}}",
      "    function __txGet(src){try{var k=__txKey(src);var v=localStorage.getItem(__TXPFX+k);if(v!=null){window.__shellTxCacheHits=(window.__shellTxCacheHits||0)+1;var m=__txLru();m[k]=Date.now();__txPersistLru(m);}else{window.__shellTxCacheMisses=(window.__shellTxCacheMisses||0)+1;try{var __miss=window.__shellTxCacheMissUrls;if(!__miss){__miss=[];window.__shellTxCacheMissUrls=__miss;}if(__miss.length<10)__miss.push(src);}catch(_){}}return v;}catch(_){return null;}}",
      "    function __txPrune(){try{var m=__txLru();var keys=Object.keys(m);if(!keys.length)return;keys.sort(function(a,b){return m[a]-m[b];});var n=Math.min(keys.length,10);for(var i=0;i<n;i++){try{localStorage.removeItem(__TXPFX+keys[i]);}catch(_){}delete m[keys[i]];}__txPersistLru(m);}catch(_){}}",
      '    function __txSet(src,body){if(typeof body!=="string"||body.length>262144)return;var k=__txKey(src);try{localStorage.setItem(__TXPFX+k,body);var m=__txLru();m[k]=Date.now();__txPersistLru(m);}catch(e){__txPrune();try{localStorage.setItem(__TXPFX+k,body);var m2=__txLru();m2[k]=Date.now();__txPersistLru(m2);}catch(__){}}}',
      "    var __jqRe=/\\bjQuery\\b|(?:^|[^A-Za-z0-9_$.])\\$\\s*\\(/;",
      "    function needsJq(code){return __jqRe.test(code);}",
      '    function wrapJq(code){return "(function(){function __run(){"+code+"\\n}if(typeof window.jQuery!=\\"undefined\\"){__run();return;}var __to;var __t=setInterval(function(){if(typeof window.jQuery!=\\"undefined\\"){clearInterval(__t);clearTimeout(__to);try{__run();}catch(e){try{console.error(\\"shell: deferred plugin failed\\",e&&e.message);}catch(_){}}}},20);__to=setTimeout(function(){clearInterval(__t);try{console.warn(\\"shell: jQuery wait timed out, running anyway\\");}catch(_){}try{__run();}catch(e){try{console.error(\\"shell: deferred plugin failed\\",e&&e.message);}catch(_){}}},10000);})();";}',
      '    function dispatchEvt(node,type){try{var ev=document.createEvent("Event");ev.initEvent(type,false,false);node.dispatchEvent(ev);}catch(_){}try{var fn=node["on"+type];if(typeof fn==="function")fn.call(node,{type:type,target:node});}catch(_){}}',
      "    function rewrite(parent,node,ref,origMethod){",
      '      var src=node.getAttribute("src");',
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
      '      window.fetch(src,{credentials:"omit"})',
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
      "    function srcPipeline(node,src){",
      "      if(node.__shellPiped)return;",
      "      node.__shellPiped=true;",
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
      '      window.fetch(src,{credentials:"omit"})',
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
      '        "FP:"+((window.__shellFastPathHits)||0)+"/"+((window.__shellFastPathFallbacks)||0)+" tx="+((window.__shellFastPathTxInlines)||0)+" lb="+((window.__shellFastPathLastBail)||"-")',
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
      "              try{modEx=wr(mid);}catch(_){continue;}",
      "              if(modEx)__shellScanExports(modEx);",
      "              if(window.__shellCMPatched&&window.__shellPMPatched&&window.__shellPluginManager)break;",
      "            }catch(_){}",
      "          }",
      "        }",
      "        if((!window.__shellCMPatched||!window.__shellPMPatched||!window.__shellPluginManager)&&window.__shellCMTries<60)setTimeout(__shellWalkWebpack,500);",
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
      '    "tx h="+(window.__shellTxCacheHits||0)+" m="+(window.__shellTxCacheMisses||0)+" sk="+(window.__shellTxSkipCount||0)+" do="+(window.__shellTxDoCount||0)+" tv="+(window.__TXVER||"?"),',
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
      'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start);}else{start();}',
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
      "(function(){",
      '  if(typeof Symbol==="undefined"||!Symbol.iterator)return;',
      "  function makeIterable(proto){",
      "    if(!proto||proto[Symbol.iterator])return;",
      "    try{Object.defineProperty(proto,Symbol.iterator,{configurable:true,writable:true,value:function(){var i=0,self=this;return {next:function(){return i<self.length?{value:self[i++],done:false}:{value:undefined,done:true};}};}});}catch(_){}",
      "  }",
      '  var names=["NodeList","HTMLCollection","HTMLFormControlsCollection","HTMLOptionsCollection","HTMLAllCollection","DOMTokenList","NamedNodeMap","FileList","DOMRectList","DOMStringList","CSSRuleList","StyleSheetList","MediaList","DataTransferItemList","TouchList","SVGLengthList","SVGNumberList","SVGPointList","SVGTransformList","SVGStringList"];',
      "  for(var i=0;i<names.length;i++){try{var C=window[names[i]];if(C&&C.prototype)makeIterable(C.prototype);}catch(_){}}",
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
    return "/* JEL-1971: QA HTTP beacon \u2014 outbound DOM telemetry channel for the hourly\n * scout. Replaces `0 debug` AUL handshake (capped at ~2 sessions per TV boot,\n * see JEL-1969) and persistent WebInspector (Samsung silently ignores\n * `web-inspector=\"enable\"` on consumer Tizen 5.0 release-signed WGTs, see\n * JEL-1970).\n *\n * Outbound HTTP works from the Tizen web app sandbox unrestricted because\n * config.xml `<access origin=\"*\">` is already set. The QA host listens on a\n * fixed LAN port and persists each POST as a JSON line; scout polls\n * `GET /latest?serial=...` for current state.\n *\n * Gating:\n *   - off unless localStorage['jellyfin.qa.overlay'] === '1' (same flag as\n *     the QA HUD overlay). Production builds never trip the gate because\n *     index.html sets it only on QA-flavored WGTs.\n *   - beacon URL overridable via localStorage['jellyfin.qa.beaconUrl'];\n *     default `http://192.168.0.20:8731/qa-beacon`.\n *   - tick paused when document.hidden (no telemetry while app backgrounded).\n *   - deferred 5 s post-DOMContentLoaded so cold-boot critical path stays\n *     untouched.\n */\n(function(){\n    try {\n        if (localStorage.getItem('jellyfin.qa.overlay') !== '1') return;\n    } catch (e) { return; }\n\n    var DEFAULT_URL = 'http://192.168.0.20:8731/qa-beacon';\n    var TICK_MS = 4000;\n    var START_DELAY_MS = 5000;\n    var MAX_TEXT_LEN = 120;\n    var MAX_ERRORS = 20;\n\n    var beaconUrl;\n    try { beaconUrl = localStorage.getItem('jellyfin.qa.beaconUrl') || DEFAULT_URL; }\n    catch (e) { beaconUrl = DEFAULT_URL; }\n\n    var serial = null;\n    try {\n        if (typeof webapis !== 'undefined' && webapis.productinfo && typeof webapis.productinfo.getDuid === 'function') {\n            serial = webapis.productinfo.getDuid();\n        }\n    } catch (e) {}\n    if (!serial) {\n        try {\n            serial = localStorage.getItem('jellyfin.qa.beaconSerial');\n            if (!serial) {\n                serial = 'shell-' + Math.random().toString(36).slice(2, 10);\n                try { localStorage.setItem('jellyfin.qa.beaconSerial', serial); } catch (_) {}\n            }\n        } catch (e) { serial = 'shell-unknown'; }\n    }\n\n    var errors = [];\n    var seenErrors = {};\n    function pushError(s) {\n        if (!s) return;\n        s = String(s).slice(0, 240);\n        if (seenErrors[s]) return;\n        seenErrors[s] = 1;\n        errors.push(s);\n        if (errors.length > MAX_ERRORS) errors.shift();\n    }\n    try {\n        window.addEventListener('error', function(ev){\n            try {\n                var msg = ev && ev.error && ev.error.stack ? ev.error.stack.split('\\n')[0] : (ev && ev.message) || '';\n                if (msg) pushError(msg);\n            } catch (_) {}\n        }, true);\n        window.addEventListener('unhandledrejection', function(ev){\n            try {\n                var r = ev && ev.reason;\n                var msg = r && r.stack ? r.stack.split('\\n')[0] : (r && r.message) || String(r || '');\n                if (msg) pushError('unhandled: ' + msg);\n            } catch (_) {}\n        }, true);\n    } catch (e) {}\n\n    function descActive() {\n        try {\n            var el = document.activeElement;\n            if (!el) return null;\n            var r = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;\n            var txt = '';\n            try { txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN); } catch (_) {}\n            return {\n                tag: el.tagName || null,\n                id: el.id || '',\n                className: (typeof el.className === 'string') ? el.className.slice(0, MAX_TEXT_LEN) : '',\n                textContent: txt,\n                rect: r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null\n            };\n        } catch (_) { return null; }\n    }\n\n    function getHudText() {\n        try {\n            var hud = document.getElementById('__qa_hud');\n            if (!hud) return null;\n            return (hud.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500);\n        } catch (_) { return null; }\n    }\n\n    function getQcState() {\n        try {\n            var creds = localStorage.getItem('jellyfin_credentials');\n            if (creds) {\n                var p = JSON.parse(creds);\n                var s = p && p.Servers && p.Servers[0];\n                if (s && s.AccessToken) return 'loggedIn';\n            }\n        } catch (_) {}\n        try {\n            if (document.querySelector('.btnUseQuickConnect, .qcCode')) return 'quickConnect';\n        } catch (_) {}\n        try {\n            if (document.querySelector('.manualLoginForm, .loginForm, #txtUserName, #txtManualName')) return 'manualLogin';\n        } catch (_) {}\n        try {\n            if (document.querySelector('.userItemContainer, .btnUser')) return 'userPicker';\n        } catch (_) {}\n        return 'unknown';\n    }\n\n    function countCards() {\n        try {\n            var n = document.querySelectorAll('.card, .listItem, .cardScalable').length;\n            return n;\n        } catch (_) { return -1; }\n    }\n\n    // JEL-1974 (v68): one-shot read of `jellyfin.qa.bootMarks.prior` \u2014\n    // the boot-mark IIFE in index.html rotated last boot's marks into\n    // this key. Beacon emits as payload.priorBootMarks on FIRST POST\n    // only, then nulls so subsequent 4 s ticks don't re-send (marks\n    // never change mid-boot). Server collector accepts arbitrary fields\n    // and persists into ndjson, so no schema change needed.\n    var priorBootMarks = null;\n    try {\n        var rawMarks = localStorage.getItem('jellyfin.qa.bootMarks.prior');\n        if (rawMarks) priorBootMarks = JSON.parse(rawMarks);\n    } catch (_) { priorBootMarks = null; }\n\n    function takePriorBootMarks() {\n        var v = priorBootMarks;\n        priorBootMarks = null;\n        return v;\n    }\n\n    function buildPayload() {\n        var active = descActive();\n        var hud = getHudText();\n        var cards = countCards();\n        var snap = errors.slice(); // copy\n        errors.length = 0;\n        seenErrors = {};\n\n        var focus = null;\n        if (active && active.rect) {\n            focus = {y: active.rect.y, w: active.rect.w};\n        }\n\n        return {\n            ts: Date.now(),\n            serial: serial,\n            url: (location && location.href) || '',\n            title: document.title || '',\n            activeElement: active,\n            focus: focus,\n            hud: hud,\n            cards: cards,\n            errors: snap,\n            qcState: getQcState(),\n            screenshotBase64: null,\n            ua: (navigator && navigator.userAgent) || '',\n            visibility: document.visibilityState || (document.hidden ? 'hidden' : 'visible'),\n            priorBootMarks: takePriorBootMarks()\n        };\n    }\n\n    var inflight = false;\n    function postOnce() {\n        if (inflight) return;\n        if (document.hidden) return;\n        inflight = true;\n        var body;\n        try { body = JSON.stringify(buildPayload()); }\n        catch (e) { inflight = false; return; }\n        try {\n            var xhr = new XMLHttpRequest();\n            xhr.open('POST', beaconUrl, true);\n            xhr.setRequestHeader('Content-Type', 'application/json');\n            xhr.timeout = 2500;\n            xhr.onloadend = function(){ inflight = false; };\n            xhr.ontimeout = function(){ inflight = false; };\n            xhr.onerror = function(){ inflight = false; };\n            xhr.send(body);\n        } catch (e) { inflight = false; }\n    }\n\n    function start() {\n        try { postOnce(); } catch (_) {}\n        setInterval(postOnce, TICK_MS);\n    }\n\n    if (document.readyState === 'complete' || document.readyState === 'interactive') {\n        setTimeout(start, START_DELAY_MS);\n    } else {\n        document.addEventListener('DOMContentLoaded', function(){ setTimeout(start, START_DELAY_MS); });\n    }\n\n    try {\n        window.__qaBeacon = {\n            post: postOnce,\n            url: function(){ return beaconUrl; },\n            serial: function(){ return serial; }\n        };\n    } catch (_) {}\n})();\n";
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
        var cached = txGetStatic(url);
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
            : (responsePromise = fetch(url, { credentials: "omit" })),
          responsePromise
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.text();
            })
            .then(function (code) {
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
                  txSetStatic(url, bodyRaw),
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
                    txSetStatic(url, body),
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
        beaconTag,
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
    return Promise.all([indexPromise, configPromise]).then(function (results) {
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
    });
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
