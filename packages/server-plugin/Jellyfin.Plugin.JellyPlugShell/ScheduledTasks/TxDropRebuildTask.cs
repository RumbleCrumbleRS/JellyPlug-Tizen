using System.Text.RegularExpressions;
using MediaBrowser.Controller;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell.ScheduledTasks;

/// <summary>
/// In-process replacement for the JEL-653 regen-tx-drop.sh cron: collects the
/// same source set the offline builder would (every non-bundle script on the
/// served /web/ index, the snippet channel, any configured extras), pre-lowers
/// them with the lockstep Babel transform, and publishes the drop atomically.
/// Default triggers: server startup + every 6 hours, so a fresh install has a
/// drop minutes after boot and content changes stale-out within one interval.
/// </summary>
public class TxDropRebuildTask : IScheduledTask
{
    private readonly ShellDropService _drop;
    private readonly TxDropBuilder _builder;
    private readonly IServerApplicationHost _appHost;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<TxDropRebuildTask> _logger;

    public TxDropRebuildTask(
        ShellDropService drop,
        TxDropBuilder builder,
        IServerApplicationHost appHost,
        IHttpClientFactory httpClientFactory,
        ILogger<TxDropRebuildTask> logger)
    {
        _drop = drop;
        _builder = builder;
        _appHost = appHost;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public string Name => "Rebuild JellyPlug tx-drop";

    public string Key => "JellyPlugShellTxDropRebuild";

    public string Description =>
        "Pre-lowers the scripts JellyPlug TVs would otherwise transpile on-device (21-42s on Tizen 5.0) and publishes them under /shell/tx/.";

    public string Category => "JellyPlug";

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(6).Ticks,
        };
    }

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (config.DisableTxRebuild)
        {
            _logger.LogInformation("tx rebuild disabled in plugin configuration; skipping");
            return;
        }

        var baseUrl = _appHost.GetApiUrlForLocalAccess(allowHttps: false).TrimEnd('/');
        using var http = _httpClientFactory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(60);

        // Same source set as build-tx-drop.mjs: --web-index (every non-bundle
        // <script src> on the served index), the snippet channel, extras.
        var urls = new List<string>();
        try
        {
            var indexHtml = await http.GetStringAsync(baseUrl + "/web/index.html", cancellationToken).ConfigureAwait(false);
            foreach (var src in TxDropBuilder.ScriptSrcsFromWebIndex(indexHtml))
            {
                if (Uri.TryCreate(new Uri(baseUrl + "/web/"), src, out var abs))
                {
                    urls.Add(abs.ToString());
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "could not read /web/index.html; continuing with channel + extra sources only");
        }

        var jsiPath = config.JsiChannelPath;
        if (!string.IsNullOrWhiteSpace(jsiPath))
        {
            urls.Add(baseUrl + (jsiPath.StartsWith('/') ? jsiPath : "/" + jsiPath));
        }

        foreach (var line in config.ExtraSourceUrls.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!line.StartsWith('#'))
            {
                urls.Add(line);
            }
        }

        var sources = new List<TxSource>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var fetched = 0;
        foreach (var url in urls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            progress.Report(30.0 * (++fetched) / urls.Count);
            if (!seen.Add(url))
            {
                continue;
            }

            try
            {
                sources.Add(new TxSource(url, await http.GetStringAsync(url, cancellationToken).ConfigureAwait(false)));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "skip tx source {Url}", url);
            }
        }

        if (sources.Count == 0)
        {
            _logger.LogWarning("no readable tx sources; keeping the existing drop untouched");
            return;
        }

        progress.Report(35);
        var timeout = TimeSpan.FromSeconds(Math.Max(30, config.TransformTimeoutSeconds));
        var result = await _builder.RebuildAsync(sources, timeout, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("tx-drop rebuild finished: {Entries} manifest entries from {Sources} sources", result.EntryCount, sources.Count);

        // JELA-186: the static bodies above inject further module scripts at
        // runtime; a fresh boot that drop-MISSES one of them lazy-loads Babel
        // (~3.13 MB) on the TV. Scan the FINAL (device-visible) bodies for
        // those URLs — mirror of the seed's __txScrapeBodies, plugin-agnostic
        // by construction — fetch them and lower them into the drop too, so
        // dynamic injection drop-HITs and Babel never loads.
        if (!config.DisableTxDynScan)
        {
            progress.Report(60);
            var discovered = await DiscoverDynamicSourcesAsync(http, result.FinalBodies, seen, cancellationToken).ConfigureAwait(false);
            if (discovered.Count > 0)
            {
                progress.Report(75);
                var dynResult = await _builder.RebuildAsync(discovered, timeout, cancellationToken).ConfigureAwait(false);
                _logger.LogInformation(
                    "tx-drop dynamic scan: {Discovered} module bodies discovered; manifest now {Entries} entries",
                    discovered.Count,
                    dynResult.EntryCount);
            }
        }

        progress.Report(100);
    }

    /// <summary>
    /// Fetch the dynamic module bodies the given final static bodies would
    /// inject at runtime. URL discovery is regex-driven (no plugin names,
    /// JEL-181/203/240): scrape each body, resolve candidates against the
    /// body's own URL, probe candidate dirs with the group's first name and
    /// commit to the first dir that answers with JS (rank order equals the
    /// seed probe's lowest-rank-success). Capped at 200 fetch attempts.
    /// </summary>
    private async Task<List<TxSource>> DiscoverDynamicSourcesAsync(
        HttpClient http,
        IReadOnlyList<TxSource> finals,
        HashSet<string> seenUrls,
        CancellationToken cancellationToken)
    {
        const int FetchCap = 200;
        var outSources = new List<TxSource>();
        var attempts = 0;

        string? Norm(Uri baseUri, string u)
        {
            if (!Uri.TryCreate(baseUri, u, out var abs) || (abs.Scheme != "http" && abs.Scheme != "https"))
            {
                return null;
            }

            if (!string.Equals(abs.GetLeftPart(UriPartial.Authority), baseUri.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase))
            {
                return null; // same-origin only, like the seed's norm()
            }

            if (Regex.IsMatch(abs.AbsolutePath, "\\.bundle\\.js$", RegexOptions.IgnoreCase))
            {
                return null;
            }

            var s = abs.ToString();
            return seenUrls.Add(s) ? s : null;
        }

        async Task<string?> TryFetchAsync(string abs)
        {
            if (attempts >= FetchCap)
            {
                return null;
            }

            attempts++;
            try
            {
                var text = await http.GetStringAsync(abs, cancellationToken).ConfigureAwait(false);

                // Probing candidate dirs can 200 an HTML SPA-fallback page; a
                // non-JS body must not win a probe or poison the drop.
                return Regex.IsMatch(text, "^\\s*<") ? null : text;
            }
            catch (HttpRequestException)
            {
                return null; // expected: dir probes miss
            }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return null; // per-request timeout
            }
        }

        foreach (var f in finals)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (attempts >= FetchCap)
            {
                break;
            }

            if (!Uri.TryCreate(f.From, UriKind.Absolute, out var baseUri) || (baseUri.Scheme != "http" && baseUri.Scheme != "https"))
            {
                continue;
            }

            var scraped = TxDropBuilder.ScrapeDynamicRefs(f.Text, f.From);
            foreach (var p in scraped.Exact)
            {
                var abs = Norm(baseUri, p);
                if (abs == null)
                {
                    continue;
                }

                var text = await TryFetchAsync(abs).ConfigureAwait(false);
                if (text != null)
                {
                    outSources.Add(new TxSource(abs, text));
                }
            }

            foreach (var g in scraped.Groups)
            {
                string? win = null;
                foreach (var d in g.Dirs)
                {
                    var abs = Norm(baseUri, d + "/" + g.Names[0]);
                    if (abs == null)
                    {
                        continue;
                    }

                    var text = await TryFetchAsync(abs).ConfigureAwait(false);
                    if (text != null)
                    {
                        outSources.Add(new TxSource(abs, text));
                        win = d;
                        break;
                    }
                }

                if (win == null)
                {
                    continue;
                }

                for (var i = 1; i < g.Names.Count; i++)
                {
                    var abs = Norm(baseUri, win + "/" + g.Names[i]);
                    if (abs == null)
                    {
                        continue;
                    }

                    var text = await TryFetchAsync(abs).ConfigureAwait(false);
                    if (text != null)
                    {
                        outSources.Add(new TxSource(abs, text));
                    }
                }
            }
        }

        if (attempts >= FetchCap)
        {
            _logger.LogWarning("tx-drop dynamic scan hit the {Cap}-fetch cap; discovery may be incomplete", FetchCap);
        }

        return outSources;
    }
}
