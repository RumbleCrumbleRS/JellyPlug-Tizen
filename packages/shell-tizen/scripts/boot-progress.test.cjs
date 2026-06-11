/*
 * JEL-126: boot progress indicator inject+remove lifecycle.
 *
 * The JEL-125 decomposition showed the M63 spends ~40 s parsing + executing
 * the jellyfin-web bundles after the document.write handoff, including a
 * ~20 s main-thread blackout where the splash sits frozen. The shell now
 * injects a compositor-driven (CSS transform/opacity keyframe) dots overlay
 * into the written document, removed by a 500 ms poll when jellyfin-web
 * paints its first real view, with a 120 s hard cap.
 *
 * This test extracts the SHIPPED bootProgressBody()/injectBootProgress()
 * out of src/shell.js and drives the overlay script through a virtual
 * clock + DOM stub, pinning:
 *   - inject: overlay + style attached, single interval armed
 *   - remove: first poll tick after a real-view selector matches tears
 *     everything down and cancels the interval
 *   - 120 s hard cap removal when no selector ever matches
 *   - kill switch, re-entry guard, and never-throws defensiveness
 *   - legacy-only gating of the DOMParser-path injector
 *   - both write paths (DOMParser + string fast path) carry the script
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");

// ---- extract a top-level function by brace matching -------------------------
function extractFn(name) {
  const marker = "function " + name + "(";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + SRC);
  let i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const bodyFnSrc = extractFn("bootProgressBody");
const injectFnSrc = extractFn("injectBootProgress");
const body = new Function(bodyFnSrc + "; return bootProgressBody();")();

// ---- static contract checks --------------------------------------------------
// Fast path splices the body as raw HTML inside <script>...</script>.
assert(
  body.indexOf("</script") === -1,
  "bootProgressBody must not contain a </script> literal",
);
// Must run pre-polyfill on Chromium 56/63: ES5 only.
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// Never intercepts input, invisible to a11y tree.
assert(
  body.indexOf("pointer-events:none") !== -1,
  "overlay must be pointer-events:none",
);
assert(body.indexOf("aria-hidden") !== -1, "overlay must be aria-hidden");
// Compositor-driven animation: transform/opacity keyframes only.
assert(body.indexOf("@keyframes") !== -1, "needs a keyframe animation");
assert(
  body.indexOf("transform:scale") !== -1,
  "keyframes must animate transform",
);
assert(
  body.indexOf("will-change:transform,opacity") !== -1,
  "dots must be layer-promoted",
);
// M63/M69 drop flexbox gap (JEL-29) — must not rely on flex/gap.
assert(
  body.indexOf("display:flex") === -1 && body.indexOf("gap:") === -1,
  "no flex gap on M63",
);
// Both write paths carry the script tag.
assert(
  text.indexOf("injectBootProgress(doc)") !== -1,
  "DOMParser write path must call injectBootProgress(doc)",
);
assert(
  text.indexOf('<script data-shell-boot-progress="1">') !== -1,
  "string fast path must splice the boot-progress script tag",
);

// ---- virtual clock + DOM stub ------------------------------------------------
function makeEnv(opts) {
  opts = opts || {};
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  function setIntervalStub(cb, ms) {
    const id = nextTimerId++;
    timers.set(id, { cb, ms, next: now + ms });
    return id;
  }
  function clearIntervalStub(id) {
    timers.delete(id);
  }
  function FakeDate() {
    this._t = now;
  }
  FakeDate.prototype.valueOf = function () {
    return this._t;
  };

  function makeNode(tag) {
    return {
      tagName: tag,
      id: "",
      parentNode: null,
      children: [],
      attrs: {},
      textContent: "",
      innerHTML: "",
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      appendChild(n) {
        n.parentNode = this;
        this.children.push(n);
        return n;
      },
      removeChild(n) {
        const i = this.children.indexOf(n);
        if (i === -1) throw new Error("removeChild: not a child");
        this.children.splice(i, 1);
        n.parentNode = null;
        return n;
      },
    };
  }

  const documentElement = makeNode("HTML");
  const head = opts.noHead ? null : makeNode("HEAD");
  let matching = false;
  const document = {
    documentElement: opts.noDocEl ? null : documentElement,
    head,
    createElement(t) {
      return makeNode(String(t).toUpperCase());
    },
    querySelector() {
      if (opts.queryThrows) throw new Error("selector boom");
      return matching ? makeNode("DIV") : null;
    },
  };
  const window = {};
  const store = opts.storage || {};
  const localStorage = {
    getItem(k) {
      if (opts.storageThrows) throw new Error("storage denied");
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
  };

  return {
    window,
    document,
    documentElement,
    head,
    timers,
    setMatching(v) {
      matching = v;
    },
    run() {
      new Function(
        "window",
        "document",
        "localStorage",
        "setInterval",
        "clearInterval",
        "Date",
        body,
      )(
        window,
        document,
        localStorage,
        setIntervalStub,
        clearIntervalStub,
        FakeDate,
      );
    },
    advance(toMs) {
      for (;;) {
        let nextTimer = null;
        for (const t of timers.values()) {
          if (t.next <= toMs && (!nextTimer || t.next < nextTimer.next))
            nextTimer = t;
        }
        if (!nextTimer) break;
        now = nextTimer.next;
        nextTimer.next = now + nextTimer.ms;
        nextTimer.cb();
      }
      now = toMs;
    },
  };
}

function findOverlay(env) {
  return (
    env.documentElement.children.find(
      (n) => n.id === "__shell_boot_progress",
    ) || null
  );
}
function findStyle(env) {
  const host = env.head || env.documentElement;
  return (
    host.children.find((n) => n.id === "__shell_boot_progress_css") || null
  );
}

// ---- 1. inject: overlay + style attached, one interval armed ------------------
{
  const env = makeEnv();
  env.run();
  const overlay = findOverlay(env);
  assert(overlay, "overlay attached to documentElement");
  assert.strictEqual(overlay.attrs["aria-hidden"], "true");
  assert(
    overlay.innerHTML.indexOf("<span>") !== -1,
    "overlay holds the dot spans",
  );
  assert(findStyle(env), "style attached to head");
  assert.strictEqual(env.window.__shellBootProgressOn, 1);
  assert.strictEqual(env.timers.size, 1, "exactly one poll interval armed");

  // ---- 2. survives the blackout window: still attached at 26 s, no match ----
  env.advance(26000);
  assert(findOverlay(env), "overlay persists while no real view is painted");

  // ---- 3. removed on first poll after a real-view selector matches ----------
  env.advance(45900);
  env.setMatching(true);
  env.advance(46500);
  assert.strictEqual(
    findOverlay(env),
    null,
    "overlay removed after first real view",
  );
  assert.strictEqual(
    findStyle(env),
    null,
    "style removed after first real view",
  );
  assert.strictEqual(env.timers.size, 0, "poll interval cancelled");
  assert(
    typeof env.window.__shellBootProgressClearedMs === "number" &&
      env.window.__shellBootProgressClearedMs > 0,
    "cleared-at breadcrumb recorded",
  );

  // ---- 4. exposed clear() is idempotent -------------------------------------
  const clearedAt = env.window.__shellBootProgressClearedMs;
  env.window.__shellBootProgressClear();
  assert.strictEqual(
    env.window.__shellBootProgressClearedMs,
    clearedAt,
    "clear() idempotent",
  );
}

// ---- 5. 120 s hard cap when nothing ever matches ------------------------------
{
  const env = makeEnv();
  env.run();
  env.advance(120000);
  assert(findOverlay(env), "overlay still up at exactly 120 s");
  env.advance(121000);
  assert.strictEqual(findOverlay(env), null, "hard cap removed the overlay");
  assert.strictEqual(env.timers.size, 0, "hard cap cancelled the interval");
}

// ---- 6. kill switch -----------------------------------------------------------
{
  const env = makeEnv({
    storage: { "jellyfin.shell.bootProgressDisabled": "1" },
  });
  env.run();
  assert.strictEqual(findOverlay(env), null, "kill switch suppresses overlay");
  assert.strictEqual(env.timers.size, 0, "kill switch arms no interval");
  assert.strictEqual(env.window.__shellBootProgressOn, undefined);
}

// ---- 7. re-entry guard ----------------------------------------------------------
{
  const env = makeEnv();
  env.run();
  env.run();
  const overlays = env.documentElement.children.filter(
    (n) => n.id === "__shell_boot_progress",
  );
  assert.strictEqual(overlays.length, 1, "second run is a no-op");
  assert.strictEqual(env.timers.size, 1, "still exactly one interval");
}

// ---- 8. defensive: localStorage throwing must not block injection --------------
{
  const env = makeEnv({ storageThrows: true });
  env.run();
  assert(
    findOverlay(env),
    "storage failure still injects (gate is best-effort)",
  );
}

// ---- 9. defensive: querySelector throwing tears down instead of leaking --------
{
  const env = makeEnv({ queryThrows: true });
  env.run();
  env.advance(1000);
  assert.strictEqual(
    findOverlay(env),
    null,
    "selector failure clears the overlay",
  );
  assert.strictEqual(
    env.timers.size,
    0,
    "selector failure cancels the interval",
  );
}

// ---- 10. defensive: missing documentElement no-ops without throwing -------------
{
  const env = makeEnv({ noDocEl: true });
  env.run();
  assert.strictEqual(env.timers.size, 0, "no documentElement → no interval");
}

// ---- 11. head missing → style falls back to documentElement ---------------------
{
  const env = makeEnv({ noHead: true });
  env.run();
  assert(
    findStyle(env),
    "style falls back to documentElement when head is absent",
  );
  assert(findOverlay(env), "overlay unaffected by missing head");
}

// ---- 12. DOMParser-path injector is legacy-gated ---------------------------------
{
  function makeDoc() {
    const headChildren = [];
    return {
      headChildren,
      createElement() {
        return {
          attrs: {},
          textContent: "",
          setAttribute(k, v) {
            this.attrs[k] = v;
          },
        };
      },
      head: {
        appendChild(n) {
          headChildren.push(n);
          return n;
        },
      },
    };
  }
  const inject = (legacy) =>
    new Function(
      "isLegacyChromium",
      "bootProgressBody",
      injectFnSrc + "; return injectBootProgress;",
    )(
      () => legacy,
      () => body,
    );

  const modernDoc = makeDoc();
  inject(false)(modernDoc);
  assert.strictEqual(
    modernDoc.headChildren.length,
    0,
    "modern engines get no overlay",
  );

  const legacyDoc = makeDoc();
  inject(true)(legacyDoc);
  assert.strictEqual(
    legacyDoc.headChildren.length,
    1,
    "legacy engines get the script tag",
  );
  assert.strictEqual(
    legacyDoc.headChildren[0].attrs["data-shell-boot-progress"],
    "1",
  );
  assert.strictEqual(
    legacyDoc.headChildren[0].textContent,
    body,
    "tag carries the shipped body",
  );
}

console.log("boot-progress.test.cjs: all assertions passed");
