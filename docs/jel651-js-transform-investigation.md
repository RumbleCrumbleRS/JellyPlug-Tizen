# JEL-651 — How we parse/transform JavaScript for Tizen ≤ 5.x, and whether there is a better way

Date: 2026-07-04. Scope: the legacy-Chromium (Tizen 5.0/M63, Tizen 5.5/M69,
floor target Chrome 56) plugin/script lowering pipeline in both shells.

## 1. Current pipeline (as of main @ 26cdc23)

For every non-bundle script the shell is about to inline (static `/web/index.html`
pass, dynamic `appendChild`/`insertBefore`/`src`-setter interceptors, and the JSI
snippet channel), on a legacy engine:

1. **Detection** — `needsTranspile(code)`: a hand-maintained regex
   (`MODERN_PRECHECK_RE`) screens for post-Chrome-56 tokens (`?.`, `??`, `??=`,
   `||=`, `&&=`, `#priv`, `1_000`, `1n`, `catch{`, object rest/spread, async
   generators, `for await`, interior `, ...x`). No match → inline raw (fast path).
2. **Content-addressed cache** — `txc:<TX_PFX>:<fnv1a(source)>` in localStorage
   (JEL-178): hit → inline cached lowered body.
3. **Pre-lowered server drop** (JEL-621) — hash the source, look it up in
   `/shell/tx-manifest.json`; on hit fetch `tx/<hash>.js` (built offline by
   `build-tx-drop.mjs` with the byte-identical Babel options). Accepted only if
   `babelOptsKey` matches and the body passes the strict oracle regex
   (`MODERN_SYNTAX_RE`).
4. **On-TV Babel fallback** — lazy-load the slim vendored `babel.min.js`
   (2.09 MB, JEL-620) and `Babel.transform(code, {targets:{chrome:"56"}, loose,
   iterable assumptions})` on the main thread; verify with the oracle; cache.
5. **Neutralize** (JEL-216) — if transform fails, the script node is inertized so
   raw modern syntax can never SyntaxError the concatenated document.

After the JEL-616 rehaul (all children merged), the on-TV Babel pass no longer
runs on the *steady-state* boot path: warm boots hit the `txc:` cache, cold boots
hit the tx drop. Babel now runs only on **misses** — new/changed plugin bodies,
servers whose drop is stale or absent, and dynamic scripts not covered at
publish time. A full miss regresses to the measured 21–42 s class.

## 2. Where the current design is weak

**(a) Regex detection is the recurring bug factory.** Both gates
(`MODERN_PRECHECK_RE` pre-check and `MODERN_SYNTAX_RE` oracle) approximate the
question "can this engine parse this source?" with a token regex. Misses ship a
SyntaxError to the TV (JEL-354: un-lowered ES2018; JEL-417: interior object
spread) and each widening forces a `TX_EPOCH` bump that orphans every cached
transpile on every TV in the field. False positives (`span1n`-style identifiers,
tokens inside string literals) burn needless 50–200 ms Babel passes. Every new
ECMAScript syntax the ecosystem adopts is a future field incident by
construction. The regex source is lockstep-duplicated across **12 files**
(both shells, seed-script string literals, drop builder, JSI minify gate, and
their tests), guarded by parity tests that exist only because the duplication
is dangerous.

**(b) Drop coverage is manual.** `build-tx-drop.mjs` runs by hand. Any server
content change (jellyfin-web update, plugin config edit) changes source hashes,
so every entry misses and TVs silently fall back to on-TV Babel until someone
re-runs the builder. There is no automation and no alerting on the
`__shellTxDrop.m/f` miss counters.

## 3. Alternatives evaluated

| Option | Verdict |
| --- | --- |
| **Device-native parse probe** — `new Function(src)` in try/catch: the TV's own parser is ground truth for "needs transpile" and for the post-transform oracle | **Adopt.** Kills the regex false-negative bug class and TX_EPOCH cache nukes; per-device optimal (an M69 panel transpiles less than the chrome-56 floor). Measured 2 MB corpus parse ≈ 40 ms in Node (~200–400 ms est. on TV silicon, slow paths only) vs ~2 ms regex — negligible against the Babel passes it gates/avoids. Spec guarantees eager SyntaxError (`CreateDynamicFunction` parses the body; early errors throw at construction). |
| **Automate drop regeneration** | **Adopt.** Regenerate on release + on server content change (cron `--merge` run against `--web-index`); alert on sustained drop-miss counters. Turns the 21–42 s miss regression from "until a human notices" into a bounded window. |
| swc/esbuild instead of Babel | esbuild cannot emit ES5; swc-wasm on-TV is unproven on M63 and only helps the (now rare) miss path. Offline, publish-time speed is irrelevant and byte-lockstep with the on-TV transform (`babelOptsKey`, hash equality) argues for keeping the same vendored Babel. **No.** |
| Babel in a Web Worker | Keeps the main thread responsive but total time unchanged; worker+blob URL support on Tizen 5.0 WRT unverified. Marginal — only worth it if miss-path UX ever matters again. **Defer.** |
| Server-side on-demand transpile endpoint (companion plugin / sidecar) | Terminal state — TV never transpiles even on misses. Real infra: a JS toolchain on the server, cache keyed like `txc:`. Superseded in cost/benefit by drop automation unless miss rates stay high. **Defer; revisit with counter data.** |
| Pre-lowered fork of jellyfin-web (browserslist chrome 56) | Eliminates runtime transform entirely but means owning a web-client build forever and violates the plugin-agnostic policy (server plugins inject arbitrary JS regardless). **No.** |

## 4. Recommended design: parse-probe detection

```js
function parsesOnThisEngine(code) {
  try { new Function(code); return true; }
  catch (e) { return false; } // SyntaxError → this engine cannot parse it
}
// detection:  needsTranspile(code) = !parsesOnThisEngine(code)
// oracle:     accept a drop/Babel body only if parsesOnThisEngine(body)
```

Rollout shape (implementation ticket):

- Probe wrapped in capability detection at boot (`new Function("1")` under
  try/catch); if unavailable (CSP/eval restriction — must be confirmed on-device
  once, on both the widget origin and the post-document.write server origin),
  fall back to today's regex path unchanged.
- Kill switch `jellyfin.shell.parseProbeDisabled`, mirroring every other rehaul
  lever.
- Regexes are kept offline in `build-tx-drop.mjs` as the conservative
  *coverage* pre-filter (an offline builder cannot ask an M56 parser), and
  initially on-device as the fallback; the 12-file lockstep burden shrinks to
  the builder + fallback once proven.
- Known probe caveats, all acceptable: the Function wrapper legalizes top-level
  `return` (a plugin using it would break today too); the compile allocates and
  discards code objects (bounded, sequential per script); detection becomes
  engine-relative, which is correct because the result is only used on that
  device and all caches are already content-addressed per device.
- On-device gates before merge: probe `"var a=b?.c"` throws SyntaxError on the
  M63 panel; probe of a lowered drop body parses; boot-phase ring (JEL-617)
  shows no regression; `__shellTx*` counters sane over 5 cold boots.

## 5. Measurements backing this

- Regex scan of a 1.99 MB minified corpus: ~0.4 ms/pass (Node, this sandbox).
- `new Function` full parse of the same corpus: ~40 ms/pass (Node); TV estimate
  ~5–10× → 200–400 ms across the whole plugin set, incurred only on slow paths.
- On-TV Babel (prior art, JEL-131/616): ~50–200 ms *per plugin*, 21–42 s for the
  full 1.9 MB set on a 2019 panel — the thing both recommendations bound.
