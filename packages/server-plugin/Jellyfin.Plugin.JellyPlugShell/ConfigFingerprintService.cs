using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Per-component fingerprint of everything a TV consumes at boot, plus the
/// ordered aggregate epoch (JELA-58 / plan JELA-57 §5.1). All values are
/// lowercase sha256 hex.
/// </summary>
public sealed record ConfigFingerprint(string Epoch, string Web, string Shell, string Scripts, string Branding)
{
    /// <summary>
    /// The one manifest/settings-facing view of the component groups — both
    /// /shell/manifest.json and the settings-page endpoints serve this, so a
    /// future fifth group cannot show up in one and not the other.
    /// </summary>
    public Dictionary<string, string> ComponentsDictionary() => new()
    {
        ["web"] = Web,
        ["shell"] = Shell,
        ["scripts"] = Scripts,
        ["branding"] = Branding,
    };
}

/// <summary>
/// JELA-58 (JELA-57 WS-1): computes a stable `configEpoch` over every source
/// of TV-visible boot configuration, so a TV whose cached epoch matches can
/// skip all revalidation traffic. Component groups (plan §5.1):
///
///   web      — jellyfin-web dist: index.html, config.json, the assets
///              index.html references, and every theme CSS byte (themes are
///              NOT content-hashed upstream, so bytes must be covered).
///   shell    — the plugin's own embedded shell.min.js + babel.min.js shas
///              plus a normalized view of the on-disk tx-drop manifest
///              (babelOptsKey + sorted entries; the `generated` timestamp is
///              deliberately EXCLUDED — the scheduled rebuild rewrites it on
///              every run even when no entry changed, and raw bytes would
///              churn the epoch for nothing).
///   scripts  — injector-style plugin state: plugin-config XMLs and plugin
///              folders whose names match the configured patterns (defaults
///              cover JS-Injector + JellyfinEnhanced), plus operator-listed
///              extra paths. Our own plugin config XML is excluded — this
///              plugin's toggles never change what a TV downloads (the shell
///              group already covers the served shell bytes). Plugin-config
///              XMLs hash with the configured VOLATILE leaf elements stripped
///              (JELA-139): JellyfinEnhanced rewrites its cache-clear
///              timestamps on its own, and hashing them churned the epoch —
///              one spurious (safe) resume reload fleet-wide per churn.
///   branding — the server branding config (custom CSS + splashscreen toggle
///              live in branding.xml under the configuration dir).
///
/// Component hash = sha256 over "label\0sha256(bytes)\n" lines sorted by
/// label (labels are roots-relative, so the epoch does not depend on where
/// the server is installed). Epoch = sha256 over the fixed-order aggregate
/// "web:.. shell:.. scripts:.. branding:..".
///
/// Freshness (plan §5.1): NO FileSystemWatcher — NAS/Docker bind mounts drop
/// inotify events silently. Instead a cheap path+mtime+size pre-scan runs at
/// most every ~30s; full byte re-hash only happens when the pre-scan
/// signature moves. Core config-saved events (branding lives there) hook
/// straight into cache invalidation where the server exposes them.
/// </summary>
public class ConfigFingerprintService
{
    /// <summary>Pre-scan at most every ~30s (plan §5.1 throttle).</summary>
    private static readonly TimeSpan PrescanInterval = TimeSpan.FromSeconds(30);

    /// <summary>Never byte-hash a single file larger than this (defensive cap; nothing a TV consumes is near it).</summary>
    private const long MaxHashedFileBytes = 32L * 1024 * 1024;

    /// <summary>Our own config XML never feeds the epoch (see class remarks).</summary>
    private const string OwnConfigFileName = "Jellyfin.Plugin.JellyPlugShell.xml";

    private static readonly Regex ScriptSrcRe = new(
        "<script\\b[^>]*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"']",
        RegexOptions.IgnoreCase | RegexOptions.ECMAScript);

    private static readonly Regex LinkHrefRe = new(
        "<link\\b[^>]*\\bhref\\s*=\\s*[\"']([^\"']+)[\"']",
        RegexOptions.IgnoreCase | RegexOptions.ECMAScript);

    private readonly ShellDropService _drop;
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<ConfigFingerprintService> _logger;
    private readonly object _sync = new();

    /// <summary>Serializes Rehash passes only — never held while serving manifest fetches.</summary>
    private readonly object _rehashGate = new();

    private long _prescanDueTicks; // Environment.TickCount64 basis; 0 = scan now
    private string? _prescanSignature;
    private ConfigFingerprint? _cached;
    private long _generation; // bumped by Invalidate(); detects saves racing a Rehash pass

    public ConfigFingerprintService(
        ShellDropService drop,
        IApplicationPaths appPaths,
        IServerConfigurationManager configurationManager,
        ILogger<ConfigFingerprintService> logger)
    {
        _drop = drop;
        _appPaths = appPaths;
        _logger = logger;

        // Branding (and other core named configs) save through here — skip the
        // 30s throttle window for those so an operator edit is visible on the
        // very next manifest fetch. Plugin-config saves have no server-wide
        // event on 10.11; the throttled pre-scan picks those up.
        configurationManager.NamedConfigurationUpdated += (_, _) => Invalidate();
        configurationManager.ConfigurationUpdated += (_, _) => Invalidate();

        // JELA-62: our own settings page saves fingerprint-affecting fields
        // (patterns/extra paths/kill switch) through UpdateConfiguration, so
        // the epoch the page re-reads right after Save must not be a stale
        // pre-save value from inside the 30s throttle window. Instance can
        // only be null if this singleton is somehow resolved before the
        // plugin loads — then the throttled pre-scan remains the fallback.
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged += (_, _) => Invalidate();
        }
    }

    /// <summary>Force the next fingerprint request to re-run the pre-scan.</summary>
    public void Invalidate()
    {
        lock (_sync)
        {
            _prescanDueTicks = 0;
            _generation++;
        }
    }

    /// <summary>
    /// JELA-62: full re-hash regardless of pre-scan state — every covered
    /// byte is hashed again. Covers the one change class the mtime+size
    /// pre-scan cannot see: content rewritten in place with a preserved
    /// timestamp (rsync -t, cp -p into a bind mount).
    ///
    /// The hash runs OUTSIDE the state lock so /shell/manifest.json keeps
    /// serving the previous fingerprint for the whole pass (a full pass over
    /// a NAS bind mount can take seconds — booting TVs must not queue behind
    /// it), and the result is published only on success: a transient IO
    /// failure keeps the known-good cache instead of dropping the epoch
    /// fleet-wide. Concurrent Rehash calls serialize on a separate gate so an
    /// elevated caller looping the endpoint cannot fan out parallel full disk
    /// passes; a config save racing the pass zeroes the pre-scan deadline via
    /// the generation counter, so the next fetch re-scans immediately instead
    /// of serving the pre-save epoch for up to 30s. Returns null only when
    /// the re-hash itself failed.
    /// </summary>
    public ConfigFingerprint? Rehash(PluginConfiguration config, CancellationToken cancellationToken = default)
    {
        lock (_rehashGate)
        {
            long generationAtStart;
            lock (_sync)
            {
                generationAtStart = _generation;
            }

            try
            {
                var files = EnumerateCoveredFiles(config);
                var signature = PrescanSignature(files);
                var computed = Compute(files, VolatileKeyRegexes(config.VolatileScriptConfigKeys), cancellationToken);

                lock (_sync)
                {
                    var before = _cached?.Epoch;
                    _cached = computed;
                    _prescanSignature = signature;
                    _prescanDueTicks = _generation == generationAtStart
                        ? Environment.TickCount64 + (long)PrescanInterval.TotalMilliseconds
                        : 0;

                    if (before != null && before != computed.Epoch)
                    {
                        _logger.LogInformation("config rehash: epoch changed {Before} -> {After}", before, computed.Epoch);
                    }
                    else
                    {
                        _logger.LogInformation("config rehash: epoch {Epoch}", computed.Epoch);
                    }
                }

                return computed;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "config rehash failed; keeping the previous fingerprint");
                return null;
            }
        }
    }

    /// <summary>
    /// Current fingerprint, or null when computation fails — the caller then
    /// serves the legacy manifest bytes, i.e. failure degrades to today's
    /// behavior, never to a wrong epoch.
    /// </summary>
    public ConfigFingerprint? TryGetFingerprint(PluginConfiguration config)
    {
        lock (_sync)
        {
            try
            {
                var now = Environment.TickCount64;
                if (_cached != null && now < _prescanDueTicks)
                {
                    return _cached;
                }

                var files = EnumerateCoveredFiles(config);
                var signature = PrescanSignature(files);
                if (_cached == null || signature != _prescanSignature)
                {
                    _cached = Compute(files, VolatileKeyRegexes(config.VolatileScriptConfigKeys));
                    _prescanSignature = signature;
                }

                _prescanDueTicks = Environment.TickCount64 + (long)PrescanInterval.TotalMilliseconds;
                return _cached;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "config fingerprint unavailable; serving legacy manifest");
                _cached = null;
                _prescanSignature = null;
                _prescanDueTicks = 0;
                return null;
            }
        }
    }

    /// <summary>One covered on-disk input: which component group, its stable label, its absolute path.</summary>
    private readonly record struct CoveredFile(string Group, string Label, string Path);

    private List<CoveredFile> EnumerateCoveredFiles(PluginConfiguration config)
    {
        var files = new List<CoveredFile>();

        // web ------------------------------------------------------------
        var webPath = _appPaths.WebPath;
        if (!string.IsNullOrEmpty(webPath) && Directory.Exists(webPath))
        {
            AddIfFile(files, "web", "web/index.html", Path.Combine(webPath, "index.html"));
            AddIfFile(files, "web", "web/config.json", Path.Combine(webPath, "config.json"));

            var indexPath = Path.Combine(webPath, "index.html");
            if (File.Exists(indexPath))
            {
                foreach (var rel in ReferencedWebAssets(File.ReadAllText(indexPath)))
                {
                    var full = ResolveUnder(webPath, rel);
                    if (full != null)
                    {
                        AddIfFile(files, "web", "web/" + rel, full);
                    }
                }
            }

            AddDirectory(files, "web", "web/themes/", Path.Combine(webPath, "themes"));
        }

        // shell ----------------------------------------------------------
        // shell.min.js / babel.min.js are embedded constants added in
        // Compute(); only the on-disk tx manifest participates in the
        // pre-scan.
        AddIfFile(files, "shell", "shell/tx-manifest.json", _drop.TxManifestPath);

        // scripts ----------------------------------------------------------
        var patterns = GlobRegexes(config.ScriptFingerprintPatterns);
        if (patterns.Count > 0)
        {
            var configDir = _appPaths.PluginConfigurationsPath;
            if (Directory.Exists(configDir))
            {
                foreach (var path in Directory.EnumerateFiles(configDir))
                {
                    var name = Path.GetFileName(path);
                    if (!string.Equals(name, OwnConfigFileName, StringComparison.OrdinalIgnoreCase)
                        && MatchesAny(patterns, name))
                    {
                        files.Add(new CoveredFile("scripts", "scripts/config/" + name, path));
                    }
                }
            }

            var pluginsDir = _appPaths.PluginsPath;
            if (Directory.Exists(pluginsDir))
            {
                foreach (var dir in Directory.EnumerateDirectories(pluginsDir))
                {
                    var name = Path.GetFileName(dir);
                    if (MatchesAny(patterns, name))
                    {
                        AddDirectory(files, "scripts", "scripts/plugins/" + name + "/", dir);
                    }
                }
            }
        }

        foreach (var line in SplitLines(config.ExtraFingerprintPaths))
        {
            if (File.Exists(line))
            {
                files.Add(new CoveredFile("scripts", "scripts/extra/" + Path.GetFileName(line), line));
            }
            else if (Directory.Exists(line))
            {
                AddDirectory(files, "scripts", "scripts/extra/" + Path.GetFileName(line) + "/", line);
            }
        }

        // branding ---------------------------------------------------------
        AddIfFile(files, "branding", "branding/branding.xml", Path.Combine(_appPaths.ConfigurationDirectoryPath, "branding.xml"));

        return files;
    }

    /// <summary>
    /// Local (non-bundle-agnostic) assets referenced by the web index:
    /// every &lt;script src&gt; and &lt;link href&gt; that is same-origin
    /// relative, query-stripped. Returns web-root-relative forward-slash
    /// paths.
    /// </summary>
    public static IReadOnlyList<string> ReferencedWebAssets(string indexHtml)
    {
        var rels = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var re in new[] { ScriptSrcRe, LinkHrefRe })
        {
            foreach (Match m in re.Matches(indexHtml))
            {
                var url = m.Groups[1].Value;
                if (Regex.IsMatch(url, "^(?:[a-z][a-z0-9+.-]*:|//)", RegexOptions.IgnoreCase))
                {
                    continue; // absolute / protocol-relative / data: — not a dist file
                }

                var rel = url.Split('?')[0].Split('#')[0].TrimStart('/');
                if (rel.Length > 0 && seen.Add(rel))
                {
                    rels.Add(rel);
                }
            }
        }

        return rels;
    }

    private static string? ResolveUnder(string root, string rel)
    {
        var full = Path.GetFullPath(Path.Combine(root, rel));
        var rooted = Path.GetFullPath(root);
        return full.StartsWith(rooted + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            ? full
            : null; // traversal outside the web root — never hash it
    }

    private static void AddIfFile(List<CoveredFile> files, string group, string label, string path)
    {
        if (File.Exists(path))
        {
            files.Add(new CoveredFile(group, label, path));
        }
    }

    private static void AddDirectory(List<CoveredFile> files, string group, string labelPrefix, string dir)
    {
        if (!Directory.Exists(dir))
        {
            return;
        }

        foreach (var path in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(dir, path).Replace(Path.DirectorySeparatorChar, '/');
            files.Add(new CoveredFile(group, labelPrefix + rel, path));
        }
    }

    private static IEnumerable<string> SplitLines(string? text)
        => (text ?? string.Empty)
            .Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0);

    private static List<Regex> GlobRegexes(string? patterns)
    {
        var list = new List<Regex>();
        foreach (var line in SplitLines(patterns))
        {
            var rx = "^" + Regex.Escape(line).Replace("\\*", ".*").Replace("\\?", ".") + "$";
            list.Add(new Regex(rx, RegexOptions.IgnoreCase | RegexOptions.ECMAScript));
        }

        return list;
    }

    private static bool MatchesAny(List<Regex> patterns, string name)
        => patterns.Any(p => p.IsMatch(name));

    /// <summary>
    /// Cheap change detector: sorted "group|label|mtimeTicks|size" lines.
    /// Timestamps feed ONLY this signature, never the fingerprint itself, so
    /// a redeploy that rewrites identical bytes re-hashes but lands on the
    /// same epoch.
    /// </summary>
    private static string PrescanSignature(List<CoveredFile> files)
    {
        var lines = new List<string>(files.Count);
        foreach (var f in files)
        {
            var info = new FileInfo(f.Path);
            if (!info.Exists)
            {
                continue;
            }

            lines.Add(f.Group + "|" + f.Label + "|" + info.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + info.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        lines.Sort(StringComparer.Ordinal);
        return Sha256Hex(Encoding.UTF8.GetBytes(string.Join("\n", lines)));
    }

    private ConfigFingerprint Compute(List<CoveredFile> files, List<Regex> volatileKeyRes, CancellationToken cancellationToken = default)
    {
        var groups = new Dictionary<string, List<(string Label, string Sha)>>(StringComparer.Ordinal)
        {
            ["web"] = new(),
            ["shell"] = new(),
            ["scripts"] = new(),
            ["branding"] = new(),
        };

        // Embedded shell constants — always present, independent of disk.
        groups["shell"].Add(("shell/shell.min.js", _drop.ShellSha256));
        groups["shell"].Add(("shell/babel.min.js", _drop.BabelSha256));

        foreach (var f in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string sha;
            try
            {
                if (string.Equals(f.Label, "shell/tx-manifest.json", StringComparison.Ordinal))
                {
                    sha = NormalizedTxManifestSha(f.Path);
                }
                else if (f.Label.StartsWith("scripts/config/", StringComparison.Ordinal))
                {
                    var info = new FileInfo(f.Path);
                    if (!info.Exists || info.Length > MaxHashedFileBytes)
                    {
                        continue;
                    }

                    sha = NormalizedScriptConfigSha(File.ReadAllBytes(f.Path), volatileKeyRes);
                }
                else
                {
                    var info = new FileInfo(f.Path);
                    if (!info.Exists || info.Length > MaxHashedFileBytes)
                    {
                        continue;
                    }

                    using var stream = File.OpenRead(f.Path);
                    sha = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                }
            }
            catch (IOException)
            {
                continue; // vanished mid-scan — next pre-scan settles it
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            groups[f.Group].Add((f.Label, sha));
        }

        var web = GroupSha(groups["web"]);
        var shell = GroupSha(groups["shell"]);
        var scripts = GroupSha(groups["scripts"]);
        var branding = GroupSha(groups["branding"]);

        // Ordered aggregate — the order is part of the contract, mirrored by
        // the TV-side gate and pinned by config-fingerprint.test.cjs.
        var epoch = Sha256Hex(Encoding.UTF8.GetBytes(
            "web:" + web + "\nshell:" + shell + "\nscripts:" + scripts + "\nbranding:" + branding + "\n"));
        return new ConfigFingerprint(epoch, web, shell, scripts, branding);
    }

    /// <summary>sha256 over "label\0sha\n" lines sorted ordinal by label.</summary>
    public static string GroupSha(IEnumerable<(string Label, string Sha)> entries)
    {
        var lines = entries
            .Select(e => e.Label + "\0" + e.Sha + "\n")
            .OrderBy(l => l, StringComparer.Ordinal);
        return Sha256Hex(Encoding.UTF8.GetBytes(string.Concat(lines)));
    }

    /// <summary>
    /// JELA-139: element-strip regexes for the configured volatile keys.
    /// Each matches one LEAF element — `&lt;Key&gt;text&lt;/Key&gt;` or
    /// `&lt;Key/&gt;`, optionally with attributes — and nothing else. `[^&lt;]*`
    /// cannot cross into child elements, and a key name mentioned inside
    /// element TEXT (e.g. a JS-Injector snippet quoting the tag) can never
    /// match because literal `&lt;` is entity-escaped in XML content.
    /// </summary>
    public static List<Regex> VolatileKeyRegexes(string? keys)
    {
        var list = new List<Regex>();
        foreach (var line in SplitLines(keys))
        {
            var name = Regex.Escape(line);
            list.Add(new Regex(
                "<" + name + "(?:\\s[^>]*)?(?:/>|>[^<]*</" + name + "\\s*>)",
                RegexOptions.IgnoreCase | RegexOptions.ECMAScript));
        }

        return list;
    }

    /// <summary>
    /// JELA-139: plugin-config XMLs hash with the configured volatile leaf
    /// elements stripped — JellyfinEnhanced rewrites its cache-clear
    /// timestamps (ClearTranslationCacheTimestamp / ClearLocalStorageTimestamp)
    /// without any operator config change, and raw bytes would churn the
    /// epoch (= one spurious resume reload per TV per churn). Every other
    /// byte still feeds the hash, so real config changes keep moving the
    /// epoch. The mtime bump from a volatile-only rewrite still triggers a
    /// pre-scan re-hash, but the re-hash lands on the same epoch — no TV
    /// traffic results.
    /// </summary>
    public static string NormalizedScriptConfigSha(byte[] bytes, IReadOnlyList<Regex> volatileKeyRes)
    {
        if (volatileKeyRes.Count == 0)
        {
            return Sha256Hex(bytes);
        }

        var text = Encoding.UTF8.GetString(bytes);
        foreach (var re in volatileKeyRes)
        {
            text = re.Replace(text, string.Empty);
        }

        return Sha256Hex(Encoding.UTF8.GetBytes(text));
    }

    /// <summary>
    /// Normalized tx-manifest digest: "babelOptsKey\0&lt;key&gt;\n" plus
    /// "&lt;hash&gt;\0&lt;rel&gt;\n" per entry sorted ordinal — the
    /// `generated` timestamp is excluded on purpose (see class remarks).
    /// Absent file hashes a fixed sentinel; unparseable bytes fall back to a
    /// raw byte hash so corruption still moves the epoch.
    /// </summary>
    public static string NormalizedTxManifestSha(string path)
    {
        if (!File.Exists(path))
        {
            return Sha256Hex(Encoding.UTF8.GetBytes("tx-manifest:absent"));
        }

        var bytes = File.ReadAllBytes(path);
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;
            var sb = new StringBuilder();
            sb.Append("babelOptsKey\0");
            if (root.TryGetProperty("babelOptsKey", out var key) && key.ValueKind == JsonValueKind.String)
            {
                sb.Append(key.GetString());
            }

            sb.Append('\n');

            if (root.TryGetProperty("entries", out var entries) && entries.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in entries.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    sb.Append(p.Name).Append('\0').Append(p.Value.ToString()).Append('\n');
                }
            }

            return Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()));
        }
        catch (JsonException)
        {
            return Sha256Hex(bytes);
        }
    }

    private static string Sha256Hex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
