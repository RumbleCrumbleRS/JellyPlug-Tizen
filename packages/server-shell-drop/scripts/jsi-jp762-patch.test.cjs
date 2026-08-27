#!/usr/bin/env node
/*
 * jsi-jp762-patch.test.cjs — JELA-762 guard for jsi-jp762-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * `LIVE_API_UTILS` and `LIVE_LOAD_SLIDESHOW_DATA` below are copied VERBATIM
 * from the live `mediabar-tizen5-rescue` body, so a regeneration of the
 * vendored slideshowpure copy shows up here as a failing anchor rather than
 * as a silent no-op deploy. Their collaborators (SlideUtils, SlideTimer, the
 * DOM) are reduced stand-ins — the patch does not depend on their internals,
 * only on their shapes.
 *
 * What is asserted:
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ENGINE: the added code must survive the Q60R's M63-class engine — no
 *     optional chaining, no `??`, no ES2019 bare `catch{`.
 *  3) FLAG-DARK: with the flag absent, the request sequence is byte-identical
 *     to shipped — the alias hop then the bare read, per slide, and no pool
 *     query at all.
 *  4) THE FIX: with the flag on, the pool is read ONCE (one /Items?Ids=) and
 *     every rotation after the first slide costs ZERO item requests.
 *  5) PROJECTION: the pooled query asks for every non-base field the hero
 *     slide actually renders, and the seeded object satisfies the renderer.
 *  6) FAIL-OPEN: a pool query that 500s leaves the shipped path intact.
 *  7) KILL SWITCH: the disable key restores shipped behaviour with the flag
 *     still on.
 *  8) SPONSORBLOCK: its own flag, default off, and the gated return value is
 *     the one the shipped error path already produces.
 *  9) ATTRIBUTION: the counters name which branch answered — in particular
 *     `bare`, which counts the double-read this ticket measured.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel -----------------------------------------
// ApiUtils.fetchItemDetails + ApiUtils.getSkipSegments, exactly as they ship.
const LIVE_API_UTILS =
  'async fetchItemDetails(e){if(!e)return null;try{if(STATE.slideshow.loadedItems[e])return STATE.slideshow.loadedItems[e];const t=20,s=Object.keys(STATE.slideshow.loadedItems);s.length>=t&&delete STATE.slideshow.loadedItems[s[0]];/*jp317*/let jp317S=null;try{const jp317J=window.JellyPlug;if(jp317J&&typeof jp317J.getItem=="function")jp317S=await jp317J.getItem(e)}catch(jp317E){jp317S=null}if(jp317S&&jp317S.Id)return STATE.slideshow.loadedItems[e]=jp317S,jp317S;const i=await fetch(`${STATE.jellyfinData.serverAddress}/Items/${e}`,{headers:this.getAuthHeaders()});if(!i.ok)throw new Error(`Failed to fetch item details: ${i.statusText}`);const n=await i.json();return STATE.slideshow.loadedItems[e]=n,n}catch(t){return console.error(`Error fetching details for item ${e}:`,t),null}},async getSkipSegments(e){try{const s=await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${e}&categories=["intro","sponsor","selfpromo","interaction"]`);if(s.status===200){const n=(await s.json()).find(a=>a.segment[0]<5);if(n)return console.log(`[SponsorBlock] Skipping intro for ${e}. Start at: ${n.segment[1]}`),Math.ceil(n.segment[1])}return 0}catch(t){return 0}}';

// SlideshowManager.loadSlideshowData, exactly as it ships.
const LIVE_LOAD_SLIDESHOW_DATA =
  'async loadSlideshowData(){try{STATE.slideshow.isLoading=!0;let e=await ApiUtils.fetchItemIdsFromList();e.length===0&&(e=await ApiUtils.fetchItemIdsFromServer()),e=SlideUtils.shuffleArray(e),STATE.slideshow.itemIds=e,STATE.slideshow.totalItems=e.length,this.createPaginationDots(),STATE.slideshow.slideInterval&&STATE.slideshow.slideInterval.stop(),STATE.slideshow.slideInterval=new SlideTimer(()=>{!STATE.slideshow.isPaused&&!STATE.slideshow.isVideoPlaying&&this.nextSlide()},CONFIG.shuffleInterval),STATE.slideshow.slideInterval.stop(),await this.updateCurrentSlide(0),STATE.slideshow.slideInterval&&STATE.slideshow.slideInterval.stop(),STATE.slideshow.slideInterval=new SlideTimer(()=>{!STATE.slideshow.isPaused&&VisibilityObserver.wasVisible&&this.nextSlide()},CONFIG.shuffleInterval)}catch(e){console.error("Error loading slideshow data:",e)}finally{STATE.slideshow.isLoading=!1}}';

/*
 * Every non-base item property the hero slide reads, taken from the live
 * createSlideElement / createRatingInfo / createFavoriteButton. If a future
 * skin change starts reading another one, this list is where it gets noticed
 * — the projection must cover it or the slide renders wrong.
 */
const SLIDE_NON_BASE_FIELDS = [
  "Overview",
  "Genres",
  "RemoteTrailers",
  "ChildCount",
];

// --- harness ----------------------------------------------------------------

/** A pool item shaped like a projected /Items?Ids= row. */
function poolItem(id) {
  return {
    Id: id,
    Name: "Item " + id,
    Type: "Movie",
    Overview: "overview " + id,
    Genres: ["Action"],
    RemoteTrailers: [{ Url: "https://youtu.be/watch?v=" + id }],
    ImageTags: { Logo: "l" + id },
    BackdropImageTags: ["b" + id],
    CommunityRating: 7.5,
    OfficialRating: "PG",
    PremiereDate: "2020-01-01T00:00:00.0000000Z",
    RunTimeTicks: 6e10,
    UserData: { IsFavorite: false },
  };
}

/** A full /Items/{id} body — what the shipped per-slide read returns. */
function fullItem(id) {
  const it = poolItem(id);
  it.MediaSources = [{ big: "x".repeat(4096) }];
  return it;
}

/**
 * Boot one patched media bar.
 *
 * `jellyPlugGetItem` models the jp317 hop: it ALWAYS dispatches the
 * user-scoped alias request (that is what `jpIGet` -> `jpIStart` ->
 * `ApiClient.getItem` does), and `aliasAnswers` decides whether the caller is
 * then satisfied. `aliasAnswers:false` reproduces exactly what JELA-759
 * captured — a request that fires and still leaves the bare read to happen.
 */
function boot(mod, opts) {
  const o = opts || {};
  const store = Object.assign({}, o.ls);
  const calls = [];
  const counters = {};

  // Assembled so that PATCH_HELPERS' `,ApiUtils={async fetchItemDetails(e){`
  // anchor exists verbatim — the helper block is INSERTED by the patch here,
  // exactly as it is on the channel, not pasted in by the harness.
  const src =
    "const CONFIG={maxItems:50,shuffleInterval:12e3};" +
    'const STATE={jellyfinData:{serverAddress:"http://srv",userId:"u1"},' +
    "slideshow:{loadedItems:{},itemIds:[],totalItems:0,isLoading:!1," +
    "isPaused:!1,isVideoPlaying:!1,slideInterval:null}};" +
    "const LocalizationUtils={}," +
    "ApiUtils={" +
    LIVE_API_UTILS +
    ",getAuthHeaders(){return{}}};" +
    "const SlideUtils={shuffleArray(a){return a}};" +
    "const VisibilityObserver={wasVisible:!0};" +
    "function SlideTimer(){this.stop=function(){return this}}" +
    "const SlideshowManager={" +
    "createPaginationDots(){}," +
    "async updateCurrentSlide(i){" +
    "await ApiUtils.fetchItemDetails(STATE.slideshow.itemIds[i])}," +
    LIVE_LOAD_SLIDESHOW_DATA +
    "};" +
    "globalThis.__t={CONFIG,STATE,ApiUtils,SlideshowManager};";

  // The patches are applied to the assembled module, so the anchors are
  // exercised against the verbatim live text every run.
  let patched = src;
  for (const p of mod.PATCHES) patched = mod.applyPatch(patched, p);
  mod.assertEngineSafeAdditions(patched);

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    encodeURIComponent,
    Math,
    Object,
    String,
    Error,
    Promise,
    JSON,
    async fetch(url) {
      calls.push(url);
      if (
        url.indexOf("sponsor.ajay.app") === 0 ||
        url.indexOf("sponsor.ajay.app") > 0
      ) {
        return {
          status: 200,
          async json() {
            return [{ segment: [0, 12] }];
          },
        };
      }
      if (url.indexOf("/Items?Ids=") > 0) {
        if (o.poolFails) return { ok: false, status: 500, statusText: "boom" };
        const ids = decodeURIComponent(
          url.split("/Items?Ids=")[1].split("&")[0],
        ).split(",");
        return {
          ok: true,
          async json() {
            return { Items: ids.map(poolItem) };
          },
        };
      }
      const id = url.split("/Items/")[1];
      return {
        ok: true,
        async json() {
          return fullItem(id);
        },
      };
    },
  };
  sandbox.window = {
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
    },
    JellyPlug: {
      async getItem(id) {
        // The alias request fires whether or not the caller ends up satisfied.
        calls.push("http://srv/Users/u1/Items/" + id);
        return o.aliasAnswers ? fullItem(id) : null;
      },
    },
  };
  Object.defineProperty(sandbox.window, mod.COUNTER_KEY, {
    get() {
      return counters.bag;
    },
    set(v) {
      counters.bag = v;
    },
    configurable: true,
  });
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  new vm.Script(patched, {
    filename: "mediabar-tizen5-rescue.patched.js",
  }).runInContext(sandbox);

  return {
    t: sandbox.__t,
    calls,
    counters: () => counters.bag || {},
    itemCalls: () => calls.filter((c) => c.indexOf("/Items") > 0),
  };
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp762-patch.mjs"));
  const IDS = ["a1", "a2", "a3", "a4"];

  // 1) FAIL-CLOSED -----------------------------------------------------------
  for (const p of mod.PATCHES) {
    for (const e of p.edits) {
      assert.throws(
        () => mod.applyPatch("nothing here", { entry: p.entry, edits: [e] }),
        /matched 0 times/,
        `anchor "${e.what}" must fail closed when it is gone`,
      );
      assert.throws(
        () =>
          mod.applyPatch(e.from + "//x" + e.from, {
            entry: p.entry,
            edits: [e],
          }),
        /matched 2 times/,
        `anchor "${e.what}" must fail closed when it is ambiguous`,
      );
    }
  }

  // 2) ENGINE ----------------------------------------------------------------
  assert.throws(
    () => mod.assertEngineSafeAdditions("/*jp762*/var x=a?.b;/*jp762*/"),
    /post-ES2018/,
  );
  assert.throws(
    () => mod.assertEngineSafeAdditions("/*jp762*/try{}catch{}/*jp762*/"),
    /post-ES2018/,
  );
  assert.throws(
    () => mod.assertEngineSafeAdditions("no markers"),
    /did not apply/,
  );

  // 3) FLAG-DARK: byte-identical to shipped ----------------------------------
  {
    const b = boot(mod, { aliasAnswers: false });
    b.t.STATE.slideshow.itemIds = IDS.slice();
    for (const id of IDS) await b.t.ApiUtils.fetchItemDetails(id);
    assert.deepStrictEqual(
      b.itemCalls(),
      [
        "http://srv/Users/u1/Items/a1",
        "http://srv/Items/a1",
        "http://srv/Users/u1/Items/a2",
        "http://srv/Items/a2",
        "http://srv/Users/u1/Items/a3",
        "http://srv/Items/a3",
        "http://srv/Users/u1/Items/a4",
        "http://srv/Items/a4",
      ],
      "flag off must reproduce the shipped double-read exactly",
    );
    assert.strictEqual(
      b.itemCalls().filter((c) => c.indexOf("Ids=") > 0).length,
      0,
      "flag off must never issue the pool query",
    );
    // 9) ATTRIBUTION: `bare` names the defect this ticket measured.
    assert.strictEqual(b.counters().bare, 4);
    assert.strictEqual(b.counters().jp317 || 0, 0);
    assert.strictEqual(b.counters().pool || 0, 0);

    // ...and when the alias hop DOES answer, the bare read never happens —
    // so a non-zero `bare` in a capture is a jp317 failure, not a design.
    const b2 = boot(mod, { aliasAnswers: true });
    await b2.t.ApiUtils.fetchItemDetails("a1");
    assert.deepStrictEqual(b2.itemCalls(), ["http://srv/Users/u1/Items/a1"]);
    assert.strictEqual(b2.counters().jp317, 1);
    assert.strictEqual(b2.counters().bare || 0, 0);
  }

  // 4) THE FIX: one pool query, then free rotations --------------------------
  {
    const b = boot(mod, {
      aliasAnswers: false,
      ls: { [mod.FLAG_KEY]: "1" },
    });
    // Full boot: loadSlideshowData renders slide 0, then primes.
    b.t.ApiUtils.fetchItemIdsFromList = async () => IDS.slice();
    b.t.ApiUtils.fetchItemIdsFromServer = async () => [];
    await b.t.SlideshowManager.loadSlideshowData();
    await b.t.ApiUtils.jp762Wait();

    const boot0 = b.itemCalls().slice();
    assert.deepStrictEqual(
      boot0.slice(0, 2),
      ["http://srv/Users/u1/Items/a1", "http://srv/Items/a1"],
      "slide 0 must stay on the shipped path — the prime is NOT on first paint",
    );
    assert.strictEqual(
      boot0.filter((c) => c.indexOf("Ids=") > 0).length,
      1,
      "the pool must be read exactly once",
    );

    // Every later rotation: zero item requests.
    const before = b.itemCalls().length;
    for (const id of IDS) await b.t.ApiUtils.fetchItemDetails(id);
    assert.strictEqual(
      b.itemCalls().length,
      before,
      "rotations over a primed pool must cost zero requests",
    );
    assert.strictEqual(b.counters().req, 1);
    assert.strictEqual(
      b.counters().items,
      IDS.length - 1,
      "slide 0 was already memoed",
    );
    assert.strictEqual(
      b.counters().bare,
      1,
      "only slide 0 paid the double read",
    );

    // The LRU cap must not evict the pool it just seeded.
    assert.ok(
      b.t.ApiUtils.jp762Cap() >= IDS.length,
      "the memo cap must cover the whole pool",
    );
    assert.strictEqual(b.t.ApiUtils.jp762Cap(), 50);
  }

  // 5) PROJECTION ------------------------------------------------------------
  {
    const b = boot(mod, { aliasAnswers: false, ls: { [mod.FLAG_KEY]: "1" } });
    b.t.STATE.slideshow.itemIds = IDS.slice();
    await b.t.ApiUtils.jp762Prime(IDS);
    await b.t.ApiUtils.jp762Wait();
    const poolUrl = b.itemCalls().find((c) => c.indexOf("Ids=") > 0);
    assert.ok(poolUrl, "a pool query must have been issued");
    for (const f of SLIDE_NON_BASE_FIELDS) {
      assert.ok(
        decodeURIComponent(poolUrl).indexOf(f) > 0,
        `the projection must request ${f} — the hero slide renders it`,
      );
    }
    assert.ok(
      poolUrl.indexOf("EnableUserData=true") > 0,
      "UserData.IsFavorite is rendered",
    );
    assert.ok(poolUrl.indexOf("EnableImageTypes=Backdrop,Logo,Primary") > 0);
    // The seeded object must satisfy every read the renderer makes.
    const seeded = b.t.STATE.slideshow.loadedItems.a1;
    for (const k of [
      "Id",
      "Name",
      "Type",
      "ImageTags",
      "BackdropImageTags",
      "UserData",
    ]) {
      assert.ok(k in seeded, `pooled item is missing ${k}`);
    }
    // The override exists so a missing field can be added on a live TV.
    const b2 = boot(mod, {
      aliasAnswers: false,
      ls: { [mod.FLAG_KEY]: "1", [mod.FIELDS_KEY]: "Overview,People" },
    });
    assert.strictEqual(b2.t.ApiUtils.jp762Fields(), "Overview,People");
  }

  // 6) FAIL-OPEN -------------------------------------------------------------
  {
    const b = boot(mod, {
      aliasAnswers: false,
      poolFails: true,
      ls: { [mod.FLAG_KEY]: "1" },
    });
    b.t.STATE.slideshow.itemIds = IDS.slice();
    b.t.ApiUtils.jp762Prime(IDS);
    await b.t.ApiUtils.jp762Wait();
    assert.strictEqual(b.counters().err, 1);
    const got = await b.t.ApiUtils.fetchItemDetails("a1");
    assert.strictEqual(
      got.Id,
      "a1",
      "a failed prime must still return the item",
    );
    assert.deepStrictEqual(
      b.itemCalls().filter((c) => c.indexOf("Ids=") < 0),
      ["http://srv/Users/u1/Items/a1", "http://srv/Items/a1"],
      "a failed prime must fall through to exactly the shipped path",
    );
  }

  // 7) KILL SWITCH -----------------------------------------------------------
  {
    const b = boot(mod, {
      aliasAnswers: false,
      ls: { [mod.FLAG_KEY]: "1", [mod.KILL_KEY]: "1" },
    });
    b.t.STATE.slideshow.itemIds = IDS.slice();
    assert.strictEqual(b.t.ApiUtils.jp762On(), false);
    assert.strictEqual(b.t.ApiUtils.jp762Prime(IDS), null);
    assert.strictEqual(
      b.t.ApiUtils.jp762Cap(),
      20,
      "the shipped LRU cap comes back",
    );
    await b.t.ApiUtils.fetchItemDetails("a1");
    assert.deepStrictEqual(b.itemCalls(), [
      "http://srv/Users/u1/Items/a1",
      "http://srv/Items/a1",
    ]);
  }

  // 8) SPONSORBLOCK ----------------------------------------------------------
  {
    const off = boot(mod, { aliasAnswers: false });
    assert.strictEqual(await off.t.ApiUtils.getSkipSegments("vid"), 12);
    assert.strictEqual(
      off.calls.filter((c) => c.indexOf("sponsor.ajay.app") > 0).length,
      1,
      "default must keep shipped behaviour",
    );

    const on = boot(mod, {
      aliasAnswers: false,
      ls: { [mod.NO_SPONSOR_KEY]: "1" },
    });
    assert.strictEqual(
      await on.t.ApiUtils.getSkipSegments("vid"),
      0,
      "the gated return must be the shipped error-path value",
    );
    assert.strictEqual(
      on.calls.filter((c) => c.indexOf("sponsor.ajay.app") > 0).length,
      0,
      "no library item id may reach the third party",
    );
    // Independent of the pool flag in both directions.
    const pooled = boot(mod, {
      aliasAnswers: false,
      ls: { [mod.FLAG_KEY]: "1" },
    });
    assert.strictEqual(await pooled.t.ApiUtils.getSkipSegments("vid"), 12);
  }

  console.log("jsi-jp762-patch.test.cjs: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
