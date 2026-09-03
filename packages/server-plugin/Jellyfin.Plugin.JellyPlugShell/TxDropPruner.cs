using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// One published body's prune bookkeeping: the source URL that last produced
/// this hash, and how many consecutive rebuilds have failed to rediscover it.
/// </summary>
public record TxPruneEntry(string? From, int Miss);

/// <summary>What one prune pass did.</summary>
public record TxPruneOutcome(int Kept, int Superseded, int Expired, int Pending, long BytesFreed)
{
    /// <summary>Bodies deleted this pass — superseded plus grace-expired.</summary>
    public int Deleted => Superseded + Expired;
}

/// <summary>
/// JELA-881: the drop's garbage collector.
///
/// <see cref="TxDropBuilder"/> merges the previous manifest on every rebuild
/// so a partially-failing run never un-publishes still-valid work, and until
/// this existed nothing ever removed anything: every JSI config save gave the
/// lowered public.js new bytes, a new fnv1a, and a new tx/&lt;hash&gt;.js, and
/// the superseded body stayed published forever (measured live 2026-09-03:
/// 98 of 258 entries, 70.7 MB, were stale copies of that one file).
///
/// The rule is <b>supersession is certain, absence is not</b>:
///
/// <list type="bullet">
/// <item>A hash the walk rediscovered is live. Keep it.</item>
/// <item>A hash whose owning source URL WAS fetched this run and now hashes to
/// something else is provably dead — the thing that published it still exists
/// and no longer produces it. Delete immediately.</item>
/// <item>A hash nobody claimed this run may just be a discovery gap (the
/// /web/ index fetch failed, a module 404'd transiently, the dynamic scan hit
/// its fetch cap). Those are expected and self-healing, so absence only earns
/// a strike; deletion waits until <c>graceRebuilds</c> consecutive rebuilds
/// have missed it.</item>
/// </list>
///
/// The strikes and the hash→source-URL map live in a sidecar
/// (<c>tx-prune-state.json</c>) next to the manifest, never in the manifest —
/// the manifest is TV-facing and its normalized sha gates the config
/// fingerprint. The manifest is rewritten (atomic rename, JEL-653 parity)
/// BEFORE any file is unlinked, so a body is never referenced by a published
/// manifest it can no longer be served from.
/// </summary>
public static class TxDropPruner
{
    /// <summary>
    /// Consecutive rebuilds an unclaimed body survives before deletion. One
    /// strike covers a single flaky discovery pass (the 6 h rebuild interval
    /// makes that ~12 h of tolerance) and bounds unclaimed growth at two
    /// copies; a superseded body does not wait at all.
    /// </summary>
    public const int DefaultGraceRebuilds = 1;

    /// <summary>
    /// Delete published tx bodies the current discovery walk can no longer
    /// reach. <paramref name="discovered"/> maps every source URL fetched this
    /// run to the fnv1a of the text it served — the same hash
    /// <see cref="TxDropBuilder"/> publishes under, computed for EVERY fetched
    /// source including ones the precheck skipped and ones whose transform
    /// failed. A failed transform therefore cannot evict its own previously
    /// published body: the source was still discovered, so its hash is still
    /// reachable (the JELA-833 / --merge invariant).
    /// </summary>
    public static TxPruneOutcome Prune(
        string txDir,
        string manifestPath,
        string statePath,
        IReadOnlyDictionary<string, string> discovered,
        int graceRebuilds,
        ILogger? logger = null)
    {
        var grace = Math.Max(0, graceRebuilds);

        // A caller that discovered nothing tells us nothing about what is
        // dead. TxDropRebuildTask already bails before rebuilding in that
        // case; this is the belt to its braces, because the one bug this
        // module could ever have is "deleted the whole drop".
        if (discovered.Count == 0)
        {
            logger?.LogWarning("tx-drop prune skipped: no sources were discovered this run");
            return new TxPruneOutcome(0, 0, 0, 0, 0);
        }

        var reachable = new HashSet<string>(discovered.Values, StringComparer.Ordinal);
        var fetchedUrls = new HashSet<string>(discovered.Keys, StringComparer.Ordinal);
        var prev = LoadState(statePath, logger);

        // Everything currently published: manifest entries UNION on-disk
        // bodies. The union matters in both directions — an entry whose file
        // vanished should leave the manifest, and a body written by a run that
        // died before its manifest rename is an orphan only this side sees.
        var manifest = LoadManifest(manifestPath, logger);
        if (manifest.Unreadable)
        {
            // The manifest exists but will not parse. Its entry set is
            // unknown, so every on-disk body looks like an orphan — exactly
            // the shape that would delete the whole drop. Leave it alone; the
            // next rebuild republishes a valid manifest and prunes then.
            logger?.LogWarning("tx-drop prune skipped: tx-manifest.json is present but unreadable");
            return new TxPruneOutcome(0, 0, 0, 0, 0);
        }

        var published = new HashSet<string>(manifest.Entries.Keys, StringComparer.Ordinal);
        foreach (var f in EnumerateBodies(txDir))
        {
            published.Add(Path.GetFileNameWithoutExtension(f));
        }

        var next = new Dictionary<string, TxPruneEntry>(StringComparer.Ordinal);
        var doomed = new List<string>();
        int kept = 0, superseded = 0, expired = 0;

        foreach (var hash in published)
        {
            if (reachable.Contains(hash))
            {
                kept++;
                continue; // live: no bookkeeping, so a returning body starts clean
            }

            var owner = prev.TryGetValue(hash, out var p) ? p.From : null;
            if (owner != null && fetchedUrls.Contains(owner))
            {
                superseded++; // its publisher answered and no longer produces it
                doomed.Add(hash);
                continue;
            }

            var miss = (p?.Miss ?? 0) + 1;
            if (miss > grace)
            {
                expired++;
                doomed.Add(hash);
            }
            else
            {
                next[hash] = new TxPruneEntry(owner, miss);
            }
        }

        // Remember who published each live hash, so the NEXT rebuild can tell
        // a supersession from a discovery gap.
        foreach (var kv in discovered)
        {
            if (published.Contains(kv.Value))
            {
                next[kv.Value] = new TxPruneEntry(kv.Key, 0);
            }
        }

        if (doomed.Count > 0 && manifest.Exists)
        {
            WriteManifestWithout(manifestPath, manifest, doomed, logger);
        }

        long freed = 0;
        foreach (var hash in doomed)
        {
            var path = Path.Combine(txDir, hash + ".js");
            try
            {
                var len = new FileInfo(path).Length;
                File.Delete(path);
                freed += len;
            }
            catch (Exception ex)
            {
                logger?.LogWarning(ex, "could not delete stale tx body {Hash}", hash);
            }
        }

        SaveState(statePath, next, grace, logger);

        logger?.LogInformation(
            "tx-drop pruned: kept={Kept} superseded={Superseded} expired={Expired} pending={Pending} freed={FreedKiB} KiB",
            kept,
            superseded,
            expired,
            next.Count(e => e.Value.Miss > 0),
            freed / 1024);

        return new TxPruneOutcome(kept, superseded, expired, next.Count(e => e.Value.Miss > 0), freed);
    }

    private static IEnumerable<string> EnumerateBodies(string txDir)
    {
        try
        {
            return Directory.Exists(txDir)
                ? Directory.EnumerateFiles(txDir, "*.js", SearchOption.TopDirectoryOnly).ToList()
                : Array.Empty<string>();
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// The manifest, decomposed: entries as a plain map, every OTHER top-level
    /// key kept as a detached JsonElement so a republish can round-trip it.
    /// </summary>
    private record LoadedManifest(
        bool Exists,
        bool Unreadable,
        Dictionary<string, string> Entries,
        Dictionary<string, JsonElement> Other);

    private static LoadedManifest LoadManifest(string manifestPath, ILogger? logger)
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal);
        var other = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (!File.Exists(manifestPath))
        {
            return new LoadedManifest(false, false, entries, other);
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return new LoadedManifest(true, true, entries, other);
            }

            foreach (var p in doc.RootElement.EnumerateObject())
            {
                if (string.Equals(p.Name, "entries", StringComparison.Ordinal) && p.Value.ValueKind == JsonValueKind.Object)
                {
                    foreach (var e in p.Value.EnumerateObject())
                    {
                        var rel = e.Value.GetString();
                        if (rel != null)
                        {
                            entries[e.Name] = rel;
                        }
                    }
                }
                else
                {
                    other[p.Name] = p.Value.Clone(); // Clone outlives the document
                }
            }

            return new LoadedManifest(true, false, entries, other);
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "could not parse tx-manifest for pruning");
            return new LoadedManifest(true, true, entries, other);
        }
    }

    /// <summary>
    /// Republish the manifest without the doomed hashes, preserving every
    /// other top-level key verbatim (format, babelOptsKey, generated, and
    /// anything a later ticket adds) so pruning can never silently drop a
    /// field the device reads. Write + rename, same atomicity the builder's
    /// publish uses.
    /// </summary>
    private static void WriteManifestWithout(string manifestPath, LoadedManifest manifest, List<string> doomed, ILogger? logger)
    {
        try
        {
            var drop = new HashSet<string>(doomed, StringComparer.Ordinal);
            var root = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var p in manifest.Other)
            {
                root[p.Key] = p.Value;
            }

            var kept = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var e in manifest.Entries)
            {
                if (!drop.Contains(e.Key))
                {
                    kept[e.Key] = e.Value;
                }
            }

            root["entries"] = kept;

            var tmp = manifestPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(root, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, manifestPath, overwrite: true);
        }
        catch (Exception ex)
        {
            // The bodies stay on disk (we only unlink what the manifest no
            // longer references, and it still references them) — a failed
            // prune must cost disk, never a drop miss.
            logger?.LogWarning(ex, "could not republish the pruned tx-manifest; keeping the stale bodies");
            doomed.Clear();
        }
    }

    private static Dictionary<string, TxPruneEntry> LoadState(string statePath, ILogger? logger)
    {
        var state = new Dictionary<string, TxPruneEntry>(StringComparer.Ordinal);
        try
        {
            if (!File.Exists(statePath))
            {
                return state;
            }

            using var doc = JsonDocument.Parse(File.ReadAllText(statePath));
            if (!doc.RootElement.TryGetProperty("published", out var pub) || pub.ValueKind != JsonValueKind.Object)
            {
                return state;
            }

            foreach (var p in pub.EnumerateObject())
            {
                if (p.Value.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var from = p.Value.TryGetProperty("from", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : null;
                var miss = p.Value.TryGetProperty("miss", out var m) && m.TryGetInt32(out var mi) ? mi : 0;
                state[p.Name] = new TxPruneEntry(from, miss);
            }
        }
        catch (Exception ex)
        {
            // No state = every unclaimed body starts at zero strikes, i.e. one
            // extra grace cycle. Losing this file delays a prune, never
            // triggers one.
            logger?.LogWarning(ex, "could not read tx prune state; starting a fresh generation");
            state.Clear();
        }

        return state;
    }

    private static void SaveState(string statePath, Dictionary<string, TxPruneEntry> state, int grace, ILogger? logger)
    {
        try
        {
            var published = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var kv in state)
            {
                published[kv.Key] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["from"] = kv.Value.From,
                    ["miss"] = kv.Value.Miss,
                };
            }

            var root = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["format"] = 1,
                ["graceRebuilds"] = grace,
                ["published"] = published,
            };

            var tmp = statePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(root, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, statePath, overwrite: true);
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "could not persist tx prune state; the next rebuild re-strikes from zero");
        }
    }
}
