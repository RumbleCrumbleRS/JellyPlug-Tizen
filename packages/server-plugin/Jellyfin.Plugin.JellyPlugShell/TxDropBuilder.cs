using System.Text.Json;
using System.Text.RegularExpressions;
using Jint;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>One transform input: where it came from + its source text.</summary>
public record TxSource(string From, string Text);

/// <summary>
/// In-process port of packages/server-shell-drop/scripts/build-tx-drop.mjs:
/// pre-lowers every transpile-slow-path source with the same Babel transform
/// the TV would run, and publishes tx/&lt;fnv1a&gt;.js bodies plus an atomic
/// tx-manifest.json. Publish-time gates mirror the device gates: the manifest
/// carries the lockstep babelOptsKey, and every body must pass the strict
/// fully-lowered oracle or the source is skipped (device falls back to
/// on-device Babel — safe, just slow).
/// </summary>
public class TxDropBuilder
{
    private readonly ShellDropService _drop;
    private readonly ILogger<TxDropBuilder> _logger;

    public TxDropBuilder(ShellDropService drop, ILogger<TxDropBuilder> logger)
    {
        _drop = drop;
        _logger = logger;
    }

    /// <summary>
    /// Mirrors the builder's scriptUrlsFromWebIndex(): every &lt;script src&gt;
    /// on the web index that is not a jellyfin-web webpack bundle (patched /
    /// replayed, never transpiled) and not an inline-scheme URL.
    /// </summary>
    public static IReadOnlyList<string> ScriptSrcsFromWebIndex(string html)
    {
        var urls = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(html, "<script\\b[^>]*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"']", RegexOptions.IgnoreCase))
        {
            var src = m.Groups[1].Value;
            if (Regex.IsMatch(src, "^(?:data|blob|javascript):", RegexOptions.IgnoreCase))
            {
                continue;
            }

            if (Regex.IsMatch(src.Split('?')[0], "\\.bundle\\.js$", RegexOptions.IgnoreCase))
            {
                continue;
            }

            if (seen.Add(src))
            {
                urls.Add(src);
            }
        }

        return urls;
    }

    /// <summary>
    /// Rebuild the drop from the given sources. Runs on a dedicated big-stack
    /// thread because Babel's traversal recursion is proportional to AST
    /// depth and minified plugin bundles nest deeply.
    /// </summary>
    public Task<int> RebuildAsync(IReadOnlyList<TxSource> sources, TimeSpan perSourceTimeout, CancellationToken cancellationToken)
    {
        var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(
            () =>
            {
                try
                {
                    tcs.SetResult(Rebuild(sources, perSourceTimeout, cancellationToken));
                }
                catch (Exception ex)
                {
                    tcs.SetException(ex);
                }
            },
            maxStackSize: 64 * 1024 * 1024)
        {
            IsBackground = true,
            Name = "jellyplug-tx-rebuild",
        };
        thread.Start();
        return tcs.Task;
    }

    private int Rebuild(IReadOnlyList<TxSource> sources, TimeSpan perSourceTimeout, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_drop.TxDir);

        using var engine = new Engine(o =>
        {
            o.Strict(false);
            o.LimitRecursion(10_000);
            o.TimeoutInterval(perSourceTimeout);
            o.CancellationToken(cancellationToken);
        });
        engine.Execute("var window = this; var self = this;");
        engine.Execute("var console = { log: function(){}, warn: function(){}, error: function(){}, info: function(){}, debug: function(){}, trace: function(){} };");
        engine.Execute(_drop.BabelTransformSource);
        engine.Execute("var OPTS = " + TxDropConstants.BabelOptsJs + ";");

        // --merge semantics: keep previous entries whose tx/ body survives, so
        // a partially-failing run never un-publishes still-valid work.
        var entries = LoadPreviousEntries();

        int lowered = 0, skipped = 0, failed = 0;
        foreach (var s in sources)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TxDropConstants.PrecheckRe.IsMatch(s.Text))
            {
                skipped++;
                continue; // device fast-path inlines it raw; a drop entry would never be consulted
            }

            var hash = TxDropConstants.TxFnv1a(s.Text);
            var rel = "tx/" + hash + ".js";
            var outPath = Path.Combine(_drop.TxDir, hash + ".js");
            if (entries.TryGetValue(hash, out var existing) && existing == rel && File.Exists(outPath))
            {
                lowered++; // already published for these exact bytes
                continue;
            }

            string outCode;
            try
            {
                engine.SetValue("SRC", s.Text);
                engine.Execute("var OUT = Babel.transform(SRC, OPTS).code;");
                outCode = engine.GetValue("OUT").AsString();
            }
            catch (Exception ex)
            {
                failed++;
                _logger.LogWarning(ex, "tx transform failed for {Source}; device will fall back to on-device Babel", s.From);
                continue;
            }

            if (string.IsNullOrEmpty(outCode) || TxDropConstants.OracleRe.IsMatch(outCode))
            {
                failed++;
                _logger.LogWarning("tx output for {Source} failed the lowered oracle; not published", s.From);
                continue;
            }

            File.WriteAllText(outPath, outCode);
            entries[hash] = rel;
            lowered++;
            _logger.LogInformation("tx lowered {Source} -> {Rel} ({In} -> {Out} chars)", s.From, rel, s.Text.Length, outCode.Length);
        }

        // Atomic publish (JEL-653 parity): write + rename so a TV fetching
        // mid-rebuild never reads a torn manifest.
        var manifest = new Dictionary<string, object>
        {
            ["format"] = 1,
            ["babelOptsKey"] = TxDropConstants.BabelOptsKey,
            ["generated"] = DateTime.UtcNow.ToString("o"),
            ["entries"] = entries,
        };
        var tmp = _drop.TxManifestPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, _drop.TxManifestPath, overwrite: true);

        _logger.LogInformation(
            "tx-drop rebuilt: entries={Entries} lowered={Lowered} skipped={Skipped} failed={Failed}",
            entries.Count,
            lowered,
            skipped,
            failed);
        return entries.Count;
    }

    private Dictionary<string, string> LoadPreviousEntries()
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            if (!File.Exists(_drop.TxManifestPath))
            {
                return entries;
            }

            using var doc = JsonDocument.Parse(File.ReadAllText(_drop.TxManifestPath));
            if (!doc.RootElement.TryGetProperty("babelOptsKey", out var key)
                || key.GetString() != TxDropConstants.BabelOptsKey
                || !doc.RootElement.TryGetProperty("entries", out var prev))
            {
                return entries; // opts-key drift stales the whole drop at once
            }

            foreach (var p in prev.EnumerateObject())
            {
                var rel = p.Value.GetString();
                if (rel != null && File.Exists(Path.Combine(_drop.DropDir, rel)))
                {
                    entries[p.Name] = rel;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "could not merge previous tx-manifest; rebuilding fresh");
        }

        return entries;
    }
}
