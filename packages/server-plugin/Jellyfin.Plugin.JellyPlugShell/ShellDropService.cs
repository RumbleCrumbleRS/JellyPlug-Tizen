using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Holds the embedded /shell/ assets plus the derived manifest.json, and owns
/// the on-disk tx-drop directory the scheduled rebuild publishes into. The
/// drop lives under the server data dir (not the plugin folder) so it
/// survives plugin updates.
/// </summary>
public class ShellDropService
{
    private const string MinBootstrapVersion = "2.0.0";

    public ShellDropService(IApplicationPaths appPaths)
    {
        ShellBytes = ReadResource("JellyPlugShell.Resources.shell.min.js");
        BabelBytes = ReadResource("JellyPlugShell.Resources.babel.min.js");
        BabelTransformSource = Encoding.UTF8.GetString(
            ReadResource("JellyPlugShell.Resources.babel-transform.min.js"));

        ShellSha256 = Sha256Hex(ShellBytes);
        BabelSha256 = Sha256Hex(BabelBytes);
        var shellVersion = ExtractShellVersion(Encoding.UTF8.GetString(ShellBytes));

        _baseManifest = new Dictionary<string, object?>
        {
            ["version"] = shellVersion,
            ["sha256"] = ShellSha256,
            ["shellUrl"] = null,
            ["babelSha256"] = BabelSha256,
            ["minBootstrapVersion"] = MinBootstrapVersion,
            ["bootstrapWgt"] = null,
        };
        ManifestJson = JsonSerializer.SerializeToUtf8Bytes(_baseManifest);

        DropDir = Path.Combine(appPaths.DataPath, "jellyplug-shell");
        TxDir = Path.Combine(DropDir, "tx");
        TxManifestPath = Path.Combine(DropDir, "tx-manifest.json");
    }

    private readonly Dictionary<string, object?> _baseManifest;

    public byte[] ShellBytes { get; }

    public byte[] BabelBytes { get; }

    public string ShellSha256 { get; }

    public string BabelSha256 { get; }

    /// <summary>
    /// Legacy manifest.json body (emit_manifest.py schema) — the exact bytes
    /// served before JELA-58, still served verbatim when the config
    /// fingerprint is disabled or unavailable.
    /// </summary>
    public byte[] ManifestJson { get; }

    /// <summary>
    /// JELA-58: manifest.json with the ADDITIVE config-fingerprint fields
    /// appended after the legacy keys — `configEpoch` plus per-group
    /// `components`. Old TVs JSON.parse and ignore the extras; nothing in the
    /// legacy schema changes shape or value.
    /// </summary>
    public byte[] BuildManifestJson(ConfigFingerprint fingerprint)
    {
        var manifest = new Dictionary<string, object?>(_baseManifest)
        {
            ["configEpoch"] = fingerprint.Epoch,
            ["components"] = new Dictionary<string, string>
            {
                ["web"] = fingerprint.Web,
                ["shell"] = fingerprint.Shell,
                ["scripts"] = fingerprint.Scripts,
                ["branding"] = fingerprint.Branding,
            },
        };
        return JsonSerializer.SerializeToUtf8Bytes(manifest);
    }

    /// <summary>The official @babel/standalone UMD source used for server-side transforms.</summary>
    public string BabelTransformSource { get; }

    public string DropDir { get; }

    public string TxDir { get; }

    public string TxManifestPath { get; }

    private static byte[] ReadResource(string logicalName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"missing embedded resource {logicalName}");
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string Sha256Hex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// Mirrors emit_manifest.py extract_shell_version(): scan the head bytes
    /// for the inlined shell version. The current min build carries it as
    /// ver:"1.0.75" in the boot-phase record; the python patterns are kept as
    /// fallbacks.
    /// </summary>
    private static string ExtractShellVersion(string shellText)
    {
        var head = shellText.Length > 8192 ? shellText[..8192] : shellText;
        foreach (var pattern in new[]
        {
            "[^\\w]ver\\s*[:=]\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
            "shellVer\\s*[:=]\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
            "\"version\"\\s*:\\s*\"([0-9][0-9A-Za-z.\\-]*)\"",
        })
        {
            var m = Regex.Match(head, pattern, RegexOptions.ECMAScript);
            if (m.Success)
            {
                return m.Groups[1].Value;
            }
        }

        return "unknown";
    }
}
