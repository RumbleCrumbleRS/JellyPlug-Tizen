// JELA-848 regression test — the babel <script src> repoint.
//
// JELA-841 shipped two fixes and only one of them can reach a TV that is
// already in the field: the parse-time absolute BABEL_SRC rides the WGT
// (reinstall only), and the ensureBabelReady() absolute fallback was measured
// NEVER TO EXECUTE on the boot that hangs — both its call sites sit behind a
// tx-drop cache MISS on the per-script slow path, and the hanging boot dies
// before the static walk starts. So the mitigation had to move to the one
// place the shell is already holding the bootstrap's tag: the script
// interceptor.
//
// This test executes the SHIPPING seed source (lifted out of the string array
// in both shells, exactly like tx-gen-sweep.test.cjs) inside a stub DOM, and
// pins the four properties the fix is worth nothing without:
//
//   1. A babel.min.js src is satisfied from the ABSOLUTE ${S}/shell/ drop.
//      Not the relative URL (that is the bug: once the shell is served from
//      localStorage it wins the <base href> race and the relative URL
//      resolves to ${S}/web/babel.min.js -> 404), and not the file:// WGT
//      sibling (Chromium blocks a file:// fetch issued from script — that
//      variant was tried on the rig and still hung on "Failed to fetch").
//
//   2. The 486 KB drop body NEVER enters the JEL-557 tx cache. srcPipeline
//      ends in __txSet(src,body); localStorage on a fielded TV already sits
//      at 69.7% of the 5,242,880 UTF-16 code-unit M63 quota (JELA-843/844),
//      and a FULL store costs +49% requests and +49% bytes on every later
//      boot. The branch must return before __txGet/__txSet AND before
//      __recDyn, which would otherwise prime the same URL next boot.
//
//   3. The node's load/error listeners are ALWAYS settled — on success, on a
//      failed drop fetch, and when Babel is already present. The bootstrap's
//      __ensureBabel wraps them in a settle() funnel that every later
//      transpile awaits; leaving it unsettled hangs the boot just as dead as
//      the 404 did.
//
//   4. Ordinary plugin scripts are untouched: they still record and still go
//      through the cache.
//
// Run: node scripts/babel-repoint.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELLS = [
  ["shell.js", path.join(REPO, "packages", "shell-tizen", "src", "shell.js")],
  [
    "boot-shell.src.js",
    path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.src.js",
    ),
  ],
];

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? " — " + detail : ""));
    failures++;
  }
}

// --- lift the shipping seed source -----------------------------------------
//
// The seed is an array of string literals joined at build time. A one-line
// function is a single literal; a multi-line one spans consecutive literals
// (plus // comments, which are not part of the emitted body). Walk from the
// declaration line collecting eval'd literals until the braces balance.

function seedLines(src) {
  return src.split("\n").map((l) => l.trim());
}

function liftSeedFn(src, name, label) {
  const lines = seedLines(src);
  const head = lines.findIndex(
    (t) => /^['"]/.test(t) && t.includes("function " + name + "("),
  );
  if (head === -1) throw new Error(label + ": seed fn " + name + " not found");
  let body = "";
  let depth = 0;
  for (let i = head; i < lines.length; i++) {
    const t = lines[i];
    if (!/^['"]/.test(t)) continue; // comment line between literals
    // eslint-disable-next-line no-eval
    const piece = eval(t.replace(/,\s*$/, ""));
    body += piece + "\n";
    for (const ch of piece) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && body.includes("{")) return body;
  }
  throw new Error(label + ": could not close seed fn " + name);
}

// --- one compiled sandbox per shell ----------------------------------------

const DROP_BODY = 'window.Babel={transform:function(){return{code:""}}};';

function compile(src, label, opts) {
  const o = opts || {};
  const calls = {
    fetch: [],
    recDyn: [],
    txGet: [],
    txSet: [],
    events: [],
    lsWrites: [],
  };

  const ls = {
    setItem: function (k, v) {
      calls.lsWrites.push([k, String(v).length]);
    },
    getItem: function () {
      return null;
    },
    removeItem: function () {},
    key: function () {
      return null;
    },
    length: 0,
  };

  const sandbox = {
    console: { warn: function () {}, error: function () {}, log: function () {} },
    setTimeout: setTimeout,
    Promise: Promise,
    localStorage: ls,
    S: "https://srv.example",
    document: {
      createElement: function (tag) {
        return mkNode(tag);
      },
      head: mkNode("head"),
      documentElement: mkNode("html"),
      createComment: function (t) {
        return { nodeType: 8, data: t };
      },
      createEvent: function () {
        return {
          initEvent: function (type) {
            this.type = type;
          },
        };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.fetch = function (url) {
    calls.fetch.push(String(url));
    if (o.dropFails) return Promise.reject(new Error("Failed to fetch"));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: function () {
        return Promise.resolve(DROP_BODY);
      },
    });
  };

  function mkNode(tag) {
    return {
      nodeName: String(tag || "script").toUpperCase(),
      attrs: {},
      children: [],
      parentNode: null,
      nextSibling: null,
      textContent: "",
      setAttribute: function (k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute: function (k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k)
          ? this.attrs[k]
          : null;
      },
      removeAttribute: function (k) {
        delete this.attrs[k];
      },
      appendChild: function (n) {
        n.parentNode = this;
        this.children.push(n);
        return n;
      },
      insertBefore: function (n) {
        n.parentNode = this;
        this.children.push(n);
        return n;
      },
      replaceChild: function (n) {
        n.parentNode = this;
        this.children.push(n);
        return n;
      },
      dispatchEvent: function () {},
    };
  }

  const ctx = vm.createContext(sandbox);

  // Stubs for everything srcPipeline/rewrite touch that is out of scope here.
  // dispatchEvt is the real seed implementation wrapped so the test can see
  // what settled; the rest are counters.
  const prelude = [
    "var __recDynCalls=[],__txGetCalls=[],__txSetCalls=[],__evts=[];",
    "function __recDyn(s){__recDynCalls.push(String(s));}",
    "function __txGet(s){__txGetCalls.push(String(s));return null;}",
    "function __txSet(s,b){__txSetCalls.push([String(s),b.length]);}",
    'function dispatchEvt(node,type){__evts.push(type);try{var f=node["on"+type];if(typeof f==="function")f({type:type,target:node});}catch(_){}}',
    "function needsJq(){return false;}",
    "function wrapJq(c){return c;}",
    "function needsTx(){return false;}",
    "function maybeTranspile(c){return c;}",
    "function __txDropGet(){return Promise.resolve(null);}",
    "function __ensureBabelDyn(){return Promise.resolve(true);}",
    "function __txResolve(c){return Promise.resolve(c);}",
  ].join("\n");

  const body = [
    prelude,
    liftSeedFn(src, "__babelFromDrop", label),
    liftSeedFn(src, "__isBabelSrc", label),
    liftSeedFn(src, "__babelRepoint", label),
    liftSeedFn(src, "srcPipeline", label),
    liftSeedFn(src, "rewrite", label),
    "var __ebRep=null;",
  ].join("\n");

  vm.runInContext(body, ctx);
  return { ctx, calls, mkNode, run: (code) => vm.runInContext(code, ctx) };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

async function runShell(label, src) {
  console.log("\n== " + label + " ==");

  // --- 1. __isBabelSrc classification ---------------------------------------
  {
    const s = compile(src, label);
    const table = [
      ["babel.min.js", true, "the shipped 2.0.25 relative src"],
      ["./babel.min.js", true, "dot-relative"],
      ["/web/babel.min.js", true, "the 404 the race loss produces"],
      ["https://srv.example/web/babel.min.js", true, "absolute /web/ form"],
      ["file:///opt/usr/apps/x/res/wgt/babel.min.js", true, "WGT sibling"],
      ["https://srv.example/shell/babel.min.js", true, "the drop itself"],
      ["babel.min.js?v=2", true, "query stripped before matching"],
      ["babel.min.js#x", true, "fragment stripped before matching"],
      ["/web/not-babel.min.js", false, "different file, same suffix"],
      ["/web/babel.min.js.map", false, "sourcemap is not the script"],
      ["/web/babelmin.js", false, "near miss"],
      ["/web/plugin.js", false, "an ordinary plugin body"],
      ["", false, "empty"],
      [null, false, "null"],
    ];
    for (const [url, want, why] of table) {
      const got = s.run("__isBabelSrc(" + JSON.stringify(url) + ")");
      check(
        "__isBabelSrc(" + JSON.stringify(url) + ") === " + want + " (" + why + ")",
        got === want,
        "got " + got,
      );
    }
  }

  // --- 2. srcPipeline repoints to the ABSOLUTE drop, cache untouched --------
  {
    const s = compile(src, label);
    s.run(
      'var n=document.createElement("script");srcPipeline(n,"babel.min.js");',
    );
    await settle();
    const c = s.calls;
    check(
      "repoint fetches exactly one URL",
      c.fetch.length === 1,
      JSON.stringify(c.fetch),
    );
    check(
      "repoint fetches the ABSOLUTE /shell/ drop",
      c.fetch[0] === "https://srv.example/shell/babel.min.js",
      c.fetch[0],
    );
    check(
      "repoint never fetches a file:// URL (Chromium blocks it from script)",
      !c.fetch.some((u) => u.indexOf("file:") === 0),
      JSON.stringify(c.fetch),
    );
    check(
      "repoint never fetches the relative/base-resolved URL",
      !c.fetch.some((u) => /\/web\/babel\.min\.js/.test(u)),
      JSON.stringify(c.fetch),
    );
    check("window.Babel is defined after the drop", s.run('typeof window.Babel') === "object");
    check(
      "the node's load listener is settled",
      s.run("__evts.join(',')") === "load",
      s.run("__evts.join(',')"),
    );
    // AC3: the 486 KB body must not reach the tx cache, and must not be
    // recorded for next-boot priming either.
    check(
      "__txGet is never consulted for babel",
      s.run("__txGetCalls.length") === 0,
      s.run("JSON.stringify(__txGetCalls)"),
    );
    check(
      "__txSet never stores the babel body",
      s.run("__txSetCalls.length") === 0,
      s.run("JSON.stringify(__txSetCalls)"),
    );
    check(
      "__recDyn never primes the babel URL",
      s.run("__recDynCalls.length") === 0,
      s.run("JSON.stringify(__recDynCalls)"),
    );
    check(
      "localStorage is not written at all on the babel path",
      c.lsWrites.length === 0,
      JSON.stringify(c.lsWrites),
    );
    check(
      "the repoint is counted for the fleet probe",
      s.run("window.__shellBabelRepoint") === 1,
      String(s.run("window.__shellBabelRepoint")),
    );
  }

  // --- 3. Babel already present: settle without a fetch ---------------------
  {
    const s = compile(src, label);
    s.run("window.Babel={};");
    s.run(
      'var n=document.createElement("script");srcPipeline(n,"babel.min.js");',
    );
    await settle();
    check(
      "an already-loaded Babel costs no request",
      s.calls.fetch.length === 0,
      JSON.stringify(s.calls.fetch),
    );
    check(
      "and the node still settles with load",
      s.run("__evts.join(',')") === "load",
      s.run("__evts.join(',')"),
    );
  }

  // --- 4. A failed drop settles with error, never hangs ---------------------
  {
    const s = compile(src, label, { dropFails: true });
    s.run(
      'var n=document.createElement("script");srcPipeline(n,"babel.min.js");',
    );
    await settle();
    check(
      "a failed drop fetch settles the node with error, not silence",
      s.run("__evts.join(',')") === "error",
      s.run("__evts.join(',')"),
    );
    check(
      "and still writes nothing to the cache",
      s.run("__txSetCalls.length") === 0,
    );
  }

  // --- 5. Two tags share ONE in-flight drop fetch ---------------------------
  {
    const s = compile(src, label);
    s.run(
      'var a=document.createElement("script");var b=document.createElement("script");' +
        'srcPipeline(a,"babel.min.js");srcPipeline(b,"/web/babel.min.js");',
    );
    await settle();
    check(
      "a second babel tag reuses the in-flight fetch",
      s.calls.fetch.length === 1,
      JSON.stringify(s.calls.fetch),
    );
    check(
      "both nodes settle",
      s.run("__evts.join(',')") === "load,load",
      s.run("__evts.join(',')"),
    );
  }

  // --- 6. Ordinary plugin scripts are untouched -----------------------------
  {
    const s = compile(src, label);
    s.run(
      'var n=document.createElement("script");srcPipeline(n,"https://srv.example/web/plugin.js");',
    );
    await settle();
    check(
      "a plugin src is still recorded for priming",
      s.run("JSON.stringify(__recDynCalls)") ===
        JSON.stringify(["https://srv.example/web/plugin.js"]),
      s.run("JSON.stringify(__recDynCalls)"),
    );
    check(
      "a plugin src still consults the tx cache",
      s.run("__txGetCalls.length") === 1,
      s.run("JSON.stringify(__txGetCalls)"),
    );
    check(
      "and the repoint counter stays 0",
      s.run("window.__shellBabelRepoint") === undefined,
      String(s.run("window.__shellBabelRepoint")),
    );
  }

  // --- 7. The appendChild path repoints too, and strips the bad src ---------
  {
    const s = compile(src, label);
    s.run(
      'var p=document.createElement("div");var n=document.createElement("script");' +
        'n.setAttribute("src","babel.min.js");' +
        "rewrite(p,n,null,function(x){this.appendChild(x);return x;});",
    );
    await settle();
    check(
      "rewrite fetches the absolute drop",
      s.calls.fetch.length === 1 &&
        s.calls.fetch[0] === "https://srv.example/shell/babel.min.js",
      JSON.stringify(s.calls.fetch),
    );
    check(
      "rewrite strips src before inserting, so the browser never loads the 404",
      s.run('n.getAttribute("src")') === null,
      String(s.run('n.getAttribute("src")')),
    );
    check(
      "rewrite writes nothing to the tx cache",
      s.run("__txSetCalls.length") === 0 && s.run("__txGetCalls.length") === 0,
    );
  }
}

(async () => {
  for (const [label, file] of SHELLS) {
    await runShell(label, fs.readFileSync(file, "utf8"));
  }
  console.log(
    "\nbabel-repoint: " + (failures ? failures + " failure(s)" : "all checks passed"),
  );
  process.exit(failures ? 1 : 0);
})();
