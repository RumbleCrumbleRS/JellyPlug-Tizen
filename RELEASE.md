# Release & Signing Policy

> **Canonical release path: `RumbleCrumbleRS/JellyPlug-Tizen-internal` (private).**
> **This repository (`RumbleCrumbleRS/JellyPlug-Tizen`, public) is source-only — do not cut releases from it.**

This is the ratified policy from
[JEL-162](/JEL/issues/JEL-162) (Decision 2 = `bless-internal`). The full
rationale lives in the signing-policy document:
[Tizen Signing & Release Policy](/JEL/issues/JEL-162#document-signing-policy).

## Signed releases come from the internal repository

A retail/locked Samsung Tizen TV **refuses to install an unsigned `.wgt`**, so
every installable widget must be signed. The signing material and the full
release runbook live **only** in the private `JellyPlug-Tizen-internal`
repository — this public repo is not a signing endpoint and intentionally
documents no signing secrets.

> **Signed releases are produced from the internal `JellyPlug-Tizen-internal`
> repository. See that repo's `RELEASE.md` for signing and release
> instructions.**

This public repository carries no signing secrets and is not a release endpoint.
Its release workflows fail fast (with a pointer to the internal repo) instead of
emitting an unsigned, uninstallable widget.

## CI on this repository

`.github/workflows/ci.yml` is a build/package check only: its `build-tizen` job
test-signs with a throwaway self-signed cert (never release material) to
exercise the build/package pipeline. It is not a release path.

Restoring a release path on this public repo would be a **separate, deliberate
board decision**. Until then, treat this repo as source-only and cut all signed
releases from the internal repository.
