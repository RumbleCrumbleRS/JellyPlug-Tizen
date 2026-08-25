using System;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-731. Serves <c>GET /HomeScreen/Section/LatestShows</c> from
/// <see cref="LatestShowsFastPath"/> when it can reproduce the upstream row, and
/// otherwise gets out of the way.
///
/// <para>Why a middleware and not a section: <c>/HomeScreen/Section/{sectionType}</c> is
/// a Home Screen Sections route, and its section registry takes last-writer-wins on the
/// section id — overriding it would need a compile-time reference to a third-party
/// plugin on its own release train. An <see cref="IStartupFilter"/> runs ahead of the
/// whole pipeline and needs no cooperation from the route's owner, which is the same
/// hook JELA-709/714/722 use.</para>
///
/// <para>The cost of running ahead of the pipeline is that a short-circuited response
/// skips the middleware that would have decorated it, so the two headers the fielded
/// TVs and the perf harness actually depend on are reproduced here, exactly as the
/// live origin emits them: <c>Access-Control-Allow-Origin: *</c> only when the request
/// carries an <c>Origin</c> (the shell's fetches are cross-origin — the page origin is
/// <c>file://</c> on-device), and <c>x-response-time-ms</c>, which every measurement in
/// this programme is quoted in.</para>
/// </summary>
public class LatestShowsFastPathStartupFilter : IStartupFilter
{
    private const string RequestPath = "/HomeScreen/Section/LatestShows";

    /// <summary>
    /// Marks a response as having come from the fast path. Verification needs to tell
    /// "the fix is fast" apart from "the fix quietly stepped aside and the box is warm";
    /// with medians a few hundred ms apart, timing alone cannot.
    /// </summary>
    private const string ServedByHeader = "X-JellyPlug-LatestShows";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var body = await TrySerializeAsync(context).ConfigureAwait(false);
                if (body is null)
                {
                    await nextMiddleware().ConfigureAwait(false);
                    return;
                }

                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "application/json; charset=utf-8";
                context.Response.ContentLength = body.Value.Body.Length;
                context.Response.Headers[ServedByHeader] = "fastpath";
                context.Response.Headers["x-response-time-ms"] =
                    body.Value.ElapsedMs.ToString("0.0000", CultureInfo.InvariantCulture);

                if (!string.IsNullOrEmpty(context.Request.Headers.Origin))
                {
                    context.Response.Headers["Access-Control-Allow-Origin"] = "*";
                }

                await context.Response.Body.WriteAsync(body.Value.Body).ConfigureAwait(false);
            });

            next(app);
        };
    }

    /// <summary>
    /// Produces the response body, or <c>null</c> to let Home Screen Sections answer.
    /// Nothing is written to the response until the whole body exists, so every
    /// bail-out below — including an unexpected exception — falls back cleanly to
    /// today's behaviour rather than to a half-written reply.
    /// </summary>
    private static async Task<(ReadOnlyMemory<byte> Body, double ElapsedMs)?> TrySerializeAsync(HttpContext context)
    {
        if (!IsLatestShowsRequest(context.Request))
        {
            return null;
        }

        if (Plugin.Instance?.Configuration.DisableLatestShowsFastPath ?? false)
        {
            return null;
        }

        var stopwatch = Stopwatch.StartNew();

        try
        {
            if (!Guid.TryParse(context.Request.Query["UserId"], out var userId) || userId.Equals(default))
            {
                return null;
            }

            var services = context.RequestServices;

            // Jellyfin's authorization context parses the token off the request itself, so
            // it does not need the auth middleware (which runs downstream of us) to have
            // gone first.
            var authorizationContext = services.GetService<IAuthorizationContext>();
            if (authorizationContext is null)
            {
                return null;
            }

            var auth = await authorizationContext.GetAuthorizationInfo(context).ConfigureAwait(false);

            // The upstream route is [Authorize] and then trusts whatever UserId the caller
            // passes. Rather than reproduce that, the fast path only answers for the
            // caller's own user (or an API key, which is server-wide by definition) and
            // hands every other shape back to the route that owns it — so this cannot
            // widen access to anyone's row.
            if (!auth.IsApiKey && (auth.User is null || !auth.User.Id.Equals(userId)))
            {
                return null;
            }

            var userManager = services.GetService<IUserManager>();
            var libraryManager = services.GetService<ILibraryManager>();
            var dtoService = services.GetService<IDtoService>();
            var jsonOptions = services.GetService<IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>>();

            if (userManager is null || libraryManager is null || dtoService is null || jsonOptions is null)
            {
                return null;
            }

            var result = LatestShowsFastPath.TryBuild(userId, userManager, libraryManager, dtoService);
            if (result is null)
            {
                return null;
            }

            // Serialized with the very options the MVC pipeline would have used, so the
            // bytes match what the route emits today (PascalCase, Jellyfin's converters).
            var body = JsonSerializer.SerializeToUtf8Bytes(result, jsonOptions.Value.JsonSerializerOptions);

            return (body, stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (Exception)
        {
            // A row is not worth a 500. Anything unexpected is upstream's request again.
            return null;
        }
    }

    internal static bool IsLatestShowsRequest(HttpRequest request)
    {
        return HttpMethods.IsGet(request.Method)
            && request.Path.HasValue
            && string.Equals(request.Path.Value, RequestPath, StringComparison.OrdinalIgnoreCase);
    }
}
