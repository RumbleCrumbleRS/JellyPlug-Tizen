#!/usr/bin/env node
/*
 * jsi-jp815-patch.test.cjs — JELA-815 guard for jsi-jp815-patch.mjs.
 *
 * What can actually go wrong with this patch, and which case covers it:
 *
 *  1) ANCHOR DRIFT. Both edits are textual and must match exactly once, and
 *     re-running the patcher against an already-patched config must THROW
 *     rather than double-wrap the fetch burst (the config POST replaces all
 *     entries and sibling runs deploy on overlapping schedules — JELA-764).
 *  2) COLLATERAL. Only tizen-compat and genre-rows may change. Asserted by
 *     byte-comparing every other entry after the patch.
 *  3) ES5. The Q60R engine is M63-class and throws on ES2020+ (and on the
 *     ES2019 `catch{`). Scoped to the ADDED spans only — the JELA-681 lesson.
 *  4) POLARITY AND BEHAVIOUR, executed rather than grepped. The gate is run in
 *     `node:vm` against a stub window whose section rectangles we move by hand,
 *     because "the bundle contains the string" is not evidence that the gate
 *     releases when it should and holds when it should not (JELA-806).
 *  5) BOTH RELEASE TERMS ARE LOAD-BEARING. A gate that released on scroll
 *     alone, or on geometry alone, would pass a naive test. Cases 4c and 4d
 *     assert each term independently blocks release.
 *  6) FAIL-OPEN BELT. A geometry probe that breaks must cost a late fetch, not
 *     a permanently missing row.
 *  7) PRE-IMAGE RECONSTRUCTION (JELA-805). Reversing the patch must reproduce
 *     the input config byte-for-byte — the check that detects a foreign writer
 *     racing our POST.
 */
const assert = require("node:assert");
const vm = require("node:vm");

let mod;

// --- fixtures ---------------------------------------------------------------
// The anchor text is quoted VERBATIM from the live channel entries so an
// upstream edit that moves an anchor fails here before it fails on the server.
const TC_BODY =
  "(function(s){var n={};n.homeItemTypes=jp512F,/*jp745*/n.rowPrefetch=(function(){return{on:on,arm:arm}})()," +
  "/*jp745*/n.__compatReady=!0,s.JellyPlug=n})(window);";

const GR_BODY =
  "function Z(){var e=d.location;if(!(e&&!B(e.hash))){var t=S();" +
  'if(!(!t||typeof t.getItems!="function")){var i=n.safe("genre-rows.uid",function(){' +
  'return typeof t.getCurrentUserId=="function"?t.getCurrentUserId():null},null);' +
  "if(i){if(jpUid!==i&&(jpUid&&jpRst320(),jpUid=i),!$){$=!0;jpBusy();" +
  "for(var a=0;a<f.length;a++)(function(u){var l=I(u),c=me(t,i,u);" +
  "if(!c){L[l]=null,x++,G(t);return}c.then(function(h){if(i!==jpUid)return;" +
  "L[l]=J(h),x++,G(t)},function(h){if(i!==jpUid)return;L[l]=null,x++,G(t)})" +
  "})(f[a])}V(t),ve()}}}}";

/** genre-rows fixture extended with the anchors jp816 also needs. */
const GR_BODY_816 =
  'function G(e){A||x<f.length||(A=F(f,L,Q(),o),n.log("sel"),V(e),jpIdle())}' +
  "var $=!1,jpBz=!1,jpId=!1,jpFs=null,jpUid=null;" +
  "function jpRst320(){$=!1,L={},w={},p={},A=null,x=0,jpBz=!1}" +
  GR_BODY;

function mkCfg816() {
  const c = mkCfg();
  c.CustomJavaScripts[2].Script = GR_BODY_816;
  return c;
}

function mkCfg() {
  return {
    CustomJavaScripts: [
      {
        Name: "JellyPlug — tizen-compat (load first)",
        Script: TC_BODY,
        Enabled: true,
      },
      {
        Name: "JellyPlug — netflix-rows",
        Script: "/*untouched*/void 0;",
        Enabled: true,
      },
      { Name: "JellyPlug — genre-rows", Script: GR_BODY, Enabled: true },
      {
        Name: "JellyPlug — row-see-all",
        Script: "/*untouched*/void 0;",
        Enabled: true,
      },
    ],
  };
}

// --- a stub window the gate can measure -------------------------------------
/**
 * `sections` is a list of {cls, top, height}. The gate reads only
 * getBoundingClientRect(), className and innerHeight, so this is the whole
 * surface it touches. Timers are manual: `flushTimers()` runs one poll, which
 * makes "held for N polls" an exact assertion instead of a sleep.
 */
function mkWindow(opts) {
  const o = opts || {};
  const state = {
    sections: o.sections || [],
    innerHeight: o.innerHeight || 540,
    pageYOffset: 0,
    scrollTop: 0,
    timers: [],
    store: Object.assign(Object.create(null), o.ls || {}),
  };
  const scrollingElement = {
    get scrollTop() {
      return state.scrollTop;
    },
  };
  const win = {
    get innerHeight() {
      return state.innerHeight;
    },
    get pageYOffset() {
      return state.pageYOffset;
    },
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
    document: {
      scrollingElement,
      documentElement: scrollingElement,
      querySelectorAll: (sel) => {
        assert.strictEqual(sel, ".verticalSection");
        return state.sections.map((s) => ({
          className: s.cls || "verticalSection",
          getBoundingClientRect: () => ({
            top: s.top,
            bottom: s.top + s.height,
            height: s.height,
          }),
        }));
      },
    },
  };
  return {
    win,
    state,
    /** Scroll by `px`: every section moves up, mirroring a real scroll. */
    scrollBy(px, mechanism) {
      for (const s of state.sections) s.top -= px;
      if (mechanism === "window") state.pageYOffset += px;
      else if (mechanism === "element") state.scrollTop += px;
    },
    /** Run exactly one pending poll. Returns false when nothing was pending. */
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

/** Instantiate the injected gate source standalone, bound to a stub window. */
function mkGate(w) {
  const ctx = vm.createContext({ __w: w.win });
  return new vm.Script(
    "var s=__w;__out=" + mod.VIEW_GATE_SRC + ";__out",
  ).runInContext(ctx);
}

// The rig-measured home: 17 sections, the last ending at y=6,427 on a 540 px
// viewport, 0 of 258 cards on screen (JELA-813).
function rigSections() {
  const out = [];
  let top = 498;
  for (let i = 0; i < 9; i++) {
    out.push({ cls: "verticalSection", top, height: 345 });
    top += 373;
  }
  for (let i = 0; i < 8; i++) {
    out.push({ cls: "verticalSection jp-genre-row", top, height: 353 });
    top += 377;
  }
  return out;
}

async function main() {
  mod = await import("./jsi-jp815-patch.mjs");

  // --- 1. both edits apply, exactly once, and are idempotence-hostile -------
  {
    const cfg = mkCfg();
    const report = mod.patchConfig(cfg);
    assert.strictEqual(report.length, 2, "two entries patched");
    const tc = cfg.CustomJavaScripts[0].Script;
    const gr = cfg.CustomJavaScripts[2].Script;
    assert.ok(tc.includes("n.rowViewGate="), "gate installed on the namespace");
    assert.ok(
      tc.indexOf("n.rowViewGate=") < tc.indexOf("n.__compatReady=!0"),
      "gate installs BEFORE __compatReady — a consumer that reads the " +
        "namespace on ready must find it",
    );
    assert.ok(gr.includes('jpG815.hold("genre-rows",jpF815)'), "burst held");
    assert.ok(
      gr.indexOf("var jpF815=function(){") < gr.indexOf("jpBusy()"),
      "jpBusy() moved INSIDE the deferred body — a held burst that still " +
        "announced itself busy would stall the row-busy registry for 9 s",
    );
    assert.throws(
      () => mod.patchConfig(cfg),
      /matched 0 times/,
      "re-patching an already-patched config must throw, not double-wrap",
    );
  }

  // --- 2. no collateral damage ---------------------------------------------
  {
    const before = mkCfg();
    const after = mkCfg();
    mod.patchConfig(after);
    for (let i = 0; i < before.CustomJavaScripts.length; i++) {
      const b = before.CustomJavaScripts[i];
      const a = after.CustomJavaScripts[i];
      assert.strictEqual(a.Name, b.Name, "entry order preserved");
      if (/tizen-compat|genre-rows/.test(b.Name)) continue;
      assert.strictEqual(a.Script, b.Script, `entry "${b.Name}" must not move`);
    }
  }

  // --- 3. ES5, scoped to the added spans ------------------------------------
  {
    const cfg = mkCfg();
    mod.patchConfig(cfg);
    for (const e of cfg.CustomJavaScripts) mod.assertEs5Additions(e.Script);
    // and the guard itself must actually bite
    assert.throws(
      () => mod.assertEs5Additions("a/*jp815*/const x=1;/*jp815*/b"),
      /non-ES5/,
    );
    // ...without being fooled by shipped code outside the markers (JELA-681)
    mod.assertEs5Additions('/*jp815*/var q=1;/*jp815*/ a.card[class*="jp-"]');
    // The regex only sees the added spans. When acorn is on hand, parse the
    // WHOLE patched entry at ecmaVersion 5 — that is what catches the shapes
    // the regex cannot name, e.g. the ES2019 `catch {` the Q60R throws on.
    let acorn = null;
    try {
      acorn = require("acorn");
    } catch (_) {
      console.log("  (acorn unavailable — ES5 parse check skipped)");
    }
    if (acorn) {
      for (const e of cfg.CustomJavaScripts) {
        if (!/tizen-compat|genre-rows/.test(e.Name)) continue;
        acorn.parse(e.Script, { ecmaVersion: 5 });
      }
    }
  }

  // --- 4a. flag OFF: hold() is a synchronous pass-through (the AC4 arm) -----
  {
    const w = mkWindow({ sections: rigSections() });
    const g = mkGate(w);
    let calls = 0;
    const deferred = g.hold("genre-rows", () => calls++);
    assert.strictEqual(g.on(), false, "gate disarmed with no flag");
    assert.strictEqual(deferred, false, "hold() reports it did not defer");
    assert.strictEqual(calls, 1, "callback ran synchronously — shipped path");
    assert.strictEqual(w.state.timers.length, 0, "no poll armed when disarmed");
  }

  // --- 4b. flag "0" is also OFF (per-TV kill switch) ------------------------
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "0" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    assert.strictEqual(calls, 1, '"0" must run the shipped path');
  }

  // --- 4c. flag ON, never scrolled: HELD, however long we wait --------------
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    const deferred = g.hold("genre-rows", () => calls++);
    assert.strictEqual(deferred, true, "hold() reports it deferred");
    w.ticks(50);
    assert.strictEqual(calls, 0, "an unscrolled home must never fetch");
    assert.strictEqual(g.stats().scrolled, 0);
  }

  // --- 4d. flag ON, scrolled ONE screenful: still HELD ----------------------
  // The geometry term on its own. The rig home is 6,427 px tall; one screenful
  // of scroll leaves the bottom edge ~5,900 px away, far outside the lookahead.
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.tick();
    w.scrollBy(540, "element");
    w.ticks(20);
    assert.strictEqual(g.stats().scrolled, 1, "scroll was detected");
    assert.strictEqual(calls, 0, "scroll alone must not release the gate");
  }

  // --- 4e. flag ON, scrolled to the end: RELEASED, exactly once -------------
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.tick();
    // bottom edge 6,427 -> release needs it within vh + max(2*vh,1080) = 1,620
    w.scrollBy(4900, "element");
    w.ticks(5);
    assert.strictEqual(calls, 1, "released once the content bottom is near");
    assert.strictEqual(g.stats().why, "near");
    w.ticks(20);
    assert.strictEqual(calls, 1, "and exactly once");
    // and a LATER hold on an already-open gate runs straight through
    let late = 0;
    assert.strictEqual(
      g.hold("late", () => late++),
      false,
    );
    assert.strictEqual(late, 1);
  }

  // --- 4f. the scroll signal must survive a port that ignores scrollTop -----
  // JELA-813: `.page.homePage` reports scrollHeight 6450 > clientHeight 540 but
  // has overflow-y:visible, so pageYOffset and scrollingElement.scrollTop both
  // stay 0 while the page really does move. Only the rect-derived signal fires.
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.tick();
    w.scrollBy(4900, "none"); // rects move; neither scroll counter does
    w.ticks(5);
    assert.strictEqual(w.state.pageYOffset, 0);
    assert.strictEqual(w.state.scrollTop, 0);
    assert.strictEqual(calls, 1, "rect-derived scroll signal must carry it");
  }

  // --- 4g. genre rows are excluded from the measured edge ------------------
  // Otherwise the gate is self-referential: each released row extends the very
  // bottom edge the gate is watching.
  {
    const onlyGenre = [
      { cls: "verticalSection jp-genre-row", top: 100, height: 353 },
    ];
    const w = mkWindow({ sections: onlyGenre, ls: { [mod.FLAG_KEY]: "1" } });
    const g = mkGate(w);
    assert.strictEqual(g.stats().geo, null, "genre rows do not count as home");
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.ticks(20);
    assert.strictEqual(calls, 0, "no measurable home edge = stay held");
  }

  // --- 4h. zero-height sections do not pin the edge at the top -------------
  {
    const secs = rigSections();
    secs.unshift({ cls: "verticalSection", top: 0, height: 0 });
    const w = mkWindow({ sections: secs, ls: { [mod.FLAG_KEY]: "1" } });
    const g = mkGate(w);
    assert.strictEqual(g.stats().geo.n, 9, "empty sections are skipped");
  }

  // --- 4i. lookahead is sized for 1080p, not for the 540 px rig ------------
  {
    const w540 = mkGate(
      mkWindow({ sections: rigSections(), innerHeight: 540 }),
    );
    const w1080 = mkGate(
      mkWindow({ sections: rigSections(), innerHeight: 1080 }),
    );
    assert.strictEqual(w540.stats().look, mod.LOOKAHEAD_MIN_PX, "floored");
    assert.strictEqual(w1080.stats().look, 2160, "two screenfuls at 1080p");
  }

  // --- 4j. fail-open belt --------------------------------------------------
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.ticks(mod.MAX_POLLS - 1);
    assert.strictEqual(calls, 0, "still held one poll short of the belt");
    w.ticks(2);
    assert.strictEqual(calls, 1, "belt releases a gate that never opened");
    assert.strictEqual(g.stats().why, "belt");
  }

  // --- 4k. disarming mid-hold releases (rollback must not strand a row) ----
  {
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const g = mkGate(w);
    let calls = 0;
    g.hold("genre-rows", () => calls++);
    w.ticks(3);
    assert.strictEqual(calls, 0);
    w.win.localStorage.setItem(mod.FLAG_KEY, "0");
    w.ticks(2);
    assert.strictEqual(calls, 1, "a mid-flight kill switch must release");
    assert.strictEqual(g.stats().why, "disarmed");
  }

  // --- 5. the patched genre-rows body still parses, and holds for real ------
  // End-to-end: the PATCHED entry text, executed, with the PATCHED gate.
  {
    const cfg = mkCfg();
    mod.patchConfig(cfg);
    const grPatched = cfg.CustomJavaScripts[2].Script;
    const w = mkWindow({
      sections: rigSections(),
      ls: { [mod.FLAG_KEY]: "1" },
    });
    const gate = mkGate(w);
    let bursts = 0;
    const ctx = vm.createContext({
      d: { JellyPlug: { rowViewGate: gate } },
      // Minimal stand-ins for the closure variables Z() reads.
      S: () => ({ getItems: () => null, getCurrentUserId: () => "u1" }),
      B: () => true,
      n: { safe: (_k, fn, dflt) => (fn ? fn() : dflt) },
      f: [{ genre: "Action" }, { genre: "Comedy" }],
      I: (c) => c.genre,
      me: () => {
        bursts++;
        return null;
      },
      L: {},
      G: () => {},
      V: () => {},
      ve: () => {},
      jpBusy: () => {},
      jpRst320: () => {},
      J: (h) => h,
      x: 0,
      $: false,
      jpUid: null,
    });
    new vm.Script(grPatched + "\nZ();").runInContext(ctx);
    assert.strictEqual(bursts, 0, "flag ON + unscrolled = zero genre fetches");
    w.tick();
    w.scrollBy(4900, "element");
    w.ticks(5);
    assert.strictEqual(bursts, 2, "and all candidates fetch on release");
  }

  // --- 6. pre-image reconstruction (JELA-805) -------------------------------
  {
    const before = mkCfg();
    const after = mkCfg();
    mod.patchConfig(after);
    for (let i = 0; i < after.CustomJavaScripts.length; i++) {
      const rebuilt = after.CustomJavaScripts[i].Script.replace(
        /\/\*jp815\*\/[\s\S]*?\/\*jp815\*\//g,
        "",
      );
      assert.strictEqual(
        rebuilt,
        before.CustomJavaScripts[i].Script,
        `stripping jp815 from "${after.CustomJavaScripts[i].Name}" must ` +
          "reproduce the fetched body byte-for-byte",
      );
    }
  }

  // --- 7. composition with jp816, which edits the same fan-out ------------
  // jp816's `rows:fanout-open` anchor is a SUBSTRING of this patch's
  // `rows:hold` anchor. jp815-then-jp816 works because jp815 re-emits the
  // fan-out verbatim; the reverse cannot, because jp816 rewrites the tail of
  // jp815's anchor. Both directions fail CLOSED, so the hazard is a confusing
  // error rather than a corrupt entry — this pins which order is supported so
  // nobody "fixes" the reverse by loosening an anchor.
  {
    let jp816 = null;
    try {
      jp816 = await import("./jsi-jp816-patch.mjs");
    } catch (_) {
      console.log("  (jsi-jp816-patch.mjs absent — composition check skipped)");
    }
    if (jp816) {
      const fwd = mkCfg816();
      mod.patchConfig(fwd);
      jp816.patchConfig(fwd); // must not throw
      const gr = fwd.CustomJavaScripts[2].Script;
      assert.ok(gr.includes("jp815") && gr.includes("jp816"), "both applied");

      const rev = mkCfg816();
      jp816.patchConfig(rev);
      assert.throws(
        () => mod.patchConfig(rev),
        /anchor "rows:hold" matched 0 times/,
        "jp816-then-jp815 must fail CLOSED with a named anchor, not silently",
      );
    }
  }

  console.log("jsi-jp815-patch.test.cjs: all cases pass");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
