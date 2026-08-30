using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-723. Stamps a revalidatable <c>Cache-Control</c> on the three third-party
/// plugin client scripts our shell injects at ~870 ms into every boot.
///
/// The routes belong to NotifySync, GetAvatar and Plugin Pages, so there is no
/// controller of ours to fix — same reason as JELA-731/732, same hook: every
/// registered <see cref="IStartupFilter"/> runs, composed, which is the one
/// order-independent way a plugin gets middleware around routes it does not own
/// (proven live by JELA-714's stamping of core-owned <c>/web/</c>).
///
/// What is wrong today, measured on the live corpus (JELA-720 census):
/// <list type="bullet">
/// <item><c>/NotifySync/client.js</c> — 63,603 B at <c>max-age=300</c>; five minutes
/// is shorter than any realistic gap between TV power-ons, so every boot
/// re-downloads it.</item>
/// <item><c>/GetAvatar/ClientScript</c> — 16,091 B, no Cache-Control at all.</item>
/// <item><c>/PluginPages/inject.js</c> — 2,707 B, no Cache-Control at all.</item>
/// </list>
///
/// The stamp is <c>public, max-age=86400</c> — deliberately NOT <c>immutable</c>:
/// these are bare urls with no content hash, so the entry must be able to go
/// stale (the JELA-688 babel.min.js conclusion). The bodies change only when the
/// third-party plugin itself is upgraded, so a day of staleness is the bounded
/// worst case, against NotifySync's own choice of 300 s.
///
/// <c>Vary</c> gets both <c>Accept-Encoding</c> (the body may be served gzipped
/// by the JELA-727 compression filter) and <c>Origin</c> (the M63 HTTP cache is
/// not partitioned by request mode, so a no-cors script-tag entry would poison a
/// later CORS fetch of the same url — m63-cors-cache-mode-collision, JELA-688).
///
/// Unlike JELA-709 this filter DOES overwrite an existing Cache-Control:
/// NotifySync's 300 s is the defect being fixed, not a layer to defer to. The
/// kill switch (<see cref="PluginConfiguration.DisablePluginScriptCacheHeaders"/>)
/// is read per-response, so an operator flip takes effect without a restart and
/// restores each plugin's own headers exactly.
/// </summary>
public class PluginScriptCacheStartupFilter : IStartupFilter
{
    /// <summary>
    /// One day, revalidatable. Bounded staleness after a plugin upgrade; long
    /// enough that no same-day boot re-downloads the scripts.
    /// </summary>
    internal const string CacheControlValue = "public, max-age=86400";

    private static readonly string[] StampedPaths =
    {
        "/NotifySync/client.js",
        "/GetAvatar/ClientScript",
        "/PluginPages/inject.js",
    };

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(static async (context, nextMiddleware) =>
            {
                if (IsStampedScript(context.Request.Path.Value))
                {
                    context.Response.OnStarting(static state =>
                    {
                        var response = ((HttpContext)state).Response;

                        // Status is only final here, not at middleware entry. A 404
                        // (plugin uninstalled) or 500 must keep its default
                        // no-store behavior — a day-long cached error is worse
                        // than the re-download this filter removes.
                        if (response.StatusCode is not (StatusCodes.Status200OK
                            or StatusCodes.Status304NotModified))
                        {
                            return Task.CompletedTask;
                        }

                        if (Plugin.Instance?.Configuration.DisablePluginScriptCacheHeaders == true)
                        {
                            return Task.CompletedTask;
                        }

                        response.Headers.CacheControl = CacheControlValue;
                        response.Headers.Vary = MergeVary(response.Headers.Vary.ToString());

                        return Task.CompletedTask;
                    }, context);
                }

                await nextMiddleware(context).ConfigureAwait(false);
            });

            next(app);
        };
    }

    internal static bool IsStampedScript(string? path)
    {
        if (path is null)
        {
            return false;
        }

        foreach (var stamped in StampedPaths)
        {
            if (string.Equals(path, stamped, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Appends Accept-Encoding and Origin to whatever Vary is already on the
    /// response (the JELA-727 compression middleware may have set
    /// Accept-Encoding before this callback runs) without duplicating either.
    /// </summary>
    internal static string MergeVary(string existing)
    {
        if (string.IsNullOrEmpty(existing))
        {
            return "Accept-Encoding, Origin";
        }

        var merged = existing;
        if (!ContainsToken(merged, "Accept-Encoding"))
        {
            merged += ", Accept-Encoding";
        }

        if (!ContainsToken(merged, "Origin"))
        {
            merged += ", Origin";
        }

        return merged;
    }

    private static bool ContainsToken(string headerValue, string token)
    {
        foreach (var part in headerValue.Split(','))
        {
            if (part.Trim().Equals(token, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}
