# Legacy TV emulators — testing Tizen 5.0 / 5.5 (and older)

> JEL-5. Investigation + procedure for running **old** Samsung TV emulator
> images (Tizen 5.0 = 2019 TVs, Tizen 5.5 = 2020 TVs) under Tizen Studio.
> This is a deeper cut of **Tier 3** in [`README.md`](./README.md) — same tool
> (Tizen Studio TV emulator), but pinned to old platform images instead of the
> latest one the Package Manager offers by default.

## TL;DR

- **Yes, it's doable.** A **Tizen 5.5** TV emulator is the realistic target:
  its TV Extension is still on Samsung's public archive (TV Extension 5.5.0,
  Dec 2019). A **Tizen 5.0** emulator needs an older TV SDK that predates the
  current archive (oldest archived is 5.5.0) — you can still stand it up via the
  manual platform-image merge, but the image is harder to source.
- **Why we'd bother:** old TVs run an old Chromium WebView. The whole HSB +
  polyfill design in this repo exists for exactly that engine gap. A 5.0/5.5
  emulator is the only no-hardware way to exercise the real old engine.
- **Can't be done in this sandbox** (no Tizen Studio, no GUI, no HW
  virtualization). This doc is the verified procedure; an actual boot + WGT
  install on the image needs a machine with Tizen Studio + HAXM/KVM. See
  [Escalation](#escalation--what-still-needs-a-real-machine).

## Why an old-engine emulator is worth it

Our shipped WGT (`required_version="2.3"`) installs on every Samsung TV from
2015 on, but the **WebView engine** under it changes drastically by model year.
That engine — not the Tizen API level — is what breaks the hosted Jellyfin web
client. Samsung's
[Web Engine Specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html):

| Tizen | Model year | Web engine    | Notes for us                                                      |
| ----- | ---------- | ------------- | ---------------------------------------------------------------- |
| 2.3   | 2015       | WebKit r152340| pre-Chromium; oldest target our `required_version="2.3"` allows  |
| 2.4   | 2016       | WebKit r152340|                                                                  |
| 3.0   | 2017       | Chromium M47  |                                                                  |
| 4.0   | 2018       | Chromium M56  | **this is the "Chromium-56 polyfills" the repo carries**         |
| 5.0   | 2019       | Chromium M63  | **JEL-5 target**                                                 |
| 5.5   | 2020       | Chromium M69  | **JEL-5 target**                                                 |
| 6.0   | 2021       | Chromium M76  |                                                                  |
| 6.5   | 2022       | Chromium M85  | roughly what the default Tier-3 image (`tv-6.5`/`7.0`) gives you |
| 7.0   | 2023       | Chromium M94  |                                                                  |

The default Tier-3 emulator image (whatever the current Package Manager ships,
~M85+) does **not** reproduce M56/M63/M69 behaviour. If a 2019/2020 TV renders
the web client wrong but a 2022 emulator looks fine, the only no-hardware way to
catch it is to boot the matching old image. That's this doc.

## What's actually available (the core finding)

Samsung versions the **TV Extension** to the Tizen platform it carries, and
keeps old ones on the
[TV Extension archive](https://developer.samsung.com/smarttv/develop/tools/tv-extension/archive.html).
As of this investigation the archive's floor is:

| TV Extension     | Released     | Platform image it carries |
| ---------------- | ------------ | ------------------------- |
| 10.0.0 … 6.5.x   | 2026 … 2022  | Tizen 8.0 … 6.5           |
| **6.0**          | Jan 2021     | **Tizen 6.0**             |
| **5.5.0**        | **Dec 2019** | **Tizen 5.5** ← floor     |

So:

- **Tizen 5.5 emulator → supported-ish.** Install TV Extension **5.5.0** from
  the archive; its emulator image is `tv-samsung-5.5-x86`.
- **Tizen 5.0 emulator → legacy.** Its TV SDK (TV Extension ~4.0 era, paired
  with **Tizen Studio 3.x**) is **older than the archive floor**. Samsung's own
  2019 walkthrough confirms the image existed —
  [Launch on a Samsung TV 5.0 emulator](https://developer.samsung.com/tizen/blog/en/2019/01/24/launch-your-tizen-net-application-on-a-samsung-tv-50-emulator)
  launches `tv-samsung-5.0-x86` from the Tizen Studio 3.0 Emulator Manager — but
  you'll need to source that platform image (older Samsung mirror or an existing
  install) and side-load it via the manual merge below. Modern Tizen Studio's
  Package Manager will not offer it.

**Recommendation:** treat **Tizen 5.5 (M69)** as the primary old-engine target —
it's the lowest one we can stand up cleanly from the public archive, and it
covers the 2020 model-year cohort. Add **5.0 (M63)** only if a bug is suspected
to be specific to 2019 panels; the M63↔M69 gap is small, so 5.5 is a good proxy.

## Procedure A — Tizen 5.5 via archived TV Extension (recommended)

Modern Tizen Studio + the archived 5.5.0 extension. This is the clean path.

1. Install **Tizen Studio** (current is fine for 5.5; for 5.0 use 3.x — see B).
2. **Package Manager → drop in the archived extension.** Download
   *TV Extension 5.5.0* (Dec 2019) for your OS from the archive page above.
   Package Manager → ⚙ **Extension SDK** → add the local package / extra repo,
   then install the **Samsung TV** tools it provides.
3. **Emulator Manager → Create** → device template **TV**, platform
   **`tv-samsung-5.5-x86`** → finish.
4. **Launch** (GUI button or `tizen emulator launch -n <name>`). It registers
   with `sdb` like any target:
   ```bash
   sdb devices            # emulator-2610x  device  <name>
   ```
5. **Package + install + run our WGT** — identical to the Tier-3 flow:
   ```bash
   cd packages/shell-tizen-bootstrap/src
   rm -f JellyfinShell.wgt          # stale .wgt -> installing[17]; see root README
   tizen package -t wgt -- .
   tizen install -n JellyfinShell.wgt -t <emulator-name>
   tizen run -p JelShellTV.Jellyfin -t <emulator-name>
   ```

## Procedure B — legacy manual platform-image merge (5.0, or 5.5 offline)

When the platform image isn't installable through Package Manager (the 5.0 case,
or an offline 5.5), merge the image into Tizen Studio by hand. Distilled from the
community
[Setup Legacy Tizen (Samsung) Emulator](https://gist.github.com/PatrickSt1991/efc5dba3f57dd55332229c068553328a)
writeup:

1. Download the archived image package for the target (`TIZEN-SDK-IMG_*`).
2. Unzip it, go to `.../TIZEN-SDK-IMG_*/binary`, and **extract every zip in
   that `binary` folder into the same dir** — they share overlapping paths and
   are meant to merge.
3. Copy the resulting `platforms/tizen-<ver>/tv-samsung` folder into your Tizen
   Studio install, e.g. `…/tizen-studio/platforms/tizen-5.0/tv-samsung`.
4. Open **Emulator Manager** — the side-loaded image now appears as a creatable
   TV template. Create + launch, then package/install/run exactly as in A step 5.

## Gotchas (all confirmed during this investigation)

- **HW virtualization is mandatory.** The TV emulator is QEMU and needs Intel
  HAXM, KVM (Linux), or Hyper-V. If launch hangs at boot, it's almost always the
  accelerator, not the image.
- **Old DevTools need an old Chrome.** Remote-inspecting a 5.x emulator WebView
  breaks on Chrome 64+ (the legacy DevTools protocol changed); use **Chrome 63**
  (archived builds) and, if the inspector looks dead, read the launch log for the
  forwarded `localhost:<port>` and navigate to it manually. For our app you can
  usually skip this — the on-screen **HSB diagnostic overlay** baked into
  `index.html` already reports `__hsbState` / `__hsbShellUrl` / `__hsbFallback`
  on-screen, no inspector required.
- **Signing still applies.** Even on the emulator, `tizen package` needs a
  certificate profile (Certificate Manager). An **author** profile is enough to
  install; a Samsung partner/distributor cert is only for store/privileged APIs.
- **The stale-`.wgt` rule applies here too.** `tizen package -t wgt -- .`
  bundles everything in the CWD, so a leftover `JellyfinShell.wgt` gets packed
  inside the new one and fails signature verify at `installing[17]`. Always
  `rm -f JellyfinShell.wgt` first (root `README.md`).
- **5.0 needs Tizen Studio 3.x.** The 5.0 TV SDK was built against the 3.x
  Emulator Manager; pairing it with a current Studio can fail to register the
  template. Keep a 3.x install (or a VM) if 5.0 is a hard requirement.

## How this fits our test tiers

This is **Tier 3, pinned to an old image**. Relative to the rest of the strategy
([`README.md`](./README.md)):

- **Tier 2 (`wgt-emulate`)** runs the bootstrap flow in *desktop* Chromium —
  always a modern engine. It can fake an old UA but **cannot** reproduce M63/M69
  engine quirks. (It already can't fully boot the hosted shell on modern headless
  Chromium — that's the documented Tier-2 limit.)
- **This legacy Tier 3** is the *only* no-hardware way to run the genuine
  2019/2020 WebView. Reach for it when Tier 2 is green but a 5.0/5.5-era TV
  misbehaves, to tell "old-engine regression" apart from "our bug."
- **Tier 4 (real 2019/2020 TV)** remains the final word, but the emulator catches
  most old-engine breakage first and needs no panel on a desk.

## Escalation — what still needs a real machine

This sandbox has **no Tizen Studio, no GUI, and no HW virtualization**, so the
image could not be *booted* here and our WGT could not be installed on it. The
procedure above is verified against Samsung's archive + engine specs and the repo
packaging rules, but the live confirmation step — boot `tv-samsung-5.5-x86`,
`tizen install` our `JellyfinShell.wgt`, confirm the hosted shell renders the
Jellyfin client on the M69 engine — needs a host with Tizen Studio + HAXM/KVM.
That host already exists in this project for real-TV installs (root `README.md`
assumes a Tizen Studio box). Recommend doing the one-time 5.5 emulator validation
there; if it surfaces M69-specific rendering bugs, file them as child issues of
JEL-5.
