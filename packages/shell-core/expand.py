"""JEL-644: build-time text substitution that splices packages/shell-core
fragments into the shell entry files.

Both shell entry files — shell-tizen/src/shell.js and
shell-tizen-bootstrap/src/boot-shell.src.js — carry `//@@SHELL_CORE:name@@`
marker lines where a shared function used to live. `expand()` replaces each
marker with the corresponding fragment body from shell-core.src.js (delimited
by `//@@BEGIN:name@@` / `//@@END:name@@`).

Deliberately NOT a module bundler: the result is still a single-file IIFE that
esbuild minifies exactly as before (the build scripts feed the expanded source
to esbuild via stdin). Because each fragment carries retail's canonical raw
text and every extracted function was build-minify byte-identical across both
shells before extraction, re-minifying the expanded entry files reproduces the
committed .min blobs byte-for-byte (zero-shipped-byte; see JEL-644).

Kept tiny and equivalent to expand.cjs (the JS twin used by the parity guard
and the shared test loader). If you change the marker/delimiter grammar, change
both.
"""

import re
from pathlib import Path

CORE_SRC = Path(__file__).parent / "src" / "shell-core.src.js"

# A marker occupies its own line (any indentation); the whole line is replaced.
_MARKER_RE = re.compile(
    r"^[ \t]*//@@SHELL_CORE:([A-Za-z_$][\w$]*)@@[ \t]*$", re.M
)
# BEGIN ... END delimited fragment blocks. `\1` ties END to its BEGIN name.
_FRAG_RE = re.compile(
    r"//@@BEGIN:([A-Za-z_$][\w$]*)@@\n([\s\S]*?)\n[ \t]*//@@END:\1@@"
)


def load_fragments(core_text: str | None = None) -> dict[str, str]:
    if core_text is None:
        core_text = CORE_SRC.read_text(encoding="utf-8")
    frags: dict[str, str] = {}
    for m in _FRAG_RE.finditer(core_text):
        name = m.group(1)
        if name in frags:
            raise ValueError(f"duplicate shell-core fragment {name!r}")
        frags[name] = m.group(2)
    return frags


def expand(text: str, fragments: dict[str, str] | None = None) -> str:
    """Return `text` with every `//@@SHELL_CORE:name@@` marker replaced by the
    named shell-core fragment. Raises if a marker names an unknown fragment."""
    if fragments is None:
        fragments = load_fragments()

    def repl(m: "re.Match[str]") -> str:
        name = m.group(1)
        if name not in fragments:
            raise KeyError(
                f"shell-core marker names unknown fragment {name!r} "
                f"(defined: {sorted(fragments)})"
            )
        return fragments[name]

    return _MARKER_RE.sub(repl, text)


def marker_names(text: str) -> list[str]:
    """Names referenced by `//@@SHELL_CORE:...@@` markers in `text`."""
    return [m.group(1) for m in _MARKER_RE.finditer(text)]
