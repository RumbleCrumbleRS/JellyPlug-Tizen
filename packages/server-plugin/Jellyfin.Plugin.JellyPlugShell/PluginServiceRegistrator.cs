using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyPlugShell;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<ShellDropService>();
        serviceCollection.AddSingleton<TxDropBuilder>();
        serviceCollection.AddSingleton<DiagIngestService>();
        serviceCollection.AddSingleton<ConfigFingerprintService>();

        // JELA-722: immutable headers on content-hashed /web/ chunks. IStartupFilter +
        // OnStarting is the only order-independent hook here — RegisterServices runs
        // before Startup.ConfigureServices, so a direct middleware substitution loses.
        serviceCollection.AddTransient<IStartupFilter, WebAssetCacheStartupFilter>();

        // JELA-732: short private cache over /HomeScreen/Section/{name}. The store is
        // a singleton so it survives across requests; the filter itself stays transient
        // like its sibling (ASP.NET resolves IStartupFilter once, at pipeline build).
        serviceCollection.AddSingleton<HomeScreenSectionCache>();
        serviceCollection.AddTransient<IStartupFilter, HomeScreenSectionCacheStartupFilter>();
    }
}
