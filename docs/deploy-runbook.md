# Server-plugin deploy runbook — ship, verify, roll back

**Scope:** JELA-31 (WS-E / C4). The canonical, **reversible** way to ship a
change to the live `/shell/` channel via the `JellyPlug Shell` Jellyfin server
plugin, prove it actually propagated, and roll back fast if it didn't.

**Why this doc exists.** JELA-26 stalled: publishing the plugin is
outward-facing (it auto-updates every subscribed TV) and was hard to reverse,
the propagation/rollback story was ad-hoc (a publish was reverted mid-flight —
`764d974`), and there was **no way to confirm the live server had actually
picked up the new bytes in the same heartbeat**. Live `/shell/` only flips
after the Jellyfin server auto-pulls the new plugin zip **and restarts** —
timing the release step does not control. This runbook + the
`tooling/ci/verify-shell-deploy.sh` probe close all three gaps.

Related: [`RELEASE.md`](../RELEASE.md) (signing policy — the **`.wgt` bootstrap**
is signed and cut from the private internal repo; the **server plugin** below is
an unsigned managed-DLL zip and ships from this public repo),
[`packages/server-plugin/README.md`](../packages/server-plugin/README.md)
(plugin internals).

---

## 0. Mental model — what "deploy" means here

Two independently-versioned things get confused; keep them separate:

| Thing                                           | Version                         | Where it lives                                                             | How a TV gets it                                                       |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **shell** (`shell.min.js`)                      | `ver:"1.0.75"` inline in the JS | `packages/shell-tizen/src/shell.min.js`, embedded into the plugin at build | TV polls `/shell/manifest.json`, cache-busts `shell.min.js?v=<sha256>` |
| **server plugin** (`jellyplug-shell_<ver>.zip`) | `<Version>` in the `.csproj`    | GitHub release + `plugin-repo/manifest.json`                               | Jellyfin autoUpdate pulls the zip, then **restarts**                   |

Key consequence: **the shell has no version bump of its own.** You ship a new
shell by rebuilding `shell.min.js`, bumping the **plugin** `.csproj` `<Version>`,
and cutting a plugin release. The plugin embeds the shell as a resource, so a
new plugin build auto-carries whatever `shell.min.js` is on `main`. TVs
cache-bust on the shell's **sha256**, so no shell-side version bump is needed
for the new bytes to propagate — the sha changing is the signal.

The single source of truth for "which shell bytes are intended" is therefore the
**sha256 of `packages/shell-tizen/src/shell.min.js` at the released commit.**
That is exactly what the verification probe compares against.

---

## 1. Ship (forward path)

Preconditions: the shell change is already on `main` (both `shell.js` and the
regenerated `shell.min.js`, guarded byte-for-byte by `verify_shell_src.py` in
CI — see [`shell-src-edit-workflow`] conventions). Do **not** ship a shell that
only exists on a feature branch.

1. **Bump the plugin version.** Edit
   `packages/server-plugin/Jellyfin.Plugin.JellyPlugShell/Jellyfin.Plugin.JellyPlugShell.csproj`
   → `<Version>` to the next value (e.g. `1.0.1.0` → `1.0.2.0`). This is the
   single source of truth; the release refuses to publish if the dispatch input
   disagrees. Commit to `main` via PR.

2. **Cut the release (CI, no local dotnet needed).** Actions tab →
   **release-server-plugin** → _Run workflow_ → `confirm_version` = the exact
   `.csproj` `<Version>`. The workflow (`release-server-plugin.yml`):
   - re-reads `<Version>` and **stops** if `confirm_version` disagrees (a stale
     tab can't ship the wrong bytes);
   - **stops** if the `server-plugin-v<ver>` tag already exists (no clobber);
   - `dotnet publish` + `package-plugin.sh` → `dist/jellyplug-shell_<ver>.zip`
     (embeds the current `shell.min.js` + `babel.min.js`);
   - creates GitHub release `server-plugin-v<ver>` with the zip asset;
   - idempotently splices the version entry (with the real md5 `checksum`) into
     `plugin-repo/manifest.json` and pushes it to `main`.
     Dispatch-only; re-running a published version is a no-op.

3. **Propagation is now out of your hands but bounded.** Subscribed Jellyfin
   servers poll the manifest, autoUpdate the plugin, **and restart** on their own
   cadence. Until that restart, live `/shell/` still serves the previous shell.
   Do not assume "released" == "live". Go to §3 to prove it.

Manual fallback (local dotnet box) is the same recipe by hand — see
`packages/server-plugin/README.md` §Distribution. Prefer the CI path.

---

## 2. Roll back (reverse path)

Rollback is intentionally cheap because a publish is outward-facing. Pick by how
far propagation got:

### 2a. Prod has NOT yet auto-pulled the bad version (fastest, zero prod impact)

This is the `764d974` case: the manifest entry + release existed but the live
server was still on the prior version. Cleanly remove the new entry so no server
ever pulls it:

1. **Revert the manifest bump** so `plugin-repo/manifest.json` no longer lists
   the bad version:
   ```sh
   git revert --no-edit <manifest-bump-commit>   # e.g. 8a663ea
   # or hand-delete the versions[] entry and commit
   git push origin main
   ```
2. **Delete the GitHub release + tag** so the `sourceUrl` 404s even if a stale
   manifest is cached:
   ```sh
   gh release delete server-plugin-v<bad-ver> --cleanup-tag --yes
   ```
3. Confirm the manifest's top entry is the **prior good** version. Servers that
   poll now stay put.

> Keep enabling infra (the `.csproj` version bump, workflow changes) if you want
> to re-cut later — `764d974` kept `1.0.1.0` + the CI automation and only
> reverted the manifest publish, so re-shipping was a single dispatch.

### 2b. Prod HAS auto-updated to a bad version (pin backward)

autoUpdate always installs the **highest** compatible `version` in the manifest,
so you cannot roll a server back merely by deleting the newest entry (a server
already on it stays). You must publish a **higher** version that carries the
**good** (previous) bytes:

1. Check out the last-good shell commit (or `git revert` the bad shell change on
   `main`) so `shell.min.js` is the good bytes again.
2. Bump `.csproj` `<Version>` to a value **above** the bad one (e.g. bad
   `1.0.2.0` → roll-forward `1.0.3.0`).
3. Run **release-server-plugin** as in §1. Servers autoUpdate to `1.0.3.0`,
   which serves the good shell.
4. Verify with §3 (`--expect-version 1.0.3.0`, and the sha equals the good
   shell's sha).

Rollback is always "roll forward to good bytes" once fielded — there is no
downgrade channel. Keep the previous shell's sha256 handy (the probe prints it,
and every release's manifest entry records the zip checksum).

---

## 3. Verify propagation — automated sha-match probe

`tooling/ci/verify-shell-deploy.sh` fetches `<base>/shell/manifest.json` and
asserts its `sha256` equals the sha256 of the shell this repo intends to ship.
It can **poll**, absorbing the uncontrolled "server auto-pulls + restarts" delay,
so a release becomes deterministically verifiable instead of "check back later".

```sh
# One-shot (intended sha = sha256 of the checked-out shell.min.js):
JELLYFIN_URL=https://your-server.example \
  tooling/ci/verify-shell-deploy.sh

# Poll until the server picks it up (15 min default), also assert the version:
tooling/ci/verify-shell-deploy.sh https://your-server.example \
  --poll --expect-version 1.0.2.0

# Verify a specific past release from any checkout (explicit intended sha):
tooling/ci/verify-shell-deploy.sh https://your-server.example \
  78b5dc342f01184ba788a36bac6056d26cc8bf13f2ee8504ce94a09645369a86
```

- **Exit 0** — live `sha256` matches intended → deploy propagated.
- **Exit 1** — mismatch / poll timeout / unreachable (server not restarted yet,
  or the release didn't carry the intended shell).
- **Exit 2** — usage error (no URL, missing source file).

The base URL is a **personal endpoint** and is never committed (JEL-139 guard) —
always pass it via arg or `$JELLYFIN_URL` at run time.

### Optional: fail the release run itself on non-propagation

`release-server-plugin.yml` has a final **verify-propagation** step that runs
this probe **only if** the repo variable `DEPLOY_VERIFY_URL` is set (Settings →
Secrets and variables → Actions → Variables). Unset ⇒ the step logs "skipped"
and the release still succeeds (default, keeps the URL out of git). Set it and
every dispatched release polls the live server and turns red if the bytes never
went live within the window.

---

## 4. JELA-26 precondition

JELA-26 (on-device Q60R confirm of the JELA-22 scrollY gate) was blocked on
"the gated shell isn't live and I can't prove when it will be." With this
runbook + probe:

- the ship path (§1) is a documented one-dispatch action that carries the gated
  `shell.min.js` (sha `78b5dc34…` on `main`) into a plugin release;
- propagation is provable in-heartbeat via `--poll` (§3) instead of guesswork;
- a bad ship is reversible in minutes (§2).

Once a release carrying the gated shell is cut **and** the probe reports the
live `/shell/manifest.json` sha == `78b5dc34…`, JELA-26's shipped-gated-shell
precondition is satisfied and on-device verification can proceed.

[`shell-src-edit-workflow`]: ../packages/shell-tizen/scripts/verify_shell_src.py
