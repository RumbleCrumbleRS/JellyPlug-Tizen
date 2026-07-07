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

    private readonly ShellDropService _drop;

    public ShellController(ShellDropService drop)
    {
        _drop = drop;
    }

    [HttpGet("manifest.json")]
    public IActionResult GetManifest()
    {
        Response.Headers.CacheControl = "no-cache";
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
}
