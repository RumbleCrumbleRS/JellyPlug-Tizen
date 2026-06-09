// JEL-44 — Browser-side subtitle render capture (the "browser" half of the
// browser-vs-TV comparison). Drives a real headless Chrome-for-Testing (launched
// by ../dpad-nav-test/bootstrap-chromium.sh, CDP on :9222) against the live
// Jellyfin server: logs in, plays an item, opens the subtitle selector, switches
// tracks, and captures HOW each subtitle codec renders + a screenshot.
//
// This establishes the modern-engine baseline. The shell loads /web/ verbatim
// (1:1 parity — see packages/shell-tizen/PARITY_NOTES.md), so the subtitle UI,
// the render path, and the appearance CSS are byte-identical on the M63 TV; only
// the JS/CSS engine differs. The delivery side is covered by subtitle-delivery.mjs
// and the M63 worker parse-safety by octopus-worker-syntax.cjs.
//
// Findings captured on Jellyfin 10.11 (2026-06-09):
//   - Subtitle selector lists every track with codec ("English-SRT - ASS",
//     "Chinese-PGS - PGSSUB", ...) — selection + toggle work.
//   - Selecting an ASS track instantiates SubtitlesOctopus: a <canvas
//     class="libassjs-canvas"> appears under .libassjs-canvas-parent and
//     video.textTracks.length === 0 (NOT native <track>/::cue) — i.e. the
//     enableSsaRender:true client-libass path, confirmed live.
//
// Env: JELLYFIN_URL, JELLYFIN_USER, JELLYFIN_PASS, CDP_BASE (optional),
//      ITEM_ID (optional — defaults to an ASS-bearing item), SEEK (optional sec).
// Usage: ../dpad-nav-test/bootstrap-chromium.sh   # once, brings up CDP :9222
//        node subtitle-render-capture.mjs

import { connectPage, evalExpr, sleep } from '../dpad-nav-test/cdp.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
const ITEM = process.env.ITEM_ID || '38434e613d4cb97c443cc4948f23e457'; // "300" — has an eng ASS track
const SEEK = Number(process.env.SEEK || 0);
if (!URL || !USER || !PASS) {
  console.error('Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS');
  process.exit(2);
}
const watchdog = setTimeout(() => {
  console.log('WATCHDOG-TIMEOUT');
  process.exit(3);
}, 95000);

const cdp = await connectPage();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const shot = (n) =>
  cdp
    .send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(resolve(HERE, n), Buffer.from(r.data, 'base64')))
    .catch(() => {});

// fresh state + login (web manual-login flow; session usually persists)
await cdp.send('Page.navigate', { url: URL + '/web/index.html#/home' });
await sleep(6000);
await evalExpr(
  cdp,
  `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   function setVal(el,v){const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
   for(let i=0;i<20;i++){let n=document.querySelector('#txtManualName');
     if(n){let p=document.querySelector('#txtManualPassword');setVal(n,${JSON.stringify(USER)});if(p)setVal(p,${JSON.stringify(PASS)});let f=n.closest('form');if(f)f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));let b=document.querySelector('.btnManual,button[type=submit]');if(b)b.click();break;}
     let m=[...document.querySelectorAll('a,button')].find(e=>/manual login|other user/i.test(e.textContent||''));if(m){m.click();await sleep(800);continue;}await sleep(700);} })()`,
).catch(() => {});
await sleep(4000);

// open details + start playback (avoid SyncPlay / Cast / Trailer buttons)
await evalExpr(cdp, `location.hash=${JSON.stringify('#/details?id=' + ITEM)}`, false).catch(() => {});
await sleep(6000);
const play = await evalExpr(
  cdp,
  `(()=>{const bad=/sync|cast|trailer|more|favorite|played|queue/i;
    let b=[...document.querySelectorAll('button[data-action]')].find(x=>/play|resume/i.test(x.getAttribute('data-action')||'')&&!bad.test((x.getAttribute('title')||'')+(x.className||'')));
    if(!b)b=[...document.querySelectorAll('button')].find(x=>/^play$|^resume/i.test((x.getAttribute('title')||'').trim()));
    if(b){b.scrollIntoView();b.click();return 'clicked:'+(b.getAttribute('data-action')||b.getAttribute('title'));}return 'none';})()`,
);
console.log('play:', play);
await sleep(15000);
const vstate = await evalExpr(
  cdp,
  `(()=>{const v=document.querySelector('video');if(!v)return 'no-video';try{v.muted=true;v.play&&v.play();if(${SEEK}>0&&v.duration>${SEEK})v.currentTime=${SEEK};}catch(e){}return {ct:Math.round(v.currentTime),paused:v.paused,rs:v.readyState,tt:v.textTracks.length,dur:Math.round(v.duration||0)};})()`,
);
console.log('vstate:', JSON.stringify(vstate));
await sleep(3000);
await shot('capture-playing.png');

// open the subtitle selector
await evalExpr(
  cdp,
  `(()=>{const el=document.querySelector('.videoPlayerContainer,.htmlvideoplayer,body');['mousemove','mousedown','mouseup'].forEach(t=>el&&el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:640,clientY:700})));})()`,
  false,
).catch(() => {});
await sleep(1500);
const subBtn = await evalExpr(
  cdp,
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/subtitle|caption/i.test((x.getAttribute('title')||x.getAttribute('aria-label')||x.className||'')));if(b){b.click();return 'opened:'+(b.getAttribute('title')||b.getAttribute('aria-label')||b.className).slice(0,30);}return 'no-sub-btn';})()`,
);
console.log('subBtn:', subBtn);
await sleep(2000);
const menu = await evalExpr(
  cdp,
  `[...document.querySelectorAll('.actionSheetMenuItem,.listItem')].map((e,i)=>i+':'+(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,36)).filter(s=>s.length>2).slice(0,40)`,
);
console.log('menu:', JSON.stringify(menu));
await shot('capture-menu.png');

// select an ASS/eng track (else 2nd item) and inspect the render path
const pick = await evalExpr(
  cdp,
  `(()=>{const items=[...document.querySelectorAll('.actionSheetMenuItem,.listItem')];let t=items.find(e=>/ass|eng|english/i.test(e.textContent||''));if(!t&&items.length>1)t=items[1];if(t){t.click();return 'picked:'+(t.textContent||'').replace(/\\s+/g,' ').trim().slice(0,36);}return 'no-pick';})()`,
);
console.log('pick:', pick);
await sleep(5000);
await evalExpr(cdp, `(()=>{const v=document.querySelector('video');if(v){try{v.play();}catch(e){}}})()`, false).catch(() => {});
await sleep(3000);
const render = await evalExpr(
  cdp,
  `(()=>{const out={};
    const lib=document.querySelector('canvas.libassjs-canvas,canvas[class*="libass"]');
    out.libassCanvas=lib?{w:lib.width,h:lib.height,style:lib.getAttribute('style')||''}:null;
    const txt=document.querySelector('.htmlvideoplayer ~ div,.subtitleappearance,[class*="subtitle"][class*="appearance"],.videoSubtitles');
    if(txt){const cs=getComputedStyle(txt);out.textOverlay={cls:txt.className,fontSize:cs.fontSize,fontFamily:cs.fontFamily,bottom:cs.bottom,textAlign:cs.textAlign,content:(txt.textContent||'').slice(0,80)};}
    const v=document.querySelector('video');out.video=v?{ct:Math.round(v.currentTime),textTracks:v.textTracks.length}:null;
    return out;})()`,
);
console.log('render:', JSON.stringify(render, null, 2));
await shot('capture-subs-on.png');
writeFileSync(resolve(HERE, 'capture-result.json'), JSON.stringify({ generatedFor: 'JEL-44', item: ITEM, play, vstate, subBtn, menu, pick, render }, null, 2));
clearTimeout(watchdog);
console.log('DONE — wrote capture-result.json + capture-*.png');
process.exit(0);
