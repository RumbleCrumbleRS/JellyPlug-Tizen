// JEL-197 (parent JEL-196) — shell-side JS-Injector snippet channel.
//
// The Tizen shell document.writes the server's /web/index.html. JEL-196 retires
// the JellyPlug Shell Loader .NET plugin (which File-Transformation-appends the
// snippets to runtime.bundle.js) by having the shell fetch the JS Injector's
// public.js itself, so the TV runs the SAME source a browser does. This test
// pins the channel's behaviour on BOTH shipped artifacts:
//
//   1. injectJsInjectorChannel adds exactly ONE
//      <script src="${server}/JavaScriptInjector/public.js"
//              data-shell-jsi-channel="1"> to <body> when none is present, so
//      it flows through the existing transpileLegacyScripts firewall.
//   2. Idempotent: if the document already references a public.js tag (server-
//      or plugin-injected), the channel adds nothing — public.js never runs
//      twice, and the channel coexists with the FT blob during cutover.
//   3. Killswitch: localStorage['jellyfin.shell.jsiChannelDisabled']='1' is
//      honoured (no injection), so the feature can be turned off on-device.
//   4. The warm-boot string fast path bails ("jsiChannel") when the channel is
//      on and the html carries no public.js, so the DOMParser path runs the
//      injection + transpile (the fast path can't transpile an injected tag).
//   5. loadRemoteWebClient actually calls the channel, and the killswitch key +
//      path constant are byte-identical across both shells (lockstep).
//
// The behavioural cases extract the SHIPPED functions straight from source and
// run them in an isolated vm against a tiny DOM mock — real code, not a re-impl.
//
// Run: node scripts/jsi-snippet-channel.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Brace-match a `function NAME(...) {...}` declaration, skipping string bodies.
function extractFunction(src, name, file) {
  const start = src.indexOf("function " + name);
  if (start === -1) throw new Error(`no function ${name} in ${file}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name} in ${file}`);
}

// Minimal DOM mock: enough for injectJsInjectorChannel's querySelector +
// createElement + body.appendChild. querySelector matches the channel's
// `script[src*="..."]` substring selector against scripts in <body>.
function makeDoc(existingSrcs) {
  const scripts = (existingSrcs || []).map((src) => ({
    tagName: "script",
    src,
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
  }));
  const body = {
    appendChild(el) {
      scripts.push(el);
      return el;
    },
  };
  return {
    body,
    __scripts: scripts,
    createElement() {
      return {
        tagName: "script",
        src: "",
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        getAttribute(k) {
          return this.attrs[k];
        },
      };
    },
    querySelector(sel) {
      // Only the channel's substring selector is used.
      const m = /script\[src\*="([^"]+)"\]/.exec(sel);
      if (!m) return null;
      const needle = m[1];
      return scripts.find((s) => (s.src || "").indexOf(needle) >= 0) || null;
    },
  };
}

function loadChannel(file) {
  const src = fs.readFileSync(file, "utf8");
  const harness =
    extractFunction(src, "jsiChannelDisabled", file) +
    "\n" +
    // JEL-204: jsiChannelPath() resolves the (overridable) delivery route.
    extractFunction(src, "jsiChannelPath", file) +
    "\n" +
    extractFunction(src, "injectJsInjectorChannel", file) +
    "\n" +
    // The path/key constants live in a `var` block; redeclare them here from the
    // shipped literals so the extracted functions resolve them in the sandbox.
    'var JSI_CHANNEL_DISABLED_KEY = "jellyfin.shell.jsiChannelDisabled";\n' +
    'var JSI_CHANNEL_PATH_KEY = "jellyfin.shell.jsiChannelPath";\n' +
    'var JSI_PUBLIC_PATH = "/JavaScriptInjector/public.js";\n' +
    "globalThis.__inject = injectJsInjectorChannel;\n" +
    "globalThis.__disabled = jsiChannelDisabled;\n" +
    "globalThis.__path = jsiChannelPath;\n";
  const store = {};
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(harness, sandbox);
  return {
    inject: sandbox.__inject,
    disabled: sandbox.__disabled,
    path: sandbox.__path,
    store,
  };
}

const SERVER = "http://tv.example.test:8096";
const EXPECTED = SERVER + "/JavaScriptInjector/public.js";

for (const [label, file] of [
  ["shell.js", SHELL],
  ["boot-shell.src.js", BOOT],
]) {
  const m = loadChannel(file);

  // Case 1: clean document → injects exactly one public.js tag at body end.
  let doc = makeDoc([]);
  m.inject(doc, SERVER);
  const added = doc.__scripts.filter(
    (s) => (s.src || "").indexOf("/JavaScriptInjector/public.js") >= 0,
  );
  check(label + ": injects exactly one public.js tag", added.length === 1);
  check(
    label + ": injected src is ${server}/JavaScriptInjector/public.js",
    added.length === 1 && added[0].src === EXPECTED,
    added.length ? "got " + added[0].src : "none injected",
  );
  check(
    label + ": injected tag carries data-shell-jsi-channel marker",
    added.length === 1 &&
      added[0].getAttribute("data-shell-jsi-channel") === "1",
  );

  // Case 2: document already has a public.js (server/plugin injected) → no dup.
  doc = makeDoc([SERVER + "/JavaScriptInjector/public.js?v=12345"]);
  m.inject(doc, SERVER);
  const pubCount = doc.__scripts.filter(
    (s) => (s.src || "").indexOf("/JavaScriptInjector/public.js") >= 0,
  ).length;
  check(
    label + ": idempotent — does not add a second public.js",
    pubCount === 1,
    "found " + pubCount + " public.js tags",
  );
  check(
    label + ": idempotent — existing tag left untouched (no channel marker)",
    doc.__scripts[0].getAttribute("data-shell-jsi-channel") === undefined,
  );

  // Case 3: killswitch on → no injection.
  m.store["jellyfin.shell.jsiChannelDisabled"] = "1";
  check(
    label + ": jsiChannelDisabled() reflects killswitch",
    m.disabled() === true,
  );
  doc = makeDoc([]);
  m.inject(doc, SERVER);
  check(
    label + ": killswitch suppresses injection",
    doc.__scripts.length === 0,
  );
  delete m.store["jellyfin.shell.jsiChannelDisabled"];
  check(
    label + ": jsiChannelDisabled() default is false",
    m.disabled() === false,
  );

  // Case 4: tolerates a document with no body (defensive — never throws).
  let threw = false;
  try {
    m.inject({ querySelector: () => null }, SERVER);
  } catch (_) {
    threw = true;
  }
  check(label + ": no body → no throw", threw === false);

  // Case 5 (JEL-204): path defaults to public.js, and a localStorage override
  // redirects the channel so the delivery route is not a hardcoded constant.
  check(
    label + ": jsiChannelPath() defaults to /JavaScriptInjector/public.js",
    m.path() === "/JavaScriptInjector/public.js",
  );
  m.store["jellyfin.shell.jsiChannelPath"] = "/MyDelivery/snippets.js";
  check(
    label + ": jsiChannelPath() honours the override key",
    m.path() === "/MyDelivery/snippets.js",
  );
  doc = makeDoc([]);
  m.inject(doc, SERVER);
  const overridden = doc.__scripts.filter(
    (s) => (s.src || "").indexOf("/MyDelivery/snippets.js") >= 0,
  );
  check(
    label + ": override injects ${server}<override path>, not public.js",
    overridden.length === 1 &&
      overridden[0].src === SERVER + "/MyDelivery/snippets.js" &&
      doc.__scripts.filter((s) => (s.src || "").indexOf("public.js") >= 0)
        .length === 0,
  );
  // Empty/whitespace override falls back to the default (no blank route).
  m.store["jellyfin.shell.jsiChannelPath"] = "";
  check(
    label + ": empty override falls back to the default path",
    m.path() === "/JavaScriptInjector/public.js",
  );
  delete m.store["jellyfin.shell.jsiChannelPath"];
}

// Source-level wiring assertions across both shells.
for (const [label, file] of [
  ["shell.js", SHELL],
  ["boot-shell.src.js", BOOT],
]) {
  const src = fs.readFileSync(file, "utf8");
  check(
    label + ": loadRemoteWebClient calls injectJsInjectorChannel",
    /injectJsInjectorChannel\(doc, serverUrl\)/.test(src),
  );
  check(
    label + ': fast path bails for the channel (bail("jsiChannel"))',
    /bail\("jsiChannel"\)/.test(src),
  );
}

// Lockstep: the killswitch key + path constant must match across both shells.
function literal(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(src);
  return m ? m[1] : null;
}
for (const c of ["JSI_CHANNEL_DISABLED_KEY", "JSI_PUBLIC_PATH"]) {
  const a = literal(SHELL, c);
  const b = literal(BOOT, c);
  check(
    "lockstep: " + c + " identical across both shells",
    a !== null && a === b,
    "shell.js=" + a + " vs boot-shell.src.js=" + b,
  );
}

if (failures) {
  console.error("\nJEL-197 jsi-snippet-channel FAILED: " + failures);
  process.exit(1);
}
console.log("\nAll JEL-197 jsi-snippet-channel checks passed.");
