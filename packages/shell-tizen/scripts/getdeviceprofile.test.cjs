// JEL-47 verification — NativeShell.getDeviceProfile device profile (TV vs browser).
//
// CLAIM PROVEN HERE (offline, source-of-record check):
//   The Tizen shell does NOT author a codec/container/DRM matrix. Its
//   getDeviceProfile delegates to jellyfin-web's own profileBuilder and passes
//   exactly two options:
//       getDeviceProfile : { enableMkvProgressive: false, enableSsaRender: true }
//       getSyncProfile   : { enableMkvProgressive: false }
//   Every DirectPlayProfile / CodecProfile / TranscodingProfile in the profile
//   the server receives is therefore produced by jellyfin-web's
//   browserDeviceProfile.js from RUNTIME canPlayType / MediaSource.isTypeSupported
//   probes inside the running WebView. That makes the profile per-model-correct
//   by construction (M56 vs M63 vs M69 Chromium each report their own decode
//   support) and identical-by-construction to the desktop-browser profile except
//   where the panel's real codec support differs. See
//   tooling/tv-validate/device-profile/results-JEL-47.md for the full analysis,
//   including why the two options cannot incorrectly exclude a format:
//     - enableSsaRender:true matches jellyfin-web's own default and is the
//       transcode-AVOIDING choice (SSA/ASS rendered client-side, not burned in).
//     - enableMkvProgressive is INERT in jellyfin-web 10.10/10.11 (the option
//       name is not referenced anywhere in browserDeviceProfile.js); MKV
//       direct-play is gated solely on the WebView's runtime matroska support.
//
// This test pins those two facts to the source-of-record so they cannot silently
// drift, across BOTH shells (full shell.js + bootstrap) and their deployed
// minified blobs. It runs fully offline — no server, no device.
//
// Run: node scripts/getdeviceprofile.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js");
const BOOT_SRC = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.src.js");
const BOOT_MIN = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.min.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

const SRC_FILES = [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
];
const MIN_FILES = [
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
];

// --- 1. getDeviceProfile delegates to the passed-in profileBuilder ----------
// Shape in source: getDeviceProfile: function (profileBuilder) { return profileBuilder({...}) }
for (const [label, src] of SRC_FILES) {
  check(
    "getDeviceProfile delegates to profileBuilder(...) in " + label,
    /getDeviceProfile:\s*function\s*\(\s*profileBuilder\s*\)\s*\{\s*return\s+profileBuilder\(/.test(src),
  );
}

// --- 2. getDeviceProfile passes EXACTLY { enableMkvProgressive:false, enableSsaRender:true }
//        NOTE: shell.js writes the literals `false`/`true`; boot-shell.src.js is a
//        hand-maintained de-minified source that writes the equivalent `!1`/`!0`.
//        Both forms are accepted — they are semantically identical.
const FALSE = "(?:false|!1)";
const TRUE = "(?:true|!0)";
for (const [label, src] of SRC_FILES) {
  const m = src.match(
    /getDeviceProfile:\s*function\s*\(\s*profileBuilder\s*\)\s*\{\s*return\s+profileBuilder\(\s*\{([\s\S]*?)\}\s*\)/,
  );
  check("found getDeviceProfile options literal in " + label, !!m);
  if (!m) continue;
  const opts = m[1];
  check(
    "getDeviceProfile passes enableMkvProgressive:false in " + label,
    new RegExp("enableMkvProgressive:\\s*" + FALSE).test(opts),
    opts.trim(),
  );
  check(
    "getDeviceProfile passes enableSsaRender:true in " + label,
    new RegExp("enableSsaRender:\\s*" + TRUE).test(opts),
    opts.trim(),
  );
  // Guard against a shell-authored codec list sneaking into the options object.
  check(
    "getDeviceProfile options contain NO codec/container matrix in " + label,
    !/DirectPlayProfiles|TranscodingProfiles|CodecProfiles|VideoCodec|AudioCodec|Container/.test(opts),
    opts.trim(),
  );
}

// Deployed blobs carry the same two options (minified booleans).
for (const [label, src] of MIN_FILES) {
  check(
    "deployed " + label + " getDeviceProfile passes enableMkvProgressive:!1",
    /getDeviceProfile:function\(\w+\)\{return \w+\(\{enableMkvProgressive:!1/.test(src) ||
      /enableMkvProgressive:!1,\s*enableSsaRender:!0/.test(src),
  );
  check(
    "deployed " + label + " getDeviceProfile passes enableSsaRender:!0",
    /enableSsaRender:!0/.test(src),
  );
}

// --- 3. getSyncProfile delegates the same way with { enableMkvProgressive:false }
for (const [label, src] of SRC_FILES) {
  check(
    "getSyncProfile delegates to profileBuilder({ enableMkvProgressive:false }) in " + label,
    new RegExp(
      "getSyncProfile:\\s*function\\s*\\(\\s*profileBuilder\\s*\\)\\s*\\{\\s*return\\s+profileBuilder\\(\\s*\\{\\s*enableMkvProgressive:\\s*" +
        FALSE +
        "\\s*\\}\\s*\\)",
    ).test(src),
  );
}

// --- 4. The shell authors NO codec/container/DRM matrix anywhere. This is the
//        crux of TV/browser parity: there is no shell allow/deny list that could
//        incorrectly exclude a format and force server-side transcoding. The
//        matrix is built by jellyfin-web at runtime from the WebView's real
//        canPlayType / MediaSource.isTypeSupported results.
for (const [label, src] of SRC_FILES) {
  check(
    "no shell-authored DirectPlayProfiles in " + label,
    !/DirectPlayProfiles/.test(src),
  );
  check(
    "no shell-authored TranscodingProfiles in " + label,
    !/TranscodingProfiles/.test(src),
  );
  check(
    "no shell-authored CodecProfiles in " + label,
    !/CodecProfiles/.test(src),
  );
}

// --- 5. Both shells AGREE on the options (server must see one profile shape
//        regardless of which shell booted).
const optOf = (src) => {
  const m = src.match(/getDeviceProfile:\s*function\s*\(\s*profileBuilder\s*\)\s*\{\s*return\s+profileBuilder\(\s*\{([\s\S]*?)\}\s*\)/);
  // Normalize whitespace and minified-boolean forms so shell.js (`false`/`true`)
  // and boot-shell.src.js (`!1`/`!0`) compare equal.
  return m
    ? m[1].replace(/\s+/g, "").replace(/!1/g, "false").replace(/!0/g, "true")
    : null;
};
check(
  "shell.js and boot-shell.src.js agree on getDeviceProfile options",
  optOf(tvSrc) && optOf(tvSrc) === optOf(bootSrc),
  "shell=" + optOf(tvSrc) + " boot=" + optOf(bootSrc),
);

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " getDeviceProfile contract check(s) FAILED");
  process.exit(1);
}
console.log("All NativeShell.getDeviceProfile contract checks passed.");
