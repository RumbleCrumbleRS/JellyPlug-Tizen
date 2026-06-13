// JEL-83 verification — HTTPS vs HTTP server connections + certificate handling,
// compared TV-shell vs hosted/browser-shell.
//
// What the issue asks us to prove:
//   1. HTTPS connections work without certificate warnings;
//   2. self-signed / invalid certs are handled gracefully (or the error message
//      is informative);
//   3. normalizeServerUrl correctly prepends http:// for bare hostnames;
//   plus: compare browser behaviour for invalid certs.
//
// The decisive insight — and why this is testable WITHOUT a TV or a server:
//   The shell carries ZERO TLS code. Every server connection (the
//   /System/Info/Public probe AND the /web/ client load) goes through `fetch`,
//   never a top-level cross-origin navigation. So the certificate trust
//   decision belongs entirely to the platform net stack (M63 WebView on the TV,
//   modern Chromium in the browser):
//     • valid public cert  → fetch resolves → the shell never renders a cert UI,
//       so "HTTPS works without warnings" holds by CONSTRUCTION;
//     • self-signed / bad cert → fetch REJECTS → the connect form's .catch
//       surfaces  "Could not reach server: " + err.message  and stays on the
//       form. Graceful (no crash) + informative-as-a-failure, identical on both
//       platforms.
//   The browser's clickable "proceed anyway" interstitial only exists for
//   top-level navigation — which this shell never does to the server — so an
//   invalid-cert server is non-bypassable on BOTH platforms by the same code.
//
// What is left for the shell to own, and what this guard pins:
//   • normalizeServerUrl: prepend http:// for bare hosts, PRESERVE explicit
//     https://, never downgrade https→http, strip trailing slashes. Run the
//     REAL function lifted from each shell over a table of inputs.
//   • validateServer is a transparent conduit: it neither weakens TLS (no cert
//     options on the fetch) nor swallows a rejection. Run it with a fetch stub
//     that resolves (valid cert) and one that rejects (bad cert) and assert it
//     faithfully propagates both.
//   • source-contract cert-transparency: no setCertificateError / WebSetting /
//     rejectUnauthorized / allowInsecure anywhere; the catch surfaces the
//     message; identical across both shells + the deployed .min blobs.
//
// The richer narrated walk (all 4 artifacts + the shell-core TS source, full
// input matrix, browser-vs-TV writeup) lives at
//   tooling/tv-validate/https-certificates/verify-https-certificates.mjs
// and is documented in
//   tooling/tv-validate/https-certificates/results-JEL-83.md
//
// Run: node scripts/https-certificates.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const HOSTED_SHELL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const HOSTED_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name);
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const hostedSrc = fs.readFileSync(HOSTED_SHELL, "utf8");
const hostedMin = fs.readFileSync(HOSTED_SHELL_MIN, "utf8");

// Extract a `function name(...) { ... }` declaration verbatim by brace-matching.
// normalizeServerUrl / validateServer carry no brace-bearing string or regex
// literals beyond the scheme regex (which has no unbalanced brace), so a plain
// depth counter is exact.
function extractFn(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1)
    throw new Error(label + ": function " + name + " not found");
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

// Lift the REAL normalizeServerUrl out of a source and return the callable fn.
function liftNormalize(src, label) {
  const sandbox = { console };
  vm.createContext(sandbox);
  return vm.runInContext(
    extractFn(src, "normalizeServerUrl", label) + "\n;normalizeServerUrl;",
    sandbox,
  );
}

// Lift the REAL validateServer with an injectable fetch stub.
// Some shells wrap the probe in a boot-timeout helper
// (e.g. withBootTimeout(fetch(...), "connect", CONNECT_FETCH_TIMEOUT_MS)).
// Provide a pass-through stub + a timeout constant so the lift works against
// BOTH the bare-fetch and the wrapped shape — the TLS transparency we assert
// (resolve / reject is propagated, fetch carries no cert options) is identical
// either way, and the timeout wrapper must not change it.
function liftValidate(src, fetchStub, label) {
  const sandbox = {
    fetch: fetchStub,
    withBootTimeout: (p) => p,
    CONNECT_FETCH_TIMEOUT_MS: 5000,
    console,
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    extractFn(src, "validateServer", label) + "\n;validateServer;",
    sandbox,
  );
}

// ---------------------------------------------------------------------------
// (3) normalizeServerUrl — bare host → http://, https:// preserved, never
//     downgraded, trailing slashes stripped, whitespace trimmed.
// ---------------------------------------------------------------------------
// [input, expected] — the shipped JS contract (empty string → "").
const CASES = [
  // bare hostname → DEFAULT http:// (the issue's core claim 3)
  ["jellyfin.ddns.example", "http://jellyfin.ddns.example"],
  ["jellyfin.local:8096", "http://jellyfin.local:8096"],
  ["192.168.1.50:8096", "http://192.168.1.50:8096"],
  // explicit https:// PRESERVED — never downgraded to http
  ["https://jellyfin.ddns.example", "https://jellyfin.ddns.example"],
  ["https://jelly.example:8920", "https://jelly.example:8920"],
  // explicit http:// preserved
  ["http://192.168.1.50:8096", "http://192.168.1.50:8096"],
  // trailing slash(es) stripped for clean concatenation
  ["https://jelly.example/", "https://jelly.example"],
  ["https://jelly.example///", "https://jelly.example"],
  ["jelly.example/", "http://jelly.example"],
  // whitespace trimmed
  ["  jellyfin.local:8096  ", "http://jellyfin.local:8096"],
  // scheme test is case-insensitive → no spurious prepend; case preserved
  ["HTTPS://Host", "HTTPS://Host"],
  ["HtTp://Host", "HtTp://Host"],
  // empty / blank → "" (shipped JS contract; see TS divergence in the .mjs)
  ["", ""],
  ["   ", ""],
];

const NORMALIZERS = [
  { label: "TV shell.js", fn: liftNormalize(tvSrc, "TV shell.js") },
  { label: "TV shell.min.js", fn: liftNormalize(tvMin, "TV shell.min.js") },
  {
    label: "hosted boot-shell.src.js",
    fn: liftNormalize(hostedSrc, "hosted boot-shell.src.js"),
  },
  {
    label: "hosted boot-shell.min.js",
    fn: liftNormalize(hostedMin, "hosted boot-shell.min.js"),
  },
];

for (const { label, fn } of NORMALIZERS) {
  for (const [input, expected] of CASES) {
    const got = fn(input);
    check(
      label +
        ": normalizeServerUrl(" +
        JSON.stringify(input) +
        ") === " +
        JSON.stringify(expected) +
        (got === expected ? "" : "  (got " + JSON.stringify(got) + ")"),
      got === expected,
    );
  }
}

// Cross-artifact parity: every input maps to the SAME output across all four
// artifacts (the function is byte-identical; this proves behaviour matches).
for (const [input] of CASES) {
  const outs = NORMALIZERS.map((n) => n.fn(input));
  check(
    "normalizeServerUrl parity across all 4 artifacts for " +
      JSON.stringify(input),
    outs.every((o) => o === outs[0]),
  );
}

// ---------------------------------------------------------------------------
// (1)+(2) validateServer is a transparent TLS conduit: it propagates whatever
//         the platform net stack decides — RESOLVE on a trusted cert, REJECT on
//         a self-signed / untrusted one — without weakening or swallowing it.
// ---------------------------------------------------------------------------
async function transparency(src, label) {
  // Valid-cert path: fetch resolves with a real Jellyfin /System/Info/Public.
  const okStub = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ Id: "abc", Version: "10.10.0" }),
    });
  const validate = liftValidate(src, okStub, label);
  let resolvedInfo = null;
  try {
    resolvedInfo = await validate("https://jellyfin.ddns.example");
  } catch (_) {
    resolvedInfo = null;
  }
  check(
    label +
      ": (1) valid-cert HTTPS → validateServer resolves (no cert UI is ever shown)",
    resolvedInfo && resolvedInfo.Id === "abc",
  );

  // Self-signed / untrusted path: the platform net stack rejects the fetch
  // (in real Chromium a TLS failure surfaces as a TypeError "Failed to fetch").
  const tlsError = new TypeError("Failed to fetch");
  const badCertStub = () => Promise.reject(tlsError);
  const validateBad = liftValidate(src, badCertStub, label);
  let rejected = null;
  try {
    await validateBad("https://self-signed.example");
    rejected = false;
  } catch (e) {
    rejected = e;
  }
  check(
    label +
      ": (2) self-signed HTTPS → validateServer faithfully PROPAGATES the rejection (not swallowed)",
    rejected === tlsError,
  );
  check(
    label +
      ": (2) the propagated error carries a message the connect form can show",
    !!(rejected && rejected.message),
  );
}

// ---------------------------------------------------------------------------
// Source-contract: certificate transparency + informative error surfacing.
// ---------------------------------------------------------------------------
function certContract(src, label) {
  const flat = src.replace(/\s+/g, " ");

  // No TLS-bypass / cert-override anywhere — the platform owns the decision.
  // (Match the actual Tizen cert APIs; jellyfin-web's unrelated
  // `webSettings.getConfig()` server-config call is NOT a TLS override.)
  check(
    label + ": no setCertificateError / cert-confirmation override",
    !/setCertificateError|setCertificateConfirmation/i.test(src),
  );
  check(
    label +
      ": no rejectUnauthorized / allowInsecure / allowInvalidCert weakening",
    !/rejectUnauthorized|allowInsecure|allowInvalidCert|NODE_TLS_REJECT/i.test(
      src,
    ),
  );

  // validateServer's fetch carries ONLY method/credentials/cache — no option
  // that could weaken TLS validation.
  const vs = extractFn(src, "validateServer", label).replace(/\s+/g, " ");
  check(
    label + ": validateServer fetch passes no TLS-weakening options",
    /fetch\(serverUrl \+ "\/System\/Info\/Public", \{ method: "GET", credentials: "omit", cache: "no-store", \}\)/.test(
      vs,
    ),
  );

  // normalizeServerUrl prepends http:// only for schemeless input and never
  // rewrites an explicit scheme (so https stays https).
  const ns = extractFn(src, "normalizeServerUrl", label).replace(/\s+/g, " ");
  check(
    label + ": normalizeServerUrl prepends http:// only when scheme is absent",
    /\/\^https\?:\\\/\\\/\/i\.test\(url\)/.test(ns) &&
      /"http:\/\/" \+ url/.test(ns),
  );
  check(
    label +
      ": normalizeServerUrl never force-rewrites to https:// or downgrades",
    !/"https:\/\/" \+/.test(ns) &&
      !/replace\([^)]*https?:\/\/[^)]*http:/.test(ns),
  );

  // The connect-submit failure path surfaces the server error message and
  // stays on the form (graceful, informative).
  check(
    label + ": connect failure surfaces an informative message via showError",
    /Could not reach server: /.test(flat) &&
      /err && err\.message \? err\.message : "unknown error"/.test(flat),
  );
}

// ---------------------------------------------------------------------------
// Parity + deployed-blob guards.
// ---------------------------------------------------------------------------
function parity() {
  // The two source-of-record shells spell normalizeServerUrl differently
  // (shell.js uses an explicit if-form; boot-shell.src.js the pre-minified
  // ternary), but they are BEHAVIOURALLY identical — already proven by the
  // 4-artifact input-matrix parity above. Here we pin the shared contract
  // tokens (scheme regex + http:// default) so neither shell can drift.
  for (const [label, s] of [
    ["TV shell.js", tvSrc],
    ["hosted boot-shell.src.js", hostedSrc],
  ]) {
    const ns = extractFn(s, "normalizeServerUrl", label).replace(/\s+/g, " ");
    check(
      label + ": normalizeServerUrl carries the scheme regex + http:// default",
      /\/\^https\?:\\\/\\\/\/i\.test\(url\)/.test(ns) &&
        /"http:\/\/" \+ url/.test(ns),
    );
  }
  for (const [label, blob] of [
    ["shell.min.js", tvMin],
    ["boot-shell.min.js", hostedMin],
  ]) {
    check(
      "deployed " + label + " carries normalizeServerUrl + the http:// default",
      /function normalizeServerUrl/.test(blob) && /"http:\/\/"\+url/.test(blob),
    );
    check(
      "deployed " + label + " carries no TLS-bypass",
      !/setCertificateError|rejectUnauthorized|allowInsecure/i.test(blob),
    );
  }
}

(async () => {
  console.log("--- (3) normalizeServerUrl input matrix (4 artifacts) ---");
  // (cases already run above synchronously)

  console.log(
    "\n--- (1)+(2) validateServer TLS transparency (resolve + reject) ---",
  );
  await transparency(tvSrc, "TV shell.js");
  await transparency(hostedSrc, "hosted boot-shell.src.js");

  console.log("\n--- cert-transparency source contract (both shells) ---");
  certContract(tvSrc, "TV shell.js");
  certContract(hostedSrc, "hosted boot-shell.src.js");

  console.log("\n--- parity (TV vs browser/hosted) + deployed-blob guards ---");
  parity();

  if (failures) {
    console.error("\n" + failures + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nAll HTTPS/HTTP + certificate-handling checks passed.");
})();
