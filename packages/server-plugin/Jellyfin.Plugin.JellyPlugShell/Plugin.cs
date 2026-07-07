using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JellyPlug Shell server plugin (JELA-15). Serves the Hosted Shell Bootstrap
/// drop (/shell/) straight from an installable plugin so no server ever needs
/// SSH + filesystem + cron to keep JellyPlug TVs fast.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "JellyPlug Shell";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("6f97e5aa-cf2f-4b48-8b73-6be92f4b7d31");

    /// <inheritdoc />
    public override string Description =>
        "Serves the JellyPlug hosted TV shell (/shell/) plus the pre-lowered "
        + "transpile drop, and rebuilds the drop in-process on a scheduled task.";
}
