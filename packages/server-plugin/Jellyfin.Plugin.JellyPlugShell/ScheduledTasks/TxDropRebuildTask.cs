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
        var entries = await _builder.RebuildAsync(sources, timeout, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("tx-drop rebuild finished: {Entries} manifest entries from {Sources} sources", entries, sources.Count);
        progress.Report(100);
    }
}
