"use strict";
// Lite's contract is stricter than the shell's Babel-oracle regex
// (which only flags ES2019+, since the M63 parses ES2018): lite.src.js
// ships and runs RAW with no transpile fallback at all, so it stays
// plain ES5. This guard catches the post-ES5 syntax a reviewer is most
// likely to slip in. It is lexical (comments/strings are stripped
// first), not a parser — keep the source boring.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

let src = fs.readFileSync(
  path.join(__dirname, "..", "src", "lite.src.js"),
  "utf8",
);

// strip block comments, line comments, and string literals
src = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const FORBIDDEN = [
  [/=>/, "arrow function"],
  [/`/, "template literal"],
  [/\blet\s/, "let"],
  [/\bconst\s/, "const"],
  [/\bclass\s/, "class"],
  [/\basync\b/, "async"],
  [/\bawait\b/, "await"],
  [/\byield\b/, "generator yield"],
  [/function\s*\*/, "generator function"],
  [/\.\.\./, "spread/rest"],
  [/\bfor\s*\(\s*(var\s+)?[\w$]+\s+of\b/, "for...of"],
  [/\bnew\s+Promise\b/, "hand-rolled Promise (stay callback-based)"],
  [/\bObject\.assign\b/, "Object.assign (ES2015 runtime)"],
  [/\bArray\.from\b/, "Array.from (ES2015 runtime)"],
  [/\.includes\s*\(/, "String/Array.includes (ES2015+ runtime)"],
  [/\bfetch\s*\(/, "fetch() (use the injected fetchJson / XHR)"],
];

for (const [re, what] of FORBIDDEN) {
  const m = src.match(re);
  assert.ok(
    !m,
    `lite.src.js contains ${what}: ...${src.slice(Math.max(0, m ? m.index - 40 : 0), m ? m.index + 40 : 0)}...`,
  );
}

// and it must still be parseable at all
new Function(src);

console.log("es5-guard.test.cjs OK");
