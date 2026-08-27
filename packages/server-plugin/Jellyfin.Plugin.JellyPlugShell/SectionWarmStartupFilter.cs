using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-793: starts <see cref="SectionWarmService"/> once the host's service provider
/// exists.
///
/// <para>This filter adds no middleware and touches no request. It is an
/// <see cref="IStartupFilter"/> purely because that is the one hook in this plugin's reach
/// that runs after the container is built and hands over
/// <see cref="IApplicationBuilder.ApplicationServices"/> — plugin
/// <c>RegisterServices</c> runs inside <c>appHost.Init</c>, long before
/// <see cref="MediaBrowser.Controller.Library.ILibraryManager"/> can be resolved, and the
/// plugin constructor is earlier still. Registered LAST so that adding it cannot move any
/// of the filters whose nesting order is load-bearing (JELA-727 compression must stay
/// outermost of the JELA-732 cache, which must stay outside the JELA-731 fast path).</para>
/// </summary>
public class SectionWarmStartupFilter : IStartupFilter
{
    private readonly SectionWarmService _warm;

    public SectionWarmStartupFilter(SectionWarmService warm)
    {
        _warm = warm;
    }

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        => app =>
        {
            _warm.Start(app.ApplicationServices);
            next(app);
        };
}
