using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyPlugShell;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Path (relative to the server root) of the snippet-channel script the
    /// TVs load — the shell's jsiChannelPath() default. The tx rebuild
    /// fetches it as a transform source.
    /// </summary>
    public string JsiChannelPath { get; set; } = "/JavaScriptInjector/public.js";

    /// <summary>
    /// Extra absolute source URLs to pre-lower (newline separated) — e.g. the
    /// TV's recorded jellyfin.shell.pluginUrls entries that are not on the
    /// /web/ index. Empty by default.
    /// </summary>
    public string ExtraSourceUrls { get; set; } = string.Empty;

    /// <summary>
    /// Disable the scheduled in-process tx-drop rebuild entirely. The static
    /// /shell/ assets keep serving; TVs fall back to on-device Babel.
    /// </summary>
    public bool DisableTxRebuild { get; set; }

    /// <summary>Per-source transform timeout, seconds.</summary>
    public int TransformTimeoutSeconds { get; set; } = 600;

    /// <summary>
    /// JELA-30 (WS-C): refuse all opt-in boot-ring diag beacons at
    /// POST /shell/diag. Ingest is off on the TV by default (the shell only
    /// posts when localStorage["jellyfin.shell.diagBeacon"]==="1"), so this
    /// defaults false — flip it to have the server reject every beacon
    /// regardless of what a fielded TV opts into.
    /// </summary>
    public bool DisableDiagIngest { get; set; }

    /// <summary>
    /// JELA-30: cap on retained boot-ring records in the diag store
    /// (diag/rings.ndjson under the server data dir). Oldest rings are pruned
    /// once the store grows past this, bounding disk and a hostile TV's ability
    /// to inflate the file.
    /// </summary>
    public int DiagMaxRings { get; set; } = 5000;
}
