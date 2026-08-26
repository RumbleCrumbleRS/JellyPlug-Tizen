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
/// Deliberately NOT covered:
/// <list type="bullet">
/// <item>the 10 bare <c>node_modules.*.bundle.js</c> chunk names — no hash in the
/// filename, so an immutable entry at that bare url would survive a jellyfin-web
/// upgrade and go stale (same hazard as babel.min.js in JELA-688/689).</item>
/// <item><c>config.json</c>, <c>index.html</c>, <c>themes/*/theme.css</c> — mutable
/// content at stable urls.</item>
/// </list>
///
/// <c>Vary: Origin</c> is mandatory alongside <c>immutable</c>: the M63 HTTP cache is
/// not partitioned by request mode, so a no-cors entry would otherwise poison a later
/// CORS fetch of the same url (m63-cors-cache-mode-collision, JELA-688).
/// </summary>
public class WebAssetCacheStartupFilter : IStartupFilter
{
    private const string CacheControlValue = "public, max-age=604800, immutable";

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
                if (IsImmutableWebAsset(context.Request.Path.Value))
                {
                    context.Response.OnStarting(static state =>
                    {
                        var response = ((HttpContext)state).Response;

                        // Status is only final here, not at middleware entry. Never stamp
                        // a 404/500 immutable — that would pin an error for a week.
                        var status = response.StatusCode;
                        if (status is not (StatusCodes.Status200OK
                            or StatusCodes.Status206PartialContent
                            or StatusCodes.Status304NotModified))
                        {
                            return Task.CompletedTask;
                        }

                        response.Headers["Cache-Control"] = CacheControlValue;

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
                    }, context);
                }

                await nextMiddleware().ConfigureAwait(false);
            });

            next(app);
        };
    }

    internal static bool IsImmutableWebAsset(string? path)
    {
        if (path is null || !path.StartsWith("/web/", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var lastSlash = path.LastIndexOf('/');
        var filename = path[(lastSlash + 1)..];

        // Mutable content at stable urls. None of these carry a hash segment, so the
        // pattern below already rejects them; kept explicit so the intent survives.
        if (filename.Equals("config.json", StringComparison.OrdinalIgnoreCase)
            || filename.Equals("index.html", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return ContentHashPattern.IsMatch(filename);
    }
}
