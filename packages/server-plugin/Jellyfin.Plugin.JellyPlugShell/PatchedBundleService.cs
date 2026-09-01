using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using MediaBrowser.Controller;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// One published patched body: the bytes a TV executes, plus everything the
/// manifest advertisement and the cache headers need.
/// </summary>
public sealed class PatchedBundle
{
    private readonly Lazy<byte[]?> _gzip;

    public PatchedBundle(string buildHash, string name, byte[] bytes, string sha256, int patches, int sourceLength)
    {
        BuildHash = buildHash;
        Name = name;
        Bytes = bytes;
        Sha256 = sha256;
        Patches = patches;
        SourceLength = sourceLength;
        _gzip = new Lazy<byte[]?>(() => GzipOrNull(bytes));
    }

    /// <summary>The jellyfin-web build stamp — the query webpack puts on every index.html script src.</summary>
    public string BuildHash { get; }

    /// <summary>Bare filename as it appears on the index (main.jellyfin.bundle.js).</summary>
    public string Name { get; }

    public byte[] Bytes { get; }

    public string Sha256 { get; }

    public int Patches { get; }

    public int SourceLength { get; }

    /// <summary>Relative URL the shell writes into its <c>&lt;script defer src&gt;</c>.</summary>
    public string Url => "/shell/patched/" + BuildHash + "/" + Name;

    public byte[]? Gzip => _gzip.Value;

    private static byte[]? GzipOrNull(byte[] raw)
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
            return null; // raw body still serves; /shell/ must stay serveable
        }
    }
}

/// <summary>
/// JELA-865. Publishes the CM/PM-patched main jellyfin-web bundle at a real
/// URL so the TV's HTML parser — not the shell's own <c>fetch</c> — owns the
/// load.
///
/// Why this exists at all: the shells patch the bundle by INLINING the rewritten
/// body into the markup they document.write. JELA-863's trace census priced that
/// on a Tizen 5.0 panel — Blink only streams scripts it loaded itself over
/// http(s), so an inlined ~500 KB body moved ~194 ms of <c>V8.CompileCode</c>
/// off the ScriptStreamerThread and onto the pre-paint main thread, and the
/// cached body cost 497,795 characters of the TV's 5 MB localStorage quota
/// (JELA-797/843). The fix is not to stop patching; it is to stop inlining.
///
/// Discovery mirrors <see cref="ScheduledTasks.TxDropRebuildTask"/>: read the
/// SERVED /web/index.html over local access (never the filesystem — the served
/// index is what the TV parses, and other plugins rewrite it), find the main
/// bundle's script tag, fetch that body, patch it. Content addressing is the
/// webpack build stamp already on every index.html script query, so a
/// jellyfin-web upgrade changes the URL by construction and no TV can be handed
/// bytes from a build its sibling bundles do not belong to.
/// </summary>
public class PatchedBundleService
{
    /// <summary>
    /// The shells' main-bundle test (patchPlaybackBundles), applied to the bare
    /// path: <c>main.*.bundle.js</c> anchored at a path segment.
    /// </summary>
    private static readonly Regex MainBundleRe = new(
        @"(^|/)main\.[^/]*\.bundle\.js$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex ScriptSrcRe = new(
        "<script\\b[^>]*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"']",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Build stamps and bundle names both become URL path segments, so both are
    /// held to a conservative shape. This is also the route's whitelist — see
    /// <see cref="IsSafeSegment"/>.
    /// </summary>
    private static readonly Regex SafeSegmentRe = new("^[A-Za-z0-9._-]{1,64}$", RegexOptions.ECMAScript | RegexOptions.Compiled);

    private readonly IServerApplicationHost _appHost;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<PatchedBundleService> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private PatchedBundle? _current;

    public PatchedBundleService(
        IServerApplicationHost appHost,
        IHttpClientFactory httpClientFactory,
        ILogger<PatchedBundleService> logger)
    {
        _appHost = appHost;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// The published body, or null when nothing has been built yet or the last
    /// build declined to publish. Never blocks — the manifest is on the TV's
    /// critical path and must not wait on a 500 KB loopback fetch.
    /// </summary>
    public PatchedBundle? Current => _current;

    public static bool IsSafeSegment(string? segment) => segment != null && SafeSegmentRe.IsMatch(segment);

    /// <summary>
    /// Builds (or rebuilds) the patched body. Serialized: a burst of cold TVs
    /// must not each pull the bundle over loopback. Returns the published body,
    /// or null when the index could not be read, carried no main bundle, or
    /// carried the throw text in a shape none of the patterns matched — the last
    /// case being exactly the shell's "bundle has error string but no pattern
    /// matched" warning, where publishing would claim a patch we did not make.
    /// </summary>
    public async Task<PatchedBundle?> EnsureAsync(bool force, CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (config.DisablePatchedBundle)
        {
            _current = null;
            return null;
        }

        if (!force && _current != null)
        {
            return _current;
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!force && _current != null)
            {
                return _current;
            }

            var built = await BuildAsync(cancellationToken).ConfigureAwait(false);
            if (built != null)
            {
                _current = built;
            }

            return built ?? _current;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<PatchedBundle?> BuildAsync(CancellationToken cancellationToken)
    {
        var baseUrl = _appHost.GetApiUrlForLocalAccess(allowHttps: false).TrimEnd('/');
        using var http = _httpClientFactory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(60);

        string indexHtml;
        try
        {
            indexHtml = await http.GetStringAsync(baseUrl + "/web/index.html", cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "patched-bundle: could not read /web/index.html; nothing published");
            return null;
        }

        var src = FindMainBundleSrc(indexHtml);
        if (src == null)
        {
            _logger.LogInformation("patched-bundle: no main.*.bundle.js on the served index; nothing published");
            return null;
        }

        var parts = src.Split('?');
        var name = parts[0].Split('/')[^1];
        var buildHash = parts.Length > 1 ? parts[1] : string.Empty;
        if (!IsSafeSegment(name) || !IsSafeSegment(buildHash))
        {
            // No usable build stamp means no way to content-address the body, and
            // an unstamped URL could outlive a jellyfin-web upgrade in a TV's HTTP
            // cache. Decline rather than publish something that can go stale.
            _logger.LogInformation(
                "patched-bundle: main bundle src {Src} has no path-safe name+build stamp; nothing published",
                src);
            return null;
        }

        string body;
        try
        {
            var abs = new Uri(new Uri(baseUrl + "/web/"), src).ToString();
            body = await http.GetStringAsync(abs, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "patched-bundle: could not read {Src}; nothing published", src);
            return null;
        }

        var result = BundleSourcePatcher.Patch(body);
        if (result.NeedleFound && result.Patches == 0)
        {
            _logger.LogWarning(
                "patched-bundle: {Name} carries the throw text but no pattern matched; nothing published (TVs keep their own patch path)",
                name);
            return null;
        }

        var bytes = Encoding.UTF8.GetBytes(result.Source);
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        _logger.LogInformation(
            "patched-bundle published: {Name}?{Build} patches={Patches} ({In} -> {Out} chars)",
            name,
            buildHash,
            result.Patches,
            body.Length,
            result.Source.Length);
        return new PatchedBundle(buildHash, name, bytes, sha, result.Patches, body.Length);
    }

    /// <summary>
    /// First <c>&lt;script src&gt;</c> on the served index whose bare path is a
    /// main jellyfin-web bundle. Inline-scheme sources are skipped for the same
    /// reason <see cref="TxDropBuilder.ScriptSrcsFromWebIndex"/> skips them.
    /// </summary>
    public static string? FindMainBundleSrc(string html)
    {
        foreach (Match m in ScriptSrcRe.Matches(html ?? string.Empty))
        {
            var src = m.Groups[1].Value;
            if (Regex.IsMatch(src, "^(?:data|blob|javascript):", RegexOptions.IgnoreCase))
            {
                continue;
            }

            var bare = src.Split('?')[0];
            if (Regex.IsMatch(bare, "serviceworker", RegexOptions.IgnoreCase))
            {
                continue;
            }

            if (MainBundleRe.IsMatch(bare))
            {
                return src;
            }
        }

        return null;
    }
}
