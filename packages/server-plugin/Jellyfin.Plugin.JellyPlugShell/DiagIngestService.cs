using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-30 (WS-C/C3): ingest + aggregate the opt-in per-boot diag beacons a
/// fielded TV posts to <c>POST /shell/diag</c> — the self-reporting boot-ring
/// channel that replaces flaky manual sdb/CDP sessions for reading on-device
/// boot health (the recurring cost across JELA-13/21/26/27).
///
/// **Redaction is by construction (the WS-F egress audit, folded in here).**
/// The ingest NEVER trusts the shape of the posted JSON: it copies a fixed
/// whitelist of fields into a fresh record, coercing every timing/counter to a
/// finite number and EXTRACTING the two string fields (opaque device id, shell
/// version) against strict shapes rather than merely stripping characters —
/// stripping is not enough, because "https://home.example.org" strips to a
/// dotted hostname that still leaks. The id keeps only the longest [0-9a-z]
/// run; the ver keeps only a leading dotted-numeric version. A URL, access
/// token, server hostname, or any other free-form string simply has nowhere
/// to land — a value where a number is expected is dropped, and a string not
/// shaped like an opaque hash / version collapses to its one plausible token
/// or to nothing at all. So no raw server URL or account/PII can reach disk
/// even if a hostile or buggy TV posts one.
///
/// The store lives under the server data dir (survives plugin updates, like
/// the tx-drop) and is bounded to <see cref="PluginConfiguration.DiagMaxRings"/>
/// lines so a misbehaving device cannot grow it without bound.
/// </summary>
public class DiagIngestService
{
    // A boot POST carries at most the shell's 10-entry ring; cap generously.
    private const int MaxRingsPerPost = 20;
    private const int MaxIdLen = 24;
    private const int MaxVerLen = 24;

    // Opaque device id: the shell posts an fnv1a-base36 hash, never the raw
    // Tizen DUID/serial — so a single [0-9a-z] run is the entire legal shape.
    // Sanitizing EXTRACTS the longest such run: mixed junk (a serial, an
    // email, a URL) collapses to its one plausible opaque token or to nothing.
    private static readonly Regex IdRun = new("[0-9a-z]+", RegexOptions.Compiled);

    // Version strings are dotted numerics with an optional alphanumeric
    // -suffix ("1.0.75", "2.0.18-rc1"), matched from the START of the string.
    // A URL/hostname/token has no leading digit, so it yields nothing at all
    // (a character-class strip would have left a dotted hostname behind).
    private static readonly Regex VerMatch = new("^[0-9]+(\\.[0-9]+)*(-[0-9A-Za-z]+)?", RegexOptions.Compiled);

    // Per-boot ring record: every field is a wall-clock ms delta from boot
    // (JEL-617) except the version string. Whitelisted explicitly — the raw
    // record is never spread.
    private static readonly string[] RingNumFields =
    {
        "ts", "nav", "connect", "dcl", "api", "login", "home", "card", "snap",
    };

    private static readonly object Gate = new();

    private readonly ShellDropService _drop;

    public DiagIngestService(ShellDropService drop)
    {
        _drop = drop;
    }

    /// <summary>Directory holding the diag store (under the server data dir).</summary>
    public string DiagDir => Path.Combine(_drop.DropDir, "diag");

    /// <summary>Newline-delimited JSON store, one sanitized ring per line.</summary>
    public string RingsPath => Path.Combine(DiagDir, "rings.ndjson");

    /// <summary>
    /// Sanitize a posted beacon and append its rings to the store. Returns the
    /// number of ring records accepted (0 = nothing usable in the payload).
    /// </summary>
    public int Ingest(JsonElement root, int maxRings)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return 0;
        }

        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String
            ? SanitizeId(idEl.GetString())
            : string.Empty;
        if (id.Length == 0)
        {
            return 0; // no opaque key -> not attributable, drop
        }

        var topVer = root.TryGetProperty("ver", out var verEl) && verEl.ValueKind == JsonValueKind.String
            ? SanitizeVer(verEl.GetString())
            : string.Empty;

        var tx = root.TryGetProperty("tx", out var txEl) ? CleanTx(txEl) : null;

        if (!root.TryGetProperty("ring", out var ringEl) || ringEl.ValueKind != JsonValueKind.Array)
        {
            return 0;
        }

        var received = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var lines = new List<string>();
        foreach (var recEl in ringEl.EnumerateArray())
        {
            if (lines.Count >= MaxRingsPerPost)
            {
                break;
            }

            var rec = CleanRing(recEl);
            if (rec is null)
            {
                continue;
            }

            var line = new Dictionary<string, object?>
            {
                ["id"] = id,
                ["rcv"] = received,
                ["ring"] = rec,
            };
            if (topVer.Length > 0)
            {
                line["ver"] = topVer;
            }

            if (tx is not null)
            {
                line["tx"] = tx;
            }

            lines.Add(JsonSerializer.Serialize(line));
        }

        if (lines.Count == 0)
        {
            return 0;
        }

        Append(lines, maxRings);
        return lines.Count;
    }

    /// <summary>
    /// Aggregate the store into a compact read-side report: per opaque device
    /// the most-complete recent ring plus a fleet-wide median for each phase.
    /// This is the "boot ring readable off a fielded TV without an sdb session"
    /// deliverable — an admin reads it over HTTP.
    /// </summary>
    public DiagReport BuildReport()
    {
        var report = new DiagReport();
        List<string> raw;
        lock (Gate)
        {
            if (!File.Exists(RingsPath))
            {
                return report;
            }

            raw = new List<string>(File.ReadAllLines(RingsPath));
        }

        // Dedupe by (device id, boot ts): a TV re-posts its whole ring every
        // boot, so the same boot arrives repeatedly. Keep the most-complete
        // copy (a cold boot's first post can lack home/card; the next boot
        // re-sends it filled in), tie-broken by latest receive time.
        var best = new Dictionary<string, (JsonElement Line, int Fields, long Rcv)>();
        foreach (var text in raw)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            JsonElement line;
            try
            {
                line = JsonDocument.Parse(text).RootElement.Clone();
            }
            catch (JsonException)
            {
                continue;
            }

            if (!line.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String ||
                !line.TryGetProperty("ring", out var ringEl) || ringEl.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var ts = ringEl.TryGetProperty("ts", out var tsEl) && tsEl.ValueKind == JsonValueKind.Number
                ? tsEl.GetRawText()
                : "0";
            var key = idEl.GetString() + "|" + ts;
            var fields = ringEl.EnumerateObject().Count();
            var rcv = line.TryGetProperty("rcv", out var rcvEl) && rcvEl.ValueKind == JsonValueKind.Number
                ? rcvEl.GetInt64()
                : 0;

            if (!best.TryGetValue(key, out var cur) || fields > cur.Fields ||
                (fields == cur.Fields && rcv >= cur.Rcv))
            {
                best[key] = (line, fields, rcv);
            }
        }

        var byDevice = new Dictionary<string, (JsonElement Line, long Ts, long Rcv)>();
        var phaseSamples = new Dictionary<string, List<double>>();
        foreach (var (line, _, rcv) in best.Values)
        {
            report.TotalRings++;
            var idEl = line.GetProperty("id");
            var ringEl = line.GetProperty("ring");
            var id = idEl.GetString() ?? string.Empty;
            var ts = ringEl.TryGetProperty("ts", out var tsEl) && tsEl.ValueKind == JsonValueKind.Number
                ? tsEl.GetInt64()
                : 0;

            // Latest boot per device (highest ts) drives the per-device view.
            if (!byDevice.TryGetValue(id, out var prev) || ts > prev.Ts)
            {
                byDevice[id] = (line, ts, rcv);
            }

            foreach (var prop in ringEl.EnumerateObject())
            {
                if (prop.Name == "ts" || prop.Name == "nav" || prop.Name == "ver" ||
                    prop.Value.ValueKind != JsonValueKind.Number)
                {
                    continue;
                }

                if (!phaseSamples.TryGetValue(prop.Name, out var list))
                {
                    list = new List<double>();
                    phaseSamples[prop.Name] = list;
                }

                list.Add(prop.Value.GetDouble());
            }
        }

        report.Devices = byDevice.Count;
        foreach (var (id, (line, ts, rcv)) in byDevice)
        {
            report.LatestPerDevice.Add(new DiagDeviceEntry
            {
                Id = id,
                Ts = ts,
                Rcv = rcv,
                Ver = line.TryGetProperty("ver", out var v) && v.ValueKind == JsonValueKind.String
                    ? v.GetString()
                    : null,
                Ring = line.GetProperty("ring").Clone(),
                Tx = line.TryGetProperty("tx", out var t) ? t.Clone() : null,
            });
        }

        foreach (var (phase, samples) in phaseSamples)
        {
            report.PhaseMedianMs[phase] = Median(samples);
        }

        return report;
    }

    private static string SanitizeId(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var best = string.Empty;
        foreach (Match m in IdRun.Matches(value))
        {
            if (m.Value.Length > best.Length)
            {
                best = m.Value;
            }
        }

        return best.Length > MaxIdLen ? best[..MaxIdLen] : best;
    }

    private static string SanitizeVer(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var m = VerMatch.Match(value);
        if (!m.Success || m.Value.Length == 0)
        {
            return string.Empty;
        }

        return m.Value.Length > MaxVerLen ? m.Value[..MaxVerLen] : m.Value;
    }

    private static Dictionary<string, object?>? CleanRing(JsonElement recEl)
    {
        if (recEl.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var rec = new Dictionary<string, object?>();
        foreach (var field in RingNumFields)
        {
            if (recEl.TryGetProperty(field, out var el) && TryNum(el, out var n))
            {
                rec[field] = n;
            }
        }

        if (!rec.ContainsKey("ts"))
        {
            return null; // a ring record with no boot timestamp is useless
        }

        if (recEl.TryGetProperty("ver", out var verEl) && verEl.ValueKind == JsonValueKind.String)
        {
            var ver = SanitizeVer(verEl.GetString());
            if (ver.Length > 0)
            {
                rec["ver"] = ver;
            }
        }

        return rec;
    }

    private static Dictionary<string, object?>? CleanTx(JsonElement txEl)
    {
        if (txEl.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var tx = new Dictionary<string, object?>();
        foreach (var name in new[] { "skip", "done" })
        {
            if (txEl.TryGetProperty(name, out var el) && TryNum(el, out var n))
            {
                tx[name] = n;
            }
        }

        if (txEl.TryGetProperty("drop", out var dropEl) && dropEl.ValueKind == JsonValueKind.Object)
        {
            var drop = new Dictionary<string, object?>();
            foreach (var name in new[] { "ok", "h", "m", "r", "f" })
            {
                if (dropEl.TryGetProperty(name, out var el) && TryNum(el, out var n))
                {
                    drop[name] = n;
                }
            }

            if (drop.Count > 0)
            {
                tx["drop"] = drop;
            }
        }

        return tx.Count > 0 ? tx : null;
    }

    private static bool TryNum(JsonElement el, out double value)
    {
        value = 0;
        if (el.ValueKind != JsonValueKind.Number || !el.TryGetDouble(out var d))
        {
            return false;
        }

        if (double.IsNaN(d) || double.IsInfinity(d))
        {
            return false;
        }

        value = d;
        return true;
    }

    private static double Median(List<double> samples)
    {
        if (samples.Count == 0)
        {
            return 0;
        }

        samples.Sort();
        var mid = samples.Count / 2;
        return samples.Count % 2 == 1
            ? samples[mid]
            : (samples[mid - 1] + samples[mid]) / 2.0;
    }

    private void Append(List<string> lines, int maxRings)
    {
        var cap = maxRings > 0 ? maxRings : 5000;
        lock (Gate)
        {
            Directory.CreateDirectory(DiagDir);
            File.AppendAllLines(RingsPath, lines);

            // Prune with hysteresis so we rewrite the whole file rarely, not on
            // every post. Keep the newest `cap` lines.
            var existing = File.ReadAllLines(RingsPath);
            if (existing.Length > cap + (cap / 5))
            {
                var kept = existing[^cap..];
                var tmp = RingsPath + ".tmp";
                File.WriteAllLines(tmp, kept);
                File.Move(tmp, RingsPath, overwrite: true);
            }
        }
    }
}

/// <summary>Read-side aggregate returned by <c>GET /shell/diag/report</c>.</summary>
public class DiagReport
{
    public int Devices { get; set; }

    public int TotalRings { get; set; }

    public Dictionary<string, double> PhaseMedianMs { get; } = new();

    public List<DiagDeviceEntry> LatestPerDevice { get; } = new();
}

/// <summary>The latest boot ring reported by one opaque device.</summary>
public class DiagDeviceEntry
{
    public string Id { get; set; } = string.Empty;

    public long Ts { get; set; }

    public long Rcv { get; set; }

    public string? Ver { get; set; }

    /// <summary>Sanitized ring JSON (numbers + version only).</summary>
    public JsonElement Ring { get; set; }

    /// <summary>Sanitized tx-counter JSON, or null.</summary>
    public JsonElement? Tx { get; set; }
}
