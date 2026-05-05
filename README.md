# jellyfin-tv-shell

Thin browser-shell apps for Jellyfin on TV. Each platform shell loads the
**live** Jellyfin web client from `${server}/web/` so server-installed plugins
work 1:1 on TV - the same code, the same plugins, every platform.

## Status

Scaffold only. The directory layout, CI, and conventions are in place; the
shells are stubs. First runnable target is the Tizen prototype tracked in
`JEL-3`. Architecture rationale lives in the `repo-structure` document on
`JEL-4` and the `roadmap` on `JEL-2`.

## Layout

```
packages/
  shell-core/      # shared TS: connect screen, NativeShell types, key maps,
                   # server validation
  shell-tizen/     # Samsung Tizen .wgt
  shell-webos/     # LG webOS .ipk
  shell-android/   # Android TV .apk (Kotlin/Gradle)
tooling/
  eslint-config/   # shared eslint preset
  tsconfig-base/   # shared tsconfig
  ci/              # shared GHA helpers
.github/workflows/
  ci.yml                # lint + typecheck + per-platform build matrix
  release-tizen.yml     # tag tizen-v* -> signed .wgt
  release-webos.yml     # tag webos-v* -> .ipk
  release-android.yml   # tag android-v* -> signed .apk
```

## Local commands

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run build
```

## License

GPL-2.0-only, matching the rest of the Jellyfin org.
