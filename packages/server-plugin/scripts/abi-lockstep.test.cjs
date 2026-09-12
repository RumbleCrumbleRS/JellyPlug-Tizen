#!/usr/bin/env node
/*
 * abi-lockstep.test.cjs — guard the release path against shipping a plugin zip
 * the target server refuses to load (JELA-896).
 *
 * The 12.0 port bumped Jellyfin.Controller + TargetFramework in the .csproj,
 * but package-plugin.sh carried its own hardcoded TARGET_ABI="10.11.0.0" and
 * release-server-plugin.yml its own dotnet-version: "9.0.x". Both are invisible
 * from the .csproj, so the bump looked complete while CI would still have built
 * against the wrong SDK and stamped meta.json with the old ABI — a released
 * 1.0.53.0 that Jellyfin 12.0 rejects exactly like the 1.0.52.0 it replaced.
 *
 * These three pins have no compile-time or runtime coupling to each other, so
 * nothing but this test notices when they drift.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");
const csprojPath = path.join(
  __dirname,
  "..",
  "Jellyfin.Plugin.JellyPlugShell",
  "Jellyfin.Plugin.JellyPlugShell.csproj",
);
const csproj = fs.readFileSync(csprojPath, "utf8");
const packageScript = fs.readFileSync(
  path.join(__dirname, "package-plugin.sh"),
  "utf8",
);
const releaseWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "release-server-plugin.yml"),
  "utf8",
);

function csprojValue(tag) {
  const m = csproj.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  assert.ok(m, `missing <${tag}> in ${path.basename(csprojPath)}`);
  return m[1].trim();
}

const targetAbi = csprojValue("JellyfinTargetAbi");
const targetFramework = csprojValue("TargetFramework");

const controllerVersion = csproj.match(
  /<PackageReference\s+Include="Jellyfin\.Controller"\s+Version="([^"]+)"/,
)?.[1];
assert.ok(controllerVersion, "missing Jellyfin.Controller PackageReference");

// 1. The declared ABI must match the Controller package we actually compile
//    against. Jellyfin compares targetAbi to the server version, so a plugin
//    built on 12.0.0 that advertises 10.11.0.0 gets loaded by a 10.x server
//    and then fails on the first missing type.
assert.strictEqual(
  targetAbi.split(".")[0],
  controllerVersion.split(".")[0],
  `targetAbi ${targetAbi} and Jellyfin.Controller ${controllerVersion} disagree on the major version`,
);
assert.match(targetAbi, /^\d+\.\d+\.\d+\.\d+$/, "targetAbi must be 4-part");

// 2. package-plugin.sh must read the ABI from the .csproj, not carry its own.
//    A literal here is what shipped the wrong meta.json.
assert.match(
  packageScript,
  /TARGET_ABI="\$\(grep[^"]*JellyfinTargetAbi/,
  "package-plugin.sh must derive TARGET_ABI from the csproj <JellyfinTargetAbi>",
);
const hardcodedAbi = packageScript.match(/TARGET_ABI="(\d+(?:\.\d+)+)"/);
assert.ok(
  !hardcodedAbi,
  `package-plugin.sh hardcodes TARGET_ABI="${hardcodedAbi?.[1]}" — derive it from the csproj instead`,
);

// 3. The release runner's SDK must cover the csproj TargetFramework, or the
//    build fails (or worse, resolves a stale framework) at release time only.
const sdkPin = releaseWorkflow.match(/dotnet-version:\s*"([^"]+)"/)?.[1];
assert.ok(sdkPin, "release-server-plugin.yml must pin a dotnet-version");
const tfmMajor = targetFramework.match(/^net(\d+)\.\d+$/)?.[1];
assert.ok(tfmMajor, `unexpected TargetFramework "${targetFramework}"`);
assert.strictEqual(
  sdkPin.split(".")[0],
  tfmMajor,
  `release-server-plugin.yml pins dotnet ${sdkPin} but the csproj targets ${targetFramework}`,
);

console.log(
  `abi-lockstep.test.cjs: ok (abi=${targetAbi}, controller=${controllerVersion}, tfm=${targetFramework}, sdk=${sdkPin})`,
);
