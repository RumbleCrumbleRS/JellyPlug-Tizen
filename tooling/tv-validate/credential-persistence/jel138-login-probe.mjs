// JEL-138: discriminate Enter-vs-button from checkbox-state for credential
// persistence. Drives real jellyfin-web served by the test server in headless
// Chrome via CDP. No shell involved — this probes jellyfin-web's own behavior.
//
// S1 enter-checked    : fresh storage, Remember me checked (default), submit via
//                       real Enter keystroke in the password field.
// S2 button-unchecked : fresh storage, uncheck Remember me, click the Sign In button.
// S3 sticky-enter     : DO NOT clear storage after S2; reload the login page and
//                       submit via Enter without touching the checkbox (user's loop).
//
// Expectation if hypothesis holds: S1 persists token, S2 does not, S3 renders the
// checkbox unchecked and does not persist.
import { connectPage, evalExpr, sleep } from '../dpad-nav-test/cdp.mjs';

const URL_ = process.env.JELLYFIN_URL.replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
const LOGIN_URL = URL_ + '/web/index.html#/login.html';

const cdp = await connectPage();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

async function nav(url) {
  await cdp.send('Page.navigate', { url });
  await sleep(1500);
}

async function waitFor(expr, ms = 20000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalExpr(cdp, expr).catch(() => false)) return true;
    await sleep(400);
  }
  throw new Error('timeout waiting for ' + label);
}

async function openLoginForm() {
  await nav(LOGIN_URL);
  // wait for either the manual form or the user picker w/ manual button
  await waitFor(
    `!!(document.querySelector('.manualLoginForm input#txtManualName') || document.querySelector('.btnManual'))`,
    25000, 'login form'
  );
  const manualVisible = await evalExpr(cdp,
    `(()=>{const f=document.querySelector('.manualLoginForm');return !!f && !f.classList.contains('hide') && f.offsetParent!==null;})()`);
  if (!manualVisible) {
    await evalExpr(cdp, `document.querySelector('.btnManual')?.click(); true`);
    await waitFor(
      `(()=>{const f=document.querySelector('.manualLoginForm');return !!f && f.offsetParent!==null;})()`,
      8000, 'manual form visible'
    );
  }
}

async function fillCreds() {
  await evalExpr(cdp, `(()=>{
    const u=document.querySelector('#txtManualName'), p=document.querySelector('#txtManualPassword');
    const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    set(u, ${JSON.stringify(USER)}); set(p, ${JSON.stringify(PASS)});
    return true;
  })()`);
}

async function checkboxState() {
  return evalExpr(cdp, `(()=>{const c=document.querySelector('.chkRememberLogin');return c?{found:true,checked:c.checked}:{found:false};})()`);
}

async function setCheckbox(want) {
  return evalExpr(cdp, `(()=>{const c=document.querySelector('.chkRememberLogin');if(!c)return 'missing';
    if(c.checked!==${want}){c.click();} return c.checked;})()`);
}

async function pressEnterInPassword() {
  await evalExpr(cdp, `document.querySelector('#txtManualPassword').focus(); document.activeElement.id`);
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  // fallback: if the synthetic key did not trigger implicit submission within 6s,
  // use requestSubmit() — the spec equivalent (fires the same submit event/handler)
  await sleep(6000);
  const stillLogin = await evalExpr(cdp, `location.hash.indexOf('login')!==-1`);
  if (stillLogin) {
    console.log('  (CDP Enter did not submit; falling back to form.requestSubmit())');
    await evalExpr(cdp, `document.querySelector('.manualLoginForm').requestSubmit(); true`);
  }
}

async function clickSubmit() {
  await evalExpr(cdp, `(()=>{
    const b=document.querySelector('.manualLoginForm button[type=submit], .manualLoginForm .btnSubmit');
    b.click(); return b.textContent.trim();
  })()`);
}

async function waitAuthed() {
  await waitFor(`location.hash.indexOf('login')===-1 && location.hash.length>2`, 20000, 'navigated away from login');
}

async function readPersistence(label) {
  const r = await evalExpr(cdp, `(()=>{
    const eal = localStorage.getItem('enableAutoLogin');
    let tokens = null, servers = null;
    try { const c = JSON.parse(localStorage.getItem('jellyfin_credentials')||'null');
      if (c && c.Servers) { servers = c.Servers.length; tokens = c.Servers.filter(s=>s.AccessToken).length; }
    } catch(e) {}
    return { enableAutoLogin: eal, servers, serversWithToken: tokens, hash: location.hash };
  })()`);
  console.log(label, JSON.stringify(r));
  return r;
}

async function clearStorage() {
  await nav(URL_ + '/web/index.html');
  await evalExpr(cdp, `localStorage.clear(); sessionStorage.clear(); true`);
}

const out = {};

// ---- S1: Enter key, Remember me checked (fresh default) ----
await clearStorage();
await openLoginForm();
await fillCreds();
let cb = await checkboxState();
console.log('S1 checkbox initial:', JSON.stringify(cb));
if (cb.found && !cb.checked) await setCheckbox(true);
await pressEnterInPassword();
await waitAuthed();
await sleep(1500);
out.S1 = await readPersistence('S1 enter-checked   ->');

// ---- S2: button click, Remember me UNchecked ----
await clearStorage();
await openLoginForm();
await fillCreds();
await setCheckbox(false);
cb = await checkboxState();
console.log('S2 checkbox at submit:', JSON.stringify(cb));
await clickSubmit();
await waitAuthed();
await sleep(1500);
out.S2 = await readPersistence('S2 button-unchecked->');

// ---- S3: sticky replay — reload login, DO NOT touch checkbox, Enter ----
await openLoginForm();           // no clearStorage: enableAutoLogin should be sticky "false"
cb = await checkboxState();
console.log('S3 checkbox as rendered (sticky):', JSON.stringify(cb));
out.S3_renderedChecked = cb.checked;
await fillCreds();
await pressEnterInPassword();
await waitAuthed();
await sleep(1500);
out.S3 = await readPersistence('S3 sticky-enter    ->');

// ---- S4: heal check — Enter again but RE-CHECK the box first ----
await openLoginForm();
await setCheckbox(true);
await fillCreds();
await pressEnterInPassword();
await waitAuthed();
await sleep(1500);
out.S4 = await readPersistence('S4 enter-rechecked ->');

console.log('\nVERDICT:');
console.log('  Enter+checked persists:    ', out.S1.serversWithToken >= 1);
console.log('  Button+unchecked persists: ', out.S2.serversWithToken >= 1);
console.log('  Sticky render unchecked:   ', out.S3_renderedChecked === false);
console.log('  Sticky Enter persists:     ', out.S3.serversWithToken >= 1);
console.log('  Re-checked Enter persists: ', out.S4.serversWithToken >= 1);
process.exit(0);
