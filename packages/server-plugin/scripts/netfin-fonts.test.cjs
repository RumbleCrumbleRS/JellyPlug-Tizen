#!/usr/bin/env node
/*
 * netfin-fonts.test.cjs — JELA-902 guards for the vendored NetFin skin.
 *
 * The defect: the server's Branding.CustomCss held 73 bytes —
 * `@import url("https://cdn.jsdelivr.net/gh/ya0903/NetFin@main/netfin.css");`
 * — and every third-party byte of a cold boot hung off it: 5.28 MB over 7
 * requests to 3 origins, 26% of a 20.26 MB boot, including a 4,969,868 B
 * UNSUBSETTED 4-axis VARIABLE icon font whose axes M63 cannot even drive.
 *
 * sibling fonts.test.cjs already covers what is generic to the /shell/fonts/
 * drop, and it covers netfin.css for free once the sheet is listed there: every
 * url() local, ?v= matching the committed bytes, no orphan woff2, csproj + route
 * + content types wired. This file guards only what is specific to JELA-902 and
 * would otherwise fail silently.
 *
 * The failure this is really written against is a HALF-LANDED REGEN of the icon
 * subset. Its glyph set is derived, not authored — the union of JELA-825's
 * audited material-icons.json codepoints and the PUA escapes netfin.css uses
 * itself. Either input can grow without anyone re-running the builder, and the
 * symptom on a TV is a few icons silently turning into blank boxes. So the
 * union is re-derived HERE, from the same two files, and checked against what
 * the manifest says the committed font was actually built to cover.
 *
 * No font library is required, deliberately: scripts/build-netfin-fonts.mjs
 * needs a subsetter, but it is a hand-run regen tool (like fetch-webfonts.py)
 * and `pnpm test` must never depend on that — a devDep-skipping install would
 * turn a guard into a silent pass.
 *
 * Run: node packages/server-plugin/scripts/netfin-fonts.test.cjs
 */
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const FONTS = path.join(ROOT, "Resources", "fonts");

const SHEET = "netfin.css";
const ICON_FONT = "material-symbols-rounded-v267-400.woff2";
// AC2's ceiling. The subset lands ~13 KB, so this is a tripwire for a regen
// that loses --no-layout-closure (which drags all ~6k icon glyphs back in and
// yields a ~1 MB "subset"), not a tight budget.
const ICON_MAX_BYTES = 150 * 1024;

const manifest = JSON.parse(
  fs.readFileSync(path.join(FONTS, "fonts-manifest.json"), "utf8"),
);
const nf = manifest.netfin;
assert.ok(nf, "fonts-manifest.json lost its netfin section");

const sha256 = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ---- 1. the served sheet reaches no third-party origin, at all --------------

// Unlike JELA-818's kill-switch case, nothing here needs a stock URL as a
// fallback string, so this can be the literal greppable property rather than
// the unpassable AC that lesson warned about: not even a comment may name one.
const sheetPath = path.join(FONTS, SHEET);
assert.ok(fs.existsSync(sheetPath), `${SHEET} not committed`);
const sheet = fs.readFileSync(sheetPath, "utf8");
for (const origin of [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
]) {
  assert.ok(
    !sheet.includes(origin),
    `${SHEET} still names ${origin} — AC1 requires zero requests to it, and ` +
      "provenance belongs in fonts-manifest.json, which is never served",
  );
}
// The hostname check above is deliberately on the RAW bytes — not even a
// comment may name an origin. `@import` is different: the word appears in the
// header comment explaining what was inlined, and prose cannot fetch anything.
// So this one runs on effective CSS only.
const effective = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/@import/.test(effective),
  `${SHEET} kept a live @import — that is how the original chain started`,
);

// ---- 2. every replacement text face is woff2, and actually committed --------

// AC2, second conjunct: ".ttf" is uncompressed where woff2 is Brotli, which is
// why two Rajdhani faces cost 277 KB on the wire against ~24 KB self-hosted.
assert.ok(
  Array.isArray(nf.text.faces) && nf.text.faces.length === 10,
  `expected the 10 faces the upstream @import declares, got ${nf.text.faces?.length}`,
);
for (const face of nf.text.faces) {
  assert.ok(
    face.file.endsWith(".woff2"),
    `${face.file}: replacement text faces must be woff2, never .ttf`,
  );
  const p = path.join(FONTS, face.file);
  assert.ok(fs.existsSync(p), `${face.file} in manifest but not committed`);
  assert.strictEqual(
    fs.statSync(p).size,
    face.bytes,
    `${face.file}: committed size does not match the manifest — half-landed regen`,
  );
  assert.strictEqual(
    sha256(p),
    face.sha256,
    `${face.file}: committed bytes do not match the manifest sha256`,
  );
  // The sheet must actually declare it, at the weight it was cut for.
  const decl = new RegExp(
    `font-family: '${face.family}';[\\s\\S]{0,120}?font-weight: ${face.weight};` +
      `[\\s\\S]{0,120}?src: url\\(${face.file.replace(/\./g, "\\.")}\\?v=`,
  );
  assert.ok(
    decl.test(sheet),
    `${SHEET} does not declare ${face.family} ${face.weight} -> ${face.file}`,
  );
  assert.ok(
    !/\.ttf/.test(face.file),
    `${face.file}: a .ttf must never be committed as a served face`,
  );
}

// ---- 3. the icon font is ours, small, and pointed at ------------------------

const iconPath = path.join(FONTS, ICON_FONT);
assert.ok(fs.existsSync(iconPath), `${ICON_FONT} not committed`);
const icon = fs.readFileSync(iconPath);
assert.strictEqual(
  icon.toString("latin1", 0, 4),
  "wOF2",
  `${ICON_FONT} is not a WOFF2 (signature mismatch)`,
);
assert.ok(
  icon.length <= ICON_MAX_BYTES,
  `${ICON_FONT} is ${icon.length} B, over AC2's ${ICON_MAX_BYTES} B ceiling — ` +
    "a regen that lost noLayoutClosure pulls every icon glyph back in",
);
assert.strictEqual(
  sha256(iconPath),
  nf.icons.sha256,
  `${ICON_FONT}: committed bytes do not match the manifest sha256`,
);
assert.ok(
  new RegExp(`src: url\\(${ICON_FONT.replace(/\./g, "\\.")}\\?v=[0-9a-f]{64}\\)`).test(
    sheet,
  ),
  `${SHEET} does not point its icon face at ${ICON_FONT}`,
);
// The whole point: it must be smaller than what it replaced, by a lot.
assert.ok(
  nf.icons.sourceBytes > 4_000_000 && icon.length * 100 < nf.icons.sourceBytes,
  `icon subset is not <1% of the ${nf.icons.sourceBytes} B upstream face`,
);
// Instanced, not variable: M63 cannot drive the axes (JELA-710), so shipping a
// variable font would be paying gvar for nothing.
assert.deepStrictEqual(
  nf.icons.instancedAxes,
  { wght: 400, FILL: 0, GRAD: 0, opsz: 24 },
  "icon font must stay pinned to the upstream default instance",
);

// ---- 4. the derived glyph set still matches what was built ------------------

// Re-derive the union from its two real inputs. This is the check that catches
// "someone added icons and nobody re-ran the builder".
const audited = JSON.parse(
  fs.readFileSync(path.join(FONTS, "material-icons.json"), "utf8"),
);
const required = new Set(
  audited.codepoints.map((u) => parseInt(u.replace(/^U\+/, ""), 16)),
);
const auditedCount = required.size;
const fromSheet = new Set(
  [...sheet.matchAll(/\\([eEfF][0-9a-fA-F]{3})\b/g)].map((m) =>
    parseInt(m[1], 16),
  ),
);
assert.ok(
  fromSheet.size > 0,
  `${SHEET}: found no PUA icon escapes at all — the regex or the sheet moved`,
);
for (const c of fromSheet) required.add(c);

assert.strictEqual(
  nf.icons.codepointsRequested,
  required.size,
  `the icon subset was built for ${nf.icons.codepointsRequested} codepoints but ` +
    `material-icons.json (${auditedCount}) + ${SHEET} (${fromSheet.size}) now ` +
    `require ${required.size}. Re-run scripts/build-netfin-fonts.mjs — ` +
    "otherwise the new icons render as blank boxes on TVs.",
);

// Requested = present + absent-upstream, with nothing unaccounted for. An
// absent-upstream codepoint is not a regression: it does not render from this
// face today either, and netfin.css's `--iconPack: "Material Icons Round",
// Material Icons` makes per-glyph fallback land on Jellyfin's own subset.
assert.strictEqual(
  nf.icons.codepointsPresent + nf.icons.codepointsAbsentUpstream.length,
  nf.icons.codepointsRequested,
  "icon coverage does not add up: present + absentUpstream != requested",
);
for (const u of nf.icons.codepointsAbsentUpstream) {
  assert.ok(
    /^U\+[0-9A-F]{4,6}$/.test(u),
    `malformed absentUpstream entry ${u}`,
  );
  assert.ok(
    required.has(parseInt(u.slice(2), 16)),
    `${u} recorded as absent upstream but is not even requested`,
  );
}

// ---- 5. upstream stays pinned to a commit, never a branch ------------------

// An unpinned `@main` is an uncontrolled input to the fielded skin: an upstream
// force-push silently changes what every TV renders.
assert.ok(
  /^[0-9a-f]{40}$/.test(nf.upstream.commit),
  `upstream must be pinned to a full commit sha, got "${nf.upstream.commit}"`,
);
assert.ok(
  nf.upstream.url.includes(nf.upstream.commit) &&
    !/@(main|master|HEAD)\b/.test(nf.upstream.url),
  "upstream url must carry the pinned commit, not a branch ref",
);
assert.ok(
  /^[0-9a-f]{64}$/.test(nf.upstream.sha256),
  "upstream netfin.css sha256 missing — drift would be undetectable",
);

// ---- 6. the builder is committed alongside the artifacts -------------------

const builder = path.join(__dirname, "build-netfin-fonts.mjs");
assert.ok(fs.existsSync(builder), "build-netfin-fonts.mjs missing");
const src = fs.readFileSync(builder, "utf8");
assert.ok(
  /noLayoutClosure:\s*true/.test(src),
  "builder lost noLayoutClosure — mandatory, not an optimisation (JELA-825)",
);
assert.ok(
  src.includes(nf.upstream.commit),
  "builder's pinned commit and the manifest's have drifted apart",
);

console.log(
  `netfin-fonts.test.cjs OK — ${SHEET} (${fs.statSync(sheetPath).size} B) + ` +
    `${nf.text.faces.length} woff2 text faces + icon subset ` +
    `${nf.icons.sourceBytes} -> ${icon.length} B ` +
    `(${nf.icons.codepointsPresent}/${nf.icons.codepointsRequested} codepoints, ` +
    `${nf.icons.codepointsAbsentUpstream.length} absent upstream)`,
);
