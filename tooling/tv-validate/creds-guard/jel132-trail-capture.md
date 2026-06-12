# JEL-132 — on-device creds trail capture: hard-restart logout = localStorage rollback

2026-06-12, physical M63 (QN82Q60RAFXZA, Tizen 5.0). Reads the per-boot
creds trail (`jellyfin.shell.credsTrail`) recorded by the v2.0.11
creds-guard (PR #41) across the user's live reproduction of "login page
after hard TV restart", via a QA capture build (`qa/jel132-capture` @
6013c67, sign run 27429676648) using the JEL-130 beacon + cfg-topic
farewell loop. Raw beacon payloads: `jel132-trail-payloads.json`.

## Trail (5 boots; ts are TV wall-clock epoch ms)

| boot (UTC≈) | p (creds key) | t (tokens) | ls (LS keys) | reading                                  |
| ----------- | ------------- | ---------- | ------------ | ---------------------------------------- |
| 16:36:51    | 0 (absent)    | 0          | **16**       | first boot after the user's HARD restart |
| 16:38:58    | 0 (absent)    | 0          | 18           | relaunch, still logged out               |
| 16:46:28    | 1 (server)    | 0          | **76**       | caches repopulated; server entry back    |
| 16:49:09    | 1             | 0          | 76           | relaunch                                 |
| 16:54:08    | 1             | 0          | 79           | QA capture boot (this session)           |

Guard counters at capture: `strips: 0, vetoes: 0, lo: 0, lastVal: null` —
across every recorded boot. `enableAutoLogin` is unset (defaults true).
User confirmed the login form's "Remember me" is checked.

## Verdict

**Storage-level rollback, not a credential strip.** jellyfin-web never
wrote a token-removal while the guard watched (zero strips), and the token
was already gone at the first post-restart boot — together with ~60 other
localStorage keys (76+ → 16). Tizen 5.0 commits localStorage lazily; a
forced (hold-power) restart discards everything since the last durable
commit. Recently written keys (the login token, tx caches) die; ancient
keys (the shell's serverUrl, written days ago) survive — which is exactly
the user-visible "server remembered, user login re-asked" signature.

Control: the user's menu-driven TV restart at ~16:43 (Developer-Mode IP
change) lost nothing — writes from the 16:38 session were all present at
16:46 (ls 18 → 76). Only the hard cut rolls back. The v2.0.11
validate-clear guard (JEL-132 v1) is real but orthogonal — no
localStorage-write veto can survive a storage rollback.

Side finding (JEL-131 relevant): the same rollback wipes the JEL-557/JEL-131
transpile caches, so a hard power-cut re-triggers the cold-boot Babel storm
on the next boot.

## Fix direction (v2)

Mirror `jellyfin_credentials` into IndexedDB (transactional, durable across
power-cuts) from the existing guard's setItem wrap, with logout/401
invalidation so intentional sign-outs are never resurrected; restore at
boot (both shells' pre-rewrite async path) when localStorage has no token
but the vault holds a valid one. Trail event `restore` records each firing.

## End state

cfg-topic farewell cleared `jellyfin.qa.*` and exited; retail
`JellyPlugBootstrap_v2.0.11.wgt` (release asset sha `2bc589be…51a9`)
reinstalled; user creds/trail untouched throughout (probe reports presence
flags and counters only — token values never leave the TV).
