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

        // JELA-731: one-query "Latest Shows" row in place of Home Screen Sections'
        // 30-day sliding-window scan (54 queries / 1,166 ms of server time on
        // production). Same hook, and for the same reason — the route belongs to a
        // third-party plugin, so there is nothing to substitute into.
        serviceCollection.AddTransient<IStartupFilter, LatestShowsFastPathStartupFilter>();

        // JELA-709: IStartupFilter is resolved as an IEnumerable — every
        // registration runs — so unlike a service substitution this survives
        // registering BEFORE Jellyfin's own web wiring. See the filter's docs.
        serviceCollection.AddTransient<IStartupFilter, CorsPreflightMaxAgeStartupFilter>();
    }
}
