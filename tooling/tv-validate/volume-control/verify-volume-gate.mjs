// JEL-78 — live ground-truth verifier for the volume-control gate.
//
// The deterministic unit test (packages/shell-tizen/scripts/volume-control
// .test.cjs) pins the SHELL contract (no volume keys registered;
// physicalvolumecontrol declared) and behaviourally MODELS jellyfin-web's volume
// gate. This script re-derives that gate from the LIVE web bundle the server
// actually serves (the exact JS that runs in a desktop browser AND inside the
// Tizen webview) so the model can't silently drift out of sync with a server
// upgrade. No media decode needed — it reads the shipped JS — so it is fast and
// deterministic.
//
// Run:  JELLYFIN_URL=https://host node tooling/tv-validate/volume-control/verify-volume-gate.mjs
// Skips cleanly (exit 0) when JELLYFIN_URL is unset.

const BASE = (process.env.JELLYFIN_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.log("SKIP: JELLYFIN_URL not set — live volume-gate check skipped.");
  process.exit(0);
}

const url = BASE + "/web/main.jellyfin.bundle.js";
const res = await fetch(url);
if (!res.ok) {
  console.error("FAIL: could not fetch " + url + " (HTTP " + res.status + ")");
  process.exit(1);
}
const src = await res.text();
console.log("Fetched " + url + " (" + src.length + " bytes)\n");

let failures = 0;
const ok = (n, c, d) => {
  console[c ? "log" : "error"](
    (c ? "OK:   " : "FAIL: ") + n + (!c && d ? "  — " + d : ""),
  );
  if (!c) failures++;
};

// 1. appHost.supports() delegates ENTIRELY to NativeShell on TV. This is what
//    makes our SupportedFeatures (which lists physicalvolumecontrol)
//    authoritative inside the shell, and a desktop browser (no NativeShell) fall
//    back to jellyfin-web's own self-report.
ok(
  "appHost.supports() delegates to NativeShell.AppHost.supports when present",
  /supports:function\([^)]*\)\{return window\.NativeShell\?window\.NativeShell\.AppHost\.supports\([^)]*\):/.test(
    src,
  ),
);

// 2. PhysicalVolumeControl is the gate constant, and jellyfin-web's OWN feature
//    self-report (browser path) pushes it only for tv/xbox/ps4/mobile/ipad — so
//    a desktop browser reports it FALSE while our TV shell reports it TRUE.
ok(
  'PhysicalVolumeControl feature constant === "physicalvolumecontrol"',
  /PhysicalVolumeControl="physicalvolumecontrol"/.test(src),
);
ok(
  "browser self-report pushes PhysicalVolumeControl only for tv/xboxOne/ps4/mobile/ipad",
  /tv\|\|[a-zA-Z.]+\.xboxOne\|\|[a-zA-Z.]+\.ps4\|\|[a-zA-Z.]+\.mobile\|\|[a-zA-Z.]+\.ipad\)&&[a-zA-Z.]+\.push\([a-zA-Z.]+\.PhysicalVolumeControl\)/.test(
    src,
  ),
);

// 3. The Re() predicate: software volume is gated on a LOCAL player that
//    supports physicalvolumecontrol.
ok(
  "Re(p) === p.isLocalPlayer && supports(PhysicalVolumeControl)",
  /function Re\(e\)\{return e\.isLocalPlayer&&[a-zA-Z._]+supports\([a-zA-Z.]+PhysicalVolumeControl\)\}/.test(
    src,
  ),
);

// 4. playbackManager volume surface is short-circuited by !Re() — confirms TV
//    (PVC true) makes these no-ops while browser (PVC false) runs them.
ok(
  "setVolume gated: (p && !Re(p)) && p.setVolume(v)",
  /setVolume=function\([^)]*\)\{[^}]*&&!Re\([a-z]\)&&[a-z]\.setVolume/.test(src),
);
ok(
  "getVolume gated: (p && !Re(p)) ? p.getVolume() : 1",
  /getVolume=function\([^)]*\)\{return[^}]*&&!Re\([a-z]\)\?[a-z]\.getVolume\(\):1/.test(
    src,
  ),
);
ok(
  "volumeUp gated: (p && !Re(p)) && p.volumeUp()",
  /volumeUp=function\([^)]*\)\{[^}]*&&!Re\([a-z]\)&&[a-z]\.volumeUp/.test(src),
);
ok(
  "volumeDown gated: (p && !Re(p)) && p.volumeDown()",
  /volumeDown=function\([^)]*\)\{[^}]*&&!Re\([a-z]\)&&[a-z]\.volumeDown/.test(
    src,
  ),
);

// 5. Mute is NOT gated by Re() — setMute/toggleMute hit the player directly, so
//    jellyfin-web's software-mute path stays functional on TV (even though it is
//    never invoked there: hardware Mute key unregistered + slider not loaded).
ok(
  "setMute is NOT Re()-gated (calls player directly)",
  /key:"setMute",value:function\([^)]*\)\{var [a-z]=[^;]+;[a-z]&&[a-z]\.setMute\([a-z]\)\}/.test(
    src,
  ),
);
ok(
  "toggleMute is NOT Re()-gated (player.toggleMute || setMute(!isMuted))",
  /key:"toggleMute",value:function\([^)]*\)\{var [a-z]=[^;]+;[a-z]&&\([a-z]\.toggleMute\?[a-z]\.toggleMute\(\):[a-z]\.setMute\(![a-z]\.isMuted\(\)\)\)\}/.test(
    src,
  ),
);

// 6. The on-screen volume slider / mute OSD module is dynamically loaded only
//    when PhysicalVolumeControl is NOT supported (or on touch). On TV the
//    short-circuit `supports(PVC)&&!touch` is truthy, so the module is skipped;
//    in a desktop browser it loads — hence the slider exists in browser, not TV.
ok(
  "volume OSD module gated: supports(PVC)&&!touch || <dynamic import>",
  /supports\([a-zA-Z.]+PhysicalVolumeControl\)&&![a-zA-Z.]+touch\|\|[a-zA-Z.]+\.e\(\d+\)\.then/.test(
    src,
  ),
);

// 7. Keyboard command contract: VolumeUp/VolumeDown/Mute/ToggleMute KeyNames map
//    to playbackManager handlers. On TV these are dormant (the hardware keys are
//    unregistered and have no KeyNames keyCode entry, so they never arrive); in
//    a browser a media keyboard can drive them.
const KB = {
  VolumeUp: "volumeup",
  VolumeDown: "volumedown",
  Mute: "mute",
  ToggleMute: "togglemute",
};
for (const [keyName, cmd] of Object.entries(KB)) {
  ok(
    `keyboard: case "${keyName}" -> handleCommand("${cmd}")`,
    new RegExp(`case"${keyName}":return void [a-zA-Z._]+handleCommand\\("${cmd}"\\)`).test(
      src,
    ),
  );
}
// And confirm the TV hardware volume keys have NO KeyNames keyCode->name entry,
// so even a leaked keyCode could not be translated to a Volume command.
ok(
  "no KeyNames keyCode entry maps to a Volume* / Mute key name",
  !/\d{2,5}:"(VolumeUp|VolumeDown|VolumeMute|Mute)"/.test(src),
);

console.log("");
if (failures) {
  console.error(failures + " live volume-gate check(s) FAILED — bundle drifted.");
  process.exit(1);
}
console.log("Live volume-control gate matches the pinned ground truth.");
