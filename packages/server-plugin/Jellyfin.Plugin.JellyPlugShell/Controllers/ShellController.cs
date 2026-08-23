using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyPlugShell.Controllers;

/// <summary>
/// Root-level /shell/ routes for the Hosted Shell Bootstrap. Root-level (not
/// /Plugins/...) because every fielded bootstrap WGT hardcodes
/// ${server}/shell/ — precedent for plugin root routes on 10.11:
/// JellyfinEnhanced, PluginPages. The TV-facing routes are anonymous by
/// design: the TV fetches these before any login, exactly like /web/ statics.
/// Auth shape is fail-closed: the class default is RequiresElevation and each
/// TV-facing endpoint opts out with [AllowAnonymous] (method-level
/// AllowAnonymous legitimately overrides class-level Authorize). The previous
/// class-level [AllowAnonymous] did the reverse — it silently disabled the
/// method-level [Authorize] on diag/report (ASP0026) — and a future endpoint
/// added without any attribute would have shipped anonymous.
/// </summary>
[ApiController]
[Authorize(Policy = "RequiresElevation")]
[Route("shell")]
public class ShellController : ControllerBase
{
    private static readonly Regex HashRe = new("^[0-9a-z]{1,13}$", RegexOptions.ECMAScript);

    // A boot beacon is tiny (an ~10-entry ring of numbers). Refuse anything
    // that could not plausibly be one so a hostile POST can't stream a large
    // body through the sanitizer.
    private const int MaxDiagBodyBytes = 64 * 1024;

    private const string JsContentType = "application/javascript";

    // JELA-689: shell.min.js and lite.min.js are only ever requested at
    // CONTENT-ADDRESSED urls — every call site appends ?v=<manifest sha> (the
    // bootstrap's cached-sha and manifest paths) or, on the manifest-failure
    // fallback, ?t=<now>. The bytes behind a given url therefore can never
    // change, so the correct TTL is the maximum, exactly like tx/{hash}.js
    // below. The old "TVs cache-bust with ?v=<sha>, so a short TTL is enough"
    // ran the inference backwards: max-age=60 + no ETag meant every real boot
    // (any boot >60 s after the last) re-downloaded ~190 KB it already had,
    // with nothing to answer 304 with. manifest.json stays no-cache — that
    // indirection is what lets a TV discover a new sha at all.
    private const string ImmutableCacheControl = "public, max-age=31536000, immutable";

    // babel.min.js is the exception, and it is NOT safe to mark immutable: the
    // shell and boot-shell both fetch it at the BARE url
    // (`fetch(S+"/shell/babel.min.js")` — shell.js / boot-shell.src.js), so an
    // immutable year would pin a TV to whatever babel it first saw and a
    // plugin update could never reach it. A day of freshness plus the ETag
    // still converts today's every-boot 2 MB re-download into a cache hit, or
    // a ~200-byte 304 once stale.
    private const string RevalidateCacheControl = "public, max-age=86400, must-revalidate";

    private readonly ShellDropService _drop;
    private readonly DiagIngestService _diag;
    private readonly ConfigFingerprintService _fingerprint;

    public ShellController(ShellDropService drop, DiagIngestService diag, ConfigFingerprintService fingerprint)
    {
        _drop = drop;
        _diag = diag;
        _fingerprint = fingerprint;
    }

    /// <summary>
    /// JELA-58: dynamic — carries the additive configEpoch/components fields
    /// unless the operator kill switch (DisableConfigFingerprint) is on or
    /// the fingerprint is unavailable. JELA-141 adds the additive
    /// `flagDefaults` map whenever any Lite*DefaultOn config flag is set.
    /// With neither extra applicable the legacy static bytes are served
    /// verbatim (pre-JELA-58 behavior, both compat directions free).
    /// </summary>
    [AllowAnonymous]
    [HttpGet("manifest.json")]
    public IActionResult GetManifest()
    {
        Response.Headers.CacheControl = "no-cache";

        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        ConfigFingerprint? fingerprint = null;
        if (!config.DisableConfigFingerprint)
        {
            fingerprint = _fingerprint.TryGetFingerprint(config);
        }

        var flagDefaults = ShellDropService.LiteFlagDefaults(config);
        return File(_drop.BuildManifestJson(fingerprint, flagDefaults), "application/json");
    }

    [AllowAnonymous]
    [HttpGet("shell.min.js")]
    public IActionResult GetShell()
        => JsAsset(_drop.ShellBytes, _drop.ShellGzipBytes, _drop.ShellSha256, ImmutableCacheControl);

    /// <summary>
    /// JELA-67: JellyPlug Lite canvas home. Anonymous like the other TV-facing
    /// assets — a TV fetches it pre-login exactly as it fetches shell.min.js;
    /// whether it RUNS is gated on-device (jellyfin.shell.liteEnabled, default
    /// OFF). TVs cache-bust with ?v=&lt;manifest liteSha256&gt;.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("lite.min.js")]
    public IActionResult GetLite()
        => JsAsset(_drop.LiteBytes, _drop.LiteGzipBytes, _drop.LiteSha256, ImmutableCacheControl);

    [AllowAnonymous]
    [HttpGet("babel.min.js")]
    public IActionResult GetBabel()
        => JsAsset(_drop.BabelBytes, _drop.BabelGzipBytes, _drop.BabelSha256, RevalidateCacheControl);

    /// <summary>
    /// JELA-688 / JELA-689: the one way any /shell/ JS asset goes out.
    ///
    /// Jellyfin does not run response compression across plugin routes — a
    /// plugin that wants it does it itself (JavaScriptInjector on the same
    /// server is the precedent) — so these three bodies shipped raw: 190 KB
    /// shell + 34 KB lite on every warm boot, 2.0 MB babel on a cold one.
    /// gzip takes that to −72%/−66%/−77%.
    ///
    /// Serving compressed is strictly opt-in on the CLIENT's terms. A request
    /// with no Accept-Encoding, or one that rules gzip out, gets the identical
    /// raw bytes it gets today: an M63 TV must never be handed a body it
    /// cannot inflate, and this route is on the path where a stranded TV has
    /// no second chance. The bytes the TV ultimately executes are unchanged
    /// either way, so the manifest sha256 and every ?v=&lt;sha&gt; url stay
    /// correct — the sha is of the RAW asset and is never derived from what
    /// went over the wire.
    ///
    /// The two representations carry DIFFERENT ETags (`"&lt;sha&gt;"` vs
    /// `"&lt;sha&gt;-gzip"`) because an entity tag identifies a representation,
    /// not a resource; Vary: Accept-Encoding is set on both — including on the
    /// uncompressed one — so an intermediary can never hand a cached gzip body
    /// to a client that asked for identity. FileContentResult answers a
    /// matching If-None-Match with a 304 for free.
    /// </summary>
    private IActionResult JsAsset(byte[] raw, byte[]? gzip, string sha256, string cacheControl)
    {
        Response.Headers.CacheControl = cacheControl;
        Response.Headers.Vary = HeaderNames.AcceptEncoding;

        if (gzip != null && AcceptsGzip(Request.Headers.AcceptEncoding))
        {
            Response.Headers.ContentEncoding = "gzip";
            return Tagged(gzip, sha256 + "-gzip");
        }

        return Tagged(raw, sha256);
    }

    // The ETag-bearing File() overload is the 5-arg one; the 3-arg call binds
    // to `bool enableRangeProcessing` instead and silently drops the tag.
    // fileDownloadName stays null (no Content-Disposition — these are scripts,
    // not downloads) and lastModified stays null: the sha IS the validator,
    // and an embedded resource has no meaningful mtime.
    private FileContentResult Tagged(byte[] body, string tag)
        => File(
            body,
            JsContentType,
            fileDownloadName: null,
            lastModified: null,
            entityTag: new EntityTagHeaderValue("\"" + tag + "\""));

    /// <summary>
    /// True only when the client actually asked for gzip. Fail-closed in every
    /// ambiguous case (absent header, unparseable list, gzip;q=0), because the
    /// cost of guessing wrong is a TV that cannot read the shell at all.
    /// `gzip;q=0` is an explicit refusal and beats a `*` wildcard, per RFC 9110
    /// §12.5.3.
    /// </summary>
    private static bool AcceptsGzip(StringValues acceptEncoding)
    {
        if (StringValues.IsNullOrEmpty(acceptEncoding)
            || !StringWithQualityHeaderValue.TryParseList(acceptEncoding, out var encodings)
            || encodings == null)
        {
            return false;
        }

        bool? gzip = null;
        var wildcard = false;
        foreach (var encoding in encodings)
        {
            var acceptable = encoding.Quality.GetValueOrDefault(1) > 0;
            if (string.Equals(encoding.Value.Value, "gzip", StringComparison.OrdinalIgnoreCase))
            {
                gzip = acceptable;
            }
            else if (encoding.Value.Equals("*"))
            {
                wildcard = acceptable;
            }
        }

        return gzip ?? wildcard;
    }

    [AllowAnonymous]
    [HttpGet("tx-manifest.json")]
    public IActionResult GetTxManifest()
    {
        if (!System.IO.File.Exists(_drop.TxManifestPath))
        {
            return NotFound(); // no drop yet — TVs fall back to on-device Babel
        }

        Response.Headers.CacheControl = "no-cache";
        return PhysicalFile(_drop.TxManifestPath, "application/json");
    }

    [AllowAnonymous]
    [HttpGet("tx/{hash}.js")]
    public IActionResult GetTxBody([FromRoute] string hash)
    {
        if (!HashRe.IsMatch(hash))
        {
            return NotFound(); // fnv1a base36 only — also forecloses path traversal
        }

        var path = Path.Combine(_drop.TxDir, hash + ".js");
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        // Content-addressed: same hash always means same bytes.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return PhysicalFile(path, "application/javascript");
    }

    /// <summary>
    /// JELA-30 (WS-C): ingest an opt-in per-boot diag beacon (the shell's
    /// bootPhases ring + __shellTx* counters). Anonymous like the rest of
    /// /shell/ — a TV posts this before login, exactly as it fetches the shell
    /// assets. Opt-in lives on the TV (the shell only posts when
    /// localStorage["jellyfin.shell.diagBeacon"]==="1"); an operator can also
    /// refuse all ingest server-side via the plugin config. The body is fully
    /// re-sanitized in DiagIngestService — nothing here trusts its shape.
    ///
    /// text/plain is accepted alongside application/json so a shell running on
    /// a widget origin can post without tripping a CORS preflight; the body is
    /// parsed as JSON regardless of the declared content type.
    /// </summary>
    [AllowAnonymous]
    [HttpPost("diag")]
    [Consumes("application/json", "text/plain")]
    public async Task<IActionResult> PostDiag()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (config.DisableDiagIngest)
        {
            return NotFound(); // ingest turned off by the operator
        }

        byte[] body;
        using (var ms = new MemoryStream())
        {
            // Bounded copy: stop reading past the cap instead of buffering an
            // attacker-controlled stream.
            var buffer = new byte[8192];
            int read;
            while ((read = await Request.Body.ReadAsync(buffer).ConfigureAwait(false)) > 0)
            {
                if (ms.Length + read > MaxDiagBodyBytes)
                {
                    return StatusCode(413); // payload too large
                }

                ms.Write(buffer, 0, read);
            }

            body = ms.ToArray();
        }

        if (body.Length == 0)
        {
            return BadRequest();
        }

        int accepted;
        try
        {
            using var doc = JsonDocument.Parse(body);
            accepted = _diag.Ingest(doc.RootElement, config.DiagMaxRings);
        }
        catch (JsonException)
        {
            return BadRequest();
        }

        Response.Headers.CacheControl = "no-store";
        return Ok(new { ok = true, accepted });
    }

    /// <summary>
    /// JELA-62: current server config fingerprint for the plugin settings
    /// page. Admin-only — the anonymous manifest already carries the epoch,
    /// but this view also works while the DisableConfigFingerprint kill
    /// switch is on (the operator can still inspect the hash the manifest is
    /// withholding) and reports the switch state itself.
    /// </summary>
    [HttpGet("fingerprint")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult GetFingerprint()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-store";
        return FingerprintJson(config, _fingerprint.TryGetFingerprint(config));
    }

    /// <summary>
    /// JELA-62: force a full re-hash now (the settings page "Rehash now"
    /// button) — same operation the scheduled ConfigRehashTask runs. Returns
    /// the freshly computed fingerprint.
    /// </summary>
    [HttpPost("fingerprint/rehash")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult PostFingerprintRehash()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-store";
        return FingerprintJson(config, _fingerprint.Rehash(config, HttpContext.RequestAborted));
    }

    private static JsonResult FingerprintJson(PluginConfiguration config, ConfigFingerprint? fingerprint)
        => new(new
        {
            enabled = !config.DisableConfigFingerprint,
            available = fingerprint != null,
            epoch = fingerprint?.Epoch,
            components = fingerprint?.ComponentsDictionary(),
        });

    /// <summary>
    /// JELA-30 (WS-C): read-side view over the aggregated rings — the boot
    /// health of every opted-in fielded TV, readable over HTTP without an sdb
    /// session or power-cycle. Admin-only (device timing data is operator
    /// telemetry), unlike the anonymous ingest.
    /// </summary>
    [HttpGet("diag/report")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult GetDiagReport()
    {
        Response.Headers.CacheControl = "no-store";
        return new JsonResult(_diag.BuildReport());
    }
}
