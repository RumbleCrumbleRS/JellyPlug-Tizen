#!/usr/bin/env node
/*
 * wgt-emulate end-to-end validation (JEL-4).
 *
 * Drives the REAL Hosted Shell Bootstrap (HSB) boot flow from
 * packages/shell-tizen-bootstrap/src/index.html inside a DOM engine (jsdom),
 * against a live `serve.py` instance. Unlike `serve.py --self-test` (which only
 * asserts HTTP endpoint shape) this actually executes the bootloader: reading
 * localStorage, rendering the connect form, submitting it, fetching the manifest
 * over XHR, <script>-loading the hosted shell, and exercising both fallback
 * branches. It is headless (no GUI browser) so it runs in CI.
 *
 * jsdom is intentionally NOT a committed workspace dependency — the documented
 * Tier 2 default is "Python 3 + a browser". This deeper check is opt-in: if
 * jsdom isn't resolvable it prints how to enable and exits 0 (skip, not fail).
 *
 *   # from tooling/wgt-emulate:
 *   npm install jsdom    # one-time, local (not committed)
 *   node e2e.cjs
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVE = path.join(HERE, 'serve.py');
const SERVER_KEY = 'jellyfin.shell.serverUrl';

// --- locate jsdom (local install or JSDOM_PATH); skip cleanly if absent ------
// ResourceLoader was a named export in older jsdom (<=16) but was dropped in
// newer releases (jsdom 29 exposes only JSDOM/VirtualConsole/CookieJar/…). We
// treat it as optional: when present we use it to relax strictSSL, otherwise we
// fall back to `resources: 'usable'`, which is enough to load the http://
// localhost manifest/shell that this harness serves.
let JSDOM, ResourceLoader, VirtualConsole;
try {
  const mod = process.env.JSDOM_PATH ? require(process.env.JSDOM_PATH) : require('jsdom');
  ({ JSDOM, ResourceLoader, VirtualConsole } = mod);
} catch (_) {
  console.log('SKIP: jsdom not found. This optional DOM-engine e2e needs jsdom.');
  console.log('      Enable it with:  (cd tooling/wgt-emulate && npm install jsdom)');
  console.log('      or point at an existing copy:  JSDOM_PATH=/path/to/jsdom node e2e.cjs');
  process.exit(0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function probe() {
      const req = http.get({ host: '127.0.0.1', port, path: '/shell/manifest.json' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('server did not come up on ' + port));
        setTimeout(probe, 100);
      });
    })();
  });
}

async function startServer(port, extraArgs) {
  const args = [SERVE, '--port', String(port)].concat(extraArgs || []);
  const proc = spawn('python3', args, { cwd: HERE, stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForPort(port, 8000);
  return proc;
}

// Load the WGT index in jsdom against the live server, optionally pre-seeding
// the serverUrl (simulating a post-connect reload). Returns the final hsbState.
async function bootInBrowser(port, { seedServer } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const resources = typeof ResourceLoader === 'function'
    ? new ResourceLoader({ strictSSL: false })
    : 'usable';
  // jsdom raises "Not implemented: navigation" when the bootloader calls
  // location.reload() — capture that as proof the reload was invoked.
  const navAttempts = { count: 0 };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (/navigation/i.test((err && err.message) || '')) navAttempts.count += 1;
  });
  const dom = await JSDOM.fromURL(base + '/index.html', {
    runScripts: 'dangerously',
    resources,
    virtualConsole,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.console.warn = () => {};
      window.console.error = () => {};
      if (seedServer) {
        try { window.localStorage.setItem(SERVER_KEY, seedServer); } catch (_) {}
      }
    },
  });
  const win = dom.window;

  const terminal = new Set([
    'shell-loaded', 'baked-shell-loaded', 'baked-load-failed', 'no-server-url',
  ]);
  // JEL-32: sample #boot-root visibility and the phase sequence across the whole
  // boot so warm-boot scenarios can prove the connect form never flickers in,
  // not merely that it is hidden at the terminal phase.
  const phasesSeen = [];
  let bootRootEverVisible = false;
  function sampleBootRoot() {
    const root = win.document.getElementById('boot-root');
    if (root && win.getComputedStyle(root).display !== 'none') bootRootEverVisible = true;
    const p = win.__hsbState && win.__hsbState.phase;
    if (p && phasesSeen[phasesSeen.length - 1] !== p) phasesSeen.push(p);
  }
  const deadline = Date.now() + 12000;
  let phase = null;
  while (Date.now() < deadline) {
    sampleBootRoot();
    phase = win.__hsbState && win.__hsbState.phase;
    if (phase && terminal.has(phase)) break;
    await sleep(10);
  }
  sampleBootRoot();
  return { dom, win, state: win.__hsbState || {}, phase, navAttempts, phasesSeen, bootRootEverVisible };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 1. No serverUrl -> connect form renders; submit trims + saves + reloads.
async function scenarioConnectForm(port) {
  const proc = await startServer(port, []);
  try {
    const { dom, win, phase, navAttempts } = await bootInBrowser(port, {});
    const root = win.document.getElementById('boot-root');
    const formVisible = root && win.getComputedStyle(root).display !== 'none';
    check('connect-form: no serverUrl -> form shown', phase === 'no-server-url' && formVisible, `phase=${phase}`);

    win.document.getElementById('server-input').value = `http://127.0.0.1:${port}/`; // trailing slash
    win.document.getElementById('server-form')
      .dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(100);
    const saved = win.localStorage.getItem(SERVER_KEY);
    check('connect-form: submit saves trimmed serverUrl', saved === `http://127.0.0.1:${port}`, `saved=${saved}`);
    check('connect-form: submit triggers location.reload()', navAttempts.count > 0, `navAttempts=${navAttempts.count}`);
    dom.window.close();
  } finally { proc.kill(); }
}

// 2. Happy path: manifest 200 -> hosted shell (?v=sha) -> EMULATED SHELL LOADED.
async function scenarioHappyPath(port) {
  const proc = await startServer(port, []);
  try {
    const { dom, win, state, phase } = await bootInBrowser(port, { seedServer: `http://127.0.0.1:${port}` });
    check('happy-path: reaches shell-loaded', phase === 'shell-loaded', `phase=${phase}`);
    check('happy-path: manifest sha recorded', !!state.manifestSha, `sha=${(state.manifestSha || '').slice(0, 16)}`);
    check('happy-path: shellUrl cache-busted by sha (?v=)', /\/shell\/shell\.min\.js\?v=/.test(state.shellUrl || ''), `shellUrl=${state.shellUrl}`);
    check('happy-path: stub shell executed (window.__emulatedShell)', win.__emulatedShell === true);
    const box = win.document.getElementById('emulated-shell');
    check('happy-path: EMULATED SHELL LOADED screen rendered', !!box && /EMULATED SHELL LOADED/.test(box.textContent || ''));
    check('happy-path: no errors recorded', (state.errors || []).length === 0, `errors=${(state.errors || []).join('|')}`);
    dom.window.close();
  } finally { proc.kill(); }
}

// 2b. Warm boot (JEL-32): a saved serverUrl auto-connects WITHOUT ever painting
//     the connect screen. #boot-root must stay display:none for the entire boot
//     (no connect-form flicker), the bootloader must never enter the
//     'no-server-url' phase, and the hosted shell (which document.writes
//     ${server}/web/index.html) must load. The bootstrap uses no Tizen APIs, so
//     this path is byte-identical on desktop browser and the Tizen 5.0 WebView.
async function scenarioWarmBoot(port) {
  const proc = await startServer(port, []);
  try {
    const { dom, win, state, phase, phasesSeen, bootRootEverVisible, navAttempts } =
      await bootInBrowser(port, { seedServer: `http://127.0.0.1:${port}` });
    const root = win.document.getElementById('boot-root');
    check('warm-boot: #boot-root never painted (no connect flicker)',
      bootRootEverVisible === false, `everVisible=${bootRootEverVisible}`);
    check('warm-boot: #boot-root hidden at end (display:none)',
      root && win.getComputedStyle(root).display === 'none',
      `display=${root && win.getComputedStyle(root).display}`);
    check('warm-boot: no inline display set on #boot-root (showConnectForm never ran)',
      root && (root.style.display === '' || root.style.display === 'none'),
      `inline=${JSON.stringify(root && root.style.display)}`);
    check('warm-boot: bootloader never entered no-server-url phase',
      !phasesSeen.includes('no-server-url'), `phases=${phasesSeen.join('>')}`);
    check('warm-boot: no location.reload() (already warm, no submit)',
      navAttempts.count === 0, `navAttempts=${navAttempts.count}`);
    check('warm-boot: went straight to manifest fetch (loadHostedShell, not connect form)',
      phasesSeen[0] === 'fetch-manifest', `phases=${phasesSeen.join('>')}`);
    check('warm-boot: hosted /shell/shell.min.js was selected for load',
      /\/shell\/shell\.min\.js/.test(state.shellUrl || ''), `shellUrl=${state.shellUrl}`);
    check('warm-boot: reaches shell-loaded (hosted shell took over)',
      phase === 'shell-loaded', `phase=${phase}`);
    check('warm-boot: shell that performs the /web/ document.write executed',
      win.__emulatedShell === true);
    check('warm-boot: no boot errors recorded',
      (state.errors || []).length === 0, `errors=${(state.errors || []).join('|')}`);
    dom.window.close();
  } finally { proc.kill(); }
}

// 3. manifest 503 -> bootloader still loads shell.min.js with ?t= cache-buster.
async function scenarioFailManifest(port) {
  const proc = await startServer(port, ['--fail-manifest']);
  try {
    const { dom, win, state, phase } = await bootInBrowser(port, { seedServer: `http://127.0.0.1:${port}` });
    check('fail-manifest: still reaches shell-loaded', phase === 'shell-loaded', `phase=${phase}`);
    check('fail-manifest: shellUrl uses ?t= fallback', /\/shell\/shell\.min\.js\?t=\d+/.test(state.shellUrl || ''), `shellUrl=${state.shellUrl}`);
    check('fail-manifest: stub shell still executed', win.__emulatedShell === true);
    check('fail-manifest: manifest-http-503 error noted', (state.errors || []).some((e) => /manifest-http-503/.test(e)), `errors=${(state.errors || []).join('|')}`);
    dom.window.close();
  } finally { proc.kill(); }
}

// 4. shell.min.js 503 -> <script> onerror -> baked boot-shell.min.js fallback.
async function scenarioFailShell(port) {
  const proc = await startServer(port, ['--fail-shell']);
  try {
    const { dom, win, state, phase } = await bootInBrowser(port, { seedServer: `http://127.0.0.1:${port}` });
    check('fail-shell: falls back to baked shell', phase === 'baked-shell-loaded', `phase=${phase}`);
    check('fail-shell: fallback reason = script-error', state.fallback === 'script-error', `fallback=${state.fallback}`);
    check('fail-shell: __hsbFallback set', win.__hsbFallback === 'script-error');
    dom.window.close();
  } finally { proc.kill(); }
}

(async () => {
  void REPO_ROOT; // (kept for clarity / future use)
  await scenarioConnectForm(8101);
  await scenarioHappyPath(8102);
  await scenarioWarmBoot(8105);
  await scenarioFailManifest(8103);
  await scenarioFailShell(8104);

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log(`e2e: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((r) => console.log('  - ' + r.name + (r.detail ? '  (' + r.detail + ')' : '')));
    process.exit(1);
  }
  console.log('ALL E2E CHECKS PASS');
  process.exit(0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
