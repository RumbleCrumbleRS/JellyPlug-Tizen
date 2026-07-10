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
public sealed record ConfigFingerprint(string Epoch, string Web, string Shell, string Scripts, string Branding);

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
///              group already covers the served shell bytes).
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

    private long _prescanDueTicks; // Environment.TickCount64 basis; 0 = scan now
    private string? _prescanSignature;
    private ConfigFingerprint? _cached;

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
    }

    /// <summary>Force the next fingerprint request to re-run the pre-scan.</summary>
    public void Invalidate()
    {
        lock (_sync)
        {
            _prescanDueTicks = 0;
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
                    _cached = Compute(files);
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

    private ConfigFingerprint Compute(List<CoveredFile> files)
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
            string sha;
            try
            {
                if (string.Equals(f.Label, "shell/tx-manifest.json", StringComparison.Ordinal))
                {
                    sha = NormalizedTxManifestSha(f.Path);
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
