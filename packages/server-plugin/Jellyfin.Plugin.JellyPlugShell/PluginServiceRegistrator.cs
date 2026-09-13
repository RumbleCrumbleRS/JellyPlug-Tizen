using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyPlugShell;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // JELA-904: wrap the core IUserManager in a short-TTL memo over
        // GetUserById. First, because it rewrites an EXISTING descriptor
        // rather than adding one, and every addition below should be able to
        // assume the collection it sees is the one it will run against.
        TryDecorateUserManager(serviceCollection);

        serviceCollection.AddSingleton<ShellDropService>();
        serviceCollection.AddSingleton<TxDropBuilder>();
        serviceCollection.AddSingleton<DiagIngestService>();
        serviceCollection.AddSingleton<ConfigFingerprintService>();

        // JELA-865: holds the patched main-bundle body in memory. Singleton so
        // one loopback fetch serves every TV for the life of the process; the
        // tx-drop rebuild task warms it on the startup trigger.
        serviceCollection.AddSingleton<PatchedBundleService>();

        // JELA-727: gzip for controller output — Jellyfin's own compression only
        // wraps the static-file branch. MUST stay the first-registered filter:
        // first-registered is OUTERMOST, and the JELA-732 section cache below
        // captures identity bytes — its IsStorable refuses any body already
        // carrying Content-Encoding, so compression registered inside it would
        // silently turn that cache into a permanent miss. Outermost, both cache
        // hits and misses stream their plain bytes through the compression body
        // wrapper on the way to the wire.
        serviceCollection.AddTransient<IStartupFilter, ResponseCompressionStartupFilter>();

        // JELA-723: revalidatable Cache-Control + Vary on the three third-party
        // plugin client scripts the shell injects on the boot critical path
        // (NotifySync max-age=300 re-downloads 62 KiB every boot; the other two
        // ship no Cache-Control at all). Routes we do not own — same hook as
        // JELA-731/732.
        serviceCollection.AddTransient<IStartupFilter, PluginScriptCacheStartupFilter>();

        // JELA-825: intercept /web/MaterialIcons-Regular.*.woff2 and serve a 4 KB
        // subset in place of the 125 KB full font. Must sit inside the compression
        // filter (registered first/outermost) so the response gets gzip treatment.
        // Registered before WebAssetCacheStartupFilter — the interception short-circuits
        // before that filter's OnStarting runs, so there is no conflict.
        serviceCollection.AddTransient<IStartupFilter, MaterialIconsSubsetStartupFilter>();

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

        // JELA-793: background library-warm timer. Registered LAST because it adds no
        // middleware — it only needs a hook that runs once the container is built — and
        // registering it anywhere else would shuffle the nesting of the filters above,
        // which is load-bearing. Off unless SectionWarmIntervalSeconds is set.
        serviceCollection.AddSingleton<SectionWarmService>();
        serviceCollection.AddTransient<IStartupFilter, SectionWarmStartupFilter>();

        // JELA-709: IStartupFilter is resolved as an IEnumerable — every
        // registration runs — so unlike a service substitution this survives
        // registering BEFORE Jellyfin's own web wiring. See the filter's docs.
        serviceCollection.AddTransient<IStartupFilter, CorsPreflightMaxAgeStartupFilter>();
    }

    /// <summary>
    /// JELA-904: replace the container's <see cref="IUserManager"/> with
    /// <see cref="CachingUserManager"/> wrapped around the original
    /// implementation.
    ///
    /// This works because of the call order in
    /// <c>Emby.Server.Implementations/ApplicationHost.cs</c>: <c>:490</c> runs
    /// core <c>RegisterServices</c> (where
    /// <c>Jellyfin.Server/CoreAppHost.cs:83</c> does
    /// <c>AddSingleton&lt;IUserManager, UserManager&gt;()</c>) and <c>:492</c>
    /// runs <c>_pluginManager.RegisterServices</c> — this method — on the same
    /// <see cref="IServiceCollection"/>. Nothing registers
    /// <see cref="IUserManager"/> after us, so the last registration wins and
    /// the decorated instance is what every consumer resolves.
    ///
    /// The original descriptor is re-registered under its own implementation
    /// type rather than merely left in place, for two reasons: the decorator
    /// needs a way to resolve the real manager, and leaving a dormant
    /// <c>IUserManager -&gt; UserManager</c> descriptor behind would hand a
    /// SECOND, undecorated manager to anything resolving
    /// <c>IEnumerable&lt;IUserManager&gt;</c>. Registering it as a service in
    /// its own right also keeps the container the owner of its lifetime, which
    /// matters because <c>UserManager</c> is <see cref="IDisposable"/>.
    ///
    /// Every unexpected shape FAILS OPEN and leaves the collection untouched,
    /// so a future Jellyfin that registers its user manager differently gets
    /// stock behavior rather than a broken server.
    /// </summary>
    private static void TryDecorateUserManager(IServiceCollection serviceCollection)
    {
        ServiceDescriptor? existing = null;
        for (var i = serviceCollection.Count - 1; i >= 0; i--)
        {
            var candidate = serviceCollection[i];
            if (candidate.ServiceType == typeof(IUserManager))
            {
                existing = candidate;
                break;
            }
        }

        // Not registered yet (we ran too early), keyed, non-singleton, already
        // ours, or supplied by a factory/instance we cannot name a type for:
        // leave it alone.
        if (existing is null
            || existing.IsKeyedService
            || existing.Lifetime != ServiceLifetime.Singleton
            || existing.ImplementationType is null
            || existing.ImplementationType == typeof(CachingUserManager))
        {
            return;
        }

        var implementationType = existing.ImplementationType;
        serviceCollection.Remove(existing);
        serviceCollection.AddSingleton(implementationType);
        serviceCollection.AddSingleton<IUserManager>(
            sp => new CachingUserManager((IUserManager)sp.GetRequiredService(implementationType)));
    }
}
