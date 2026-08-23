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
        => ContentAddressed(_drop.ShellBytes, _drop.ShellGzipBytes, _drop.ShellSha256);

    /// <summary>
    /// JELA-67: JellyPlug Lite canvas home. Anonymous like the other TV-facing
    /// assets — a TV fetches it pre-login exactly as it fetches shell.min.js;
    /// whether it RUNS is gated on-device (jellyfin.shell.liteEnabled, default
    /// OFF). TVs cache-bust with ?v=&lt;manifest liteSha256&gt;.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("lite.min.js")]
    public IActionResult GetLite()
        => ContentAddressed(_drop.LiteBytes, _drop.LiteGzipBytes, _drop.LiteSha256);

    /// <summary>
    /// The vendored slim Babel. Note this one is fetched at a BARE url by both
    /// shells (`S+"/shell/babel.min.js"` in shell.js and boot-shell.src.js), so
    /// in practice it takes the revalidate branch of
    /// <see cref="ContentAddressed"/> — see the note there on why that matters.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("babel.min.js")]
    public IActionResult GetBabel()
        => ContentAddressed(_drop.BabelBytes, _drop.BabelGzipBytes, _drop.BabelSha256);

    /// <summary>
    /// JELA-689: serve a /shell/ JS body under the cache policy its URL has
    /// actually earned, plus an ETag either way.
    ///
    /// A request that carries the CURRENT sha as ?v= is content-addressed:
    /// those bytes can never change, because a new shell means a new sha means
    /// a new URL (the TV reads the sha from the always-no-cache manifest.json,
    /// which is the whole point of the split). That earns the same year-long
    /// `immutable` tx/{hash}.js already gets. The old blanket
    /// `max-age=60, must-revalidate` meant every real boot — anything more than
    /// a minute after the last — had to round-trip before it could reuse bytes
    /// it already had.
    ///
    /// Everything else keeps the short TTL, and that branch is load-bearing,
    /// not a leftover:
    ///   * babel.min.js is fetched at a BARE url by both shells. Fielded WGTs
    ///     hardcode their fetches and can never be updated, so pinning a bare
    ///     url `immutable` for a year would strand the whole fleet on a stale
    ///     transpiler with no way to bust it.
    ///   * the bootstrap's manifest-failure path deliberately busts with
    ///     ?t=&lt;now&gt; — that URL is unique per boot and must not be pinned.
    ///   * a STALE ?v= (a TV still holding an older manifest) is not addressing
    ///     the bytes we are about to hand back, so calling them immutable under
    ///     that URL would be a lie that outlives the mistake by a year.
    ///
    /// The ETag is unconditional, so even the short-TTL branch now answers a
    /// revalidation with a ~200-byte 304 instead of re-sending 190 KB the TV
    /// already has — which is most of the win for babel.min.js specifically.
    ///
    /// JELA-688: the body also goes out gzipped when the client asks for it.
    /// Jellyfin runs no response compression across plugin routes — a plugin
    /// that wants it does it itself (JavaScriptInjector on the same server is
    /// the precedent) — so these three shipped raw: 190 KB shell + 34 KB lite
    /// on every warm boot, 2.0 MB babel on a cold one. gzip takes that to
    /// −72%/−66%/−77%.
    ///
    /// Serving compressed is strictly on the CLIENT's terms. A request with no
    /// Accept-Encoding, or one that rules gzip out, gets the identical raw
    /// bytes it got before: an M63 TV must never be handed a body it cannot
    /// inflate, and this route is where a stranded TV has no second chance.
    /// The bytes the TV ultimately executes are unchanged either way, so the
    /// manifest sha256 and the ?v= match above stay correct — the sha is of the
    /// RAW asset and is never derived from what went over the wire.
    ///
    /// The two representations carry DIFFERENT ETags (`"&lt;sha&gt;"` vs
    /// `"&lt;sha&gt;-gzip"`) because an entity tag identifies a representation,
    /// not a resource; Vary: Accept-Encoding is set on both — including the
    /// uncompressed one — so an intermediary can never hand a cached gzip body
    /// to a client that asked for identity.
    ///
    /// JELA-687: `Origin` is in Vary for a different and sharper reason. M63
    /// (Chrome 63) does not partition its HTTP cache by request mode, so a
    /// cache entry populated by a no-cors `&lt;script src&gt;` load can be
    /// handed to a later CORS `fetch()` of the SAME url — and that entry
    /// carries no CORS approval, so the fetch fails with "No
    /// 'Access-Control-Allow-Origin' header is present" even though this route
    /// always sends `*`. Both shells do exactly that sequence on the hosted
    /// shell.min.js: script-tag on the cold path, fetch() on the warm one.
    ///
    /// That collision predates JELA-689 and used to self-heal — under the old
    /// blanket `max-age=60` the poisoned entry went stale and the next fetch
    /// revalidated. Measured on the rig against production: with
    /// `max-age=60` the fetch fails at t+2 s and SUCCEEDS at t+75 s; with
    /// `immutable` it fails at both. So `immutable` did not create the bug, it
    /// removed the only thing that was clearing it — and pinned it for a year.
    ///
    /// A script tag sends no `Origin`; a fetch sends one. Varying on it gives
    /// the two request modes separate cache slots, so the CORS fetch misses the
    /// no-cors entry and goes to the network, where it gets its `*`. This keeps
    /// JELA-689's immutable win instead of trading it away for the old TTL.
    /// </summary>
    private IActionResult ContentAddressed(byte[] bytes, byte[]? gzip, string sha256)
    {
        var addressed = string.Equals(Request.Query["v"].ToString(), sha256, StringComparison.Ordinal);
        Response.Headers.CacheControl = addressed
            ? "public, max-age=31536000, immutable"
            : "public, max-age=60, must-revalidate";
        Response.Headers.Vary = HeaderNames.AcceptEncoding + ", " + HeaderNames.Origin;

        if (gzip != null && AcceptsGzip(Request.Headers.AcceptEncoding))
        {
            Response.Headers.ContentEncoding = "gzip";
            return Tagged(gzip, sha256 + "-gzip");
        }

        return Tagged(bytes, sha256);
    }

    // Strong ETag — the sha256 IS a hash of the exact bytes below. Passing it
    // to File() is what makes MVC honour If-None-Match and answer 304; setting
    // the header by hand would not. It has to be the 5-arg overload: the 3-arg
    // call binds to `bool enableRangeProcessing` and silently drops the tag.
    private FileContentResult Tagged(byte[] body, string tag)
        => File(
            body,
            "application/javascript",
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
