// JEL-621 verification — build-tx-drop.mjs, the offline pre-lower tool.
//
// The tool publishes pre-lowered ES5 bodies into the /shell/ drop keyed by
// the fnv1a hash of the original source. The TV only trusts a drop whose
// manifest carries the shell's exact BABEL_OPTS_KEY and whose bodies pass
// the strict fully-lowered oracle — so every constant the builder embeds
// MUST stay byte-lockstep with BOTH shell sources, and its hash function
// must agree with the shells' txFnv1a on arbitrary text.
//
// WHAT THIS PINS
//   PART A — LOCKSTEP: ORACLE_SRC / PRECHECK_SRC / BABEL_OPTS_KEY / fnv1a
//            agree with shell.js and boot-shell.src.js.
//   PART B — BUILD: a real run over fixtures (modern `?.`, interior-spread-
//            only JEL-417 shape, plain ES5) emits a manifest whose keys are
//            the shells' hashes, whose bodies are oracle-clean, and skips
//            ES5-safe sources; --merge keeps prior surviving entries.
//
// Run: node scripts/tx-drop-build.test.cjs
//   or: pnpm --filter @jellyfin-tv/server-shell-drop test

"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const REPO = path.join(__dirname, "..", "..", "..");
const BUILDER = path.join(__dirname, "build-tx-drop.mjs");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

function extractStringConst(src, name) {
  const re = new RegExp(name + '\\s*=\\s*\\n?\\s*"([^"]+)"');
  const m = re.exec(src);
  if (!m) throw new Error("could not extract " + name);
  // The capture is raw source text (backslashes doubled); parse it to the
  // runtime string value the shells actually use.
  return JSON.parse('"' + m[1] + '"');
}

function extractTopFn(src, name) {
  const lines = src.split("\n");
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("  function " + name + "(")) {
      s = i;
      break;
    }
  }
  if (s === -1) throw new Error("function not found: " + name);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(s, i + 1).join("\n");
  }
  throw new Error("no closing brace for: " + name);
}

async function main() {
  const builder = await import(pathToFileURL(BUILDER).href);
  const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
  const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");

  // ==========================================================================
  // PART A — LOCKSTEP
  // ==========================================================================
  for (const [name, src] of [
    ["shell.js", tvSrc],
    ["boot-shell.src.js", bootSrc],
  ]) {
    check(
      "lockstep oracle vs " + name,
      builder.ORACLE_SRC === extractStringConst(src, "MODERN_SYNTAX_RE_SRC"),
    );
    check(
      "lockstep babelOptsKey vs " + name,
      builder.BABEL_OPTS_KEY === extractStringConst(src, "BABEL_OPTS_KEY"),
    );
    // JEL-417: PRE-check = oracle + the interior-spread tail, exactly.
    check(
      "lockstep pre-check tail vs " + name,
      builder.PRECHECK_SRC ===
        extractStringConst(src, "MODERN_SYNTAX_RE_SRC") +
          "|,\\s*\\.\\.\\.[\\w$]" &&
        src.includes(
          'MODERN_SYNTAX_RE_SRC + "|,\\\\s*\\\\.\\\\.\\\\.[\\\\w$]"',
        ),
    );
    // Hash parity on arbitrary vectors, against the shell's own txFnv1a.
    const fnSrc = extractTopFn(src, "txFnv1a").replace(
      /^ {2}function txFnv1a/,
      "function",
    );
    const sb = {};
    vm.createContext(sb);
    const shellFnv = vm.runInContext("(" + fnSrc + ")", sb);
    let hashOk = true;
    for (const v of [
      "",
      "abc",
      "var cfg = window.__cfg ?? {};",
      "𝌆 unicode ☃ mixed\nlines\t" + "x".repeat(4096),
    ]) {
      if (shellFnv(v) !== builder.txFnv1a(v)) hashOk = false;
    }
    check("lockstep txFnv1a vs " + name, hashOk);
  }
  // The builder's transform options literal must carry the JEL-26
  // assumptions block the seeds use (semantic, not just syntactic, parity).
  check(
    "builder transform opts carry JEL-26 assumptions",
    JSON.stringify(builder.BABEL_OPTS.assumptions) ===
      '{"iterableIsArray":true,"arrayLikeIsIterable":true}' &&
      JSON.stringify(builder.BABEL_OPTS.presets) ===
        '[["env",{"targets":{"chrome":"56"},"modules":false,"loose":true}]]',
  );

  // ==========================================================================
  // PART B — BUILD
  // ==========================================================================
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jel621-"));
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const srcDir = path.join(tmp, "src");
  const dropDir = path.join(tmp, "drop");
  fs.mkdirSync(srcDir, { recursive: true });

  const MODERN = "var v = window.__x ?? 1;\nconsole.log(window.__y?.z, v);\n";
  // JEL-417 shape: interior object spread is the ONLY modern token.
  const INTERIOR = "var o = { a: 1, ...window.__b, c: 2 };\nconsole.log(o);\n";
  const PLAIN = 'var p = 1;\nconsole.log("plain", p);\n';
  fs.writeFileSync(path.join(srcDir, "modern.js"), MODERN);
  fs.writeFileSync(path.join(srcDir, "interior.js"), INTERIOR);
  fs.writeFileSync(path.join(srcDir, "plain.js"), PLAIN);

  execFileSync(process.execPath, [BUILDER, dropDir, "--dir", srcDir], {
    stdio: "pipe",
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(dropDir, "tx-manifest.json"), "utf8"),
  );
  check("manifest format", manifest.format === 1);
  check(
    "manifest babelOptsKey matches shells",
    manifest.babelOptsKey === extractStringConst(tvSrc, "BABEL_OPTS_KEY"),
  );
  const hModern = builder.txFnv1a(MODERN);
  const hInterior = builder.txFnv1a(INTERIOR);
  const hPlain = builder.txFnv1a(PLAIN);
  check(
    "modern source published under its source hash",
    manifest.entries[hModern] === "tx/" + hModern + ".js",
  );
  check(
    "interior-spread-only source published (JEL-417 pre-check)",
    manifest.entries[hInterior] === "tx/" + hInterior + ".js",
  );
  check(
    "ES5-safe source skipped (device fast-path owns it)",
    !(hPlain in manifest.entries),
  );

  const oracle = new RegExp(extractStringConst(tvSrc, "MODERN_SYNTAX_RE_SRC"));
  for (const h of [hModern, hInterior]) {
    const body = fs.readFileSync(path.join(dropDir, "tx", h + ".js"), "utf8");
    check("drop body " + h + " is non-empty", body.length > 0);
    check("drop body " + h + " passes the lowered oracle", !oracle.test(body));
    check(
      "drop body " + h + " parses standalone",
      (() => {
        try {
          new vm.Script(body);
          return true;
        } catch (_) {
          return false;
        }
      })(),
    );
  }

  // --merge keeps prior surviving entries when rebuilding a subset.
  const src2 = path.join(tmp, "src2");
  fs.mkdirSync(src2);
  const MODERN2 = "var q = { ...window.__cfg };\nconsole.log(q?.k);\n";
  fs.writeFileSync(path.join(src2, "second.js"), MODERN2);
  execFileSync(process.execPath, [BUILDER, dropDir, "--dir", src2, "--merge"], {
    stdio: "pipe",
  });
  const merged = JSON.parse(
    fs.readFileSync(path.join(dropDir, "tx-manifest.json"), "utf8"),
  );
  check(
    "--merge keeps prior entries and adds new ones",
    merged.entries[hModern] === "tx/" + hModern + ".js" &&
      merged.entries[builder.txFnv1a(MODERN2)] != null,
  );

  process.exitCode = failures ? 1 : 0;
  console.log(failures ? failures + " FAILURE(S)" : "all checks passed");
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
