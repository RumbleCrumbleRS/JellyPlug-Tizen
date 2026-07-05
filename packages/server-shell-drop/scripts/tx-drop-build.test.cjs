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
//   PART C — REGEN AUTOMATION (JEL-653): regen-tx-drop.sh run twice against
//            a live local HTTP server proves the unattended contract — a
//            changed plugin body yields a fresh manifest entry under its new
//            source hash with no human action, prior entries survive the
//            merge, TX_DROP_PRUNE_DAYS reaps aged-out bodies, and the
//            manifest publish leaves no torn temp file.
//
// Run: node scripts/tx-drop-build.test.cjs
//   or: pnpm --filter @jellyfin-tv/server-shell-drop test

"use strict";
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const REPO = path.join(__dirname, "..", "..", "..");
const BUILDER = path.join(__dirname, "build-tx-drop.mjs");
const REGEN = path.join(__dirname, "regen-tx-drop.sh");
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

  // ==========================================================================
  // PART C — REGEN AUTOMATION (JEL-653)
  // ==========================================================================
  // A tiny in-process origin standing in for the live Jellyfin server: one
  // non-bundle plugin script on /web/index.html plus a snippet-channel body.
  // Generic fixture names only (plugin-agnostic repo policy, JEL-240).
  let pluginBody = "var a = window.__pa ?? 'v1';\nconsole.log(a);\n";
  const jsiBody = "var s = window.__snip ?? 1;\nconsole.log(s);\n";
  const srv = http.createServer((req, res) => {
    const u = String(req.url || "").split("?")[0];
    if (u === "/web/index.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<script src="../plugins/alpha.js"></script>' +
          '<script src="main.jellyfin.bundle.js"></script>',
      );
    } else if (u === "/plugins/alpha.js") {
      res.end(pluginBody);
    } else if (u === "/snippets/public.js") {
      res.end(jsiBody);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + srv.address().port;
  const cronDrop = path.join(tmp, "cron-drop");
  const regenEnv = Object.assign({}, process.env, {
    TX_DROP_JSI_PATH: "/snippets/public.js",
  });
  // execFile, NOT execFileSync: the child fetches from the server hosted by
  // THIS process — a sync wait would block the event loop and deadlock the
  // child's requests against a server that can never respond.
  const runRegen = (extraEnv) =>
    new Promise((resolve, reject) => {
      execFile(
        "bash",
        [REGEN, cronDrop, origin],
        { env: Object.assign({}, regenEnv, extraEnv || {}) },
        (err, stdout, stderr) =>
          err ? reject(new Error(err.message + "\n" + stdout + stderr)) : resolve(stdout),
      );
    });

  await runRegen();
  const gen1 = JSON.parse(
    fs.readFileSync(path.join(cronDrop, "tx-manifest.json"), "utf8"),
  );
  const hPlugin1 = builder.txFnv1a(pluginBody);
  const hJsi = builder.txFnv1a(jsiBody);
  check(
    "regen publishes web-index plugin under its source hash",
    gen1.entries[hPlugin1] === "tx/" + hPlugin1 + ".js",
  );
  check(
    "regen publishes the snippet-channel body under its source hash",
    gen1.entries[hJsi] === "tx/" + hJsi + ".js",
  );
  check(
    "regen skips the jellyfin-web bundle (shell never feeds it to Babel)",
    Object.keys(gen1.entries).length === 2,
  );

  // The success condition of JEL-653: a plugin-body change on the server
  // results in a fresh drop entry on the next scheduled run, verified by
  // hash lookup — no human action between the two runs.
  pluginBody = "var a = window.__pa ?? 'v2-changed';\nconsole.log(a);\n";
  await runRegen();
  const gen2 = JSON.parse(
    fs.readFileSync(path.join(cronDrop, "tx-manifest.json"), "utf8"),
  );
  const hPlugin2 = builder.txFnv1a(pluginBody);
  check(
    "changed plugin body yields a fresh entry under its new hash",
    hPlugin2 !== hPlugin1 &&
      gen2.entries[hPlugin2] === "tx/" + hPlugin2 + ".js",
  );
  check(
    "prior-generation entry survives the --merge run (file still present)",
    gen2.entries[hPlugin1] === "tx/" + hPlugin1 + ".js" &&
      fs.existsSync(path.join(cronDrop, "tx", hPlugin1 + ".js")),
  );
  check(
    "atomic publish leaves no torn manifest temp file",
    !fs.existsSync(path.join(cronDrop, "tx-manifest.json.tmp")),
  );

  // TX_DROP_PRUNE_DAYS: age the dead generation's body past the window;
  // live sources are rewritten (mtime refreshed) every run, so only the
  // no-longer-served entry is reaped.
  const oldSec = (Date.now() - 10 * 864e5) / 1000;
  fs.utimesSync(path.join(cronDrop, "tx", hPlugin1 + ".js"), oldSec, oldSec);
  await runRegen({ TX_DROP_PRUNE_DAYS: "7" });
  const gen3 = JSON.parse(
    fs.readFileSync(path.join(cronDrop, "tx-manifest.json"), "utf8"),
  );
  check(
    "prune reaps the aged-out dead entry (body file and manifest key)",
    !(hPlugin1 in gen3.entries) &&
      !fs.existsSync(path.join(cronDrop, "tx", hPlugin1 + ".js")),
  );
  check(
    "prune keeps live entries (rewritten every run)",
    gen3.entries[hPlugin2] === "tx/" + hPlugin2 + ".js" &&
      gen3.entries[hJsi] === "tx/" + hJsi + ".js",
  );
  srv.close();

  process.exitCode = failures ? 1 : 0;
  console.log(failures ? failures + " FAILURE(S)" : "all checks passed");
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
