#!/usr/bin/env node
/*
 * Transpile-cache (localStorage) hits / misses / LRU-eviction parity (JEL-39).
 *
 * The shell caches transpiled plugin bodies in localStorage so a warm boot can
 * skip the fetch + babel pass. Two cooperating code paths share the cache:
 *
 *   - the SEED script (injected on the server origin after document.write) that
 *     intercepts dynamically-appended <script src> — __txGet / __txSet /
 *     __txPrune / __txLru, defined as string literals inside shell.js's
 *     seed-script array. This is the path that maintains the LRU map and bumps
 *     the window.__shellTxCacheHits / __shellTxCacheMisses counters the QA HUD
 *     and this ticket read.
 *   - the STATIC pass (transpileLegacyScripts) — txGetStatic / txSetStatic.
 *
 * Both key entries as `shell.tx<TX_VER>:<urlPathWithoutQuery>` where TX_VER is
 * an FNV-1a hash derived from the babel inputs (MODERN_SYNTAX_RE source, babel
 * options literal, vendored babel.min.js fingerprint). Change any of those and
 * TX_VER changes, which auto-invalidates every cached entry.
 *
 * This test does NOT re-implement the cache. It extracts the REAL seed-script
 * functions verbatim from shell.js (and asserts the bootstrap/TV shell ships
 * byte-identical copies), then drives them against a localStorage stub to prove
 * the four behaviours JEL-39 calls for:
 *
 *   1. cold boot  -> every lookup misses, bodies get written under shell.tx*:
 *   2. warm boot  -> every lookup hits; __shellTxCacheHits == N, __shellTxCacheMisses == 0
 *                    (including JellyfinEnhanced's ?v=<Date.now()> query drift — JEL-554)
 *   3. TX_VER bust-> a babel-input change flips the prefix; warm entries become
 *                    invisible -> miss + re-transpile under the new prefix
 *   4. LRU evict  -> on quota, __txSet prunes the 10 least-recently-used entries
 *                    (ordered by the LRU timestamp map) and retries
 *
 * TV-vs-browser parity: the seed cache source is identical across the hosted
 * shell (shell.js / shell.min.js) and the TV bootstrap shell (boot-shell.src.js
 * / boot-shell.min.js), and the static + dynamic paths derive the same TX_VER
 * and normalize keys the same way — so a body written by either path on either
 * platform is found by the other.
 *
 * Zero committed deps: pure source parsing + Node vm. Run:
 *   node tooling/wgt-emulate/transpile-cache.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SHELL_JS = path.join(REPO_ROOT, 'packages', 'shell-tizen', 'src', 'shell.js');
const SHELL_MIN = path.join(REPO_ROOT, 'packages', 'shell-tizen', 'src', 'shell.min.js');
const BOOT_SRC = path.join(REPO_ROOT, 'packages', 'shell-tizen-bootstrap', 'src', 'boot-shell.src.js');
const BOOT_MIN = path.join(REPO_ROOT, 'packages', 'shell-tizen-bootstrap', 'src', 'boot-shell.min.js');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// 1. Extract the REAL seed-script cache functions from shell.js.
//
// They live as quoted string literals in the seed-script array, one function
// per array element (e.g.  '    function __txGet(src){...}',). Evaluating the
// literal recovers the exact source string that ships to the device.
// ---------------------------------------------------------------------------
const SEED_FNS = ['__txKey', '__txLru', '__txPersistLru', '__txGet', '__txPrune', '__txSet'];

function extractSeedFn(src, name) {
  // Match the array element line: <indent><quote> function NAME ( ... <quote>,
  const re = new RegExp(
    '\\n\\s*([\'"])(\\s*function ' + name + '\\b(?:\\\\.|(?!\\1).)*?)\\1\\s*,',
  );
  const m = src.match(re);
  if (!m) throw new Error('could not locate seed fn ' + name + ' in ' + src.slice(0, 0));
  // Re-eval the captured literal (with its surrounding quotes) to unescape it.
  return (0, eval)(m[1] + m[2] + m[1]); // eslint-disable-line no-eval
}

const shellSrc = fs.readFileSync(SHELL_JS, 'utf8');
const bootSrc = fs.readFileSync(BOOT_SRC, 'utf8');

const shellFns = {};
const bootFns = {};
SEED_FNS.forEach((n) => {
  shellFns[n] = extractSeedFn(shellSrc, n);
  bootFns[n] = extractSeedFn(bootSrc, n);
});

// (a) TV-vs-browser source parity: every seed cache function is byte-identical
//     between the hosted shell and the TV bootstrap shell.
const fnDivergence = SEED_FNS.filter((n) => shellFns[n] !== bootFns[n]);
check('seed cache fns byte-identical hosted(shell.js) vs TV(boot-shell.src.js)',
  fnDivergence.length === 0, fnDivergence.length ? 'diverged: ' + fnDivergence.join(', ') : '');

// (b) The deployed minified artifacts both embed the same seed functions
//     (source <-> shipped artifact), so this is what actually runs on-device.
const shellMin = fs.readFileSync(SHELL_MIN, 'utf8');
const bootMin = fs.readFileSync(BOOT_MIN, 'utf8');
const artifactMissing = [];
SEED_FNS.forEach((n) => {
  if (!shellMin.includes(shellFns[n])) artifactMissing.push('shell.min.js:' + n);
  if (!bootMin.includes(bootFns[n])) artifactMissing.push('boot-shell.min.js:' + n);
});
check('deployed artifacts (shell.min.js + boot-shell.min.js) embed the seed cache fns verbatim',
  artifactMissing.length === 0, artifactMissing.join(', '));

// ---------------------------------------------------------------------------
// 2. Derive TX_VER exactly the way the shell does (FNV-1a over babel inputs).
// ---------------------------------------------------------------------------
function litAfter(src, varName) {
  const m = src.match(new RegExp('var ' + varName + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*;'));
  return m ? (0, eval)(m[1]) : null; // eslint-disable-line no-eval
}
function extractFnv1a(src) {
  const m = src.match(/function txFnv1a\(s\)\s*\{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error('txFnv1a not found');
  return (0, eval)('(' + m[0] + ')'); // eslint-disable-line no-eval
}
const MODERN_SYNTAX_RE_SRC = litAfter(shellSrc, 'MODERN_SYNTAX_RE_SRC');
const BABEL_OPTS_KEY = litAfter(shellSrc, 'BABEL_OPTS_KEY');
const BABEL_FPR = litAfter(shellSrc, 'BABEL_FPR');
const txFnv1a = extractFnv1a(shellSrc);

function deriveTxVer(fpr) {
  return txFnv1a(MODERN_SYNTAX_RE_SRC + '|' + BABEL_OPTS_KEY + '|' + fpr);
}
const TX_VER = deriveTxVer(BABEL_FPR);
const TX_PFX = 'shell.tx' + TX_VER + ':';

check('TX_VER derives to a stable base36 hash; TX_PFX = "shell.tx<VER>:"',
  /^[0-9a-z]+$/.test(TX_VER) && TX_PFX === 'shell.tx' + TX_VER + ':',
  'TX_VER=' + TX_VER + ' TX_PFX=' + TX_PFX);

// A babel-input change (e.g. a new vendored babel.min.js fingerprint) must
// produce a different prefix — this is the cache-bust mechanism.
const TX_VER_BUST = deriveTxVer(BABEL_FPR + '-changed');
check('changing a babel input changes TX_VER (cache-bust precondition)',
  TX_VER_BUST !== TX_VER, TX_VER + ' -> ' + TX_VER_BUST);

// ---------------------------------------------------------------------------
// 3. Build a localStorage / window / Date sandbox and load the real seed fns.
// ---------------------------------------------------------------------------
function makeLocalStorage(bodyQuota) {
  // bodyQuota: max number of shell.tx<ver>: BODY entries before setItem throws
  // a quota error (the LRU-map key is exempt — it's tiny and always persists,
  // matching real WebKit behaviour where one small write rarely tips quota).
  const store = new Map();
  function bodyCount() {
    let n = 0;
    for (const k of store.keys()) if (/^shell\.tx[0-9a-z]+:/.test(k)) n++;
    return n;
  }
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    removeItem(k) { store.delete(k); },
    setItem(k, v) {
      const isBody = /^shell\.tx[0-9a-z]+:/.test(k);
      if (isBody && !store.has(k) && bodyQuota != null && bodyCount() >= bodyQuota) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store.set(String(k), String(v));
    },
    _store: store,
    _bodyKeys() { return [...store.keys()].filter((k) => /^shell\.tx[0-9a-z]+:/.test(k)); },
  };
}

// Monotonic clock so LRU timestamps are deterministic and strictly ordered by
// call sequence (oldest access == smallest value).
function makeClock() {
  let t = 1000;
  return { now() { return ++t; } };
}

function loadSeed(localStorage, clock, txVer) {
  const window = {};
  const sandbox = {
    window,
    localStorage,
    Date: { now: clock.now },
    JSON,
    String,
    Object,
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
  };
  const prelude = [
    'var __TXVER=' + JSON.stringify(txVer) + ';',
    'var __TXPFX="shell.tx"+__TXVER+":";',
    'var __TXLRUKEY="shell.txLru"+__TXVER;',
  ];
  const body = SEED_FNS.map((n) => shellFns[n]).join('\n');
  const exportLine = 'globalThis.__api={__txGet:__txGet,__txSet:__txSet,__txPrune:__txPrune,__txKey:__txKey,__txLru:__txLru,__TXPFX:__TXPFX,__TXLRUKEY:__TXLRUKEY};';
  vm.createContext(sandbox);
  vm.runInContext(prelude.join('\n') + '\n' + body + '\n' + exportLine, sandbox);
  return { window, api: sandbox.__api };
}

// ---------------------------------------------------------------------------
// 4. Scenario: cold boot -> warm boot (hits) -> query drift -> TX_VER bust.
// ---------------------------------------------------------------------------
const PLUGINS = [
  'https://tv.example/web/plugins/jellyfinEnhanced/main.js',
  'https://tv.example/web/plugins/themeSwitcher/index.js',
  'https://tv.example/web/plugins/trailers/bundle.js',
  'https://tv.example/web/plugins/skipIntro/skip.js',
  'https://tv.example/web/plugins/subtitleTweaks/sub.js',
];
const BODY = function (u) { return '/*transpiled*/console.log(' + JSON.stringify(u) + ');'; };

const ls = makeLocalStorage(null);

// --- Cold boot: nothing cached. Every __txGet misses, then __txSet writes. ---
(function coldBoot() {
  const { window, api } = loadSeed(ls, makeClock(), TX_VER);
  PLUGINS.forEach((u) => {
    const v = api.__txGet(u);
    if (v == null) api.__txSet(u, BODY(u)); // simulate fetch+transpile then cache
  });
  check('cold boot: all lookups miss, none hit',
    (window.__shellTxCacheHits || 0) === 0 && window.__shellTxCacheMisses === PLUGINS.length,
    `hits=${window.__shellTxCacheHits || 0} misses=${window.__shellTxCacheMisses}`);
  const keys = ls._bodyKeys();
  check('cold boot: bodies written under shell.tx<VER>: keys',
    keys.length === PLUGINS.length && keys.every((k) => k.indexOf(TX_PFX) === 0),
    `wrote ${keys.length} keys, e.g. ${keys[0]}`);
  // LRU map persisted with one timestamp per cached key.
  const lru = JSON.parse(ls.getItem('shell.txLru' + TX_VER) || '{}');
  check('cold boot: LRU timestamp map has one entry per cached body',
    Object.keys(lru).length === PLUGINS.length,
    `lru entries=${Object.keys(lru).length}`);
})();

// --- Warm boot: same plugins, fresh window counters, cache intact. ---
(function warmBoot() {
  const { window, api } = loadSeed(ls, makeClock(), TX_VER);
  let bodiesOk = true;
  PLUGINS.forEach((u) => { if (api.__txGet(u) !== BODY(u)) bodiesOk = false; });
  check('warm boot: __shellTxCacheHits == N and __shellTxCacheMisses stays 0',
    window.__shellTxCacheHits === PLUGINS.length && (window.__shellTxCacheMisses || 0) === 0,
    `hits=${window.__shellTxCacheHits} misses=${window.__shellTxCacheMisses || 0}`);
  check('warm boot: each hit returns the exact cached body', bodiesOk, '');
})();

// --- Query-string drift (JEL-554): JellyfinEnhanced appends ?v=<Date.now()>.
//     The key strips the query, so a drifting query still hits. ---
(function queryDrift() {
  const { window, api } = loadSeed(ls, makeClock(), TX_VER);
  PLUGINS.forEach((u, i) => api.__txGet(u + '?v=' + (9000000 + i)));
  check('warm boot with ?v= query drift still hits (key normalizes query away)',
    window.__shellTxCacheHits === PLUGINS.length && (window.__shellTxCacheMisses || 0) === 0,
    `hits=${window.__shellTxCacheHits} misses=${window.__shellTxCacheMisses || 0}`);
})();

// --- TX_VER bust: a new babel fingerprint flips the prefix. The previously
//     cached entries live under the OLD prefix and are now invisible -> miss,
//     re-transpile, re-write under the NEW prefix. ---
(function txVerBust() {
  const { window, api } = loadSeed(ls, makeClock(), TX_VER_BUST);
  PLUGINS.forEach((u) => { if (api.__txGet(u) == null) api.__txSet(u, BODY(u)); });
  check('TX_VER bust: warm entries invisible -> all miss + re-transpile',
    (window.__shellTxCacheHits || 0) === 0 && window.__shellTxCacheMisses === PLUGINS.length,
    `hits=${window.__shellTxCacheHits || 0} misses=${window.__shellTxCacheMisses}`);
  const newKeys = ls._bodyKeys().filter((k) => k.indexOf('shell.tx' + TX_VER_BUST + ':') === 0);
  const oldKeys = ls._bodyKeys().filter((k) => k.indexOf(TX_PFX) === 0);
  check('TX_VER bust: re-written under new prefix; old-prefix entries untouched',
    newKeys.length === PLUGINS.length && oldKeys.length === PLUGINS.length,
    `new=${newKeys.length} old=${oldKeys.length}`);
  // A subsequent boot on the busted version now hits.
  const re = loadSeed(ls, makeClock(), TX_VER_BUST);
  PLUGINS.forEach((u) => re.api.__txGet(u));
  check('TX_VER bust: next boot on new version hits the re-transpiled cache',
    re.window.__shellTxCacheHits === PLUGINS.length && (re.window.__shellTxCacheMisses || 0) === 0,
    `hits=${re.window.__shellTxCacheHits} misses=${re.window.__shellTxCacheMisses || 0}`);
})();

// ---------------------------------------------------------------------------
// 5. LRU eviction: on quota, __txSet prunes the 10 least-recently-used entries
//    (by LRU timestamp) and retries the write.
// ---------------------------------------------------------------------------
(function lruEviction() {
  const QUOTA = 25; // body-entry cap; the 26th write triggers prune-then-retry
  const lls = makeLocalStorage(QUOTA);
  const clock = makeClock();
  const { api } = loadSeed(lls, clock, TX_VER);

  // Fill to quota with U000..U024, touching them in ascending order so their
  // LRU timestamps are strictly increasing (U000 = oldest).
  const urls = [];
  for (let i = 0; i < QUOTA; i++) {
    const u = 'https://tv.example/web/plugins/p' + String(i).padStart(3, '0') + '.js';
    urls.push(u);
    api.__txSet(u, BODY(u));
  }
  check('LRU: cache filled exactly to quota before eviction',
    lls._bodyKeys().length === QUOTA, `bodies=${lls._bodyKeys().length}`);

  // One more write overflows quota -> __txSet catches, __txPrune removes the 10
  // oldest, then the retry succeeds.
  const overflow = 'https://tv.example/web/plugins/p999.js';
  api.__txSet(overflow, BODY(overflow));

  const remaining = lls._bodyKeys();
  // The 10 oldest (U000..U009) should be gone; U010..U024 + p999 remain.
  const evicted = urls.slice(0, 10).filter((u) => remaining.includes(TX_PFX + u));
  const survivedOld = urls.slice(10).every((u) => remaining.includes(TX_PFX + u));
  const overflowStored = remaining.includes(TX_PFX + overflow);
  check('LRU: overflow write evicts exactly the 10 least-recently-used entries',
    evicted.length === 0 && survivedOld && overflowStored
      && remaining.length === QUOTA - 10 + 1,
    `remaining=${remaining.length} evictedStillPresent=${evicted.length} overflowStored=${overflowStored}`);

  // The LRU map must be pruned in lock-step (no orphan timestamps for evicted keys).
  const lru = JSON.parse(lls.getItem('shell.txLru' + TX_VER) || '{}');
  const orphanTs = urls.slice(0, 10).filter((u) => Object.prototype.hasOwnProperty.call(lru, u));
  check('LRU: pruned entries removed from the timestamp map too (no orphans)',
    orphanTs.length === 0 && Object.keys(lru).length === remaining.length,
    `lruEntries=${Object.keys(lru).length} orphans=${orphanTs.length}`);

  // Recency matters, not insertion order: re-touch an "old" survivor so it is
  // most-recent, then force another eviction and confirm it is spared.
  const reTouched = urls[10]; // oldest current survivor
  api.__txGet(reTouched); // bumps its LRU timestamp to "now"
  // Refill back over quota.
  for (let i = 0; i < 10; i++) {
    const u = 'https://tv.example/web/plugins/q' + String(i).padStart(3, '0') + '.js';
    api.__txSet(u, BODY(u));
  }
  const afterKeys = lls._bodyKeys();
  check('LRU: a re-touched (recently used) entry survives the next eviction',
    afterKeys.includes(TX_PFX + reTouched),
    `reTouched present=${afterKeys.includes(TX_PFX + reTouched)}`);
})();

// ---------------------------------------------------------------------------
// 6. Static <-> dynamic key agreement (within a single deployed build): the
//    static pass derives the same TX_PFX and normalizes the key the same way,
//    so a body written by the static pass is found by the dynamic seed (and
//    vice-versa). Asserted at the source level.
// ---------------------------------------------------------------------------
(function staticDynamicAgreement() {
  // Static path uses TX_PFX + txKey(url); the seed uses __TXPFX + __txKey(src).
  // Both derive TX_VER from the same three inputs and strip at the first '?'.
  const staticTxKey = shellSrc.match(/function txKey\(url\)\s*\{[\s\S]*?\n {2}\}/);
  const seedTxKeyBody = shellFns['__txKey'];
  // Behavioural equivalence of the two key normalizers on representative URLs.
  const stKey = (0, eval)('(' + staticTxKey[0] + ')'); // eslint-disable-line no-eval
  const seedKey = (0, eval)('(' + seedTxKeyBody.replace('__txKey', 'fn') + ')'); // eslint-disable-line no-eval
  const samples = [
    'https://x/web/p/a.js',
    'https://x/web/p/a.js?v=123',
    'https://x/web/p/a.js?v=1&w=2',
    '',
    null,
  ];
  const mismatch = samples.filter((s) => stKey(s) !== seedKey(s));
  check('static txKey() and seed __txKey() normalize URLs identically',
    mismatch.length === 0, mismatch.length ? 'mismatch on: ' + JSON.stringify(mismatch) : '');
  // Both reference the same TX_PFX var derived once at top-of-IIFE.
  check('static + dynamic paths share one TX_PFX (single derived prefix per build)',
    /var TX_PFX = "shell\.tx" \+ TX_VER \+ ":";/.test(shellSrc)
      && shellFns['__txGet'].indexOf('__TXPFX+k') >= 0,
    '');
})();

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(`transpile-cache: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach((r) => console.log('  - ' + r.name + (r.detail ? '  (' + r.detail + ')' : '')));
  process.exit(1);
}
console.log('ALL TRANSPILE-CACHE PARITY CHECKS PASS');
process.exit(0);
