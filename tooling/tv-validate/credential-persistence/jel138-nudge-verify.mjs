// JEL-138 fix verification: the default-checked Remember-Me nudge, validated
// against the user's real jellyfin-web bundle. Reproduces the sticky-false
// trap (S2 leaves enableAutoLogin="false"), then injects the EXACT shell nudge
// IIFE and asserts:
//   (a) the box renders CHECKED despite stored flag "false";
//   (b) merely rendering does NOT mutate stored enableAutoLogin (no silent
//       persist before sign-in / no vault-restore-gate flip);
//   (c) an OSK-Enter login now persists and survives relaunch;
//   (d) the nudge does NOT fight a deliberate uncheck (user can still opt out).
import { connectPage, evalExpr, sleep } from '../dpad-nav-test/cdp.mjs';

const URL_ = process.env.JELLYFIN_URL.replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

// The nudge IIFE — byte-for-byte the string that will be injected by the shell
// seed script. Kept here as the single source for the test; the shell entry
// must match this logic.
const NUDGE = `try{(function(){
  if(localStorage.getItem("jellyfin.shell.rememberMeDefaultDisabled")==="1")return;
  window.__shellRememberMeChecks=0;
  var bound=new WeakSet(),userOff=new WeakSet();
  function nudge(){try{
    var c=document.querySelector(".manualLoginForm .chkRememberLogin")||document.querySelector(".chkRememberLogin");
    if(!c)return;
    if(!bound.has(c)){bound.add(c);c.addEventListener("change",function(){if(!c.checked){userOff.add(c);}else{userOff["delete"](c);}},false);}
    if(userOff.has(c))return;
    if(!c.checked){c.checked=true;window.__shellRememberMeChecks++;}
  }catch(_){}}
  try{setInterval(nudge,300);}catch(_){}
  try{document.addEventListener("DOMContentLoaded",nudge,false);}catch(_){}
  nudge();
})();}catch(_){}`;

const cdp = await connectPage();
await cdp.send('Page.enable');
// Inject the nudge on EVERY new document, exactly like a seed script that runs
// before jellyfin-web's scripts.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NUDGE });

async function nav(u) { await cdp.send('Page.navigate', { url: u }); await sleep(2000); }
async function waitFor(expr, ms = 25000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evalExpr(cdp, expr).catch(() => false)) return true; await sleep(400); }
  throw new Error('timeout: ' + label);
}
async function openForm() {
  await waitFor(`!!(document.querySelector('.manualLoginForm input#txtManualName')||document.querySelector('.btnManual'))`, 25000, 'login ui');
  const vis = await evalExpr(cdp, `(()=>{const f=document.querySelector('.manualLoginForm');return !!f&&!!f.offsetParent;})()`);
  if (!vis) { await evalExpr(cdp, `document.querySelector('.btnManual')?.click(); true`); await sleep(1200); }
  await waitFor(`!!document.querySelector('.chkRememberLogin')`, 8000, 'checkbox');
}
async function fill() {
  await evalExpr(cdp, `(()=>{const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    set(document.querySelector('#txtManualName'),${JSON.stringify(USER)});set(document.querySelector('#txtManualPassword'),${JSON.stringify(PASS)});return true;})()`);
}
async function persistence() {
  return evalExpr(cdp, `(()=>{let t=null;try{const c=JSON.parse(localStorage.getItem('jellyfin_credentials')||'null');if(c&&c.Servers)t=c.Servers.filter(s=>s.AccessToken).length;}catch(e){}
    return {hash:location.hash,eal:localStorage.getItem('enableAutoLogin'),tokens:t,checks:window.__shellRememberMeChecks,
      boxChecked:(document.querySelector('.chkRememberLogin')||{}).checked};})()`);
}

// 1) Create the sticky-false state: button login, unchecked.
await nav(URL_ + '/web/index.html');
await evalExpr(cdp, `localStorage.clear();sessionStorage.clear();true`);
await nav(URL_ + '/web/index.html');
await openForm();
await fill();
await evalExpr(cdp, `(()=>{const c=document.querySelector('.chkRememberLogin');if(c.checked)c.click();return c.checked;})()`);
await evalExpr(cdp, `document.querySelector('.manualLoginForm').requestSubmit();true`);
await waitFor(`location.hash.indexOf('home')!==-1`, 25000, 'home');
console.log('setup: after unchecked login, eal =', await evalExpr(cdp, `localStorage.getItem('enableAutoLogin')`));

// 2) Relaunch into the login page (sticky-false) and let the nudge run.
await evalExpr(cdp, `sessionStorage.clear();true`);
await nav(URL_ + '/web/index.html');
await openForm();
await sleep(1200); // let the poller fire
const rendered = await persistence();
console.log('A rendered (sticky-false + nudge):', JSON.stringify(rendered));

// 3) OSK-Enter login WITHOUT touching the checkbox; then relaunch.
await fill();
await evalExpr(cdp, `document.querySelector('#txtManualPassword').focus();true`);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(6000);
if (await evalExpr(cdp, `location.hash.indexOf('login')!==-1`)) await evalExpr(cdp, `document.querySelector('.manualLoginForm').requestSubmit();true`);
await waitFor(`location.hash.indexOf('home')!==-1`, 25000, 'home2');
const afterLogin = await persistence();
console.log('B after Enter-login (nudged):     ', JSON.stringify(afterLogin));
await evalExpr(cdp, `sessionStorage.clear();true`);
await nav(URL_ + '/web/index.html');
await waitFor(`location.hash.indexOf('home')!==-1||document.querySelector('.manualLoginForm')||document.querySelector('.btnManual')`, 30000, 'settle');
await sleep(2500);
const afterRelaunch = await persistence();
console.log('C after relaunch:                 ', JSON.stringify(afterRelaunch));

// 4) Deliberate-uncheck still works: fresh login, uncheck after nudge, submit, relaunch -> signed out.
await nav(URL_ + '/web/index.html');
await evalExpr(cdp, `localStorage.clear();sessionStorage.clear();true`);
await nav(URL_ + '/web/index.html');
await openForm(); await sleep(1000);
await fill();
const beforeUncheck = await evalExpr(cdp, `(document.querySelector('.chkRememberLogin')||{}).checked`);
await evalExpr(cdp, `(()=>{const c=document.querySelector('.chkRememberLogin');if(c.checked)c.click();return c.checked;})()`);
await sleep(1000); // ensure the nudge does NOT re-check it (same element instance)
const afterUncheck = await evalExpr(cdp, `(document.querySelector('.chkRememberLogin')||{}).checked`);
await evalExpr(cdp, `document.querySelector('.manualLoginForm').requestSubmit();true`);
await waitFor(`location.hash.indexOf('home')!==-1`, 25000, 'home3');
await evalExpr(cdp, `sessionStorage.clear();true`);
await nav(URL_ + '/web/index.html');
await waitFor(`location.hash.indexOf('home')!==-1||document.querySelector('.manualLoginForm')||document.querySelector('.btnManual')`, 30000, 'settle2');
await sleep(2500);
const optOut = await persistence();
console.log('D opt-out: box before=', beforeUncheck, 'after uncheck=', afterUncheck, '-> relaunch', JSON.stringify(optOut));

// NB: a signed-out relaunch lands at `#/login?serverid=…&url=%2Fhome` — the
// `url=%2Fhome` query contains "home", so a naive hash.indexOf('home') gives a
// false positive. Discriminate on the hash PREFIX (route) + token count.
const atHome = (h) => /^#\/home/.test(h);
const atLogin = (h) => /^#\/login/.test(h);
console.log('\nVERDICT:');
console.log('  (a) box rendered checked despite sticky-false:', rendered.boxChecked === true, '(checks=' + rendered.checks + ')');
console.log('  (b) render did NOT mutate stored flag:        ', rendered.eal === 'false');
console.log('  (c) Enter-login persisted across relaunch:    ', atHome(afterRelaunch.hash) && afterRelaunch.tokens >= 1);
console.log('  (d) deliberate uncheck still opts out:        ', afterUncheck === false && atLogin(optOut.hash) && optOut.tokens === 0);
process.exit(0);
