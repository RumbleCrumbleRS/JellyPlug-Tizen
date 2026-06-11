# JEL-125 — Fresh-install delay: cold-boot decomposition from the JEL-116 on-device run

**Verdict: the ~60 s the user sees per transition is NOT an error or a hang — it is the
M63 (Tizen 5.0 / Chromium 63, 2018 silicon) parsing + executing the jellyfin-web bundles,
plus home data/render. Zero JS errors in every beacon tick. The shell-owned pre-handoff
span is already fast (~4 s on a fresh first connect).**

## Source data

`jel116-ntfy-raw.jsonl` (this directory) — the full ntfy.envs.net beacon stream from the
JEL-116 on-device fresh-install verification run (2026-06-10, physical M63 QN82Q60RAFXZA,
server `https://REDACTED-SERVER.example`), recovered from the ntfy cache on 2026-06-11 before
its 12 h expiry. Two runs:

- **Run 1 (stored-URL path)** — launch 20:10:58, localStorage intact from prior install.
- **Run 2 (fresh path)** — launch ~20:16:19, pre-bootloader clear (88 keys) = bit-identical
  to a true fresh install from the bootloader's perspective; auto-submit of the connect
  form at 20:16:25 simulating the user pressing Connect.

QA beacon ticks every 4 s once live (5 s after the written doc's DOMContentLoaded);
`qcState=loggedIn` from the first tick because the harness pre-seeded credentials, so the
user's two manual transitions (connect→user picker, sign-in→home) are merged into one span
here.

## Fresh-run timeline (run 2)

| Wall clock        | Δ from submit | Event                                                                                                                            |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 20:16:25          | 0 s           | connect-form submit fires                                                                                                        |
| 20:16:26          | ~1 s          | manifest 404 → hosted shell 404 → baked boot-shell loaded                                                                        |
| ~20:16:29         | ~4 s          | `document.write` handoff + written-doc DCL (first beacon at :34 = DCL+5 s)                                                       |
| 20:16:34–:51      | 9–26 s        | jellyfin-web defers executing (`AF` counter climbing, `RE:5/0`)                                                                  |
| 20:16:51–20:17:11 | 26–46 s       | **~20 s main-thread blackout** — beacon cadence stops; `RE` jumps 5→19 (custom-element registration inside vendors/main execute) |
| 20:17:11          | 46 s          | `#/home` route reached, spinner up                                                                                               |
| 20:17:20          | 55 s          | 266 cards rendered (133 real), steady state, `errs=0` throughout                                                                 |

Run 1 (stored URL, warm localStorage) shows the SAME shape: ~3 s to handoff, ~20 s
blackout (20:11:22→20:11:42), cards at ~52 s. Warm shell caches did not remove the
dominant cost — because the dominant cost is not shell work.

## Decomposition

| Phase                                   | Cost  | Owner                                                                                           |
| --------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| Submit → document.write (shell-owned)   | ~4 s  | shell (manifest probe chain, /web fetch, bundle scan, transpile gate — `tx=0`, bundle scan hit) |
| jellyfin-web parse + execute → `#/home` | ~40 s | jellyfin-web bundle size × M63 CPU                                                              |
| Home data fetch + 266-card render       | ~9 s  | server RTT + M63 layout                                                                         |

The user's report ("60 s to user picker, 60 s after sign-in") matches: their first span =
submit → interactive user picker (≈45–60 s incl. picker render); their second span =
post-auth route/home-section loads + images on the same slow engine, plus a truly-fresh
install also pays cold HTTP cache (full bundle download over DDNS hairpin) and cold V8
code cache, both of which warm up by the second boot — hence "might not happen after
initial install".

## What this rules out

- **No hanging error**: `errs=[]` in every tick of both runs (the user hypothesized "maybe
  there is an error happening hanging it up" — there is not).
- **No 60 s timeout being hit**: all shell timeouts are 1.5/4/5/15 s; none fired.
- **Not transpile/babel**: `tx=0` both runs; babel parse is ~0.5–0.8 s on-device when it
  does run (JEL-1973 measurement).

## Shell-side levers (JEL-125 scope)

1. **Bootstrap prefetch parity (landed with this commit)** — the shipped bootstrap's
   `index.html` started ZERO network until baked boot-shell was parsed (manifest 404 →
   hosted 404 → boot-shell load all serialized ahead of the `/web/` RTT pair).
   shell-tizen's `index.html` has had a head-IIFE prefetch into `window.__shellPrefetch`
   since JEL-58, and boot-shell ALREADY adopts that global — the bootstrap just never
   primed it. Now `loadHostedShell()` primes index+config fetches at submit time (fresh)
   and at stored-URL boot, overlapping them with the manifest probe chain. Worth ~2–4 s
   per boot.
2. **Eager babel kick on legacy first connect (landed with this commit)** — on a fresh
   install the babel verdict is unlearned so the 2.4 MB fetch+parse serialized at
   first-transpile inside the pre-write path; now kicked at `loadHostedShell()` on legacy
   UAs (gated; see index.html comments). Worth ~0.5–1 s on fresh boots.
3. **Out of shell reach**: the ~40 s parse/execute is jellyfin-web's bundle weight on
   2018 TV silicon. A "~10 s to user picker" target on the M63 is not reachable by shell
   changes alone. Candidate follow-ups: boot progress indication (compositor-driven
   spinner survives the main-thread blackout, makes the wait legible instead of
   broken-looking), and investigating whether the localStorage bundle-inlining fast path
   defeats Chromium's V8 code cache on warm boots (inline scripts get no code cache;
   `<script src>` does after repeat runs).

## Follow-up verification

On-device re-capture after this fix ships needs a board-approved idle window and wipes
the user's login again (fresh-state simulation, JEL-116 method) — tracked in the JEL-125
child issue.
