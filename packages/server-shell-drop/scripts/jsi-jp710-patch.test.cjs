#!/usr/bin/env node
/*
 * jsi-jp710-patch.test.cjs — JELA-710 guard for jsi-jp710-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel, so the
 * edits are anchored text replacements and anchor drift is the whole risk:
 * an upstream channel edit that changes an anchor must fail LOUDLY at patch
 * time, never silently ship the Google Fonts chain as if it were removed.
 *
 * The anchor fragments below are VERBATIM from the live channel bodies
 * (fetched 2026-08-25), so upstream drift shows up here as a failing anchor.
 *
 * 1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 * 2) ES5: the added code must survive Chromium 63 / V8 6.3.
 * 3) URL MAPPING: by default Inter/Sora resolve to /shell/fonts/ and a
 *    slideshowpure href maps to the patched local copy while every other
 *    media-bar stylesheet href passes through untouched.
 * 4) KILL SWITCH: jellyfin.shell.selfFontsDisabled="1" restores the stock
 *    Google/jsdelivr URLs; a THROWING localStorage still yields the local
 *    URLs (a locked-down webview must not lose fonts).
 * 5) ENTRY SELECTION: the media-bar matcher must not catch the mediabar-*
 *    sibling entries (guard/rescue/hero-types).
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

let mod;
before();
async function before() {
  mod = await import(path.join(__dirname, "jsi-jp710-patch.mjs"));
  run();
}

// --- verbatim from the live channel (2026-08-25) -----------------------------
const LIVE_THEME_FONTS_LINE =
  '  var FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@400;500;600;700;800&display=swap";\n' +
  "  var fontsStarted = false;\n";

const LIVE_MEDIABAR_PUSH =
  'function y(e){var r=[];if(!e)return r;for(var i=/<link\\b([^>]*)>/gi,t;(t=i.exec(e))!==null;){var n=t[1]||"",l=f(n,"rel")||"",u=f(n,"href");/stylesheet/i.test(l)&&u&&/slideshowpure|media[-_]?bar/i.test(u)&&r.push({type:"css",href:u})}return r}';

// Reduced stand-in for f(attrs, name) — the patch does not touch it.
const MEDIABAR_HELPERS =
  "function f(e,r){if(!e)return null;var i=new RegExp(\"\\\\b\"+r+\"\\\\s*=\\\\s*(\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\\\s>]+))\",\"i\"),t=i.exec(e);if(!t)return null;var n=t[2]!=null?t[2]:t[3]!=null?t[3]:t[4];return n==null?null:n}";

function makeLocalStorage(backing) {
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(backing, k)
        ? backing[k]
        : null;
    },
  };
}

function run() {
  const {
    PATCH_FONTS,
    PATCH_MEDIABAR,
    PATCHES,
    applyPatch,
    assertEs5Additions,
    patchConfig,
    FLAG_KEY,
    GOOGLE_FONTS_URL,
    LOCAL_FONTS_URL,
    LOCAL_MEDIABAR_URL,
  } = mod;

  // ---- 1. fail-closed anchors ----------------------------------------------

  const patchedFonts = applyPatch(LIVE_THEME_FONTS_LINE, PATCH_FONTS);
  assert.ok(patchedFonts.includes(LOCAL_FONTS_URL));
  assert.throws(
    () => applyPatch(LIVE_THEME_FONTS_LINE.replace("&display=swap", ""), PATCH_FONTS),
    /matched 0 times/,
    "a drifted css2 url must fail the anchor, not silently no-op",
  );
  assert.throws(
    () => applyPatch(patchedFonts + patchedFonts, PATCH_FONTS),
    /matched 0 times/,
    "an already-patched body must not re-patch",
  );

  const patchedBar = applyPatch(LIVE_MEDIABAR_PUSH, PATCH_MEDIABAR);
  assert.ok(patchedBar.includes(LOCAL_MEDIABAR_URL));
  assert.throws(
    () => applyPatch(LIVE_MEDIABAR_PUSH + LIVE_MEDIABAR_PUSH, PATCH_MEDIABAR),
    /matched 2 times/,
  );

  // ---- 2. ES5 additions ----------------------------------------------------

  assertEs5Additions(patchedFonts);
  assertEs5Additions(patchedBar);
  new vm.Script(MEDIABAR_HELPERS + patchedBar);

  // ---- 3 + 4. url mapping and the kill switch ------------------------------

  function fontsUrl(backing) {
    const ctx = { localStorage: makeLocalStorage(backing) };
    vm.createContext(ctx);
    // Run just the patched declaration; FONTS is the observable.
    vm.runInContext(patchedFonts + ";this.__out=FONTS;", ctx);
    return ctx.__out;
  }
  assert.strictEqual(fontsUrl({}), LOCAL_FONTS_URL, "default must be local");
  assert.strictEqual(
    fontsUrl({ [FLAG_KEY]: "1" }),
    GOOGLE_FONTS_URL,
    "kill switch must restore the stock css2 url",
  );
  {
    const ctx = {
      localStorage: {
        getItem() {
          throw new Error("locked down");
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext(patchedFonts + ";this.__out=FONTS;", ctx);
    assert.strictEqual(ctx.__out, LOCAL_FONTS_URL, "throwing LS keeps local");
  }

  function extract(html, backing) {
    const ctx = { localStorage: makeLocalStorage(backing) };
    vm.createContext(ctx);
    vm.runInContext(
      MEDIABAR_HELPERS + patchedBar + ";this.__out=y(" + JSON.stringify(html) + ");",
      ctx,
    );
    return ctx.__out;
  }
  const JSDELIVR =
    "https://cdn.jsdelivr.net/gh/IAmParadox27/jellyfin-plugin-media-bar@ae878fd763c1d2065db4dcbc7d15a90539a0f813/slideshowpure.css";
  const OTHER = "/web/media-bar-extras.css";
  const html =
    '<link rel="stylesheet" href="' +
    JSDELIVR +
    '" /><link rel="stylesheet" href="' +
    OTHER +
    '" /><link rel="icon" href="x.ico" />';
  assert.deepStrictEqual(
    Array.from(extract(html, {}), (a) => a.href),
    [LOCAL_MEDIABAR_URL, OTHER],
    "slideshowpure maps local; other media-bar stylesheets pass through",
  );
  assert.deepStrictEqual(
    Array.from(extract(html, { [FLAG_KEY]: "1" }), (a) => a.href),
    [JSDELIVR, OTHER],
    "kill switch must restore the jsdelivr href",
  );

  // ---- 5. entry selection --------------------------------------------------

  const cfg = {
    CustomJavaScripts: [
      { Name: "JellyPlug — theme-css (JELA-107, generated from src/css — do not edit)", Script: LIVE_THEME_FONTS_LINE },
      { Name: "JellyPlug — mediabar-tizen5-rescue (JELA-115)", Script: "var x=1;" },
      { Name: "JellyPlug — media-bar", Script: LIVE_MEDIABAR_PUSH },
      { Name: "JellyPlug — mediabar-guard", Script: "var x=1;" },
      { Name: "JellyPlug — mediabar-hero-types (JELA-659)", Script: "var x=1;" },
    ],
  };
  const report = patchConfig(cfg);
  assert.deepStrictEqual(
    report.map((r) => r.name).sort(),
    [
      "JellyPlug — media-bar",
      "JellyPlug — theme-css (JELA-107, generated from src/css — do not edit)",
    ],
    "exactly the two intended entries must be patched",
  );
  assert.ok(cfg.CustomJavaScripts[1].Script === "var x=1;", "decoys untouched");
  assert.ok(cfg.CustomJavaScripts[3].Script === "var x=1;", "decoys untouched");

  assert.strictEqual(PATCHES.length, 2);
  console.log("OK: jsi-jp710-patch (JELA-710)");
}
