// JEL-44 — SubtitlesOctopus (libass-WASM) worker parse-safety guard for M63.
//
// WHY THIS EXISTS
// ASS/SSA subtitles are rendered client-side by jellyfin-web via SubtitlesOctopus,
// which loads its engine with `new Worker('.../subtitles-octopus-worker.js')`.
// A Web Worker's script is parsed by the worker engine DIRECTLY — it does NOT
// pass through the shell's document-level Babel transpile (shell.js only rewrites
// <script> tags written into /web/index.html and plugin specs; see
// transpileLegacyScripts / needsTranspile). So if that worker bundle ever ships
// ES2020+ syntax (optional chaining, nullish, logical-assign, private fields,
// numeric separators, BigInt, optional-catch), the M63 (Tizen 5.0 / Chrome 63)
// worker thread throws a SyntaxError at load and ASS rendering silently dies —
// while subrip (no worker) and any modern browser keep working.
//
// WHAT THIS DOES
// Fetches the worker bundle from the live server, then runs it through the EXACT
// Babel + options the shell uses (chrome:63, loose, sourceType:script). If real
// modern syntax is present, preset-env lowers it and the token count drops; if
// the regex pre-hits are only inside string literals (libass embeds large CJK /
// word-frequency data tables that contain "?." and "#x" sequences), nothing
// lowers. The guard FAILS only when genuine, lowered modern syntax is detected —
// i.e. when the worker really would break Chrome 63.
//
// As of jellyfin-web on Jellyfin 10.11 the worker is parse-safe: the ?./#x hits
// are all string data. Re-run after any jellyfin-web upgrade.
//
// Env: JELLYFIN_URL.  Usage: node octopus-worker-syntax.cjs   (exit 1 = unsafe on M63)

const path = require('path');
const U = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
if (!U) {
  console.error('Set JELLYFIN_URL');
  process.exit(2);
}
const Babel = require(path.resolve(__dirname, '../../../packages/shell-tizen/src/babel.min.js'));

// Mirror of shell.js BABEL_OPTS_KEY transform options.
const TRANSFORM = {
  presets: [['env', { targets: { chrome: 63 }, modules: false, loose: true }]],
  sourceType: 'script',
  compact: true,
  comments: false,
};
// Tokens for ES features Chrome 63 cannot parse (subset of shell MODERN_SYNTAX_RE
// that survives as a literal substring after transform if it was real syntax —
// preset-env removes ?./??/||=/&&=/??=/#x entirely for a chrome:63 target).
const PROBES = {
  'optional-chaining ?.': /\?\./g,
  'nullish/logical-assign': /\?\?|\|\|=|&&=/g,
  'private-field #x': /(^|[^\w])#[a-zA-Z_$]/g,
};
const TARGETS = [
  ['/web/libraries/subtitles-octopus-worker.js', 'WASM glue worker (primary ASS path)'],
  ['/web/libraries/subtitles-octopus-worker-legacy.js', 'asm.js fallback worker'],
];

function count(code, re) {
  return (code.match(new RegExp(re.source, 'g')) || []).length;
}

(async () => {
  // Sanity: prove preset-env in THIS babel actually lowers modern syntax,
  // otherwise the whole test is vacuous.
  const probe = 'const f=(a)=>a?.b ?? 1; class C{ #x=2; }';
  const probeOut = Babel.transform(probe, TRANSFORM).code;
  if (/\?\.|\?\?/.test(probeOut) || /[^\w]#[a-zA-Z_$]/.test(probeOut)) {
    console.error('ABORT: shell babel did not lower modern syntax in the probe — test is invalid.');
    process.exit(2);
  }
  let unsafe = 0;
  for (const [p, label] of TARGETS) {
    const res = await fetch(U + p);
    if (!res.ok) {
      console.log(`SKIP ${p} (${res.status})`);
      continue;
    }
    const code = await res.text();
    let out;
    try {
      out = Babel.transform(code, TRANSFORM).code;
    } catch (e) {
      console.log(`FAIL ${label}: Babel threw parsing worker — ${String(e.message).slice(0, 160)}`);
      unsafe++;
      continue;
    }
    const lowered = {};
    let realSyntax = 0;
    for (const [name, re] of Object.entries(PROBES)) {
      const d = count(code, re) - count(out, re);
      if (d > 0) {
        lowered[name] = d;
        realSyntax += d;
      }
    }
    if (realSyntax > 0) {
      console.log(`FAIL ${label} (${p}): ${realSyntax} real ES2020+ tokens that break Chrome 63 — ${JSON.stringify(lowered)}`);
      unsafe++;
    } else {
      console.log(`OK   ${label} (${p}, ${code.length}b): no real modern syntax — regex hits are string-literal data only.`);
    }
  }
  console.log(unsafe ? `\nUNSAFE on M63: ${unsafe} worker(s) need transpile but bypass it.` : '\nAll SubtitlesOctopus workers are parse-safe on M63 (Chrome 63).');
  process.exit(unsafe ? 1 : 0);
})();
