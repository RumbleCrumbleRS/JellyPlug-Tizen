#!/usr/bin/env node
/*
 * jsi-jp762-patch.mjs — JELA-762: stop the media bar re-reading every rotation
 * item's full body (twice) on a 15 s timer.
 *
 * The web-skin source repo (`jellyplug-theme`) is gone from the workspace, so
 * the JS-Injector channel IS the source of truth for these snippets. This
 * applies the JELA-762 edits as anchored textual patches against the LIVE
 * entry body, fail-closed on any anchor that does not match exactly once.
 * Pair it with the jsi-channel-deploy snapshot/gate/rollback discipline
 * (JELA-107/108, reconstructed in JELA-227) to put the result on the server.
 *
 * ---------------------------------------------------------------------------
 * What this fixes, and the mechanism behind it
 * ---------------------------------------------------------------------------
 * Measured by JELA-759 (idle home, 240 s, no user input): the media-bar
 * backdrop rotates ~every 15.3 s, 16 times in the window, and EVERY rotation
 * reads the rotated item's full body TWICE — 16 x `/Items/{id}` (444,480 B)
 * plus 16 x `/Users/{u}/Items/{id}` (444,290 B) = 888,770 B, 53.7% of all
 * idle bytes. Extrapolated: ~240 item fetches and ~13 MB per idle hour.
 *
 * Both reads come out of ONE function, `ApiUtils.fetchItemDetails`, in the
 * vendored slideshowpure copy (JSI entry `mediabar-tizen5-rescue`, JELA-115):
 *
 *   if (STATE.slideshow.loadedItems[e]) return STATE.slideshow.loadedItems[e];
 *   const t = 20, s = Object.keys(STATE.slideshow.loadedItems);
 *   s.length >= t && delete STATE.slideshow.loadedItems[s[0]];
 *   // jp317: ask the shared JellyPlug item cache first...
 *   jp317S = await window.JellyPlug.getItem(e);        // -> ApiClient.getItem
 *   if (jp317S && jp317S.Id) return ...;               //    = /Users/{u}/Items/{id}
 *   // ...otherwise read it ourselves
 *   await fetch(`${server}/Items/${e}`);               //    = /Items/{id} (bare)
 *
 * `JellyPlug.getItem` is `jpIGet` in tizen-compat, and `jpIStart` dispatches
 * `ApiClient.getItem(userId, itemId)` — the user-scoped alias. So the pair the
 * capture shows is the jp317 shortcut FIRING A REQUEST and then failing to
 * satisfy the caller, after which the shipped bare fetch runs anyway. The two
 * bodies are the same object (JELA-742 verified them md5-identical when both
 * are called with a user token; the capture's per-item sizes agree to 0-28 B,
 * which is header size).
 *
 * WHY the jp317 hop comes back empty is NOT settled — `jpIGet` reads correct
 * on inspection, and the live server was unreachable for the confirmatory
 * capture. This patch therefore does not "fix jp317": it makes the question
 * moot for the rotation, and instruments the branch so the next capture
 * ATTRIBUTES the residual instead of guessing. See `jp762Bump` below.
 *
 * ---------------------------------------------------------------------------
 * The fix: read the rotation pool ONCE, projected, off the boot path
 * ---------------------------------------------------------------------------
 * The pool is a small fixed set — `fetchItemIdsFromList` (a curated
 * `/web/avatars/list.txt`) or `fetchItemIdsFromServer` (`Limit=CONFIG.maxItems`,
 * 50), resolved once per `loadSlideshowData` and then rotated over forever.
 * Re-reading a full item body per slide is pure waste.
 *
 *   PATCH_HELPERS  install `jp762*` on `ApiUtils`: the flags, the counters,
 *                  and `jp762Prime`, one bulk `/Items?Ids=...` that seeds
 *                  `STATE.slideshow.loadedItems` for the whole pool.
 *   PATCH_FETCH    raise the `loadedItems` LRU cap (20 -> pool size, or the
 *                  prime would evict itself mid-cycle), await an in-flight
 *                  prime before falling through to the network, and count
 *                  which of the three branches answered.
 *   PATCH_PRIME    kick the prime off in `loadSlideshowData` — AFTER
 *                  `await this.updateCurrentSlide(0)`.
 *   PATCH_SPONSOR  a separate flag that stops the per-rotation call to
 *                  `sponsor.ajay.app`.
 *
 * Fields. `createSlideElement` + `createRatingInfo` + `createFavoriteButton`
 * read exactly: Id, Name, Type, RemoteTrailers, BackdropImageTags, ImageTags,
 * Overview, Genres, CommunityRating, CriticRating, OfficialRating,
 * PremiereDate, RunTimeTicks, ChildCount, UserData.IsFavorite. Everything but
 * Overview/Genres/RemoteTrailers/ChildCount is a base field, so the projection
 * is those four plus `EnableUserData=true` and the three image types. That is
 * ask #3 of the ticket, and it is what keeps ONE pooled request smaller than
 * the two full bodies a single slide costs today (the largest observed body
 * was 56,074 B, dominated by MediaSources/MediaStreams/People/Chapters that
 * no backdrop renders). `jellyplug.mediabar.poolFields` overrides the list
 * from localStorage, so a field the skin turns out to need can be added on a
 * live TV without a channel redeploy.
 *
 * WHY AFTER THE FIRST SLIDE. Boot latency on this fleet tracks request COUNT
 * inside the fill window (JELA-434/713 concurrency queueing), and slide 0 is
 * already on the boot path. Priming before `updateCurrentSlide(0)` would put
 * a ~50-item body in front of first paint to save requests that only happen
 * minutes later. So the prime lands after slide 0 is up: slides 0 and 1
 * (`preloadAdjacentSlides` builds the next one) pay the shipped path, and
 * every rotation after that is free. Against the JELA-759 window that is
 * 32 requests / 888,770 B -> 1 request plus the 4 the first two slides
 * already cost.
 *
 * Nothing is unconditional: `createdSlides[e]` already stops a REBUILT slide
 * from refetching, so this only removes reads that are genuinely first-time
 * reads of a pool member.
 *
 * ---------------------------------------------------------------------------
 * Scope, and what is deliberately NOT here
 * ---------------------------------------------------------------------------
 * - The alias pair AT BOOT is JELA-742 / PR #185 (`jellyfin.shell.aliasCoalesce`,
 *   a 10 s one-shot URL-keyed store in the shell). That fix collapses each
 *   pair to one request but still pays one full body per slide; this one
 *   removes the reads entirely and projects the fields. They compose — the
 *   shell store simply stops seeing these URLs — and neither depends on the
 *   other landing.
 * - `jpIGet` itself is untouched. Other consumers (hero-runtime, match-score)
 *   want FULL bodies out of that cache; seeding it with a projection would
 *   break them. The two caches stay separate on purpose.
 * - The backdrop IMAGE bytes are not in scope (JELA-680 disabled images in
 *   the rig, so they are not in the 888 KB either).
 *
 * Dark by default. Nothing changes until `jellyplug.mediabar.poolPrefetch` is
 * `"1"` in localStorage; `jellyplug.mediabar.poolPrefetchDisabled` is the
 * kill switch reserved for the default-ON flip. The SponsorBlock gate is a
 * SEPARATE flag (`jellyplug.mediabar.noSponsorBlock`) because it changes
 * behaviour — trailers lose their intro-skip offset — rather than just
 * removing waste.
 *
 * Usage:
 *   node jsi-jp762-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp762-patch.mjs --entry <name> --in <body.js> --out <body.js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

/** localStorage flag that arms the pool prefetch. */
export const FLAG_KEY = "jellyplug.mediabar.poolPrefetch";
/** Kill switch, reserved for the default-ON flip. */
export const KILL_KEY = "jellyplug.mediabar.poolPrefetchDisabled";
/** localStorage override for the projected field list. */
export const FIELDS_KEY = "jellyplug.mediabar.poolFields";
/** Separate flag: stop the per-rotation sponsor.ajay.app call. */
export const NO_SPONSOR_KEY = "jellyplug.mediabar.noSponsorBlock";
/** Counter bag on window, read over CDP to attribute the residual. */
export const COUNTER_KEY = "__jpMB762";

/**
 * The non-base item fields the hero slide actually renders. Derived from
 * createSlideElement / createRatingInfo / createFavoriteButton, not guessed:
 *   Overview       -> .plot
 *   Genres         -> .genre (SlideUtils.parseGenres)
 *   RemoteTrailers -> the YouTube trailer id
 *   ChildCount     -> "N Seasons" in .runTime
 * Everything else it touches (Name, Type, ImageTags, BackdropImageTags,
 * CommunityRating, CriticRating, OfficialRating, PremiereDate, RunTimeTicks)
 * is returned by /Items without asking; UserData needs EnableUserData=true.
 */
export const POOL_FIELDS = "Overview,Genres,RemoteTrailers,ChildCount";

/*
 * The helpers, injected as `ApiUtils` methods. They are addressed as
 * `ApiUtils.jp762X()` rather than `this.jp762X()` at every call site, because
 * `getSkipSegments` is also reached through JELA-659's creator wrapper and
 * `this` is not guaranteed there.
 *
 * Engine floor is the vendored copy's own: Chromium 63 / es2017 (async/await,
 * template literals, arrow functions OK; optional chaining and `??` are not).
 *
 * `jp762P` is the single in-flight prime promise. It never rejects — a failed
 * prime bumps `err` and leaves `loadedItems` untouched, so `fetchItemDetails`
 * falls through to exactly the shipped path. Fail-open is the whole contract:
 * the worst case of this patch is today's rotation.
 */
export const HELPERS_SRC =
  "/*jp762*/" +
  "jp762Ls(k){try{return window.localStorage?window.localStorage.getItem(k):null}catch(e){return null}}," +
  'jp762On(){return this.jp762Ls("' +
  FLAG_KEY +
  '")==="1"&&this.jp762Ls("' +
  KILL_KEY +
  '")!=="1"},' +
  'jp762NoSponsor(){return this.jp762Ls("' +
  NO_SPONSOR_KEY +
  '")==="1"},' +
  "jp762Cap(){return this.jp762On()?Math.max(20,CONFIG.maxItems||20):20}," +
  "jp762Bump(k,n){try{const c=window." +
  COUNTER_KEY +
  "||(window." +
  COUNTER_KEY +
  "={pool:0,jp317:0,bare:0,memo:0,req:0,items:0,err:0});c[k]=(c[k]||0)+(n===void 0?1:n)}catch(e){}}," +
  'jp762Fields(){const f=this.jp762Ls("' +
  FIELDS_KEY +
  '");return f&&f.length?f:"' +
  POOL_FIELDS +
  '"},' +
  // One bulk read for the whole pool. Chunked at 50 so a future maxItems
  // raise cannot build a URL the server rejects; today the pool cap IS 50.
  "jp762Prime(ids){" +
  "if(!this.jp762On())return null;" +
  "if(this.jp762P)return this.jp762P;" +
  "const list=[];" +
  "for(let i=0;i<(ids||[]).length&&list.length<(CONFIG.maxItems||50);i++)if(ids[i])list.push(String(ids[i]));" +
  "if(!list.length)return null;" +
  "const self=this;" +
  "this.jp762P=(async function(){" +
  "for(let o=0;o<list.length;o+=50){" +
  "const chunk=list.slice(o,o+50);" +
  "try{" +
  'self.jp762Bump("req");' +
  'const url=STATE.jellyfinData.serverAddress+"/Items?Ids="+chunk.join(",")+"&Limit="+chunk.length+"&Fields="+encodeURIComponent(self.jp762Fields())+"&EnableUserData=true&EnableImages=true&EnableImageTypes=Backdrop,Logo,Primary&EnableTotalRecordCount=false";' +
  "const r=await fetch(url,{headers:self.getAuthHeaders()});" +
  'if(!r.ok)throw new Error("jp762 pool "+r.status);' +
  "const items=(await r.json()).Items||[];" +
  "let seeded=0;" +
  "for(let i=0;i<items.length;i++){const it=items[i];" +
  "if(it&&it.Id&&!STATE.slideshow.loadedItems[it.Id]){STATE.slideshow.loadedItems[it.Id]=it;seeded++}}" +
  'self.jp762Bump("items",seeded);' +
  '}catch(e){self.jp762Bump("err")}}' +
  "})();" +
  "return this.jp762P}," +
  "async jp762Wait(){const p=this.jp762P;if(p)try{await p}catch(e){}}," +
  "/*jp762*/";

// --- mediabar-tizen5-rescue: install the helpers on ApiUtils -----------------
export const PATCH_HELPERS = {
  entry: /mediabar-tizen5-rescue/i,
  edits: [
    {
      what: "helpers",
      from: ",ApiUtils={async fetchItemDetails(e){",
      to: ",ApiUtils={" + HELPERS_SRC + "async fetchItemDetails(e){",
    },
  ],
};

// --- mediabar-tizen5-rescue: fetchItemDetails ------------------------------
// `e` is the item id. The three `jp762Bump` calls are the attribution the
// JELA-759 re-run needs: `pool` = the prime answered, `jp317` = the shared
// JellyPlug cache answered, `bare` = BOTH network reads happened (i.e. the
// jp317 hop fired a request and still came back empty — the defect this
// ticket measured). `memo` = the slide was already in loadedItems.
export const PATCH_FETCH = {
  entry: /mediabar-tizen5-rescue/i,
  edits: [
    {
      what: "fetch:memo",
      from:
        "async fetchItemDetails(e){if(!e)return null;try{" +
        "if(STATE.slideshow.loadedItems[e])return STATE.slideshow.loadedItems[e];",
      to:
        "async fetchItemDetails(e){if(!e)return null;try{" +
        "if(STATE.slideshow.loadedItems[e])return/*jp762*/ApiUtils.jp762Bump('memo'),/*jp762*/" +
        "STATE.slideshow.loadedItems[e];",
    },
    {
      what: "fetch:cap",
      from:
        "const t=20,s=Object.keys(STATE.slideshow.loadedItems);" +
        "s.length>=t&&delete STATE.slideshow.loadedItems[s[0]];",
      to:
        "const t=/*jp762*/ApiUtils.jp762Cap()/*jp762*/," +
        "s=Object.keys(STATE.slideshow.loadedItems);" +
        "s.length>=t&&delete STATE.slideshow.loadedItems[s[0]];" +
        // A prime started while this slide was being built: wait for it and
        // re-check the memo before spending a request of our own.
        "/*jp762*/if(ApiUtils.jp762P){await ApiUtils.jp762Wait();" +
        'if(STATE.slideshow.loadedItems[e]){ApiUtils.jp762Bump("pool");' +
        "return STATE.slideshow.loadedItems[e]}}/*jp762*/",
    },
    {
      what: "fetch:attribute",
      from:
        "if(jp317S&&jp317S.Id)return STATE.slideshow.loadedItems[e]=jp317S,jp317S;" +
        "const i=await fetch(`${STATE.jellyfinData.serverAddress}/Items/${e}`," +
        "{headers:this.getAuthHeaders()});",
      to:
        'if(jp317S&&jp317S.Id)return/*jp762*/ApiUtils.jp762Bump("jp317"),/*jp762*/' +
        "STATE.slideshow.loadedItems[e]=jp317S,jp317S;" +
        '/*jp762*/ApiUtils.jp762Bump("bare");/*jp762*/' +
        "const i=await fetch(`${STATE.jellyfinData.serverAddress}/Items/${e}`," +
        "{headers:this.getAuthHeaders()});",
    },
  ],
};

// --- mediabar-tizen5-rescue: start the prime after the first slide ----------
// `e` is the resolved id list; `this` is SlideshowManager here, which is why
// the prime is dispatched through `ApiUtils` explicitly.
export const PATCH_PRIME = {
  entry: /mediabar-tizen5-rescue/i,
  edits: [
    {
      what: "prime",
      from:
        "await this.updateCurrentSlide(0)," +
        "STATE.slideshow.slideInterval&&STATE.slideshow.slideInterval.stop(),",
      to:
        "await this.updateCurrentSlide(0)," +
        "/*jp762*/ApiUtils.jp762Prime(e),/*jp762*/" +
        "STATE.slideshow.slideInterval&&STATE.slideshow.slideInterval.stop(),",
    },
  ],
};

// --- mediabar-tizen5-rescue: the third-party skip-segment call --------------
// Ask #4 of the ticket. 15 calls in 240 idle seconds, each one publishing a
// library item's YouTube id to a third party for content nobody is playing.
// Returning 0 is exactly what the shipped error path returns, so the only
// behavioural change is that a trailer starts at 0 s instead of skipping its
// intro. Separate flag, default off — this one is a product call, not waste.
export const PATCH_SPONSOR = {
  entry: /mediabar-tizen5-rescue/i,
  edits: [
    {
      what: "sponsorblock",
      from: "async getSkipSegments(e){try{",
      to:
        "async getSkipSegments(e){" +
        "/*jp762*/if(ApiUtils.jp762NoSponsor())return 0;/*jp762*/" +
        "try{",
    },
  ],
};

export const PATCHES = [PATCH_HELPERS, PATCH_FETCH, PATCH_PRIME, PATCH_SPONSOR];

/** Apply one patch's edits. Throws unless every anchor matches exactly once. */
export function applyPatch(body, patch) {
  let out = body;
  for (const e of patch.edits) {
    const hits = out.split(e.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `jp762 anchor "${e.what}" matched ${hits} times (want exactly 1)`,
      );
    }
    out = out.replace(e.from, e.to);
  }
  return out;
}

/**
 * The vendored slideshowpure copy is es2017 (it already ships async/await,
 * template literals and arrow functions), so unlike jp681/jp682 the floor
 * here is NOT ES5 — but the Q60R engine is M63-class and throws on ES2020+,
 * so optional chaining, nullish coalescing and the ES2019 bare `catch{` must
 * not appear. Only the regions BETWEEN a marker pair are ours: split on the
 * marker and take the odd segments, or unpatched syntax elsewhere in the
 * snippet would be attributed to this patch.
 */
export function assertEngineSafeAdditions(body) {
  const parts = body.split("/*jp762*/");
  const added = parts.filter((_, i) => i % 2 === 1).join("\n");
  if (/\?\.|\?\?|catch\s*\{/.test(added)) {
    throw new Error("jp762 edit introduced post-ES2018 syntax");
  }
  if (!added.trim()) {
    throw new Error("jp762: no marked additions found — patch did not apply");
  }
  // The whole patched body is parsed by the caller (`new vm.Script`), which is
  // the real syntax gate; the additions cannot be parsed in isolation because
  // one of them is object-literal method syntax and the rest are statements.
  return added;
}

export function patchConfig(cfg) {
  const entries = cfg.CustomJavaScripts || [];
  const report = [];
  for (const patch of PATCHES) {
    const hit = entries.filter((e) => patch.entry.test(e.Name || ""));
    if (hit.length !== 1) {
      throw new Error(
        `jp762: ${patch.entry} matched ${hit.length} channel entries (want 1)`,
      );
    }
    const before = hit[0].Script || "";
    const after = applyPatch(before, patch);
    new vm.Script(after, { filename: `${hit[0].Name}.js` });
    hit[0].Script = after;
    report.push({ name: hit[0].Name, delta: after.length - before.length });
  }
  for (const e of entries) {
    if (/mediabar-tizen5-rescue/i.test(e.Name || "")) {
      assertEngineSafeAdditions(e.Script || "");
    }
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
    let body = readFileSync(args.in, "utf8");
    const wanted = PATCHES.filter((p) => p.entry.test(args.entry));
    if (!wanted.length) {
      console.error(`no jp762 patch for entry "${args.entry}"`);
      process.exit(2);
    }
    for (const p of wanted) body = applyPatch(body, p);
    assertEngineSafeAdditions(body);
    new vm.Script(body, { filename: args.entry });
    writeFileSync(args.out, body);
    console.error(`ok  ${args.entry}`);
  } else {
    console.error("need --config <cfg.json> or --entry <name> --in <body.js>");
    process.exit(2);
  }
  console.error(`wrote ${args.out}`);
}
