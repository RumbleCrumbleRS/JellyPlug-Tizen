// JELA-986 — ResizeObserver + Intl.DisplayNames polyfills for the Tizen 5.0 /
// M63 engine.
//
// WHY
//   The first boot of the shell against Jellyfin 12.2.0 on the Chromium 63 rig
//   (JELA-112 harness) rendered the home screen, but two Jellyfin Enhanced
//   12.12 modules died at load time on APIs the M63 engine never shipped:
//     enhanced/header-actions.js  → ReferenceError: ResizeObserver is not defined
//     tags/languagetags.js        → TypeError: Intl.DisplayNames is not a constructor
//   Board rule: no upstream reports — the shell's chromium56PolyfillBody grows
//   the two shims, next to the Intl.RelativeTimeFormat one (JEL-404).
//
// WHAT THIS PROVES
//   1. The injected polyfill bytes (reconstructed from the string-array source,
//      exactly as they ship) install both globals when absent, and leave a
//      native implementation alone when present.
//   2. ResizeObserver: constructor/argument errors are TypeErrors like native;
//      observe() delivers an initial async entry, a size change delivers one
//      more, unobserve()/disconnect() stop delivery, entries carry
//      target/contentRect/borderBoxSize.
//   3. Intl.DisplayNames: `type` is required; language/region/script/currency
//      lookups; region/script qualifiers on language tags; fallback:"code"
//      returns the input and fallback:"none" returns undefined;
//      supportedLocalesOf / resolvedOptions shapes.
//   4. Parity: shell.js and the hosted boot-shell.src.js inject byte-identical
//      lines, and the release artifact shell.min.js carries both shims.
//
// Run: node scripts/m63-polyfills.test.cjs   (or via the package `test` script)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const HOSTED = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

const src = fs.readFileSync(SHELL, "utf8");
const min = fs.readFileSync(SHELL_MIN, "utf8");
const hosted = fs.readFileSync(HOSTED, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// The two shims are single quoted lines inside chromium56PolyfillBody's array.
// Pull them out verbatim and evaluate the string literals so we test the exact
// bytes that reach the device.
function extract(source, label, marker) {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => l.indexOf(marker) !== -1);
  if (idx === -1)
    throw new Error(label + ": line with " + marker + " not found");
  const line = lines[idx].trim().replace(/,$/, "");
  // eslint-disable-next-line no-new-func
  const str = new Function("return " + line)();
  if (typeof str !== "string")
    throw new Error(label + ": " + marker + " line is not a string literal");
  return str;
}
const RO_MARK = "window.ResizeObserver=";
const DN_MARK = "Intl.DisplayNames=";

function makeCtx(prelude) {
  // Minimal DOM: elements with mutable offset sizes, a window with
  // addEventListener, and real timers so the async notifications fire.
  const listeners = {};
  const win = {
    addEventListener: (n, f) => {
      (listeners[n] = listeners[n] || []).push(f);
    },
    __fire: (n) => (listeners[n] || []).forEach((f) => f()),
  };
  const ctx = {
    // window === the context global, so these become window.addEventListener etc.
    addEventListener: win.addEventListener,
    __fire: win.__fire,
    setTimeout,
    setInterval,
    clearInterval,
    console,
    JSON,
    makeEl: (w, h) => ({
      nodeType: 1,
      offsetWidth: w,
      offsetHeight: h,
      getBoundingClientRect() {
        return {
          left: 0,
          top: 0,
          right: this.offsetWidth,
          bottom: this.offsetHeight,
          width: this.offsetWidth,
          height: this.offsetHeight,
        };
      },
    }),
  };
  vm.createContext(ctx);
  // `window` must be the context global itself (as in a browser) so the
  // shims' bare `Intl` and `window.Intl` resolve to the same object.
  vm.runInContext("var window=this;" + (prelude || ""), ctx);
  return ctx;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ro = extract(src, "shell.js", RO_MARK);
  const dn = extract(src, "shell.js", DN_MARK);

  console.log("--- PART 1: install semantics ---");
  // Node ships Intl.DisplayNames natively; delete it to model the M63 engine.
  let ctx = makeCtx("delete Intl.DisplayNames;");
  vm.runInContext(ro + dn, ctx);
  check(
    "ResizeObserver installed when absent",
    typeof ctx.window.ResizeObserver === "function",
  );
  check(
    "Intl.DisplayNames installed when absent (window.Intl created)",
    typeof ctx.window.Intl.DisplayNames === "function",
  );
  ctx = makeCtx(
    "window.ResizeObserver=function NATIVE(){};Intl.DisplayNames=function NATIVEDN(){};",
  );
  vm.runInContext(ro + dn, ctx);
  check(
    "native ResizeObserver left untouched",
    ctx.window.ResizeObserver.name === "NATIVE",
  );
  check(
    "native Intl.DisplayNames left untouched",
    ctx.window.Intl.DisplayNames.name === "NATIVEDN",
  );

  console.log("\n--- PART 2: ResizeObserver behaviour ---");
  ctx = makeCtx();
  vm.runInContext(ro, ctx);
  const errs = vm.runInContext(
    "(function(){var a=[];try{window.ResizeObserver(function(){})}catch(e){a.push(e.name)}" +
      "try{new window.ResizeObserver(1)}catch(e){a.push(e.name)}" +
      "try{new window.ResizeObserver(function(){}).observe(null)}catch(e){a.push(e.name)}return a.join(',')})()",
    ctx,
  );
  check(
    "call without new / non-function callback / non-element observe → TypeError",
    errs === "TypeError,TypeError,TypeError",
    errs,
  );
  vm.runInContext(
    "var el=makeEl(100,20);var calls=[];var ro=new window.ResizeObserver(function(es,o){calls.push({n:es.length,w:es[0].contentRect.width,h:es[0].contentRect.height,t:es[0].target===el,o:o===ro,bb:es[0].borderBoxSize[0].inlineSize});});ro.observe(el);ro.observe(el);",
    ctx,
  );
  await sleep(30);
  let calls = vm.runInContext("JSON.stringify(calls)", ctx);
  check(
    "initial entry delivered asynchronously once (duplicate observe ignored)",
    calls === '[{"n":1,"w":100,"h":20,"t":true,"o":true,"bb":100}]',
    calls,
  );
  vm.runInContext("el.offsetWidth=200;window.__fire('resize');", ctx);
  await sleep(30);
  calls = vm.runInContext("JSON.stringify(calls.length)", ctx);
  check(
    "size change (resize event) delivers a second entry",
    calls === "2",
    calls,
  );
  vm.runInContext("el.offsetWidth=250;", ctx);
  await sleep(700);
  calls = vm.runInContext("JSON.stringify(calls.length)", ctx);
  check(
    "size change without an event is caught by the 500 ms sweep",
    calls === "3",
    calls,
  );
  vm.runInContext(
    "ro.unobserve(el);el.offsetWidth=300;window.__fire('resize');",
    ctx,
  );
  await sleep(30);
  calls = vm.runInContext("JSON.stringify(calls.length)", ctx);
  check("unobserve stops delivery", calls === "3", calls);
  vm.runInContext(
    "ro.observe(el);ro.disconnect();el.offsetWidth=310;window.__fire('resize');",
    ctx,
  );
  await sleep(30);
  calls = vm.runInContext("JSON.stringify(calls.length)", ctx);
  check("disconnect stops delivery", calls === "3", calls);
  const thrown = vm.runInContext(
    "(function(){var ok=true;var r=new window.ResizeObserver(function(){throw new Error('boom')});r.observe(makeEl(1,1));return ok})()",
    ctx,
  );
  await sleep(30);
  check("a throwing callback does not break the sweep", thrown === true);

  console.log("\n--- PART 3: Intl.DisplayNames behaviour ---");
  ctx = makeCtx("delete Intl.DisplayNames;");
  vm.runInContext(dn, ctx);
  const dnRes = JSON.parse(
    vm.runInContext(
      "JSON.stringify({" +
        "fr:new window.Intl.DisplayNames(['en'],{type:'language'}).of('fr')," +
        "ptbr:new window.Intl.DisplayNames('en',{type:'language'}).of('pt-BR')," +
        "zhHant:new window.Intl.DisplayNames('en',{type:'language'}).of('zh-Hant')," +
        "und:new window.Intl.DisplayNames('en',{type:'language'}).of('und')," +
        "unknown:new window.Intl.DisplayNames('en',{type:'language'}).of('xx')," +
        "none:String(new window.Intl.DisplayNames('en',{type:'language',fallback:'none'}).of('xx'))," +
        "region:new window.Intl.DisplayNames('en',{type:'region'}).of('de')," +
        "script:new window.Intl.DisplayNames('en',{type:'script'}).of('latn')," +
        "currency:new window.Intl.DisplayNames('en',{type:'currency'}).of('eur')," +
        "sup:window.Intl.DisplayNames.supportedLocalesOf(['en','de'])," +
        "opts:new window.Intl.DisplayNames('en',{type:'region'}).resolvedOptions()," +
        "noType:(function(){try{new window.Intl.DisplayNames('en');return 'no-throw'}catch(e){return e.name}})()," +
        "noNew:(function(){try{window.Intl.DisplayNames('en',{type:'language'});return 'no-throw'}catch(e){return e.name}})()" +
        "})",
      ctx,
    ),
  );
  check("language 'fr' → French", dnRes.fr === "French");
  check(
    "language 'pt-BR' → Portuguese (Brazil)",
    dnRes.ptbr === "Portuguese (Brazil)",
  );
  check(
    "language 'zh-Hant' → Chinese (Traditional Han)",
    dnRes.zhHant === "Chinese (Traditional Han)",
    dnRes.zhHant,
  );
  check("language 'und' → Unknown language", dnRes.und === "Unknown language");
  check(
    "unknown code falls back to the code (native default)",
    dnRes.unknown === "xx",
  );
  check("fallback:'none' → undefined", dnRes.none === "undefined");
  check("region 'de' → Germany (case-insensitive)", dnRes.region === "Germany");
  check("script 'latn' → Latin", dnRes.script === "Latin");
  check("currency 'eur' → Euro", dnRes.currency === "Euro");
  check(
    "supportedLocalesOf echoes the list",
    JSON.stringify(dnRes.sup) === '["en","de"]',
  );
  check(
    "resolvedOptions shape",
    dnRes.opts.type === "region" &&
      dnRes.opts.style === "long" &&
      dnRes.opts.fallback === "code",
  );
  check(
    "missing options.type → TypeError (native contract)",
    dnRes.noType === "TypeError",
  );
  check(
    "call without new → TypeError (native contract)",
    dnRes.noNew === "TypeError",
  );

  console.log("\n--- PART 4: parity + release artifact ---");
  check(
    "ResizeObserver shim byte-identical in shell.js and boot-shell.src.js",
    ro === extract(hosted, "boot-shell.src.js", RO_MARK),
  );
  check(
    "Intl.DisplayNames shim byte-identical in shell.js and boot-shell.src.js",
    dn === extract(hosted, "boot-shell.src.js", DN_MARK),
  );
  check(
    "shell.min.js carries the ResizeObserver shim",
    min.indexOf(RO_MARK) !== -1,
  );
  check(
    "shell.min.js carries the Intl.DisplayNames shim",
    min.indexOf(DN_MARK) !== -1,
  );
  check(
    "both shims sit inside chromium56PolyfillBody (injected before plugin scripts)",
    src.indexOf("function chromium56PolyfillBody()") < src.indexOf(RO_MARK) &&
      src.indexOf(RO_MARK) <
        src.indexOf("JEL-567: Jellyfin 10.11.8 ships a React/MUI web client"),
  );

  console.log("");
  if (failures) {
    console.error("JELA-986 M63 polyfills: " + failures + " check(s) FAILED.");
    process.exit(1);
  }
  console.log("JELA-986 M63 polyfills: all checks passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: " + (e && e.stack));
  process.exit(1);
});
