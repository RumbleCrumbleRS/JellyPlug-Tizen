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
}
