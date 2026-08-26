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
        // Registered before the JELA-731 fast path so the cache sits outside it: a hit
        // short-circuits, a miss falls through to the fast path's one-query build.
        serviceCollection.AddSingleton<HomeScreenSectionCache>();
        serviceCollection.AddTransient<IStartupFilter, HomeScreenSectionCacheStartupFilter>();

        // JELA-731: one-query "Latest Shows" row in place of Home Screen Sections'
        // 30-day sliding-window scan (54 queries / 1,166 ms of server time on
        // production). Same hook, and for the same reason — the route belongs to a
        // third-party plugin, so there is nothing to substitute into.
        serviceCollection.AddTransient<IStartupFilter, LatestShowsFastPathStartupFilter>();
    }
}
