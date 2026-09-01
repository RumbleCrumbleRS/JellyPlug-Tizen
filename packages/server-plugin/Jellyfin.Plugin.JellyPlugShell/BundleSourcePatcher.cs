using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>Patch outcome: the rewritten source plus the number of sites hit.</summary>
public record BundlePatchResult(string Source, int Patches, bool NeedleFound);

/// <summary>
/// JELA-865. Server-side port of the shells' <c>buildBundleSourcePatcher()</c>
/// (JEL-436 v24/v25) — the CM/PM <c>getApiClient</c> repair that rewrites
/// <c>function(e){if(!e)throw new Error("item or serverId cannot be null")</c>
/// into a form that falls back to <c>window.ApiClient</c> before throwing.
///
/// The TVs have always applied this themselves, at boot, by fetching
/// main.jellyfin.bundle.js, regex-scanning it and INLINING the patched body
/// into the markup they document.write. JELA-863 priced what inlining costs on
/// a Tizen 5.0 panel: Blink will not stream a script it did not load itself, so
/// ~500 KB that the DIRECT arm parsed for 162–174 ms on the ScriptStreamerThread
/// instead became ~194 ms of main-thread <c>V8.CompileCode</c> nested under a
/// re-entrant ParseHTML, pre-paint. Doing the identical rewrite here once, and
/// handing the TV a URL, gives the bytes back to the streamer.
///
/// Lockstep with packages/shell-tizen/src/shell.js is enforced by
/// packages/server-plugin/scripts/bundle-patch-lockstep.test.cjs, which rebuilds
/// these patterns as JavaScript RegExps and requires the output over a fixture to
/// be byte-identical to what the shell's own patcher produces. Do not edit one
/// side without the other.
/// </summary>
public static class BundleSourcePatcher
{
    /// <summary>
    /// The verbatim throw text. Minification preserves string literals, so this
    /// is the locator; its absence means the bundle needs no patch at all
    /// (the shells' <c>needsPatch=false</c> verdict).
    /// </summary>
    public const string Needle = "item or serverId cannot be null";

    /// <summary>
    /// Replacement body, with <see cref="ParamToken"/> standing in for the
    /// matched parameter name. A token (rather than composite formatting) keeps
    /// the template a literal transcription of the shell's concatenation — the
    /// body is full of braces, and escaping them for string.Format would be the
    /// exact kind of silent drift the lockstep test exists to catch.
    /// </summary>
    public const string ParamToken = "%P%";

    /// <summary>Transcription of the shell's replacement concatenation.</summary>
    public const string ReplacementTemplate =
        "try{"
        + "if(" + ParamToken + "==null&&window.ApiClient)return window.ApiClient;"
        + "if(" + ParamToken + "&&typeof " + ParamToken + "===\"object\"&&!" + ParamToken
        + ".ServerId&&window.ApiClient&&typeof window.ApiClient.serverId===\"function\")"
        + ParamToken + ".ServerId=window.ApiClient.serverId();"
        + "}catch(_){}"
        + "if(!" + ParamToken + ")throw new Error(\"item or serverId cannot be null\")";

    /// <summary>
    /// The shells' four patterns, in the shells' order: single-check function,
    /// single-check arrow, then the two legacy <c>!X||!X.ServerId</c> shapes.
    /// ECMAScript mode so <c>\w</c>/<c>\s</c>/<c>\d</c> carry JavaScript
    /// semantics rather than .NET's Unicode-aware ones.
    /// </summary>
    public static readonly string[] PatternSources =
    {
        @"(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['""])item or serverId cannot be null\3\s*\)",
        @"(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['""])item or serverId cannot be null\3\s*\)",
        @"(\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['""])item or serverId cannot be null\3\s*\)",
        @"(\(\s*(\w+)\s*\)\s*=>\s*\{\s*)if\s*\(\s*!\s*\2\s*\|\|\s*!\s*\2\s*\.\s*ServerId\s*\)\s*(?:\{\s*)?throw\s+(?:new\s+)?Error\s*\(\s*(['""])item or serverId cannot be null\3\s*\)",
    };

    private static readonly Regex[] Patterns = BuildPatterns();

    /// <summary>
    /// Applies every pattern in order, exactly as the shell does. Returns the
    /// rewritten source and the total number of rewritten sites; a source with
    /// no <see cref="Needle"/> comes back unchanged with 0 patches.
    /// </summary>
    public static BundlePatchResult Patch(string source)
    {
        source ??= string.Empty;
        var needle = source.Contains(Needle, StringComparison.Ordinal);
        if (!needle)
        {
            return new BundlePatchResult(source, 0, false);
        }

        var total = 0;
        var current = source;
        foreach (var pattern in Patterns)
        {
            current = pattern.Replace(
                current,
                m =>
                {
                    total++;
                    return m.Groups[1].Value + ReplacementTemplate.Replace(ParamToken, m.Groups[2].Value, StringComparison.Ordinal);
                });
        }

        return new BundlePatchResult(current, total, true);
    }

    private static Regex[] BuildPatterns()
    {
        var built = new Regex[PatternSources.Length];
        for (var i = 0; i < PatternSources.Length; i++)
        {
            built[i] = new Regex(PatternSources[i], RegexOptions.ECMAScript | RegexOptions.Compiled);
        }

        return built;
    }
}
