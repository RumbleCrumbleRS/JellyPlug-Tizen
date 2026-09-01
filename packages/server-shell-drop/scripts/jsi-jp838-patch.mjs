#!/usr/bin/env node
/*
 * jsi-jp838-patch.mjs — JELA-838: close the boot-1 arming hole for the eight
 * fleet-ON `jellyplug.*` skin flags whose read sites live in the JS-Injector
 * channel.
 *
 * ---------------------------------------------------------------------------
 * The defect
 * ---------------------------------------------------------------------------
 * JELA-821/823/827/834 closed this bug class for flags whose read site is in
 * the SHELL. These eight are different: reader AND seeder are both channel
 * modules in `/JavaScriptInjector/public.js`, and the seeder entries all sit
 * near the END of the channel document while the readers latch the key at
 * module load, near the start. The channel itself ships the admission, next to
 * the jp745 seeder:
 *
 *     arm() reads the key at module load, so a seeder placed after them
 *     would only take effect on the next boot.
 *
 * So on a first install, a re-install, or any localStorage eviction, all eight
 * levers are OFF for the whole of boot 1. JELA-837's fourteenth full Tizen 5.0
 * census measured the cost on the query side (which JEL-619's version-keyed LS
 * cache cannot touch), cold boot vs the same profile's boot 2:
 *
 *     /HomeScreen/Section*        12 -> 6      (the home builds every row twice)
 *     /Users/{id}/Items GETs      25 -> 18     168,381 -> 117,935 B
 *     queries over 2 s of server  9 -> 3       25.6 s -> 8.1 s aggregate
 *     peak concurrent in-flight   151 -> 34
 *
 * 0 of 10 `jellyplug.*` keys present at nav in 3/3 independent cold boots.
 *
 * ---------------------------------------------------------------------------
 * The fix, and why it is the READ SITE and not the seeder
 * ---------------------------------------------------------------------------
 * Exactly what JELA-828 did for `genreLazy` — the one flag of the ten that is
 * already live on boot 1, and the control that proves the shape works. Every
 * gate becomes opt-OUT, with the per-TV kill switch tested FIRST:
 *
 *     getItem(FLAG)==="1"                                   // boot-1-dead
 *     getItem(FLAG+"Disabled")!=="1" && getItem(FLAG)!=="0"  // armed on boot 1
 *
 * Rejected alternatives, both already disproven on this codebase:
 *   - `flagDefaults` is cached one boot behind BY CONTRACT (JELA-819 rejected
 *     it for deferJe) — it moves the bug, it does not fix it.
 *   - Moving the seeder entries earlier only re-orders a race, and it breaks
 *     the moment anything is appended above them. The read site is what arms
 *     a feature; the seeder is for kill durability (JELA-828).
 *
 * Five of the eight readers had NO kill-switch term at all — the `*Disabled`
 * key was honoured only by their seeder. Under an opt-out read that would have
 * left a killed TV armed (absent arm key now means ON), so this patch ADDS the
 * `*Disabled` term to those readers. That is what makes the kill path survive
 * the flip, and it is what JELA-838 AC3 tests.
 *
 * Three seeders (jp745, jp791 x2, jp801) guarded only on `*Disabled`, so they
 * would overwrite a per-TV `"0"` on the next boot. Per JELA-827 their guards
 * are widened to also skip a stored `"0"`.
 *
 * Out of scope on purpose: `bitrateCache`, `directHome`, `bootFailOverlayClear`
 * are fail-closed but NOT seeded (JELA-827) — flipping them would enable
 * untested code fleet-wide. `genreLazy` is already opt-out. Every `*Disabled`
 * kill switch keeps its `!== "1"` polarity, which is correct.
 *
 * ---------------------------------------------------------------------------
 * Rollback
 * ---------------------------------------------------------------------------
 * `--rollback` is the exact byte-level inverse of the flip: every read site
 * goes back to `==="1"` and every seeder guard back to its shipped form. It is
 * NOT a delete and it does NOT write "0" anywhere: unlike JELA-828 these flags
 * are ALREADY seeded fleet-wide (that is the whole point — they work from boot
 * 2), so restoring the opt-in read alone returns every TV to today's behaviour.
 * Per-TV rollback needs no deploy: set `<flag>Disabled` = "1".
 *
 * Deploy discipline is unchanged and non-negotiable: a config POST replaces
 * EVERY entry, so re-fetch the live config and re-run this patcher IMMEDIATELY
 * before the POST (jsi-config-write-race), then POST until the SERVED bundle
 * carries the marker (jsi-config-save-off-by-one — the count is not fixed at
 * two, and a server restart is also a rebuild).
 *
 * Usage:
 *   node jsi-jp838-patch.mjs --config <live-cfg.json> --out <patched-cfg.json>
 *   node jsi-jp838-patch.mjs --config <cfg.json> --out <cfg.json> --rollback
 *   node jsi-jp838-patch.mjs --audit <cfg.json>     # list boot-1-dead gates
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import vm from "node:vm";

import * as jp745 from "./jsi-jp745-patch.mjs";
import * as jp754 from "./jsi-jp754-patch.mjs";
import * as jp755 from "./jsi-jp755-patch.mjs";
import * as jp762 from "./jsi-jp762-patch.mjs";
import * as jp768 from "./jsi-jp768-patch.mjs";
import * as jp791 from "./jsi-jp791-patch.mjs";
import * as jp815 from "./jsi-jp815-patch.mjs";

/** Grep marker: one per rewritten site, in the served bundle. */
export const MARKER = "/*jp838*/";

/** The eight flags this patch arms on boot 1. */
export const FLAGS = [
  jp815.FLAG_KEY, // jellyplug.rows.viewgate          JELA-815
  jp745.FLAG_KEY, // jellyplug.rows.prefetch          JELA-745
  jp755.FLAG_KEY, // jellyplug.rows.navkeep           JELA-755
  jp754.SHARE_FLAG, // jellyplug.top10.sharepool      JELA-754/785
  jp754.FIELDS_FLAG, // jellyplug.top10.leanfields    JELA-785
  jp791.FLAG_KEY, // jellyplug.mediabar.heroPoolRead  JELA-791
  jp762.FLAG_KEY, // jellyplug.mediabar.poolPrefetch  JELA-762/791
  jp768.FLAG_KEY, // jellyplug.filterbar.pageCache    JELA-768
];

/**
 * Every rewrite, as an exact-string swap.
 *
 * `hits` is the number of occurrences expected across the WHOLE config, not
 * per entry: jp755's helper is duplicated verbatim into five row modules and
 * jp791's into two. `names` must match the Name of every entry a site lands
 * in — a foreign entry that happened to contain the same bytes is a throw, not
 * a silent extra edit.
 *
 * `origin` is the module that shipped the site. Its exported sources are
 * searched for the `from` text at load time, so if that ticket's patcher is
 * ever re-worded this module fails to import rather than patching nothing.
 */
export const SITES = [
  {
    id: "jp745-read",
    ticket: "JELA-745",
    origin: jp745,
    names: /tizen-compat/,
    hits: 1,
    from:
      `var F="${jp745.FLAG_KEY}",ST=50,MX=200,R=[],H=null,tr=0,fired=0;` +
      `function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}`,
    to:
      `var F="${jp745.FLAG_KEY}",ST=50,MX=200,R=[],H=null,tr=0,fired=0;` +
      `${MARKER}function on(){try{var l8=s.localStorage;` +
      `return!!(l8&&l8.getItem(F+"Disabled")!=="1"&&l8.getItem(F)!=="0")}catch(e){return!1}}`,
  },
  {
    id: "jp815-read",
    ticket: "JELA-815",
    origin: jp815,
    names: /tizen-compat/,
    hits: 1,
    from:
      `var F="${jp815.FLAG_KEY}",P=750,MX=800,LK=1080;` +
      `var Q=[],H=null,mxT=null,scr=0,fired=0,polls=0,opened=0,why=null;` +
      `function on(){try{return!!(s.localStorage&&s.localStorage.getItem(F)==="1")}catch(e){return!1}}`,
    to:
      `var F="${jp815.FLAG_KEY}",P=750,MX=800,LK=1080;` +
      `var Q=[],H=null,mxT=null,scr=0,fired=0,polls=0,opened=0,why=null;` +
      `${MARKER}function on(){try{var l8=s.localStorage;` +
      `return!!(l8&&l8.getItem(F+"Disabled")!=="1"&&l8.getItem(F)!=="0")}catch(e){return!1}}`,
  },
  {
    id: "jp755-read",
    ticket: "JELA-755",
    origin: jp755,
    names: /my-list|watch-it-again|top-picks|match-score|home-resume-left/,
    hits: 5,
    from:
      `function jpOn755(w){try{return!!(w.localStorage&&` +
      `w.localStorage.getItem("${jp755.FLAG_KEY}")==="1")}catch(e){return!1}}`,
    to:
      `${MARKER}function jpOn755(w){try{var l8=w.localStorage;return!!(l8&&` +
      `l8.getItem("${jp755.FLAG_KEY}Disabled")!=="1"&&` +
      `l8.getItem("${jp755.FLAG_KEY}")!=="0")}catch(e){return!1}}`,
  },
  {
    id: "jp754-read",
    ticket: "JELA-754/785",
    origin: jp754,
    names: /top10-badges/,
    hits: 1,
    // Parameterised: this single helper gates BOTH top10 flags.
    from: `function jpOn754(f){try{return!!(g.localStorage&&g.localStorage.getItem(f)==="1")}catch(e){return!1}}`,
    to:
      `${MARKER}function jpOn754(f){try{var l8=g.localStorage;` +
      `return!!(l8&&l8.getItem(f+"Disabled")!=="1"&&l8.getItem(f)!=="0")}catch(e){return!1}}`,
  },
  {
    id: "jp791-read",
    ticket: "JELA-791",
    origin: jp791,
    names: /hero-runtime|match-score/,
    hits: 2,
    from:
      `function jp791F(w){try{var l=w.localStorage;return!!(l&&` +
      `l.getItem("${jp791.FLAG_KEY}")==="1"&&l.getItem("${jp791.KILL_KEY}")!=="1")}catch(e){return!1}}`,
    to:
      `${MARKER}function jp791F(w){try{var l=w.localStorage;return!!(l&&` +
      `l.getItem("${jp791.FLAG_KEY}")!=="0"&&l.getItem("${jp791.KILL_KEY}")!=="1")}catch(e){return!1}}`,
  },
  {
    id: "jp762-read",
    ticket: "JELA-762/791",
    origin: jp762,
    names: /mediabar-tizen5-rescue/,
    hits: 1,
    from:
      `jp762On(){return this.jp762Ls("${jp762.FLAG_KEY}")==="1"&&` +
      `this.jp762Ls("${jp762.KILL_KEY}")!=="1"}`,
    to:
      `${MARKER}jp762On(){return this.jp762Ls("${jp762.FLAG_KEY}")!=="0"&&` +
      `this.jp762Ls("${jp762.KILL_KEY}")!=="1"}`,
  },
  {
    id: "jp768-read",
    ticket: "JELA-768",
    origin: jp768,
    names: /results-filter-bar/,
    hits: 1,
    from:
      `function jp768On(){return jp768Ls("${jp768.FLAG_KEY}")==="1"&&` +
      `jp768Ls("${jp768.KILL_KEY}")!=="1"}`,
    to:
      `${MARKER}function jp768On(){return jp768Ls("${jp768.FLAG_KEY}")!=="0"&&` +
      `jp768Ls("${jp768.KILL_KEY}")!=="1"}`,
  },
  /*
   * Seeder guards. These three write the arm key whenever `*Disabled` is not
   * "1", so they would re-arm a TV that a human had disarmed with a stored
   * "0". Harmless while the read site was opt-in (a "0" read as OFF either
   * way); after the flip it is a lost kill switch. JELA-828's own seeder and
   * jp786seed/jp785seed already have the right guard and are untouched.
   */
  {
    id: "jp745-seed-guard",
    ticket: "JELA-745",
    origin: null,
    names: /row prefetch default-ON/,
    hits: 1,
    from: `if(l.getItem("${jp745.FLAG_KEY}Disabled")!=="1"){l.setItem("${jp745.FLAG_KEY}","1");}`,
    to:
      `${MARKER}if(l.getItem("${jp745.FLAG_KEY}Disabled")!=="1"&&` +
      `l.getItem("${jp745.FLAG_KEY}")!=="0"){l.setItem("${jp745.FLAG_KEY}","1");}`,
  },
  {
    id: "jp791-seed-guard-pool",
    ticket: "JELA-791",
    origin: null,
    names: /poolPrefetch\+heroPoolRead default-ON/,
    hits: 1,
    from: `if(l.getItem("${jp762.KILL_KEY}")!=="1"){l.setItem("${jp762.FLAG_KEY}","1");}`,
    to:
      `${MARKER}if(l.getItem("${jp762.KILL_KEY}")!=="1"&&` +
      `l.getItem("${jp762.FLAG_KEY}")!=="0"){l.setItem("${jp762.FLAG_KEY}","1");}`,
  },
  {
    id: "jp791-seed-guard-hero",
    ticket: "JELA-791",
    origin: null,
    names: /poolPrefetch\+heroPoolRead default-ON/,
    hits: 1,
    from: `if(l.getItem("${jp791.KILL_KEY}")!=="1"){l.setItem("${jp791.FLAG_KEY}","1");}`,
    to:
      `${MARKER}if(l.getItem("${jp791.KILL_KEY}")!=="1"&&` +
      `l.getItem("${jp791.FLAG_KEY}")!=="0"){l.setItem("${jp791.FLAG_KEY}","1");}`,
  },
  {
    id: "jp768-seed-guard",
    ticket: "JELA-768/801",
    origin: null,
    names: /filterbar\.pageCache default-ON/,
    hits: 1,
    from: `var k="${jp768.FLAG_KEY}";if(localStorage.getItem(k)!=="1"){localStorage.setItem(k,"1");}`,
    to: `${MARKER}var k="${jp768.FLAG_KEY}";if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}`,
  },
];

/** Total rewrites a clean flip performs. */
export const TOTAL_HITS = SITES.reduce((n, s) => n + s.hits, 0);

/* ------------------------------------------------------------------ *
 * Load-time drift guard: every read-site anchor must still be present  *
 * in the sources its own ticket's patcher emits.                       *
 * ------------------------------------------------------------------ */
function moduleStrings(o, out = [], seen = new Set()) {
  if (o == null) return out;
  if (typeof o === "string") {
    out.push(o);
    return out;
  }
  if (typeof o !== "object" || seen.has(o)) return out;
  seen.add(o);
  for (const v of Object.values(o)) moduleStrings(v, out, seen);
  return out;
}
for (const site of SITES) {
  if (!site.origin) continue;
  const src = moduleStrings(site.origin).join(" ");
  if (!src.includes(site.from)) {
    throw new Error(
      `jp838: ${site.id} anchor is no longer emitted by its own patcher — re-derive it`,
    );
  }
}

/** Reject anything the M63-class panel engine would throw on. */
export function assertEs5(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/=>|`|\blet\b|\bconst\b|\bclass\b|\?\.|\?\?|catch\s*\{/.test(code)) {
    throw new Error("jp838: rewrite introduced non-ES5 syntax");
  }
  return true;
}
for (const site of SITES) assertEs5(site.to);

/* ------------------------------------------------------------------ *
 * Patch                                                                *
 * ------------------------------------------------------------------ */
function applySite(entries, site, { rollback = false } = {}) {
  const from = rollback ? site.to : site.from;
  const to = rollback ? site.from : site.to;
  let hits = 0;
  const touched = [];
  for (const e of entries) {
    const body = e.Script || "";
    const n = body.split(from).length - 1;
    if (!n) continue;
    if (!site.names.test(e.Name || "")) {
      throw new Error(
        `jp838: ${site.id} matched a foreign entry "${e.Name}" — refusing to edit it`,
      );
    }
    hits += n;
    e.Script = body.split(from).join(to);
    touched.push(e.Name);
  }
  if (hits !== site.hits) {
    throw new Error(
      `jp838: ${site.id} matched ${hits} site(s), want ${site.hits} — ` +
        (rollback
          ? "is the flip actually applied?"
          : "has the channel drifted, or is the flip already applied?"),
    );
  }
  // The reverse text must not survive anywhere: a half-applied site is worse
  // than an unapplied one.
  for (const e of entries) {
    if ((e.Script || "").includes(from)) {
      throw new Error(`jp838: ${site.id} left an unpatched occurrence behind`);
    }
  }
  return touched;
}

/**
 * Flip every read site to opt-OUT and widen the three loose seeder guards
 * (or, with `rollback`, restore all of them byte-for-byte).
 * Fail-closed on every ambiguity; never mutates a foreign entry.
 */
export function patchConfig(cfg, { rollback = false } = {}) {
  const entries = cfg.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("jp838: config has no CustomJavaScripts array");
  }
  const before = entries.map((e) => e.Script || "").join(" ");
  const marks = before.split(MARKER).length - 1;
  if (!rollback && marks !== 0) {
    throw new Error(
      `jp838: config already carries ${marks} ${MARKER} marker(s) — refusing to double-patch`,
    );
  }
  if (rollback && marks !== TOTAL_HITS) {
    throw new Error(
      `jp838 rollback: config carries ${marks} marker(s), want ${TOTAL_HITS}`,
    );
  }

  const applied = [];
  for (const site of SITES) {
    applied.push({
      id: site.id,
      ticket: site.ticket,
      entries: applySite(entries, site, { rollback }),
    });
  }

  // Every entry we touched must still parse on its own. A SyntaxError in ONE
  // channel entry takes down the whole bundle (JELA-815).
  const names = new Set(applied.flatMap((a) => a.entries));
  for (const e of entries) {
    if (names.has(e.Name)) {
      new vm.Script(e.Script, { filename: `${e.Name}.js` });
    }
  }

  const after = entries.map((e) => e.Script || "").join(" ");
  const finalMarks = after.split(MARKER).length - 1;
  const wantMarks = rollback ? 0 : TOTAL_HITS;
  if (finalMarks !== wantMarks) {
    throw new Error(
      `jp838: ended with ${finalMarks} marker(s), want ${wantMarks}`,
    );
  }
  return {
    action: rollback ? "rollback" : "flip",
    sites: applied,
    rewrites: TOTAL_HITS,
    entries: entries.length,
    touched: [...names],
  };
}

/**
 * Prove the edit by RECONSTRUCTING the pre-image byte-for-byte (JELA-805): a
 * marker count and a byte delta cannot detect a foreign writer racing our
 * POST. The caller compares this against the config it actually fetched.
 */
export function reconstructPreImage(patchedCfg) {
  const clone = JSON.parse(JSON.stringify(patchedCfg));
  patchConfig(clone, { rollback: true });
  return clone;
}

/* ------------------------------------------------------------------ *
 * Gate harnesses — execute the SHIPPED BYTES, never grep them          *
 * ------------------------------------------------------------------ */
/*
 * JELA-827: derive behaviour by EXECUTING the channel, not by matching a read
 * shape. Each harness wraps one site's exact text (`from` for the pre-image,
 * `to` for the flip) in the minimum scaffolding its entry gives it, and hands
 * back the gate as a callable. The two `*Ls` helpers below are verbatim from
 * the live channel — they are what makes an unreadable localStorage read as
 * `null` rather than as a throw.
 */
export const LS762_SRC = `jp762Ls(k){try{return window.localStorage?window.localStorage.getItem(k):null}catch(e){return null}}`;
export const LS768_SRC = `function jp768Ls(k){try{return f.localStorage?f.localStorage.getItem(k):null}catch(x){return null}}`;

export const HARNESS = {
  "jp745-read": (t) =>
    `(function(s){${t};return function(){return on()}})(__w)`,
  "jp815-read": (t) =>
    `(function(s){${t};return function(){return on()}})(__w)`,
  "jp755-read": (t) =>
    `(function(){${t};return function(){return jpOn755(__w)}})()`,
  "jp754-read": (t) =>
    `(function(g){${t};return function(k){return jpOn754(k)}})(__w)`,
  "jp791-read": (t) =>
    `(function(){${t};return function(){return jp791F(__w)}})()`,
  "jp762-read": (t) =>
    `(function(window){var o={${LS762_SRC},${t}};return function(){return o.jp762On()}})(__w)`,
  "jp768-read": (t) =>
    `(function(f){${LS768_SRC};${t};return function(){return jp768On()}})(__w)`,
};

/** Compile one site's gate text against a stub window. */
export function bootGate(siteId, text, win) {
  const wrap = HARNESS[siteId];
  if (!wrap) throw new Error(`jp838: no harness for ${siteId}`);
  return vm.runInNewContext(wrap(text), { __w: win });
}

/* ------------------------------------------------------------------ *
 * Audit — deliberately over-inclusive (JELA-827)                       *
 * ------------------------------------------------------------------ */
/**
 * Every `=== "1"` gate, whether the key is a literal, a `var`-bound name, or a
 * helper parameter. A regex that only knows the literal form finds 8 of the 12
 * sites this ticket fixes — the same trap JELA-827 hit, where a grep for one
 * read shape found 2 of 13 seeded keys.
 */
const GATE_RE =
  /(?:getItem|jp\d+Ls)\(\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*\)\s*===\s*["']1["']/g;

/**
 * Resolve a `var X="…"` binding inside one entry body, taking the binding
 * NEAREST to (and before) the read. `tizen-compat` binds `F` twice — once to
 * `rows.prefetch` and once to `rows.viewgate` — so a first-match lookup would
 * label the second gate with the first flag's name.
 */
function bindingOf(body, ident, before = body.length) {
  const re = new RegExp(`\\b${ident}\\s*=\\s*["']([^"']*)["']`, "g");
  let m,
    hit = null;
  while ((m = re.exec(body))) {
    if (m.index > before) break;
    hit = m[1];
  }
  return hit;
}

/**
 * Find every gate in one entry body that reads one of the eight flags in the
 * boot-1-dead `=== "1"` shape. Deliberately over-inclusive: an unresolvable
 * key (a helper parameter) is reported whenever the entry mentions one of our
 * flags at all, so "0 violations" is a superset claim. Run it against the BASE
 * config too — an audit that reports nothing on the pre-image is an audit that
 * stopped looking, not a clean bill of health.
 */
export function auditOptIn(body) {
  const out = [];
  const mentions = FLAGS.filter((f) => body.includes(f));
  if (!mentions.length) return out;
  let m;
  GATE_RE.lastIndex = 0;
  while ((m = GATE_RE.exec(body))) {
    const literal = m[1] ?? m[2];
    const ident = m[3];
    let flag = literal;
    if (!flag && ident) flag = bindingOf(body, ident, m.index);
    if (flag && !FLAGS.includes(flag)) continue; // out-of-scope flag
    out.push({
      flag: flag || `(parameterised: ${ident} — gates ${mentions.join(", ")})`,
      index: m.index,
      form: m[0],
    });
  }
  return out;
}

export function auditConfig(cfg) {
  return (cfg.CustomJavaScripts || []).flatMap((e) =>
    auditOptIn(e.Script || "").map((v) => ({ ...v, entry: e.Name })),
  );
}

function parseArgs(argv) {
  const a = { config: null, out: null, rollback: false, audit: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--config") a.config = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--rollback") a.rollback = true;
    else if (k === "--audit") a.audit = argv[++i];
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.audit) {
    const cfg = JSON.parse(readFileSync(args.audit, "utf8"));
    const v = auditConfig(cfg);
    for (const x of v) console.error(`opt-in  ${x.flag}  in "${x.entry}"`);
    console.error(`${v.length} boot-1-dead gate(s)`);
    process.exit(0);
  }
  if (!args.config || !args.out) {
    console.error(
      "need --config <cfg.json> --out <cfg.json> [--rollback] | --audit <cfg.json>",
    );
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(args.config, "utf8"));
  const r = patchConfig(cfg, { rollback: args.rollback });
  for (const s of r.sites) {
    console.error(
      `  ${s.id.padEnd(22)} ${s.ticket.padEnd(13)} ${s.entries.join(", ")}`,
    );
  }
  console.error(
    `ok  ${r.action}  rewrites=${r.rewrites}  entries=${r.entries}  touched=${r.touched.length}`,
  );
  writeFileSync(args.out, JSON.stringify(cfg));
  console.error(`wrote ${args.out}`);
}
