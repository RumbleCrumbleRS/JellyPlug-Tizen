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
    /// JELA-58 (JELA-57 WS-1) server-side kill switch: when true,
    /// /shell/manifest.json omits configEpoch/components entirely and serves
    /// the exact legacy bytes — every TV falls back to today's revalidation
    /// behavior regardless of what it opted into. Default false: the fields
    /// are additive and old TVs ignore them, so serving them is always safe;
    /// rollout gating lives on the TV (JELA-59).
    /// </summary>
    public bool DisableConfigFingerprint { get; set; }

    /// <summary>
    /// JELA-58: newline-separated case-insensitive glob patterns selecting
    /// which injector-style plugins feed the `scripts` fingerprint group.
    /// Matched against file names in the plugin-configurations dir and
    /// folder names in the plugins dir. Defaults cover the fielded stack
    /// (JS-Injector snippets/config + JellyfinEnhanced user-script plugin).
    /// </summary>
    public string ScriptFingerprintPatterns { get; set; } = "*injector*\n*enhanced*";

    /// <summary>
    /// JELA-58: newline-separated extra absolute files/directories to fold
    /// into the `scripts` fingerprint group — e.g. an on-disk user-script a
    /// snippet loads that no pattern above covers. Empty by default.
    /// </summary>
    public string ExtraFingerprintPaths { get; set; } = string.Empty;

    /// <summary>
    /// JELA-30: cap on retained boot-ring records in the diag store
    /// (diag/rings.ndjson under the server data dir). Oldest rings are pruned
    /// once the store grows past this, bounding disk and a hostile TV's ability
    /// to inflate the file.
    /// </summary>
    public int DiagMaxRings { get; set; } = 5000;
}
