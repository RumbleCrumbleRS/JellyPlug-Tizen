## release-artifacts/

Pre-built, signed Tizen `.wgt` packages used by `.github/workflows/release-tizen.yml`
to publish GitHub Releases.

Layout:

```
release-artifacts/
  v<version>/
    JellyfinShell.wgt   # signed widget for that version
```

Why is this checked in? Until the CI image (`ghcr.io/jellyfin/tizen-studio`) and
Tizen signing secrets (`TIZEN_*_BASE64` / `*_PASSWORD`) are configured on the
repo, CI cannot build a signed `.wgt`. Until then, the maintainer builds the
widget locally with `pnpm -C packages/shell-tizen build` (see that package's
README) and commits the resulting `.wgt` here. Pushing tag `tizen-v<version>`
then triggers the release workflow, which only attaches the pre-built artifact.

This is a stopgap — track removal in the CI/release-build issue.
