using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-709: append <c>Access-Control-Max-Age</c> to every CORS preflight the
/// server approves, so a TV pays one preflight per (origin, method, headers)
/// per cache window instead of one per request.
///
/// Why this matters: the WGT bootstrap's origin is never the API's origin, so
/// every Jellyfin API call the app makes is cross-origin, and every one
/// carries <c>X-Emby-Authorization</c> — not a CORS-safelisted header, so
/// every call is preflight + real request, two serialized round trips. The
/// server answers those preflights with no max-age, and the Fetch spec's
/// fallback is FIVE SECONDS, which on a multi-minute TV boot means the same
/// endpoint is preflighted again and again: 98 of 555 requests (17.7%) in the
/// JELA-706 cold-boot waterfall were preflights. At household-Wi-Fi RTT that
/// is seconds of pure serialized latency that shows up as neither bytes nor
/// server CPU — invisible to every byte- and request-count sweep before it.
///
/// Why an <see cref="IStartupFilter"/> and not a response header on our
/// controller: a preflight OPTIONS never reaches ANY controller — Jellyfin's
/// server-wide CORS middleware answers it and short-circuits the pipeline —
/// so there is no per-route lever, on our routes or anyone else's. And a
/// plugin cannot substitute the policy either: plugin RegisterServices runs
/// inside <c>appHost.Init</c>, which the host executes BEFORE
/// <c>Startup.ConfigureServices</c> registers Jellyfin's own
/// <c>ICorsPolicyProvider</c>, and the last registration wins. IStartupFilter
/// is the one hook that is order-independent: every registered filter runs,
/// composed, so this middleware sits at the outer edge of the pipeline and
/// decorates the preflight response on its way out via
/// <see cref="HttpResponse.OnStarting(Func{object, Task}, object)"/>.
///
/// The decoration is deliberately narrow and deferential:
///   * only true preflights (OPTIONS + Access-Control-Request-Method);
///   * only when the CORS layer actually approved the request (an
///     Access-Control-Allow-Origin is on the response — a refused origin gets
///     no headers from us either);
///   * only when no max-age is already present, so the day Jellyfin core
///     sends its own (the upstream half of JELA-709) this filter stands down
///     automatically.
///
/// 600 because Chromium clamps the preflight cache to 600 s regardless of a
/// larger value, and it comfortably covers a boot plus normal browsing. The
/// cache is self-limiting: keyed on origin + method + headers, so a CORS
/// policy change invalidates naturally within the window.
///
/// The kill switch (<see cref="PluginConfiguration.DisableCorsPreflightMaxAge"/>)
/// is read per-response, so an operator flip takes effect without a restart.
/// </summary>
public class CorsPreflightMaxAgeStartupFilter : IStartupFilter
{
    /// <summary>Chromium's preflight-cache clamp — higher buys nothing.</summary>
    internal const string MaxAgeSeconds = "600";

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        => app =>
        {
            app.Use(static (context, nextMiddleware) =>
            {
                if (HttpMethods.IsOptions(context.Request.Method)
                    && !StringValues.IsNullOrEmpty(context.Request.Headers.AccessControlRequestMethod))
                {
                    context.Response.OnStarting(static state =>
                    {
                        var headers = ((HttpContext)state).Response.Headers;
                        var config = Plugin.Instance?.Configuration;
                        if (config?.DisableCorsPreflightMaxAge != true
                            && !StringValues.IsNullOrEmpty(headers.AccessControlAllowOrigin)
                            && StringValues.IsNullOrEmpty(headers.AccessControlMaxAge))
                        {
                            headers.AccessControlMaxAge = MaxAgeSeconds;
                        }

                        return Task.CompletedTask;
                    }, context);
                }

                return nextMiddleware(context);
            });

            next(app);
        };
}
