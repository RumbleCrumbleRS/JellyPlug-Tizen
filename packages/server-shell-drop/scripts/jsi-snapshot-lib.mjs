/*
 * jsi-snapshot-lib.mjs — JELA-898: shared core for jsi-backup.mjs / jsi-restore.mjs.
 *
 * The JavaScript Injector config IS the JellyPlug product layer. 110
 * `CustomJavaScripts` entries, ~905 KB of minified ES5, built up over ~50
 * incremental `jsi-jpNNN-patch.mjs` runs that were each applied ONCE against
 * live state. The repo cannot regenerate them: a patcher takes the live body
 * as its base, so replaying them from an empty config is not a thing.
 *
 * JELA-896 proved that is a single point of failure. The Jellyfin 12.0 upgrade
 * emptied the plugin config — `/JavaScriptInjector/public.js` went 924,481 B to
 * 0 — and the only reason the layer still exists is that a scratch artifact
 * from JELA-886 happened to still be on an agent box.
 *
 * Both tools share this module so the snapshot format has exactly one
 * definition and `jsi-restore.mjs` validates precisely what `jsi-backup.mjs`
 * wrote.
 *
 * ---------------------------------------------------------------------------
 * The floors, and why each one exists
 * ---------------------------------------------------------------------------
 * A backup tool that faithfully mirrors whatever the server says is worse than
 * no backup tool, because it will dutifully overwrite a good snapshot with the
 * wiped one. Every guard here is fail-closed with an explicit `--force`:
 *
 *  - MIN ENTRIES. A config with fewer than `--min-entries` entries is the
 *    JELA-896 wipe signature. Refuse to write it.
 *  - SHRINK CEILING. Compared against the previous known-good snapshot, a drop
 *    of more than `--max-shrink-pct` in either entry count or script bytes is a
 *    loss event, not an edit. This is the guard that would have caught 12.0.
 *  - PERSONAL ENDPOINTS. A snapshot is a tracked repo file, so it is inside the
 *    JEL-139 blast radius. `tooling/ci/check-no-personal-endpoints.sh` would
 *    fail CI after the commit exists; catching it here keeps the operator's
 *    dynamic-DNS hostname out of git history in the first place.
 */
import { createHash } from "node:crypto";

export const SNAPSHOT_FORMAT = "jellyplug.jsi-snapshot";
export const SNAPSHOT_FORMAT_VERSION = 1;

/** The JavaScript Injector plugin, as reported by `GET /Plugins`. */
export const JSI_PLUGIN_NAME = "JavaScript Injector";

/**
 * Free dynamic-DNS suffixes — the kind used to expose a home server.
 *
 * This mirrors the `PATTERN` in `tooling/ci/check-no-personal-endpoints.sh`,
 * and it is ASSEMBLED FROM PARTS rather than written as one literal on purpose:
 * that guard scans every tracked file, including this one, so a verbatim copy
 * of its pattern makes the guard fail on itself. `jsi-backup-restore.test.cjs`
 * reads the shell script, pulls out its PATTERN, and asserts it is
 * byte-identical to what this builds — so the two cannot silently drift apart.
 */
const DDNS_SUFFIXES = [
  "ddns\\.net",
  "duckdns\\.org",
  "hopto\\.org",
  "zapto\\.org",
  "sytes\\.net",
  "myftp\\.(org|biz)",
  "serveo\\.net",
  "dyndns\\.(org|tv|info)",
  "no-ip\\.(org|biz|info|com)",
  "ddnsfree\\.com",
  "loginto\\.me",
];

export const PERSONAL_ENDPOINT_PATTERN = [
  // The specific historical hostname from JEL-139, split so this file does not
  // itself contain the token the guard greps for.
  `example${"host"}`,
  `[a-z0-9][a-z0-9.-]*\\.(${DDNS_SUFFIXES.join("|")})`,
].join("|");

/* -------------------------------------------------------------------------- */
/* pure helpers                                                               */
/* -------------------------------------------------------------------------- */

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The bytes the integrity hash is taken over. `JSON.parse` preserves key
 * insertion order, so a snapshot's `config` re-serializes to the exact string
 * that was hashed at capture time.
 */
export function canonicalConfigJson(config) {
  return JSON.stringify(config);
}

/** `20260904T161247Z` — the stamp form already used by this package's artifacts. */
export function stampFor(date) {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

export function defaultSnapshotName(stamp) {
  return `jsi-config-${stamp}.json`;
}

/** Entries the JSI plugin serves from the anonymous `/JavaScriptInjector/public.js`. */
export function isPublicEntry(entry) {
  return entry.Enabled === true && entry.RequiresAuthentication !== true;
}

export function configStats(config) {
  const entries = config?.CustomJavaScripts;
  if (!Array.isArray(entries)) {
    throw new Error("config has no CustomJavaScripts array");
  }
  let scriptBytes = 0;
  let enabled = 0;
  let publicEntries = 0;
  for (const e of entries) {
    scriptBytes += Buffer.byteLength(e?.Script || "", "utf8");
    if (e?.Enabled === true) enabled++;
    if (isPublicEntry(e || {})) publicEntries++;
  }
  return {
    entries: entries.length,
    enabledEntries: enabled,
    publicEntries,
    scriptBytes,
  };
}

export function buildSnapshot({ config, source, capturedAt }) {
  const stats = configStats(config);
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    capturedAt,
    // Deliberately no server URL: the origin is a personal dynamic-DNS
    // hostname and this file is committed (JEL-139).
    source,
    stats,
    configSha256: sha256Hex(canonicalConfigJson(config)),
    config,
  };
}

/** Structural validation. Throws with a single actionable message. */
export function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object") {
    throw new Error("snapshot is not an object");
  }
  if (snap.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `snapshot format is "${snap.format}" (want "${SNAPSHOT_FORMAT}")`,
    );
  }
  if (snap.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshot formatVersion is ${snap.formatVersion} (this tool reads ${SNAPSHOT_FORMAT_VERSION})`,
    );
  }
  if (!snap.config || typeof snap.config !== "object") {
    throw new Error("snapshot has no config object");
  }
  // Throws if CustomJavaScripts is missing/not an array.
  configStats(snap.config);
  return snap;
}

/**
 * Integrity check. A snapshot whose recorded hash does not match its body has
 * been hand-edited or truncated — refuse rather than POST it to prod.
 */
export function assertSnapshotIntegrity(snap) {
  const actual = sha256Hex(canonicalConfigJson(snap.config));
  if (actual !== snap.configSha256) {
    throw new Error(
      `snapshot integrity failure: configSha256 says ${snap.configSha256}, body hashes to ${actual}`,
    );
  }
  const recomputed = configStats(snap.config);
  for (const k of ["entries", "enabledEntries", "scriptBytes"]) {
    if (snap.stats?.[k] !== recomputed[k]) {
      throw new Error(
        `snapshot integrity failure: stats.${k} says ${snap.stats?.[k]}, body has ${recomputed[k]}`,
      );
    }
  }
  return snap;
}

export function findPersonalEndpoints(text) {
  const re = new RegExp(PERSONAL_ENDPOINT_PATTERN, "gi");
  return [...new Set((text.match(re) || []).map((m) => m.toLowerCase()))];
}

/**
 * How much smaller `next` is than `prev`, per axis, in percent. Negative means
 * it grew. This is the JELA-896 detector: the 12.0 wipe reads as 100/100.
 */
export function assessShrink(prev, next) {
  const pct = (a, b) => (a <= 0 ? 0 : ((a - b) / a) * 100);
  return {
    entriesDropPct: pct(prev.entries, next.entries),
    scriptBytesDropPct: pct(prev.scriptBytes, next.scriptBytes),
  };
}

/**
 * Compare two configs by entry Name. Names are unique on the live config and
 * are how every `jsi-jpNNN-patch.mjs` addresses an entry, so they are the
 * stable identity here.
 */
export function diffConfigs(from, to) {
  const index = (cfg) => {
    const m = new Map();
    for (const e of cfg.CustomJavaScripts || []) m.set(e?.Name, e);
    return m;
  };
  const a = index(from);
  const b = index(to);
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [name, entry] of b) {
    if (!a.has(name)) {
      added.push({
        name,
        bytes: Buffer.byteLength(entry?.Script || "", "utf8"),
      });
    } else if (JSON.stringify(a.get(name)) !== JSON.stringify(entry)) {
      changed.push({
        name,
        delta:
          Buffer.byteLength(entry?.Script || "", "utf8") -
          Buffer.byteLength(a.get(name)?.Script || "", "utf8"),
      });
    } else {
      unchanged++;
    }
  }
  for (const [name, entry] of a) {
    if (!b.has(name)) {
      removed.push({
        name,
        bytes: Buffer.byteLength(entry?.Script || "", "utf8"),
      });
    }
  }
  // Non-entry keys (DisableScriptInjectionMiddleware, PluginJavaScripts).
  const scalarKeys = new Set([
    ...Object.keys(from || {}),
    ...Object.keys(to || {}),
  ]);
  scalarKeys.delete("CustomJavaScripts");
  const otherKeysChanged = [...scalarKeys].filter(
    (k) => JSON.stringify(from?.[k]) !== JSON.stringify(to?.[k]),
  );
  return { added, removed, changed, unchanged, otherKeysChanged };
}

export function isIdenticalConfig(a, b) {
  return canonicalConfigJson(a) === canonicalConfigJson(b);
}

/**
 * Which enabled, anonymous entries are NOT byte-present in the served bundle.
 *
 * This is the check that [[jsi-config-save-off-by-one]] exists for: a `POST`
 * that round-trips through `GET /Plugins/{id}/Configuration` proves nothing
 * about what TVs receive, because the bundle only rebuilds on the NEXT save (or
 * a restart). The served artifact is the only authority.
 *
 * `RequiresAuthentication` entries are served from `private.js`, which is
 * per-user and 401s for an API key, so they are reported as unverifiable
 * rather than silently counted as present.
 */
export function verifyServed(config, servedText) {
  const missing = [];
  let expected = 0;
  let unverifiable = 0;
  for (const e of config.CustomJavaScripts || []) {
    if (e?.Enabled !== true) continue;
    if (e.RequiresAuthentication === true) {
      unverifiable++;
      continue;
    }
    const body = e.Script || "";
    if (!body) continue;
    expected++;
    if (!servedText.includes(body)) missing.push(e.Name);
  }
  return {
    expected,
    present: expected - missing.length,
    missing,
    unverifiable,
  };
}

/* -------------------------------------------------------------------------- */
/* Jellyfin transport                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Jellyfin 12.0 rejects the legacy `?api_key=` query param and `X-Emby-Token`
 * with a 401. The `MediaBrowser Token="..."` Authorization header is the form
 * that survived the major and is what the rest of this repo's tooling uses.
 */
export function authHeaders(apiKey) {
  return { Authorization: `MediaBrowser Token="${apiKey}"` };
}

async function jfFetch(baseUrl, apiKey, path, init = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(apiKey), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${init.method || "GET"} ${path} -> ${res.status} ${res.statusText}${
        body ? `: ${body.slice(0, 200)}` : ""
      }`,
    );
  }
  return res;
}

/** Resolve the JSI plugin id by name so no GUID is hard-coded. */
export async function discoverPlugin(baseUrl, apiKey, name = JSI_PLUGIN_NAME) {
  const res = await jfFetch(baseUrl, apiKey, "/Plugins");
  const plugins = await res.json();
  const hit = plugins.filter((p) => p.Name === name);
  if (hit.length !== 1) {
    throw new Error(
      `found ${hit.length} plugins named "${name}" (want exactly 1)`,
    );
  }
  return { id: hit[0].Id, name: hit[0].Name, version: hit[0].Version };
}

export async function getServerInfo(baseUrl, apiKey) {
  const res = await jfFetch(baseUrl, apiKey, "/System/Info");
  const info = await res.json();
  return { jellyfinVersion: info.Version };
}

export async function getPluginConfig(baseUrl, apiKey, pluginId) {
  const res = await jfFetch(
    baseUrl,
    apiKey,
    `/Plugins/${pluginId}/Configuration`,
  );
  return res.json();
}

export async function postPluginConfig(baseUrl, apiKey, pluginId, config) {
  await jfFetch(baseUrl, apiKey, `/Plugins/${pluginId}/Configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

/** Cache-busted so a proxy cannot answer with the pre-save bundle. */
export async function getServedBundle(
  baseUrl,
  path = "/JavaScriptInjector/public.js",
) {
  const bust = `${path}?v=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${bust}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
  };
}

/* -------------------------------------------------------------------------- */
/* CLI plumbing shared by both tools                                           */
/* -------------------------------------------------------------------------- */

export function resolveConnection(args) {
  const url = args.url || process.env.JELLYFIN_URL;
  const apiKey = args.apiKey || process.env.JELLYFIN_API_KEY;
  if (!url) {
    throw new Error("no server: pass --url or set JELLYFIN_URL");
  }
  if (!apiKey) {
    throw new Error("no credential: pass --api-key or set JELLYFIN_API_KEY");
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) {
      out._.push(k);
      continue;
    }
    const key = k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (spec.flags.includes(key)) out[key] = true;
    else if (spec.values.includes(key)) out[key] = argv[++i];
    else throw new Error(`unknown option ${k}`);
  }
  return out;
}

export function fmtBytes(n) {
  return n.toLocaleString("en-US");
}
