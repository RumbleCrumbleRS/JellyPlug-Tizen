#!/usr/bin/env node
// JEL-121: guard for tooling/ci/verify-wgt-source-match.sh — the release-time
// check that a committed retail .wgt's payload is byte-identical to the tagged
// source (signatures excluded). A signature proves who built the artifact;
// this proves *what* was built. The test packs a .wgt from the live source
// tree exactly the way build-wgt.sh stages it, then drives the verifier
// through pass + every tamper class it must catch:
//
//   1. faithful payload + dummy signatures        -> PASS (sigs excluded)
//   2. one byte changed inside shell.js           -> FAIL (content mismatch)
//   3. extra smuggled file in the .wgt            -> FAIL (extra entry)
//   4. payload entry deleted from the .wgt        -> FAIL (missing entry)
//   5. QA-seeded index.html packaged as retail    -> FAIL (JEL-100 regression)
//
// Zip packing shells out to python3 (same dependency the verifier itself
// uses; ubuntu CI and the sandbox both ship it).

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PKG_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");
const VERIFY = path.join(REPO_ROOT, "tooling", "ci", "verify-wgt-source-match.sh");
const QA_SEED = path.join(PKG_DIR, "scripts", "process-qa-seed.sh");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jel121-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// Stage the retail payload exactly like build-wgt.sh: src/** + config.xml,
// QA seed stripped (retail default).
const stageDir = path.join(tmpRoot, "stage");
fs.cpSync(path.join(PKG_DIR, "src"), stageDir, { recursive: true });
fs.copyFileSync(
  path.join(PKG_DIR, "tizen", "config.xml"),
  path.join(stageDir, "config.xml"),
);
execFileSync("bash", [QA_SEED, path.join(stageDir, "index.html")], {
  env: { ...process.env, SHELL_QA_BUILD: "" },
  stdio: "pipe",
});

// Pack a directory into a .wgt (zip), adding dummy signature entries so the
// artifact shape matches a real signed package.
function packWgt(dir, outFile, { withSigs = true, extraEntries = {}, dropEntry } = {}) {
  const script = `
import os, sys, zipfile
src, out, with_sigs, drop = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
extras = sys.argv[5:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            if rel == drop:
                continue
            z.write(full, rel)
    if with_sigs:
        z.writestr("author-signature.xml", "<Signature>dummy author</Signature>")
        z.writestr("signature1.xml", "<Signature>dummy distributor</Signature>")
    for i in range(0, len(extras), 2):
        z.writestr(extras[i], extras[i + 1])
`;
  const args = [
    "-c",
    script,
    dir,
    outFile,
    withSigs ? "1" : "0",
    dropEntry || "",
  ];
  for (const [name, body] of Object.entries(extraEntries)) args.push(name, body);
  execFileSync("python3", args, { stdio: "pipe" });
}

function runVerify(wgt) {
  const r = spawnSync("bash", [VERIFY, wgt], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok    ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}

// 1. Faithful payload (+ dummy signatures) passes — signatures are excluded.
const goodWgt = path.join(tmpRoot, "good.wgt");
packWgt(stageDir, goodWgt);
let r = runVerify(goodWgt);
check("faithful payload passes", r.status === 0, r.out.trim());

// 2. A single tampered byte inside shell.js fails.
const tamperDir = path.join(tmpRoot, "tamper");
fs.cpSync(stageDir, tamperDir, { recursive: true });
const shellJs = path.join(tamperDir, "shell.js");
const buf = fs.readFileSync(shellJs);
buf[Math.floor(buf.length / 2)] ^= 0xff;
fs.writeFileSync(shellJs, buf);
const tamperWgt = path.join(tmpRoot, "tamper.wgt");
packWgt(tamperDir, tamperWgt);
r = runVerify(tamperWgt);
check(
  "tampered shell.js fails",
  r.status !== 0 && r.out.includes("content mismatch: shell.js"),
  r.out.trim(),
);

// 3. A smuggled extra file fails (a payload addition the source never had).
const extraWgt = path.join(tmpRoot, "extra.wgt");
packWgt(stageDir, extraWgt, { extraEntries: { "evil.js": "alert(1)" } });
r = runVerify(extraWgt);
check(
  "smuggled extra file fails",
  r.status !== 0 && r.out.includes("extra in .wgt"),
  r.out.trim(),
);

// 4. A deleted payload entry fails.
const missingWgt = path.join(tmpRoot, "missing.wgt");
packWgt(stageDir, missingWgt, { dropEntry: "qa-beacon.js" });
r = runVerify(missingWgt);
check(
  "missing payload entry fails",
  r.status !== 0 && r.out.includes("missing from .wgt"),
  r.out.trim(),
);

// 5. A QA-seeded index.html packaged as a release artifact fails — the
// verifier always stages the RETAIL (stripped) variant (JEL-100).
const qaDir = path.join(tmpRoot, "qa");
fs.cpSync(path.join(PKG_DIR, "src"), qaDir, { recursive: true });
fs.copyFileSync(path.join(PKG_DIR, "tizen", "config.xml"), path.join(qaDir, "config.xml"));
// src/index.html still carries the QA-SEED block — pack it unstripped.
const qaWgt = path.join(tmpRoot, "qa.wgt");
packWgt(qaDir, qaWgt);
r = runVerify(qaWgt);
check(
  "QA-seeded index.html fails retail check",
  r.status !== 0 && r.out.includes("content mismatch: index.html"),
  r.out.trim(),
);

if (failures > 0) {
  console.error(`\nwgt-source-match: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nwgt-source-match: all 5 checks passed");
