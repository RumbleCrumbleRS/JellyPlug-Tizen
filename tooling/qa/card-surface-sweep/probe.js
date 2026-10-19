/* JELA-696 blast-radius tour probe.
 *
 * Drives the SPA through every native card surface and records, per stop:
 *   - cards actually in the DOM (max + final)
 *   - itemsContainer count / innerHTML size
 *   - every window error AND unhandledrejection raised while on that stop
 *   - every getItemsHtml throw (emby-itemscontainer prototype wrap)
 *
 * The tour runs INSIDE the page so no CDP traffic starves the M63 main thread
 * during boot. Results land in localStorage['jela696.probe'].
 * ES5 only.
 */
(function (w) {
  'use strict';
  var T0 = Date.now();
  var K = 'jela696.probe';

  var STOPS = (function () {
    var s = [];
    try { s = JSON.parse(localStorage.getItem('jela696.stops') || '[]'); } catch (e) {}
    return s;
  })();
  var BOOT_MS = Number(localStorage.getItem('jela696.bootMs') || 55000);
  var STOP_MS = Number(localStorage.getItem('jela696.stopMs') || 14000);

  var out = {
    t0: T0,
    arm: localStorage.getItem('jela696.arm') || '?',
    stops: [],       // one record per stop
    err: [],         // [t, kind, msg, where, stopIdx]
    throws: [],      // [t, 'getItemsHtml', msg, stopIdx]
    notes: [],
    shim: null
  };
  var cur = -1;      // index of the stop we are currently sitting on

  function el() { return Date.now() - T0; }
  function save() { try { localStorage.setItem(K, JSON.stringify(out)); } catch (e) {} }

  function pushErr(kind, msg, where) {
    if (out.err.length < 200) out.err.push([el(), kind, String(msg || '').slice(0, 220), String(where || '').slice(-70), cur]);
  }

  try {
    w.addEventListener('error', function (e) {
      pushErr('error', (e && e.message) || '', ((e && e.filename) || '') + ':' + (e && e.lineno));
    }, true);
  } catch (e) {}
  try {
    w.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      pushErr('reject', (r && (r.message || r)) || '', (r && r.stack ? String(r.stack).split('\n')[1] : ''));
    });
  } catch (e) {}

  // ---- emby-itemscontainer render-chain wrap --------------------------------
  function wrapGetItemsHtml(ic) {
    var g = ic.getItemsHtml;
    if (typeof g !== 'function' || g.__j696) return;
    var wrapped = function () {
      try { return g.apply(this, arguments); }
      catch (e) {
        if (out.throws.length < 200) out.throws.push([el(), 'getItemsHtml', String(e).slice(0, 200), cur]);
        save();
        throw e;
      }
    };
    wrapped.__j696 = 1;
    try { ic.getItemsHtml = wrapped; } catch (e) {}
  }
  function instrumentProto(proto) {
    if (!proto || proto.__j696) return false;
    proto.__j696 = 1;
    var origRefresh = proto.refreshItems;
    if (typeof origRefresh === 'function') {
      proto.refreshItems = function () {
        wrapGetItemsHtml(this);
        var self = this, r;
        try { r = origRefresh.apply(this, arguments); }
        catch (e) {
          if (out.throws.length < 200) out.throws.push([el(), 'refreshItems', String(e).slice(0, 200), cur]);
          throw e;
        }
        if (r && typeof r.then === 'function') {
          r.then(null, function (e2) {
            if (out.throws.length < 200) out.throws.push([el(), 'refreshItems-REJECT', String(e2 && (e2.message || e2)).slice(0, 200), cur]);
            save();
          });
        }
        return r;
      };
    }
    return true;
  }
  function hookRegister(D) {
    if (!D || !D.registerElement || D.registerElement.__j696) return false;
    var orig = D.registerElement;
    var wrapped = function (name, opts) {
      if (name === 'emby-itemscontainer') instrumentProto(opts && opts.prototype);
      return orig.apply(this, arguments);
    };
    wrapped.__j696 = 1;
    try { D.registerElement = wrapped; return true; } catch (e) { return false; }
  }
  hookRegister(w.Document && w.Document.prototype) || hookRegister(w.document);

  // ---- DOM census -----------------------------------------------------------
  // The SPA keeps every visited page in the DOM behind `.hide`, so a
  // document-wide `.card` count is dominated by pages we already left.
  // Everything below is scoped to the VISIBLE page.
  function activePage() {
    var d = w.document, i, p;
    try {
      var pages = d.querySelectorAll('.page');
      for (i = pages.length - 1; i >= 0; i--) {
        p = pages[i];
        if (!/(^|\s)hide(\s|$)/.test(String(p.className || ''))) return p;
      }
      // React views (search, settings) are not `.page`
      var rv = d.querySelector('.mainAnimatedPage:not(.hide)') || d.getElementById('reactRoot') || d.querySelector('.skinBody');
      return rv || null;
    } catch (e) { return null; }
  }

  function census() {
    var d = w.document, p = activePage();
    var scope = p || d;
    var cards = 0, cardsWithId = 0, ics = 0, icHtml = 0, imgs = 0, empty = 0, eb = 0;
    try {
      cards = scope.querySelectorAll('.card').length;
      cardsWithId = scope.querySelectorAll('.card[data-id]').length;
      var list = scope.querySelectorAll('.itemsContainer');
      ics = list.length;
      for (var i = 0; i < list.length; i++) icHtml += (list[i].innerHTML || '').length;
      imgs = scope.querySelectorAll('.cardImageContainer, .lazy, img').length;
      empty = scope.querySelectorAll('.noItemsMessage, .emptyMessage').length;
      eb = d.querySelectorAll('.errorBoundary').length;
    } catch (e) {}
    var page = '';
    try { page = p ? String(p.id || p.className || '').slice(0, 60) : '(none)'; } catch (e) {}
    // per-section breakdown: which named row rendered how many cards
    var secs = [];
    try {
      var sl = scope.querySelectorAll('.verticalSection, .homeSection, .detailSection');
      for (var j = 0; j < sl.length && j < 40; j++) {
        var t = sl[j].querySelector('.sectionTitle, h2, h3');
        secs.push([String((t && (t.textContent || t.innerText)) || '?').replace(/\s+/g, ' ').slice(0, 34),
                   sl[j].querySelectorAll('.card').length]);
      }
    } catch (e) {}
    return { cards: cards, cardsWithId: cardsWithId, ics: ics, icHtml: icHtml, imgs: imgs,
             empty: empty, errorBoundary: eb, secs: secs,
             page: page, hash: String(w.location.hash).slice(0, 90),
             docCards: (function () { try { return d.querySelectorAll('.card').length; } catch (e) { return -1; } })(),
             scopeLen: (function () { try { return (scope.innerHTML || '').length; } catch (e) { return -1; } })() };
  }

  // ---- tour state machine ---------------------------------------------------
  var phase = 'boot';
  var stopStart = 0;
  var rec = null;

  function beginStop(i) {
    cur = i;
    rec = { i: i, name: STOPS[i] ? STOPS[i].name : ('stop' + i),
            route: STOPS[i] ? STOPS[i].route : '', tEnter: el(),
            samples: [], max: null, fin: null, errN0: out.err.length, thrN0: out.throws.length };
    out.stops.push(rec);
    if (STOPS[i] && STOPS[i].route) {
      try { w.location.hash = STOPS[i].route; } catch (e) { pushErr('nav', String(e), STOPS[i].route); }
    }
    stopStart = Date.now();
    save();
  }

  function endStop() {
    if (!rec) return;
    rec.fin = census();
    rec.errs = out.err.slice(rec.errN0).map(function (e) { return [e[1], e[2]]; });
    rec.thrs = out.throws.slice(rec.thrN0).map(function (e) { return [e[1], e[2]]; });
    rec.nErr = out.err.length - rec.errN0;
    rec.nThrow = out.throws.length - rec.thrN0;
    rec.tExit = el();
    save();
  }

  setInterval(function () {
    var c = census();
    if (phase === 'boot') {
      if (Date.now() - T0 >= BOOT_MS) { phase = 'tour'; beginStop(0); }
      return;
    }
    if (phase !== 'tour' || !rec) return;
    if (rec.samples.length < 60) rec.samples.push([el(), c.cards, c.cardsWithId, c.ics]);
    if (!rec.max || c.cards > rec.max.cards) rec.max = c;
    if (Date.now() - stopStart >= STOP_MS) {
      endStop();
      if (cur + 1 < STOPS.length) beginStop(cur + 1);
      else { phase = 'done'; finish(); }
    }
    save();
  }, 500);

  function finish() {
    try {
      if (rec && !rec.fin) endStop();
      out.shim = w.__shellWorkerShim ? JSON.parse(JSON.stringify(w.__shellWorkerShim)) : null;
      out.workerNative = (function () { try { return String(w.Worker).indexOf('native code') >= 0 ? 'native' : 'wrapped'; } catch (e) { return '?'; } })();
      out.phase = phase;
      out.done = (out.done | 0) + 1;
    } catch (e) { out.notes.push('finish:' + String(e).slice(0, 150)); }
    save();
  }
  w.__jela696finish = finish;
  save();
})(window);
