# Release & Signing Policy (JEL-173)

> **Canonical release path: `RumbleCrumbleRS/JellyPlug-Tizen-internal` (private).**
> **`RumbleCrumbleRS/JellyPlug-Tizen` (public) is source-only — do not cut releases from it.**

This is the ratified policy from
[JEL-162](/JEL/issues/JEL-162) (Decision 2 = `bless-internal`). The full
rationale lives in the signing-policy document:
[Tizen Signing & Release Policy](/JEL/issues/JEL-162#document-signing-policy).

## Why

A retail/locked Samsung Tizen TV **refuses to install an unsigned `.wgt`**.
Producing an installable widget therefore requires the 4 `TIZEN_*` GitHub
Actions secrets (author + distributor `.p12` + passwords) that
`tooling/ci/configure-tizen-signing.sh` builds the `jellyfin` signing profile
from:

- `TIZEN_AUTHOR_P12_BASE64`
- `TIZEN_AUTHOR_PASSWORD`
- `TIZEN_DISTRIBUTOR_P12_BASE64`
- `TIZEN_DISTRIBUTOR_PASSWORD`

| Repo                                 | Secrets                            | Release/sign path                                           | Status             |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------------------- | ------------------ |
| `JellyPlug-Tizen-internal` (private) | intact                             | **canonical** — emits **signed** `.wgt` the TV accepts      | release here       |
| `JellyPlug-Tizen` (public)           | **dropped in the JEL-145 rebuild** | source-only — would emit **unsigned** `.wgt` the TV refuses | **do not release** |

## What this means in CI

The two release workflows — `.github/workflows/bootstrap-sign.yml` and
`.github/workflows/release-tizen.yml` — open with an
**`Enforce internal-repo-only release path (JEL-173)`** preflight step. It
checks that the canonical signing secret (`TIZEN_AUTHOR_P12_BASE64`) is present
and **fails fast with a pointer to the internal repo** when it is not. So:

- On **`JellyPlug-Tizen-internal`** (secrets intact) the preflight passes and
  signing proceeds as before.
- On the **public `JellyPlug-Tizen`** (no secrets) the workflow stops at the
  preflight instead of silently building an **unsigned**, uninstallable widget
  the way it would have after the JEL-145 secret loss.

`.github/workflows/ci.yml` is unaffected: its `build-tizen` job deliberately
**test-signs** with a throwaway self-signed cert (never the release secrets) to
exercise the build/package pipeline, and is not a release path.

## Cutting a release (internal repo only)

Tag from `JellyPlug-Tizen-internal`:

- `bootstrap-v<ver>` → `bootstrap-sign.yml` signs + publishes the HSB bootstrap
  pair (`JellyPlug.wgt` retail + `JellyPlug-Debug.wgt`).
- `jellyplug-v<ver>` (or legacy `tizen-v<ver>`) → `release-tizen.yml` builds +
  signs + publishes the shell `JellyPlug.wgt`.

Restoring a release path on the public repo is a **separate, deliberate board
decision** — re-provision the 4 `TIZEN_*` secrets first, then revisit this
policy. Until then, treat the public repo as source-only.
