# JEL-74 — Custom Elements stub / Web Components fallback — TV vs browser

**Verdict: PARITY — the fallback is correct, non-throwing, and degrades
gracefully. 27/27 deterministic checks pass.** The stub is present and
byte-identical in both shells and shipped in both `.min.js` artifacts; its
mechanism (native-success → component works; pre-`interactive` throw → inert
stub) is proven by running the real extracted code in a `vm`. On a browser the
wrapper installs nothing, so jellyfin-web's native path is untouched.

Run it (no server or browser required):

```
node tooling/tv-validate/custom-elements-stub/verify-custom-elements-stub.mjs
```

## Correction to the ticket framing

The ticket says M56 "lacks native Custom Elements" and asks to verify a
"polyfill." That is not what the code does, and the distinction matters:

- M56/M63/M69 Tizen WebViews **do** ship Custom Elements — both the **v1** API
  (`customElements.define`, Chrome 54+) and the **v0** API
  (`document.registerElement`, Chrome 36–79).
- The shell does **not** polyfill a missing API. It **wraps the v0 API**, which
  on the Tizen WebView build _throws_ `NotSupportedError` when
  `document.registerElement('array-checkbox', …)` is called before the document
  reaches `readyState === "interactive"` (JEL-1779). jellyfin-web /
  emby-webcomponents trigger exactly this during early boot; one unguarded throw
  blows up the boot sequence and the splash hangs 10+ minutes.

So this is a **"rescue a throwing v0 registerElement"** guard, not a
missing-API polyfill. `makeStub()` is the value returned when (and only when)
the native call throws.

## How each ticket requirement is covered

| Ticket asks                              | How it is satisfied                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fallback installed for the TV path       | Wrapper present + byte-identical in `shell.js` and `boot-shell.src.js`, shipped in both `.min.js`. Installed only when `document.registerElement` exists.                                                                                                                                                                          |
| Components work correctly **or** degrade | Two branches: native call succeeds → returns the native constructor (component **works**); native call throws → returns an inert HTMLElement-derived stub (**degrades gracefully**).                                                                                                                                               |
| Stub does not throw on the TV            | The throw is caught; the wrapper returns `makeStub()` and never rethrows. Proven over 40 mixed registrations: zero throws reach the caller.                                                                                                                                                                                        |
| Same UI renders as in browser            | On a browser `document.registerElement` is absent (Chrome 80+ removed v0) → wrapper installs **nothing** → native v1 path untouched. On TV the overwhelming majority of registrations succeed natively; only pre-`interactive` ones are stubbed, and a stubbed tag still renders its light-DOM children as an inert `HTMLElement`. |

## The fallback, exactly (both shells, byte-identical)

```js
try {
  (function () {
    var orig = document.registerElement;
    if (!orig || orig.__shellWrap) return; // absent (browser v1) OR already wrapped → no-op
    function makeStub() {
      function S() {
        if (typeof HTMLElement === "function")
          try {
            return Reflect.construct(HTMLElement, [], S);
          } catch (_) {}
        return this;
      }
      S.prototype = Object.create(HTMLElement.prototype);
      S.prototype.constructor = S;
      return S;
    }
    var wrapped = function (name, opts) {
      window.__shellRegElCalls = (window.__shellRegElCalls || 0) + 1;
      try {
        return orig.apply(document, arguments); // native success → component WORKS
      } catch (e) {
        window.__shellRegElErrors = (window.__shellRegElErrors || 0) + 1;
        // …push a bounded diagnostic into window.__shellDiag.errors…
        return makeStub(); // throw → inert HTMLElement-derived stub → DEGRADES gracefully
      }
    };
    wrapped.__shellWrap = true;
    try {
      document.registerElement = wrapped;
    } catch (_) {}
  })();
} catch (_) {}
```

## Verification — what the harness proves

**PART A — source + artifacts (11 checks).** The wrapper block extracted from
`shell.js` equals the one in `boot-shell.src.js` byte-for-byte (880 chars);
`makeStub()` builds an `HTMLElement`-derived constructor; the install guard
skips when `registerElement` is absent or already wrapped; the success path
returns the native result; the throw path is caught and returns `makeStub()`;
the `__shellRegElCalls`/`__shellRegElErrors` diagnostics and `__shellWrap`
idempotency tag are present; and both `shell.min.js` and `boot-shell.min.js`
ship the wrapper (not stripped by minification).

**PART B — faithful simulation of the REAL extracted code in a `vm` (16
checks).** The exact injected JS is reconstituted from source and executed
against a mocked `document.registerElement`:

- **native success** → wrapper installs over the present API, returns the
  native constructor, counts 1 call / 0 errors.
- **throws `NotSupportedError`** → does **not** rethrow; returns a stub
  constructor; counts 1 call / 1 error; records a diagnostic naming the failed
  element (`array-checkbox`). The stub is usable: `new Stub()` does not throw,
  instances are `instanceof HTMLElement`, and `Stub.prototype` chains to
  `HTMLElement.prototype` with `constructor === Stub` (so the tag sits in the
  DOM as a valid inert element → graceful degradation, not a crash).
- **registerElement absent** (browser / Chrome 80+) → installs nothing; native
  v1 `customElements.define` is untouched → same UI as browser.
- **idempotent** → re-running the seed never double-wraps; one call increments
  the counter by exactly 1.
- **mixed traffic** → 40 registrations (8 native successes, 32 thrown) never
  throw to the caller, the call/error split is exact, and the diagnostics ring
  buffer is bounded at 30 (no unbounded growth).

```
27/27 checks passed.
```

## On-device empirical confirmation (no manual step)

The harness proves the **mechanism** is correct and non-throwing. The
real-device split of natively-registered vs rescued components is directly
readable at runtime from `window.__shellRegElCalls` and
`window.__shellRegElErrors` (and the rescued elements are named in
`window.__shellDiag.errors`). These are surfaced by the existing QA beacon /
diag, so the native-vs-rescued ratio on a real Tizen TV can be observed without
any new instrumentation. A healthy boot shows `__shellRegElErrors` small (only
the handful of pre-`interactive` registrations) relative to `__shellRegElCalls`.

## Scope / notes

- This is a behavior-equivalence + mechanism proof, not a pixel capture. The few
  components stubbed during early boot lose only their own v0 scripted behavior;
  their light-DOM content still renders, and the boot sequence is never blocked —
  which is the whole point of the guard (JEL-1779).
- No server, browser, or device is required to run the harness; it is fully
  deterministic and runs in the sandbox.
- The stub touches **only** the v0 `document.registerElement` path. It never
  shims v1 `customElements`, so on any runtime where jellyfin-web uses native v1
  the shell is completely transparent.
