using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Inserts ASP.NET Core ResponseCompressionMiddleware at the front of the
/// pipeline so controller output (not just static files) is compressed.
/// Jellyfin only wraps its static-file branch — every controller response
/// ships uncompressed, costing ~3.9 MiB per boot on a TV whose boot is
/// bytes-and-RTT bound.
///
/// Jellyfin already registers response compression services (they power
/// static-file compression). This filter reuses those registrations by
/// inserting the same middleware ahead of routing. UseMiddleware(Type) is
/// used instead of UseResponseCompression() to avoid a compile-time
/// extension-method resolution conflict between the shared framework and
/// the NuGet DI abstractions that Jellyfin.Controller pins.
///
/// BREACH/CRIME: compressing authenticated responses over TLS is the
/// standard theoretical caveat. Jellyfin already compresses authenticated
/// static content, the API responses carry no reflected user input
/// alongside the auth token, and this is a LAN/DDNS deployment.
/// </summary>
public class ResponseCompressionStartupFilter : IStartupFilter
{
    private static readonly Type? MiddlewareType = Type.GetType(
        "Microsoft.AspNetCore.ResponseCompression.ResponseCompressionMiddleware, Microsoft.AspNetCore.ResponseCompression");

    private static readonly Type? ProviderServiceType = Type.GetType(
        "Microsoft.AspNetCore.ResponseCompression.IResponseCompressionProvider, Microsoft.AspNetCore.ResponseCompression");

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            // UseMiddleware(Type) constructs the middleware at pipeline build:
            // if IResponseCompressionProvider ever stopped being registered
            // (it powers Jellyfin's static-file compression today), an
            // unguarded branch would fail the whole server at startup instead
            // of just skipping compression.
            if (MiddlewareType != null
                && ProviderServiceType != null
                && app.ApplicationServices.GetService(ProviderServiceType) != null)
            {
                app.UseWhen(
                    context => !IsExcluded(context.Request.Path),
                    branch => branch.UseMiddleware(MiddlewareType));
            }
            next(app);
        };
    }

    private static bool IsExcluded(Microsoft.AspNetCore.Http.PathString path)
    {
        if (!path.HasValue)
            return false;

        var value = path.Value!;

        if (value.StartsWith("/Playback/BitrateTest", StringComparison.OrdinalIgnoreCase))
            return true;

        if (value.StartsWith("/Videos/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/Audio/", StringComparison.OrdinalIgnoreCase)
            || (value.StartsWith("/Items/", StringComparison.OrdinalIgnoreCase)
                && value.Contains("/Images", StringComparison.OrdinalIgnoreCase)))
            return true;

        return false;
    }
}
