# JELA-797 — the "~3.67 MB localStorage cliff" is not a cliff

**Status: investigation complete, premise REFUTED. No sweep shipped.**
Measured 2026-08-28 on the pinned Chromium 63 rig (`/tmp/local-tizen-tester`),
booting the real prod shell.

JELA-796 observed an aged rig profile die 4/4 while a fresh one ran 9/9, and
inferred a localStorage quota cliff at ~3.67 MB. The issue was explicit that the
link was correlational and that step 2 — measure the real quota — had to close
the gap **before** any eviction code was written. It does not close it. It
refutes it.

---

## 1. The quota is 5,242,880 characters, and the store never reached it

Fresh profile, rig origin, write until the first throw, refined 32K → 1K → 64
char chunks:

| | value |
|---|---|
| ceiling reached | **5,242,876 chars** (= 5 Mi chars − 4) |
| exception | `QuotaExceededError`, `code: 22` — **visible, not silent** |
| non-ASCII (U+00E9) ceiling | 5,210,797 chars — **same ceiling** |

The identical ceiling for 2-byte characters proves accounting is per **UTF-16
code unit**, so the limit is 5 Mi *characters* (10 MiB of UTF-16 bytes).

This is the unit error at the heart of the parent issue. JELA-796 summed
`k.length + v.length`, which counts **characters**, and reported it as "MB". Its
"3.67 MB" is 3,674,995 characters — **70.1% of the quota**. The store the aged
profile died on had ~1.57 million characters of headroom left.

## 2. A completely full store does not break `fetch()`

With the store filled to the ceiling, a `fetch()` to the server returned
`{ok: true, status: 200, len: 215}`. Quota exhaustion cannot produce the
`net::ERR_ABORTED` the parent issue cited.

## 3. All 26 main-path `setItem` sites are inside a `try`

Tokenizer-based audit of `packages/shell-tizen/src/shell.js` (strings, comments
and regex literals stripped first, so the seed-side code that lives inside JS
string literals is excluded and audited separately): **26 code-level
`localStorage.setItem` call sites, 26 guarded, 0 unguarded.** A quota-full store
degrades the shell to "cache never helps"; it has no unguarded write to throw
from and abort a boot chain.

## 4. The direct causal test: dead boots happen with no quota pressure at all

One profile, six boots, padding as the only variable. `domCards` is read from the
DOM over CDP, **not** from `__707.state` — rec707 writes that state into
localStorage inside a swallowing `catch`, so on a full store a healthy boot would
have reported as dead. Both readings agreed on every boot, so that particular
confound did not fire.

| boot | mode | store at nav | `qe` | reqs | domCards |
|---|---|---|---|---|---|
| 0 | none (cold) | 449 | 0 | 529 | 263 ✓ |
| 1 | none | 1,850,158 | 0 | 491 | 279 ✓ |
| 2 | **padded to quota** | 5,242,824 | 1 | 227 | **0 ✗** |
| 3 | **padded to quota** | 5,242,837 | 4 | 448 | 279 ✓ |
| 4 | unpadded | 1,850,833 | 0 | 438 | 279 ✓ |
| 5 | none | 2,867,463 | **0** | **44** | **0 ✗** |

**Boot 5 is the result that settles it.** No padding, store at 2.87 M chars —
55% of quota, *below* the alleged 3.67 M cliff — `window.__shellLsQuotaErr = 0`,
so the shell hit no quota error whatsoever. It died anyway, with **44 requests**:
the exact signature JELA-796 attributed to the cliff ("~44 requests and no
render").

Two further points from the same table:

- `net::ERR_ABORTED (canceled) Fetch` appears on boot 3, which rendered **279
  cards**. It is present in healthy boots and is not a failure signature.
- Dead boots occur in both arms (1/2 padded, 1/4 unpadded). n is far too small to
  estimate a rate, but a rate is not needed: a single unpadded, quota-clean dead
  boot refutes the causal claim.

## 5. The growth curve was misread too

JELA-796 read boots 0→8 growing 415 → 3,674,522 as accumulation across boots. On
this run the store reached **3,618,074 chars during the very first cold boot**
(boot 0). ~3.6 M chars is the steady-state size of one full plugin set, reached
immediately — not something that builds up over nine boots. The 796 curve was
partly an artifact of localStorage not flushing fully between SIGKILLed boots
(visible here too: boot 0 ended at 3,618,074 and boot 1 started at 1,850,158).

Its key count also *plateaued* at 227 over boots 7→8 (+11 KB), which is a bounded
key set saturating, not an unbounded axis.

---

## What IS real (and is not this issue)

The census of the aged 796 profile (228 keys, 3,674,995 chars) does show two
genuine defects. Both are about **cache efficiency and degraded plugin
behaviour at quota**, not about boots dying — so they are split out rather than
fixed here.

**(a) A plugin version bump orphans the previous generation, with no sweep.**
The seed-side `__txSet` (shell.js ~L1888) stores the **full body** under
`__txKey(url)`, which deliberately keeps a `?v=` version token (only 12–14 digit
epoch busters are stripped). Nothing removes `path?v=OLD` when `path?v=NEW`
appears: the seed maintains no `vqk:` index, and the main shell's
`txRecordQuerySlot` one-generation cleanup (L5929) only runs for URLs the main
shell itself fetches — the census found **3 `vqk:` entries against 163 plain
slots**, so ~160 seed-written slots are never generation-swept.

Measured cost: 163 plain slots / 1,882,682 chars, of which essentially all the
large entries carry `?v=12.4.1.0-<ticks>`. So one JellyfinEnhanced version bump
adds a fresh ~1.84 M-char generation on top of a ~3.67 M-char store:
**3.67 M + 1.84 M = 5.51 M > 5.24 M quota.** One version bump is enough to pin
this store at the ceiling.

**(b) The largest single entry can never be evicted.**
`__txPrune` (L1887) removes the 10 LRU-oldest keys *from the `__txLru` map*. Only
`__txGet`/`__txSet` populate that map. The main-shell writers `txSetStatic`
(L6015) and `txRecordQuerySlot` never touch it, so the content-addressed `txc:`
bodies are invisible to the pruner — including the single biggest key in the
store, `shell.tx1t1at4s:txc:<hash>` at **901,582 chars (24.5% of the whole
store)**. At quota the pruner evicts small seed entries 10 at a time while the
901 KB body stays forever. `txSetStatic`'s own quota `catch` does not prune at
all; it just counts the lost write.

Boot 3 shows what "at quota" costs in practice even when it renders: a cascade of
`TypeError: Cannot read property '<x>' of undefined` from plugin scripts whose
dependencies never got cached.

Filed as a follow-up (see the issue thread). It wants a proactive generation
sweep plus LRU-tracking for `txc:` bodies — and, per house rules, a control arm
that shows the defect before anything flips.

## Not done

**Step 3 (check a real Q60R panel's store size) did not run**: there is no `sdb`
binary in this container, so the panel is unreachable from this run. It is also
now much less urgent — the number it would produce (~3.6 M chars, one plugin
set) is no longer a cliff to compare against. It becomes relevant again only for
follow-up (a): a panel that has lived through a plugin version bump is the place
to confirm the 5.51 M arithmetic.

---

## Appendix — how to re-run

Three scripts, written to `/tmp/jela797-rig/` (not tracked; workspace is not
durable):

1. **`quota797.mjs`** — fresh profile, fills in 32768/1024/64-char chunks until
   `QuotaExceededError`, records name/code/message, then re-tests `fetch()` on a
   full store and repeats the fill with U+00E9 to settle bytes-vs-code-units.
2. **`census797.mjs`** — copies the (concurrently held) 796 profile and reads it
   at **the same origin the ring used**, `http://127.0.0.1:8796`. A different
   port is a different origin and reports an empty store as a clean result. The
   values are snappy-compressed in LevelDB, so a `strings` scan of
   `Local Storage/leveldb/*.ldb` silently misses most of them — it must be read
   through a browser. Groups keys by shape and counts generations per path.
3. **`boot797.mjs`** — the six-boot self-controlled ring above. Two independent
   render readings (DOM over CDP + `__707.state`) because the 796 dead-boot
   signature is read entirely out of localStorage through a swallowing `catch`.
   Credentials are seeded **before** padding, or a padded boot tests "no
   credentials" instead of "no headroom".

Ports are private to each script (8801/9801, 8796/9802, 8802/9803) because the
796 ring may be running concurrently, and a shared port is a shared origin.
