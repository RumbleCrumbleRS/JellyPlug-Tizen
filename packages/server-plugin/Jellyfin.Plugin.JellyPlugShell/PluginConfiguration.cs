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
    /// JELA-186: disable the dynamic-module discovery pass of the tx-drop
    /// rebuild (static sources still rebuild). With the scan off, dynamic
    /// modules drop-MISS and fresh boots lazy-load Babel on the TV instead.
    /// </summary>
    public bool DisableTxDynScan { get; set; }

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
    /// JELA-139: newline-separated XML element names stripped from
    /// plugin-config XMLs before they feed the `scripts` fingerprint group.
    /// These are runtime cache-clear signals the plugins' own client scripts
    /// poll from config — they never change the bytes a TV downloads at boot,
    /// but they rewrite on their own (JellyfinEnhanced bumps them without any
    /// operator config change), so hashing them churns configEpoch and every
    /// churn is one unnecessary resume reload on every TV. Defaults cover the
    /// fielded JellyfinEnhanced volatile keys (2026-07 audit of the live
    /// config found exactly these two; JS-Injector has none).
    /// </summary>
    public string VolatileScriptConfigKeys { get; set; } = "ClearTranslationCacheTimestamp\nClearLocalStorageTimestamp";

    /// <summary>
    /// JELA-30: cap on retained boot-ring records in the diag store
    /// (diag/rings.ndjson under the server data dir). Oldest rings are pruned
    /// once the store grows past this, bounding disk and a hostile TV's ability
    /// to inflate the file.
    /// </summary>
    public int DiagMaxRings { get; set; } = 5000;

    /// <summary>
    /// JELA-141 (C5/WS-5): fleet default for the Lite canvas home. When any
    /// Lite*DefaultOn flag is true, /shell/manifest.json carries an additive
    /// `flagDefaults` map ({"jellyfin.shell.liteEnabled":"1", ...}); shells
    /// with NO explicit device-local value for a key adopt the served default
    /// one boot later (stale-one-boot, same contract as the Lite byte cache).
    /// An explicit device-local "1"/"0" always wins, so QA opt-ins and
    /// per-device kills survive fleet flips. Turning a flag back off here (or
    /// rolling the plugin back to a version without the field — absent field
    /// clears the TVs' cached defaults) is the fleet kill switch: TVs revert
    /// on their next manifest read + boot. All three false = the field is
    /// omitted and the manifest stays byte-identical to pre-JELA-141.
    /// </summary>
    public bool LiteDefaultOn { get; set; }

    /// <summary>
    /// JELA-141: fleet default for jellyfin.lite.native (AVPlay native
    /// playback fork). Meaningful only alongside LiteDefaultOn — see its
    /// remarks for the adoption/kill contract.
    /// </summary>
    public bool LiteNativeDefaultOn { get; set; }

    /// <summary>
    /// JELA-141/JELA-152: fleet default for jellyfin.lite.subs (Lite-side
    /// External-srt cue engine). Stays false for the C5 rollout — the flip
    /// rides the JELA-152 real-panel gate. Same contract as LiteDefaultOn.
    /// </summary>
    public bool LiteSubsDefaultOn { get; set; }
}
