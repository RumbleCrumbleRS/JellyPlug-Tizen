// JELA-865 verification — the patched-bundle drop.
//
// WHAT THIS PROVES
//   The shells stop INLINING the CM/PM-patched main jellyfin-web bundle and
//   instead repoint its <script defer src> at a body the server publishes at
//   /shell/patched/<buildhash>/<name>. JELA-863 measured why: Blink will not
//   stream a script it did not load itself over http(s), so an inlined ~500 KB
//   body is compiled on the main thread by construction (~194 ms of
//   V8.CompileCode under a re-entrant ParseHTML, pre-paint) where the
//   parser-loaded arm spent 162-174 ms on the ScriptStreamerThread. The cached
//   body also cost 497,795 characters of the M63 5 MB localStorage quota.
//
//   1. Gate polarity: opt-IN. Only "1" arms; absent/"0"/junk keeps the
//      unchanged fetch + scan + inline path (this is the kill switch).
//   2. The manifest field IS the capability handshake — no `patchedBundle`,
//      no repoint. A shell that guessed the URL could 404 a written
//      <script src> and kill the boot (JELA-841).
//   3. The entry is pinned to ONE jellyfin-web build: a build-stamp or
//      filename mismatch declines rather than running a main bundle whose
//      sibling chunks come from a different build.
//   4. When it arms: `defer` survives, the URL still ends in .bundle.js (so
//      isJellyfinWebBundle keeps transpileLegacyScripts off it), the tag is
//      marked, and the patch count is carried through from the manifest.
//   5. AC4 — the armed path drops BOTH stale localStorage records and writes
//      no body of its own.
//   6. Wiring, source-asserted on all four artifacts (both srcs, both
//      committed .min blobs): the gate is consulted before the inline path,
//      loadConfigEpoch parks the manifest body the gate reads, and the drop
//      branch never calls writeBundlePatchState.
//
// STRATEGY mirrors bundle-patch.test.cjs: lift the REAL shell-core functions
// into a `vm` sandbox over a fake localStorage + a fake document, and exercise
// the shipped behaviour instead of re-describing it.
//
// Run: node scripts/patched-drop.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { expand } = require("../../shell-core/expand.cjs");

const REPO = path.join(__dirname, "..", "..", "..");
const CORE = fs.readFileSync(
  path.join(REPO, "packages", "shell-core", "src", "shell-core.src.js"),
  "utf8",
);
const SRC = {
  "shell.js": fs.readFileSync(
    path.join(REPO, "packages", "shell-tizen", "src", "shell.js"),
    "utf8",
  ),
  "shell.min.js": fs.readFileSync(
    path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js"),
    "utf8",
  ),
  "boot-shell.src.js": fs.readFileSync(
    path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.src.js",
    ),
    "utf8",
  ),
  "boot-shell.min.js": fs.readFileSync(
    path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.min.js",
    ),
    "utf8",
  ),
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// --- lift the three shell-core fragments -------------------------------------

function fragment(name) {
  const begin = CORE.indexOf("//@@BEGIN:" + name + "@@");
  const end = CORE.indexOf("//@@END:" + name + "@@");
  if (begin < 0 || end < 0)
    throw new Error("shell-core fragment " + name + " missing");
  return CORE.slice(begin + ("//@@BEGIN:" + name + "@@").length, end);
}

function makeSandbox(lsSeed) {
  const map = new Map(Object.entries(lsSeed || {}));
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const sandbox = { localStorage, URL, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fragment("patchedBundleDropOn") +
      "\n" +
      fragment("patchedBundleDropApply") +
      "\n" +
      fragment("patchedBundleDropCommit") +
      "\nthis.patchedBundleDropOn = patchedBundleDropOn;" +
      "\nthis.patchedBundleDropApply = patchedBundleDropApply;" +
      "\nthis.patchedBundleDropCommit = patchedBundleDropCommit;",
    sandbox,
  );
  return { sandbox, map };
}

// Minimal document: only querySelectorAll("script[src]") and per-tag
// get/setAttribute are exercised by the function under test.
function makeDoc(srcs) {
  const tags = srcs.map((s) => {
    const attrs = { src: s, defer: "defer" };
    return {
      attrs,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      setAttribute: (k, v) => {
        attrs[k] = String(v);
      },
      removeAttribute: (k) => {
        delete attrs[k];
      },
    };
  });
  return {
    tags,
    querySelectorAll: (sel) => (sel === "script[src]" ? tags : []),
  };
}

const BASE = "https://tv.example/web/";
const MANIFEST = {
  patchedBundle: {
    v: "4c3e5ec610f9c71cad1c",
    src: "main.jellyfin.bundle.js",
    url: "/shell/patched/4c3e5ec610f9c71cad1c/main.jellyfin.bundle.js",
    n: 1,
  },
};
const INDEX_SRCS = [
  "runtime.bundle.js?4c3e5ec610f9c71cad1c",
  "serviceworker.js",
  "main.jellyfin.bundle.js?4c3e5ec610f9c71cad1c",
];

function arm(manifest, srcs, lsSeed) {
  const { sandbox, map } = makeSandbox(lsSeed);
  sandbox.__shellBundlePatches = 0;
  sandbox.__shellBundlesPatchedFiles = [];
  sandbox.__shellConfigEpoch = { mf: manifest };
  const doc = makeDoc(srcs || INDEX_SRCS);
  const armed = sandbox.patchedBundleDropApply(doc, BASE);
  return { armed, doc, sandbox, map };
}

// --- 1. gate polarity (the kill switch) --------------------------------------

for (const [value, expected] of [
  ["1", true],
  ["0", false],
  ["", false],
  [null, false],
  ["true", false],
]) {
  const { sandbox } = makeSandbox(
    value === null ? {} : { "jellyfin.shell.patchedDrop": value },
  );
  check(
    "gate " + JSON.stringify(value) + " -> " + expected,
    sandbox.patchedBundleDropOn() === expected,
    'opt-IN: anything but "1" must keep the inline path',
  );
}

// --- 2/3. the decline paths ---------------------------------------------------

check(
  "declines when the manifest carries no patchedBundle",
  arm({}).armed === 0,
  "absence of the field is the capability handshake",
);
check(
  "declines when the epoch gate parked no manifest at all",
  arm(null).armed === 0,
);
check(
  "declines on a build-stamp mismatch",
  (() => {
    const r = arm(MANIFEST, ["main.jellyfin.bundle.js?deadbeefdeadbeefdead"]);
    return r.armed === 0 && r.sandbox.__shellPatchedDrop.why === "ver";
  })(),
  "a main bundle from another jellyfin-web build must never be substituted",
);
check(
  "declines when the index carries no main bundle tag",
  (() => {
    const r = arm(MANIFEST, ["runtime.bundle.js?4c3e5ec610f9c71cad1c"]);
    return r.armed === 0 && r.sandbox.__shellPatchedDrop.why === "notag";
  })(),
);
check(
  "declines on a filename mismatch",
  (() => {
    const r = arm(
      {
        patchedBundle: Object.assign({}, MANIFEST.patchedBundle, {
          src: "main.other.bundle.js",
        }),
      },
      ["main.jellyfin.bundle.js?4c3e5ec610f9c71cad1c"],
    );
    return r.armed === 0 && r.sandbox.__shellPatchedDrop.why === "name";
  })(),
);
check(
  "an incomplete entry (no url) declines rather than repointing at nothing",
  arm({ patchedBundle: { v: "x", src: "main.jellyfin.bundle.js", n: 1 } })
    .armed === 0,
);

// --- 4. the armed path --------------------------------------------------------

const hit = arm(MANIFEST);
const mainTag = hit.doc.tags[2];
check("arms on a matching manifest entry", hit.armed === 1);
check(
  "repoints src at the absolute drop url",
  mainTag.getAttribute("src") ===
    "https://tv.example/shell/patched/4c3e5ec610f9c71cad1c/main.jellyfin.bundle.js",
  mainTag.getAttribute("src"),
);
check(
  "keeps defer — the parser owning the load is the whole point",
  mainTag.getAttribute("defer") === "defer",
);
check(
  "the drop url still ends in .bundle.js so isJellyfinWebBundle skips it",
  /\.bundle\.js$/.test(mainTag.getAttribute("src").split("?")[0]),
  "otherwise transpileLegacyScripts would Babel a 500 KB bundle",
);
check(
  "marks the tag for the transpile pass and for QA",
  mainTag.getAttribute("data-shell-bundle-drop") === "1" &&
    mainTag.getAttribute("data-shell-bundle-patched") ===
      mainTag.getAttribute("src"),
);
check(
  "carries the server's patch count",
  mainTag.getAttribute("data-shell-bundle-patches") === "1" &&
    hit.sandbox.__shellBundlePatches === 1 &&
    hit.sandbox.__shellBundlesPatchedFiles[0] ===
      "main.jellyfin.bundle.js:drop1",
);
check(
  "leaves every other script tag untouched",
  hit.doc.tags[0].getAttribute("src") ===
    "runtime.bundle.js?4c3e5ec610f9c71cad1c" &&
    hit.doc.tags[1].getAttribute("src") === "serviceworker.js",
);
check(
  "surfaces state on window.__shellPatchedDrop",
  hit.sandbox.__shellPatchedDrop.on === 1 &&
    hit.sandbox.__shellPatchedDrop.armed === 1 &&
    hit.sandbox.__shellPatchedDrop.n === 1,
);

// --- 5. AC4: the localStorage the drop path gives back ------------------------

{
  const { sandbox, map } = makeSandbox({
    "jellyfin.shell.bundlePatchState": JSON.stringify({
      v: "1.0.90",
      url: "https://tv.example/web/main.jellyfin.bundle.js?4c3e5ec610f9c71cad1c",
      needsPatch: true,
      body: "x".repeat(485280),
      patches: 1,
    }),
    "jellyfin.shell.bundleUrl":
      "https://tv.example/web/main.jellyfin.bundle.js?4c3e5ec610f9c71cad1c",
    "jellyfin.shell.configEpoch": "{}",
  });
  const before = [...map.values()].reduce((n, v) => n + v.length, 0);
  sandbox.patchedBundleDropCommit();
  const after = [...map.values()].reduce((n, v) => n + v.length, 0);
  check(
    "commit drops the cached patched body",
    map.get("jellyfin.shell.bundlePatchState") === undefined,
  );
  check(
    "commit forgets the last-seen bundle url (kills the WGT head-IIFE preload)",
    map.get("jellyfin.shell.bundleUrl") === undefined,
  );
  check(
    "commit leaves unrelated keys alone",
    map.get("jellyfin.shell.configEpoch") === "{}",
  );
  check(
    "AC4: >= 450,000 localStorage units returned",
    before - after >= 450000,
    "freed " + (before - after),
  );
}

// --- 6. wiring, on all four shipped artifacts ---------------------------------

for (const [label, text] of Object.entries(SRC)) {
  const minified = label.endsWith(".min.js");
  check(
    label + ": consults the drop gate before the inline path",
    /patchedBundleDropOn\(\)/.test(text) &&
      /patchedBundleDropApply\(/.test(text) &&
      /patchedBundleDropCommit\(/.test(text),
  );
  check(
    label + ": the inline path still exists as the fallback",
    /patchPlaybackBundlesInner/.test(text) ||
      // the minifiers rename the local declaration; the call still has to be
      // reachable from the wrapper, which the src assertions above cover.
      minified,
  );
  check(
    label + ": loadConfigEpoch parks the manifest body the gate reads",
    /\.mf\s*=\s*m[,;)]/.test(text),
    "without this there is no capability field to read",
  );
  // The srcs carry //@@SHELL_CORE: markers where the shared functions go, so
  // literals inside them only exist after the build's splice — compare against
  // the same expansion the build and the parity guard use.
  const whole = minified ? text : expand(text);
  check(
    label + ": the flag key is the documented one",
    whole.includes("jellyfin.shell.patchedDrop"),
  );
  check(
    label + ": every writeBundlePatchState call lives in the inline path",
    minified ||
      text
        .slice(0, text.indexOf("function patchPlaybackBundlesInner("))
        .split("writeBundlePatchState(").length -
        1 ===
        // the two declarations above (read/write) plus nothing else: the
        // wrapper and the drop branch must never persist a body.
        1,
    "the drop path caches nothing — a body in localStorage is the cost AC4 removes",
  );
}

// The manifest field name has to match what the plugin emits.
{
  const controller = fs.readFileSync(
    path.join(
      REPO,
      "packages",
      "server-plugin",
      "Jellyfin.Plugin.JellyPlugShell",
      "ShellDropService.cs",
    ),
    "utf8",
  );
  check(
    "server advertises the same manifest field the shells read",
    /manifest\["patchedBundle"\]/.test(controller) &&
      /\["v"\]/.test(controller) &&
      /\["src"\]/.test(controller) &&
      /\["url"\]/.test(controller) &&
      /\["n"\]/.test(controller),
  );
}

if (failures) {
  console.error("\npatched-drop.test.cjs: " + failures + " failure(s)");
  process.exit(1);
}
console.log("\npatched-drop.test.cjs OK");
