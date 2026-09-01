using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyPlugShell;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Path (relative to the server root) of the snippet-channel script the
    /// TVs load — the shell's jsiChannelPath() default. The tx rebuild
    /// fetches it as a transform source.
    /// </summary>
    public string JsiChannelPath { get; set; } = "/JavaScriptInjector/public.js";

    /// <summary>
    /// Extra absolute source URLs to pre-lower (newline separated) — e.g. the
    /// TV's recorded jellyfin.shell.pluginUrls entries that are not on the
    /// /web/ index. Empty by default.
    /// </summary>
    public string ExtraSourceUrls { get; set; } = string.Empty;

    /// <summary>
    /// Disable the scheduled in-process tx-drop rebuild entirely. The static
    /// /shell/ assets keep serving; TVs fall back to on-device Babel.
    /// </summary>
    public bool DisableTxRebuild { get; set; }

    /// <summary>Per-source transform timeout, seconds.</summary>
    public int TransformTimeoutSeconds { get; set; } = 600;

    /// <summary>
    /// JELA-865 server-side kill switch for the patched main-bundle drop. With
    /// this set the plugin stops publishing /shell/patched/ and stops
    /// advertising `patchedBundle` in the manifest, which is all a TV needs to
    /// fall straight back to its own fetch+scan+inline path — no shell flag
    /// flip and no TV restart required. Default off: the drop is inert until a
    /// TV opts in with localStorage['jellyfin.shell.patchedDrop']='1', so
    /// shipping it armed costs nothing and saves a second deploy when the
    /// client-side flag flips.
    /// </summary>
    public bool DisablePatchedBundle { get; set; }

    /// <summary>
    /// JELA-186: disable the dynamic-module discovery pass of the tx-drop
    /// rebuild (static sources still rebuild). With the scan off, dynamic
    /// modules drop-MISS and fresh boots lazy-load Babel on the TV instead.
    /// </summary>
    public bool DisableTxDynScan { get; set; }

    /// <summary>
    /// JELA-30 (WS-C): refuse all boot-ring diag beacons at POST /shell/diag.
    /// JELA-827: the TV-side gate is now opt-OUT — the shell posts unless
    /// localStorage["jellyfin.shell.diagBeacon"]==="0" (the "1" was seeded by
    /// the JSI channel, which runs too late to arm a cold boot). This still
    /// defaults false — flip it to have the server reject every beacon
    /// regardless of what a fielded TV is set to.
    /// </summary>
    public bool DisableDiagIngest { get; set; }

    /// <summary>
    /// JELA-58 (JELA-57 WS-1) server-side kill switch: when true,
    /// /shell/manifest.json omits configEpoch/components entirely and serves
    /// the exact legacy bytes — every TV falls back to today's revalidation
    /// behavior regardless of what it opted into. Default false: the fields
    /// are additive and old TVs ignore them, so serving them is always safe;
    /// rollout gating lives on the TV (JELA-59).
    /// </summary>
    public bool DisableConfigFingerprint { get; set; }

    /// <summary>
    /// JELA-58: newline-separated case-insensitive glob patterns selecting
    /// which injector-style plugins feed the `scripts` fingerprint group.
    /// Matched against file names in the plugin-configurations dir and
    /// folder names in the plugins dir. Defaults cover the fielded stack
    /// (JS-Injector snippets/config + JellyfinEnhanced user-script plugin).
    /// </summary>
    public string ScriptFingerprintPatterns { get; set; } = "*injector*\n*enhanced*";

    /// <summary>
    /// JELA-58: newline-separated extra absolute files/directories to fold
    /// into the `scripts` fingerprint group — e.g. an on-disk user-script a
    /// snippet loads that no pattern above covers. Empty by default.
    /// </summary>
    public string ExtraFingerprintPaths { get; set; } = string.Empty;

    /// <summary>
    /// JELA-139: newline-separated XML element names stripped from
    /// plugin-config XMLs before they feed the `scripts` fingerprint group.
    /// These are runtime cache-clear signals the plugins' own client scripts
    /// poll from config — they never change the bytes a TV downloads at boot,
    /// but they rewrite on their own (JellyfinEnhanced bumps them without any
    /// operator config change), so hashing them churns configEpoch and every
    /// churn is one unnecessary resume reload on every TV. Defaults cover the
    /// fielded JellyfinEnhanced volatile keys (2026-07 audit of the live
    /// config found exactly these two; JS-Injector has none).
    /// </summary>
    public string VolatileScriptConfigKeys { get; set; } = "ClearTranslationCacheTimestamp\nClearLocalStorageTimestamp";

    /// <summary>
    /// JELA-30: cap on retained boot-ring records in the diag store
    /// (diag/rings.ndjson under the server data dir). Oldest rings are pruned
    /// once the store grows past this, bounding disk and a hostile TV's ability
    /// to inflate the file.
    /// </summary>
    public int DiagMaxRings { get; set; } = 5000;

    /// <summary>
    /// JELA-732: TTL, in seconds, of the private per-credential cache over
    /// /HomeScreen/Section/{name} (the Home Screen Sections row CONTENTS,
    /// which ship with no Cache-Control and no ETag and cost 1.4-2.2 s of
    /// server query CPU per home load). Drives both the server-side memo and
    /// the Cache-Control max-age handed to the TV. 0 disables the cache
    /// entirely, same as DisableHomeScreenSectionCache.
    ///
    /// 30 s is the freshness ceiling that needs no invalidation hook:
    /// ContinueWatchingNextUp is the one row where a stale answer is visible
    /// (resume position), and it self-corrects inside one TTL. Raising this
    /// past ~30 s wants a real "watched" invalidator first.
    /// </summary>
    public int HomeScreenSectionCacheSeconds { get; set; } = 30;

    /// <summary>
    /// JELA-732 kill switch: pass every /HomeScreen/Section/{name} request
    /// straight through, stamping no headers and storing nothing. Read per
    /// request, so flipping it takes effect without a restart.
    /// </summary>
    public bool DisableHomeScreenSectionCache { get; set; }

    /// <summary>
    /// JELA-732 half-kill: keep the server-side memo but stop TVs holding the
    /// body in their own HTTP cache (Cache-Control becomes private, no-cache,
    /// so a repeat still costs a request but is answered by a 304 off the
    /// body-hash ETag). The rollback for client-side staleness that a server
    /// restart cannot clear.
    /// </summary>
    public bool HomeScreenSectionCacheServerOnly { get; set; }

    /// <summary>
    /// JELA-141 (C5/WS-5): fleet default for the Lite canvas home. When any
    /// Lite*DefaultOn flag is true, /shell/manifest.json carries an additive
    /// `flagDefaults` map ({"jellyfin.shell.liteEnabled":"1", ...}); shells
    /// with NO explicit device-local value for a key adopt the served default
    /// one boot later (stale-one-boot, same contract as the Lite byte cache).
    /// An explicit device-local "1"/"0" always wins, so QA opt-ins and
    /// per-device kills survive fleet flips. Turning a flag back off here (or
    /// rolling the plugin back to a version without the field — absent field
    /// clears the TVs' cached defaults) is the fleet kill switch: TVs revert
    /// on their next manifest read + boot. All three false = the field is
    /// omitted and the manifest stays byte-identical to pre-JELA-141.
    /// </summary>
    public bool LiteDefaultOn { get; set; }

    /// <summary>
    /// JELA-141: fleet default for jellyfin.lite.native (AVPlay native
    /// playback fork). Meaningful only alongside LiteDefaultOn — see its
    /// remarks for the adoption/kill contract.
    /// </summary>
    public bool LiteNativeDefaultOn { get; set; }

    /// <summary>
    /// JELA-141/JELA-152: fleet default for jellyfin.lite.subs (Lite-side
    /// External-srt cue engine). Stays false for the C5 rollout — the flip
    /// rides the JELA-152 real-panel gate. Same contract as LiteDefaultOn.
    /// </summary>
    public bool LiteSubsDefaultOn { get; set; }

    /// <summary>
    /// JELA-731 kill switch: stop answering
    /// <c>GET /HomeScreen/Section/LatestShows</c> from the one-query fast path and
    /// let Home Screen Sections' own 30-day window walk serve it again. Default
    /// false (fast path on). The fast path already steps aside on its own whenever
    /// it cannot reproduce the upstream row; this is the operator's override for
    /// the case where it can, but should not — a row that looks wrong on a TV, or
    /// an upstream release that changes what the section means.
    /// </summary>
    public bool DisableLatestShowsFastPath { get; set; }

    /// JELA-709 kill switch: stop appending Access-Control-Max-Age to
    /// approved CORS preflight responses. Default false (header on): the
    /// header only lets a browser reuse a preflight verdict it already got,
    /// for at most 600 s, and the filter never overwrites a max-age some
    /// other layer set. Read per-response — flipping it needs no restart.
    /// </summary>
    public bool DisableCorsPreflightMaxAge { get; set; }

    /// <summary>
    /// JELA-793: seconds between background library-warm passes, or 0 (the
    /// default) to leave the warmer off entirely — the field is both the
    /// enable and the kill switch, read on a 10 s tick, so changing it takes
    /// effect without a restart.
    ///
    /// A box that has been idle answers its first /HomeScreen/Section/* request
    /// 10-25x slower than its own warm median, and the penalty is in the shared
    /// library-query path rather than in any one section: a trivial
    /// /Items?Limit=1 control pays it too, while /System/Info stays at its
    /// 1.5 ms floor. So every home row on the first TV boot after a quiet
    /// stretch pays at once, and the JELA-732 section cache cannot help — its
    /// TTL is 30 s, so a first boot is always a miss.
    ///
    /// A pass rebuilds ONE home row for ONE user, which measured is enough to
    /// carry all four rows and the whole household (~0.5% of one core at 30 s).
    /// The cheaper thing this originally did — user-less item scans — is a
    /// measured null; see SectionWarmService.
    ///
    /// The interval has to be short. Walking the quiet interval up on
    /// production, against each checkpoint's own in-window warm reference:
    /// 30 s of idle costs nothing, 60 s costs 2.6x, 5 min costs 7.6x. This
    /// decays in about a minute, not in the "hours" the symptom was first
    /// reported over. An interval longer than the decay time buys nothing at
    /// all, which is the one way to get this wrong that still looks enabled —
    /// hence 30, and hence the number being an operator-visible field rather
    /// than a constant.
    /// </summary>
    public int SectionWarmIntervalSeconds { get; set; }

    /// <summary>
    /// JELA-798: also build the Latest Movies row on each warm pass. Default
    /// false, and it does nothing at all unless
    /// <see cref="SectionWarmIntervalSeconds"/> is non-zero. Read per pass, so
    /// it is its own kill switch and needs no restart.
    ///
    /// JELA-793 shipped on the finding that "warming one section carries the
    /// other three". Re-measured on production 2026-08-28, that does not
    /// replicate: with the warmer on and healthy, LatestShows comes in at
    /// 0.8-1.6x its own warm median while LatestMovies sits at 4-13x. The
    /// carry is partial, not whole.
    ///
    /// The cheap suspect was the user rotation — one user per pass over 11
    /// users at 30 s means a boot lands 0-330 s into that user's staleness —
    /// and it is not the cause. Dropping the interval to 10 s (a 110 s lap,
    /// every user fresh) left LatestMovies at 4.25x. It cannot be the cause,
    /// because a user-less <c>/Items?IncludeItemTypes=Movie&amp;Limit=1</c>
    /// control probe carries no user for the rotation to reach and was cold in
    /// the same burst at 9.6 s against a 7.9 ms warm median.
    ///
    /// So the residual is per-SECTION, not per-user: the pass does the episode
    /// item/DTO/image work and nothing ever does the movie equivalent. Hence a
    /// second row rather than a faster rotation. It is the row build and not
    /// the query that matters — JELA-793 measured the user-less movie scan
    /// (which this warmer still runs on its fallback path) as worth ~0%, a
    /// user-scoped scan as ~40%, and the full row build as ~100%.
    /// </summary>
    public bool SectionWarmMovieRow { get; set; }

    /// <summary>
    /// JELA-723 kill switch: stop stamping Cache-Control/Vary on the three
    /// third-party plugin client scripts (/NotifySync/client.js,
    /// /GetAvatar/ClientScript, /PluginPages/inject.js). Read per-response, so
    /// flipping it takes effect without a restart and each plugin's own
    /// headers come back exactly as it sent them.
    /// </summary>
    public bool DisablePluginScriptCacheHeaders { get; set; }
}
