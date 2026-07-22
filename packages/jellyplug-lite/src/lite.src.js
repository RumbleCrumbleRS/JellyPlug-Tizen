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
        // M3 resume plumbing: the position already arrives on the
        // home-sections payload, so the native player can seek without
        // an extra fetch (design doc §4, "Resume entry").
        posTicks: (item.UserData && item.UserData.PlaybackPositionTicks) || 0,
        runtimeTicks: item.RunTimeTicks || 0,
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
   * Player — native AVPlay lifecycle skeleton (M3 slice 1).
   *
   * The adapter (opts.avplay) is webapis.avplay on a TV whose widget
   * carries the avplay privilege + webapis.js include (WGT v2.0.25);
   * node tests inject a fake. The one hard rule (M3 spike gate G4 and
   * the design doc §4): stop()+close() ALWAYS run on any exit — error,
   * stream end, back — even when individual adapter calls throw. A
   * leaked player wedges the platform pipeline until app restart.
   *
   * One player instance = one playback. After teardown the instance is
   * dead (st "closed" / "err"); the caller creates a fresh player for
   * the next item — the spike's "second playback works" G4 check is
   * exactly that sequence on-device.
   * ---------------------------------------------------------------- */

  // Item types whose OK-press may take the native path; everything
  // else (Series/BoxSet/Playlist/…) is container navigation and stays
  // on the SPA details deep-link (design doc §1).
  Lite.isPlayableLeaf = function (type) {
    return (
      type === "Movie" ||
      type === "Episode" ||
      type === "Video" ||
      type === "MusicVideo"
    );
  };

  Lite.createPlayer = function (opts) {
    var avplay = opts.avplay;
    var vw = opts.vw || LAYOUT.vw;
    var vh = opts.vh || LAYOUT.vh;
    var now =
      opts.now ||
      function () {
        return new global.Date().getTime();
      };
    // The __shellLite.player QA surface (design doc §4): st, ms
    // (prepare → first frame), url kind ("direct"; "remux" is the
    // slice-3 DirectStream candidate).
    var diag = opts.diag || {};

    var st;
    var prepT0 = 0;
    var firstFrameSeen = false;
    var lastTimeMs = 0;
    var buffering = false;
    // JELA-137 remux clock: a DirectStream opened with StartTimeTicks=T
    // usually restamps output from 0 (ffmpeg -ss + copy), so the
    // pipeline clock is stream-relative and every position read must
    // add T back. Some server paths copy absolute timestamps instead —
    // detected one-shot on the first playtime tick (a tick already past
    // T/2 can only be an absolute clock) and the offset drops to 0.
    var kind0 = "direct";
    var remuxOffMs = 0;
    var offDetected = false;

    function absTime(t) {
      return (t || 0) + remuxOffMs;
    }

    function setSt(next) {
      st = next;
      diag.st = next;
    }
    setSt("idle");

    function dead() {
      return st === "closed" || st === "err";
    }

    // The G4 rule: both calls, both guarded, in this order, no matter
    // which of them throws or what state the pipeline is in.
    function teardown(why) {
      if (dead()) {
        return;
      }
      try {
        avplay.stop();
      } catch (_) {}
      try {
        avplay.close();
      } catch (_2) {}
      setSt(why === "err" ? "err" : "closed");
    }

    function fail(why) {
      teardown("err");
      if (opts.onError) {
        opts.onError(why);
      }
    }

    var listener = {
      oncurrentplaytime: function (ms) {
        if (dead()) {
          return;
        }
        if (!offDetected) {
          offDetected = true;
          if (remuxOffMs > 0 && (ms || 0) >= remuxOffMs / 2) {
            remuxOffMs = 0;
          }
        }
        lastTimeMs = absTime(ms);
        // The first playtime tick after play() is the closest signal
        // the AVPlay API has to "first frame on the video plane" — the
        // M3 spike's G1 numbers were measured exactly this way.
        if (!firstFrameSeen && (st === "playing" || st === "paused")) {
          firstFrameSeen = true;
          diag.ms = now() - prepT0;
          if (opts.onFirstFrame) {
            opts.onFirstFrame(diag.ms);
          }
        }
      },
      onbufferingstart: function () {
        buffering = true;
      },
      onbufferingprogress: function () {},
      onbufferingcomplete: function () {
        buffering = false;
      },
      onstreamcompleted: function () {
        teardown("end");
        if (opts.onEnd) {
          opts.onEnd();
        }
      },
      onerror: function (type) {
        fail("avplay:" + type);
      },
      onevent: function () {},
    };

    var player = {
      state: function () {
        return st;
      },
      buffering: function () {
        return buffering;
      },
      // Frozen at the last observed tick once the pipeline is closed —
      // the caller patches the Resume row from this after Back.
      currentTimeMs: function () {
        if (dead()) {
          return lastTimeMs;
        }
        try {
          var t = avplay.getCurrentTime();
          if (typeof t === "number" && t >= 0) {
            lastTimeMs = absTime(t);
          }
        } catch (_) {}
        return lastTimeMs;
      },
      durationMs: function () {
        // Remux: the pipeline sees a growing offset-relative stream, so
        // getDuration is meaningless — 0 hands the clock to the
        // caller's RunTimeTicks fallback (exact for a remux: -c copy
        // never changes the runtime).
        if (dead() || kind0 === "remux") {
          return 0;
        }
        try {
          var d = avplay.getDuration();
          return typeof d === "number" && d > 0 ? d : 0;
        } catch (_) {
          return 0;
        }
      },

      // open(url, posMs): the whole §4 lifecycle in one shot —
      // open → setListener → setDisplayRect → prepareAsync →
      // (posMs ? seekTo : nothing) → play. One-shot: false when this
      // instance already ran.
      //
      // Remux (kind="remux"): the caller bakes the start position into
      // the URL (StartTimeTicks) — a growing transcode output has no
      // byte ranges, so a pipeline seek is not possible. posMs here is
      // the URL's offset, kept only to translate the stream-relative
      // clock back to absolute media time (see remuxOffMs above).
      open: function (url, posMs, kind) {
        if (st !== "idle") {
          return false;
        }
        kind0 = kind || "direct";
        diag.url = kind0;
        if (kind0 === "remux") {
          remuxOffMs = posMs > 0 ? posMs : 0;
          lastTimeMs = remuxOffMs;
          posMs = 0;
        }
        try {
          avplay.open(url);
          avplay.setListener(listener);
          avplay.setDisplayRect(0, 0, vw, vh);
          setSt("preparing");
          prepT0 = now();
          avplay.prepareAsync(
            function () {
              if (dead()) {
                return;
              }
              if (posMs > 0) {
                avplay.seekTo(
                  posMs,
                  function () {
                    player._go();
                  },
                  function () {
                    // A failed resume-seek is not fatal: playing from
                    // 0 beats bouncing the user to the SPA.
                    player._go();
                  },
                );
              } else {
                player._go();
              }
            },
            function (e) {
              fail("prepare:" + e);
            },
          );
        } catch (e2) {
          fail("open");
          return false;
        }
        return true;
      },

      // prepare-success continuation; internal, but on the object so
      // the seek callbacks above reach it after `player` exists.
      _go: function () {
        if (dead()) {
          return;
        }
        try {
          avplay.play();
          setSt("playing");
        } catch (_) {
          fail("play");
        }
      },

      playPause: function () {
        if (st === "playing") {
          try {
            avplay.pause();
            setSt("paused");
            return true;
          } catch (_) {
            fail("pause");
          }
        } else if (st === "paused") {
          try {
            avplay.play();
            setSt("playing");
            return true;
          } catch (_2) {
            fail("play");
          }
        }
        return false;
      },

      // cb(ok) fires when the pipeline settles (G3 measured ~405ms
      // paused / ~1.0s playing on the Q60R via exactly this success
      // callback).
      seekTo: function (ms, cb) {
        // Remux streams cannot pipeline-seek (see open) — the SESSION
        // restarts the stream at the target instead; refusing here
        // keeps a stray call from wedging the pipeline.
        if (kind0 === "remux" || (st !== "playing" && st !== "paused")) {
          if (cb) {
            cb(false);
          }
          return;
        }
        if (ms < 0) {
          ms = 0;
        }
        try {
          avplay.seekTo(
            ms,
            function () {
              if (cb) {
                cb(true);
              }
            },
            function () {
              if (cb) {
                cb(false);
              }
            },
          );
        } catch (_) {
          if (cb) {
            cb(false);
          }
        }
      },

      stop: function () {
        teardown("stop");
      },
    };
    return player;
  };

  /* ------------------------------------------------------------------
   * PlaybackInfo — the direct-play decision (M3 slice 2, design §3).
   *
   * One POST decides native-vs-SPA. Anything that is not a clean
   * SupportsDirectPlay source — transcode-only answer, HTTP error,
   * timeout — is a decline, and the caller falls back to the M2 SPA
   * deep-link. The timeout matters: PlaybackInfo is one POST on a LAN
   * server, but a wedged server must bounce OK to the SPA promptly,
   * not hang Lite with a "Loading…" overlay.
   * ---------------------------------------------------------------- */

  // JELA-138: does this panel do HDR? Samsung avinfo has answered this
  // since Tizen 2.4, but the probe must never take Lite down with it —
  // absent/throwing webapis means "assume SDR panel" and HDR sources
  // keep the designed SPA fallback (which tone-maps server-side).
  // Probed once per boot; tests override via Lite.hdrPanel._v.
  Lite.hdrPanel = function () {
    if (Lite.hdrPanel._v !== undefined) {
      return Lite.hdrPanel._v;
    }
    var v = false;
    try {
      v = !!(
        global.webapis &&
        global.webapis.avinfo &&
        global.webapis.avinfo.isHdrTvSupport()
      );
    } catch (_h) {
      v = false;
    }
    Lite.hdrPanel._v = v;
    return v;
  };

  // M63 (2019, Tizen 5.0) device profile — design §3, widened by
  // JELA-138 from the conservative slice-2 shape after a full-library
  // PlaybackInfo sweep against the real 10.11 server showed the actual
  // deniers were missing audio/legacy video codecs and sub selection —
  // NOT the hevc HDR video, which 10.11 passes once a range
  // declaration exists. Panel capability picks the hevc
  // VideoRangeType list: HDR panels take HDR10/HDR10+/HLG plus DoVi
  // profiles that carry an HDR10/SDR fallback layer (pure
  // DOVI/DOVIWithEL stays excluded — no base layer to fall back to);
  // SDR panels take SDR only, so HDR sources decline to the SPA whose
  // transcode tone-maps. mpeg2video/mpeg4/avi and the audio widening
  // (opus/vorbis/pcm/flac) are Samsung published decoder support for
  // 2019+ panels; dts/truehd stay out (Samsung dropped DTS licensing
  // for 2019+ models) and vp9/av1 stay out (no declared container /
  // no 2019 hardware decode). Real-panel decode + HDR-actually-lit
  // verification rides the JELA-141 rollout QA — the emulated harness
  // cannot prove either.
  Lite.HDR_RANGE_TYPES =
    "SDR|HDR10|HLG|HDR10Plus|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithSDR";
  Lite.SDR_RANGE_TYPES = "SDR|DOVIWithSDR";
  Lite.DIRECT_AUDIO = "aac,mp3,ac3,eac3,opus,vorbis,pcm_s24le,pcm_s16le,flac";

  Lite.deviceProfile = function () {
    return {
      MaxStreamingBitrate: 120000000,
      DirectPlayProfiles: [
        {
          Container: "mp4,mov,mkv",
          Type: "Video",
          VideoCodec: "h264,hevc,mpeg2video,mpeg4",
          AudioCodec: Lite.DIRECT_AUDIO,
        },
        {
          Container: "avi",
          Type: "Video",
          VideoCodec: "mpeg4,h264,mpeg2video",
          AudioCodec: Lite.DIRECT_AUDIO,
        },
      ],
      // Slice 3: accept DirectStream (container remux, no codec re-encode)
      // for hevc/h264 items the server won't direct-play from a foreign
      // container. Audio stays the narrow list: remux is -c copy, so a
      // wide-audio source in a foreign container must re-encode audio =
      // not remux-only = decline, which is the designed outcome.
      TranscodingProfiles: [
        {
          Container: "mkv",
          Type: "Video",
          VideoCodec: "h264,hevc",
          AudioCodec: "aac,mp3,ac3,eac3",
          Protocol: "Http",
        },
      ],
      CodecProfiles: [
        {
          Type: "Video",
          Codec: "h264",
          Conditions: [
            {
              Condition: "LessThanEqual",
              Property: "VideoLevel",
              Value: "51",
              IsRequired: false,
            },
          ],
        },
        {
          Type: "Video",
          Codec: "hevc",
          Conditions: [
            {
              Condition: "EqualsAny",
              Property: "VideoProfile",
              Value: "main|main 10",
              IsRequired: false,
            },
            {
              Condition: "EqualsAny",
              Property: "VideoRangeType",
              Value: Lite.hdrPanel()
                ? Lite.HDR_RANGE_TYPES
                : Lite.SDR_RANGE_TYPES,
              IsRequired: false,
            },
          ],
        },
      ],
      // JELA-151 DECISION (2026-07-22, data-backed): stays EMPTY for
      // C5. Lite has no subtitle renderer, so any answer that selects
      // a sub stream must decline the native path and ride the SPA,
      // which renders subs correctly — playing picture WITHOUT a
      // user-selected sub is worse than the fallback. Costs ~2.1% of
      // items for the real fleet (7/7 real users are OnlyForced;
      // 89/4206 items carry forced subs). The lift is JELA-152
      // (External delivery + avplay setExternalSubtitlePath). Do NOT
      // declare formats here before Lite can hand subs to avplay.
      SubtitleProfiles: [],
    };
  };

  // JELA-137 emulated-QA finding: a real 10.11 server never sets
  // SupportsDirectStream on these video answers — "direct stream" there
  // means "original container proxied via the server" and stays gated on
  // DirectPlayProfiles, so a container-mismatch source reports
  // SupportsDirectStream:false even when every codec is copy-eligible.
  // The actual remux offer is the TranscodingUrl whose TranscodeReasons
  // name the container as the ONLY problem: ffmpeg then runs -c copy
  // into the TranscodingProfile container. Any codec/subtitle/bitrate
  // reason means real re-encode work, which Lite must never start from
  // a TV press. No TranscodeReasons at all = cannot prove copy-only =
  // decline (the pre-fix behaviour).
  function remuxOnlyReasons(turl) {
    var m = /[?&]TranscodeReasons=([^&]+)/i.exec(turl);
    if (!m) {
      return false;
    }
    var raw = m[1];
    try {
      raw = global.decodeURIComponent(raw);
    } catch (_r) {}
    var parts = raw.split(",");
    var i;
    for (i = 0; i < parts.length; i++) {
      if (parts[i] !== "ContainerNotSupported") {
        return false;
      }
    }
    return parts.length > 0;
  }

  // postJson(url, headers, body, cb?) is injected; the default XHR
  // implementation lives in boot() so this stays node-testable.
  Lite.createPlaybackInfo = function (opts) {
    var base = opts.base;
    var token = opts.token;
    var userId = opts.userId;
    var postJson = opts.postJson;
    var timeoutMs = opts.timeoutMs || 3000;
    var setT = opts.setTimeout;
    var clearT = opts.clearTimeout;

    return {
      // cb(err, {url, playSessionId, mediaSourceId, container}) — cb
      // fires exactly once; a reply that loses the race against the
      // timeout is dropped (the SPA handoff already started).
      resolve: function (item, cb) {
        var done = false;
        var timer = setT(function () {
          if (done) {
            return;
          }
          done = true;
          cb(new Error("timeout"), null);
        }, timeoutMs);
        postJson(
          base + "/Items/" + item.id + "/PlaybackInfo?userId=" + userId,
          { "X-Emby-Token": token },
          { DeviceProfile: Lite.deviceProfile(), AutoOpenLiveStream: false },
          function (err, body) {
            if (done) {
              return;
            }
            done = true;
            clearT(timer);
            if (err) {
              cb(err, null);
              return;
            }
            var sources = (body && body.MediaSources) || [];
            var ms = null;
            var kind = "direct";
            var i;
            for (i = 0; i < sources.length; i++) {
              if (sources[i] && sources[i].SupportsDirectPlay === true) {
                ms = sources[i];
                kind = "direct";
                break;
              }
            }
            // Slice 3: DirectStream remux fallback — server re-muxes
            // into mkv without re-encoding codecs; URL is in
            // ms.TranscodingUrl (relative, prefix with base).
            if (!ms) {
              for (i = 0; i < sources.length; i++) {
                if (
                  sources[i] &&
                  sources[i].SupportsDirectStream === true &&
                  sources[i].TranscodingUrl
                ) {
                  ms = sources[i];
                  kind = "remux";
                  break;
                }
              }
            }
            // JELA-137: the shape a REAL 10.11 server answers with for a
            // container-mismatch remux (see remuxOnlyReasons above) —
            // SupportsDirectStream stays false there, so without this
            // scan the remux path is dead code against production
            // servers and every eligible press falls back to the SPA.
            if (!ms) {
              for (i = 0; i < sources.length; i++) {
                if (
                  sources[i] &&
                  sources[i].TranscodingUrl &&
                  remuxOnlyReasons(sources[i].TranscodingUrl)
                ) {
                  ms = sources[i];
                  kind = "remux";
                  break;
                }
              }
            }
            if (!ms || !ms.Id || (!ms.Container && kind !== "remux")) {
              cb(new Error("no-direct-play"), null);
              return;
            }
            // JELA-137: the DeviceId the server baked into the
            // TranscodingUrl names the ffmpeg job — DELETE
            // /Videos/ActiveEncodings needs it to reap the remux on
            // exit (server CPU headroom). Absent → the Stopped beacon
            // is the only reaper.
            var deviceId = null;
            if (kind === "remux") {
              var dm = /[?&][Dd]eviceId=([^&]+)/.exec(ms.TranscodingUrl);
              if (dm) {
                deviceId = dm[1];
                try {
                  deviceId = global.decodeURIComponent(dm[1]);
                } catch (_dm) {}
              }
            }
            cb(null, {
              // Direct-play: build stream.{ms.Container} URL.
              // Remux: use ms.TranscodingUrl (server-built, relative).
              url:
                kind === "remux"
                  ? base + ms.TranscodingUrl
                  : base +
                    "/Videos/" +
                    item.id +
                    "/stream." +
                    ms.Container +
                    "?static=true&mediaSourceId=" +
                    ms.Id +
                    "&api_key=" +
                    token,
              playSessionId: (body && body.PlaySessionId) || null,
              mediaSourceId: ms.Id,
              container: ms.Container || null,
              kind: kind,
              deviceId: deviceId,
            });
          },
        );
      },
    };
  };

  /* ------------------------------------------------------------------
   * Progress reporter — what makes "resume" real (design §4, gate G5).
   * Fire-and-forget POSTs to /Sessions/Playing[/Progress|/Stopped];
   * the final Stopped PositionTicks is what the server persists as
   * UserData, and what the next boot's Continue Watching row reads.
   * ---------------------------------------------------------------- */

  Lite.TICKS_PER_MS = 10000;

  Lite.createReporter = function (opts) {
    var base = opts.base;
    var token = opts.token;
    var postJson = opts.postJson;
    var itemId = opts.itemId;
    var mediaSourceId = opts.mediaSourceId;
    var playSessionId = opts.playSessionId;
    var positionMs = opts.positionMs; // function () -> current position
    var isPaused = opts.isPaused; // function () -> bool
    // JELA-137: remux sessions report DirectStream — the server keys
    // transcode-session bookkeeping (and stats) off PlayMethod.
    var playMethod = opts.playMethod || "DirectPlay";
    var intervalMs = opts.intervalMs || 10000;
    var setI = opts.setInterval;
    var clearI = opts.clearInterval;

    var timer = null;
    var stopped = false;

    function body(extra) {
      var b = {
        ItemId: itemId,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: Math.round(positionMs() * Lite.TICKS_PER_MS),
        PlayMethod: playMethod,
        CanSeek: true,
      };
      var k;
      for (k in extra) {
        if (extra.hasOwnProperty(k)) {
          b[k] = extra[k];
        }
      }
      return b;
    }

    function post(path, b) {
      // fire-and-forget: a lost beacon must never disturb playback
      try {
        postJson(base + path, { "X-Emby-Token": token }, b, null);
      } catch (_) {}
    }

    var reporter = {
      start: function () {
        if (stopped) {
          return;
        }
        post("/Sessions/Playing", body({}));
        if (!timer) {
          timer = setI(function () {
            reporter.progress("timeupdate");
          }, intervalMs);
        }
      },
      progress: function (eventName) {
        if (stopped) {
          return;
        }
        post(
          "/Sessions/Playing/Progress",
          body({
            IsPaused: !!isPaused(),
            EventName: eventName || "timeupdate",
          }),
        );
      },
      // One-shot: after stop() every other beacon is inert, so a late
      // interval tick or key can never resurrect a finished session
      // server-side.
      stop: function (finalMs) {
        if (stopped) {
          return;
        }
        stopped = true;
        if (timer) {
          clearI(timer);
          timer = null;
        }
        post("/Sessions/Playing/Stopped", {
          ItemId: itemId,
          MediaSourceId: mediaSourceId,
          PlaySessionId: playSessionId,
          PositionTicks: Math.round(
            (typeof finalMs === "number" ? finalMs : positionMs()) *
              Lite.TICKS_PER_MS,
          ),
        });
      },
    };
    return reporter;
  };

  /* ------------------------------------------------------------------
   * Playback OSD — drawn on a dedicated transparent canvas ABOVE the
   * AVPlay video plane (the "canvas hole", spike gate G2). Everything
   * here starts from clearRect, never an opaque fill: any opaque pixel
   * covers the video. Redraws are driven by the session's 500ms tick +
   * key presses — no rAF loop runs during playback.
   * ---------------------------------------------------------------- */

  Lite.fmtTime = function (ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = (h && m < 10 ? "0" : "") + m;
    var ss = (sec < 10 ? "0" : "") + sec;
    return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  };

  var OSD = {
    barH: 8,
    padX: 90,
    padB: 60,
    scrimH: 190,
    accent: "#00a4dc",
    hideMs: 4000,
  };

  Lite.createOsd = function (opts) {
    var ctx = opts.ctx;
    var vw = opts.vw || LAYOUT.vw;
    var vh = opts.vh || LAYOUT.vh;
    var title = opts.title || "";
    var now = opts.now;
    var hideMs = opts.hideMs || OSD.hideMs;

    var shownAt = -1; // -1 = hidden
    var clean = false; // canvas known fully transparent

    var osd = {
      show: function () {
        shownAt = now();
      },
      hide: function () {
        shownAt = -1;
      },
      // Auto-hide: visible() flips false hideMs after the last show().
      // Paused/buffering keep the overlay up regardless (see draw).
      visible: function () {
        if (shownAt < 0) {
          return false;
        }
        if (now() - shownAt >= hideMs) {
          shownAt = -1;
          return false;
        }
        return true;
      },

      // s: {posMs, durMs, paused, buffering}
      draw: function (s) {
        if (!osd.visible() && !s.paused && !s.buffering) {
          if (!clean) {
            ctx.clearRect(0, 0, vw, vh);
            clean = true;
          }
          return false;
        }
        clean = false;
        ctx.clearRect(0, 0, vw, vh);

        // bottom scrim so the text reads over any video
        ctx.fillStyle = "rgba(16,16,16,0.72)";
        ctx.fillRect(0, vh - OSD.scrimH, vw, OSD.scrimH);

        // state glyph (canvas paths — TV font glyph coverage is not
        // trustworthy) + title
        var gx = OSD.padX;
        var gy = vh - 162;
        ctx.fillStyle = COLORS.title;
        if (s.paused) {
          ctx.fillRect(gx, gy, 12, 34);
          ctx.fillRect(gx + 22, gy, 12, 34);
        } else {
          ctx.beginPath();
          ctx.moveTo(gx, gy);
          ctx.lineTo(gx, gy + 34);
          ctx.lineTo(gx + 30, gy + 17);
          ctx.closePath();
          ctx.fill();
        }
        ctx.font = "600 32px sans-serif";
        ctx.fillText(title, gx + 56, gy + 28);

        // seek bar + clock
        var barW = vw - 2 * OSD.padX;
        var barY = vh - OSD.padB - OSD.barH;
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(OSD.padX, barY, barW, OSD.barH);
        var frac = s.durMs > 0 ? clamp(s.posMs / s.durMs, 0, 1) : 0;
        ctx.fillStyle = OSD.accent;
        ctx.fillRect(OSD.padX, barY, Math.round(barW * frac), OSD.barH);
        ctx.fillStyle = COLORS.title;
        ctx.font = "400 24px sans-serif";
        ctx.fillText(
          Lite.fmtTime(s.posMs) + " / " + Lite.fmtTime(s.durMs),
          OSD.padX,
          barY - 12,
        );

        if (s.buffering) {
          ctx.font = "400 34px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("Buffering…", vw / 2, vh / 2);
          ctx.textAlign = "left";
        }
        return true;
      },
    };
    return osd;
  };

  /* ------------------------------------------------------------------
   * Playback session — one OK press end to end: player lifecycle,
   * remote keys, OSD redraws, progress beacons, exit restore.
   * ---------------------------------------------------------------- */

  // Remote keys during native playback (design §4). The Media* codes
  // are Samsung tvinputdevice codes; registration happens in boot.
  // Red (403) exits playback like Back — the SPA escape hatch stays a
  // home-screen affordance.
  Lite.PLAYER_KEYS = {
    13: "playpause", // OK
    10252: "playpause", // MediaPlayPause
    415: "play", // MediaPlay
    19: "pause", // MediaPause
    37: "rew", // left  = -10s (Netflix-style asymmetric, design §7)
    412: "rew", // MediaRewind
    39: "ff", // right = +30s
    417: "ff", // MediaFastForward
    38: "osd",
    40: "osd",
    10009: "back",
    403: "back",
  };

  Lite.SEEK_BACK_MS = 10000;
  Lite.SEEK_FWD_MS = 30000;
  // JELA-137 (G5 follow-up): AVPlay snaps a resume seek to a keyframe —
  // observed +9.9s PAST the requested position after a seek burst on
  // the Q60R. Resume therefore backs off by one worst-case keyframe
  // interval so a forward snap can never overshoot the stop point;
  // rewatching ≤10s beats skipping unseen footage (and matches the
  // deliberate re-orientation preroll every major player ships).
  Lite.RESUME_KEYFRAME_BACK_MS = 10000;
  // Repeated left/right presses compound into ONE pipeline seek: each
  // press moves a preview target on the OSD and re-arms this debounce;
  // AVPlay only sees the settled target (G3: a seek costs ~0.4-1s on
  // the Q60R — five queued seeks would wedge the pipeline for seconds).
  Lite.SEEK_DEBOUNCE_MS = 350;
  var OSD_TICK_MS = 500;
  // Never seek into the last 2s: landing exactly on the tail races
  // onstreamcompleted against the seek callback.
  var SEEK_TAIL_GUARD_MS = 2000;

  Lite.createPlaybackSession = function (opts) {
    var avplay = opts.avplay;
    var reporter = opts.reporter;
    var osd = opts.osd;
    var now = opts.now;
    var setT = opts.setTimeout;
    var clearT = opts.clearTimeout;
    var setI = opts.setInterval;
    var clearI = opts.clearInterval;
    var runtimeMs = opts.runtimeMs || 0; // RunTimeTicks fallback clock
    var diag = opts.diag || {};

    var started = false; // first frame seen
    var finished = false;
    var pendingSeek = -1; // compound-seek preview target, -1 = none
    var seekTimer = null;
    var drawTimer = null;
    var kind = "direct";

    // JELA-137: a remux seek is a stream RESTART (fresh one-shot player
    // on a new StartTimeTicks URL), so player creation must be
    // repeatable. session.player is re-pointed on every restart — the
    // boot's reporter closures read it per call, so beacons follow.
    function makePlayer() {
      return Lite.createPlayer({
        avplay: avplay,
        now: now,
        diag: diag,
        onFirstFrame: function () {
          if (!started) {
            started = true;
            reporter.start();
          } else {
            // a restarted remux stream settled at its new position
            reporter.progress("timeupdate");
          }
          osd.show();
          redraw();
        },
        onEnd: function () {
          finish("end");
        },
        onError: function (why) {
          if (started) {
            finish("err");
            return;
          }
          // Pre-first-frame failure → the caller falls back to the SPA
          // deep-link (design §1); the player already tore itself down.
          cleanup();
          finished = true;
          if (opts.onFallback) {
            opts.onFallback(why);
          }
        },
      });
    }

    var player = makePlayer();

    function durMs() {
      var d = player.durationMs();
      return d > 0 ? d : runtimeMs;
    }

    function redraw() {
      osd.draw({
        posMs: pendingSeek >= 0 ? pendingSeek : player.currentTimeMs(),
        durMs: durMs(),
        paused: player.state() === "paused",
        buffering: player.buffering(),
      });
    }

    function cleanup() {
      if (seekTimer) {
        clearT(seekTimer);
        seekTimer = null;
      }
      if (drawTimer) {
        clearI(drawTimer);
        drawTimer = null;
      }
    }

    function finish(why) {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      // Position BEFORE stop(): currentTimeMs freezes at the last
      // observed tick once the pipeline closes (G4), and that frozen
      // value is both the Stopped beacon and the local Resume patch.
      var ms = player.currentTimeMs();
      player.stop();
      reporter.stop(ms);
      if (opts.onExit) {
        opts.onExit(ms, why);
      }
    }

    // Remux seek = teardown + reopen at the target (no byte ranges on a
    // growing transcode output). The old ffmpeg job is reaped first
    // (stopEncoding) so two remuxes never run concurrently — the whole
    // point of the JELA-137 server-CPU-headroom rule. Same reporter,
    // same PlaySessionId: the server sees one continuous session.
    function restartAt(targetMs) {
      if (finished || !opts.urlAt) {
        return;
      }
      player.stop();
      if (opts.stopEncoding) {
        try {
          opts.stopEncoding();
        } catch (_) {}
      }
      player = makePlayer();
      session.player = player;
      player.open(opts.urlAt(targetMs), targetMs, "remux");
      osd.show();
      redraw();
    }

    function applySeek() {
      seekTimer = null;
      var target = pendingSeek;
      pendingSeek = -1;
      if (kind === "remux") {
        restartAt(target);
        return;
      }
      player.seekTo(target, function () {
        reporter.progress("timeupdate");
        redraw();
      });
    }

    function nudge(deltaMs) {
      var base = pendingSeek >= 0 ? pendingSeek : player.currentTimeMs();
      var d = durMs();
      var t = base + deltaMs;
      if (t < 0) {
        t = 0;
      }
      if (d > 0 && t > d - SEEK_TAIL_GUARD_MS) {
        t = Math.max(0, d - SEEK_TAIL_GUARD_MS);
      }
      pendingSeek = t;
      if (seekTimer) {
        clearT(seekTimer);
      }
      seekTimer = setT(applySeek, Lite.SEEK_DEBOUNCE_MS);
      osd.show();
      redraw();
    }

    var session = {
      player: player,

      start: function (url, resumeMs, kindArg) {
        kind = kindArg || "direct";
        // Keyframe-snap tolerance (G5): back the resume target off so a
        // forward snap lands at-or-before the stop point. Applies to
        // both kinds — ffmpeg's -ss also snaps to a keyframe.
        var pos =
          resumeMs > 0
            ? Math.max(0, resumeMs - Lite.RESUME_KEYFRAME_BACK_MS)
            : 0;
        if (kind === "remux" && pos > 0) {
          // The start position rides the URL, not a pipeline seek.
          if (opts.urlAt) {
            url = opts.urlAt(pos);
          } else {
            pos = 0; // no URL builder → play from the head, never lie
          }
        }
        var ok = player.open(url, pos, kind);
        if (ok && !finished) {
          osd.show();
          drawTimer = setI(redraw, OSD_TICK_MS);
        }
        return ok;
      },

      active: function () {
        return !finished;
      },

      // keyCode in, true when the key mapped to a player action. While
      // a session is live the boot key handler swallows EVERY key, so
      // an unmapped code is inert rather than leaking into home nav.
      key: function (keyCode) {
        if (finished) {
          return false;
        }
        var action = Lite.PLAYER_KEYS[keyCode];
        if (!action) {
          return false;
        }
        if (action === "back") {
          finish("back");
          return true;
        }
        if (action === "rew") {
          nudge(-Lite.SEEK_BACK_MS);
          return true;
        }
        if (action === "ff") {
          nudge(Lite.SEEK_FWD_MS);
          return true;
        }
        if (action === "osd") {
          osd.show();
          redraw();
          return true;
        }
        // play / pause / playpause
        var st = player.state();
        var toggled = false;
        if (action === "playpause") {
          toggled = player.playPause();
        } else if (action === "play" && st === "paused") {
          toggled = player.playPause();
        } else if (action === "pause" && st === "playing") {
          toggled = player.playPause();
        }
        if (toggled) {
          reporter.progress(player.state() === "paused" ? "pause" : "unpause");
        }
        osd.show();
        redraw();
        return true;
      },

      // v2.0.24 interplay (design §4): once background-support=enable
      // ships, the app suspends instead of dying — park/unpark the
      // AVPlay pipeline on visibilitychange. Harmless today: pre-
      // v2.0.24 the platform kills the whole app instead.
      suspend: function () {
        if (finished) {
          return;
        }
        try {
          avplay.suspend();
        } catch (_) {}
      },
      restore: function () {
        if (finished) {
          return;
        }
        try {
          avplay.restore();
        } catch (_) {}
      },

      finish: finish,
    };
    return session;
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

  // POST twin of xhrFetchJson. cb is optional: the progress reporter
  // fires beacons and never looks back.
  function xhrPostJson(url, headers, body, cb) {
    var xhr = new global.XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    var k;
    for (k in headers) {
      if (headers.hasOwnProperty(k)) {
        xhr.setRequestHeader(k, headers[k]);
      }
    }
    if (cb) {
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) {
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          cb(new Error("HTTP " + xhr.status + " " + url), null);
          return;
        }
        try {
          cb(null, xhr.responseText ? JSON.parse(xhr.responseText) : null);
        } catch (e) {
          cb(e, null);
        }
      };
    }
    xhr.send(JSON.stringify(body));
  }

  // Fire-and-forget request with no body and no reply handling —
  // JELA-137: DELETE /Videos/ActiveEncodings reaps the server-side
  // ffmpeg remux job on exit and before every seek-restart.
  function xhrSend(method, url, headers) {
    var xhr = new global.XMLHttpRequest();
    xhr.open(method, url, true);
    var k;
    for (k in headers) {
      if (headers.hasOwnProperty(k)) {
        xhr.setRequestHeader(k, headers[k]);
      }
    }
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

    // M3: the AVPlay adapter exists only once the v2.0.25 widget
    // (avplay privilege + webapis.js include) is installed — everywhere
    // else native playback reports unsupported and OK stays on the SPA
    // deep-link path.
    var avplay = null;
    try {
      if (win.webapis && win.webapis.avplay) {
        avplay = win.webapis.avplay;
      }
    } catch (_) {}

    // Media transport keys are opt-in on Tizen: without registerKey the
    // remote's MediaPlayPause/… codes never reach the page. Only worth
    // registering when native playback is possible at all.
    if (avplay) {
      try {
        var tid = win.tizen && win.tizen.tvinputdevice;
        if (tid && tid.registerKey) {
          var mediaKeys = [
            "MediaPlayPause",
            "MediaPlay",
            "MediaPause",
            "MediaRewind",
            "MediaFastForward",
          ];
          var mki;
          for (mki = 0; mki < mediaKeys.length; mki++) {
            try {
              tid.registerKey(mediaKeys[mki]);
            } catch (_mk) {}
          }
        }
      } catch (_tk) {}
    }

    // Timers come off the window so the node testkit (bare vm sandbox,
    // no globals) can fake them per test.
    function setT(f, ms) {
      return win.setTimeout(f, ms);
    }
    function clearT(t) {
      win.clearTimeout(t);
    }
    function setI(f, ms) {
      return win.setInterval(f, ms);
    }
    function clearI(t) {
      win.clearInterval(t);
    }
    function nowMs() {
      return new global.Date().getTime();
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

    // Native playback state (M3 slice 2). pending covers the async gap
    // between OK and the PlaybackInfo answer (double-OK must not spawn
    // two sessions); declineId is the one-shot fallback latch (see
    // startNative's bail).
    var playback = { session: null, pending: false, declineId: null };
    var pbInfo = null;

    // A consumed key must stop HERE: the widget keeps a window-level
    // Back backstop that EXITS THE APP on 10009 until the SPA flags
    // boot-done — which never happens on the Lite path. Found live on
    // the Q60R (slice-2 QA): Back-exit from native playback closed the
    // pipeline cleanly, then the bubbled keydown reached the backstop
    // and the platform tore down the whole widget ~0.5s later.
    // stopPropagation still lets other document-level listeners run
    // (the shell's bg-warm re-arm rides document capture too).
    function eatKey(ev) {
      if (ev.preventDefault) {
        ev.preventDefault();
      }
      if (ev.stopPropagation) {
        ev.stopPropagation();
      }
    }

    function onKey(ev) {
      // While a native session is live it owns EVERY key: mapped codes
      // act on the player, unmapped ones are swallowed so nothing
      // leaks into home nav under the video plane.
      if (playback.session && playback.session.active()) {
        playback.session.key(ev.keyCode);
        eatKey(ev);
        return;
      }
      var action = Lite.KEYS[ev.keyCode];
      if (!action) {
        return;
      }
      eatKey(ev);
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
    }
    doc.addEventListener("keydown", onKey, true);

    // v2.0.24 interplay (design §4): with background-support enabled
    // the app suspends instead of dying — park/unpark the pipeline.
    // Pre-v2.0.24 (today) the platform kills the app outright, so this
    // listener simply never fires with a live session.
    doc.addEventListener("visibilitychange", function () {
      var s = playback.session;
      if (!s || !s.active()) {
        return;
      }
      if (doc.hidden) {
        s.suspend();
      } else {
        s.restore();
      }
    });

    // The whole native OK press: PlaybackInfo decision → canvas hole →
    // player/reporter/OSD session → exit restore. Every pre-first-frame
    // failure funnels into bail(), which re-enters app.onOpen with the
    // decline latch set so the shell fork's second openNative call
    // returns false and the M2 SPA deep-link runs unchanged.
    function startNative(item) {
      playback.pending = true;
      var d = { st: "info" }; // __shellLite.player diag surface (§4)
      try {
        if (win.__shellLite) {
          win.__shellLite.player = d;
        }
      } catch (_d) {}
      if (!pbInfo) {
        pbInfo = Lite.createPlaybackInfo({
          base: creds.base,
          token: creds.token,
          userId: creds.userId,
          postJson: xhrPostJson,
          setTimeout: setT,
          clearTimeout: clearT,
        });
      }
      // Immediate feedback on the home canvas while PlaybackInfo runs;
      // cleared on either outcome (player takes over / SPA handoff).
      renderer.setMessage("Loading…");
      schedule();

      function bail(why) {
        d.st = "err";
        d.why = why;
        playback.pending = false;
        playback.session = null;
        renderer.setMessage(null);
        schedule();
        playback.declineId = item.id;
        if (app.onOpen) {
          app.onOpen(item);
        }
      }

      pbInfo.resolve(item, function (err, info) {
        if (err) {
          bail("info:" + (err && err.message));
          return;
        }
        // Canvas hole (spike gate G2): AVPlay renders on a plane BEHIND
        // the web layer. The home canvas paints an opaque bg, so hide
        // it and put a dedicated transparent OSD canvas above the
        // video; body must not paint either while the hole is open.
        var osdCanvas = doc.createElement("canvas");
        osdCanvas.width = LAYOUT.vw;
        osdCanvas.height = LAYOUT.vh;
        osdCanvas.style.cssText =
          "position:fixed;left:0;top:0;width:100%;height:100%;" +
          "background:transparent";
        var prevBodyBg = doc.body.style.background;
        var restored = false;
        function restoreHome(patchMs) {
          if (restored) {
            return;
          }
          restored = true;
          playback.pending = false;
          try {
            if (osdCanvas.parentNode) {
              osdCanvas.parentNode.removeChild(osdCanvas);
            }
          } catch (_r) {}
          doc.body.style.background = prevBodyBg;
          canvas.style.display = "";
          renderer.setMessage(null);
          if (typeof patchMs === "number" && patchMs >= 0) {
            // Local Resume patch: the card object lives in the scene,
            // so the next OK resumes from here even before the server
            // round-trip (SWR revalidate) catches up. Best-effort — a
            // scene rebuild from fresher server data supersedes it.
            item.posTicks = Math.round(patchMs * Lite.TICKS_PER_MS);
          }
          renderer.invalidate();
          schedule();
        }

        doc.body.appendChild(osdCanvas);
        doc.body.style.background = "transparent";
        canvas.style.display = "none";
        renderer.setMessage(null);

        // JELA-137 server CPU headroom: a remux leaves an ffmpeg job
        // running server-side. The Stopped beacon usually reaps it, but
        // that beacon is fire-and-forget — kill the job explicitly on
        // every exit and before every seek-restart. Best-effort: needs
        // the DeviceId the server baked into TranscodingUrl.
        function killEncoding() {
          if (info.kind !== "remux" || !info.deviceId) {
            return;
          }
          try {
            xhrSend(
              "DELETE",
              creds.base +
                "/Videos/ActiveEncodings?deviceId=" +
                encodeURIComponent(info.deviceId) +
                (info.playSessionId
                  ? "&playSessionId=" + encodeURIComponent(info.playSessionId)
                  : ""),
              { "X-Emby-Token": creds.token },
            );
          } catch (_k) {}
        }

        var osd = Lite.createOsd({
          ctx: osdCanvas.getContext("2d"),
          title: item.name || "",
          now: nowMs,
        });
        var reporter = Lite.createReporter({
          base: creds.base,
          token: creds.token,
          postJson: xhrPostJson,
          itemId: item.id,
          mediaSourceId: info.mediaSourceId,
          playSessionId: info.playSessionId,
          positionMs: function () {
            return session.player.currentTimeMs();
          },
          isPaused: function () {
            return session.player.state() === "paused";
          },
          playMethod: info.kind === "remux" ? "DirectStream" : "DirectPlay",
          setInterval: setI,
          clearInterval: clearI,
        });
        var session = Lite.createPlaybackSession({
          avplay: avplay,
          reporter: reporter,
          osd: osd,
          now: nowMs,
          setTimeout: setT,
          clearTimeout: clearT,
          setInterval: setI,
          clearInterval: clearI,
          runtimeMs: item.runtimeTicks
            ? Math.round(item.runtimeTicks / Lite.TICKS_PER_MS)
            : 0,
          diag: d,
          // Remux plumbing (JELA-137): every start/seek position rides
          // the URL as StartTimeTicks — the transcode output has no
          // byte ranges for the pipeline to seek over.
          urlAt:
            info.kind === "remux"
              ? function (ms) {
                  return (
                    info.url +
                    (info.url.indexOf("?") >= 0 ? "&" : "?") +
                    "StartTimeTicks=" +
                    Math.round(ms * Lite.TICKS_PER_MS)
                  );
                }
              : null,
          stopEncoding: killEncoding,
          onExit: function (ms) {
            playback.session = null;
            killEncoding();
            restoreHome(ms);
          },
          onFallback: function (why) {
            playback.session = null;
            killEncoding();
            restoreHome(-1);
            bail(why);
          },
        });
        playback.session = session;
        var resumeMs = item.posTicks
          ? Math.round(item.posTicks / Lite.TICKS_PER_MS)
          : 0;
        session.start(info.url, resumeMs, info.kind);
      });
    }

    // Shared teardown-first guard for handoff()/destroy(): a leaked
    // AVPlay pipeline wedges the platform until app restart (G4).
    function stopSession() {
      try {
        if (playback.session && playback.session.active()) {
          playback.session.finish("teardown");
        }
      } catch (_s) {}
    }

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
      // M3 native playback surface for the shell's onOpen fork (behind
      // localStorage["jellyfin.lite.native"], default OFF). Returns
      // true when the native pipeline takes the OK press; false hands
      // the caller back to the M2 SPA deep-link. True is optimistic —
      // the PlaybackInfo answer is async — so a native failure later
      // re-enters app.onOpen with the decline latch set, and the
      // shell fork's second call here returns false into the same M2
      // deep-link (worst case = exactly today's behaviour, design §1).
      nativeSupported: !!avplay,
      openNative: function (item) {
        if (!avplay || !item || !Lite.isPlayableLeaf(item.type)) {
          return false;
        }
        if (playback.declineId && playback.declineId === item.id) {
          playback.declineId = null;
          return false;
        }
        if (
          playback.pending ||
          (playback.session && playback.session.active())
        ) {
          // one press in flight already — swallow the repeat
          return true;
        }
        startNative(item);
        return true;
      },
      // M2 handoff: stop input but KEEP the canvas up showing a message,
      // so the screen isn't black for the seconds until the SPA's
      // document.write teardown replaces the document (canvas included).
      handoff: function (message) {
        stopSession();
        doc.removeEventListener("keydown", onKey, true);
        renderer.setMessage(message || "Opening…");
        schedule();
      },
      destroy: function () {
        // §4 rule for the v2.0.24 configEpoch teardown: stop+close the
        // player FIRST, then take the document apart.
        stopSession();
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
