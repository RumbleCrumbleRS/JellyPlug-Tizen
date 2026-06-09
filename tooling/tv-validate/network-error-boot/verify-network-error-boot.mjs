#!/usr/bin/env node
// JEL-63 — Compare: Network error handling — server unreachable at boot.
//
// Scenario: a server URL is already saved (warm boot) but the host is now
// unreachable. The issue asks us to verify, on BOTH TV and browser, that:
//   (1) the /web/index.html fetch times out GRACEFULLY (bounded, not a hang);
//   (2) an error message is displayed to the user;
//   (3) the connect screen reappears, allowing re-entry;
//   (4) the saved server URL is NOT cleared (the user can retry the same host);
//   (5) the error message text is identical on both platforms.
//
// ── Why these requirements were not all met before, and what changed ────────
// shell.js (TV) and the hosted boot-shell run the SAME bootstrap() boot path —
// there is no per-UA branch around the failure handling, so requirements (2),
// (3) and (5) hold by construction. But the original code:
//   • had NO timeout on the index.html / config.json fetches → on an
//     unreachable-but-routable host (SYN dropped) the boot hung for the
//     platform's default TCP connect timeout, which differs between Tizen
//     Chromium and desktop Chrome → req (1) was not bounded and not parity-equal;
//   • called clearServerUrl() in the boot-failure catch → req (4) was violated:
//     the saved URL WAS wiped, forcing a full retype.
// JEL-63 adds withBootTimeout() (a UA-independent bounded race, safe on
// Chromium 56 which predates AbortController), drops the clearServerUrl() call,
// and pre-fills the connect form with the saved URL. This harness proves all
// five requirements against the REAL shell.js boot path.
//
// ── What this harness does ──────────────────────────────────────────────────
//  PART A (source): structural guards on shell.js asserting the fix is present
//    and the regression (clearServerUrl on boot failure) cannot creep back.
//  PART B (runtime): execute the ACTUAL shell.js IIFE end-to-end in a vm under a
//    modern-browser navigator AND a legacy Tizen navigator, with a saved server
//    URL and a fetch that (b1) hangs forever, then (b2) rejects immediately —
//    the two faces of "unreachable". Observe the resulting connect-screen DOM
//    and localStorage to assert reqs (1)-(5) on both platforms.
//
// No server needed — the failure path never touches the network for real (the
// fetch is stubbed to model the unreachable host). Exits non-zero on any FAIL.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const SHELL_JS = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");

const SAVED_URL = "https://unreachable.jellyplug.test";
const EXPECTED_ERROR =
  "Could not reach saved server. Check your network and try again.";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const UAS = {
  browser:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  // Tizen 5.5 TV — legacy Chromium 69 (regex-detectable as <70). The legacy UA
  // exercises isLegacyChromium()===true through the same failure handler.
  tv: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36 Chrome/69.0.3497.106",
};

// ===================================================================
// PART A — source structure guards on shell.js (source of record).
// shell.min.js is a release-time esbuild artifact rebuilt at the next
// release cut, so the binding asserts the SOURCE only.
// ===================================================================
function partA() {
  const src = fs.readFileSync(SHELL_JS, "utf8");
  const flat = src.replace(/\s+/g, "");

  // (1) bounded timeout helper exists with the documented 15 s bound and is
  // applied to BOTH critical boot fetches.
  check(
    "shell.js defines withBootTimeout() with a 15 s bound",
    /var BOOT_FETCH_TIMEOUT_MS = 15000;/.test(src) &&
      /function withBootTimeout\(/.test(src),
    "BOOT_FETCH_TIMEOUT_MS=15000 + withBootTimeout()",
  );
  check(
    "withBootTimeout wraps the /web/index.html fetch (web client)",
    /var indexFetch = withBootTimeout\(/.test(src),
    "indexFetch = withBootTimeout(...)",
  );
  check(
    "withBootTimeout wraps the /web/config.json fetch (web config)",
    /var configFetch = withBootTimeout\(/.test(src),
    "configFetch = withBootTimeout(...)",
  );
  // timeout is implemented as a Promise.race-style timer (works on Chromium 56,
  // which has no AbortController) — assert the rejecting setTimeout shape.
  check(
    "timeout rejects via setTimeout (AbortController-free, Chromium-56 safe)",
    /setTimeout\(function\(\)\{if\(settled\)return;settled=true;reject\(newError\("Timedoutreachingserver/.test(
      flat,
    ),
    "setTimeout → reject('Timed out reaching server')",
  );

  // (4) the boot-failure catch must NOT clear the saved server URL.
  const bootCatch = src.slice(
    src.indexOf("loadRemoteWebClient(stored).catch"),
    src.indexOf("} else {", src.indexOf("loadRemoteWebClient(stored).catch")),
  );
  check(
    "boot-failure catch does NOT call clearServerUrl() (saved URL preserved)",
    bootCatch.length > 0 && !/clearServerUrl\(\)/.test(bootCatch),
    bootCatch.length > 0 ? "no clearServerUrl() in the catch" : "catch not found",
  );
  // (2)+(5) the error string is a single literal emitted from the UA-independent
  // catch — so it is byte-identical on both platforms.
  check(
    "boot-failure catch shows the exact, UA-independent error text",
    bootCatch.includes(EXPECTED_ERROR),
    JSON.stringify(EXPECTED_ERROR),
  );
  // the error string appears exactly once in the file (no UA-forked variant).
  const occurrences = src.split(EXPECTED_ERROR).length - 1;
  check(
    "error text is defined exactly once (no per-platform fork)",
    occurrences === 1,
    `${occurrences} occurrence(s)`,
  );

  // retry affordance: attachConnectForm pre-fills the saved URL.
  check(
    "attachConnectForm pre-fills the saved server URL for one-press retry",
    /if \(!input\.value\) \{\s*var saved = loadServerUrl\(\);\s*if \(saved\) input\.value = saved;/.test(
      src,
    ),
    "input.value = loadServerUrl() when empty",
  );
}

// ===================================================================
// PART B — run the REAL shell.js boot path in a vm.
// A faithful-but-minimal fake DOM (only the connect-screen elements
// index.html declares) + a fake localStorage seeded with the saved
// URL + a stubbed fetch modelling the unreachable host.
// ===================================================================
function makeEl(id) {
  return {
    id: id || "",
    tagName: "DIV",
    style: {},
    hidden: false,
    value: "",
    textContent: "",
    rel: "",
    as: "",
    href: "",
    _kids: [],
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) {
      this._kids.push(c);
      return c;
    },
    insertBefore(c) {
      this._kids.push(c);
      return c;
    },
    remove() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    getBoundingClientRect() {
      return { width: 0, height: 0 };
    },
    get firstChild() {
      return this._kids[0] || null;
    },
    get nextSibling() {
      return null;
    },
  };
}

// Run a single boot under one UA + one fetch failure mode. Returns the observed
// connect-screen state plus the timeout delays the real code requested.
function runBoot(ua, fetchMode) {
  const els = {
    "boot-root": makeEl("boot-root"),
    "server-form": makeEl("server-form"),
    "server-input": makeEl("server-input"),
    "boot-error": Object.assign(makeEl("boot-error"), { hidden: true }),
  };
  const head = makeEl("head");
  const body = makeEl("body");

  const store = new Map([["jellyfin.shell.serverUrl", SAVED_URL]]);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const document = {
    readyState: "complete",
    head,
    body,
    documentElement: makeEl("html"),
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
  };

  // fetch models the unreachable host: either an eternal hang (must be rescued
  // by the bounded timeout) or an immediate network reject (connection refused).
  const fetch = () =>
    fetchMode === "hang"
      ? new Promise(() => {})
      : Promise.reject(new TypeError("Failed to fetch"));

  // Compress the real 15 000 ms bound so the harness runs fast, and record the
  // delays the production code requested (proves the bound is genuinely 15 s).
  const timeoutDelays = [];
  const fakeSetTimeout = (fn, ms) => {
    timeoutDelays.push(ms);
    return setTimeout(fn, ms >= 1000 ? 25 : ms);
  };

  const win = {
    addEventListener() {},
    removeEventListener() {},
    close() {},
  };
  const sandbox = {
    window: win,
    document,
    navigator: { userAgent: ua },
    localStorage,
    fetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: (t) => clearTimeout(t),
    setInterval: () => 0,
    clearInterval: () => {},
    Promise,
    JSON,
    Math,
    Date,
    RegExp,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    console: { log() {}, warn() {}, error() {} },
    performance: { now: () => 0 },
  };
  win.localStorage = localStorage;
  win.document = document;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  // Execute the real shell.js. Its trailing bootstrap() fires synchronously
  // (readyState==='complete'); the failure .catch resolves on a later tick.
  vm.runInContext(fs.readFileSync(SHELL_JS, "utf8"), sandbox, {
    filename: "shell.js",
  });

  return new Promise((resolve) => {
    // Give the bounded timeout (compressed to 25 ms) + the catch microtasks
    // room to run, then snapshot the connect-screen state.
    setTimeout(() => {
      resolve({
        errorText: els["boot-error"].textContent,
        errorVisible: els["boot-error"].hidden === false,
        connectShown: els["boot-root"].style.display === "block",
        urlPreserved: store.get("jellyfin.shell.serverUrl") === SAVED_URL,
        inputPrefilled: els["server-input"].value === SAVED_URL,
        timeoutDelays,
      });
    }, 200);
  });
}

async function partB() {
  for (const mode of ["hang", "reject"]) {
    const label = mode === "hang" ? "unreachable (timeout)" : "refused (reject)";
    const obs = {};
    for (const [plat, ua] of Object.entries(UAS)) {
      obs[plat] = await runBoot(ua, mode);
    }

    for (const plat of ["browser", "tv"]) {
      const o = obs[plat];
      // (1) graceful, bounded recovery — for the hang mode this is ONLY possible
      // because withBootTimeout fired; we also assert the requested bound is 15 s.
      if (mode === "hang") {
        check(
          `[${plat}/${label}] boot recovered via the bounded timeout (no hang)`,
          o.connectShown && o.errorVisible,
          "connect screen + error rendered despite an eternal fetch",
        );
        check(
          `[${plat}/${label}] timeout bound requested is 15 s (parity-equal across platforms)`,
          o.timeoutDelays.includes(15000),
          `delays requested: ${o.timeoutDelays.join(", ")}`,
        );
      } else {
        check(
          `[${plat}/${label}] boot recovered gracefully on immediate reject`,
          o.connectShown && o.errorVisible,
          "connect screen + error rendered",
        );
      }
      // (2) error message displayed.
      check(
        `[${plat}/${label}] error message displayed to the user`,
        o.errorVisible && o.errorText === EXPECTED_ERROR,
        JSON.stringify(o.errorText),
      );
      // (3) connect screen reappears.
      check(
        `[${plat}/${label}] connect screen reappears (boot-root revealed)`,
        o.connectShown,
        "boot-root display:block",
      );
      // (4) saved URL NOT cleared.
      check(
        `[${plat}/${label}] saved server URL is NOT cleared`,
        o.urlPreserved,
        o.urlPreserved ? "serverUrl still in localStorage" : "URL WAS WIPED",
      );
      // retry affordance: the form is pre-filled with the saved URL.
      check(
        `[${plat}/${label}] connect form pre-filled with saved URL (one-press retry)`,
        o.inputPrefilled,
        o.inputPrefilled ? "input.value === savedUrl" : `input='${o.inputPrefilled}'`,
      );
    }

    // (5) error text identical across platforms.
    check(
      `[${label}] error text identical on TV and browser`,
      obs.browser.errorText === obs.tv.errorText &&
        obs.browser.errorText === EXPECTED_ERROR,
      JSON.stringify(obs.browser.errorText),
    );
  }
}

async function main() {
  console.log("== PART A: shell.js source structure (timeout + no-clear + prefill) ==");
  partA();
  console.log("\n== PART B: real shell.js boot-failure path under both UAs ==");
  await partB();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("harness error:", e?.stack || e?.message || e);
  process.exit(1);
});
