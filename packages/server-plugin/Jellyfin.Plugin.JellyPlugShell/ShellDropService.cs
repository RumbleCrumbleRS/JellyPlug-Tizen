using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Holds the embedded /shell/ assets plus the derived manifest.json, and owns
/// the on-disk tx-drop directory the scheduled rebuild publishes into. The
/// drop lives under the server data dir (not the plugin folder) so it
/// survives plugin updates.
/// </summary>
public class ShellDropService
{
    private const string MinBootstrapVersion = "2.0.0";

    public ShellDropService(IApplicationPaths appPaths)
    {
        ShellBytes = ReadResource("JellyPlugShell.Resources.shell.min.js");
        BabelBytes = ReadResource("JellyPlugShell.Resources.babel.min.js");
        LiteBytes = ReadResource("JellyPlugShell.Resources.lite.min.js");
        BabelTransformSource = Encoding.UTF8.GetString(
            ReadResource("JellyPlugShell.Resources.babel-transform.min.js"));

        ShellSha256 = Sha256Hex(ShellBytes);
        BabelSha256 = Sha256Hex(BabelBytes);
        LiteSha256 = Sha256Hex(LiteBytes);

        // JELA-688: gzip once, serve many. Jellyfin runs no response
        // compression over plugin routes (JavaScriptInjector compresses
        // itself; we never did), so /shell/* went out raw: 190 KB shell +
        // 34 KB lite every warm boot, 2.0 MB babel on a cold/stranded one.
        // Lazy, not ctor-eager, because this service is a DI singleton
        // constructed on the FIRST /shell/ request: compressing 2 MB of babel
        // there would sit in front of the shell fetch on the boot critical
        // path, and babel is only ever requested by the rare TV that falls
        // through to the on-device transform. Each body is compressed at most
        // once, on the first request that can actually use it.
        _shellGzip = LazyGzip(ShellBytes);
        _babelGzip = LazyGzip(BabelBytes);
        _liteGzip = LazyGzip(LiteBytes);

        var shellVersion = ExtractShellVersion(Encoding.UTF8.GetString(ShellBytes));

        // liteSha256 is ADDITIVE like the JELA-58 fingerprint fields: old
        // TVs JSON.parse the manifest and ignore keys they do not know, and
        // every legacy key keeps its exact shape/order. The shell's Lite
        // loader (JELA-67, opt-in flag) keys its localStorage byte cache on
        // this sha exactly like the HSB bootstrap keys the shell cache on
        // sha256.
        _baseManifest = new Dictionary<string, object?>
        {
            ["version"] = shellVersion,
            ["sha256"] = ShellSha256,
            ["shellUrl"] = null,
            ["babelSha256"] = BabelSha256,
            ["minBootstrapVersion"] = MinBootstrapVersion,
            ["bootstrapWgt"] = null,
            ["liteSha256"] = LiteSha256,
        };
        ManifestJson = JsonSerializer.SerializeToUtf8Bytes(_baseManifest);

        DropDir = Path.Combine(appPaths.DataPath, "jellyplug-shell");
        TxDir = Path.Combine(DropDir, "tx");
        TxManifestPath = Path.Combine(DropDir, "tx-manifest.json");
    }

    private readonly Dictionary<string, object?> _baseManifest;

    private readonly Lazy<byte[]?> _shellGzip;
    private readonly Lazy<byte[]?> _babelGzip;
    private readonly Lazy<byte[]?> _liteGzip;

    // JELA-708: per-hash gzip of the on-disk tx/{hash}.js bodies. Unlike the
    // three embedded assets above these are not held in memory, so the cache
    // is keyed and bounded rather than one Lazy per asset.
    private readonly ConcurrentDictionary<string, Lazy<byte[]?>> _txGzip = new(StringComparer.Ordinal);

    private readonly object _txManifestGzipLock = new();
    private (long Length, DateTime LastWriteUtc, byte[]? Gzip) _txManifestGzip = (-1, default, null);

    public byte[] ShellBytes { get; }

    public byte[] BabelBytes { get; }

    /// <summary>JELA-67: JellyPlug Lite canvas home (packages/jellyplug-lite dist blob).</summary>
    public byte[] LiteBytes { get; }

    public string ShellSha256 { get; }

    public string BabelSha256 { get; }

    public string LiteSha256 { get; }

    /// <summary>
    /// JELA-688: gzip of <see cref="ShellBytes"/>, or null when compression
    /// did not pay (see <see cref="Gzip"/>). Null means "serve the raw bytes",
    /// never "fail the request".
    /// </summary>
    public byte[]? ShellGzipBytes => _shellGzip.Value;

    /// <summary>JELA-688: gzip of <see cref="BabelBytes"/> — the 2 MB cold-boot body, by far the biggest win.</summary>
    public byte[]? BabelGzipBytes => _babelGzip.Value;

    /// <summary>JELA-688: gzip of <see cref="LiteBytes"/>.</summary>
    public byte[]? LiteGzipBytes => _liteGzip.Value;

    /// <summary>
    /// Legacy manifest.json body (emit_manifest.py schema) — the exact bytes
    /// served before JELA-58, still served verbatim when the config
    /// fingerprint is disabled or unavailable.
    /// </summary>
    public byte[] ManifestJson { get; }

    /// <summary>
    /// JELA-58: manifest.json with the ADDITIVE config-fingerprint fields
    /// appended after the legacy keys — `configEpoch` plus per-group
    /// `components`. JELA-141 adds the equally-additive `flagDefaults` map
    /// after them. Old TVs JSON.parse and ignore the extras; nothing in the
    /// legacy schema changes shape or value, and with neither extra present
    /// the exact legacy bytes are returned.
    /// </summary>
    public byte[] BuildManifestJson(ConfigFingerprint? fingerprint, Dictionary<string, string>? flagDefaults = null)
    {
        if (fingerprint == null && flagDefaults == null)
        {
            return ManifestJson;
        }

        var manifest = new Dictionary<string, object?>(_baseManifest);
        if (fingerprint != null)
        {
            manifest["configEpoch"] = fingerprint.Epoch;
            manifest["components"] = fingerprint.ComponentsDictionary();
        }

        if (flagDefaults != null)
        {
            manifest["flagDefaults"] = flagDefaults;
        }

        return JsonSerializer.SerializeToUtf8Bytes(manifest);
    }

    /// <summary>
    /// JELA-141: the additive `flagDefaults` manifest map, or null when every
    /// Lite default is off — null keeps the served manifest byte-identical to
    /// pre-JELA-141, and an ABSENT field is itself meaningful on the TV side
    /// (shells clear their cached defaults record, so rolling the plugin back
    /// to a version without the field is a working fleet kill switch). All
    /// three keys are always emitted together with explicit "0"/"1" values so
    /// a flip of one flag can never be misread as "no opinion" on another.
    /// </summary>
    public static Dictionary<string, string>? LiteFlagDefaults(PluginConfiguration config)
    {
        if (!config.LiteDefaultOn && !config.LiteNativeDefaultOn && !config.LiteSubsDefaultOn)
        {
            return null;
        }

        return new Dictionary<string, string>
        {
            ["jellyfin.shell.liteEnabled"] = config.LiteDefaultOn ? "1" : "0",
            ["jellyfin.lite.native"] = config.LiteNativeDefaultOn ? "1" : "0",
            ["jellyfin.lite.subs"] = config.LiteSubsDefaultOn ? "1" : "0",
        };
    }

    /// <summary>The official @babel/standalone UMD source used for server-side transforms.</summary>
    public string BabelTransformSource { get; }

    public string DropDir { get; }

    public string TxDir { get; }

    public string TxManifestPath { get; }

    /// <summary>
    /// JELA-708: bound for <see cref="_txGzip"/>. A cold boot pulls ~69 tx
    /// bodies (~200 KiB gzipped total) and the merged corpus grows slowly, so
    /// the cap exists only to keep a pathological drop from growing the cache
    /// without limit — not as an eviction policy worth bookkeeping for.
    /// </summary>
    private const int TxGzipCacheCap = 512;

    /// <summary>
    /// JELA-708: gzip of one published tx/{hash}.js body, or null when the
    /// file is unreadable or compression does not pay — null means "serve the
    /// raw file", never "fail the request", same contract as the asset gzips
    /// above. Cached per hash: the hash is the fnv1a of the SOURCE text and a
    /// published body is never rewritten within a drop, so an entry cannot go
    /// stale between rebuilds; <see cref="ResetTxGzipCache"/> covers the one
    /// path that can change bytes under a hash (a deleted body re-lowered by
    /// a newer Babel). Past the cap the cache is dropped wholesale and
    /// repopulates on demand. The caller must pre-validate
    /// <paramref name="hash"/> (ShellController's HashRe) — it is joined into
    /// a path here.
    /// </summary>
    public byte[]? TxGzipBytes(string hash)
    {
        if (_txGzip.Count >= TxGzipCacheCap && !_txGzip.ContainsKey(hash))
        {
            _txGzip.Clear();
        }

        return _txGzip.GetOrAdd(
            hash,
            h => new Lazy<byte[]?>(() => GzipTxFile(h), LazyThreadSafetyMode.ExecutionAndPublication)).Value;
    }

    /// <summary>
    /// JELA-708: gzip of the current tx-manifest.json, or null (serve raw).
    /// The manifest is rewritten by every rebuild, so the cache validates
    /// against the file's length + mtime on each call instead of trusting a
    /// hash — the publish is an atomic rename, so a mismatched stamp costs one
    /// recompute, never a torn read.
    /// </summary>
    public byte[]? TxManifestGzipBytes()
    {
        try
        {
            var info = new FileInfo(TxManifestPath);
            if (!info.Exists)
            {
                return null;
            }

            var length = info.Length;
            var stamp = info.LastWriteTimeUtc;
            lock (_txManifestGzipLock)
            {
                if (_txManifestGzip.Length == length && _txManifestGzip.LastWriteUtc == stamp)
                {
                    return _txManifestGzip.Gzip;
                }
            }

            var gzip = Gzip(File.ReadAllBytes(TxManifestPath));
            lock (_txManifestGzipLock)
            {
                _txManifestGzip = (length, stamp, gzip);
            }

            return gzip;
        }
        catch (Exception)
        {
            return null; // fall back to the raw file; /shell/ must stay serveable
        }
    }

    /// <summary>
    /// JELA-708: called by TxDropRebuildTask after a rebuild published new
    /// bodies. Content-addressing makes this belt-and-braces for tx/ (see
    /// <see cref="TxGzipBytes"/>) and load-bearing for the manifest stamp.
    /// </summary>
    public void ResetTxGzipCache()
    {
        _txGzip.Clear();
        lock (_txManifestGzipLock)
        {
            _txManifestGzip = (-1, default, null);
        }
    }

    private byte[]? GzipTxFile(string hash)
    {
        try
        {
            return Gzip(File.ReadAllBytes(Path.Combine(TxDir, hash + ".js")));
        }
        catch (Exception)
        {
            return null; // fall back to the raw file; /shell/ must stay serveable
        }
    }

    private static byte[] ReadResource(string logicalName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"missing embedded resource {logicalName}");
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string Sha256Hex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static Lazy<byte[]?> LazyGzip(byte[] raw)
        => new(() => Gzip(raw), LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>
    /// JELA-688: gzip a served asset, or return null when the compressed body
    /// would not be strictly smaller than the raw one. Null is a normal
    /// outcome the caller handles by serving the raw bytes — a TV must never
    /// be handed MORE bytes than it would have got uncompressed, and a
    /// compressor fault must never turn a served asset into a failed boot.
    /// <see cref="CompressionLevel.SmallestSize"/> is `gzip -9`, the level the
    /// JELA-688 measurements were taken at; it runs once per asset per server
    /// lifetime, so the CPU is irrelevant and only the wire size matters.
    /// </summary>
    private static byte[]? Gzip(byte[] raw)
    {
        try
        {
            using var ms = new MemoryStream(raw.Length / 2);
            using (var gz = new GZipStream(ms, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                gz.Write(raw, 0, raw.Length);
            }

            return ms.Length < raw.Length ? ms.ToArray() : null;
        }
        catch (Exception)
        {
            return null; // fall back to the raw body; /shell/ must stay serveable
        }
    }

    /// <summary>
    /// Mirrors emit_manifest.py extract_shell_version(): scan the head bytes
    /// for the inlined shell version. The current min build carries it as
    /// ver:"1.0.75" in the boot-phase record; the python patterns are kept as
    /// fallbacks.
    /// </summary>
    private static string ExtractShellVersion(string shellText)
    {
        var head = shellText.Length > 8192 ? shellText[..8192] : shellText;
        foreach (var pattern in new[]
        {
            "[^\\w]ver\\s*[:=]\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
            "shellVer\\s*[:=]\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
            "\"version\"\\s*:\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
        })
        {
            var m = Regex.Match(head, pattern, RegexOptions.ECMAScript);
            if (m.Success)
            {
                return m.Groups[1].Value;
            }
        }

        return "unknown";
    }
}
