using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-732: puts a short private cache in front of
/// <c>/HomeScreen/Section/{name}</c>, the Home Screen Sections plugin's
/// row-CONTENTS endpoint. It answers with no Cache-Control and no ETag, so
/// every home load — every boot, every navigation home, every TV — rebuilds
/// every row from scratch: 1.4-2.2 s of server query CPU per load, measured
/// on the live origin (JELA-730). Repeats are far cheaper than first builds,
/// which is exactly the shape a cache is for.
///
/// This is NOT the endpoint JELA-693/JELA-703 fixed. Those covered
/// <c>/HomeScreen/Sections</c>, the section LIST; the section contents were
/// explicitly out of scope there and stayed live.
///
/// Two levers, one TTL:
///
///   * a server-side memo (<see cref="HomeScreenSectionCache"/>) so a repeat
///     never re-runs the query at all, and
///   * <c>Cache-Control: private, max-age=TTL</c> + a body-hash ETag so the
///     TV's own HTTP cache can skip the request, and a revalidation that does
///     happen costs a 304 instead of a rebuilt body.
///
/// Why a middleware and not a patch to that plugin: an <c>IStartupFilter</c>
/// is the only order-independent hook a Jellyfin plugin has into another
/// component's pipeline (JELA-709), and it needs no fork of a third-party
/// plugin we do not ship.
///
/// Pipeline position: first-registered startup filter is OUTERMOST, so this
/// sits outside Jellyfin's routing, auth, CORS and response-time middleware.
/// Consequences, all handled below: a hit must replay the CORS headers itself
/// (<see cref="HomeScreenSectionCache.CachedResponse.AllowOrigin"/>), must
/// emit its own <c>x-response-time-ms</c> (Jellyfin's writer is inside and
/// never runs on a hit), and must never serve a body to a credential that did
/// not already receive it — hence the credential-keyed store.
/// </summary>
public class HomeScreenSectionCacheStartupFilter : IStartupFilter
{
    /// <summary>The row-contents route. The trailing slash keeps /HomeScreen/Sections out.</summary>
    private const string SectionPathPrefix = "/HomeScreen/Section/";

    private const string CacheStatusHeader = "X-JellyPlug-Section-Cache";

    private static readonly Regex AuthTokenPattern = new(
        @"Token\s*=\s*""?([^"",\s]+)""?",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly HomeScreenSectionCache _cache;

    public HomeScreenSectionCacheStartupFilter(HomeScreenSectionCache cache)
    {
        _cache = cache;
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
                var ttlSeconds = config.HomeScreenSectionCacheSeconds;

                if (config.DisableHomeScreenSectionCache || ttlSeconds <= 0)
                {
                    await nextMiddleware();
                    return;
                }

                var credential = IsCandidate(context.Request) ? ExtractCredential(context.Request) : null;

                // No credential = nothing we are allowed to key on, so nothing
                // we may cache. Anonymous traffic takes the normal path.
                if (credential == null)
                {
                    await nextMiddleware();
                    return;
                }

                var ttl = TimeSpan.FromSeconds(ttlSeconds);
                var origin = context.Request.Headers["Origin"].ToString();
                var key = HomeScreenSectionCache.BuildKey(
                    context.Request.Method,
                    context.Request.Path.Value ?? string.Empty,
                    context.Request.QueryString.Value ?? string.Empty,
                    credential,
                    origin);

                var stopwatch = Stopwatch.StartNew();
                var now = DateTimeOffset.UtcNow;
                var hit = _cache.TryGet(key, now);

                if (hit != null)
                {
                    await ServeFromCacheAsync(context, hit, now, config, stopwatch);
                    return;
                }

                await ServeAndMaybeStoreAsync(context, nextMiddleware, key, ttl, config);
            });

            next(app);
        };
    }

    /// <summary>GET on the row-contents route, and not a client that asked us not to.</summary>
    private static bool IsCandidate(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
            return false;

        var path = request.Path.Value;
        if (path == null || !path.StartsWith(SectionPathPrefix, StringComparison.OrdinalIgnoreCase))
            return false;

        // A client that explicitly refuses stored responses gets a live one.
        var requestCacheControl = request.Headers.CacheControl.ToString();
        if (requestCacheControl.Contains("no-store", StringComparison.OrdinalIgnoreCase))
            return false;

        return true;
    }

    /// <summary>
    /// The caller's API token, however Jellyfin clients present it. Returns
    /// null when there is none — an unauthenticated request must never hit a
    /// stored body.
    /// </summary>
    internal static string? ExtractCredential(HttpRequest request)
    {
        foreach (var header in new[] { "X-Emby-Token", "X-MediaBrowser-Token" })
        {
            var value = request.Headers[header].ToString();
            if (!string.IsNullOrWhiteSpace(value))
                return value;
        }

        foreach (var header in new[] { "Authorization", "X-Emby-Authorization" })
        {
            var value = request.Headers[header].ToString();
            if (string.IsNullOrWhiteSpace(value))
                continue;

            var match = AuthTokenPattern.Match(value);
            if (match.Success)
                return match.Groups[1].Value;
        }

        foreach (var name in new[] { "api_key", "ApiKey" })
        {
            var value = request.Query[name].ToString();
            if (!string.IsNullOrWhiteSpace(value))
                return value;
        }

        return null;
    }

    private static async Task ServeFromCacheAsync(
        HttpContext context,
        HomeScreenSectionCache.CachedResponse entry,
        DateTimeOffset now,
        PluginConfiguration config,
        Stopwatch stopwatch)
    {
        var response = context.Response;
        var headers = response.Headers;

        headers["ETag"] = entry.ETag;
        ApplyClientCacheHeaders(headers, entry.ExpiresUtc - now, config);

        if (entry.Vary != null)
            headers["Vary"] = entry.Vary;
        if (entry.AllowOrigin != null)
            headers["Access-Control-Allow-Origin"] = entry.AllowOrigin;
        if (entry.AllowCredentials != null)
            headers["Access-Control-Allow-Credentials"] = entry.AllowCredentials;
        if (entry.ExposeHeaders != null)
            headers["Access-Control-Expose-Headers"] = entry.ExposeHeaders;

        headers[CacheStatusHeader] = "hit";

        // Jellyfin's own response-time middleware is INSIDE this filter and
        // never runs on a short-circuit, so a hit would otherwise vanish from
        // every x-response-time-ms census. Write our own: it is the same
        // quantity (server-side wall clock for this response).
        headers["x-response-time-ms"] = stopwatch.Elapsed.TotalMilliseconds.ToString("0.0000");

        if (HomeScreenSectionCache.ETagMatches(context.Request.Headers.IfNoneMatch.ToString(), entry.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = null;
            return;
        }

        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = entry.ContentType;
        response.ContentLength = entry.Body.Length;
        await response.Body.WriteAsync(entry.Body);
    }

    private async Task ServeAndMaybeStoreAsync(
        HttpContext context,
        Func<Task> nextMiddleware,
        string key,
        TimeSpan ttl,
        PluginConfiguration config)
    {
        var response = context.Response;
        var originalBodyFeature = context.Features.Get<IHttpResponseBodyFeature>();
        using var buffer = new MemoryStream();

        // Filled in below, read back inside the OnStarting callback.
        byte[]? storableBody = null;
        string? storableETag = null;
        string? storableContentType = null;

        // JELA-794: this callback — NOT the code after nextMiddleware() — is the
        // only place the CORS headers are observable.
        //
        // ASP.NET Core's CORS middleware does not write Access-Control-* inline;
        // it registers an OnStarting callback and stamps them when the response
        // actually begins. This filter buffers the body, and the compression
        // filter outside it buffers again, so the response has NOT started when
        // we return from nextMiddleware(). The old code snapshotted headers
        // there and captured AllowOrigin = null every single time, then replayed
        // that nothing on every hit: measured on prod 1.0.37.0, a cache hit came
        // back with no Access-Control-Allow-Origin at all and a real M63 fetch
        // from Origin: null failed with "Failed to fetch" while CDP showed a
        // clean 200 (the JELA-687 divergence).
        //
        // OnStarting callbacks run in REVERSE registration order, and this one
        // is registered before the inner pipeline runs, so it fires after the
        // CORS middleware's and sees the finished header set.
        response.OnStarting(() =>
        {
            if (storableBody == null || storableETag == null)
                return Task.CompletedTask;

            EnsureVaryOrigin(response.Headers);

            var allowOrigin = HeaderOrNull(response, "Access-Control-Allow-Origin");

            // Fail-safe, and the reason correctness here does not rest on that
            // ordering argument: a cross-origin request whose CORS headers we
            // could not capture is simply NOT cached. A miss costs a rebuild; a
            // hit that replays no Access-Control-Allow-Origin is a dead row on
            // every TV, because the shell runs at file:// and every section
            // request it makes is cross-origin.
            if (allowOrigin == null && !string.IsNullOrEmpty(context.Request.Headers.Origin.ToString()))
                return Task.CompletedTask;

            var storedUtc = DateTimeOffset.UtcNow;
            _cache.Store(key, new HomeScreenSectionCache.CachedResponse
            {
                Body = storableBody,
                ETag = storableETag,
                ContentType = storableContentType ?? "application/json; charset=utf-8",
                AllowOrigin = allowOrigin,
                AllowCredentials = HeaderOrNull(response, "Access-Control-Allow-Credentials"),
                ExposeHeaders = HeaderOrNull(response, "Access-Control-Expose-Headers"),
                Vary = HeaderOrNull(response, "Vary"),
                StoredUtc = storedUtc,
                ExpiresUtc = storedUtc + ttl,
            });

            return Task.CompletedTask;
        });

        context.Features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(buffer));
        try
        {
            await nextMiddleware();
        }
        finally
        {
            if (originalBodyFeature != null)
                context.Features.Set(originalBodyFeature);
        }

        var body = buffer.ToArray();

        // The response never reached the wire (we held the body), so headers
        // are still mutable here — unless something downstream started it
        // explicitly, in which case we touch nothing and just pass the bytes on.
        if (!response.HasStarted && IsStorable(response, body))
        {
            var etag = HomeScreenSectionCache.ComputeETag(body);
            response.Headers["ETag"] = etag;
            ApplyClientCacheHeaders(response.Headers, ttl, config);
            response.Headers[CacheStatusHeader] = "miss";

            // Arms the OnStarting callback registered above. Vary and the store
            // itself happen there, once the CORS headers exist.
            if (body.Length <= HomeScreenSectionCache.MaxBodyBytes)
            {
                storableBody = body;
                storableETag = etag;
                storableContentType = response.ContentType;
            }

            if (HomeScreenSectionCache.ETagMatches(context.Request.Headers.IfNoneMatch.ToString(), etag))
            {
                response.StatusCode = StatusCodes.Status304NotModified;
                response.ContentLength = null;
                return;
            }

            response.ContentLength = body.Length;
        }

        if (body.Length > 0)
        {
            if (originalBodyFeature != null)
                await originalBodyFeature.Stream.WriteAsync(body);
            else
                await response.Body.WriteAsync(body);
        }
    }

    /// <summary>
    /// <c>private</c> because the body is one user's rows; <c>max-age</c> so a
    /// second boot inside the window skips the request entirely. Never paired
    /// with no-store — that would make the ETag inert (JELA-693).
    /// </summary>
    private static void ApplyClientCacheHeaders(IHeaderDictionary headers, TimeSpan remaining, PluginConfiguration config)
    {
        if (config.HomeScreenSectionCacheServerOnly)
        {
            // Server memo only: tell the client to keep asking, but let the
            // ETag turn the answer into a 304 instead of a rebuilt body.
            headers["Cache-Control"] = "private, no-cache";
            return;
        }

        var maxAge = (int)Math.Max(1, Math.Floor(remaining.TotalSeconds));
        headers["Cache-Control"] = "private, max-age=" + maxAge.ToString();
    }

    /// <summary>
    /// Every cacheable section response varies on Origin — including the ones
    /// that carry no Access-Control-Allow-Origin at all.
    ///
    /// JELA-794: the old version returned early unless an
    /// Access-Control-Allow-Origin was already present, which covered only half
    /// the hazard. M63 does not partition its HTTP cache by request mode
    /// (JELA-687), so the dangerous direction is the other one: an entry stored
    /// for a request that sent no Origin carries no CORS headers, and M63 will
    /// happily replay it into a later cross-origin fetch, which then fails for
    /// a body the server would have allowed. Varying on Origin unconditionally
    /// gives the two request modes separate cache slots and closes both
    /// directions. The header is appended, never assigned, so the compression
    /// filter's Vary: Accept-Encoding survives.
    /// </summary>
    private static void EnsureVaryOrigin(IHeaderDictionary headers)
    {
        var vary = headers["Vary"].ToString();
        if (string.IsNullOrEmpty(vary))
            headers["Vary"] = "Origin";
        else if (!vary.Contains("Origin", StringComparison.OrdinalIgnoreCase))
            headers["Vary"] = vary + ", Origin";
    }

    private static bool IsStorable(HttpResponse response, byte[] body)
    {
        if (response.StatusCode != StatusCodes.Status200OK)
            return false;

        if (body.Length == 0)
            return false;

        var contentType = response.ContentType;
        if (contentType == null || !contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
            return false;

        // Never memoize something that carries per-response state, and never
        // store an already-encoded body (compression runs outside this filter,
        // so identity bytes are what we should be holding).
        if (response.Headers.ContainsKey("Set-Cookie"))
            return false;

        if (!string.IsNullOrEmpty(response.Headers.ContentEncoding.ToString()))
            return false;

        if (response.Headers.CacheControl.ToString().Contains("no-store", StringComparison.OrdinalIgnoreCase))
            return false;

        return true;
    }

    private static string? HeaderOrNull(HttpResponse response, string name)
    {
        var value = response.Headers[name].ToString();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}
