using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// Lockstep constants shared with the TV shells and the offline builder
/// (packages/server-shell-drop/scripts/build-tx-drop.mjs). Guarded against
/// drift by packages/server-plugin/scripts/lockstep.test.cjs — do not edit
/// one side without the other.
/// </summary>
public static class TxDropConstants
{
    /// <summary>
    /// STRICT post-transpile oracle — must equal MODERN_SYNTAX_RE_SRC in
    /// packages/shell-tizen/src/shell.js + boot-shell.src.js (ORACLE_SRC in
    /// build-tx-drop.mjs). A published body matching this would be rejected
    /// (or worse, mis-run) by the device.
    /// </summary>
    public const string OracleSrc =
        "\\?\\.|\\?\\?|\\?\\?=|\\|\\|=|&&=|(^|[^\\w])#[a-zA-Z_$][\\w$]*\\s*[=(]|\\d_\\d|(^|[^\\w$.])\\d+n\\b|catch\\s*\\{|\\{\\s*\\.\\.\\.|\\.\\.\\.[\\w$]+\\s*\\}|async\\s+function\\s*\\*|async\\s*\\*|for\\s+await";

    /// <summary>Broader transpile PRE-check — must equal MODERN_PRECHECK_RE_SRC (JEL-417).</summary>
    public const string PrecheckSrc = OracleSrc + "|,\\s*\\.\\.\\.[\\w$]";

    /// <summary>
    /// Canonical transform-option descriptor — must equal BABEL_OPTS_KEY in
    /// both shells; embedded in tx-manifest.json and checked on-device.
    /// </summary>
    public const string BabelOptsKey =
        "presets:[[env,{targets:{chrome:56},modules:false,loose:true}]];sourceType:script;compact:true;comments:false";

    /// <summary>
    /// Transform options as a JS object literal, evaluated inside the Jint
    /// engine — must stay semantically lockstep with the seed-side
    /// transpile() literal in both shells (assumptions carry the JEL-26 fix).
    /// </summary>
    public const string BabelOptsJs =
        "{ presets: [['env', { targets: { chrome: '56' }, modules: false, loose: true }]],"
        + " assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },"
        + " sourceType: 'script', compact: true, comments: false }";

    // RegexOptions.ECMAScript keeps \d/\w/\s ASCII-only, matching the JS
    // regexes these sources are lockstep with.
    public static readonly Regex OracleRe = new(OracleSrc, RegexOptions.ECMAScript | RegexOptions.Compiled);
    public static readonly Regex PrecheckRe = new(PrecheckSrc, RegexOptions.ECMAScript | RegexOptions.Compiled);

    /// <summary>
    /// Same fnv1a-over-UTF-16-code-units the shells use (txFnv1a / seed
    /// __txFnv), base36-encoded. C# char == JS charCodeAt for every UTF-16
    /// unit, so hashes agree byte-for-byte with the device and the builder.
    /// </summary>
    public static string TxFnv1a(string s)
    {
        unchecked
        {
            uint h = 0x811c9dc5;
            for (int i = 0; i < s.Length; i++)
            {
                h ^= s[i];
                h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24));
            }

            return ToBase36(h);
        }
    }

    private static string ToBase36(uint value)
    {
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (value == 0)
        {
            return "0";
        }

        Span<char> buf = stackalloc char[13];
        int pos = buf.Length;
        while (value > 0)
        {
            buf[--pos] = digits[(int)(value % 36)];
            value /= 36;
        }

        return new string(buf[pos..]);
    }
}
