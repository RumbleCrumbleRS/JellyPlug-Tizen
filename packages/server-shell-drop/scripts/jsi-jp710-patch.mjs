#!/usr/bin/env node
/*
 * jsi-jp710-patch.mjs — JELA-710: point the JS-Injector channel's two font
 * consumers at the plugin's self-hosted /shell/fonts/ drop.
 *
 * Google Fonts UA-sniffs and serves the Tizen 5.0 UA TrueType — 771 KiB of
 * font bytes per boot (JELA-706 rig) across two Google origins — for an M63
 * engine that has read WOFF2 since Chrome 36. The server plugin now embeds
 * the WOFF2 bodies and two replacement stylesheets under /shell/fonts/
 * (ShellController.GetFontAsset, JELA-710). Three consumers reference the
 * old chain; the shell covers one (the index.html media-bar <link>, see
 * rewriteFontThirdPartyCss in shell.js) and this script covers the other
 * two, which live only on the live injector channel (the jellyplug-theme
 * source repo is gone — the channel IS the source of truth, JELA-227):
 *
 *   PATCH_FONTS    (theme-css)   loadFonts' FONTS url: the Inter+Sora css2
 *                                <link> becomes /shell/fonts/inter-sora.css.
 *                                Root-relative on purpose — the written TV
 *                                document carries <base href=${server}/web/>
 *                                and the web skin runs on the server origin,
 *                                so both resolve to the plugin route.
 *   PATCH_MEDIABAR (media-bar)   the index.html probe re-links media-bar
 *                                stylesheets it finds; map any slideshowpure
 *                                URL (the jsdelivr pin whose first line
 *                                @imports Archivo Narrow from Google) to
 *                                /shell/fonts/mediabar-slideshowpure.css so
 *                                the rescue path cannot re-add the chain the
 *                                shell just rewrote away.
 *
 * Both edits honour the same kill switch as the shell rewrite:
 * localStorage["jellyfin.shell.selfFontsDisabled"]="1" boots the stock
 * Google/jsdelivr chain. Either way the consumers keep their existing
 * failure shapes (loadFonts already removes a hung/erroring <link> and the
 * theme carries full local fallback stacks, so a 404 here is cosmetic).
 *
 * DEPLOY ORDER MATTERS: apply this only after the plugin serving
 * /shell/fonts/ is live (verify `curl $srv/shell/fonts/inter-sora.css`
 * first), or Inter/Sora fall back to system faces until it is. Pair with
 * snapshot/rollback discipline exactly like jsi-jp682-patch.mjs.
 *
 * Usage:
 *   node jsi-jp710-patch.mjs --config <live-cfg.json> --out <patched.json>
 *   node jsi-jp710-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** The kill switch shared with shell.js rewriteFontThirdPartyCss. */
export const FLAG_KEY = "jellyfin.shell.selfFontsDisabled";

/** The css2 URL the theme-css entry ships today (also the fallback). */
export const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@400;500;600;700;800&display=swap";

export const LOCAL_FONTS_URL = "/shell/fonts/inter-sora.css";
export const LOCAL_MEDIABAR_URL = "/shell/fonts/mediabar-slideshowpure.css";

// --- theme-css: loadFonts fetches the local stylesheet -----------------------
export const PATCH_FONTS = {
  entry: /theme-css/i,
  edits: [
    {
      what: "fonts:url",
      from: 'var FONTS = "' + GOOGLE_FONTS_URL + '";',
      to:
        "var FONTS = /*jp710*/(function(){" +
        'try{if(localStorage.getItem("' +
        FLAG_KEY +
        '")==="1")return "' +
        GOOGLE_FONTS_URL +
        '"}catch(e){}' +
        'return "' +
        LOCAL_FONTS_URL +
        '"})()/*jp710*/;',
    },
  ],
};

// --- media-bar: the index.html probe re-links the local patched copy ---------
// In this snippet `u` is the href extracted from a probed <link> tag.
export const PATCH_MEDIABAR = {
  entry: /—\s*media-bar$/,
  edits: [
    {
      what: "mediabar:href",
      from:
        '/stylesheet/i.test(l)&&u&&/slideshowpure|media[-_]?bar/i.test(u)&&r.push({type:"css",href:u})',
      to:
        '/stylesheet/i.test(l)&&u&&/slideshowpure|media[-_]?bar/i.test(u)&&r.push({type:"css",href:/*jp710*/(function(){' +
        'try{if(localStorage.getItem("' +
        FLAG_KEY +
        '")==="1")return u}catch(e){}' +
        'return /slideshowpure/i.test(u)?"' +
        LOCAL_MEDIABAR_URL +
        '":u})()/*jp710*/})',
    },
  ],
};

export const PATCHES = [PATCH_FONTS, PATCH_MEDIABAR];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp710 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The snippets ship to a Chromium-63/V8-6.3 engine, so our additions are ES5.
 * Only the regions BETWEEN a marker pair are ours.
 */
export function assertEs5Additions(body) {
  const parts = body.split("/*jp710*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b/.test(added)) {
    throw new Error("jp710 edit introduced non-ES5 syntax");
  }
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp710: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    assertEs5Additions(after);
    new vm.Script(after, { filename: `${hit[0].Name}.js` });
    hit[0].Script = after;
    report.push({ name: hit[0].Name, delta: after.length - before.length });
  }
  return report;
}

function parseArgs(argv) {
  const a = { config: null, out: null, in: null, entry: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--config") a.config = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--in") a.in = argv[++i];
    else if (k === "--entry") a.entry = argv[++i];
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("--out <path> is required");
    process.exit(2);
  }
  if (args.config) {
    const cfg = JSON.parse(readFileSync(args.config, "utf8"));
    for (const r of patchConfig(cfg)) {
      console.error(`ok  ${r.name}  ${r.delta >= 0 ? "+" : ""}${r.delta} B`);
    }
    writeFileSync(args.out, JSON.stringify(cfg, null, 2));
  } else if (args.in && args.entry) {
    const patch = PATCHES.find((p) => p.entry.test(args.entry));
    if (!patch) {
      console.error(`no jp710 patch for entry "${args.entry}"`);
      process.exit(2);
    }
    const body = applyPatch(readFileSync(args.in, "utf8"), patch);
    assertEs5Additions(body);
    new vm.Script(body, { filename: args.entry });
    writeFileSync(args.out, body);
    console.error(`ok  ${args.entry}`);
  } else {
    console.error("need --config <json> or (--entry <name> --in <body.js>)");
    process.exit(2);
  }
}
