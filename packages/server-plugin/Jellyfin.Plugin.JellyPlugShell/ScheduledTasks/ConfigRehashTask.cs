using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell.ScheduledTasks;

/// <summary>
/// JELA-62: scheduled full re-hash of the server config fingerprint. The
/// fingerprint normally refreshes lazily — a throttled mtime+size pre-scan on
/// each /shell/manifest.json fetch — which misses exactly one change class:
/// bytes rewritten in place with a preserved timestamp (rsync -t, cp -p into
/// a NAS/Docker bind mount). This task re-hashes every covered byte so such
/// an edit stales out within one interval instead of never; the interval is
/// daily because that change class is rare and operator-driven (the settings
/// page "Rehash now" button covers "I just rsynced, refresh it now"). The
/// startup trigger doubles as cache warm-up: the first TV to boot gets a
/// precomputed epoch instead of paying the initial full hash.
/// </summary>
public class ConfigRehashTask : IScheduledTask
{
    private readonly ConfigFingerprintService _fingerprint;
    private readonly ILogger<ConfigRehashTask> _logger;

    public ConfigRehashTask(ConfigFingerprintService fingerprint, ILogger<ConfigRehashTask> logger)
    {
        _fingerprint = fingerprint;
        _logger = logger;
    }

    public string Name => "Rehash JellyPlug server config";

    public string Key => "JellyPlugShellConfigRehash";

    public string Description =>
        "Re-hashes everything JellyPlug TVs consume at boot (web dist, shell drop, injected scripts, branding) and refreshes the configEpoch served in /shell/manifest.json.";

    public string Category => "JellyPlug";

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(24).Ticks,
        };
    }

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        // No default-config fallback here (unlike the tx rebuild): a rehash
        // computed from default patterns/paths would be CACHED and served to
        // TVs for up to 30s. If the plugin has not initialized yet, do
        // nothing — the first manifest fetch computes lazily as always.
        var config = Plugin.Instance?.Configuration;
        if (config == null)
        {
            _logger.LogWarning("plugin not initialized yet; skipping config rehash");
            return;
        }

        if (config.DisableConfigFingerprint)
        {
            _logger.LogInformation("config fingerprint disabled in plugin configuration; skipping rehash");
            progress.Report(100);
            return;
        }

        // Task.Run keeps the scheduler thread free; the token cancels the
        // per-file hash loop, so dashboard Stop works even mid-pass. Success
        // (and epoch-change) logging lives in the service.
        var fingerprint = await Task.Run(() => _fingerprint.Rehash(config, cancellationToken), cancellationToken).ConfigureAwait(false);
        if (fingerprint == null)
        {
            _logger.LogWarning("config rehash failed; the previously cached fingerprint (if any) is still served");
        }

        progress.Report(100);
    }
}
