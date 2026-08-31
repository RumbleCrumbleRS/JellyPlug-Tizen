#!/usr/bin/env node
/*
 * jsi-jp820-patch.test.cjs — JELA-820.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. the patcher lands its anchors, fails closed, stays reversible, and
 *      composes with jp815 and jp816 in the one supported order;
 *   2. the PATCHED CODE, instantiated in `node:vm` against a stub DOM, actually
 *      reserves a slot and withholds the fetch.
 *
 * (2) exists because a config round-trip is not a deploy and an applied anchor
 * is not a behaviour (JELA-814). The end-to-end case at the bottom patches a
 * producer fixture shaped like the live `top-picks` entry, runs it, and asserts
 * the three things the ACs are actually about: zero fetches at boot, a mounted
 * placeholder, and a hydration that does not move the section.
 */
const assert = require("node:assert");
// Arming needs BOTH keys: jp815's (now fleet-seeded) and jp820's own.
const ARMED = {
  "jellyplug.rows.viewgate": "1",
  "jellyplug.rows.reservefill": "1",
};
const vm = require("node:vm");

let mod;
let mod815;
let mod816;

// --- fixtures ---------------------------------------------------------------
// Anchor text is quoted VERBATIM from the live channel entries so an upstream
// edit that moves an anchor fails here before it fails on the server.

/** tizen-compat AFTER jp815 — jp820 extends jp815's gate, so this is the base. */
function tcAfter815() {
  const base =
    "(function(s){var n={};/*jp745*/n.__compatReady=!0,s.JellyPlug=n})(window);";
  return mod815.applyPatch(base, mod815.PATCH_GATE);
}

const TP_BODY =
  'function Me(){var e=s();if(e){var r=t.safe("top-picks.uid",function(){' +
  'return typeof e.getCurrentUserId=="function"?e.getCurrentUserId():null},null);' +
  "if(r){jpUid!==r&&(jpUid=r);if($(),j||M){j&&k();return}" +
  'var a=je(e,r);!a||typeof a.then!="function"||(M=!0,a.then(function(o){' +
  "_e(e,function(u){if(r!==jpUid){k();return}M=!1,j=!0;var d=o,g=ye();" +
  "if(d.length)if(g)x(function(){X(g,i,d,e)});else{var A=N();if(A){var Ne=me(i);" +
  "X(Ne,i,d,e),x(function(){ge(A,Ne)})}else j=!1}k()})},function(o){" +
  'r===jpUid&&(M=!1,_=null),t.warn("top-picks: pool fetch failed: "+o),k()}))}}}';

const WIA_BODY =
  "function Ee(){var e=S();if(e){var r=jpUidOf();if(r){" +
  'var a=be(e,r);if(!a||typeof a.then!="function"){a===null&&t.warn("watch-it-again: ApiClient exposes no getItems method.");return}' +
  "a.then(function(i){if(r!==jpUid){v();return}K=!0;v()},function(i){" +
  'r===jpUid&&(U=null),t.warn("watch-it-again: finished-titles fetch failed: "+i),v()})}}}';

const ML_BODY =
  "function Ce(){var e=S();if(e){var r=jpUidOf();if(r){" +
  'var n=Ie(e,r);!n||typeof n.then!="function"||n.then(function(l){if(r!==jpUid){p();return}B=!0;p()},function(l){' +
  'r===jpUid&&(E=null),t.warn("my-list: favorites fetch failed: "+l),p()})}}}';

/**
 * `genre-rows` as jp816 expects to find it: the live shape, with jp815 already
 * applied (the one order jp815/jp816 support). jp820 never touches this entry —
 * it is here only to prove jp820 leaves it alone and commutes with jp816.
 */
function grAfter815() {
  const base =
    'function G(e){A||x<f.length||(A=F(f,L,Q(),o),n.log("sel"),V(e),jpIdle())}' +
    "var $=!1,jpBz=!1,jpId=!1,jpFs=null,jpUid=null;" +
    "function jpRst320(){$=!1,L={},w={},p={},A=null,x=0,jpBz=!1}" +
    "function Z(){var e=d.location;if(!(e&&!B(e.hash))){var t=S();" +
    'if(!(!t||typeof t.getItems!="function")){var i=n.safe("genre-rows.uid",function(){' +
    'return typeof t.getCurrentUserId=="function"?t.getCurrentUserId():null},null);' +
    "if(i){if(jpUid!==i&&(jpUid&&jpRst320(),jpUid=i),!$){$=!0;jpBusy();" +
    "for(var a=0;a<f.length;a++)(function(u){var l=I(u),c=me(t,i,u);" +
    "if(!c){L[l]=null,x++,G(t);return}c.then(function(h){if(i!==jpUid)return;" +
    "L[l]=J(h),x++,G(t)},function(h){if(i!==jpUid)return;L[l]=null,x++,G(t)})" +
    "})(f[a])}V(t),ve()}}}}";
  return mod815.applyPatch(base, mod815.PATCH_ROWS);
}

function mkCfg() {
  return {
    CustomJavaScripts: [
      {
        Name: "JellyPlug — tizen-compat (load first)",
        Script: tcAfter815(),
        Enabled: true,
      },
      {
        Name: "JellyPlug — netflix-rows",
        Script: "/*untouched*/void 0;",
        Enabled: true,
      },
      { Name: "JellyPlug — top-picks", Script: TP_BODY, Enabled: true },
      { Name: "JellyPlug — watch-it-again", Script: WIA_BODY, Enabled: true },
      { Name: "JellyPlug — my-list", Script: ML_BODY, Enabled: true },
      {
        Name: "JellyPlug — mylist-nav",
        Script: "/*untouched*/void 0;",
        Enabled: true,
      },
    ],
  };
}

// --- a stub DOM the gate and the producers can both drive -------------------
/**
 * Elements are real enough to be laid out: `mkEl` nodes carry a parent, a child
 * list and an explicit box. `layout()` stacks the home container's children
 * top-to-bottom, which is what makes the anti-shift assertion (AC2) meaningful
 * — a section's `top` is DERIVED from the heights above it rather than declared.
 *
 * Timers are manual: `tick()` runs exactly one pending poll, so "held for N
 * polls" is an exact assertion instead of a sleep.
 */
function mkDom(opts) {
  const o = opts || {};
  const state = {
    innerHeight: o.innerHeight || 540,
    pageYOffset: 0,
    scrollTop: 0,
    scrollY: 0,
    timers: [],
    store: Object.assign(Object.create(null), o.ls || {}),
    reqs: [],
  };

  function mkEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: "",
      id: "",
      style: {},
      attrs: Object.create(null),
      children: [],
      parentNode: null,
      textContent: "",
      // Height is intrinsic: a section is its title plus its tallest card, so a
      // placeholder built from the same builder is the same height by
      // construction. `h` is only set on nodes the fixtures care about.
      h: 0,
      _top: 0,
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        const i = this.children.indexOf(ref);
        c.parentNode = this;
        if (i < 0) this.children.push(c);
        else this.children.splice(i, 0, c);
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      get firstChild() {
        return this.children[0] || null;
      },
      querySelectorAll(sel) {
        const want = String(sel).replace(/^[.#]/, "");
        const out = [];
        (function walk(n) {
          for (const c of n.children) {
            const hit =
              sel[0] === "."
                ? String(c.className).split(/\s+/).includes(want)
                : c.tagName === String(sel).toUpperCase();
            if (hit) out.push(c);
            walk(c);
          }
        })(el);
        return out;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      getBoundingClientRect() {
        const h = this.boxHeight();
        return {
          top: this._top - state.scrollY,
          bottom: this._top - state.scrollY + h,
          height: h,
          width: h > 0 ? 800 : 0,
        };
      },
      boxHeight() {
        if (this.h) return this.h;
        // A section's height is its title row plus its tallest card.
        let cards = 0;
        for (const c of this.querySelectorAll(".jp-card")) {
          cards = Math.max(cards, c.h || 0);
        }
        return cards ? 40 + cards : 0;
      },
    };
    return el;
  }

  const container = mkEl("div");
  container.className = "homeSectionsContainer";

  /** Stack the home container's children; this is what AC2 reads. */
  function layout() {
    let y = 498;
    for (const c of container.children) {
      c._top = y;
      y += c.boxHeight() + 28;
    }
  }

  const scrollingElement = {
    get scrollTop() {
      return state.scrollTop;
    },
  };

  const document = {
    scrollingElement,
    documentElement: scrollingElement,
    createElement: mkEl,
    createDocumentFragment() {
      const f = mkEl("#fragment");
      f.isFragment = true;
      return f;
    },
    getElementById(id) {
      return container.querySelectorAll("DIV").find((e) => e.id === id) || null;
    },
    querySelectorAll(sel) {
      return container.querySelectorAll(sel);
    },
  };

  const win = {
    get innerHeight() {
      return state.innerHeight;
    },
    get pageYOffset() {
      return state.pageYOffset;
    },
    document,
    localStorage: {
      getItem: (k) => (k in state.store ? state.store[k] : null),
      setItem: (k, v) => {
        state.store[k] = String(v);
      },
    },
    setTimeout: (fn) => {
      state.timers.push(fn);
      return state.timers.length;
    },
    clearTimeout: () => {},
  };

  return {
    win,
    state,
    container,
    mkEl,
    layout,
    /** Scroll the document; every rect moves because rects are viewport-relative. */
    scrollBy(px, mechanism) {
      state.scrollY += px;
      if (mechanism === "element") state.scrollTop += px;
      else state.pageYOffset += px;
    },
    tick() {
      const t = state.timers.shift();
      if (!t) return false;
      t();
      return true;
    },
    ticks(n) {
      let ran = 0;
      for (let i = 0; i < n; i++) if (this.tick()) ran++;
      return ran;
    },
  };
}

/** Instantiate the jp820-EXTENDED gate standalone, bound to a stub window. */
function mkGate(d) {
  let src = mod815.VIEW_GATE_SRC;
  for (const e of mod.PATCH_GATE.edits) {
    assert.strictEqual(
      src.split(e.from).length - 1,
      1,
      `gate edit "${e.what}" must anchor inside jp815's own source`,
    );
    src = src.replace(e.from, e.to);
  }
  const ctx = vm.createContext({ __w: d.win });
  return new vm.Script("var s=__w;__out=" + src + ";__out").runInContext(ctx);
}

/** A section node shaped like one a producer builds: title + N `.jp-card`s. */
function mkSection(d, cls, rank, cardH, nCards, cardText) {
  const sec = d.mkEl("div");
  sec.className = "verticalSection " + cls;
  sec.setAttribute("data-jellyplug-rank", String(rank));
  const items = d.mkEl("div");
  items.className = "itemsContainer";
  sec.appendChild(items);
  for (let i = 0; i < nCards; i++) {
    const a = d.mkEl("a");
    a.className = "jp-card";
    a.h = cardH;
    a.setAttribute("href", "#/details?id=" + i);
    const txt = d.mkEl("div");
    txt.className = "cardText";
    txt.textContent = cardText === undefined ? "Title " + i : cardText;
    a.appendChild(txt);
    items.appendChild(a);
  }
  return sec;
}

async function main() {
  mod = await import("./jsi-jp820-patch.mjs");
  mod815 = await import("./jsi-jp815-patch.mjs");
  mod816 = await import("./jsi-jp816-patch.mjs");

  // --- 1. all four entries patch, exactly once ------------------------------
  {
    const cfg = mkCfg();
    const report = mod.patchConfig(cfg);
    assert.strictEqual(report.length, 4, "four entries patched");
    const [tc, , tp, wia, ml] = cfg.CustomJavaScripts.map((e) => e.Script);
    assert.ok(tc.includes("holdEl:holdEl"), "gate exports holdEl");
    assert.ok(tc.includes("reserve:reserve"), "gate exports reserve");
    assert.ok(tc.includes("stubs:stubs"), "gate exports stubs");
    assert.ok(
      tc.includes("return{on:on,hold:hold,stats:stats/*jp820*/,"),
      "jp815's own exports are preserved, not replaced",
    );
    for (const [name, body, key] of [
      ["top-picks", tp, "top-picks"],
      ["watch-it-again", wia, "watch-it-again"],
      ["my-list", ml, "my-list"],
    ]) {
      assert.ok(
        body.includes(`jpG820.reserve("${key}"`),
        `${name} reserves its slot`,
      );
      assert.ok(
        body.includes(`jpG820.holdEl("${key}:"+r`),
        `${name} holds keyed on the user id`,
      );
      assert.ok(
        body.includes("var jpRun820=function(){"),
        `${name} names the shipped fetch block`,
      );
    }
    // Every insertion is marker-paired, so the pre-image is recoverable.
    const pre = mkCfg();
    for (let i = 0; i < cfg.CustomJavaScripts.length; i++) {
      assert.strictEqual(
        mod.stripAdditions(cfg.CustomJavaScripts[i].Script),
        pre.CustomJavaScripts[i].Script,
        `entry "${cfg.CustomJavaScripts[i].Name}" must strip back to its pre-image`,
      );
    }
  }

  // --- 2. entries we do not name are byte-identical -------------------------
  {
    const cfg = mkCfg();
    const pre = mkCfg();
    mod.patchConfig(cfg);
    for (let i = 0; i < cfg.CustomJavaScripts.length; i++) {
      const a = cfg.CustomJavaScripts[i];
      const b = pre.CustomJavaScripts[i];
      assert.strictEqual(a.Name, b.Name, "entry order preserved");
      if (/tizen-compat|top-picks|watch-it-again|my-list/.test(b.Name))
        continue;
      assert.strictEqual(a.Script, b.Script, `entry "${b.Name}" must not move`);
    }
    // "mylist-nav" must NOT be caught by the /my-list/i selector.
    assert.strictEqual(
      cfg.CustomJavaScripts[5].Script,
      "/*untouched*/void 0;",
      "mylist-nav is a different entry and must not be patched",
    );
  }

  // --- 3. fail closed: applying twice, and applying without jp815 -----------
  {
    const cfg = mkCfg();
    mod.patchConfig(cfg);
    assert.throws(
      () => mod.patchConfig(cfg),
      /matched 0 times/,
      "a second application must fail closed, never double-wrap",
    );
  }
  {
    // tizen-compat WITHOUT jp815: jp820 has nothing to extend, and must say so.
    const cfg = mkCfg();
    cfg.CustomJavaScripts[0].Script =
      "(function(s){var n={};n.__compatReady=!0,s.JellyPlug=n})(window);";
    assert.throws(
      () => mod.patchConfig(cfg),
      /gate:holdEl.*matched 0 times.*is jp815 applied first/s,
      "the missing-jp815 case must name jp815",
    );
  }

  // --- 4. composition with jp815 and jp816 ----------------------------------
  {
    // jp816 edits only the genre-rows fan-out; jp820 never touches genre-rows,
    // so the two commute. The supported order is jp815 -> jp816 -> jp820.
    const cfg = mkCfg();
    const before = cfg.CustomJavaScripts.map((e) => e.Script);
    mod.patchConfig(cfg);
    const tc = cfg.CustomJavaScripts[0].Script;
    assert.ok(
      tc.includes("jp815") && tc.includes("jp820"),
      "tizen-compat carries both gates",
    );
    assert.ok(
      tc.indexOf("/*jp815*/n.rowViewGate=") < tc.indexOf("/*jp820*/var EQ=[]"),
      "jp820's additions live inside the jp815 gate, after its opening",
    );
    // And stripping jp820 returns exactly the jp815-only artifact.
    assert.strictEqual(
      mod.stripAdditions(tc),
      before[0],
      "jp820 rollback restores the jp815-only tizen-compat byte-for-byte",
    );
  }
  {
    // jp815 and jp816 are order-DEPENDENT (jp816's anchor is a substring of
    // jp815's). jp820 is not: it never touches genre-rows, so it COMMUTES with
    // jp816, and the two orders must produce the same bytes. Pinned here so a
    // future anchor that starts overlapping is caught before a deploy does it.
    const withGenre = () => {
      const c = mkCfg();
      c.CustomJavaScripts.push({
        Name: "JellyPlug — genre-rows",
        Script: grAfter815(),
        Enabled: true,
      });
      return c;
    };
    const a = withGenre();
    mod816.patchConfig(a);
    mod.patchConfig(a);
    const b = withGenre();
    mod.patchConfig(b);
    mod816.patchConfig(b);
    assert.deepStrictEqual(
      a.CustomJavaScripts,
      b.CustomJavaScripts,
      "jp816 and jp820 must commute — neither order may win",
    );
    const gr = a.CustomJavaScripts[6].Script;
    assert.ok(gr.includes("jp816"), "genre-rows still gets jp816");
    assert.ok(
      !gr.includes("jp820"),
      "and jp820 stays out of genre-rows entirely — jp815 already owns it",
    );
  }

  // --- 5. flag off: no reservation, no hold, shipped path verbatim (AC4) ----
  {
    const d = mkDom({ ls: {} });
    const g = mkGate(d);
    assert.strictEqual(g.on(), false, "gate disarmed with no flag");
    assert.strictEqual(
      g.reserve("top-picks", { build: () => d.mkEl("div") }),
      null,
      "a disarmed gate reserves nothing — no placeholder is ever mounted",
    );
    let calls = 0;
    const deferred = g.holdEl("k", d.mkEl("div"), () => calls++);
    assert.strictEqual(deferred, false, "holdEl reports it did not defer");
    assert.strictEqual(calls, 1, "callback ran synchronously — shipped path");
    assert.strictEqual(d.state.timers.length, 0, "no poll armed when disarmed");
  }
  {
    // THE FLEET'S CURRENT STATE, and the reason jp820 carries its own key:
    // JELA-815's flip seeds viewgate="1" on every TV. If jp820 read that flag
    // it would be live the instant it reached the channel.
    const d = mkDom({ ls: { "jellyplug.rows.viewgate": "1" } });
    const g = mkGate(d);
    assert.strictEqual(
      g.stats820().gate815,
      true,
      "precondition: jp815's half IS armed, exactly as the fleet has it",
    );
    assert.strictEqual(
      g.stats820().flag,
      false,
      "but jp820 is NOT armed — its own key is absent",
    );
    let calls = 0;
    assert.strictEqual(
      g.reserve("top-picks", { build: () => d.mkEl("div") }),
      null,
      "no placeholder is mounted on a fleet TV",
    );
    g.holdEl("k", d.mkEl("div"), () => calls++);
    assert.strictEqual(calls, 1, "and the shipped path runs verbatim");
  }
  {
    // jp815's kill switch must still kill BOTH halves: a slot reserved behind a
    // gate that is off would be a placeholder nothing ever fills.
    const d = mkDom({
      ls: {
        "jellyplug.rows.viewgate": "0",
        "jellyplug.rows.reservefill": "1",
      },
    });
    const g = mkGate(d);
    let calls = 0;
    g.holdEl("k", d.mkEl("div"), () => calls++);
    assert.strictEqual(
      calls,
      1,
      "jp815's kill switch overrides jp820's own arm key",
    );
  }
  {
    // ...and jp820's own "0" is a per-TV kill switch for the reserve half alone.
    const d = mkDom({
      ls: {
        "jellyplug.rows.viewgate": "1",
        "jellyplug.rows.reservefill": "0",
      },
    });
    let calls = 0;
    mkGate(d).holdEl("k", d.mkEl("div"), () => calls++);
    assert.strictEqual(calls, 1, '"0" must behave exactly like absent');
  }

  // --- 6. reserve() mounts, sanitises, and marks ----------------------------
  {
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    let built = 0;
    const res = g.reserve("top-picks", {
      find: () => null,
      build: () => {
        built++;
        return mkSection(d, "jp-picks-row", 22, 300, 3, " ");
      },
      mount: (nd) => {
        d.container.appendChild(nd);
        d.layout();
        return true;
      },
    });
    assert.strictEqual(typeof res, "function", "reserve returns a resolver");
    assert.strictEqual(built, 0, "reserve() itself does not build");
    const nd = res();
    assert.ok(nd, "the resolver mounts on first call");
    assert.strictEqual(built, 1);
    assert.strictEqual(nd.getAttribute("data-jp820"), "ph", "marked reserved");
    for (const a of nd.querySelectorAll("A")) {
      assert.strictEqual(a.getAttribute("href"), null, "href stripped");
      assert.strictEqual(a.getAttribute("tabindex"), "-1", "not focusable");
      assert.strictEqual(a.getAttribute("aria-hidden"), "true");
    }
    assert.strictEqual(res(), nd, "the resolver is memoised while mounted");
    assert.strictEqual(built, 1, "and does not rebuild");
  }
  {
    // A row already rendered from cache is reserved by ADOPTION, not rebuilt —
    // that is the warm-TV path, where the hold defers a revalidation.
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    const existing = mkSection(d, "jp-picks-row", 22, 300, 8);
    d.container.appendChild(existing);
    d.layout();
    let built = 0;
    const res = g.reserve("top-picks", {
      find: () => existing,
      build: () => {
        built++;
        return null;
      },
      mount: () => true,
    });
    assert.strictEqual(res(), existing, "adopts the cached row");
    assert.strictEqual(built, 0, "and never builds a second one");
  }

  // --- 7. the gate holds, and geometry ALONE does not open it ---------------
  {
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    // A home that is still building: only one section exists, so the reserved
    // slot sits at y=498 — trivially inside any lookahead. This is the jp815
    // false-open trap, relocated to a per-element gate.
    const ph = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(ph);
    d.layout();
    assert.ok(
      ph.getBoundingClientRect().top < d.state.innerHeight + 540,
      "precondition: the slot IS geometrically near while the home is short",
    );
    let calls = 0;
    const deferred = g.holdEl(
      "top-picks:u1",
      () => ph,
      () => calls++,
    );
    assert.strictEqual(deferred, true, "holdEl reports it deferred");
    d.ticks(40);
    assert.strictEqual(
      calls,
      0,
      "geometry alone must NOT release — an unscrolled home never fetches",
    );
    assert.strictEqual(g.stats820().scrolled, 0);
    assert.strictEqual(g.stats820().held, 1);
    assert.strictEqual(g.stats820().reserved, 0, "holdEl did not reserve");
  }

  // --- 8. scroll alone does not open it either ------------------------------
  {
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    // A tall home: the reserved slot is 5 screenfuls down.
    for (let i = 0; i < 6; i++) {
      d.container.appendChild(mkSection(d, "row" + i, 10 + i, 300, 3));
    }
    const ph = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(ph);
    d.layout();
    let calls = 0;
    g.holdEl(
      "top-picks:u1",
      () => ph,
      () => calls++,
    );
    d.scrollBy(60, "window");
    d.ticks(3);
    assert.strictEqual(g.stats820().scrolled, 1, "scroll was detected");
    assert.strictEqual(
      calls,
      0,
      "scroll alone must not release a slot that is still far away",
    );
    // ...and it opens as soon as the slot comes within one screenful.
    const need = ph.getBoundingClientRect().top - d.state.innerHeight * 2;
    d.scrollBy(need + 10, "window");
    d.ticks(2);
    assert.strictEqual(calls, 1, "released once the slot is one screenful out");
    assert.strictEqual(
      g.stats820().why,
      "near",
      "the GEOMETRIC term opened it — not the belt, not the kill switch",
    );
    assert.strictEqual(
      ph.getAttribute("data-jp820"),
      "near",
      "and the node itself records WHY, so a rig capture can tell them apart",
    );
    d.ticks(5);
    assert.strictEqual(calls, 1, "and exactly once");
  }

  // --- 9. per-element independence — the whole point of jp820 --------------
  {
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    for (let i = 0; i < 2; i++) {
      d.container.appendChild(mkSection(d, "row" + i, 10 + i, 300, 3));
    }
    const near = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(near);
    for (let i = 0; i < 6; i++) {
      d.container.appendChild(mkSection(d, "mid" + i, 30 + i, 300, 3));
    }
    const far = mkSection(d, "jp-mylist-row", 50, 300, 3, " ");
    d.container.appendChild(far);
    d.layout();
    let n = 0;
    let f = 0;
    g.holdEl(
      "top-picks:u1",
      () => near,
      () => n++,
    );
    g.holdEl(
      "my-list:u1",
      () => far,
      () => f++,
    );
    d.scrollBy(400, "window");
    d.ticks(3);
    assert.strictEqual(n, 1, "the near slot hydrates");
    assert.strictEqual(
      f,
      0,
      "the far slot is STILL held — jp815 could not do this",
    );
    assert.strictEqual(g.stats820().held, 1);
    d.scrollBy(2600, "window");
    d.ticks(3);
    assert.strictEqual(f, 1, "and hydrates in its turn");
  }

  // --- 10. bounded fallbacks ------------------------------------------------
  {
    // The home container never appears: give up after MOUNT_MAX and let the
    // shipped path fetch, rather than hanging a row forever.
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    let calls = 0;
    const res = g.reserve("top-picks", {
      find: () => null,
      build: () => mkSection(d, "jp-picks-row", 22, 300, 3, " "),
      mount: () => false, // no home container, ever
    });
    assert.strictEqual(res(), null, "nothing mounts");
    g.holdEl("top-picks:u1", res, () => calls++);
    d.ticks(mod.MOUNT_MAX - 1);
    assert.strictEqual(calls, 0, "still trying to mount");
    d.ticks(2);
    assert.strictEqual(calls, 1, "gives up and runs the shipped fetch");
    assert.strictEqual(g.stats820().why, "nomount");
    assert.strictEqual(g.stats820().nomount, 1);
  }
  {
    // A slot that mounts LATE is still reserved: the resolver retries per poll.
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    let ready = false;
    let calls = 0;
    const res = g.reserve("top-picks", {
      find: () => null,
      build: () => mkSection(d, "jp-picks-row", 22, 300, 3, " "),
      mount: (nd) => {
        if (!ready) return false;
        d.container.appendChild(nd);
        d.layout();
        return true;
      },
    });
    g.holdEl("top-picks:u1", res, () => calls++);
    d.ticks(3);
    assert.strictEqual(calls, 0);
    ready = true;
    d.ticks(1);
    assert.ok(res(), "the slot mounted on a later poll");
    assert.strictEqual(calls, 0, "and it is held, not fired");
    assert.strictEqual(g.stats820().reserved, 1);
  }
  {
    // Fail-open belt, inherited from jp815: a geometry probe that silently
    // breaks must cost a late fetch, never a permanently missing row.
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    const ph = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(ph);
    d.layout();
    let calls = 0;
    g.holdEl(
      "top-picks:u1",
      () => ph,
      () => calls++,
    );
    d.ticks(mod815.MAX_POLLS - 1);
    assert.strictEqual(calls, 0, "still held one poll short of the belt");
    d.ticks(1);
    assert.strictEqual(calls, 1, "belt releases a gate that never opened");
    assert.strictEqual(g.stats820().why, "belt");
  }
  {
    // Mid-flight kill switch: flipping the flag off must release, not strand.
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    const ph = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(ph);
    d.layout();
    let calls = 0;
    g.holdEl(
      "top-picks:u1",
      () => ph,
      () => calls++,
    );
    d.ticks(2);
    assert.strictEqual(calls, 0);
    d.win.localStorage.setItem(mod.FLAG_KEY, "0");
    d.ticks(1);
    assert.strictEqual(calls, 1, "a mid-flight kill switch must release");
    assert.strictEqual(g.stats820().why, "disarmed");
  }

  // --- 11. dedup by key, and a user switch gets its own key -----------------
  {
    const d = mkDom({ ls: ARMED });
    const g = mkGate(d);
    const ph = mkSection(d, "jp-picks-row", 22, 300, 3, " ");
    d.container.appendChild(ph);
    d.layout();
    let a = 0;
    let b = 0;
    assert.strictEqual(
      g.holdEl(
        "top-picks:u1",
        () => ph,
        () => a++,
      ),
      true,
    );
    assert.strictEqual(
      g.holdEl(
        "top-picks:u1",
        () => ph,
        () => a++,
      ),
      true,
      "a re-entrant apply() must be deduped, not queued twice",
    );
    assert.strictEqual(g.stats820().held, 1);
    // A profile switch changes the key, so the new pass is NOT swallowed.
    g.holdEl(
      "top-picks:u2",
      () => ph,
      () => b++,
    );
    assert.strictEqual(g.stats820().held, 2);
    d.scrollBy(200, "window");
    d.ticks(2);
    assert.strictEqual(a, 1, "the first closure fires exactly once");
    assert.strictEqual(b, 1, "and so does the post-switch one");
  }

  // --- 12. lookahead is ONE screenful, and scales with the panel ------------
  {
    const d540 = mkDom({ ls: ARMED });
    const d1080 = mkDom({ ls: ARMED, innerHeight: 1080 });
    assert.strictEqual(
      mkGate(d540).stats820().look,
      540,
      "one screenful on the rig, not jp815's two",
    );
    assert.strictEqual(
      mkGate(d1080).stats820().look,
      1080,
      "and one screenful on a 1080p panel — relative, so no floor is needed",
    );
    // The floor only guards a degenerate innerHeight.
    const dBad = mkDom({ ls: ARMED, innerHeight: 0 });
    assert.strictEqual(mkGate(dBad).stats820().look, mod.LOOKAHEAD_MIN_PX);
  }

  // --- 13. end-to-end: the patched producer reserves, holds, and hydrates ---
  // This is the case the ACs are actually about. A fixture shaped like the live
  // `top-picks` entry is PATCHED by the real patcher, then run.
  {
    const run = (flag) => {
      const d = mkDom({ ls: flag ? ARMED : {} });
      const g = mkGate(d);
      const fetches = [];
      // Two sections above the reserved slot, mirroring the live home.
      const above = [];
      for (let i = 0; i < 3; i++) {
        const s = mkSection(d, "above" + i, 10 + i, 300, 6);
        d.container.appendChild(s);
        above.push(s);
      }
      // ...and one below it, so a shift would be observable.
      const below = mkSection(d, "below", 40, 300, 6);
      d.container.appendChild(below);
      d.layout();

      const ctx = vm.createContext({
        JellyPlug: { rowViewGate: g },
        __d: d,
        __fetches: fetches,
        console,
      });
      // The producer's own helpers, standing in for the minified originals.
      const preamble =
        "var c={JellyPlug:JellyPlug},t={warn:function(){},safe:function(n,f,dflt){try{return f()}catch(e){return dflt}}};" +
        "var jpUid=null,j=!1,M=!1,_=null,i='Top Picks for You';" +
        "function s(){return {getCurrentUserId:function(){return 'u1'}}}" +
        "function w(x){return x==null?'Top Picks for You':x}" +
        "function k(){}" +
        // The shipped cache-first render. On a fresh profile there is no cache,
        // so it returns null and the reservation is what fills the gap.
        "function $(){return ye()}" +
        // The MutationObserver-suppression wrapper. The placeholder mount MUST
        // go through it or inserting the slot re-triggers the producer.
        "function x(f){f()}" +
        "function N(){return __d.container}" +
        "function ye(){var l=__d.container.querySelectorAll('.jp-picks-row');return l[0]||null}" +
        "function me(title){var sec=__d.mkEl('div');sec.className='verticalSection jp-picks-row';" +
        "sec.setAttribute('data-jellyplug-rank','22');var ic=__d.mkEl('div');ic.className='itemsContainer';" +
        "sec.appendChild(ic);var h=__d.mkEl('div');h.className='sectionTitle';h.textContent=title;sec.appendChild(h);return sec}" +
        // The real card builder skips the poster when imageTag is falsy, which
        // is why a stub costs zero requests; height is the same either way.
        "function X(sec,title,items,api){var ic=sec.querySelector('.itemsContainer');" +
        "while(ic.firstChild)ic.removeChild(ic.firstChild);" +
        "for(var q=0;q<items.length;q++){var it=items[q];" +
        "if(it.imageTag&&api)__fetches.push('img');" +
        "var a=__d.mkEl('a');a.className='jp-card';a.h=300;a.setAttribute('href','#/d?id='+it.id);" +
        "var t1=__d.mkEl('div');t1.className='cardText';t1.textContent=it.name;a.appendChild(t1);" +
        "if(it.year){var t2=__d.mkEl('div');t2.className='cardText';t2.textContent=it.year;a.appendChild(t2)}" +
        "ic.appendChild(a)}sec.jpPicksItems=items;__d.layout()}" +
        "function ge(ct,nd){var ch=ct.children,q;for(q=0;q<ch.length;q++){" +
        "var rk=parseInt(ch[q].getAttribute('data-jellyplug-rank'),10);" +
        "if(rk>22){ct.insertBefore(nd,ch[q]);__d.layout();return}}ct.appendChild(nd);__d.layout()}" +
        "function _e(api,f){f(null)}" +
        "function je(api,uid){__fetches.push('pool');return {then:function(ok){ok([" +
        "{id:'a',name:'Real A',year:'2001'},{id:'b',name:'Real B',year:'2002'}," +
        "{id:'c',name:'Real C',year:'2003'},{id:'d',name:'Real D',year:'2004'}" +
        "]);return this}}}";
      const patched = mod.applyPatch(TP_BODY, mod.PATCH_TOP_PICKS);
      new vm.Script(preamble + patched + ";Me();").runInContext(ctx);
      return {
        d,
        g,
        fetches,
        above,
        below,
        ph: () => d.container.querySelectorAll(".jp-picks-row")[0],
      };
    };

    // AC4 differential: flag OFF fetches at boot, exactly as shipped today.
    {
      const r = run(false);
      assert.deepStrictEqual(r.fetches, ["pool"], "flag OFF fetches at boot");
      assert.ok(r.ph(), "and injects the row the shipped way");
      assert.strictEqual(
        r.ph().getAttribute("data-jp820"),
        null,
        "with no placeholder marker anywhere",
      );
    }

    // AC1 + AC2: flag ON reserves the slot and fetches nothing at boot.
    {
      const r = run(true);
      assert.deepStrictEqual(
        r.fetches,
        [],
        "flag ON: ZERO requests at boot — the whole point",
      );
      const ph = r.ph();
      assert.ok(ph, "but the slot IS mounted");
      assert.strictEqual(ph.getAttribute("data-jp820"), "ph");
      assert.strictEqual(
        ph.querySelector(".sectionTitle").textContent,
        "Top Picks for You",
        "with the shipped default title, resolved without a request",
      );
      assert.strictEqual(
        ph.querySelectorAll(".jp-card").length,
        mod.STUB_CARDS,
      );
      // Rank-ordered: the placeholder sits between rank 12 and rank 40.
      const kids = r.d.container.children;
      assert.strictEqual(kids.indexOf(ph), 3, "reserved at its own rank");
      assert.strictEqual(kids[kids.length - 1], r.below, "and above the tail");

      // --- the anti-shift criterion -----------------------------------------
      const topsBefore = kids.map((c) => c._top);
      r.d.scrollBy(1200, "window");
      r.d.ticks(3);
      assert.deepStrictEqual(r.fetches, ["pool"], "hydrates on approach");
      const kidsAfter = r.d.container.children;
      assert.strictEqual(kidsAfter.length, kids.length, "no section appeared");
      const topsAfter = kidsAfter.map((c) => c._top);
      for (let q = 0; q < topsBefore.length; q++) {
        assert.ok(
          Math.abs(topsAfter[q] - topsBefore[q]) <= 8,
          `AC2: section ${q} moved ${topsAfter[q] - topsBefore[q]} px ` +
            "between placeholder and hydrated state (budget 8 px)",
        );
      }
      assert.strictEqual(
        ph.querySelectorAll(".jp-card").length,
        4,
        "and the SAME node now holds the real cards",
      );
      assert.strictEqual(
        ph.querySelector(".cardText").textContent,
        "Real A",
        "hydrated in place",
      );
      assert.strictEqual(
        ph.querySelectorAll("A")[0].getAttribute("href"),
        "#/d?id=a",
        "the hydration swap restores real, focusable cards",
      );
      assert.strictEqual(ph.getAttribute("data-jp820"), "near");
    }
  }

  console.log("jsi-jp820-patch.test.cjs: all cases passed");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
