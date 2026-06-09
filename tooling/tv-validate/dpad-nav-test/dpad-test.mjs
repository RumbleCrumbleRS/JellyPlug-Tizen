// JEL-33 — Browser-side D-pad (arrow-key) navigation + body-focus rescue test.
//
// Drives a real headless Chrome-for-Testing (launched by bootstrap-chromium.sh)
// against a live Jellyfin server, logs in via the web UI, injects the EXACT
// body-focus rescue IIFE that ships in the shell (read from
// packages/shell-tizen-bootstrap/src/boot-shell.src.js so it never drifts from
// the deployed code), then walks Home / Library / Search / Settings / Details.
//
// For each page it verifies:
//   1. body-focus rescue FIRES   (__shellBodyFocusRescueAttempts increments on
//      an arrow keydown while document.activeElement === <body>), and
//   2. body-focus rescue SUCCEEDS (__shellBodyFocusRescues increments and
//      activeElement leaves <body> onto a real visible focusable), and
//   3. focus is NOT stuck (Tab/arrow events reach multiple distinct targets).
//
// The rescue IIFE is byte-identical between boot-shell.src.js (bootstrap / TV
// baked path) and shell.js (hosted-shell path), so this exercises the same
// code that runs on the Tizen set; only the JS engine differs (M63 vs V8).
//
// Env: JELLYFIN_URL, JELLYFIN_USER, JELLYFIN_PASS, CDP_BASE (optional).
// Usage: node dpad-test.mjs   (prints a JSON report, exits non-zero on FAIL)

import { connectPage, evalExpr, sleep } from './cdp.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!URL || !USER || !PASS) {
  console.error('Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS');
  process.exit(2);
}

// Extract the rescue IIFE from the source of record so this test always runs
// the same bytes that ship in the WGT.
function extractRescueIife() {
  const p = resolve(HERE, '../../../packages/shell-tizen-bootstrap/src/boot-shell.src.js');
  const lines = readFileSync(p, 'utf8').split('\n');
  const idx = lines.findIndex(
    (l) => l.includes('var K={ArrowUp:1') && l.includes('__shellBodyFocusRescueBound'),
  );
  if (idx < 0) throw new Error('rescue IIFE not found in boot-shell.src.js');
  const line = lines[idx];
  return line
    .slice(line.indexOf('`') + 1, line.lastIndexOf('`'))
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$');
}

const KEYS = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Tab: 9 };

const cdp = await connectPage();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Input.enable').catch(() => {});

async function key(k) {
  const b = { key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...b });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b });
}
async function active() {
  return await evalExpr(
    cdp,
    `(()=>{const a=document.activeElement;if(!a)return null;const r=a.getBoundingClientRect();return {tag:a.tagName,id:a.id||'',cls:(typeof a.className==='string'?a.className:'').split(' ')[0]||'',txt:(a.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30),isBody:a===document.body||a.tagName==='HTML',x:Math.round(r.x),y:Math.round(r.y),vis:r.width>0&&r.height>0};})()`,
  );
}
async function counters() {
  return await evalExpr(
    cdp,
    `({att:window.__shellBodyFocusRescueAttempts||0,res:window.__shellBodyFocusRescues||0,bound:window.__shellBodyFocusRescueBound||0})`,
  );
}
async function forceBody() {
  await evalExpr(
    cdp,
    `(()=>{try{var a=document.activeElement;a&&a!==document.body&&a.blur&&a.blur();}catch(_){}})()`,
  );
}
const sig = (a) => (a ? `${a.tag}.${a.cls}#${a.id}@${a.x},${a.y}` : 'null');

// ---- log in (web UI manual-login flow) ----
await cdp.send('Page.navigate', { url: URL + '/web/index.html#/home' });
await sleep(6000);
await evalExpr(
  cdp,
  `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   function setVal(el,v){const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
   for(let i=0;i<30;i++){let n=document.querySelector('#txtManualName');
     if(n){let p=document.querySelector('#txtManualPassword');setVal(n,${JSON.stringify(USER)});if(p)setVal(p,${JSON.stringify(PASS)});
       let f=n.closest('form');if(f)f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
       let b=document.querySelector('.btnManual,button[type=submit],.btnLogin');if(b)b.click();return;}
     let m=[...document.querySelectorAll('a,button')].find(e=>/manual login|other user/i.test(e.textContent||''));
     if(m){m.click();await sleep(800);continue;}await sleep(700);} })()`,
);
await sleep(5000);
await evalExpr(cdp, `location.hash='#/home'`, false).catch(() => {});
await sleep(3500);

// ---- inject the deployed rescue IIFE once (mirrors shell boot) ----
const RESCUE = extractRescueIife();
const injected = await evalExpr(
  cdp,
  `(()=>{if(window.__shellBodyFocusRescueBound)return'already-bound';try{${RESCUE}}catch(e){return'inject-err:'+e.message;}return window.__shellBodyFocusRescueBound?'bound-ok':'bound-fail';})()`,
);
await evalExpr(cdp, `window.__shellAFForceAuth=1;`); // treat the live session as authed for the AF interval

// ---- resolve a real library + item id from the home DOM ----
const ids = await evalExpr(
  cdp,
  `(()=>{const lib=[...document.querySelectorAll('a[href*="parentId="],a[href*="ParentId="]')].map(a=>a.getAttribute('href'))[0]||null;
    const it=[...document.querySelectorAll('a[href*="details?id="]')].map(a=>a.getAttribute('href'))[0]||null;
    let id=null,sid=null;if(it){const m=it.match(/id=([0-9a-f-]+)/i);id=m&&m[1];const s=it.match(/serverId=([0-9a-f]+)/i);sid=s&&s[1];}
    return {lib,id,sid};})()`,
);
const libHash = ids.lib ? '#' + ids.lib.replace(/^[^#]*#?\/?/, '/').replace(/^\/+/, '/') : null;
const detailsHash = ids.id
  ? `#/details?id=${ids.id}` + (ids.sid ? `&serverId=${ids.sid}` : '')
  : null;

const ROUTES = [
  { name: 'Home', hash: '#/home' },
  { name: 'Library', hash: libHash },
  { name: 'Search', hash: '#/search' },
  { name: 'Settings', hash: '#/mypreferencesmenu' },
  { name: 'Details', hash: detailsHash },
];

const results = [];
for (const r of ROUTES) {
  if (!r.hash) {
    results.push({ page: r.name, status: 'SKIP', reason: 'no id resolved from DOM' });
    continue;
  }
  await evalExpr(cdp, `location.hash=${JSON.stringify(r.hash)}`, false).catch(() => {});
  await sleep(4500);
  const focusables = await evalExpr(
    cdp,
    `document.querySelectorAll('a[href]:not([tabindex="-1"]),button:not(:disabled):not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),.focusable:not([tabindex="-1"])').length`,
  );
  // rescue test
  await forceBody();
  const wasBody = (await active())?.isBody;
  const before = await counters();
  await key('ArrowDown');
  await sleep(300);
  const after = await counters();
  const act = await active();
  const rescueFired = after.att > before.att;
  const rescueSucceeded = after.res > before.res && act && !act.isBody && act.vis;
  // not-stuck test: many Tabs/arrows, count distinct targets
  const seen = [];
  for (const k of ['ArrowRight', 'ArrowDown', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await key(k);
    await sleep(160);
    seen.push(sig(await active()));
  }
  const distinct = new Set(seen).size;
  const pass = rescueFired && rescueSucceeded && distinct > 1;
  results.push({
    page: r.name,
    status: pass ? 'PASS' : 'FAIL',
    focusables,
    wasBody,
    rescueFired,
    rescueSucceeded,
    landedOn: act ? `${act.tag}.${act.cls} "${act.txt}"` : 'null',
    notStuckDistinctTargets: distinct,
  });
}

console.log('inject:', injected);
console.log('rescue IIFE bytes:', RESCUE.length);
console.log(JSON.stringify(results, null, 2));
console.log('final counters:', JSON.stringify(await counters()));
const failed = results.filter((r) => r.status === 'FAIL');
process.exit(failed.length ? 1 : 0);
