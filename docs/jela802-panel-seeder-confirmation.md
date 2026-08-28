# JELA-802 — does the jp758 seeder land on a real Q60R panel?

Belt-and-braces rider on the JELA-758 fleet flip, which is **live and not held on
this**. The question is narrow: the JELA-112 virtual rig proved the gate itself
(AC1–AC5, flag seeded directly) but **cannot** prove the seeder's last mile,
because that `file://` harness fetches `/JavaScriptInjector/private.js` (0 bytes)
and never requests `public.js` at all — where all 102 `CustomJavaScripts` entries
live. Only a real panel closes that gap.

Budget ~20 minutes of panel time. The driver
(`jela802-panel-seeder-confirm.mjs`, Node ≥ 22, no deps) is attached to the
JELA-802 issue thread rather than committed — an on-device QA harness under
`tooling/` is exactly what the JEL-141 guard
(`tooling/ci/check-no-debug-evidence.sh`) rejects, same convention as
[JELA-718](./jela718-panel-warm-cache-procedure.md).

## Status as of 2026-08-28

**Not yet run — the Q60R was off-network.** A full `192.168.86.0/24` sweep found
26 live hosts and **zero** answering `:8001`, `:8002`, `:9197` or `:26101`. This
is not the stale docker-bridge blocker: the LAN is genuinely routable from the
container (gateway `:80` → 200; an unused address gives `No route to host`
immediately; the dev PC `.38` RSTs and serves `:8080`). A Samsung panel that
answers nothing on `:8001` is powered off or off Wi-Fi. Re-run when it is on.

Everything that does **not** need the panel was verified instead — see
[Off-panel evidence](#off-panel-evidence-verified-2026-08-28).

## Read this before you interpret anything

**The flag engages on the NEXT boot, not the boot the seeder runs on.** The shell
reads the key with `flg()` (strict `=== "1"`) inside `instantHomeBody`, which runs
when `shell.min.js` loads — long before the JSI channel executes. So the proof is
necessarily **two boots on one profile**: boot 1 seeds, boot 2 arms. A one-boot
run that reports `__shellSG.on !== 1` has proved nothing.
(Contrast JELA-768/801, whose gate is a per-call read and engages same-boot.)

**Always poll the two already-live sibling seeds as a control.** `jp788`
(`jellyfin.shell.queryAuth`) and `jp801` (`jellyplug.filterbar.pageCache`) are
flipped and confirmed live on the fleet. The verdict table:

| `searchGate` | `queryAuth` / `pageCache` | Verdict                                                            |
| ------------ | ------------------------- | ------------------------------------------------------------------ |
| present      | present                   | `CONFIRMED` — seeder lands                                         |
| absent       | absent                    | `INCONCLUSIVE` — the JSI channel never ran; **not** a jp758 signal |
| absent       | present                   | `DEFECT_JP758_SPECIFIC` — ping FE, roll back                       |

Without that control a null reads as "my flip is broken" and you roll back a
working flip. This is the technique that made the rig's null a _harness_ fact.

**A slow boot is not a flag bug.** With the JSI channel enabled the boot needs a
long settle — `public.js` is ~906 KB and is transpiled on this engine. On the rig
a 45 s read gave a zero-card boot and a 110 s read gave a clean 279-card boot.
The driver polls to 180 s. Do not read a zero-card early sample as a failure.

## Procedure

```bash
export SDB=/path/to/sdb        # sdb 4.2.36, see the tizen-cdp-boot-harness recipe
cd <local workspace holding the driver from the JELA-802 thread>

# Full two-boot proof: removes the key, boots (seeds), boots again (arms).
node jela802-panel-seeder-confirm.mjs --reset

# Optional extra AC — the per-keystroke request slice should collapse to [0,0,0,0,0,N].
node jela802-panel-seeder-confirm.mjs --reset --typing
```

Writes `jela802-result.json`; attach it to the JELA-802 thread. Exit `0` =
`CONFIRMED`, `2` = panel unreachable, `1` = anything else — read `verdict`.

The driver **sweeps** for the panel and confirms identity from the REST banner
(`modelName: QN82Q60RAFXZA`). Never hardcode the IP: it is DHCP and has already
moved `.202` → `.249`, and a stale address fails as `EHOSTUNREACH`, which looks
exactly like the old no-route blocker but means "wrong IP".

### Acceptance

1. `localStorage.getItem('jellyfin.shell.searchGate') === '1'`
2. `window.__shellSG && window.__shellSG.on === 1` — **on boot 2**
3. (optional) six-character query → per-keystroke slice `[0,0,0,0,0,N]`

### Panel handling rules that this driver encodes

- Close the app with the **Samsung REST** verb
  (`DELETE :8001/api/v2/applications/JelShellTV.Jellyfin`), never the sdb
  `0 kill` verb. `0 kill` has flipped this panel from workable to hard de-auth
  mid-session, and a power cycle is only a probabilistic fix.
- Re-run `sdb connect` **between** `shell 0 debug` and `forward` — the debug call
  kills the sdb server, so the forward otherwise fails `target not found`.
- Bound `0 debug` with a timeout. Its failure mode is an indefinite **hang**, not
  an error. If it hangs, hand off with static evidence; do not loop a human
  through power cycles.
- The CDP client carries a keepalive **and** a watchdog. A dropped CDP socket
  exits Node `0` with no output and reads exactly like a passing run that wrote
  nothing.
- `performance.setResourceTimingBufferSize(4000)` on **every** tick or the
  waterfall silently truncates at Chrome 63's default of 150 entries.
- Restore released state afterwards: `forward --remove`, `0 execute <appid>`,
  `kill-server`.

## Off-panel evidence (verified 2026-08-28)

Re-verified live rather than inherited, because a JSI config `POST` replaces the
**whole** entry list — a sibling agent's deploy can silently drop an entry.

**Served `/JavaScriptInjector/public.js`** — `200`, 906,708 B, sha256
`02603fe7…9933f9`. Marker counts: `jp758seed` ×1, alongside `jp788seed` ×1,
`jp801seed` ×1, `jp786seed` ×1, `jp789seed` ×1.

**JSI plugin configuration** — 102 entries; the three seeders are shape-identical:

| entry       | keys                                         | Enabled | RequiresAuthentication |
| ----------- | -------------------------------------------- | ------- | ---------------------- |
| `jp758seed` | `Name,Script,Enabled,RequiresAuthentication` | `true`  | `false`                |
| `jp788seed` | `Name,Script,Enabled,RequiresAuthentication` | `true`  | `false`                |
| `jp801seed` | `Name,Script,Enabled,RequiresAuthentication` | `true`  | `false`                |

**The seeder snippet executes correctly** — extracted from the served config
(922 B, `node --check` clean) and run against a stub `localStorage` in `vm`:

| key before | key after | note                        |
| ---------- | --------- | --------------------------- |
| absent     | `"1"`     | seeds                       |
| `"0"`      | `"0"`     | per-TV kill switch survives |
| `"1"`      | `"1"`     | idempotent                  |

Exactly one key written in every case.

**Served `/shell/shell.min.js`** — `200`, 238,833 B, sha256 `3ec5c49f…44b226`
(matches the sha recorded at the flip), carrying the reader: `__shellSG` ×2,
`jellyfin.shell.searchGate` ×3, `searchGateMs` ×1.

So the only unproven link is **"does a real panel execute `public.js` at all"** —
and `jp788` / `jp801`, which ride the same list with the same shape, are already
confirmed live on real panels. That is the parity argument this ticket exists to
upgrade into a direct measurement.

## If it fails

The flip is live and is not held on this. If acceptance (2) is false on a real
panel **while the control keys are present**, ping FE and roll back with
`node flip758.mjs --rollback --execute`. That swaps the seeder for a **remover**,
not a delete — a plain delete would leave every already-seeded TV latched ON.
