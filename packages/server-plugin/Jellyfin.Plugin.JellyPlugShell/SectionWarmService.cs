using System;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
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
/// <para><b>Why a plain timer and not an <c>IScheduledTask</c>.</b> This plugin already
/// owns two scheduled tasks, so the task route was the obvious one — and it is the wrong
/// one. The JELA-692 perf pre-flight gate blocks any production measurement while a
/// scheduled task is non-Idle; a warmer firing every ~45 s would put a task in Running
/// state a large fraction of the time and randomly block the gate that every performance
/// conclusion in this programme is quoted against. It would also write a task-history row
/// per pass. A timer is invisible to both.</para>
///
/// <para>Off by default (<see cref="PluginConfiguration.SectionWarmIntervalSeconds"/> is
/// 0). It touches nothing a request can see: it issues read-only item queries with no
/// user, builds no DTOs, writes no response, and stores nothing — the only state it
/// changes is the state a request would have had to build for itself anyway.</para>
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
    /// Rows read per probe. 200 is the page size <c>LatestShowsSection</c> asks for per
    /// window and the first probe size <see cref="LatestShowsFastPath"/> uses, so a pass
    /// touches the same stretch of the same indexes a real row build does — the point is
    /// to warm what the row reads, not to read as little as possible.
    /// </summary>
    internal const int ProbeLimit = 200;

    private readonly ILogger<SectionWarmService> _logger;
    private readonly Stopwatch _sinceLastPass = new();

    private IServiceProvider? _services;
    private Timer? _timer;
    private int _started;
    private int _running;
    private long _passes;
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
        var libraryManager = _services?.GetService<ILibraryManager>();
        if (libraryManager is null)
        {
            return;
        }

        var stopwatch = Stopwatch.StartNew();

        // The two ordered scans behind every "Latest" row on the home. Both Home Screen
        // Sections' own window walk and the JELA-731 fast path read exactly this: the most
        // recent items of one type ordered by premiere date. Deliberately NOT one probe —
        // the baseline showed a cheap section still paying its full cold penalty after
        // four other sections had already been served, so the warm state is not one shared
        // switch that any query flips.
        var episodes = Probe(libraryManager, BaseItemKind.Episode);
        var movies = Probe(libraryManager, BaseItemKind.Movie);

        stopwatch.Stop();
        LastPassMs = stopwatch.Elapsed.TotalMilliseconds;
        var passes = Interlocked.Increment(ref _passes);

        // One Information line on the first pass, so "is the warmer actually running?" is
        // answerable from the server log without a debug build. Every pass after that is
        // Debug: at a ~45 s cadence this fires ~1,900 times a day and must not be a
        // presence in the log an operator has to scroll past.
        if (!_loggedFirstPass)
        {
            _loggedFirstPass = true;
            _logger.LogInformation(
                "section warm active: first pass read {Episodes} episodes + {Movies} movies in {Elapsed} ms",
                episodes,
                movies,
                LastPassMs.ToString("0.0", CultureInfo.InvariantCulture));
            return;
        }

        _logger.LogDebug(
            "section warm pass {Pass}: {Episodes} episodes + {Movies} movies in {Elapsed} ms",
            passes,
            episodes,
            movies,
            LastPassMs.ToString("0.0", CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// Reads the most recent <see cref="ProbeLimit"/> items of one type by premiere date.
    /// </summary>
    /// <remarks>
    /// No user on the query, and that is the design: a user-scoped query would pull in
    /// permission filtering and user-data joins, would have to pick <em>which</em> of the
    /// household's users to warm on the household's behalf, and would multiply the cost by
    /// the user count. The cold cost measured is in reading the item rows and their
    /// ordering index, which is shared. <c>DtoOptions(false)</c> keeps it to that: no
    /// images, no user data, no DTO projection — none of which the warm-up needs and all
    /// of which a real request builds per user anyway.
    /// </remarks>
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
