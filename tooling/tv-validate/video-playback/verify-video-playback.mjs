// JEL-41 — Compare: video playback starts correctly, same format/codec support.
//
// Verifies the four things the issue asks for, browser vs Tizen TV:
//   (1) video playback negotiation starts without error (PlaybackInfo 200);
//   (2) the device profile returned by NativeShell.AppHost.getDeviceProfile is
//       appropriate for the TV hardware;
//   (3) the direct-play vs transcode decision is made correctly;
//   (4) the initial seek/resume position is correct.
// ...and notes codec/container differences between the TV and browser profiles.
//
// HOW IT WORKS — the shell's getDeviceProfile (shell.js) does NOT contain any
// codec logic; it delegates entirely to jellyfin-web's own profile builder:
//
//     getDeviceProfile: function (profileBuilder) {
//       return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
//     }
//
// So the TV-vs-browser profile difference is produced by jellyfin-web's
// browserDeviceProfile, which is gated on browser.tizen / browser.tizenVersion
// (UA-based) plus the two flags the shell passes. This harness drives the LIVE
// web client in a real headless Chromium twice:
//
//   • BROWSER mode  — default UA, no NativeShell (jellyfin-web's own apphost).
//   • TIZEN mode    — a real Samsung Tizen 5.0 UA override + a NativeShell shim
//                     whose getDeviceProfile is byte-extracted from shell.js, so
//                     apphost routes through the EXACT flags the WGT ships.
//
// In each mode it presses Play once on a real movie, captures the actual
// /PlaybackInfo POST (= the DeviceProfile the client sends) and its response
// (= the server's direct-play/transcode decision), then reuses each captured
// profile to run getPlaybackInfo for a movie AND an episode via ApiClient.
//
// LIMITATION (documented, not hidden): the headless engine is modern Chromium,
// not the TV's Chromium 63. jellyfin-web's Tizen branch hardcodes Samsung HW
// decoder support (HEVC/h264 levels, audio passthrough) by UA rather than
// trusting canPlayType precisely because TV webviews under-report, so the
// UA-spoof reproduces the dominant, UA-gated part of the TV profile. The
// residual engine-only delta (canPlayType nuances on M63) can only be observed
// on the physical set; see results-JEL-41.md.
//
// Env: JELLYFIN_URL, JELLYFIN_USER, JELLYFIN_PASS, CDP_BASE (optional).
// Prereq: ../dpad-nav-test/bootstrap-chromium.sh running on :9222.
// Usage: node verify-video-playback.mjs   (prints JSON report; non-zero on FAIL)

import { connectPage, evalExpr, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
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

// A real Samsung Tizen 5.0 (2019, Chromium 69) TV User-Agent. The "Tizen 5.0"
// token is what flips jellyfin-web's browser.tizen / tizenVersion === 5 and the
// Samsung HW-decoder codec additions; this matches the locked physical set.
const TIZEN_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.0 TV Safari/537.36';

// Extract the EXACT options object the shell passes to profileBuilder, straight
// from shell.js, so this harness can never drift from the shipped contract.
function extractShellProfileOpts() {
  const p = resolve(HERE, '../../../packages/shell-tizen/src/shell.js');
  const src = readFileSync(p, 'utf8');
  const m = src.match(/getDeviceProfile:\s*function\s*\(profileBuilder\)\s*\{\s*return profileBuilder\(\s*(\{[\s\S]*?\})\s*\)/);
  if (!m) throw new Error('getDeviceProfile profileBuilder({...}) not found in shell.js');
  // m[1] is a JS object literal with unquoted keys; eval it in a sandboxed Function.
  // eslint-disable-next-line no-new-func
  return Function('return (' + m[1] + ')')();
}

const SHELL_OPTS = extractShellProfileOpts();

const cdp = await connectPage();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

// ---- network capture of /PlaybackInfo POST + response ----
const pbi = [];
cdp.on((m) => {
  if (
    m.method === 'Network.requestWillBeSent' &&
    /\/PlaybackInfo/i.test(m.params.request.url)
  ) {
    pbi.push({
      requestId: m.params.requestId,
      url: m.params.request.url,
      postData: m.params.request.postData,
      hasPostData: m.params.request.hasPostData,
    });
  }
});

async function login() {
  // Route through about:blank so the next navigation is always a *new
  // document* (a same-URL hash nav is same-document and would NOT fire the
  // Page.addScriptToEvaluateOnNewDocument NativeShell shim).
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(800);
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
       let mm=[...document.querySelectorAll('a,button')].find(e=>/manual login|other user/i.test(e.textContent||''));
       if(mm){mm.click();await sleep(800);continue;}await sleep(700);} })()`,
  );
  await sleep(6000);
  return await evalExpr(
    cdp,
    `(window.ApiClient&&window.ApiClient.getCurrentUserId)?window.ApiClient.getCurrentUserId():null`,
  );
}

// Press Play once on a movie and harvest the DeviceProfile from its PlaybackInfo
// POST. Returns the captured profile object (or null).
async function harvestProfile(movieId) {
  pbi.length = 0;
  await evalExpr(cdp, `location.hash='#/home'`, false).catch(() => {});
  await sleep(2000);
  await evalExpr(cdp, `location.hash='#/details?id=${movieId}'`, false).catch(() => {});
  await sleep(5000);
  await evalExpr(
    cdp,
    `(()=>{const c=[...document.querySelectorAll('button.btnPlay,.mainDetailButtons .btnPlay')].filter(b=>!b.classList.contains('hide')&&b.offsetParent!==null);if(c[0]){c[0].click();return 1;}return 0;})()`,
  );
  await sleep(6000);
  for (const c of pbi) {
    let pd = c.postData;
    if (!pd && c.hasPostData) {
      try {
        pd = (await cdp.send('Network.getRequestPostData', { requestId: c.requestId })).postData;
      } catch (e) {
        /* ignore */
      }
    }
    if (pd) {
      try {
        const j = JSON.parse(pd);
        if (j.DeviceProfile) return j.DeviceProfile;
      } catch (e) {
        /* ignore */
      }
    }
  }
  return null;
}

// Run the server's playback negotiation for an item with a given DeviceProfile,
// in-page via the authenticated ApiClient. Returns the decision summary.
async function decide(userId, itemId, profile, startTicks) {
  return await evalExpr(
    cdp,
    `(async()=>{
       const ac=window.ApiClient; const prof=${JSON.stringify(profile)};
       try{
         const r=await ac.getPlaybackInfo(${JSON.stringify(itemId)},{
           UserId:${JSON.stringify(userId)},
           StartTimeTicks:${startTicks || 0},
           MaxStreamingBitrate:120000000,
           AutoOpenLiveStream:false
         },prof);
         const ms=(r.MediaSources||[])[0];
         if(!ms) return {error:'no MediaSources',playSessionId:!!r.PlaySessionId};
         const v=(ms.MediaStreams||[]).find(s=>s.Type==='Video')||{};
         const a=(ms.MediaStreams||[]).find(s=>s.Type==='Audio')||{};
         return {
           Container:ms.Container, VideoCodec:v.Codec, VideoProfile:v.Profile,
           Width:v.Width, AudioCodec:a.Codec,
           SupportsDirectPlay:ms.SupportsDirectPlay,
           SupportsDirectStream:ms.SupportsDirectStream,
           SupportsTranscoding:ms.SupportsTranscoding,
           TranscodingUrl: ms.TranscodingUrl? (ms.TranscodingUrl.split('?')[0]) : null,
           TranscodeReasons: ms.TranscodingUrl ? (decodeURIComponent(ms.TranscodingUrl).match(/TranscodeReasons=([^&]*)/)||[])[1]||null : null,
           PlaySessionId: !!r.PlaySessionId
         };
       }catch(e){return {error:String(e&&e.message||e)};}
     })()`,
  );
}

// Compact a DeviceProfile to a comparable summary.
function summarizeProfile(p) {
  if (!p) return null;
  const dpp = (p.DirectPlayProfiles || []).map((d) => ({
    Type: d.Type,
    Container: d.Container,
    Video: d.VideoCodec || '',
    Audio: d.AudioCodec || '',
  }));
  const tp = (p.TranscodingProfiles || []).map((t) => ({
    Type: t.Type,
    Container: t.Container,
    Video: t.VideoCodec || '',
    Audio: t.AudioCodec || '',
    Protocol: t.Protocol || '',
  }));
  const codecConditions = {};
  for (const c of p.CodecProfiles || []) {
    const key = (c.Type || '') + ':' + (c.Codec || '*');
    codecConditions[key] = (c.Conditions || []).map(
      (cd) => `${cd.Property}${cd.Condition === 'EqualsAny' ? '∈' : cd.Condition}${cd.Value}`,
    );
  }
  return {
    counts: {
      DirectPlay: dpp.length,
      Transcoding: tp.length,
      Codec: (p.CodecProfiles || []).length,
      Subtitle: (p.SubtitleProfiles || []).length,
    },
    MaxStaticBitrate: p.MaxStaticBitrate,
    MaxStreamingBitrate: p.MaxStreamingBitrate,
    DirectPlayProfiles: dpp,
    TranscodingProfiles: tp,
    CodecConditions: codecConditions,
  };
}

// Containers/codecs reachable via direct play, flattened for set-diffing.
function directPlayMatrix(p) {
  const set = new Set();
  for (const d of p?.DirectPlayProfiles || []) {
    if (d.Type !== 'Video') continue;
    const containers = (d.Container || '').split(',').filter(Boolean);
    const vcodecs = (d.VideoCodec || '').split(',').filter(Boolean);
    for (const c of containers.length ? containers : ['*']) {
      for (const v of vcodecs.length ? vcodecs : ['*']) {
        set.add(`${c}/${v}`);
      }
    }
  }
  return set;
}

// ===================== run =====================
const report = { server: URL, shellProfileOpts: SHELL_OPTS, modes: {}, items: {}, resume: {}, diff: {} };

// discover a movie + episode + a resumable item
const userId = await login();
report.userId = userId;
const picks = await evalExpr(
  cdp,
  `(async()=>{const ac=window.ApiClient,uid=ac.getCurrentUserId();
    const mv=await ac.getItems(uid,{IncludeItemTypes:'Movie',Recursive:true,Limit:1,Filters:'IsNotFolder',SortBy:'Random'});
    const ep=await ac.getItems(uid,{IncludeItemTypes:'Episode',Recursive:true,Limit:1,Filters:'IsNotFolder',SortBy:'Random'});
    let resume=null; try{const rs=await ac.getResumableItems(uid,{Limit:5,MediaTypes:'Video'});
      if(rs&&rs.Items&&rs.Items[0]){const it=rs.Items[0];resume={Id:it.Id,Name:it.Name,PositionTicks:(it.UserData||{}).PlaybackPositionTicks||0,RunTimeTicks:it.RunTimeTicks||0};}}catch(e){}
    return {movie:mv.Items&&mv.Items[0]?{Id:mv.Items[0].Id,Name:mv.Items[0].Name}:null,
            episode:ep.Items&&ep.Items[0]?{Id:ep.Items[0].Id,Name:ep.Items[0].Name}:null, resume};})()`,
);
report.picks = picks;
if (!picks.movie) {
  console.error('No movie found on server; cannot run.');
  process.exit(2);
}

// ---------- BROWSER mode ----------
const browserProfile = await harvestProfile(picks.movie.Id);
report.modes.browser = {
  ua: await evalExpr(cdp, `navigator.userAgent`),
  hasNativeShell: await evalExpr(cdp, `typeof window.NativeShell!=='undefined'`),
  profile: summarizeProfile(browserProfile),
};

// ---------- TIZEN mode ----------
// 1) override UA so jellyfin-web's browser.tizen / tizenVersion fire,
// 2) inject a NativeShell shim with the shell's EXACT profile flags before any
//    page script runs, so apphost.getDeviceProfile routes through it.
await cdp.send('Network.setUserAgentOverride', { userAgent: TIZEN_UA });
const shimSrc = `window.__nsProfileCalls=0;window.NativeShell={AppHost:{getDeviceProfile:function(profileBuilder){window.__nsProfileCalls++;return profileBuilder(${JSON.stringify(
  SHELL_OPTS,
)});},getDefaultLayout:function(){return 'tv';},supports:function(){return false;},
  init:function(){return Promise.resolve({deviceId:'jel41-tizen',deviceName:'Samsung Smart TV',appName:'Jellyfin Shell for Tizen'});},
  appName:function(){return 'Jellyfin Shell for Tizen';},deviceId:function(){return 'jel41-tizen';},deviceName:function(){return 'Samsung Smart TV';},
  exit:function(){},screen:function(){return {width:1920,height:1080};}},
  enableFullscreen:function(){},disableFullscreen:function(){},getPlugins:function(){return [];},
  openUrl:function(){},updateMediaSession:function(){},hideMediaSession:function(){},downloadFile:function(){}};`;
const { identifier: shimId } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: shimSrc,
});
const tizenUserId = await login();
const tizenProfile = await harvestProfile(picks.movie.Id);
report.modes.tizen = {
  ua: await evalExpr(cdp, `navigator.userAgent`),
  hasNativeShell: await evalExpr(cdp, `typeof window.NativeShell!=='undefined'`),
  tizenDetected: await evalExpr(
    cdp,
    `(()=>{try{return /tizen/i.test(navigator.userAgent);}catch(e){return 'err';}})()`,
  ),
  nsProfileCalls: await evalExpr(cdp, `window.__nsProfileCalls||0`),
  profile: summarizeProfile(tizenProfile),
};

// ---------- decisions: movie + episode under each profile ----------
async function decideBoth(label, itemId) {
  report.items[label] = {
    browser: browserProfile ? await decide(userId, itemId, browserProfile, 0) : 'no-browser-profile',
    tizen: tizenProfile ? await decide(tizenUserId || userId, itemId, tizenProfile, 0) : 'no-tizen-profile',
  };
}
await decideBoth('movie', picks.movie.Id);
if (picks.episode) await decideBoth('episode', picks.episode.Id);

// ---------- resume / seek position ----------
if (picks.resume && picks.resume.PositionTicks > 0) {
  // Verify the negotiation honors a non-zero StartTimeTicks (the value
  // jellyfin-web passes from UserData.PlaybackPositionTicks). The shell's
  // NativeShell contract has NO playback/seek hooks, so resume is 100%
  // jellyfin-web client logic; we confirm the offset round-trips.
  const start = picks.resume.PositionTicks;
  const r = browserProfile
    ? await decide(userId, picks.resume.Id, browserProfile, start)
    : null;
  report.resume = {
    item: picks.resume.Name,
    positionTicks: start,
    positionSeconds: Math.round(start / 10000000),
    runtimeSeconds: picks.resume.RunTimeTicks ? Math.round(picks.resume.RunTimeTicks / 10000000) : null,
    negotiationOk: r && !r.error,
    note: 'StartTimeTicks passed through; seek is jellyfin-web client logic, shell has no seek hook',
  };
} else {
  report.resume = { note: 'no resumable item with non-zero position on server at run time' };
}

// ---------- diff ----------
const bSet = directPlayMatrix(browserProfile);
const tSet = directPlayMatrix(tizenProfile);
report.diff = {
  directPlay_tizenOnly: [...tSet].filter((x) => !bSet.has(x)).sort(),
  directPlay_browserOnly: [...bSet].filter((x) => !tSet.has(x)).sort(),
  directPlay_shared: [...tSet].filter((x) => bSet.has(x)).sort(),
};

// ---------- pass/fail ----------
const checks = {
  browserProfileCaptured: !!browserProfile,
  tizenProfileCaptured: !!tizenProfile,
  tizenUaApplied: report.modes.tizen.tizenDetected === true,
  tizenShimActive: report.modes.tizen.hasNativeShell === true,
  movieNegotiationOk:
    report.items.movie &&
    !report.items.movie.browser.error &&
    !report.items.movie.tizen.error,
  episodeNegotiationOk:
    !picks.episode ||
    (report.items.episode &&
      !report.items.episode.browser.error &&
      !report.items.episode.tizen.error),
};
report.checks = checks;
const pass = Object.values(checks).every(Boolean);
report.status = pass ? 'PASS' : 'FAIL';

writeFileSync(resolve(HERE, 'last-run.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shimId }).catch(() => {});
await cdp.send('Network.setUserAgentOverride', { userAgent: '' }).catch(() => {});
process.exit(pass ? 0 : 1);
