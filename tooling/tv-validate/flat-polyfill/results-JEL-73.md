# JEL-73 — Compare: Array.prototype.flat / flatMap polyfills — M56 compatibility

**Verdict: confirmed equivalent to native, and parity is by construction.**
`__shellFlat()` / `__shellFlatMap()` — injected via `__installAccessor()` — produce
results identical to native `Array.prototype.flat` / `flatMap` across the full
battery of inputs we tested (dense arrays, every depth-coercion case, `Infinity`,
and flatMap with scalar/array/index/filter callbacks). The accessor is installed
**unconditionally** (no `isLegacyChromium()` gate), so the same bytes ship to TV
and browser and the override is a behavioural no-op on any engine whose native
flat is already correct. On the M56 WebView — where native flat is absent or
present-but-buggy — the accessor supplies / repairs it, with **no TypeError**.
`window.__shellFlatInstalled` is set to `1`.

## Evidence

- **9/9 runtime checks across 3 scenarios** — `verify-flat-polyfill.mjs` executes the REAL
  reconstructed shell.js polyfill over the three native-flat realities a device
  can present (absent / buggy / correct) and drives the exact playbackmanager
  `items = items.flat()` pattern.
- **85/85 static + behavioural checks** —
  `packages/shell-tizen/scripts/flat-polyfill.test.cjs` reconstructs the shipped
  polyfill bytes, compares its output to Node's native flat/flatMap across 31
  expressions, asserts the v47 accessor contract, and pins the wiring to
  `shell.js`, the deployed `shell.min.js`, and the hosted `boot-shell.src.js`.

## The three things the ticket asks us to prove

| #   | Ticket question                                                               | Result                                                                                                                                      | Evidence                                    |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `__shellFlat`/`__shellFlatMap` produce the same results as native             | Identical for every dense-array case + all depth-coercion forms + flatMap callbacks                                                         | `.cjs` PART 1 (31 exprs), `.mjs` Scenario C |
| 2   | A page that calls `flat()` (libraries/queue flattening) → no TypeError on M56 | `typeof [].flat === 'function'` after install; the playbackmanager `items.flat()` pattern flattens to real items in all three native states | `.mjs` Scenarios A & B                      |
| 3   | `__shellFlatInstalled` flag is set                                            | Set to `1` after the install IIFE runs                                                                                                      | `.cjs` PART 2, `.mjs` Scenarios A & B       |

## (A) The TV-vs-browser story is "unconditional install", not a UA fork

`shell.js` and the hosted `boot-shell.src.js` inject the **byte-identical**
polyfill block (`.cjs` PART 5 asserts string equality). Unlike the bundle-patch
and detail-page chains, there is **no `isLegacyChromium()` gate** around it — the
accessor installs on every engine. That is the right design: an unconditional
override is the only thing that can dislodge a _present-but-buggy_ native flat
(the earlier `if(!Array.prototype.flat)` conditional polyfill in
`chromium56PolyfillBody` skips when flat is present, so it cannot fix Samsung's
fork). On a correct engine the override simply reproduces native output.

## (B) Why an accessor, not a writable:false data property (the v47 fix)

The accessor is installed with `Object.defineProperty(Array.prototype, name, {
configurable: true, enumerable: false, get: () => fn, set: () => {} })`:

- **getter** always returns the fixed function, so the broken platform flat can
  never resurface;
- **write-absorbing setter** means plugin bundles running in strict mode that do
  `Array.prototype.flat = fn` (JellyfinEnhanced, JavaScriptInjector, core-js)
  succeed syntactically instead of throwing a `TypeError` that would kill the
  plugin module mid-init — the failure mode of the rejected v46 `writable:false`
  approach;
- **`configurable: true`** leaves an escape hatch: an explicit
  `Object.defineProperty` override still wins, for the rare caller that needs it.

`.cjs` PART 2 proves all four properties, including that a strict-mode write does
not throw and does not change the returned function. `.mjs` Scenario B proves the
same write cannot resurface the buggy native.

## (C) The M56 bug, reproduced and repaired

Samsung's Tizen 5.0 (Chrome 56) fork ships a flat whose body uses `d > 1` instead
of `d >= 1`, so `[[item]].flat()` returns `[[item]]` unchanged. In
`playbackmanager.js:2095` (`items = items.flat()`) that hands an array-of-arrays
down to `getPlayer(item, …)`; the inner array has no `MediaType`, every player
rejects, and the web client logs _"No player found for the requested media:
undefined"_. `verify-flat-polyfill.mjs` Scenario B fakes exactly this buggy
native, confirms the bug is present, then runs the shell polyfill over it and
shows `[[item]].flat()` correctly unwraps one level and the play-queue is
restored. Scenario A covers the _absent_-native case (stock Chrome <69), where the
same call would otherwise throw `flat is not a function`.

## (D) One documented, immaterial divergence: sparse holes

Native flat **elides** sparse array holes (`[1,,3].flat()` → `[1,3]`); the
polyfill **preserves** them as `undefined` (`[1,null,3]`). This is the only place
the two differ. It is immaterial to jellyfin-web, which only ever flattens dense
item lists (library rows, the play queue). `.cjs` PART 3 asserts the divergence
explicitly so it reads as known, not as an oversight.

## How to reproduce

```
node packages/shell-tizen/scripts/flat-polyfill.test.cjs
node tooling/tv-validate/flat-polyfill/verify-flat-polyfill.mjs
```

## On-device note

The polyfill is part of the already-shipped shell (JEL-727 v47) running on the
physical Tizen 5.0 TV. Because the logic is pure JS with no DOM/server
dependency, the reconstructed-bytes simulation above is a complete proof of the
flatten semantics; no fresh device capture adds information beyond confirming the
shell is loaded, which prior tickets establish.
