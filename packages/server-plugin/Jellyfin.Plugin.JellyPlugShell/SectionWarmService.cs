using System;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-793. Keeps the library-query substrate the home rows sit on warm, so the
/// first TV to boot after a quiet stretch does not pay the whole warm-up itself.
///
/// <para><b>The measurement this is built from</b> (production, JELA-692 pre-flight
/// CLEAR, all section probes sent with <c>Cache-Control: no-store</c> so the JELA-732
/// cache is bypassed). The first request after the box has been idle costs 10-25x its
/// own warm median, and it is not a property of any one section — the trivial control
/// query <c>/Items?Limit=1&amp;IncludeItemTypes=Movie</c> pays ~7x alongside it, while
/// <c>/System/Info</c> stays at its 1.5 ms floor throughout. So the cold cost is in the
/// <em>library query path</em>, not in ASP.NET, not in auth, and not in the sections.</para>
///
/// <para><b>And it decays in about a minute, not in hours.</b> The ticket was written
/// from a "quiet for hours" sample, which made this look like a once-a-morning problem.
/// Walking the quiet interval up, each checkpoint read against its own in-window warm
/// reference: <b>30 s of idle costs nothing, 60 s costs 2.6x, 5 min costs 7.6x</b>. That
/// is what sets the cadence: an hourly — or even five-minutely — warmer would miss almost
/// every real boot while looking, from the settings page, exactly like a working one.</para>
///
/// <para><b>What a pass has to do, measured rather than reasoned.</b> The first version of
/// this warmed the cheapest thing that plausibly shared the substrate — two user-less
/// ordered item scans, same rows, same indexes, no user, no DTOs, no images — and it was
/// a clean NULL. Holding the quiet window at 300 s and varying only the treatment applied
/// before a concurrent home fan-out (LatestShows / LatestMovies / ContinueWatchingNextUp /
/// BecauseYouWatched, ms):</para>
///
/// <list type="bullet">
/// <item><description>nothing: 2,199 / 1,528 / 2,317 / 635 — and 1,823 / 1,526 / 1,839 /
/// 560 on a repeat, so the control is stable</description></item>
/// <item><description>2 ordered scans, no user: 2,058 / 1,587 / 2,109 / 581 — <b>nothing
/// moved</b></description></item>
/// <item><description>the same 2 scans with a user: 1,362 / 1,103 / 1,336 / 13 — ~40%,
/// and BecauseYouWatched fully</description></item>
/// <item><description>building the LatestShows row for one user: <b>140 / 141 / 172 /
/// 21</b>, against an in-window warm reference of 146 / 158 / 184 / 16</description></item>
/// </list>
///
/// <para>So the pass builds the row. Warming <b>one</b> user carries the rest of the
/// household — warming as user Test left a fan-out issued as user Matt reading
/// 148 / 124 / 135 / 15 ms — so the per-user part of the cold state is small and one user
/// per pass is enough.</para>
///
/// <para><b>What does not hold is the other half of that claim.</b> This originally also
/// concluded that one warmed section was enough for all four rows. JELA-798 re-measured it on
/// production and it does not replicate: LatestShows goes properly warm (0.8-1.6x its own
/// warm median) while LatestMovies stays at 4-13x and ContinueWatchingNextUp at 6-11x. The
/// carry is partial — they sit below the 8-9x a warmerless box pays — but partial is not
/// warm. The cold state is shared per KIND, not across kinds, and a faster user rotation
/// cannot reach it; see <c>WarmMovieRow</c> for the control probe that proves that and for
/// the opt-in second row (<see cref="PluginConfiguration.SectionWarmMovieRow"/>) that
/// closes the movies half.</para>
///
/// <para><b>Why a plain timer and not an <c>IScheduledTask</c>.</b> This plugin already
/// owns two scheduled tasks, so the task route was the obvious one — and it is the wrong
/// one. The JELA-692 perf pre-flight gate blocks any production measurement while a
/// scheduled task is non-Idle; a warmer firing every 30 s would put a task in Running
/// state a large fraction of the time and randomly block the gate that every performance
/// conclusion in this programme is quoted against. It would also write a task-history row
/// per pass. A timer is invisible to both.</para>
///
/// <para>Off by default (<see cref="PluginConfiguration.SectionWarmIntervalSeconds"/> is
/// 0). It touches nothing a request can see: it reads, builds an in-memory row it then
/// discards, writes no response and stores nothing — the only state it changes is the
/// state a request would have had to build for itself anyway. One row build per pass is
/// ~150 ms, so ~0.5% of one core at 30 s.</para>
/// </summary>
public sealed class SectionWarmService : IDisposable
{
    /// <summary>
    /// How often the timer wakes to consider a pass. Deliberately shorter than any
    /// sensible warm interval: the configured interval is then re-read on every tick, so
    /// an operator changing it (or switching the warmer off) takes effect within one tick
    /// rather than at the next restart — the same "read the config per request" contract
    /// the rest of this plugin's switches keep.
    /// </summary>
    internal static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Rows read per fallback probe. 200 is the page size <c>LatestShowsSection</c> asks
    /// for per window and the first probe size <see cref="LatestShowsFastPath"/> uses.
    /// </summary>
    internal const int ProbeLimit = 200;

    /// <summary>
    /// Cards built per movie library on the JELA-798 movies half. 16 is the row length
    /// the home sections use, and the row length is what decides how many DTOs and how
    /// much image resolution the pass does — which is the work being warmed.
    /// </summary>
    internal const int MovieRowLimit = 16;

    private readonly ILogger<SectionWarmService> _logger;
    private readonly Stopwatch _sinceLastPass = new();

    private IServiceProvider? _services;
    private Timer? _timer;
    private int _started;
    private int _running;
    private long _passes;
    private long _userCursor = -1;
    private bool _loggedFirstPass;
    private bool _loggedFirstError;

    public SectionWarmService(ILogger<SectionWarmService> logger)
    {
        _logger = logger;
    }

    /// <summary>Warm passes completed since startup. Diagnostics only.</summary>
    public long Passes => Interlocked.Read(ref _passes);

    /// <summary>Wall time of the most recent pass, milliseconds. Diagnostics only.</summary>
    public double LastPassMs { get; private set; }

    /// <summary>
    /// Starts the tick timer. Idempotent — <see cref="IStartupFilter"/> instances are
    /// transient and the pipeline may be built more than once in a process.
    /// </summary>
    public void Start(IServiceProvider services)
    {
        if (Interlocked.Exchange(ref _started, 1) == 1)
        {
            return;
        }

        _services = services;

        // Elapsed-since-last-pass rather than a wall-clock timestamp: this is a duration
        // comparison, and Stopwatch does not move when the system clock does (NTP step,
        // DST on a box running local time), which would otherwise either stall the warmer
        // for an hour or make it fire every tick.
        _sinceLastPass.Start();

        _timer = new Timer(OnTick, null, TickInterval, TickInterval);
    }

    private void OnTick(object? state)
    {
        try
        {
            var interval = Plugin.Instance?.Configuration.SectionWarmIntervalSeconds ?? 0;
            if (interval <= 0)
            {
                return;
            }

            if (_sinceLastPass.Elapsed < TimeSpan.FromSeconds(interval))
            {
                return;
            }

            // A pass that outruns its own interval must not stack up behind itself: the
            // whole point is to be a background trickle, and overlapping passes on a box
            // that is already struggling is the shape that turns a warmer into the load.
            if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
            {
                return;
            }

            try
            {
                WarmOnce();
            }
            finally
            {
                // Restart AFTER the pass, so the interval is the gap between passes and a
                // slow pass cannot immediately re-trigger itself.
                _sinceLastPass.Restart();
                Interlocked.Exchange(ref _running, 0);
            }
        }
        catch (Exception ex)
        {
            // A warm pass is pure optimisation. Nothing it can hit is worth taking down
            // the timer — or the host, which an unhandled exception on a timer callback
            // would do.
            //
            // The first failure is logged loudly and the rest quietly, for the same
            // reason the first success is: a warmer that throws on every pass is
            // indistinguishable at the wire from one that is switched off, and it is a
            // background timer nobody is watching. One Warning makes it findable; the
            // rest stay out of a log this fires into ~1,900 times a day.
            if (!_loggedFirstError)
            {
                _loggedFirstError = true;
                _logger.LogWarning(ex, "section warm pass failed; the warmer will keep trying and requests are unaffected");
                return;
            }

            _logger.LogDebug(ex, "section warm pass failed");
        }
    }

    private void WarmOnce()
    {
        var userManager = _services?.GetService<IUserManager>();
        var libraryManager = _services?.GetService<ILibraryManager>();
        var dtoService = _services?.GetService<IDtoService>();

        if (userManager is null || libraryManager is null || dtoService is null)
        {
            return;
        }

        var userId = NextUser(userManager);
        if (userId is null)
        {
            return;
        }

        var stopwatch = Stopwatch.StartNew();

        // Build the LatestShows row exactly as a request would: this is the same call the
        // JELA-731 middleware makes to answer GET /HomeScreen/Section/LatestShows, for a
        // real user, all the way through DTO and image resolution.
        //
        // It looks like far more work than a warm-up needs, and the cheap version was
        // measured and is a NULL. Two user-less ordered item scans every 30 s — the same
        // rows, the same indexes, but no user, no DTOs and no images — moved a 300 s-cold
        // fan-out from 2,199/1,528/2,317/635 ms to 2,058/1,587/2,109/581 ms, i.e. not at
        // all. Putting a user on those same scans got roughly 40% of it. Building this one
        // row got ALL of it: 140/141/172/21 ms against an in-window warm reference of
        // 146/158/184/16.
        //
        // This used to claim that one row carries all four. JELA-798 re-measured it and it
        // does not: with the warmer on and healthy, LatestShows lands at 0.8-1.6x its own
        // warm median while LatestMovies is still at 4-13x. The carry is partial, not
        // whole. What survives is the cheaper half of the claim — one USER carries the
        // household — and what does not is one SECTION carrying the others. See
        // WarmMovieRow below for the measurement that separates those two.
        var built = LatestShowsFastPath.TryBuild(userId.Value, userManager, libraryManager, dtoService);

        // TryBuild returns null when it cannot prove it reproduces the upstream row —
        // HideWatchedItems on or unreadable, or a user with no TV library. That is a
        // supported configuration, not a fault, so fall back to the user-scoped ordered
        // scans: measured at ~40% of the win rather than 0%.
        var rows = built?.Items.Count;
        if (rows is null)
        {
            Probe(libraryManager, BaseItemKind.Episode);
            Probe(libraryManager, BaseItemKind.Movie);
        }

        // JELA-798. Read per pass so the flag is its own kill switch, and read AFTER the
        // shows half so switching it on can only ever add work to a pass that was already
        // going to happen.
        int? movies = null;
        if (Plugin.Instance?.Configuration.SectionWarmMovieRow == true)
        {
            movies = WarmMovieRow(userId.Value, userManager, libraryManager, dtoService);
        }

        stopwatch.Stop();
        LastPassMs = stopwatch.Elapsed.TotalMilliseconds;
        var passes = Interlocked.Increment(ref _passes);

        // One Information line on the first pass, so "is the warmer actually running?" is
        // answerable from the server log without a debug build — and it names the path
        // taken, because the fallback is worth far less and is otherwise invisible. Every
        // pass after that is Debug: at a 30 s cadence this fires ~2,900 times a day and
        // must not be a presence an operator has to scroll past.
        if (!_loggedFirstPass)
        {
            _loggedFirstPass = true;
            _logger.LogInformation(
                "section warm active: first pass built {Rows} rows, {Movies} in {Elapsed} ms",
                rows?.ToString(CultureInfo.InvariantCulture) ?? "no (fell back to item scans)",
                MoviesDescription(movies),
                LastPassMs.ToString("0.0", CultureInfo.InvariantCulture));
            return;
        }

        _logger.LogDebug(
            "section warm pass {Pass}: {Rows} rows, {Movies} in {Elapsed} ms",
            passes,
            rows?.ToString(CultureInfo.InvariantCulture) ?? "no (fell back to item scans)",
            MoviesDescription(movies),
            LastPassMs.ToString("0.0", CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// Names the movies half in the pass log. It has three outcomes an operator has to be
    /// able to tell apart — switched off, on but with nothing to build (no movie library
    /// this user can see), and on and building — because the middle one looks exactly
    /// like the first at the wire and exactly like the third in the configuration.
    /// </summary>
    private static string MoviesDescription(int? movies) => movies switch
    {
        null => "movies off",
        0 => "movies on (no movie library for this user)",
        _ => movies.Value.ToString(CultureInfo.InvariantCulture) + " movie cards",
    };

    /// <summary>
    /// JELA-798: does the Latest Movies row's work — the user-scoped ordered movie query
    /// per movie library, then a DTO with images for each card — and throws the result
    /// away. Returns the number of cards built, 0 when this user can see no movie library.
    /// </summary>
    /// <remarks>
    /// <para><b>Why a second row at all.</b> JELA-793 shipped on the finding that one
    /// warmed section was enough for all four rows. Re-measured on production 2026-08-28 with the warmer on
    /// at 30 s, gate-D-clean 450 s+ quiet windows, concurrent fan-out, <c>no-store</c>,
    /// each arm against its own in-window warm median: LatestShows 346 ms / <b>1.61x</b>,
    /// LatestMovies 2,677 ms / <b>13.3x</b>. The carry is partial, not whole.</para>
    ///
    /// <para><b>Why not just rotate faster,</b> which is the cheaper fix and was tried
    /// first. At <c>SectionWarmIntervalSeconds = 10</c> — a 110 s lap over the 11 users,
    /// so every user is fresher than the ~60 s decay time — LatestMovies still came in at
    /// 1,122 ms against a 264 ms warm median, <b>4.25x</b>, over the 3x bar. It could not
    /// have been the rotation: the same burst carried a user-less
    /// <c>/Items?IncludeItemTypes=Movie&amp;Limit=1</c> control probe, which has no user
    /// for a rotation to be stale for, and in the 30 s arm that probe read <b>9,573 ms
    /// against a 7.9 ms warm median</b> while its Episode twin read 1,366 ms. Nothing in
    /// the pass touches movies, for any user, at any interval.</para>
    ///
    /// <para><b>Why the row and not the query.</b> The user-less movie scan
    /// <see cref="Probe"/> already runs on the fallback path and JELA-793 measured that
    /// family at ~0% of the win; adding a user to it got ~40%; building the row got 100%.
    /// The expensive cold state is the DTO and image work, which is why this asks for
    /// <see cref="LatestShowsFastPath.SectionDtoOptions"/> rather than a cheaper shape.</para>
    ///
    /// <para><b>What this deliberately does not do.</b> It does not try to reproduce
    /// <c>LatestMoviesSection</c>'s row. A warmer is not a fast path: nothing it builds is
    /// ever served, so it needs to touch the same substrate, not return the same answer.
    /// That is what keeps it free of the reflection into a third-party plugin's internals
    /// that <see cref="LatestShowsFastPath"/> needs in order to be allowed to serve —
    /// and it is why <c>ContinueWatchingNextUp</c> and <c>BecauseYouWatched</c> are still
    /// not warmed here. Those rows are not "latest N of a kind"; their substrate is
    /// per-user playstate that no kind-ordered query reaches.</para>
    /// </remarks>
    private static int WarmMovieRow(
        Guid userId,
        IUserManager userManager,
        ILibraryManager libraryManager,
        IDtoService dtoService)
    {
        var user = userManager.GetUserById(userId);
        if (user is null)
        {
            return 0;
        }

        // Permission-filtered by GetChildren(user, ...), the same way LatestShowsFastPath
        // enumerates the TV libraries — a warm pass must not read a library this user
        // cannot see, both because it is the wrong substrate and because it is the wrong
        // thing for a background job to be doing on someone's behalf.
        var movieFolders = libraryManager.GetUserRootFolder()
            .GetChildren(user, true)
            .OfType<Folder>()
            .Where(x => (x as ICollectionFolder)?.CollectionType == CollectionType.movies)
            .ToArray();

        if (movieFolders.Length == 0)
        {
            return 0;
        }

        var dtoOptions = LatestShowsFastPath.SectionDtoOptions();
        var built = 0;

        foreach (var folder in movieFolders)
        {
            var page = folder.GetItems(new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie },

                // DateCreated, because "latest movies" is latest ADDED — unlike the shows
                // row, which upstream orders by premiere date.
                OrderBy = new[] { (ItemSortBy.DateCreated, SortOrder.Descending) },
                Limit = MovieRowLimit,
                IsVirtualItem = false,
                Recursive = true,
                ParentId = folder.Id,

                // A warmer has even less use for a count than upstream does, and it costs
                // a second pass over the same filtered set.
                EnableTotalRecordCount = false,

                DtoOptions = dtoOptions,
            });

            foreach (var item in page.Items)
            {
                // The return value is the point being discarded, not the call: this is
                // where the image resolution happens, and the image resolution is the
                // expensive cold state.
                dtoService.GetBaseItemDto(item, dtoOptions, user);
                built++;
            }
        }

        return built;
    }

    /// <summary>
    /// Picks the user this pass warms on behalf of, round-robin over the household in a
    /// stable order.
    /// </summary>
    /// <remarks>
    /// One user per pass, not all of them. The expensive part of the cold cost is the
    /// shared item/DTO/image work, so a single user's build is what lifts the whole box;
    /// warming all 11 users every pass would multiply the cost by 11 to re-do that shared
    /// work eleven times. Round-robin rather than a fixed pick because whatever per-user
    /// state is left over is then covered too, within one lap, and because "the first
    /// user" is an arbitrary choice that would quietly privilege one household member.
    /// </remarks>
    private Guid? NextUser(IUserManager userManager)
    {
        // GetUsersIds rather than GetUsers: this needs identity only, and materialising
        // every User entity per pass to read one Guid off it is work the warm-up is
        // supposed to be cheap enough to avoid. Ordered, because the natural order is not
        // contractually stable and a lap that reshuffles every pass is not a lap.
        var users = userManager.GetUsersIds().OrderBy(x => x).ToArray();
        if (users.Length == 0)
        {
            return null;
        }

        var next = Interlocked.Increment(ref _userCursor);

        // Modulo of a value that will eventually wrap negative: & long.MaxValue first.
        return users[(int)((next & long.MaxValue) % users.Length)];
    }

    /// <summary>
    /// Reads the most recent <see cref="ProbeLimit"/> items of one type by premiere date.
    /// The fallback pass only — see <see cref="WarmOnce"/> for why this is not the main
    /// one.
    /// </summary>
    private static int Probe(ILibraryManager libraryManager, BaseItemKind kind)
    {
        var items = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = new[] { kind },
            OrderBy = new[] { (ItemSortBy.PremiereDate, SortOrder.Descending) },
            Limit = ProbeLimit,
            IsVirtualItem = false,
            Recursive = true,

            // Upstream asks for this on every window and throws it away (JELA-731); it
            // costs a second pass over the same filtered set. A warmer has even less use
            // for a count than upstream does.
            EnableTotalRecordCount = false,

            DtoOptions = new DtoOptions(false) { EnableImages = false },
        });

        return items.Count;
    }

    public void Dispose()
    {
        _timer?.Dispose();
        _timer = null;
    }
}
