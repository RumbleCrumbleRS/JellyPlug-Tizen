using System;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-722. Stamps immutable cache headers on <c>/web/</c> assets whose filename
/// carries a webpack content hash.
///
/// JELA-714's Cache Headers plugin keys off the <c>?&lt;buildhash&gt;</c> query string,
/// which only the 32 entrypoints referenced from index.html ever carry. The webpack
/// runtime requests its chunks with no query at all — they are already content-hashed
/// in the filename — so 49 assets (415 KiB encoded) were re-downloaded on every warm
/// boot. A content-hashed filename cannot go stale by construction, which makes these
/// the safest possible immutable candidates.
///
/// JELA-826. Unhashed stable assets (<c>blurhash.worker.bundle.js</c>,
/// <c>themes/*/theme.css</c>) get a short revalidatable policy instead of immutable —
/// they can change on a jellyfin-web upgrade. <c>config.json</c> gets <c>no-cache</c>
/// so every boot revalidates configuration. All three also get <c>Vary: Origin</c>
/// to prevent the M63 cache-mode collision (JELA-688).
///
/// <c>Vary: Origin</c> is mandatory alongside <c>immutable</c>: the M63 HTTP cache is
/// not partitioned by request mode, so a no-cors entry would otherwise poison a later
/// CORS fetch of the same url (m63-cors-cache-mode-collision, JELA-688).
/// </summary>
public class WebAssetCacheStartupFilter : IStartupFilter
{
    private const string CacheControlValue = "public, max-age=604800, immutable";

    // Short-lived policy for unhashed but stable assets (blurhash.worker.bundle.js,
    // themes/*/theme.css). 1-hour max-age lets a warm TV skip the network on the
    // same day while still revalidating after a jellyfin-web upgrade overnight.
    private const string RevalidatableCacheControlValue = "public, max-age=3600, must-revalidate";

    // config.json is configuration — force a conditional GET on every boot.
    private const string NoCacheCacheControlValue = "no-cache";

    /// <summary>
    /// A webpack content hash segment. jellyfin-web emits exactly 20 lowercase hex
    /// characters for every one of its 1,065 chunk assets (927 js + 138 css) and for
    /// asset-module output such as MaterialIcons-Regular.&lt;hash&gt;.woff2. Anchoring on
    /// the exact length keeps ordinary hex-looking words (facade, decade, deafbeef)
    /// from being mistaken for a hash.
    /// </summary>
    private static readonly Regex ContentHashPattern = new(
        @"\.[0-9a-f]{20}\.",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var path = context.Request.Path.Value;
                var cacheControlOverride = GetWebAssetCacheControl(path);

                if (cacheControlOverride is not null)
                {
                    context.Response.OnStarting(
                        state =>
                        {
                            var (ctx, cc) = ((HttpContext, string))state;
                            var response = ctx.Response;

                            // Status is only final here, not at middleware entry. Never stamp
                            // a 404/500 — that would cache an error.
                            var status = response.StatusCode;
                            if (status is not (StatusCodes.Status200OK
                                or StatusCodes.Status206PartialContent
                                or StatusCodes.Status304NotModified))
                            {
                                return Task.CompletedTask;
                            }

                            response.Headers["Cache-Control"] = cc;

                            var vary = response.Headers["Vary"].ToString();
                            if (string.IsNullOrEmpty(vary))
                            {
                                response.Headers["Vary"] = "Accept-Encoding, Origin";
                            }
                            else if (vary.IndexOf("Origin", StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                response.Headers["Vary"] = vary + ", Origin";
                            }

                            return Task.CompletedTask;
                        },
                        (context, cacheControlOverride));
                }

                await nextMiddleware().ConfigureAwait(false);
            });

            next(app);
        };
    }

    /// <summary>
    /// Returns the Cache-Control value to apply to a /web/ asset, or null if the
    /// path is not a /web/ asset we manage.
    /// </summary>
    internal static string? GetWebAssetCacheControl(string? path)
    {
        if (path is null || !path.StartsWith("/web/", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var lastSlash = path.LastIndexOf('/');
        var filename = path[(lastSlash + 1)..];

        if (filename.Equals("config.json", StringComparison.OrdinalIgnoreCase))
        {
            return NoCacheCacheControlValue;
        }

        if (filename.Equals("index.html", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (ContentHashPattern.IsMatch(filename))
        {
            return CacheControlValue;
        }

        // Unhashed but stable /web/ assets (blurhash.worker.bundle.js, themes/*/theme.css,
        // and any other bare-name webpack output). Short revalidatable policy — safe to
        // cache briefly but not permanently, because these can change on a jellyfin-web
        // upgrade without a filename change. All still need Vary: Origin (JELA-826).
        return RevalidatableCacheControlValue;
    }

    // Kept for callers that relied on the old boolean form (tests).
    internal static bool IsImmutableWebAsset(string? path) =>
        GetWebAssetCacheControl(path) == CacheControlValue;
}
