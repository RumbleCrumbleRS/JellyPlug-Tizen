/*!
 * JellyPlug Lite core — JELA-67 M1 slice 1.
 *
 * ES5 ONLY. This file must run RAW on Tizen 5.0 (2019 M63, Chromium
 * 63-era engine) with no transpile step — the whole point of Lite is
 * that nothing multi-MB parses on boot. es5-guard.test.cjs enforces
 * the syntax envelope; keep new code inside it.
 *
 * Architecture (locked by the M0 on-device spike, JELA-67 thread):
 * - One fullscreen <canvas>; scene = rows of poster cards + focus ring.
 * - Posters are prescaled into card-size offscreen canvases at image
 *   load time (M0: converts Q60R frame p95 from 35.8ms marginal to
 *   27.8ms locked; prescale cost 12ms total for a full screen).
 * - Only visible cards draw (~28/frame is 2.4ms avg on the M63).
 * - NEVER read the canvas back (toDataURL/getImageData): Jellyfin
 *   image routes send no ACAO header, so drawn posters taint it.
 * - rAF runs only while a scroll lerp is live or the scene is dirty.
 *
 * Everything stateful is behind create*() factories that take their
 * environment (storage/fetch/document/now) as arguments so the pure
 * logic runs under plain node tests with no canvas or network.
 */
(function (global) {
  "use strict";

  var Lite = { version: "0.1.0" };

  /* ------------------------------------------------------------------
   * Layout — pure math for a 1920x1080 design grid.
   * ---------------------------------------------------------------- */

  var LAYOUT = {
    vw: 1920,
    vh: 1080,
    cardW: 240,
    cardH: 360,
    gapX: 24,
    rowPadL: 90,
    rowTitleH: 56,
    rowGapY: 36,
    topPad: 60,
    focusScale: 1.08,
    focusRingPad: 6,
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  var layout = {
    metrics: LAYOUT,

    rowPitch: function () {
      return LAYOUT.rowTitleH + LAYOUT.cardH + LAYOUT.rowGapY;
    },

    rowY: function (rowIndex) {
      return LAYOUT.topPad + rowIndex * layout.rowPitch();
    },

    cardX: function (col) {
      return LAYOUT.rowPadL + col * (LAYOUT.cardW + LAYOUT.gapX);
    },

    contentHeight: function (rowCount) {
      if (rowCount <= 0) {
        return LAYOUT.topPad;
      }
      return layout.rowY(rowCount - 1) + LAYOUT.rowTitleH + LAYOUT.cardH;
    },

    maxScrollY: function (rowCount) {
      return Math.max(
        0,
        layout.contentHeight(rowCount) + LAYOUT.topPad - LAYOUT.vh,
      );
    },

    maxScrollX: function (cardCount) {
      if (cardCount <= 0) {
        return 0;
      }
      var rowW = layout.cardX(cardCount - 1) + LAYOUT.cardW + LAYOUT.rowPadL;
      return Math.max(0, rowW - LAYOUT.vw);
    },

    // Netflix-style: the focused card parks at the row's left padding.
    targetScrollX: function (col, cardCount) {
      return clamp(
        layout.cardX(col) - LAYOUT.rowPadL,
        0,
        layout.maxScrollX(cardCount),
      );
    },

    // The focused row parks at the top padding.
    targetScrollY: function (rowIndex, rowCount) {
      return clamp(
        layout.rowY(rowIndex) - LAYOUT.topPad,
        0,
        layout.maxScrollY(rowCount),
      );
    },

    // Inclusive [first, last] card columns intersecting the viewport,
    // padded by one card each side so scroll lerps never pop blanks in.
    visibleCols: function (scrollX, cardCount) {
      if (cardCount <= 0) {
        return null;
      }
      var pitch = LAYOUT.cardW + LAYOUT.gapX;
      var first = Math.floor((scrollX - LAYOUT.rowPadL) / pitch) - 1;
      var last = Math.ceil((scrollX + LAYOUT.vw - LAYOUT.rowPadL) / pitch);
      first = clamp(first, 0, cardCount - 1);
      last = clamp(last, 0, cardCount - 1);
      return { first: first, last: last };
    },

    visibleRows: function (scrollY, rowCount) {
      if (rowCount <= 0) {
        return null;
      }
      var pitch = layout.rowPitch();
      var first = Math.floor((scrollY - LAYOUT.topPad) / pitch) - 1;
      var last = Math.ceil((scrollY + LAYOUT.vh - LAYOUT.topPad) / pitch);
      first = clamp(first, 0, rowCount - 1);
      last = clamp(last, 0, rowCount - 1);
      return { first: first, last: last };
    },

    // Focus ring rectangle around a card scaled by focusScale about its
    // center, in scene (unscrolled) coordinates.
    focusRect: function (rowIndex, col) {
      var w = LAYOUT.cardW * LAYOUT.focusScale;
      var h = LAYOUT.cardH * LAYOUT.focusScale;
      var x = layout.cardX(col) - (w - LAYOUT.cardW) / 2;
      var y = layout.rowY(rowIndex) + LAYOUT.rowTitleH - (h - LAYOUT.cardH) / 2;
      return {
        x: x - LAYOUT.focusRingPad,
        y: y - LAYOUT.focusRingPad,
        w: w + 2 * LAYOUT.focusRingPad,
        h: h + 2 * LAYOUT.focusRingPad,
      };
    },
  };

  Lite.layout = layout;

  /* ------------------------------------------------------------------
   * Nav — remote-key focus state machine with per-row column memory.
   * ---------------------------------------------------------------- */

  Lite.createNav = function (rowCounts) {
    var cols = [];
    var i;
    for (i = 0; i < rowCounts.length; i++) {
      cols.push(0);
    }

    var nav = {
      row: 0,
      cols: cols,

      rowCount: function () {
        return rowCounts.length;
      },

      col: function () {
        return nav.cols[nav.row] || 0;
      },

      setRowCounts: function (next) {
        rowCounts = next;
        while (nav.cols.length < next.length) {
          nav.cols.push(0);
        }
        nav.cols.length = next.length;
        if (nav.row >= next.length) {
          nav.row = Math.max(0, next.length - 1);
        }
        for (i = 0; i < next.length; i++) {
          nav.cols[i] = clamp(nav.cols[i] || 0, 0, Math.max(0, next[i] - 1));
        }
      },

      // dir: 'left' | 'right' | 'up' | 'down'. Returns true when focus moved.
      move: function (dir) {
        if (!rowCounts.length) {
          return false;
        }
        var row = nav.row;
        var col = nav.col();
        if (dir === "left" && col > 0) {
          nav.cols[row] = col - 1;
          return true;
        }
        if (dir === "right" && col < rowCounts[row] - 1) {
          nav.cols[row] = col + 1;
          return true;
        }
        if (dir === "up" && row > 0) {
          nav.row = row - 1;
          return true;
        }
        if (dir === "down" && row < rowCounts.length - 1) {
          nav.row = row + 1;
          return true;
        }
        return false;
      },
    };
    return nav;
  };

  // Tizen remote keyCode -> nav direction / action.
  Lite.KEYS = {
    37: "left",
    38: "up",
    39: "right",
    40: "down",
    13: "ok",
    10009: "back",
    // Escape hatch → full SPA (search / settings / admin).
    // 403 = Red colour button. 10182 (SmartHub/Home) was dropped after
    // the 2026-07-11 physical-remote QA: Samsung reserves the Home key
    // and never delivers it to the app, so the mapping was dead code.
    403: "escape",
  };

  /* ------------------------------------------------------------------
   * SWR cache — render from localStorage JSON instantly, revalidate
   * behind, notify only when the payload actually changed.
   * ---------------------------------------------------------------- */

  Lite.createSwr = function (opts) {
    var storage = opts.storage;
    var key = opts.key;
    var fetchFresh = opts.fetchFresh; // function (cb(err, data))
    var now =
      opts.now ||
      function () {
        return new global.Date().getTime();
      };

    function read() {
      var raw;
      try {
        raw = storage.getItem(key);
      } catch (e) {
        return null;
      }
      if (!raw) {
        return null;
      }
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !parsed.data) {
          return null;
        }
        return parsed;
      } catch (e2) {
        return null;
      }
    }

    function write(data) {
      try {
        storage.setItem(key, JSON.stringify({ ts: now(), data: data }));
        return true;
      } catch (e) {
        // Quota or privacy failure: SWR silently degrades to fetch-only.
        return false;
      }
    }

    return {
      read: read,
      write: write,

      // onRender(data, fromCache) fires once for the cached copy (if
      // any) and once more only if the network copy differs from it.
      load: function (onRender, onError) {
        var cached = read();
        var cachedJson = null;
        if (cached) {
          cachedJson = JSON.stringify(cached.data);
          onRender(cached.data, true);
        }
        fetchFresh(function (err, fresh) {
          if (err) {
            if (!cached && onError) {
              onError(err);
            }
            return;
          }
          var freshJson = JSON.stringify(fresh);
          if (freshJson !== cachedJson) {
            write(fresh);
            onRender(fresh, false);
          }
        });
      },
    };
  };

  /* ------------------------------------------------------------------
   * Credentials + Jellyfin REST home sections.
   * ---------------------------------------------------------------- */

  // Reuse the session jellyfin-web already persisted; Lite never shows
  // its own login in M1 (no-creds boots fall through to the full SPA).
  Lite.readCreds = function (storage) {
    var raw;
    try {
      raw = storage.getItem("jellyfin_credentials");
    } catch (e) {
      return null;
    }
    if (!raw) {
      return null;
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e2) {
      return null;
    }
    var servers = parsed && parsed.Servers;
    if (!servers || !servers.length) {
      return null;
    }
    var i;
    for (i = 0; i < servers.length; i++) {
      var s = servers[i];
      if (s && s.AccessToken && s.UserId) {
        var base =
          s.ManualAddress || s.LocalAddress || s.RemoteAddress || s.Address;
        if (base) {
          return {
            base: String(base).replace(/\/+$/, ""),
            token: s.AccessToken,
            userId: s.UserId,
            // The SPA's #/details route wants the credentials server id
            // alongside the item id (M2 deep-link handoff).
            serverId: s.Id || null,
          };
        }
      }
    }
    return null;
  };

  // fetchJson(url, headers, cb(err, obj)) is injected; the default XHR
  // implementation lives in boot() so this stays node-testable.
  Lite.createApi = function (opts) {
    var base = opts.base;
    var token = opts.token;
    var userId = opts.userId;
    var fetchJson = opts.fetchJson;
    var maxRows = opts.maxRows || 8;
    var rowLimit = opts.rowLimit || 20;

    function headers() {
      return { "X-Emby-Token": token };
    }

    function get(path, cb) {
      fetchJson(base + path, headers(), cb);
    }

    function itemCard(item) {
      var imgTag =
        (item.ImageTags && item.ImageTags.Primary) ||
        item.SeriesPrimaryImageTag ||
        null;
      var imgItemId = item.SeriesPrimaryImageTag ? item.SeriesId : item.Id;
      return {
        id: item.Id,
        name: item.SeriesName || item.Name || "",
        type: item.Type || "",
        img: imgTag
          ? base +
            "/Items/" +
            imgItemId +
            "/Images/Primary?maxWidth=400&tag=" +
            imgTag
          : null,
      };
    }

    function cardsOf(body) {
      var items = (body && (body.Items || body)) || [];
      if (!items.length) {
        return [];
      }
      var out = [];
      var i;
      for (i = 0; i < items.length && i < rowLimit; i++) {
        out.push(itemCard(items[i]));
      }
      return out;
    }

    return {
      // cb(err, sections) — sections: [{id, title, items:[card]}], rows
      // with zero items dropped, order: Resume, Next Up, Latest per view.
      home: function (cb) {
        var sections = [];
        var pending = 0;
        var dispatching = 0;
        var failed = null;
        var finished = false;

        // `dispatching` holds done() off while a batch of fills is
        // still being issued; without it a synchronous fetchJson (test
        // fake, future memory cache) finalizes after the FIRST request.
        function done() {
          if (finished || pending > 0 || dispatching > 0) {
            return;
          }
          finished = true;
          if (failed && !sections.length) {
            cb(failed, null);
            return;
          }
          var out = [];
          var i;
          for (i = 0; i < sections.length; i++) {
            if (sections[i] && sections[i].items.length) {
              out.push(sections[i]);
            }
          }
          cb(null, out);
        }

        function fill(slot, id, title, path) {
          pending++;
          get(path, function (err, body) {
            pending--;
            if (err) {
              failed = err;
            } else {
              sections[slot] = { id: id, title: title, items: cardsOf(body) };
            }
            done();
          });
        }

        dispatching++;
        fill(
          0,
          "resume",
          "Continue Watching",
          "/Users/" +
            userId +
            "/Items/Resume?limit=" +
            rowLimit +
            "&mediaTypes=Video&fields=PrimaryImageAspectRatio",
        );
        fill(
          1,
          "nextup",
          "Next Up",
          "/Shows/NextUp?userId=" +
            userId +
            "&limit=" +
            rowLimit +
            "&fields=PrimaryImageAspectRatio",
        );

        pending++;
        get("/Users/" + userId + "/Views", function (err, body) {
          pending--;
          if (err) {
            failed = err;
            done();
            return;
          }
          var views = (body && body.Items) || [];
          var used = 0;
          var i;
          dispatching++;
          for (i = 0; i < views.length && used < maxRows - 2; i++) {
            var v = views[i];
            if (
              !v ||
              (v.CollectionType !== "movies" && v.CollectionType !== "tvshows")
            ) {
              continue;
            }
            used++;
            fill(
              1 + used,
              "latest-" + v.Id,
              "Latest " + (v.Name || ""),
              "/Users/" +
                userId +
                "/Items/Latest?parentId=" +
                v.Id +
                "&limit=" +
                rowLimit +
                "&fields=PrimaryImageAspectRatio",
            );
          }
          dispatching--;
          done();
        });
        dispatching--;
        done();
      },
    };
  };

  /* ------------------------------------------------------------------
   * Image pool — load + prescale posters into card-size canvases.
   * ---------------------------------------------------------------- */

  Lite.createImagePool = function (doc, onLoaded, capacity) {
    var cap = capacity || 120;
    var cache = {}; // url -> {canvas, seq} | {pending:true}
    var order = []; // insertion order for cheap LRU-ish eviction
    var seq = 0;

    function prescale(img) {
      var c = doc.createElement("canvas");
      c.width = LAYOUT.cardW;
      c.height = LAYOUT.cardH;
      var ctx = c.getContext("2d");
      // cover-fit: fill the card, crop the overflow axis
      var scale = Math.max(LAYOUT.cardW / img.width, LAYOUT.cardH / img.height);
      var w = img.width * scale;
      var h = img.height * scale;
      ctx.drawImage(img, (LAYOUT.cardW - w) / 2, (LAYOUT.cardH - h) / 2, w, h);
      return c;
    }

    function evict() {
      while (order.length > cap) {
        var url = order.shift();
        if (cache[url] && !cache[url].pending) {
          delete cache[url];
        }
      }
    }

    return {
      // Returns the prescaled canvas when ready, else null (and starts
      // the load; onLoaded() fires later so the renderer can redraw).
      get: function (url) {
        if (!url) {
          return null;
        }
        var hit = cache[url];
        if (hit) {
          return hit.canvas || null;
        }
        cache[url] = { pending: true };
        var img = new global.Image();
        img.onload = function () {
          var entry = cache[url];
          if (!entry) {
            return;
          }
          entry.pending = false;
          entry.canvas = prescale(img);
          entry.seq = seq++;
          order.push(url);
          evict();
          if (onLoaded) {
            onLoaded(url);
          }
        };
        img.onerror = function () {
          delete cache[url];
        };
        img.src = url;
        return null;
      },
    };
  };

  /* ------------------------------------------------------------------
   * Renderer — draws the scene; owns scroll lerps and the dirty flag.
   * ---------------------------------------------------------------- */

  var COLORS = {
    bg: "#101010",
    card: "#2a2a2a",
    title: "#e8e8e8",
    cardName: "#9a9a9a",
    ring: "#ffffff",
  };

  var LERP_RATE = 0.28; // fraction of remaining distance per frame
  var SNAP_PX = 0.5;

  Lite.createRenderer = function (canvas, images) {
    var ctx = canvas.getContext("2d");
    var scene = []; // [{title, items, scrollX, targetX}]
    var scrollY = 0;
    var targetY = 0;
    var focus = { row: 0, col: 0 };
    var dirty = true;
    var msg = null; // non-null string → overlay message (error / empty)

    function lerp(cur, target) {
      var d = target - cur;
      if (d > -SNAP_PX && d < SNAP_PX) {
        return target;
      }
      return cur + d * LERP_RATE;
    }

    var renderer = {
      setScene: function (sections) {
        var next = [];
        var i;
        for (i = 0; i < sections.length; i++) {
          var prev = scene[i];
          next.push({
            id: sections[i].id,
            title: sections[i].title,
            items: sections[i].items,
            scrollX: prev ? prev.scrollX : 0,
            targetX: prev ? prev.targetX : 0,
          });
        }
        scene = next;
        dirty = true;
      },

      rowCounts: function () {
        var out = [];
        var i;
        for (i = 0; i < scene.length; i++) {
          out.push(scene[i].items.length);
        }
        return out;
      },

      setFocus: function (row, col) {
        focus.row = row;
        focus.col = col;
        targetY = layout.targetScrollY(row, scene.length);
        if (scene[row]) {
          scene[row].targetX = layout.targetScrollX(
            col,
            scene[row].items.length,
          );
        }
        dirty = true;
      },

      invalidate: function () {
        dirty = true;
      },

      setMessage: function (text) {
        msg = text || null;
        dirty = true;
      },

      focusedItem: function () {
        var row = scene[focus.row];
        return (row && row.items[focus.col]) || null;
      },

      // True while another frame is needed (lerp still travelling).
      needsFrame: function () {
        if (dirty) {
          return true;
        }
        if (scrollY !== targetY) {
          return true;
        }
        var i;
        for (i = 0; i < scene.length; i++) {
          if (scene[i].scrollX !== scene[i].targetX) {
            return true;
          }
        }
        return false;
      },

      draw: function () {
        dirty = false;
        scrollY = lerp(scrollY, targetY);

        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        var rows = layout.visibleRows(scrollY, scene.length);
        if (!rows) {
          return;
        }
        var r;
        for (r = rows.first; r <= rows.last; r++) {
          var row = scene[r];
          row.scrollX = lerp(row.scrollX, row.targetX);
          var y = layout.rowY(r) - scrollY;

          ctx.fillStyle = COLORS.title;
          ctx.font = "600 30px sans-serif";
          ctx.fillText(row.title, LAYOUT.rowPadL, y + 38);

          var cols = layout.visibleCols(row.scrollX, row.items.length);
          if (!cols) {
            continue;
          }
          var c;
          for (c = cols.first; c <= cols.last; c++) {
            var item = row.items[c];
            var x = layout.cardX(c) - row.scrollX;
            var cy = y + LAYOUT.rowTitleH;
            var poster = images ? images.get(item.img) : null;
            if (poster) {
              ctx.drawImage(poster, x, cy);
            } else {
              ctx.fillStyle = COLORS.card;
              ctx.fillRect(x, cy, LAYOUT.cardW, LAYOUT.cardH);
              ctx.fillStyle = COLORS.cardName;
              ctx.font = "400 22px sans-serif";
              ctx.fillText(String(item.name).slice(0, 18), x + 12, cy + 40);
            }
          }
        }

        // Focus ring last so it sits above neighbouring cards.
        var frow = scene[focus.row];
        if (frow) {
          var rect = layout.focusRect(focus.row, focus.col);
          ctx.strokeStyle = COLORS.ring;
          ctx.lineWidth = 4;
          ctx.strokeRect(
            rect.x - frow.scrollX,
            rect.y - scrollY,
            rect.w,
            rect.h,
          );
        }

        // Overlay message (error / loading / empty) drawn last.
        if (msg) {
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = COLORS.title;
          ctx.font = "400 36px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
          ctx.textAlign = "left";
        }
      },
    };
    return renderer;
  };

  /* ------------------------------------------------------------------
   * Boot — wire everything to a real window. Kept last and thin.
   * ---------------------------------------------------------------- */

  Lite.SWR_KEY = "jellyplug.lite.home.v1";

  function xhrFetchJson(url, headers, cb) {
    var xhr = new global.XMLHttpRequest();
    xhr.open("GET", url, true);
    var k;
    for (k in headers) {
      if (headers.hasOwnProperty(k)) {
        xhr.setRequestHeader(k, headers[k]);
      }
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        cb(new Error("HTTP " + xhr.status + " " + url), null);
        return;
      }
      try {
        cb(null, JSON.parse(xhr.responseText));
      } catch (e) {
        cb(e, null);
      }
    };
    xhr.send();
  }

  // Returns the app handle, or null when Lite cannot run (no stored
  // session) — the caller (shell boot path, M1 slice 2) falls back to
  // the full SPA in that case.
  Lite.boot = function (win, doc) {
    var creds = Lite.readCreds(win.localStorage);
    if (!creds) {
      return null;
    }

    var canvas = doc.createElement("canvas");
    canvas.width = LAYOUT.vw;
    canvas.height = LAYOUT.vh;
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:100%;height:100%;background:" +
      COLORS.bg;
    doc.body.appendChild(canvas);

    var renderer;
    var images = Lite.createImagePool(doc, function () {
      renderer.invalidate();
      schedule();
    });
    renderer = Lite.createRenderer(canvas, images);
    var nav = Lite.createNav([]);

    var rafLive = false;
    function frame() {
      renderer.draw();
      if (renderer.needsFrame()) {
        win.requestAnimationFrame(frame);
      } else {
        rafLive = false;
      }
    }
    function schedule() {
      if (!rafLive) {
        rafLive = true;
        win.requestAnimationFrame(frame);
      }
    }

    var api = Lite.createApi({
      base: creds.base,
      token: creds.token,
      userId: creds.userId,
      fetchJson: xhrFetchJson,
    });
    var swr = Lite.createSwr({
      storage: win.localStorage,
      key: Lite.SWR_KEY,
      fetchFresh: api.home,
    });

    swr.load(function (sections) {
      if (!sections || !sections.length) {
        // No data yet (first-ever boot before SWR fills) or fetch error
        // while cache is also empty.  Show a polite placeholder — the
        // background restock will populate it on next boot.
        renderer.setMessage("Loading…");
        schedule();
        return;
      }
      renderer.setMessage(null);
      renderer.setScene(sections);
      nav.setRowCounts(renderer.rowCounts());
      renderer.setFocus(nav.row, nav.col());
      schedule();
    });

    function onKey(ev) {
      var action = Lite.KEYS[ev.keyCode];
      if (!action) {
        return;
      }
      if (action === "ok") {
        var item = renderer.focusedItem();
        if (item && app.onOpen) {
          app.onOpen(item);
        }
        return;
      }
      if (action === "back") {
        if (app.onBack) {
          app.onBack();
        }
        return;
      }
      if (action === "escape") {
        if (app.onMenu) {
          app.onMenu();
        }
        return;
      }
      if (nav.move(action)) {
        renderer.setFocus(nav.row, nav.col());
        schedule();
      }
      ev.preventDefault();
    }
    doc.addEventListener("keydown", onKey, true);

    var app = {
      canvas: canvas,
      renderer: renderer,
      nav: nav,
      // Credentials server id — the shell's M2 deep-link handoff appends
      // it to the SPA #/details route next to the item id.
      serverId: creds.serverId || null,
      // The host (shell lite-loader) decides what OK/Back/Menu do.
      onOpen: null,
      onBack: null,
      onMenu: null, // escape hatch to full SPA (search/settings/admin)
      // M2 handoff: stop input but KEEP the canvas up showing a message,
      // so the screen isn't black for the seconds until the SPA's
      // document.write teardown replaces the document (canvas included).
      handoff: function (message) {
        doc.removeEventListener("keydown", onKey, true);
        renderer.setMessage(message || "Opening…");
        schedule();
      },
      destroy: function () {
        doc.removeEventListener("keydown", onKey, true);
        if (canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      },
    };
    return app;
  };

  global.JellyPlugLite = Lite;
})(typeof window !== "undefined" ? window : this);
