# release-artifacts/

## Shell `.wgt` — built + signed in CI, NOT committed (JEL-123)

The shell widget is no longer committed to the repo. As of JEL-123 (Option 1
of JEL-121, approved in JEL-122), `.github/workflows/release-tizen.yml` builds
and signs the `.wgt` in CI at tag time from the tagged source, using the same
4 `TIZEN_*` signing secrets and Tizen Studio recipe as `bootstrap-sign.yml`.
No local build machine is in the signing trust chain.

### Release runbook (shell)

1. Bump `version="…"` in `packages/shell-tizen/tizen/config.xml` and merge to
   `main`. (The workflow refuses a tag whose version differs from config.xml.)
2. Tag the release commit and push the tag:

   ```bash
   git tag jellyplug-v<version> <commit>
   git push origin jellyplug-v<version>
   ```

3. CI (`release-tizen.yml`) stages the widget from the tagged source, strips
   the QA seed (JEL-100), signs it, runs the JEL-8 signed guard and the
   JEL-121 source-match guard (kept as defense-in-depth), and publishes a
   GitHub Release with `JellyPlug_v<version>.wgt` attached.
4. Install on the TV from the Release asset. On-TV byte-identity verification
   (JEL-25 method) compares against this CI-produced artifact — download it
   from the Release (or the Actions run artifact) and compare hashes.

Do **not** build locally and commit a `.wgt` before tagging — that flow was
retired. A dry run without tagging is available via the workflow's
`workflow_dispatch` trigger (uploads the artifact, publishes no Release).

## Bootstrap `.wgt` — still committed (separate trust chain)

```
release-artifacts/
  bootstrap/
    v<version>/
      JellyPlugBootstrap_v<version>.wgt   # signed HSB bootstrap + manifest
```

The HSB bootstrap is signed in CI by `.github/workflows/bootstrap-sign.yml`
(tag `bootstrap-v*`) and the resulting artifact is committed here alongside
its manifest for on-device byte-identity verification (JEL-25). Every
committed `.wgt` is still checked by CI's `verify-artifacts` job (JEL-8):
it must carry author + distributor signatures.
