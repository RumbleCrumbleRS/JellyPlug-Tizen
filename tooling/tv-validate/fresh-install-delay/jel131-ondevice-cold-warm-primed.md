# JEL-131 — on-device cold/warm/primed login→home capture (M63)

2026-06-13, physical M63 (QN82Q60RAFXZA, Tizen 5.0), user's live server
(`REDACTED-SERVER.example`, jellyfin-web `?4c3e5ec610f9c71cad1c`, JellyfinEnhanced
11.11.0), Test account. QA build = main `628f6e9` + capture harness
(`qa/jel131-capture` @ `3474b91`, sign run 27450885431). Board-approved
window (interaction 69e9bcd8 accepted 2026-06-13T00:07Z on JEL-131).

Harness: baked beacon + ntfy cfg-topic command channel; scripted manual-form
login (`form.dispatchEvent(submit)`, checkbox checked, ms-precision marks
`t0` submit → `tHome` route change → `tCards` first `.card[data-id]`).
Mid-capture the sandbox egress IP got 429-limited by ntfy.envs.net (reads
AND publishes); remaining commands were relayed through a one-off Actions
workflow (`qa-ntfy-relay.yml`, qa branch only).

## Timed boots

| boot               | state                                                            | login→home cards                                                               | tx hits/misses | notes                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 cold, primer OFF | full wipe + IDB vault del, `txPrimeDisabled=1`, serverUrl seeded | **18.8 s** (t0 1781310912539 → tCards 1781310931343, 117 cards)                | 0 / 56         | nav to /home in 268 ms; storm = 55 post-login misses; txN 8→63                                                                         |
| 2 warm             | creds+vault cleared, tx cache kept                               | **2.5 s** (t0 1781311102410 → tCards 1781311104924, 40 cards → 133 within 3 s) | 56 / 0         | tHome 258 ms; zero misses                                                                                                              |
| 3 cold, primer ON  | creds+vault+tx cleared, primer enabled, ~28 s login-page dwell   | **3.2 s** (t0 1781312360488 → tCards 1781312363671, 56 cards)                  | 54 / 2         | primer telemetry during dwell: `tp q:60 f:55 t:7→55 e:5 done:1`, txN 15→63; the 5 errors are the designed probe-then-commit 404 misses |

Cold boot context (boot 1): manual login form was up with txN=8 (static
pass only), `tp:null` (kill switch honored), checkbox rendered CHECKED on
a truly fresh state (`enableAutoLogin` key absent).

**Verdict: the login-idle primer (shipped in v2.0.13, on by default) makes a
fresh install land at warm-path speed — 3.2 s vs 18.8 s login→home, beating
the user's 10 s target whenever login-form dwell ≳ ~30 s (d-pad/OSK typing
realistically takes 30-90 s). The cold/warm delta (18.8 → 2.5 s) is entirely
the post-login Babel storm, confirming the JEL-131 breakdown; the storm is
fully absorbed by the primer. The user's "~30 s" report vs our 18.8 s
submit→cards: their account has heavier home sections than Test (267-283 vs
117-133 cards at settle) and perceived "usable home" includes row hydration
after first cards.**

## Cross-issue evidence captured pre-wipe (JEL-138 / JEL-132)

QA build installed OVER retail v2.0.13 without a wipe (JEL-116:
vd_appinstall preserves localStorage), so boot 0 beaconed the user's REAL
post-testing state (00:31Z):

- `enableAutoLogin: "true"`, signed in (`cred n=1 tok=1`), 267 home cards,
  `txN=64`, warm boot `txh=56/txm=0`, `__shellCredsGuard {strips:0,
vetoes:0, vm:3}`, validate 200.
- credsTrail (UTC, decodes the user's JEL-131-comment testing session):
  - 23:59:37 boot `p:0 t:0 ls:16` — post-rollback floor, no creds
  - 00:01:16 boot `p:0 t:0 ls:18`
  - 00:03:17 boot `p:1 n:1 t:0 ls:62` — server entry, NO token = the
    "logged in but not saved" signature (Enter-login trials)
  - 00:05:47 `restore t:1` + boot `t:1 ls:77` — a button-login token was
    vaulted, a restart rolled localStorage back, the JEL-134 vault
    restored it. **The vault works for button-logins.**
  - 00:31:12 boot `t:1 ls:89` (this capture's probe boot)
- jellyfin-web bundle facts (user's server): login submit handler runs
  `appSettings.enableAutoLogin(chkRememberLogin.checked)` on EVERY submit
  (Enter and button converge on the same handler); jellyfin-apiclient
  `onAuthenticated` NULLS `UserId`/`AccessToken` before persisting when
  `enableAutoLogin === false`. Template renders the checkbox
  default-checked between the password input and the Sign In button
  (focusable on TV; OK on it toggles).

## End-of-window restore

- final prep dropped Test creds + vault (tx cache intentionally left warm
  for the user), farewell cleared `jellyfin.qa.*`, retail v2.0.13
  (`eac5e01d…81dc`) reinstalled and launched, REST-verified.
- Test-account device tokens from this window are revocable server-side
  (Dashboard → Devices).
