#!/usr/bin/env node
/*
 * jsi-jp716-patch.test.cjs — JELA-716 guard for jsi-jp716-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel, so the
 * edits are anchored text replacements and anchor drift is the whole risk:
 * an upstream/entry edit that changes an anchor must fail LOUDLY at patch
 * time, never silently ship the unpatched behaviour as if it were the fix.
 *
 * 1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *    Entry matching is name-exact for the recovery — the channel also has
 *    "mediabar-guard", "mediabar-hero-types" and the rescue itself, and a
 *    loose /media-bar/i would hit them all.
 * 2) NO ES2020+: the added code runs exactly on engines that cannot parse
 *    `?.` / `??` / bare catch (the rescue is es2017, jela762 precedent).
 * 3) DEFER GATE (rescue): flag-dark; with the flag on the library scan is
 *    HELD until a .card exists (or the bounded fail-open), and the diag
 *    object proves which release fired (perf-protocol rule 4).
 * 4) RECOVERY: the css re-link dedupes on the CURRENT document by resolved
 *    href OR stylesheet filename (the shipped exact-href compare can never
 *    match the JELA-710-rewritten link), repoints jsdelivr slideshowpure css
 *    to the self-hosted copy, latches once per window, and the asset walk
 *    skips the parse-dead CDN slideshowpure.js when the JELA-115 rescue is
 *    installed — each behind its kill switches.
 *
 * Run: node scripts/jsi-jp716-patch.test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

const CDN_CSS =
  "https://cdn.jsdelivr.net/gh/IAmParadox27/jellyfin-plugin-media-bar@ae878fd763c1d2065db4dcbc7d15a90539a0f813/slideshowpure.css";
const CDN_JS =
  "https://cdn.jsdelivr.net/gh/IAmParadox27/jellyfin-plugin-media-bar@ae878fd763c1d2065db4dcbc7d15a90539a0f813/slideshowpure.js";
const LOCAL_CSS = "https://srv.example/shell/fonts/mediabar-slideshowpure.css";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp716-patch.mjs"));
  const {
    PATCHES,
    PATCH_RESCUE,
    PATCH_RECOVERY,
    applyPatch,
    assertNoModernAdditions,
    patchConfig,
  } = mod;

  // ---- 1) fail-closed on anchor drift -------------------------------------
  for (const patch of PATCHES) {
    assert.throws(
      () => applyPatch("nothing here", patch),
      /matched 0 times/,
      "a body without the anchor must throw",
    );
    const dup = patch.edits[0].from + "\n" + patch.edits[0].from;
    assert.throws(() => applyPatch(dup, patch), /matched 2 times/);
  }

  // Entry matching: the recovery regex must single out the exact name among
  // the real channel's decoys, and the rescue regex must not hit them.
  const decoys = [
    "JellyPlug — mediabar-guard",
    "JellyPlug — mediabar-hero-types (JELA-659)",
  ];
  assert.ok(PATCH_RECOVERY.entry.test("JellyPlug — media-bar"));
  assert.ok(
    PATCH_RESCUE.entry.test("JellyPlug — mediabar-tizen5-rescue (JELA-115)"),
  );
  for (const d of decoys) {
    assert.ok(!PATCH_RECOVERY.entry.test(d), "recovery must not hit " + d);
    assert.ok(!PATCH_RESCUE.entry.test(d), "rescue must not hit " + d);
  }
  assert.ok(!PATCH_RECOVERY.entry.test("JellyPlug — media-bar extra"));

  // patchConfig refuses ambiguous channels outright.
  assert.throws(
    () =>
      patchConfig({
        CustomJavaScripts: [
          { Name: "JellyPlug — mediabar-tizen5-rescue (JELA-115)", Script: "" },
          { Name: "JellyPlug — mediabar-tizen5-rescue (copy)", Script: "" },
        ],
      }),
    /matched 2 channel entries/,
  );

  // ---- 2) additions stay parseable below ES2020 ---------------------------
  for (const patch of PATCHES) {
    let joined = "";
    for (const e of patch.edits) joined += e.to + "\n";
    assertNoModernAdditions(joined);
  }
  assert.throws(() => assertNoModernAdditions("/*jp716*/a?.b/*jp716*/"));
  assert.throws(() => assertNoModernAdditions("/*jp716*/a??b/*jp716*/"));
  assert.throws(() => assertNoModernAdditions("/*jp716*/try{}catch{}/*jp716*/"));

  // ---- 3) the defer gate, over a scaffold carrying the verbatim anchors ---
  const rescueScaffold =
    "(function(){\n" +
    "window.__JP_MEDIABAR_TIZEN5_RESCUE__ = true;\n" +
    "var STATE={slideshow:{isLoading:!1}};\n" +
    "var ApiUtils={" +
    "async fetchItemIdsFromList(){window.__calls.push('list');return[]}," +
    "async fetchItemIdsFromServer(){window.__calls.push('server');return['x']}" +
    "};\n" +
    "var SlideshowManager={" +
    "async loadSlideshowData(){try{STATE.slideshow.isLoading=!0;let e=await ApiUtils.fetchItemIdsFromList();e.length===0&&(e=await ApiUtils.fetchItemIdsFromServer());window.__done(e)}catch(x){window.__err=String(x)}}" +
    "};\n" +
    "window.__run=function(){return SlideshowManager.loadSlideshowData()};\n" +
    "})();";
  // Both verbatim anchors are present, so applyPatch exercises them for real.
  const patchedRescue = applyPatch(rescueScaffold, PATCH_RESCUE);
  new vm.Script(patchedRescue);

  function bootRescue(opts) {
    const o = opts || {};
    const win = {
      __calls: [],
      __doneWith: null,
      __err: null,
      localStorage: {
        getItem(k) {
          return (o.ls || {})[k] || null;
        },
      },
      document: {
        querySelector(sel) {
          return sel === ".card" && o.card && o.card.present ? {} : null;
        },
      },
    };
    win.__done = (e) => {
      win.__doneWith = e;
    };
    if (o.paintGate) win.__shellPaintGate = o.paintGate;
    const sb = {
      window: win,
      Promise,
      Date,
      parseInt,
      setInterval,
      clearInterval,
      setTimeout,
      String,
    };
    vm.createContext(sb);
    vm.runInContext(patchedRescue, sb);
    return win;
  }

  // R0 — flag dark: the scan runs unheld and no diag object appears.
  {
    const win = bootRescue({ card: { present: false } });
    await win.__run();
    assert.deepStrictEqual(win.__calls, ["list", "server"]);
    assert.strictEqual(win.__jpMB716, undefined);
    assert.strictEqual(win.__err, null);
  }

  // R1 — flag on, no card yet: the scan is HELD, then released by the card.
  {
    const card = { present: false };
    const win = bootRescue({
      ls: { "jellyplug.mediabar.deferscan": "1" },
      card,
    });
    const run = win.__run();
    await sleep(400);
    assert.deepStrictEqual(win.__calls, [], "scan must not fire before a card");
    assert.strictEqual(win.__jpMB716.held, 1);
    card.present = true;
    await run;
    assert.deepStrictEqual(win.__calls, ["list", "server"]);
    assert.strictEqual(win.__jpMB716.fired, "card");
    assert.ok(win.__jpMB716.waitMs >= 350, "waitMs records the hold");
  }

  // R2 — flag on, card already there: immediate release.
  {
    const win = bootRescue({
      ls: { "jellyplug.mediabar.deferscan": "1" },
      card: { present: true },
    });
    await win.__run();
    assert.deepStrictEqual(win.__calls, ["list", "server"]);
    assert.strictEqual(win.__jpMB716.fired, "immediate");
    assert.strictEqual(win.__jpMB716.held, 0);
  }

  // R3 — never a card: the bounded fail-open releases the scan.
  {
    const win = bootRescue({
      ls: {
        "jellyplug.mediabar.deferscan": "1",
        "jellyplug.mediabar.deferscanMaxMs": "500",
      },
      card: { present: false },
    });
    await win.__run();
    assert.deepStrictEqual(win.__calls, ["list", "server"]);
    assert.strictEqual(win.__jpMB716.fired, "timeout");
  }

  // R4 — the shell paint gate releases without a .card and beats the poll.
  {
    let paintCb = null;
    const win = bootRescue({
      ls: { "jellyplug.mediabar.deferscan": "1" },
      card: { present: false },
      paintGate: {
        onPaint(cb) {
          paintCb = cb;
        },
      },
    });
    const run = win.__run();
    await sleep(50);
    assert.ok(paintCb, "gate registered on __shellPaintGate.onPaint");
    paintCb();
    await run;
    assert.strictEqual(win.__jpMB716.fired, "paint");
    assert.deepStrictEqual(win.__calls, ["list", "server"]);
  }

  // ---- 4) the recovery, over a scaffold carrying the verbatim anchors -----
  const recoveryScaffold =
    '(function(a){"use strict";var s=a.document;' +
    "function c(e){return String(e)}" +
    "function p(){return s.head}" +
    'function E(e,r){for(var i=c(e),t=s.querySelectorAll(\'link[rel="stylesheet"]\'),n=0;n<t.length;n++)if(t[n].href===i)return;var l=s.createElement("link");l.rel="stylesheet",l.href=i,l.setAttribute("data-jellyplug-mediabar","css"),p().appendChild(l),r&&r.log("media-bar: linked "+i)}' +
    "function L(e,r){var i=0;function t(){if(i>=e.length){return}var n=e[i++];" +
    'if(n.type==="css"){E(n.href,r),t();return}' +
    'if(n.type==="external"){var l=c(n.src),u=s.createElement("script");u.src=l,a.__scripts.push(l),t();return}' +
    "t()}t()}" +
    "a.__E=E;a.__L=L})(window);";
  const patchedRecovery = applyPatch(recoveryScaffold, PATCH_RECOVERY);
  new vm.Script(patchedRecovery);

  function makeDoc(links) {
    const doc = {
      links: links.slice(),
      appended: [],
      querySelectorAll(sel) {
        return sel === 'link[rel="stylesheet"]' ? doc.links.slice() : [];
      },
      createElement(tag) {
        const el = {
          tag,
          attrs: {},
          setAttribute(k, v) {
            el.attrs[k] = v;
          },
        };
        return el;
      },
      head: {
        appendChild(el) {
          doc.appended.push(el);
          if (el.tag === "link") doc.links.push(el);
        },
      },
      getElementsByTagName() {
        return [doc.head];
      },
      documentElement: {},
    };
    return doc;
  }

  function bootRecovery(opts) {
    const o = opts || {};
    const win = {
      __scripts: [],
      document: o.doc,
      localStorage: {
        getItem(k) {
          return (o.ls || {})[k] || null;
        },
      },
      ApiClient: o.server
        ? {
            serverAddress() {
              return o.server;
            },
          }
        : undefined,
    };
    if (o.rescueInstalled) win.__JP_MEDIABAR_TIZEN5_RESCUE__ = true;
    if (o.staleDoc) win.__stale = o.staleDoc;
    const sb = {
      window: win,
      String,
      RegExp,
      Function: o.parseDead
        ? function (body) {
            if (String(body).indexOf("?.") !== -1) {
              throw new SyntaxError("Unexpected token .");
            }
            return function () {};
          }
        : Function,
    };
    vm.createContext(sb);
    // The IIFE captures `s = a.document` at run time; to model the stale
    // capture, boot with the stale doc installed and swap afterwards.
    if (o.staleDoc) win.document = o.staleDoc;
    vm.runInContext(patchedRecovery, sb);
    if (o.staleDoc) win.document = o.doc;
    return win;
  }

  // C1 — THE JELA-716 defect: the written link is the JELA-710-rewritten
  // /shell/fonts URL; the recovery extracts the raw jsdelivr href. The
  // shipped exact-href compare misses; the filename dedupe must hit.
  {
    const doc = makeDoc([{ href: LOCAL_CSS }]);
    const win = bootRecovery({ doc, server: "https://srv.example" });
    win.__E(CDN_CSS, null);
    assert.strictEqual(doc.appended.length, 0, "no second stylesheet link");
    assert.strictEqual(win.__JP_MEDIABAR_CSS_LINKED__, true);
  }

  // C2 — genuinely missing css: the appended link points at the self-hosted
  // copy, never at jsdelivr.
  {
    const doc = makeDoc([]);
    const win = bootRecovery({ doc, server: "https://srv.example" });
    win.__E(CDN_CSS, null);
    assert.strictEqual(doc.appended.length, 1);
    assert.strictEqual(doc.appended[0].href, LOCAL_CSS);
  }

  // C3 — selfFontsDisabled honoured: the stock jsdelivr chain comes back.
  {
    const doc = makeDoc([]);
    const win = bootRecovery({
      doc,
      server: "https://srv.example",
      ls: { "jellyfin.shell.selfFontsDisabled": "1" },
    });
    win.__E(CDN_CSS, null);
    assert.strictEqual(doc.appended.length, 1);
    assert.strictEqual(doc.appended[0].href, CDN_CSS);
  }

  // C4 — once per window, even for a genuinely new href.
  {
    const doc = makeDoc([]);
    const win = bootRecovery({ doc, server: "https://srv.example" });
    win.__E(CDN_CSS, null);
    win.__E(CDN_CSS + "?v=2", null);
    assert.strictEqual(doc.appended.length, 1);
  }

  // C5 — stale captured document: `s` points at the pre-handoff document,
  // the current a.document carries the link. The dedupe must consult the
  // CURRENT document (the shipped code consulted `s` and re-linked).
  {
    const stale = makeDoc([]);
    const doc = makeDoc([{ href: LOCAL_CSS }]);
    const win = bootRecovery({
      doc,
      staleDoc: stale,
      server: "https://srv.example",
    });
    win.__E(CDN_CSS, null);
    assert.strictEqual(doc.appended.length, 0);
    assert.strictEqual(stale.appended.length, 0);
  }

  // C6 — parse-dead engine + rescue installed: the CDN script is skipped,
  // css and other assets still deliver.
  {
    const doc = makeDoc([]);
    const win = bootRecovery({
      doc,
      server: "https://srv.example",
      parseDead: true,
      rescueInstalled: true,
    });
    win.__L(
      [
        { type: "css", href: CDN_CSS },
        { type: "external", src: CDN_JS },
        { type: "external", src: "https://srv.example/other.js" },
      ],
      null,
    );
    assert.deepStrictEqual(win.__scripts, ["https://srv.example/other.js"]);
    assert.strictEqual(doc.appended.length, 1, "css still delivered");
  }

  // C6b — capable engine: the CDN script re-delivery is untouched (it is the
  // recovery mechanism there).
  {
    const doc = makeDoc([]);
    const win = bootRecovery({ doc, server: "https://srv.example" });
    win.__L([{ type: "external", src: CDN_JS }], null);
    assert.deepStrictEqual(win.__scripts, [CDN_JS]);
  }

  // C6c — parse-dead but NO rescue installed: keep the shipped behaviour
  // (the skip must never orphan an engine the rescue does not cover).
  {
    const doc = makeDoc([]);
    const win = bootRecovery({
      doc,
      server: "https://srv.example",
      parseDead: true,
    });
    win.__L([{ type: "external", src: CDN_JS }], null);
    assert.deepStrictEqual(win.__scripts, [CDN_JS]);
  }

  // C7 — jp716Off kill switch restores the shipped recovery wholesale.
  {
    const doc = makeDoc([]);
    const win = bootRecovery({
      doc,
      server: "https://srv.example",
      parseDead: true,
      rescueInstalled: true,
      ls: { "jellyplug.mediabar.jp716Off": "1" },
    });
    win.__L(
      [
        { type: "css", href: CDN_CSS },
        { type: "external", src: CDN_JS },
      ],
      null,
    );
    assert.deepStrictEqual(win.__scripts, [CDN_JS]);
    assert.strictEqual(doc.appended[0].href, CDN_CSS);
  }

  console.log("jsi-jp716-patch: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
