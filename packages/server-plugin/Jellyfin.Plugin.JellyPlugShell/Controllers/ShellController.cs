using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyPlugShell.Controllers;

/// <summary>
/// Root-level /shell/ routes for the Hosted Shell Bootstrap. Root-level (not
/// /Plugins/...) because every fielded bootstrap WGT hardcodes
/// ${server}/shell/ — precedent for plugin root routes on 10.11:
/// JellyfinEnhanced, PluginPages. Anonymous by design: the TV fetches these
/// before any login, exactly like /web/ statics.
/// </summary>
[ApiController]
[AllowAnonymous]
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
    /// the fingerprint is unavailable, in which case the legacy static bytes
    /// are served verbatim (today's behavior, both compat directions free).
    /// </summary>
    [HttpGet("manifest.json")]
    public IActionResult GetManifest()
    {
        Response.Headers.CacheControl = "no-cache";

        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (!config.DisableConfigFingerprint)
        {
            var fingerprint = _fingerprint.TryGetFingerprint(config);
            if (fingerprint != null)
            {
                return File(_drop.BuildManifestJson(fingerprint), "application/json");
            }
        }

        return File(_drop.ManifestJson, "application/json");
    }

    [HttpGet("shell.min.js")]
    public IActionResult GetShell()
    {
        // TVs cache-bust with ?v=<sha256>, so a short server TTL is enough
        // (matches the README nginx snippet).
        Response.Headers.CacheControl = "public, max-age=60, must-revalidate";
        return File(_drop.ShellBytes, "application/javascript");
    }

    [HttpGet("babel.min.js")]
    public IActionResult GetBabel()
    {
        Response.Headers.CacheControl = "public, max-age=60, must-revalidate";
        return File(_drop.BabelBytes, "application/javascript");
    }

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
