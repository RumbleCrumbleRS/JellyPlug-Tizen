using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-732: bounded, short-TTL response memo for the Home Screen Sections
/// plugin's row-contents endpoint (<c>/HomeScreen/Section/{name}</c>), which
/// ships with no Cache-Control and no ETag and therefore rebuilds 1.4-2.2 s of
/// server query CPU on every home load, on every TV, forever.
///
/// Deliberate shape, taken from the JELA-693 post-mortem on the sibling
/// section-*list* cache in that same plugin (which was never read, never
/// evicted and never user-scoped):
///
///   1. The ETag is a hash of the BODY. JELA-693's root cause was a key
///      (<c>Guid.NewGuid()</c>) that could never match what was stored.
///   2. Entries are keyed by CREDENTIAL, not by a caller-supplied hint. The
///      key covers method + path + query + the caller's API token + Origin, so
///      a hit can only ever be replayed to the exact credential that already
///      received that body with a 200. Nothing here can widen an
///      authorization decision, because a different credential is a different
///      key and takes the normal (authenticated) path.
///   3. Entries EXPIRE and the store is BOUNDED. JELA-693 defect 3 was an
///      unbounded dictionary with a LastAccessed field that was written and
///      never read. Here every insert prunes what has expired and, if the
///      store is still at its cap, drops the oldest entry.
///
/// Residual, bounded staleness: a token revoked mid-TTL keeps reading its own
/// already-authorized rows for up to the TTL (30 s by default). That is the
/// same window a <c>Cache-Control: private, max-age=30</c> gives any HTTP
/// client, and it is why the TTL is short and operator-tunable.
/// </summary>
public sealed class HomeScreenSectionCache
{
    /// <summary>Hard cap on retained entries (see class remarks, point 3).</summary>
    public const int MaxEntries = 256;

    /// <summary>
    /// Bodies larger than this are served through but never stored — a home
    /// row is a few tens of KiB, so this only ever fires on something that is
    /// not a home row.
    /// </summary>
    public const int MaxBodyBytes = 4 * 1024 * 1024;

    private readonly ConcurrentDictionary<string, CachedResponse> _entries =
        new(StringComparer.Ordinal);

    /// <summary>A stored 200 plus exactly the response headers a replay must reproduce.</summary>
    public sealed class CachedResponse
    {
        public required byte[] Body { get; init; }

        /// <summary>Strong ETag, computed from <see cref="Body"/> — never a timestamp, never a Guid.</summary>
        public required string ETag { get; init; }

        public required string ContentType { get; init; }

        /// <summary>
        /// CORS headers as Jellyfin's own middleware wrote them. A cache hit
        /// short-circuits ahead of that middleware, so a replay that dropped
        /// these would turn a working cross-origin fetch into a CORS failure
        /// on the TV. Origin is part of the key, so replaying them verbatim is
        /// exact rather than approximate.
        /// </summary>
        public string? AllowOrigin { get; init; }

        public string? AllowCredentials { get; init; }

        public string? ExposeHeaders { get; init; }

        public string? Vary { get; init; }

        public required DateTimeOffset StoredUtc { get; init; }

        public required DateTimeOffset ExpiresUtc { get; init; }
    }

    /// <summary>Live entry count — diagnostics and the eviction tests.</summary>
    public int Count => _entries.Count;

    /// <summary>
    /// Cache key over method + path + query + credential + Origin. Every part
    /// is length-prefixed so no two different tuples can flatten to the same
    /// string, and the whole thing is hashed so the raw API token is never
    /// held as a dictionary key.
    /// </summary>
    public static string BuildKey(string method, string path, string query, string credential, string? origin)
    {
        var sb = new StringBuilder();
        AppendPart(sb, method);
        AppendPart(sb, path);
        AppendPart(sb, query);
        AppendPart(sb, credential);
        AppendPart(sb, origin ?? string.Empty);

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexString(digest);
    }

    private static void AppendPart(StringBuilder sb, string value)
    {
        sb.Append(value.Length).Append(':').Append(value).Append('\n');
    }

    /// <summary>Strong ETag over the response body (JELA-693: a hash of the bytes, nothing else).</summary>
    public static string ComputeETag(byte[] body)
    {
        var digest = SHA256.HashData(body);
        return "\"" + Convert.ToHexString(digest).ToLowerInvariant() + "\"";
    }

    /// <summary>True when an If-None-Match header selects <paramref name="etag"/>.</summary>
    public static bool ETagMatches(string? ifNoneMatch, string etag)
    {
        if (string.IsNullOrEmpty(ifNoneMatch))
            return false;

        foreach (var candidate in ifNoneMatch.Split(','))
        {
            var trimmed = candidate.Trim();
            if (trimmed == "*")
                return true;

            if (StripWeak(trimmed) == StripWeak(etag))
                return true;
        }

        return false;
    }

    private static string StripWeak(string etag) =>
        etag.StartsWith("W/", StringComparison.Ordinal) ? etag.Substring(2) : etag;

    /// <summary>
    /// Returns a live entry, or null. Expired entries are dropped on the way
    /// out, so a stale body can never be served even if the pruner never runs.
    /// </summary>
    public CachedResponse? TryGet(string key, DateTimeOffset nowUtc)
    {
        if (!_entries.TryGetValue(key, out var entry))
            return null;

        if (entry.ExpiresUtc <= nowUtc)
        {
            _entries.TryRemove(key, out _);
            return null;
        }

        return entry;
    }

    /// <summary>Stores an entry, pruning expired ones and enforcing <see cref="MaxEntries"/>.</summary>
    public void Store(string key, CachedResponse entry)
    {
        Prune(entry.StoredUtc);
        _entries[key] = entry;
    }

    /// <summary>Drops everything — the operator kill switch and the tests use it.</summary>
    public void Clear() => _entries.Clear();

    private void Prune(DateTimeOffset nowUtc)
    {
        foreach (var pair in _entries)
        {
            if (pair.Value.ExpiresUtc <= nowUtc)
                _entries.TryRemove(pair.Key, out _);
        }

        while (_entries.Count >= MaxEntries)
        {
            var oldest = default(KeyValuePair<string, CachedResponse>);
            var haveOldest = false;

            foreach (var pair in _entries)
            {
                if (!haveOldest || pair.Value.StoredUtc < oldest.Value.StoredUtc)
                {
                    oldest = pair;
                    haveOldest = true;
                }
            }

            if (!haveOldest || !_entries.TryRemove(oldest.Key, out _))
                break;
        }
    }
}
