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

// Brace-match a `function NAME(...) {...}` declaration, skipping string
// bodies AND comments (JEL-621: an apostrophe inside a `//` comment — e.g.
// "isn't" — previously opened a phantom quote and the match ran past the
// real close brace; it only ever worked by byte-layout luck).
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
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i === -1) break;
      i += 1;
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
    // JEL-618: the cache functions hash bodies with the shipped txFnv1a.
    extractFunction(src, "txFnv1a", file) +
    "\n" +
    extractFunction(src, "jsiChannelDisabled", file) +
    "\n" +
    // JEL-204: jsiChannelPath() resolves the (overridable) delivery route.
    extractFunction(src, "jsiChannelPath", file) +
    "\n" +
    // JEL-618: chunked channel-body cache.
    extractFunction(src, "jsiChannelMaxAge", file) +
    "\n" +
    extractFunction(src, "jsiChannelCacheClear", file) +
    "\n" +
    extractFunction(src, "jsiChannelCacheGet", file) +
    "\n" +
    extractFunction(src, "jsiChannelCacheSet", file) +
    "\n" +
    extractFunction(src, "injectJsInjectorChannel", file) +
    "\n" +
    // The path/key constants live in a `var` block; redeclare them here from the
    // shipped literals so the extracted functions resolve them in the sandbox.
    'var JSI_CHANNEL_DISABLED_KEY = "jellyfin.shell.jsiChannelDisabled";\n' +
    'var JSI_CHANNEL_PATH_KEY = "jellyfin.shell.jsiChannelPath";\n' +
    'var JSI_PUBLIC_PATH = "/JavaScriptInjector/public.js";\n' +
    // JEL-618: record constants + a fixed TX_VER stand-in (the shipped one
    // hashes babel inputs; the cache only ever compares it for equality).
    'var JSI_CHANNEL_META_KEY = "jellyfin.shell.jsiChannel.meta";\n' +
    'var JSI_CHANNEL_CHUNK_PFX = "jellyfin.shell.jsiChannel.c";\n' +
    'var JSI_CHANNEL_MAXAGE_KEY = "jellyfin.shell.jsiChannelMaxAgeMs";\n' +
    "var JSI_CHANNEL_MAXAGE_DEFAULT = 21600000;\n" +
    "var JSI_CHANNEL_CHUNK_LEN = 131072;\n" +
    "var JSI_CHANNEL_MAX_CHUNKS = 32;\n" +
    'var TX_VER = "txv-test";\n' +
    "globalThis.__inject = injectJsInjectorChannel;\n" +
    "globalThis.__disabled = jsiChannelDisabled;\n" +
    "globalThis.__path = jsiChannelPath;\n" +
    "globalThis.__cacheGet = jsiChannelCacheGet;\n" +
    "globalThis.__cacheSet = jsiChannelCacheSet;\n" +
    "globalThis.__cacheClear = jsiChannelCacheClear;\n" +
    "globalThis.__setNow = function (n) { Date.now = function () { return n; }; };\n";
  const store = {};
  let failSetAfter = Infinity;
  let setCalls = 0;
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        if (++setCalls > failSetAfter) throw new Error("QuotaExceededError");
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
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
    cacheGet: sandbox.__cacheGet,
    cacheSet: sandbox.__cacheSet,
    cacheClear: sandbox.__cacheClear,
    setNow: sandbox.__setNow,
    // Arm the localStorage mock to throw (quota) after n more setItem calls.
    failSetAfter: (n) => {
      failSetAfter = n;
      setCalls = 0;
    },
    store,
  };
}

const SERVER = "http://tv.example.test:8096";
// JEL-216: the channel src carries a stable `?_jsi=1` marker query so the URL
// is query-bearing — transpileLegacyScripts then routes it through the JEL-178
// content-addressed / cache-busted freshness path instead of the bare-URL cache
// (which was never re-validated on a snippet edit). channelPath stays a
// substring of src so the idempotency guard still matches.
const JSI_Q = "?_jsi=1";
const EXPECTED = SERVER + "/JavaScriptInjector/public.js" + JSI_Q;

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
    label + ": injected src is ${server}/JavaScriptInjector/public.js?_jsi=1",
    added.length === 1 && added[0].src === EXPECTED,
    added.length ? "got " + added[0].src : "none injected",
  );
  check(
    label +
      ": JEL-216 — channel src is query-bearing (routes through freshness path)",
    added.length === 1 && added[0].src.indexOf("?") >= 0,
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
      overridden[0].src === SERVER + "/MyDelivery/snippets.js" + JSI_Q &&
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

  // ---- JEL-618: chunked channel-body cache ------------------------------

  // Case 6: roundtrip — set stores chunks+meta, get returns the exact body.
  const c = loadChannel(file);
  c.setNow(1000000000000);
  const smallBody = 'window.__snip=1;/*es5 body*/"x";';
  c.cacheSet(smallBody);
  check(
    label + ": JEL-618 cache roundtrip returns the exact body",
    c.cacheGet() === smallBody,
  );
  const meta6 = JSON.parse(c.store["jellyfin.shell.jsiChannel.meta"]);
  check(
    label + ": JEL-618 meta records TX_VER + single chunk",
    meta6.v === "txv-test" && meta6.n === 1 && meta6.l === smallBody.length,
  );

  // Case 7: a body over one chunk splits and rejoins losslessly.
  const bigBody = "var pad='" + "a".repeat(300000) + "';";
  c.cacheSet(bigBody);
  const meta7 = JSON.parse(c.store["jellyfin.shell.jsiChannel.meta"]);
  check(
    label + ": JEL-618 >128KiB body chunks (n=3) and rejoins losslessly",
    meta7.n === 3 && c.cacheGet() === bigBody,
  );
  check(
    label + ": JEL-618 shrinking rewrite leaves no orphan chunks",
    (c.cacheSet(smallBody),
    c.store["jellyfin.shell.jsiChannel.c1"] === undefined &&
      c.cacheGet() === smallBody),
  );

  // Case 8: inject() with a fresh cache inlines the body — no src fetch tag.
  let cdoc = makeDoc([]);
  c.inject(cdoc, SERVER);
  check(
    label + ": JEL-618 cached inject inlines exactly one script, no src",
    cdoc.__scripts.length === 1 &&
      !cdoc.__scripts[0].src &&
      cdoc.__scripts[0].textContent === smallBody,
  );
  check(
    label + ": JEL-618 cached inject carries channel + cached markers",
    cdoc.__scripts[0].getAttribute("data-shell-jsi-channel") === "1" &&
      cdoc.__scripts[0].getAttribute("data-shell-jsi-cached") === "1",
  );
  // Killswitch + idempotency still beat the cache.
  c.store["jellyfin.shell.jsiChannelDisabled"] = "1";
  cdoc = makeDoc([]);
  c.inject(cdoc, SERVER);
  check(
    label + ": JEL-618 killswitch suppresses cached inject too",
    cdoc.__scripts.length === 0,
  );
  delete c.store["jellyfin.shell.jsiChannelDisabled"];
  cdoc = makeDoc([SERVER + "/JavaScriptInjector/public.js?v=1"]);
  c.inject(cdoc, SERVER);
  check(
    label + ": JEL-618 existing public.js tag suppresses cached inject",
    cdoc.__scripts.length === 1,
  );

  // Case 9: freshness — TTL expiry, override key, and '0' = disabled.
  check(
    label + ": JEL-618 body within default TTL is served",
    (c.setNow(1000000000000 + 21599000), c.cacheGet() === smallBody),
  );
  check(
    label + ": JEL-618 body older than default TTL is stale",
    (c.setNow(1000000000000 + 21600001), c.cacheGet() === null),
  );
  check(
    label + ": JEL-618 backdated clock (meta.t in the future) is stale too",
    (c.setNow(1000000000000 - 21600001), c.cacheGet() === null),
  );
  c.setNow(1000000000000);
  c.store["jellyfin.shell.jsiChannelMaxAgeMs"] = "1000";
  check(
    label + ": JEL-618 maxAge override key shortens the window",
    (c.setNow(1000000000000 + 1001), c.cacheGet() === null),
  );
  c.store["jellyfin.shell.jsiChannelMaxAgeMs"] = "0";
  c.setNow(1000000000000);
  check(label + ": JEL-618 maxAge '0' disables reads", c.cacheGet() === null);
  const before0 = c.store["jellyfin.shell.jsiChannel.meta"];
  c.cacheSet("var neverStored=1;");
  check(
    label + ": JEL-618 maxAge '0' disables writes",
    c.store["jellyfin.shell.jsiChannel.meta"] === before0,
  );
  delete c.store["jellyfin.shell.jsiChannelMaxAgeMs"];

  // Case 10: integrity — TX_VER mismatch, missing chunk, tampered chunk.
  c.setNow(1000000000000);
  c.cacheSet(smallBody);
  const goodMeta = c.store["jellyfin.shell.jsiChannel.meta"];
  c.store["jellyfin.shell.jsiChannel.meta"] = goodMeta.replace(
    "txv-test",
    "txv-other",
  );
  check(
    label + ": JEL-618 TX_VER mismatch invalidates the record",
    c.cacheGet() === null,
  );
  c.store["jellyfin.shell.jsiChannel.meta"] = goodMeta;
  const goodChunk = c.store["jellyfin.shell.jsiChannel.c0"];
  delete c.store["jellyfin.shell.jsiChannel.c0"];
  check(
    label + ": JEL-618 missing chunk invalidates the record",
    c.cacheGet() === null,
  );
  c.store["jellyfin.shell.jsiChannel.c0"] = goodChunk.slice(0, -1) + "!";
  check(
    label + ": JEL-618 tampered chunk fails the hash check",
    c.cacheGet() === null,
  );
  c.store["jellyfin.shell.jsiChannel.c0"] = goodChunk;
  check(
    label + ": JEL-618 restored record reads again (sanity)",
    c.cacheGet() === smallBody,
  );

  // Case 11: quota failure mid-write drops the whole record (no half state).
  c.failSetAfter(1);
  c.cacheSet(bigBody);
  c.failSetAfter(Infinity);
  check(
    label + ": JEL-618 quota mid-write clears meta + chunks",
    c.store["jellyfin.shell.jsiChannel.meta"] === undefined &&
      c.store["jellyfin.shell.jsiChannel.c0"] === undefined &&
      c.cacheGet() === null,
  );

  // Case 12: clear() empties the record.
  c.cacheSet(smallBody);
  c.cacheClear();
  check(
    label + ": JEL-618 cacheClear removes the record",
    c.cacheGet() === null &&
      c.store["jellyfin.shell.jsiChannel.meta"] === undefined,
  );
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
  // JEL-618: fast path splices a fresh cached body instead of bailing …
  check(
    label + ": fast path splices the cached channel body before </body>",
    src.indexOf(
      '\'<script data-shell-jsi-channel="1" data-shell-jsi-cached="1">\'',
    ) >= 0 && /bail\("jsiChannelNoBody"\)/.test(src),
  );
  // … but never when a "</script" literal would corrupt the document.
  check(
    label + ': fast path guards "</script" bodies (jsiChannelScriptClose)',
    /bail\("jsiChannelScriptClose"\)/.test(src),
  );
  // JEL-618: the walker must skip the inlined cached body (a string-literal
  // pre-check false positive re-babeling ~1MB would refund the entire win).
  check(
    label + ": transpile walker skips data-shell-jsi-cached scripts",
    /getAttribute\("data-shell-jsi-cached"\) === "1"/.test(src),
  );
  // JEL-618: all three finalize branches (txc pre-hit, raw fast path, babel
  // output) adopt the finished channel body into the channel cache.
  const recordHooks = (
    src.match(/(?<!function )jsiChannelCacheSet\((pre|bodyRaw|body)\)/g) || []
  ).length;
  check(
    label + ": all 3 transpile finalize branches record the channel body",
    recordHooks === 3,
    "found " + recordHooks,
  );
}

// Lockstep: the killswitch key + path constant must match across both shells.
function literal(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(src);
  return m ? m[1] : null;
}
for (const c of [
  "JSI_CHANNEL_DISABLED_KEY",
  "JSI_PUBLIC_PATH",
  // JEL-618: cache record keys must stay lockstep — both shells read the
  // SAME localStorage record (boot-shell writes it, hosted shell reads it,
  // and vice versa across upgrade paths).
  "JSI_CHANNEL_META_KEY",
  "JSI_CHANNEL_CHUNK_PFX",
  "JSI_CHANNEL_MAXAGE_KEY",
]) {
  const a = literal(SHELL, c);
  const b = literal(BOOT, c);
  check(
    "lockstep: " + c + " identical across both shells",
    a !== null && a === b,
    "shell.js=" + a + " vs boot-shell.src.js=" + b,
  );
}
// JEL-618: numeric cache constants lockstep (chunking geometry + TTL).
function numericLiteral(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const m = new RegExp(name + "\\s*=\\s*([0-9]+)").exec(src);
  return m ? m[1] : null;
}
for (const c of [
  "JSI_CHANNEL_MAXAGE_DEFAULT",
  "JSI_CHANNEL_CHUNK_LEN",
  "JSI_CHANNEL_MAX_CHUNKS",
]) {
  const a = numericLiteral(SHELL, c);
  const b = numericLiteral(BOOT, c);
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
