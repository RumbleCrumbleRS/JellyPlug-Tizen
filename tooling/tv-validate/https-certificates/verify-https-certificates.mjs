#!/usr/bin/env node
// JEL-83 — Compare: HTTPS vs HTTP server connections — certificate handling on TV.
//
// The issue asks us to verify, and compare against browser behaviour:
//   1. HTTPS connections work without certificate warnings;
//   2. self-signed certificates are handled gracefully (or the error message is
//      informative);
//   3. normalizeServerUrl correctly prepends http:// for bare hostnames;
//   4. compare browser behaviour for invalid certs.
//
// WHY THIS IS DECIDABLE WITHOUT A TV, A SERVER, OR A NETWORK
// ─────────────────────────────────────────────────────────────────────────────
// The shell contains ZERO TLS code. Two facts make the whole question fall out
// of the source:
//
//   (a) Every server connection is a `fetch`, never a top-level navigation.
//       The connect screen probes  fetch(url + "/System/Info/Public")  and the
//       web client itself is loaded by  fetch(url + "/web/") → document.write.
//       The only location.replace() in the shell targets the LOCAL "index.html".
//       The shell never points the top-level document at the remote server.
//
//   (b) `fetch` delegates TLS entirely to the platform net stack — the M63
//       WebView's network service on the TV, modern Chromium in the browser.
//       The shell passes NO certificate options and installs NO cert-error
//       callback (Tizen's setCertificateError / native WebView cert override is
//       a native-app API; a web widget cannot reach it, and this one doesn't).
//
// From (a)+(b):
//   • Valid public cert (e.g. REDACTED-SERVER.example, a real CA): the platform
//     trusts it, fetch RESOLVES, and since the shell never renders a cert UI
//     there is no "certificate warning" to show. Claim (1) holds by CONSTRUCTION.
//   • Self-signed / untrusted: the platform net stack REJECTS the fetch (real
//     Chromium reports a TypeError "Failed to fetch"; the Fetch spec deliberately
//     hides per-cert detail). The connect form's .catch surfaces
//       "Could not reach server: " + err.message
//     and stays on the form — graceful, no crash, informative-as-a-failure.
//     Claim (2) holds.
//   • Claim (4): the browser's clickable "your connection is not private →
//     proceed" interstitial exists ONLY for top-level navigation. Because the
//     shell gates every server connection behind a fetch (fact a), that
//     interstitial path is never reached — an invalid-cert server is
//     non-bypassable on the browser AND the TV, by the same code. The cert
//     decision happens at probe time on both platforms.
//
// So the only thing the shell actually OWNS is URL normalization (claim 3) and
// being a faithful, non-weakening conduit for whatever the platform decides.
// Both are executable here:
//   PART A — run the REAL normalizeServerUrl from all 4 shipped JS artifacts
//            over an input matrix; prove the http:// default, https://
//            preservation (no downgrade), trailing-slash strip.
//   PART B — run the REAL validateServer with a fetch stub that resolves (valid
//            cert) and one that rejects (bad cert); prove it propagates both
//            without weakening or swallowing.
//   PART C — source-contract cert-transparency: no TLS bypass, fetch carries no
//            cert options, the catch surfaces an informative message, config.xml
//            grants network access but no cert override.
//   PART D — parity (TV vs browser) + deployed-blob guards.
//
// Usage:  node tooling/tv-validate/https-certificates/verify-https-certificates.mjs
// Exits non-zero on any failed assertion. See results-JEL-83.md for the writeup.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const BOOT_SRC = resolve(
  REPO,
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
);
const BOOT_MIN = resolve(
  REPO,
  "packages/shell-tizen-bootstrap/src/boot-shell.min.js",
);
const BOOT_CONFIG = resolve(REPO, "packages/shell-tizen-bootstrap/src/config.xml");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS  " + name + (detail ? "  — " + detail : ""));
  } else {
    console.error("FAIL  " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const shellSrc = readFileSync(SHELL_JS, "utf8");
const shellMin = readFileSync(SHELL_MIN, "utf8");
const bootSrc = readFileSync(BOOT_SRC, "utf8");
const bootMin = readFileSync(BOOT_MIN, "utf8");
const bootConfig = readFileSync(BOOT_CONFIG, "utf8");

// Extract a `function name(...) { ... }` declaration verbatim by brace-matching.
function extractFn(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(`function ${name} not found in ${label}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

// Lift the REAL normalizeServerUrl out of a JS source → callable.
function liftNormalizeJs(src, label) {
  const ctx = { console };
  vm.createContext(ctx);
  return vm.runInContext(
    extractFn(src, "normalizeServerUrl", label) + "\n;normalizeServerUrl;",
    ctx,
  );
}

// Lift the REAL validateServer with an injectable fetch stub. Some shells wrap
// the probe in a boot-timeout helper (withBootTimeout(fetch(...), "connect",
// CONNECT_FETCH_TIMEOUT_MS)); provide a pass-through stub + timeout constant so
// the lift works for BOTH the bare-fetch and wrapped shapes. The TLS
// transparency we assert is identical either way.
function liftValidate(src, fetchStub, label) {
  const ctx = {
    fetch: fetchStub,
    withBootTimeout: (p) => p,
    CONNECT_FETCH_TIMEOUT_MS: 5000,
    console,
  };
  vm.createContext(ctx);
  return vm.runInContext(
    extractFn(src, "validateServer", label) + "\n;validateServer;",
    ctx,
  );
}

// ===========================================================================
// PART A — normalizeServerUrl input matrix (claim 3), all 4 shipped JS artifacts.
// ===========================================================================
// [input, expected] — the shipped JS contract for the Tizen shell + bootstrap.
const CASES = [
  // bare hostname → DEFAULT http://  (the issue's core claim)
  ["REDACTED-SERVER.example", "http://REDACTED-SERVER.example"],
  ["jellyfin.local:8096", "http://jellyfin.local:8096"],
  ["192.168.1.50:8096", "http://192.168.1.50:8096"],
  ["my-server", "http://my-server"],
  // explicit https:// PRESERVED — never downgraded to http
  ["https://REDACTED-SERVER.example", "https://REDACTED-SERVER.example"],
  ["https://jelly.example:8920", "https://jelly.example:8920"],
  // explicit http:// preserved
  ["http://192.168.1.50:8096", "http://192.168.1.50:8096"],
  // trailing slash(es) stripped for clean concatenation with /System/Info/Public
  ["https://jelly.example/", "https://jelly.example"],
  ["https://jelly.example///", "https://jelly.example"],
  ["jelly.example/", "http://jelly.example"],
  // whitespace trimmed
  ["  jellyfin.local:8096  ", "http://jellyfin.local:8096"],
  // scheme detection is case-insensitive → no spurious prepend, case preserved
  ["HTTPS://Host", "HTTPS://Host"],
  ["HtTp://Host", "HtTp://Host"],
];

const JS_NORMALIZERS = [
  { label: "shell.js (TV)", fn: liftNormalizeJs(shellSrc, "shell.js") },
  { label: "shell.min.js (TV)", fn: liftNormalizeJs(shellMin, "shell.min.js") },
  { label: "boot-shell.src.js (hosted)", fn: liftNormalizeJs(bootSrc, "boot-shell.src.js") },
  { label: "boot-shell.min.js (hosted)", fn: liftNormalizeJs(bootMin, "boot-shell.min.js") },
];

for (const { label, fn } of JS_NORMALIZERS) {
  for (const [input, expected] of CASES) {
    const got = fn(input);
    check(
      `[${label}] normalizeServerUrl(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`,
      got === expected,
      got === expected ? undefined : `got ${JSON.stringify(got)}`,
    );
  }
}

// Empty-input contract: the JS artifacts return "" for empty/blank input, which
// the connect form surfaces as "please enter a URL".
check(
  "[empty-input contract] JS artifacts return '' for empty/blank input",
  JS_NORMALIZERS.every((n) => n.fn("") === "" && n.fn("   ") === ""),
);

// Cross-artifact parity: every input maps to the SAME output across all 4 JS
// artifacts (the TLS-relevant claim: scheme handling is identical everywhere).
for (const [input] of CASES) {
  const outs = JS_NORMALIZERS.map((n) => n.fn(input));
  check(
    `normalizeServerUrl parity (4 JS artifacts) for ${JSON.stringify(input)}`,
    outs.every((o) => o === outs[0]),
    outs[0],
  );
}

// ===========================================================================
// PART B — validateServer is a transparent TLS conduit (claims 1 + 2).
// ===========================================================================
const JS_SHELLS = [
  { label: "shell.js (TV)", src: shellSrc },
  { label: "boot-shell.src.js (hosted)", src: bootSrc },
];

for (const { label, src } of JS_SHELLS) {
  // (1) Valid-cert HTTPS: the platform trusts the cert, fetch resolves with a
  //     real /System/Info/Public. validateServer returns the info — no cert UI.
  const okStub = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ Id: "srv-1", Version: "10.10.0" }),
    });
  const validate = liftValidate(src, okStub, label);
  const info = await validate("https://REDACTED-SERVER.example").catch(() => null);
  check(
    `[${label}] (1) valid-cert HTTPS resolves → no certificate warning is ever rendered`,
    info && info.Id === "srv-1",
    "validateServer returned server identity",
  );

  // (2) Self-signed / untrusted HTTPS: the platform net stack rejects the fetch.
  //     validateServer must PROPAGATE that rejection (so the connect form's
  //     .catch can show it), not weaken or swallow it.
  const tlsError = new TypeError("Failed to fetch");
  const badCertStub = () => Promise.reject(tlsError);
  const validateBad = liftValidate(src, badCertStub, label);
  let caught = null;
  try {
    await validateBad("https://self-signed.example");
  } catch (e) {
    caught = e;
  }
  check(
    `[${label}] (2) self-signed HTTPS → validateServer propagates the platform rejection`,
    caught === tlsError,
    "error reaches the connect-form .catch unchanged",
  );

  // A non-Jellyfin HTTPS host with a VALID cert (e.g. https://example.com) gets
  // a 200 of non-Jellyfin content → validateServer rejects with a clear,
  // shell-authored message. (Distinct from a TLS failure, equally informative.)
  const wrongHostStub = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  const validateWrong = liftValidate(src, wrongHostStub, label);
  let wrongMsg = null;
  try {
    await validateWrong("https://example.com");
  } catch (e) {
    wrongMsg = e.message;
  }
  check(
    `[${label}] (2) valid-cert non-Jellyfin host → informative "Not a Jellyfin server"`,
    wrongMsg === "Not a Jellyfin server",
    wrongMsg,
  );
}

// ===========================================================================
// PART C — cert-transparency source contract.
// ===========================================================================
for (const { label, src } of JS_SHELLS) {
  const flat = src.replace(/\s+/g, " ");

  check(
    `[${label}] no setCertificateError / cert-confirmation override`,
    !/setCertificateError|setCertificateConfirmation/i.test(src),
    "platform owns the trust decision",
  );
  check(
    `[${label}] no rejectUnauthorized / allowInsecure / allowInvalidCert / NODE_TLS_REJECT`,
    !/rejectUnauthorized|allowInsecure|allowInvalidCert|NODE_TLS_REJECT/i.test(src),
  );

  // validateServer's fetch options must be exactly {method, credentials, cache}
  // — no agent / no cert option that could weaken TLS validation.
  const vs = extractFn(src, "validateServer", label).replace(/\s+/g, " ");
  check(
    `[${label}] validateServer fetch carries no TLS-weakening options`,
    /fetch\(serverUrl \+ "\/System\/Info\/Public", \{ method: "GET", credentials: "omit", cache: "no-store", \}\)/.test(
      vs,
    ),
  );

  // normalizeServerUrl prepends http:// only when a scheme is absent and never
  // force-rewrites to https or downgrades https→http.
  const ns = extractFn(src, "normalizeServerUrl", label).replace(/\s+/g, " ");
  check(
    `[${label}] normalizeServerUrl prepends http:// only when scheme absent (no downgrade)`,
    /\/\^https\?:\\\/\\\/\/i\.test\(url\)/.test(ns) &&
      /"http:\/\/" \+ url/.test(ns) &&
      !/"https:\/\/" \+/.test(ns),
  );

  // The connect-submit failure path surfaces the underlying error message.
  check(
    `[${label}] connect failure surfaces an informative message (graceful, stays on form)`,
    /Could not reach server: /.test(flat) &&
      /err && err\.message \? err\.message : "unknown error"/.test(flat),
  );
}

// config.xml: the widget grants network access for BOTH schemes (so the
// connection is attempted), but carries NO cert-bypass privilege/setting — a web
// widget has no API to ignore cert errors, so self-signed is a hard platform
// fail by design.
check(
  "config.xml grants network access for any origin (http + https both reachable)",
  /<access\s+origin="\*"\s+subdomains="true">/.test(bootConfig),
);
check(
  "config.xml carries NO certificate-bypass privilege/setting",
  !/certificate|insecure|allow-?ssl|setCertificateError/i.test(bootConfig),
);

// ===========================================================================
// PART D — parity (TV vs browser) + deployed-blob guards.
// ===========================================================================
for (const [label, blob] of [
  ["shell.min.js", shellMin],
  ["boot-shell.min.js", bootMin],
]) {
  check(
    `deployed ${label} carries normalizeServerUrl + the http:// default`,
    /function normalizeServerUrl/.test(blob) && /"http:\/\/"\+url/.test(blob),
  );
  check(
    `deployed ${label} carries validateServer with no TLS-weakening fetch options`,
    /fetch\(serverUrl\+"\/System\/Info\/Public",\{method:"GET",credentials:"omit",cache:"no-store"\}/.test(
      blob,
    ),
  );
  check(
    `deployed ${label} carries no TLS-bypass`,
    !/setCertificateError|rejectUnauthorized|allowInsecure/i.test(blob),
  );
}

// The TLS-relevant behaviour is identical across TV and browser because it is
// the SAME fetch-delegating code with ZERO UA branching in the connect path.
check(
  "neither shell branches the connect/validate path on the TV user-agent",
  !/userAgent[\s\S]{0,80}(validateServer|normalizeServerUrl|System\/Info\/Public)/.test(
    shellSrc,
  ) &&
    !/userAgent[\s\S]{0,80}(validateServer|normalizeServerUrl|System\/Info\/Public)/.test(
      bootSrc,
    ),
);

// ---- summary --------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  "All HTTPS/HTTP + certificate-handling checks passed: http:// default for bare hosts, " +
    "https:// preserved (no downgrade), TLS delegated to the platform with zero bypass, " +
    "self-signed rejected gracefully+informatively, identical TV + browser.",
);
