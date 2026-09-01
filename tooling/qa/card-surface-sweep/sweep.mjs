// Native card-surface sweep (built for JELA-696).
//
// Drives the M63 rig through every native card surface and reports, per surface,
// how many cards actually rendered and what threw getting there. One arm per
// invocation:
//   ARM=ctl  worker shim killed  (localStorage["jellyfin.shell.workerShimDisabled"]="1")
//   ARM=fix  shipped default
// Use the SAME shell.min.js in both arms — the only variable should be the arm.
//
// Required env:
//   RIG        dir holding the served rig (index.html arm page + probe.js + seed.html)
//   HARNESS    the local Chromium-63 harness (see docs/ and the JELA-112 recipe)
//   LIB_MOVIES LIB_SHOWS LIB_BOXSETS   library ids on the server under test
//   ITEM_MOVIE ITEM_SERIES             item ids to open detail pages for
// See docs/jela696-worker-shim-blast-radius.md for the full method.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const { attach } = await import(process.env.CDP_MODULE || './cdp.mjs');

const HARNESS = process.env.HARNESS || '/tmp/local-tizen-tester';
const PORT = Number(process.env.CDP_PORT || 9696);
const HTTP = Number(process.env.HTTP_PORT || 8087);
const ORIGIN = `http://127.0.0.1:${HTTP}`;
const OUT = process.env.OUT || '/tmp/jela696/runs';
const PROF = process.env.PROF || '/tmp/jela696/prof';
const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36';
const ARM = process.env.ARM || 'fix';
const tag = process.argv[2] || ARM;

// Server-specific ids — no defaults on purpose: a wrong id renders an empty
// page, which reads exactly like the bug this sweep is looking for.
const need = k => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const MOVIES = need('LIB_MOVIES');
const SHOWS = need('LIB_SHOWS');
const BOXSETS = need('LIB_BOXSETS');
const MOVIE_ID = need('ITEM_MOVIE');
const SERIES_ID = need('ITEM_SERIES');

const STOPS = [
  { name: 'home',            route: '' },                                   // where boot lands
  { name: 'movies-grid',     route: `#/movies?topParentId=${MOVIES}` },
  { name: 'movies-suggest',  route: `#/movies?topParentId=${MOVIES}&tab=1` },
  { name: 'shows-grid',      route: `#/tv?topParentId=${SHOWS}` },
  { name: 'collections',     route: `#/list?parentId=${BOXSETS}` },
  { name: 'search',          route: '#/search?query=nin' },
  { name: 'favorites-tab',   route: '#/home?tab=1' },
  { name: 'detail-movie',    route: `#/details?id=${MOVIE_ID}` },
  { name: 'detail-series',   route: `#/details?id=${SERIES_ID}` },
];

const BOOT_MS = Number(process.env.BOOT_MS || 55000);
const STOP_MS = Number(process.env.STOP_MS || 14000);
const WAIT_MS = BOOT_MS + STOPS.length * STOP_MS + 6000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function killSweep() {
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cl = '';
    try { cl = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (cl.includes(`--user-data-dir=${PROF}`)) { try { process.kill(Number(d), 'SIGKILL'); n++; } catch {} }
  }
  return n;
}

function launch(logPath) {
  const log = fs.openSync(logPath, 'a');
  const p = spawn(`${HARNESS}/chrome-linux/chrome`, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--window-size=${process.env.WIN || '854,540'}`,
    ...(process.env.IMAGES === '1' ? [] : ['--blink-settings=imagesEnabled=false']),
    '--renderer-process-limit=1', '--disable-software-rasterizer',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROF}`,
    `--user-agent=${UA}`,
    'about:blank',
  ], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      LD_LIBRARY_PATH: `${HARNESS}/libs/usr/lib/x86_64-linux-gnu:${HARNESS}/libs/lib/x86_64-linux-gnu`,
      FONTCONFIG_FILE: `${HARNESS}/fonts.conf`,
    },
    detached: true,
  });
  p.unref();
  return p;
}

async function waitCdp(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  throw new Error('CDP never came up');
}

fs.mkdirSync(OUT, { recursive: true });
killSweep();
await sleep(600);
fs.rmSync(PROF, { recursive: true, force: true });
fs.mkdirSync(PROF, { recursive: true });
launch(`${OUT}/chrome-${tag}.log`);
await waitCdp();
const load0 = fs.readFileSync('/proc/loadavg', 'utf8').trim();
console.error(`[${tag}] chrome up, load=${load0}`);

let c = await attach(PORT, `127.0.0.1:${HTTP}`);
await c.send('Page.enable');
await c.send('Page.navigate', { url: `${ORIGIN}/seed.html` });
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const t = await c.evaluate('document.title', 5000).catch(() => '');
  if (t === 'SEEDED') break;
}
const seedJs = `
  localStorage.setItem('jela696.arm', ${JSON.stringify(ARM)});
  localStorage.setItem('jela696.stops', ${JSON.stringify(JSON.stringify(STOPS))});
  localStorage.setItem('jela696.bootMs', '${BOOT_MS}');
  localStorage.setItem('jela696.stopMs', '${STOP_MS}');
  ${ARM === 'ctl'
      ? `localStorage.setItem('jellyfin.shell.workerShimDisabled','1');`
      : `localStorage.removeItem('jellyfin.shell.workerShimDisabled');`}
  localStorage.setItem('jela680.coalesce.on','0');
  localStorage.setItem('jela682.cache','0'); localStorage.setItem('jela682.defer','0');
  localStorage.setItem('jela681.sub','0');
  localStorage.setItem('jellyplug.genrerows.stream','0');
  localStorage.setItem('jellyplug.rows.earlyarm','0');
  localStorage.removeItem('jela696.probe');
  localStorage.getItem('jellyfin.shell.workerShimDisabled')+'|ok'`;
console.error(`[${tag}] seed -> ${await c.evaluate(seedJs)}`);
await c.send('Page.navigate', { url: 'about:blank' });
await sleep(700);

const wall0 = Date.now();
await c.send('Page.navigate', { url: `${ORIGIN}/${process.env.ARM_PAGE || 'index696.html'}` });
c.close();                       // no CDP traffic during the boot/tour window
await sleep(WAIT_MS);

let c2 = null;
try { c2 = await attach(PORT, `127.0.0.1:${HTTP}`); }
catch {
  killSweep(); await sleep(1200);
  launch(`${OUT}/chrome-${tag}-recover.log`); await waitCdp();
  c2 = await attach(PORT, `127.0.0.1:${HTTP}`);
  await c2.send('Page.navigate', { url: `${ORIGIN}/blank.html` });
  await sleep(1500);
}
let probe = null;
for (let i = 0; i < 4; i++) {
  try {
    probe = await c2.evaluate(`(function(){try{if(window.__jela696finish)window.__jela696finish();}catch(e){} return localStorage.getItem('jela696.probe');})()`, 45000);
    if (probe) break;
  } catch { await sleep(2000); }
}
c2.close();
killSweep();
const res = { tag, arm: ARM, load0, loadEnd: fs.readFileSync('/proc/loadavg', 'utf8').trim(),
              wallMs: Date.now() - wall0, probe: probe ? JSON.parse(probe) : null };
fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(res, null, 1));
const p = res.probe;
if (p) {
  console.error(`[${tag}] shim=${JSON.stringify(p.shim)} Worker=${p.workerNative} stops=${p.stops.length} errs=${p.err.length} throws=${p.throws.length}`);
  for (const s of p.stops) {
    console.error(`  ${String(s.name).padEnd(15)} page=${String(s.fin?.page||'').slice(0,24).padEnd(24)} maxCards=${String(s.max ? s.max.cards : '-').padStart(4)} finCards=${String(s.fin ? s.fin.cards : '-').padStart(4)} ics=${s.fin ? s.fin.ics : '-'} empty=${s.fin?.empty} eb=${s.fin?.errorBoundary} err=${s.nErr} thr=${s.nThrow}`);
  }
} else console.error(`[${tag}] NO PROBE`);
console.log(`${OUT}/${tag}.json`);
