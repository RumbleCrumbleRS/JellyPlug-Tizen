// JEL-644: JS twin of expand.py — splices packages/shell-core fragments into a
// shell entry-file source string. Used by the cross-shell parity guard and the
// shared test loader (the Python build/verify scripts use expand.py). Kept
// deliberately tiny and grammar-equivalent to expand.py; change both together.
const fs = require("fs");
const path = require("path");

const CORE_SRC = path.join(__dirname, "src", "shell-core.src.js");

// A marker occupies its own line (any indentation); the whole line is replaced.
const MARKER_RE = /^[ \t]*\/\/@@SHELL_CORE:([A-Za-z_$][\w$]*)@@[ \t]*$/gm;
// BEGIN ... END delimited fragment blocks; \1 ties END to its BEGIN name.
const FRAG_RE =
  /\/\/@@BEGIN:([A-Za-z_$][\w$]*)@@\n([\s\S]*?)\n[ \t]*\/\/@@END:\1@@/g;

function loadFragments(coreText) {
  if (coreText == null) coreText = fs.readFileSync(CORE_SRC, "utf8");
  const frags = Object.create(null);
  FRAG_RE.lastIndex = 0;
  let m;
  while ((m = FRAG_RE.exec(coreText))) {
    if (frags[m[1]] !== undefined)
      throw new Error("duplicate shell-core fragment " + m[1]);
    frags[m[1]] = m[2];
  }
  return frags;
}

function expand(text, fragments) {
  if (fragments == null) fragments = loadFragments();
  return text.replace(MARKER_RE, (_full, name) => {
    if (fragments[name] === undefined)
      throw new Error(
        "shell-core marker names unknown fragment " +
          name +
          " (defined: " +
          Object.keys(fragments).sort().join(", ") +
          ")",
      );
    return fragments[name];
  });
}

function markerNames(text) {
  const out = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text))) out.push(m[1]);
  return out;
}

module.exports = { expand, loadFragments, markerNames, CORE_SRC };
