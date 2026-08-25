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

        FontAssets = LoadFontAssets();

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

    /// <summary>
    /// JELA-710: one served /shell/fonts/ body. WOFF2 bodies carry no gzip —
    /// WOFF2 is Brotli inside, and gzip-over-woff2 comes back larger, which
    /// <see cref="Gzip"/> already collapses to null; the two CSS bodies do
    /// compress and get the usual lazy treatment.
    /// </summary>
    public sealed class FontAsset
    {
        public FontAsset(byte[] bytes, string sha256, string contentType, Lazy<byte[]?> gzip)
        {
            Bytes = bytes;
            Sha256 = sha256;
            ContentType = contentType;
            _gzip = gzip;
        }

        private readonly Lazy<byte[]?> _gzip;

        public byte[] Bytes { get; }

        public string Sha256 { get; }

        public string ContentType { get; }

        public byte[]? GzipBytes => _gzip.Value;
    }

    /// <summary>
    /// JELA-710: the self-hosted webfont drop, keyed by served file name
    /// (e.g. "inter-v20-400-latin.woff2", "inter-sora.css"). Contents come
    /// from the embedded Resources/fonts/ directory; regenerate it with
    /// scripts/fetch-webfonts.py.
    /// </summary>
    public IReadOnlyDictionary<string, FontAsset> FontAssets { get; }

    private static Dictionary<string, FontAsset> LoadFontAssets()
    {
        const string prefix = "JellyPlugShell.Resources.fonts.";
        var assets = new Dictionary<string, FontAsset>(StringComparer.Ordinal);
        foreach (var resource in Assembly.GetExecutingAssembly().GetManifestResourceNames())
        {
            if (!resource.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            var name = resource[prefix.Length..];
            var bytes = ReadResource(resource);
            var contentType = name.EndsWith(".css", StringComparison.Ordinal)
                ? "text/css; charset=utf-8"
                : "font/woff2";
            assets[name] = new FontAsset(bytes, Sha256Hex(bytes), contentType, LazyGzip(bytes));
        }

        return assets;
    }

    /// <summary>The official @babel/standalone UMD source used for server-side transforms.</summary>
    public string BabelTransformSource { get; }

    public string DropDir { get; }

    public string TxDir { get; }

    public string TxManifestPath { get; }

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
