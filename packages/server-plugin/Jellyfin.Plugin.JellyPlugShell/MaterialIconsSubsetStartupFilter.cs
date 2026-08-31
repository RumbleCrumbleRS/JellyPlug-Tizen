using System;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-825. Intercepts any <c>/web/MaterialIcons-Regular.*.woff2</c> request and
/// serves a pre-built subset in its place, replacing the full 125 KB upstream file
/// (~2,100 glyphs) with a 4 KB subset containing only the ~96 icons the Jellyfin
/// web UI actually renders. The subset is a pre-built WOFF2 embedded as a plugin
/// resource; the response is served before Jellyfin's static-file handler runs.
///
/// Why intercept rather than patch the CSS? The CSS is built into jellyfin-web and
/// cannot be rewritten without rebuilding it. The font URL carries a 20-char webpack
/// content hash — patching the CSS would require a new CSS asset hash too, which
/// chain-invalidates the entrypoint and every CSS chunk. Short-circuiting the font
/// request is a clean, update-safe alternative: when Jellyfin ships a new font hash
/// the old URL disappears from the TV cache anyway, and this filter catches any hash.
///
/// Registration order: must sit INSIDE <see cref="ResponseCompressionStartupFilter"/>
/// (registered first / outermost) so that compression wraps this response too.
/// Registered immediately before <see cref="WebAssetCacheStartupFilter"/> so the
/// interception short-circuits before that filter's <c>OnStarting</c> runs; they
/// do not conflict because short-circuited responses never invoke <c>OnStarting</c>
/// on the real static-file response.
/// </summary>
public class MaterialIconsSubsetStartupFilter : IStartupFilter
{
    // Matches /web/MaterialIcons-Regular.<20-hex-char-hash>.woff2 (any version hash).
    private static readonly Regex MaterialIconsPathPattern = new(
        @"^/web/MaterialIcons-Regular\.[0-9a-f]{20}\.woff2$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private const string SubsetAssetName = "MaterialIcons-Regular-subset.woff2";
    private const string FontContentType = "font/woff2";
    private const string CacheControlValue = "public, max-age=604800, immutable";
    private const string VaryValue = "Accept-Encoding, Origin";

    private readonly ShellDropService _drop;

    public MaterialIconsSubsetStartupFilter(ShellDropService drop)
    {
        _drop = drop;
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var path = context.Request.Path.Value;
                if (path is not null && MaterialIconsPathPattern.IsMatch(path))
                {
                    await ServeSubset(context).ConfigureAwait(false);
                    return;
                }

                await nextMiddleware().ConfigureAwait(false);
            });

            next(app);
        };
    }

    private async Task ServeSubset(HttpContext context)
    {
        if (!_drop.FontAssets.TryGetValue(SubsetAssetName, out var asset))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var request = context.Request;
        var response = context.Response;

        response.Headers["Cache-Control"] = CacheControlValue;
        response.Headers["Vary"] = VaryValue;

        // Honour If-None-Match to avoid re-sending 4 KB on warm hits.
        var etag = $"\"{asset.Sha256[..16]}\"";
        response.Headers["ETag"] = etag;

        var ifNoneMatch = request.Headers["If-None-Match"].ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch.Contains(etag, StringComparison.Ordinal))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            return;
        }

        // Send the subset — gzip if the client supports it, raw otherwise.
        var acceptEncoding = request.Headers["Accept-Encoding"].ToString();
        var gzipBytes = asset.GzipBytes;
        if (gzipBytes is not null && acceptEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase))
        {
            response.Headers["Content-Encoding"] = "gzip";
            response.ContentType = FontContentType;
            response.ContentLength = gzipBytes.Length;
            response.StatusCode = StatusCodes.Status200OK;
            await response.Body.WriteAsync(gzipBytes).ConfigureAwait(false);
        }
        else
        {
            response.ContentType = FontContentType;
            response.ContentLength = asset.Bytes.Length;
            response.StatusCode = StatusCodes.Status200OK;
            await response.Body.WriteAsync(asset.Bytes).ConfigureAwait(false);
        }
    }
}
