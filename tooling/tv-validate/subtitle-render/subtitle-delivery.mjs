// JEL-44 — Subtitle delivery-method matrix: shell TV profile vs browser profile.
//
// Authoritative, browser-free check: ask the LIVE server (via /Items/{id}/
// PlaybackInfo) what DeliveryMethod it assigns each subtitle stream under each
// device profile. This decides what the *server* sends to the TV vs the browser
// for every subtitle codec family before any client rendering happens.
//
// The shell's getDeviceProfile() (packages/shell-tizen/src/shell.js) calls
// jellyfin-web's profileBuilder with { enableSsaRender: true }. That flag is the
// ONLY subtitle lever the shell owns: with it ON the server delivers ASS/SSA as
// External (client libass renders), with it OFF the server burns ASS into the
// video (Encode/transcode). Bitmap subs (PGS/DVDSUB) are always Encode. Text
// subs (subrip/srt) are always External. This harness proves all of that against
// real media.
//
// Env: JELLYFIN_URL, JELLYFIN_USER, JELLYFIN_PASS.
// Usage: node subtitle-delivery.mjs        (prints a table, writes JSON, exits 1 on surprise)

import { writeFileSync } from 'node:fs';

const U = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;
if (!U || !USER || !PASS) {
  console.error('Set JELLYFIN_URL / JELLYFIN_USER / JELLYFIN_PASS');
  process.exit(2);
}
const AUTH0 = 'MediaBrowser Client="JEL44", Device="sandbox", DeviceId="jel44-delivery", Version="1.0.0"';

async function auth() {
  const r = await fetch(`${U}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { Authorization: AUTH0, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: USER, Pw: PASS }),
  });
  if (!r.ok) throw new Error('auth ' + r.status);
  const j = await r.json();
  return { token: j.AccessToken, uid: j.User.Id };
}
const authHdr = (t) => `${AUTH0}, Token="${t}"`;

// Subtitle profiles. enableSsaRender ON => ass/ssa are External (client libass).
// OFF => ass/ssa removed from External => server must Encode (burn-in).
const fmts = (list) => list.map((f) => ({ Format: f, Method: 'External' }));
const SSA_ON = fmts(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'subviewer', 'ttml', 'smi', 'sami']);
const SSA_OFF = fmts(['srt', 'subrip', 'vtt', 'subviewer', 'ttml', 'smi', 'sami']);
function profile(name, subs) {
  return {
    Name: name,
    MaxStreamingBitrate: 120000000,
    MaxStaticBitrate: 100000000,
    DirectPlayProfiles: [{ Container: 'mp4,m4v,mkv,webm', Type: 'Video' }],
    TranscodingProfiles: [
      { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: subs,
  };
}
const SHELL_TV = profile('Jellyfin Shell for Tizen (enableSsaRender:true)', SSA_ON);
const NO_SSA = profile('Hypothetical (enableSsaRender:false)', SSA_OFF);

async function items(t, uid, qs) {
  const r = await fetch(`${U}/Users/${uid}/Items?${qs}`, { headers: { Authorization: authHdr(t) } });
  if (!r.ok) throw new Error('items ' + r.status);
  return (await r.json()).Items || [];
}
async function playbackInfo(t, uid, id, prof) {
  const r = await fetch(`${U}/Items/${id}/PlaybackInfo?UserId=${uid}`, {
    method: 'POST',
    headers: { Authorization: authHdr(t), 'Content-Type': 'application/json' },
    body: JSON.stringify({ UserId: uid, DeviceProfile: prof, AutoOpenLiveStream: false, MaxStreamingBitrate: 120000000 }),
  });
  if (!r.ok) throw new Error('PlaybackInfo ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
const subStreams = (src) => (src.MediaStreams || []).filter((m) => m.Type === 'Subtitle');

// Discover one representative item per codec so the harness never rots on a
// hard-coded id. Scan up to 500 items with subtitles.
async function discover(t, uid) {
  const want = ['subrip', 'ass', 'pgssub', 'dvdsub'];
  const found = {};
  const list = await items(t, uid, 'Recursive=true&IncludeItemTypes=Movie,Episode&Fields=MediaStreams&Limit=500');
  for (const it of list) {
    for (const su of (it.MediaStreams || []).filter((m) => m.Type === 'Subtitle')) {
      const c = (su.Codec || '').toLowerCase();
      if (want.includes(c) && !found[c]) found[c] = { id: it.Id, name: it.Name, index: su.Index, codec: c };
    }
    if (want.every((c) => found[c])) break;
  }
  return found;
}

const { token, uid } = await auth();
const targets = await discover(token, uid);

const EXPECT = {
  subrip: { shellTv: 'External', noSsa: 'External' },
  ass: { shellTv: 'External', noSsa: 'Encode' },
  pgssub: { shellTv: 'Encode', noSsa: 'Encode' },
  dvdsub: { shellTv: 'Encode', noSsa: 'Encode' },
};
const out = { generatedFor: 'JEL-44', server: U, rows: [] };
let surprises = 0;
console.log('codec      | item                         | shell-TV(ssa=on) | no-ssa(ssa=off) | matches-expectation');
console.log('-----------|------------------------------|------------------|-----------------|--------------------');
for (const codec of Object.keys(EXPECT)) {
  const tg = targets[codec];
  if (!tg) {
    console.log(`${codec.padEnd(10)} | (none found in first 500 items)`);
    out.rows.push({ codec, found: false });
    continue;
  }
  const a = await playbackInfo(token, uid, tg.id, SHELL_TV);
  const b = await playbackInfo(token, uid, tg.id, NO_SSA);
  const sa = subStreams(a.MediaSources[0]).find((s) => s.Index === tg.index) || {};
  const sb = subStreams(b.MediaSources[0]).find((s) => s.Index === tg.index) || {};
  const dA = sa.DeliveryMethod || '(none)';
  const dB = sb.DeliveryMethod || '(none)';
  const ok = dA === EXPECT[codec].shellTv && dB === EXPECT[codec].noSsa;
  if (!ok) surprises++;
  console.log(
    `${codec.padEnd(10)} | ${tg.name.slice(0, 28).padEnd(28)} | ${dA.padEnd(16)} | ${dB.padEnd(15)} | ${ok ? 'yes' : 'NO <-- surprise'}`,
  );
  out.rows.push({ codec, item: tg.name, itemId: tg.id, streamIndex: tg.index, shellTv: dA, noSsa: dB, expected: EXPECT[codec], ok });
}
out.surprises = surprises;
writeFileSync(new URL('./subtitle-delivery.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`\nsurprises: ${surprises}  (wrote subtitle-delivery.json)`);
process.exit(surprises ? 1 : 0);
