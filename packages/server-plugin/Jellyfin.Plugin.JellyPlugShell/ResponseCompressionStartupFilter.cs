using System.IO.Compression;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Inserts gzip compression at the front of the pipeline so controller output
/// (not just static files) is compressed. Jellyfin only wraps its static-file
/// branch — every controller response ships uncompressed, costing ~3.9 MiB per
/// boot on a TV whose boot is bytes-and-RTT bound.
///
/// The original approach (UseMiddleware via reflected Type) was silent-noop in
/// Jellyfin's plugin AssemblyLoadContext: Type.GetType() and AppDomain scans
/// both failed to produce a type that ActivatorUtilities could wire against the
/// already-registered IResponseCompressionProvider. Rather than chasing another
/// layer of reflection, this filter implements gzip directly — the same pattern
/// HomeScreenSectionCacheStartupFilter uses for body capture.
///
/// BREACH/CRIME: compressing authenticated responses over TLS is the standard
/// theoretical caveat. Jellyfin already compresses authenticated static content,
/// the API responses carry no reflected user input alongside the auth token, and
/// this is a LAN/DDNS deployment.
/// </summary>
public class ResponseCompressionStartupFilter : IStartupFilter
{
    private readonly ILogger<ResponseCompressionStartupFilter> _logger;

    public ResponseCompressionStartupFilter(ILogger<ResponseCompressionStartupFilter> logger)
    {
        _logger = logger;
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var request = context.Request;
                var response = context.Response;

                // Skip excluded routes (bandwidth probes, media streams, images)
                if (IsExcluded(request.Path))
                {
                    await nextMiddleware();
                    return;
                }

                // Only compress when the client advertises gzip support
                var acceptEncoding = request.Headers.AcceptEncoding.ToString();
                if (!acceptEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase))
                {
                    await nextMiddleware();
                    return;
                }

                // Intercept the response body so we can decide whether to compress
                var originalBodyFeature = context.Features.Get<IHttpResponseBodyFeature>()!;
                using var buffer = new MemoryStream();
                context.Features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(buffer));

                try
                {
                    await nextMiddleware();
                }
                finally
                {
                    context.Features.Set(originalBodyFeature);
                }

                var body = buffer.ToArray();

                // Skip if already encoded, non-JSON/text, or too small to bother
                var hasStarted = response.HasStarted;
                var contentEncoding = response.Headers.ContentEncoding.ToString();
                var compressible = IsCompressibleContentType(response.ContentType);
                if (hasStarted || body.Length < 150 || !string.IsNullOrEmpty(contentEncoding) || !compressible)
                {
                    _logger.LogDebug(
                        "JELA-727 skip {Path}: hasStarted={S} bodyLen={L} contentEncoding={E} compressible={C} contentType={CT}",
                        request.Path, hasStarted, body.Length, contentEncoding, compressible, response.ContentType);
                    if (body.Length > 0)
                        await originalBodyFeature.Stream.WriteAsync(body);
                    return;
                }

                // Compress the body
                using var compressed = new MemoryStream();
                using (var gz = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                {
                    gz.Write(body, 0, body.Length);
                }

                var compressedBody = compressed.ToArray();

                // Only ship compressed if it's actually smaller
                if (compressedBody.Length >= body.Length)
                {
                    response.ContentLength = body.Length;
                    if (body.Length > 0)
                        await originalBodyFeature.Stream.WriteAsync(body);
                    return;
                }

                response.Headers.ContentEncoding = "gzip";
                AppendVary(response.Headers, "Accept-Encoding");
                response.ContentLength = compressedBody.Length;

                _logger.LogDebug(
                    "JELA-727 compressed {Path}: {Raw} -> {Gz} bytes",
                    request.Path, body.Length, compressedBody.Length);

                await originalBodyFeature.Stream.WriteAsync(compressedBody);
            });

            next(app);
        };
    }

    private static bool IsExcluded(PathString path)
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

    private static bool IsCompressibleContentType(string? contentType)
    {
        if (string.IsNullOrEmpty(contentType))
            return false;

        // Strip parameters (e.g. "; charset=utf-8")
        var semi = contentType.IndexOf(';', StringComparison.Ordinal);
        var mimeType = (semi < 0 ? contentType : contentType[..semi]).Trim();

        return mimeType.Equals("application/json", StringComparison.OrdinalIgnoreCase)
            || mimeType.Equals("text/json", StringComparison.OrdinalIgnoreCase)
            || mimeType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
            || mimeType.Equals("application/xml", StringComparison.OrdinalIgnoreCase)
            || mimeType.Equals("application/javascript", StringComparison.OrdinalIgnoreCase)
            || mimeType.Equals("application/wasm", StringComparison.OrdinalIgnoreCase);
    }

    private static void AppendVary(IHeaderDictionary headers, string field)
    {
        var existing = headers.Vary.ToString();
        if (string.IsNullOrEmpty(existing))
        {
            headers.Vary = field;
        }
        else if (!existing.Contains(field, StringComparison.OrdinalIgnoreCase))
        {
            headers.Vary = existing + ", " + field;
        }
    }
}
