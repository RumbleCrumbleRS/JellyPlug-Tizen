using System.Collections.Concurrent;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Users;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-904: a delegating <see cref="IUserManager"/> that memoizes exactly one
/// member — <see cref="GetUserById"/> — for a few seconds. Every other member
/// is forwarded to the real manager untouched.
///
/// Why (JELA-903 measured all of this on production and reproduced it on a
/// plugin-free stock Jellyfin 12.0, so it is upstream, not ours, and not
/// data-volume dependent):
///
///   * <c>UserManager.GetUserById</c> is uncached and synchronous, and its
///     query is <c>.AsSingleQuery()</c> with four collection <c>.Include()</c>s
///     — one cartesian-product JOIN materialized per call (24 Permissions x 13
///     Preferences = 312 rows for a single user). ~6.6 ms each on production.
///   * It runs at <c>AuthorizationContext.cs:186</c> for EVERY user-token
///     request and again at <c>DefaultAuthorizationHandler.cs:60</c> for every
///     <c>[Authorize]</c> endpoint (API keys short-circuit above that one),
///     before the endpoint does any work of its own. Controller bodies add
///     more. So an <c>[Authorize]</c> request pays it at least twice.
///   * A cold TV boot issues ~348 same-origin requests, essentially all
///     user-token authenticated, so the fleet pays this ~700 times per boot.
///
/// Measured headroom on that same local instance, one build, mode chosen by
/// env var, arms bracketed stock -> split -> cache -> stock to absorb drift,
/// <c>/Branding/Configuration</c> medians (ms):
///
/// | mode                    | single | 48-way |
/// |-------------------------|--------|--------|
/// | stock (AsSingleQuery)   | 6.07   | 68.5   |
/// | AsSplitQuery()          | 2.52   | 2.76   |
/// | memoized entity (this)  | 0.45   | 0.34   |
///
/// ## Why the TTL is the point and must not be raised for a bigger number
///
/// Eviction on the mutating members of the interface is NOT sufficient on its
/// own, for two independent reasons:
///
///   1. <c>UserManager</c> writes <c>LastActivityDate</c> /
///      <c>LastLoginDate</c> / <c>InvalidLoginAttemptCount</c> internally via
///      <c>ExecuteUpdateAsync</c>, which bypasses the change tracker and
///      raises no event this decorator can see.
///   2. A stale <c>Permissions</c> set is security-relevant staleness: the
///      cached entity is what <c>DefaultAuthorizationHandler</c> reads to
///      decide whether the caller is an administrator. Anything that can go
///      stale in an authorization decision needs a wall-clock bound, not only
///      an invalidation hook, because the hook is the thing that might be
///      missing.
///
/// A <see cref="DefaultTtlSeconds"/>-second bound still collapses a
/// ~348-request boot burst from ~700 queries to ~2, which is the entire prize.
/// Buying a larger number by widening the window trades a measured ~0 for an
/// unbounded authorization-staleness risk.
///
/// The TTL and the kill switch are both read per call, so an operator can
/// shorten or disable the cache from the dashboard with no server restart.
/// </summary>
public sealed class CachingUserManager : IUserManager
{
    /// <summary>Default entry lifetime. See the class remarks — this is a safety bound, not a tuning knob.</summary>
    public const int DefaultTtlSeconds = 5;

    /// <summary>
    /// Hard ceiling on the operator-set TTL. A value above this is clamped
    /// rather than honored: the authorization-staleness argument above stops
    /// holding somewhere, and a config typo must not be the thing that finds
    /// out where.
    /// </summary>
    public const int MaxTtlSeconds = 60;

    private readonly IUserManager _inner;
    private readonly ConcurrentDictionary<Guid, Entry> _entries = new();

    private long _hits;
    private long _misses;
    private long _expiries;
    private long _evictions;
    private long _passthrough;

    public CachingUserManager(IUserManager inner)
    {
        _inner = inner;

        // The real manager raises this from RenameUser/UpdateUserAsync/
        // UpdatePolicyAsync/etc. Subscribing is belt-and-braces next to the
        // explicit eviction on each mutating member below: an upstream release
        // that adds a new mutation path still invalidates as long as it raises
        // the event, and if it raises neither, the TTL is the backstop.
        _inner.OnUserUpdated += OnInnerUserUpdated;
    }

    /// <summary>Live entry count (bounded by the number of real users — misses on a nonexistent id store nothing).</summary>
    public int Count => _entries.Count;

    /// <summary>
    /// Counters for the admin-only <c>GET /shell/diag/usercache</c> view.
    /// JELA-904 AC1 is "a served request proves the cache is consulted", and a
    /// hit count that moves across two requests is that proof.
    /// </summary>
    public UserCacheStats Stats => new()
    {
        Hits = Interlocked.Read(ref _hits),
        Misses = Interlocked.Read(ref _misses),
        Expiries = Interlocked.Read(ref _expiries),
        Evictions = Interlocked.Read(ref _evictions),
        Passthrough = Interlocked.Read(ref _passthrough),
        Entries = _entries.Count,
        TtlSeconds = TtlSeconds(),
    };

    /// <summary>
    /// Effective TTL in seconds: 0 means the cache is off and every call is a
    /// straight passthrough. Read per call (no restart needed to change it).
    /// </summary>
    public static int TtlSeconds()
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null || config.DisableUserCache)
        {
            return 0;
        }

        return Math.Clamp(config.UserCacheTtlSeconds, 0, MaxTtlSeconds);
    }

    /// <inheritdoc/>
    public event EventHandler<GenericEventArgs<User>> OnUserUpdated
    {
        add => _inner.OnUserUpdated += value;
        remove => _inner.OnUserUpdated -= value;
    }

    // ---- the one cached member ---------------------------------------------

    /// <inheritdoc/>
    public User? GetUserById(Guid id)
    {
        var ttl = TtlSeconds();
        if (ttl <= 0)
        {
            // Off. Drop anything held from before the flip so re-enabling can
            // never serve an entry that outlived its own TTL while disabled.
            if (!_entries.IsEmpty)
            {
                Clear();
            }

            Interlocked.Increment(ref _passthrough);
            return _inner.GetUserById(id);
        }

        if (id.Equals(Guid.Empty))
        {
            // The interface documents ArgumentException for an empty Guid.
            // Delegate so the exception is the real manager's, verbatim.
            return _inner.GetUserById(id);
        }

        var now = DateTimeOffset.UtcNow;
        if (_entries.TryGetValue(id, out var entry))
        {
            if (entry.ExpiresUtc > now)
            {
                Interlocked.Increment(ref _hits);
                return entry.User;
            }

            // Remove this exact entry, never whatever is there now — a
            // concurrent caller may already have stored a fresh one.
            if (_entries.TryRemove(new KeyValuePair<Guid, Entry>(id, entry)))
            {
                Interlocked.Increment(ref _expiries);
            }
        }

        Interlocked.Increment(ref _misses);
        var user = _inner.GetUserById(id);
        if (user is not null)
        {
            // A null is never stored: a user created moments from now must be
            // visible immediately, not after a TTL.
            _entries[id] = new Entry(user, now.AddSeconds(ttl));
        }

        return user;
    }

    // ---- mutating members: evict, delegate, evict again ---------------------
    //
    // Evicting on BOTH sides of the inner call is deliberate. Evicting only
    // afterwards leaves a window in which a concurrent reader repopulates from
    // the pre-write row and that stale entry survives the write; evicting only
    // beforehand leaves the post-write row uncached but lets a reader that ran
    // during the await repopulate a stale one. Evicting in a finally also
    // covers the mutation that throws halfway: the caller may have mutated the
    // shared entity in place before the failure, so the cached instance is
    // suspect either way.

    /// <inheritdoc/>
    public async Task UpdateUserAsync(User user)
    {
        var id = user?.Id ?? Guid.Empty;
        Evict(id);
        try
        {
            await _inner.UpdateUserAsync(user!).ConfigureAwait(false);
        }
        finally
        {
            Evict(id);
        }
    }

    /// <inheritdoc/>
    public async Task RenameUser(Guid userId, string oldName, string newName)
    {
        Evict(userId);
        try
        {
            await _inner.RenameUser(userId, oldName, newName).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task<User> CreateUserAsync(string name)
    {
        try
        {
            var created = await _inner.CreateUserAsync(name).ConfigureAwait(false);
            Evict(created.Id);
            return created;
        }
        catch
        {
            Clear();
            throw;
        }
    }

    /// <inheritdoc/>
    public async Task DeleteUserAsync(Guid userId)
    {
        Evict(userId);
        try
        {
            await _inner.DeleteUserAsync(userId).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task ResetPassword(Guid userId)
    {
        Evict(userId);
        try
        {
            await _inner.ResetPassword(userId).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task ChangePassword(Guid userId, string newPassword)
    {
        Evict(userId);
        try
        {
            await _inner.ChangePassword(userId, newPassword).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task UpdateConfigurationAsync(Guid userId, UserConfiguration config)
    {
        Evict(userId);
        try
        {
            await _inner.UpdateConfigurationAsync(userId, config).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task UpdatePolicyAsync(Guid userId, UserPolicy policy)
    {
        Evict(userId);
        try
        {
            await _inner.UpdatePolicyAsync(userId, policy).ConfigureAwait(false);
        }
        finally
        {
            Evict(userId);
        }
    }

    /// <inheritdoc/>
    public async Task ClearProfileImageAsync(User user)
    {
        var id = user?.Id ?? Guid.Empty;
        Evict(id);
        try
        {
            await _inner.ClearProfileImageAsync(user!).ConfigureAwait(false);
        }
        finally
        {
            Evict(id);
        }
    }

    // ---- mutating members whose target id is not a parameter ----------------
    //
    // These resolve a user by NAME or by a reset pin, and write login state
    // (LastLoginDate, LastActivityDate, InvalidLoginAttemptCount) with
    // ExecuteUpdateAsync, which raises no event. The id is not in hand either
    // before or after, so the whole store goes. All three are rare — a login,
    // a forgotten password, a startup — so a full clear costs nothing.

    /// <inheritdoc/>
    public async Task<User?> AuthenticateUser(string username, string password, string remoteEndPoint, bool isUserSession)
    {
        try
        {
            return await _inner.AuthenticateUser(username, password, remoteEndPoint, isUserSession).ConfigureAwait(false);
        }
        finally
        {
            Clear();
        }
    }

    /// <inheritdoc/>
    public async Task<ForgotPasswordResult> StartForgotPasswordProcess(string enteredUsername, bool isInNetwork)
    {
        try
        {
            return await _inner.StartForgotPasswordProcess(enteredUsername, isInNetwork).ConfigureAwait(false);
        }
        finally
        {
            Clear();
        }
    }

    /// <inheritdoc/>
    public async Task<PinRedeemResult> RedeemPasswordResetPin(string pin)
    {
        try
        {
            return await _inner.RedeemPasswordResetPin(pin).ConfigureAwait(false);
        }
        finally
        {
            Clear();
        }
    }

    /// <inheritdoc/>
    public async Task InitializeAsync()
    {
        try
        {
            await _inner.InitializeAsync().ConfigureAwait(false);
        }
        finally
        {
            Clear();
        }
    }

    // ---- pure passthrough ---------------------------------------------------

    /// <inheritdoc/>
    public IEnumerable<User> GetUsers() => _inner.GetUsers();

    /// <inheritdoc/>
    public IEnumerable<Guid> GetUsersIds() => _inner.GetUsersIds();

    /// <inheritdoc/>
    public User? GetFirstUser() => _inner.GetFirstUser();

    /// <inheritdoc/>
    public User? GetUserByName(string name) => _inner.GetUserByName(name);

    /// <inheritdoc/>
    public UserDto GetUserDto(User user, string? remoteEndPoint = null) => _inner.GetUserDto(user, remoteEndPoint);

    /// <inheritdoc/>
    public NameIdPair[] GetAuthenticationProviders() => _inner.GetAuthenticationProviders();

    /// <inheritdoc/>
    public NameIdPair[] GetPasswordResetProviders() => _inner.GetPasswordResetProviders();

    // ---- internals ----------------------------------------------------------

    private void OnInnerUserUpdated(object? sender, GenericEventArgs<User> e)
    {
        var id = e?.Argument?.Id ?? Guid.Empty;
        if (id.Equals(Guid.Empty))
        {
            Clear();
            return;
        }

        Evict(id);
    }

    private void Evict(Guid id)
    {
        if (!id.Equals(Guid.Empty) && _entries.TryRemove(id, out _))
        {
            Interlocked.Increment(ref _evictions);
        }
    }

    private void Clear()
    {
        var dropped = _entries.Count;
        _entries.Clear();
        if (dropped > 0)
        {
            Interlocked.Add(ref _evictions, dropped);
        }
    }

    private sealed record Entry(User User, DateTimeOffset ExpiresUtc);
}

/// <summary>Snapshot of <see cref="CachingUserManager"/> counters (JELA-904 AC1 evidence).</summary>
public sealed class UserCacheStats
{
    public long Hits { get; init; }

    public long Misses { get; init; }

    public long Expiries { get; init; }

    public long Evictions { get; init; }

    /// <summary>Calls served with the cache disabled (kill switch or TTL 0).</summary>
    public long Passthrough { get; init; }

    public int Entries { get; init; }

    /// <summary>Effective TTL at the moment of the snapshot; 0 means disabled.</summary>
    public int TtlSeconds { get; init; }
}
