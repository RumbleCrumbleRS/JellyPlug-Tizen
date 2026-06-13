import { connectPage, evalExpr, sleep } from '../dpad-nav-test/cdp.mjs';
const URL_ = process.env.JELLYFIN_URL.replace(/\/$/, '');
const cdp = await connectPage();
await cdp.send('Page.enable');
async function nav(u){await cdp.send('Page.navigate',{url:u});await sleep(2000);}
await nav(URL_ + '/web/index.html');
await evalExpr(cdp, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem('layout','tv'); true`);
await nav(URL_ + '/web/index.html');
let t0=Date.now(), r=null;
while(Date.now()-t0<25000){
  r = await evalExpr(cdp, `(()=>{
    const f=document.querySelector('.manualLoginForm');
    if(!f) return null;
    const c=document.querySelector('.chkRememberLogin');
    const lbl=c && c.closest('label');
    const cs=lbl?getComputedStyle(lbl):null;
    const rect=lbl?lbl.getBoundingClientRect():null;
    return {layout:localStorage.getItem('layout'), formVisible:!!f.offsetParent,
      chkFound:!!c, checked:c?c.checked:null,
      lblVisible: !!(lbl&&lbl.offsetParent), display:cs?cs.display:null,
      rect: rect?{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}:null,
      lblText: lbl?lbl.textContent.trim().slice(0,40):null};
  })()`).catch(()=>null);
  if(r && r.formVisible) break;
  if(r && !r.formVisible){ await evalExpr(cdp,`document.querySelector('.btnManual')?.click();true`).catch(()=>{}); }
  await sleep(600);
}
console.log('TV-layout login form:', JSON.stringify(r, null, 1));
process.exit(0);
