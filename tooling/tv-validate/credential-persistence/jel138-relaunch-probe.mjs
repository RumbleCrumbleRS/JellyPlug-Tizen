// JEL-138 part 2: does a relaunch keep the session, as a function of
// enableAutoLogin? Simulates TV app relaunch = sessionStorage cleared + fresh
// top-level navigation (localStorage persists, JEL-116).
import { connectPage, evalExpr, sleep } from '../dpad-nav-test/cdp.mjs';

const URL_ = process.env.JELLYFIN_URL.replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

const cdp = await connectPage();
await cdp.send('Page.enable');

async function nav(url) { await cdp.send('Page.navigate', { url }); await sleep(2000); }
async function waitFor(expr, ms = 25000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalExpr(cdp, expr).catch(() => false)) return true;
    await sleep(400);
  }
  return false;
}
async function state(label) {
  const r = await evalExpr(cdp, `(()=>{
    let tokens=null; try{const c=JSON.parse(localStorage.getItem('jellyfin_credentials')||'null');
      if(c&&c.Servers) tokens=c.Servers.filter(s=>s.AccessToken).length;}catch(e){}
    return {hash:location.hash, eal:localStorage.getItem('enableAutoLogin'), tokens,
      loginFormVisible: !!(document.querySelector('.manualLoginForm') && document.querySelector('.manualLoginForm').offsetParent),
      anyLoginPage: location.hash.indexOf('login')!==-1 || location.hash.indexOf('selectserver')!==-1};
  })()`);
  console.log(label, JSON.stringify(r));
  return r;
}

async function login(remember) {
  await nav(URL_ + '/web/index.html');
  await evalExpr(cdp, `localStorage.clear(); sessionStorage.clear(); true`);
  await nav(URL_ + '/web/index.html');
  await waitFor(`!!(document.querySelector('.manualLoginForm input#txtManualName') || document.querySelector('.btnManual'))`, 25000, 'login ui');
  const vis = await evalExpr(cdp, `(()=>{const f=document.querySelector('.manualLoginForm');return !!f&&!!f.offsetParent;})()`);
  if (!vis) { await evalExpr(cdp, `document.querySelector('.btnManual')?.click(); true`); await sleep(1200); }
  await evalExpr(cdp, `(()=>{
    const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    set(document.querySelector('#txtManualName'), ${JSON.stringify(USER)});
    set(document.querySelector('#txtManualPassword'), ${JSON.stringify(PASS)});
    const c=document.querySelector('.chkRememberLogin');
    if(c.checked!==${remember}) c.click();
    return c.checked;
  })()`).then(c => console.log('  checkbox at submit:', c));
  await evalExpr(cdp, `document.querySelector('.manualLoginForm').requestSubmit(); true`);
  const ok = await waitFor(`location.hash.indexOf('home')!==-1`, 25000, 'home');
  if (!ok) throw new Error('login did not reach home');
  await sleep(2000);
}

async function relaunch(label) {
  // TV app relaunch: sessionStorage gone, fresh top-level load
  await evalExpr(cdp, `sessionStorage.clear(); true`);
  await nav(URL_ + '/web/index.html');
  // settle: either home (auto-login) or login page
  await waitFor(`location.hash.indexOf('home')!==-1 || document.querySelector('.manualLoginForm') || document.querySelector('.btnManual')`, 30000, 'settle');
  await sleep(2500);
  return state(label);
}

console.log('--- A: login with Remember me UNCHECKED, then relaunch ---');
await login(false);
await state('A post-login      :');
const a = await relaunch('A after relaunch  :');

console.log('--- B: login with Remember me CHECKED, then relaunch ---');
await login(true);
await state('B post-login      :');
const b = await relaunch('B after relaunch  :');

console.log('\nVERDICT:');
console.log('  unchecked: relaunch kept session =', a.hash.indexOf('home') !== -1, ' tokens after relaunch =', a.tokens);
console.log('  checked:   relaunch kept session =', b.hash.indexOf('home') !== -1, ' tokens after relaunch =', b.tokens);
process.exit(0);
