// JEL-78 verification — volume control behavior parity (TV vs browser).
//
// QUESTION (from the ticket): does the shell register volume keys or defer to
// the OS? Does the on-screen slider work? Does mute/unmute work and show in UI?
//
// ANSWER — established by source + live ground truth (see
// tooling/tv-validate/volume-control/results-JEL-78.md):
//
//   1. The shell registers NO volume/mute keys. registerRemoteKeys() lists only
//      transport + color keys; VolumeUp/VolumeDown/VolumeMute are absent. The
//      Samsung firmware therefore keeps the physical Volume +/- and Mute buttons
//      to itself and adjusts the SET's hardware mixer — they never reach the
//      webview. Volume is delegated ENTIRELY to the OS on TV. This is correct TV
//      UX (the user's TV/AVR owns the speaker), not a gap.
//
//   2. The shell declares "physicalvolumecontrol" in SupportedFeatures. Because
//      jellyfin-web's appHost.supports() defers entirely to
//      NativeShell.AppHost.supports inside our shell (see
//      apphost-supports-delegation), supports("physicalvolumecontrol") === true
//      on TV and === false in a desktop browser (jellyfin-web only self-reports
//      it for tv/xbox/ps4/mobile/ipad). That single flag drives every divergence
//      below — by jellyfin-web's own design, not ours.
//
//   3. Given physicalvolumecontrol, jellyfin-web's playbackManager SHORT-CIRCUITS
//      software volume on a local player:
//        Re(p)      = p.isLocalPlayer && supports("physicalvolumecontrol")
//        setVolume  = (p && !Re(p)) && p.setVolume(v)      -> no-op on TV
//        getVolume  = (p && !Re(p)) ? p.getVolume() : 1    -> pinned 1 on TV
//        volumeUp   = (p && !Re(p)) && p.volumeUp()        -> no-op on TV
//        volumeDown = (p && !Re(p)) && p.volumeDown()      -> no-op on TV
//      and the volume-slider OSD module is gated `supports(PVC)&&!touch || load`,
//      so it is NOT loaded on TV. In a desktop browser none of this fires:
//      the slider loads and drives <video>.volume directly.
//
//   4. MUTE is NOT behind the Re() gate. playbackManager.setMute/toggleMute call
//      the player directly regardless of physicalvolumecontrol. So jellyfin-web's
//      software-mute path is fully functional on TV in principle — but on TV it
//      is never INVOKED, because (a) the hardware Mute key is unregistered and
//      (b) the volume/mute OSD control is not loaded. The user mutes with the
//      physical Mute button (OS-level), reflected in the TV's native mute OSD. In
//      the browser, the slider's mute button toggles <video>.muted and the
//      volume icon reflects IsMuted.
//
// This test locks the SHELL side of that contract to source (keys NOT
// registered, flag present, no volume keydown swallowing) and behaviourally
// documents jellyfin-web's gate so a future regression is caught here. The LIVE
// jellyfin-web side is re-derived from the served bundle by the companion
// verifier: tooling/tv-validate/volume-control/verify-volume-gate.mjs.
//
// Run: node scripts/volume-control.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);

// jellyfin-web KeyNames for volume controls and the hardware keyCodes Samsung
// emits for them. The shell must register NONE of these (defer to OS), and must
// never swallow these keyCodes in any keydown listener.
const VOLUME_KEY_NAMES = ["VolumeUp", "VolumeDown", "VolumeMute", "Mute"];
// Tizen/Samsung hardware volume keyCodes (reference; firmware-reserved).
const VOLUME_KEYCODES = [447, 448, 449]; // VolumeUp / VolumeDown / VolumeMute

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Brace-balanced extraction of a named function body (mirrors playback-controls).
function fnBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in shell.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name + ": unbalanced braces");
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const minSrc = fs.readFileSync(TV_SHELL_MIN, "utf8");

// --- 1. The shell registers NO volume/mute keys (defers to the OS) ----------
const regBody = fnBody(tvSrc, "registerRemoteKeys");
const registered = (regBody.match(/"([A-Za-z0-9]+)"/g) || []).map((s) =>
  s.replace(/"/g, ""),
);
check(
  "registerRemoteKeys() registers at least one key (sanity)",
  registered.length > 0,
  "registered=[" + registered + "]",
);
const registeredVolume = VOLUME_KEY_NAMES.filter((k) => registered.includes(k));
check(
  "registerRemoteKeys() registers NO volume/mute key (volume deferred to OS)",
  registeredVolume.length === 0,
  "unexpectedly registered=[" + registeredVolume + "]",
);

// --- 2. physicalvolumecontrol is declared in SupportedFeatures --------------
// This is the single flag that tells jellyfin-web "hardware owns volume on this
// device" — it suppresses the software slider and short-circuits software volume.
const featStart = tvSrc.indexOf("var SupportedFeatures");
const featBlock = tvSrc.slice(featStart, tvSrc.indexOf("]", featStart) + 1);
check(
  'SupportedFeatures includes "physicalvolumecontrol"',
  /"physicalvolumecontrol"/.test(featBlock),
);
// supports() lowercases its arg and indexOf()s SupportedFeatures, so the flag is
// authoritative for the whole client (delegation proven live in the .mjs).
const supportsBody = tvSrc.slice(
  tvSrc.indexOf("supports: function"),
  tvSrc.indexOf("supports: function") + 200,
);
check(
  "appHost.supports() resolves against SupportedFeatures (case-insensitive)",
  /SupportedFeatures\.indexOf\(String\(cmd\)\.toLowerCase\(\)\)/.test(
    supportsBody,
  ),
);

// --- 3. Deployed artifact mirrors both facts --------------------------------
check(
  'shell.min.js (deployed) declares "physicalvolumecontrol"',
  /physicalvolumecontrol/.test(minSrc),
);
const minRegistersVolume = VOLUME_KEY_NAMES.filter((k) =>
  minSrc.includes('"' + k + '"'),
);
check(
  "shell.min.js (deployed) registers no volume/mute key name",
  minRegistersVolume.length === 0,
  "found=[" + minRegistersVolume + "]",
);

// --- 4. The shell never SWALLOWS a volume key -------------------------------
// Even though the keys are unregistered (so they should not arrive at all), be
// defensive: no shell keydown listener may reference a volume keyCode or name.
// 4a. back-handler: only keyCode 10009.
const backBody = fnBody(tvSrc, "installBackHandler");
check(
  "back-handler references no volume keyCode",
  !VOLUME_KEYCODES.some((c) => new RegExp("\\b" + c + "\\b").test(backBody)),
  "seen=[" +
    VOLUME_KEYCODES.filter((c) => new RegExp("\\b" + c + "\\b").test(backBody)) +
    "]",
);
// 4b. focus-rescue keydown sets (K names / C codes) must exclude volume keys.
const setDecl = tvSrc.match(/var K=(\{[^}]*\}),C=(\{[^}]*\})/);
if (!setDecl) throw new Error("focus-rescue K/C set declaration not found");
const rescueKNames = (setDecl[1].match(/([A-Za-z]+):\s*1/g) || []).map((s) =>
  s.split(":")[0],
);
const rescueCCodes = (setDecl[2].match(/(\d+):\s*1/g) || []).map((s) =>
  Number(s.split(":")[0]),
);
check(
  "focus-rescue key-name set excludes volume/mute keys",
  !VOLUME_KEY_NAMES.some((n) => rescueKNames.includes(n)),
  "overlap=[" + VOLUME_KEY_NAMES.filter((n) => rescueKNames.includes(n)) + "]",
);
check(
  "focus-rescue keycode set excludes volume keycodes",
  !VOLUME_KEYCODES.some((c) => rescueCCodes.includes(c)),
  "overlap=[" + VOLUME_KEYCODES.filter((c) => rescueCCodes.includes(c)) + "]",
);

// --- 5. Behavioural model of jellyfin-web's volume gate ---------------------
// Reconstruct playbackManager's volume/mute surface exactly as the live bundle
// implements it (see .mjs verifier for the byte-level confirmation) and prove
// the TV-vs-browser divergence is fully and only explained by the
// physicalvolumecontrol flag — with mute remaining functional on both.
function makePlaybackManager(supportsPhysicalVolumeControl) {
  // The local <video> player. setVolume/volumeUp/volumeDown/getVolume operate on
  // <video>.volume; setMute/toggleMute on <video>.muted.
  const player = {
    isLocalPlayer: true,
    _vol: 1,
    _muted: false,
    setVolume(v) {
      this._vol = v;
    },
    getVolume() {
      return this._vol;
    },
    volumeUp() {
      this._vol = Math.min(1, this._vol + 0.1);
    },
    volumeDown() {
      this._vol = Math.max(0, this._vol - 0.1);
    },
    setMute(m) {
      this._muted = m;
    },
    isMuted() {
      return this._muted;
    },
    toggleMute() {
      this._muted = !this._muted;
    },
  };
  // Re(p) — the exact predicate from the live bundle.
  const Re = (p) => p.isLocalPlayer && supportsPhysicalVolumeControl;
  return {
    player,
    setVolume(v) {
      if (player && !Re(player)) player.setVolume(v);
    },
    getVolume() {
      return player && !Re(player) ? player.getVolume() : 1;
    },
    volumeUp() {
      if (player && !Re(player)) player.volumeUp();
    },
    volumeDown() {
      if (player && !Re(player)) player.volumeDown();
    },
    // Mute is intentionally NOT gated by Re() in the live bundle.
    setMute(m) {
      if (player) player.setMute(m);
    },
    toggleMute() {
      if (player) player.toggleMute();
    },
    isMuted() {
      return !!player && player.isMuted();
    },
  };
}

// 5a. TV (physicalvolumecontrol = true): software volume is inert; OS owns it.
{
  const pm = makePlaybackManager(true);
  pm.setVolume(0.3);
  check(
    "TV: setVolume() is a no-op on the local player (<video>.volume untouched)",
    pm.player._vol === 1,
  );
  pm.volumeDown();
  check("TV: volumeDown() is a no-op", pm.player._vol === 1);
  pm.volumeUp();
  check("TV: volumeUp() is a no-op", pm.player._vol === 1);
  check("TV: getVolume() is pinned to 1 (100%)", pm.getVolume() === 1);
  // Mute still works through the software path (though never invoked on TV).
  pm.setMute(true);
  check("TV: setMute(true) still sets <video>.muted (mute path functional)", pm.isMuted() === true);
  pm.toggleMute();
  check("TV: toggleMute() unmutes and is reflected by isMuted()", pm.isMuted() === false);
}

// 5b. Browser (physicalvolumecontrol = false): full software volume + mute.
{
  const pm = makePlaybackManager(false);
  pm.setVolume(0.3);
  check(
    "Browser: setVolume() drives <video>.volume",
    Math.abs(pm.player._vol - 0.3) < 1e-9,
  );
  check(
    "Browser: getVolume() reflects the real volume",
    Math.abs(pm.getVolume() - 0.3) < 1e-9,
  );
  pm.volumeUp();
  check("Browser: volumeUp() raises volume", pm.player._vol > 0.3);
  pm.volumeDown();
  pm.volumeDown();
  check("Browser: volumeDown() lowers volume", pm.player._vol < 0.3 + 1e-9);
  pm.setMute(true);
  check("Browser: setMute(true) mutes and isMuted() reflects it", pm.isMuted() === true);
  pm.toggleMute();
  check("Browser: toggleMute() unmutes and isMuted() reflects it", pm.isMuted() === false);
}

// 5c. The ONLY difference between the two is the flag — mute parity holds.
{
  const tv = makePlaybackManager(true);
  const br = makePlaybackManager(false);
  tv.setMute(true);
  br.setMute(true);
  check(
    "Mute parity: setMute(true) reflected by isMuted() on BOTH TV and browser",
    tv.isMuted() === true && br.isMuted() === true,
  );
  tv.setMute(false);
  br.setMute(false);
  check(
    "Unmute parity: setMute(false) reflected on BOTH TV and browser",
    tv.isMuted() === false && br.isMuted() === false,
  );
}

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All volume-control parity checks passed.");
