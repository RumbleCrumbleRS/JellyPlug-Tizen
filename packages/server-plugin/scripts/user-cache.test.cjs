#!/usr/bin/env node
/*
 * user-cache.test.cjs — JELA-904 guards for the short-TTL memo over
 * IUserManager.GetUserById.
 *
 * Context (JELA-903): upstream's GetUserById is uncached and synchronous and
 * materializes one four-way cartesian JOIN per call (~6.6 ms on production).
 * AuthorizationContext runs it for every user-token request and
 * DefaultAuthorizationHandler runs it AGAIN for every [Authorize] endpoint, so
 * a ~348-request TV boot pays it ~700 times.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring that would only break against a live server is
 * source-pinned. Each check below is a specific way this can silently stop
 * working, or silently become dangerous:
 *
 *   1. The decorator is actually wired, by REWRITING the core descriptor.
 *      Merely adding an IUserManager registration would leave a second,
 *      undecorated manager reachable through IEnumerable<IUserManager>, and
 *      would give the decorator no way to reach the real one.
 *   2. Every unexpected descriptor shape FAILS OPEN. This substitutes a core
 *      service on a server we do not own; the failure mode of a wrong guess
 *      must be "stock Jellyfin", never "broken server".
 *   3. Exactly ONE member is cached. A memo over GetUserByName or GetUsers
 *      was never measured and is not what the TTL argument covers.
 *   4. Every mutating member evicts, on BOTH sides of the inner call.
 *   5. The TTL exists, is clamped, and is read PER CALL. A TTL captured once
 *      into a field turns the dashboard kill switch into a restart-only
 *      setting — i.e. no kill switch at all, on the one cache here that holds
 *      an authorization input.
 *   6. Nulls are never stored, so a user created a moment from now is visible
 *      immediately rather than after a TTL.
 *   7. The OnUserUpdated event is both forwarded to subscribers and consumed
 *      for eviction.
 *   8. The AC1 proof endpoint exists and is elevation-gated.
 *
 * Run: node packages/server-plugin/scripts/user-cache.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const mgr = fs.readFileSync(path.join(ROOT, "CachingUserManager.cs"), "utf8");
const reg = fs.readFileSync(
  path.join(ROOT, "PluginServiceRegistrator.cs"),
  "utf8",
);
const cfg = fs.readFileSync(path.join(ROOT, "PluginConfiguration.cs"), "utf8");
const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);

// ---- 1. wired by rewriting the core descriptor ------------------------------

assert.ok(
  /RegisterServices\([^)]*\)\s*\{[\s\S]{0,400}TryDecorateUserManager\(serviceCollection\)/.test(
    reg,
  ),
  "TryDecorateUserManager must be called from RegisterServices",
);
assert.ok(
  /serviceCollection\.Remove\(existing\)/.test(reg),
  "the core IUserManager descriptor must be REMOVED, not shadowed — a dormant " +
    "IUserManager -> UserManager descriptor still feeds IEnumerable<IUserManager> " +
    "an undecorated manager",
);
assert.ok(
  /serviceCollection\.AddSingleton\(implementationType\)/.test(reg),
  "the original implementation type must be re-registered as its own singleton " +
    "(the decorator resolves it, and the container must stay the owner of its " +
    "lifetime — UserManager is IDisposable)",
);
assert.ok(
  /AddSingleton<IUserManager>\(\s*sp => new CachingUserManager\(\(IUserManager\)sp\.GetRequiredService\(implementationType\)\)\)/.test(
    reg,
  ),
  "IUserManager must resolve to CachingUserManager wrapped around the original",
);
// The whole substitution rests on plugin RegisterServices running AFTER core
// RegisterServices on the same collection. Keep the citation next to the code.
assert.ok(
  /ApplicationHost\.cs/.test(reg) && /CoreAppHost\.cs:83/.test(reg),
  "the registration-order argument (ApplicationHost :490 core / :492 plugins, " +
    "CoreAppHost.cs:83) must stay documented at the substitution site",
);

// ---- 2. fails open on every unexpected shape --------------------------------

for (const [guard, why] of [
  ["existing is null", "not registered yet"],
  ["existing.IsKeyedService", "keyed descriptor (ImplementationType throws)"],
  ["existing.Lifetime != ServiceLifetime.Singleton", "non-singleton"],
  ["existing.ImplementationType is null", "factory- or instance-provided"],
  [
    "existing.ImplementationType == typeof(CachingUserManager)",
    "already decorated",
  ],
]) {
  assert.ok(
    reg.includes(guard),
    `fail-open guard for ${why} missing (${guard})`,
  );
}
const decorate = reg.slice(
  reg.indexOf("TryDecorateUserManager(IServiceCollection"),
);
assert.ok(
  decorate.indexOf("return;") < decorate.indexOf("serviceCollection.Remove("),
  "the fail-open early return must come BEFORE anything mutates the collection",
);

// ---- 3. exactly one cached member -------------------------------------------

// The pinned IUserManager surface (Jellyfin 12.0). The compiler is the real
// guard that all of these are implemented; this list pins WHICH of them may
// consult the store.
const MEMBERS = [
  "GetUsers",
  "GetUsersIds",
  "InitializeAsync",
  "GetUserById",
  "GetFirstUser",
  "GetUserByName",
  "RenameUser",
  "UpdateUserAsync",
  "CreateUserAsync",
  "DeleteUserAsync",
  "ResetPassword",
  "ChangePassword",
  "GetUserDto",
  "AuthenticateUser",
  "StartForgotPasswordProcess",
  "RedeemPasswordResetPin",
  "GetAuthenticationProviders",
  "GetPasswordResetProviders",
  "UpdateConfigurationAsync",
  "UpdatePolicyAsync",
  "ClearProfileImageAsync",
];
for (const m of MEMBERS) {
  assert.ok(
    new RegExp(`_inner\\.${m}\\(`).test(mgr),
    `IUserManager.${m} must delegate to the real manager`,
  );
}

// Only GetUserById may READ the store.
const readSites = [...mgr.matchAll(/_entries\.TryGetValue\(/g)].length;
assert.strictEqual(
  readSites,
  1,
  "exactly one member may read the cache; found " + readSites + " read sites",
);
const writeSites = [...mgr.matchAll(/_entries\[[^\]]+\]\s*=/g)].length;
assert.strictEqual(writeSites, 1, "exactly one member may populate the cache");
const getById = mgr.slice(
  mgr.indexOf("public User? GetUserById(Guid id)"),
  mgr.indexOf("// ---- mutating members"),
);
assert.ok(
  getById.includes("_entries.TryGetValue(") &&
    getById.includes("_entries[id] ="),
  "the single read/write pair must live in GetUserById",
);

// An expired entry must be removed with the compare-and-remove overload: a
// blind TryRemove(id) can drop a fresh entry a concurrent caller just stored.
assert.ok(
  /_entries\.TryRemove\(new KeyValuePair<Guid, Entry>\(id, entry\)\)/.test(
    getById,
  ),
  "expiry must compare-and-remove the exact stale entry",
);

// ---- 4. every mutating member evicts, on both sides --------------------------

// userId/user-scoped mutators: evict before, and again in a finally.
for (const m of [
  "UpdateUserAsync",
  "RenameUser",
  "DeleteUserAsync",
  "ResetPassword",
  "ChangePassword",
  "UpdateConfigurationAsync",
  "UpdatePolicyAsync",
  "ClearProfileImageAsync",
]) {
  const at = mgr.indexOf(`public async Task ${m}(`);
  assert.ok(at > 0, `${m} override missing`);
  const body = mgr.slice(at, mgr.indexOf("\n    /// <inheritdoc/>", at + 1));
  assert.ok(
    /Evict\((id|userId)\);[\s\S]*try\s*\{/.test(body),
    `${m} must evict BEFORE delegating (or a concurrent read repopulates the pre-write row)`,
  );
  assert.ok(
    /finally\s*\{\s*Evict\((id|userId)\);/.test(body),
    `${m} must evict again in a finally (a mutation that throws may already have ` +
      `mutated the shared entity in place)`,
  );
}

// Mutators whose target is resolved by name/pin, and which write login state
// through ExecuteUpdateAsync (no event to hook): the whole store goes.
for (const m of [
  "AuthenticateUser",
  "StartForgotPasswordProcess",
  "RedeemPasswordResetPin",
  "InitializeAsync",
]) {
  const at = mgr.indexOf(`public async Task`, mgr.indexOf(` ${m}(`) - 60);
  const body = mgr.slice(
    mgr.indexOf(` ${m}(`),
    mgr.indexOf("\n    /// <inheritdoc/>", at + 1),
  );
  assert.ok(
    /finally\s*\{\s*Clear\(\);/.test(body),
    `${m} must clear the store (its target id is not a parameter and it writes ` +
      `login columns with ExecuteUpdateAsync, which raises no event)`,
  );
}

// ---- 5. TTL: exists, clamped, read per call ---------------------------------

assert.ok(
  /public const int DefaultTtlSeconds = 5;/.test(mgr),
  "the 5 s default TTL is the safety argument — see JELA-904",
);
assert.ok(
  /public const int MaxTtlSeconds = \d+;/.test(mgr),
  "an operator-set TTL must be clamped by a constant ceiling",
);
assert.ok(
  /Math\.Clamp\(config\.UserCacheTtlSeconds, 0, MaxTtlSeconds\)/.test(mgr),
  "UserCacheTtlSeconds must be clamped to [0, MaxTtlSeconds]",
);
assert.ok(
  /public static int TtlSeconds\(\)[\s\S]{0,400}Plugin\.Instance\?\.Configuration/.test(
    mgr,
  ),
  "the TTL must be read from config on every call — a TTL captured into a field " +
    "makes the kill switch restart-only",
);
assert.ok(
  !/_ttl\b|private readonly int .*Ttl/.test(mgr),
  "the TTL must not be cached in a field",
);
assert.ok(
  /config\.DisableUserCache/.test(mgr) &&
    /public bool DisableUserCache/.test(cfg) &&
    /public int UserCacheTtlSeconds/.test(cfg),
  "both operator settings must exist and be honored",
);
// Disabled => passthrough AND the store is dropped, so re-enabling cannot
// serve an entity that outlived its own TTL while the switch was off.
assert.ok(
  /if \(ttl <= 0\)[\s\S]{0,400}Clear\(\);[\s\S]{0,200}return _inner\.GetUserById\(id\);/.test(
    mgr,
  ),
  "with the cache off, GetUserById must clear the store and pass through",
);

// ---- 6. nulls are never stored ----------------------------------------------

assert.ok(
  /if \(user is not null\)\s*\{[\s\S]{0,400}_entries\[id\] =/.test(getById),
  "a null lookup must not be cached (a user created moments later must be " +
    "visible immediately)",
);

// ---- 7. OnUserUpdated forwarded AND consumed --------------------------------

assert.ok(
  /add => _inner\.OnUserUpdated \+= value;/.test(mgr) &&
    /remove => _inner\.OnUserUpdated -= value;/.test(mgr),
  "OnUserUpdated must forward subscriptions to the real manager — swallowing " +
    "them would break every other consumer of the event",
);
assert.ok(
  /_inner\.OnUserUpdated \+= OnInnerUserUpdated;/.test(mgr),
  "the decorator must itself subscribe to OnUserUpdated to evict",
);

// ---- 8. the AC1 proof endpoint ----------------------------------------------

assert.ok(
  ctrl.includes('[HttpGet("diag/usercache")]'),
  "GET shell/diag/usercache (AC1: a served request proves the decorator is in " +
    "the live resolution path and is being consulted) missing",
);
const diagAt = ctrl.indexOf('[HttpGet("diag/usercache")]');
// The attribute block is the contiguous run of [..] lines around the route.
const attrBlock = ctrl.slice(diagAt - 200, ctrl.indexOf("\n    {", diagAt));
assert.ok(
  !attrBlock.includes("[AllowAnonymous]"),
  "the user-cache diag view must NOT be anonymous",
);
assert.ok(
  attrBlock.includes('[Authorize(Policy = "RequiresElevation")]'),
  "the user-cache diag view must be elevation-gated",
);
assert.ok(
  /IUserManager _users/.test(ctrl) && /_users as CachingUserManager/.test(ctrl),
  "the endpoint must report the DI-RESOLVED IUserManager — reporting our own " +
    "registration code would prove nothing about the live container",
);
assert.ok(
  /decorated = caching != null/.test(ctrl) &&
    /stats = caching\?\.Stats/.test(ctrl),
  "the endpoint must report both that it is decorated and the hit counters",
);

console.log("user-cache.test.cjs: OK");
