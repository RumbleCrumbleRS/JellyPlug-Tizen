# JEL-138 — Enter/OSK login "doesn't save credentials": root cause confirmed

Date: 2026-06-13. Probes run in headless Chrome-for-Testing 149 (CDP) against the
**user's live server** (`JELLYFIN_URL`, jellyfin-web bundle `?4c3e5ec610f9c71cad1c`
— the exact bytes the TV fetches), Test account. No shell involved: these probe
jellyfin-web's own login behavior. Scripts: `jel138-login-probe.mjs` (submit-path
× checkbox matrix), `jel138-relaunch-probe.mjs` (app-relaunch persistence),
`jel138-tvlayout-probe.mjs` (TV-layout checkbox render). Bring-up:
`../dpad-nav-test/bootstrap-chromium.sh` (use a free `PORT`; 3100/9222 may be taken).

## User report (JEL-131, 2026-06-13)

> "It doesn't seem to save the credentials if you don't physically hit the login
> button. If you press enter on the on screen keyboard when the user and pass is
> on it'll log you in but not save the credentials."

## Findings

### 1. The submit path is irrelevant; the "Remember Me" checkbox state is everything

`jel138-login-probe.mjs`, fresh localStorage per scenario unless noted:

| scenario                                          | submit path    | checkbox               | post-login localStorage                |
| ------------------------------------------------- | -------------- | ---------------------- | -------------------------------------- |
| S1                                                | real Enter key | checked                | `enableAutoLogin="true"`, 1 token      |
| S2                                                | Sign In button | unchecked              | `enableAutoLogin="false"`, 1 token (!) |
| S3 (no clear after S2 — the user's sticky replay) | real Enter key | rendered **unchecked** | `enableAutoLogin="false"`, 1 token     |

Enter (implicit form submission) and the button land in the same
`.manualLoginForm` submit handler; both write the token. What differs is
`appSettings.enableAutoLogin(chkRememberLogin.checked)` recorded at submit.

### 2. The token is written either way — it is **discarded at the next launch**

`jel138-relaunch-probe.mjs` (relaunch = sessionStorage cleared + fresh top-level
navigation; localStorage persists, matching TV app relaunch per JEL-116):

| login with      | post-login                   | after relaunch                                               |
| --------------- | ---------------------------- | ------------------------------------------------------------ |
| Remember Me OFF | `#/home`, 1 token in storage | `#/login?serverid=…` (login page), **0 tokens** — signed out |
| Remember Me ON  | `#/home`, 1 token in storage | `#/home`, 1 token — session kept                             |

So the earlier JEL-138 write-gate model ("token never written") was slightly off
for this bundle: jellyfin-web writes the token at login regardless, then the boot
path drops it when `enableAutoLogin === "false"`. User-visible behavior is the
same: "logs you in but doesn't save the credentials".

### 3. The opt-out is sticky and invisible to the OSK-Enter flow

- One login with the box unchecked flips `enableAutoLogin` to `"false"`; every
  later login form renders the box **unchecked** (S3) until the user re-checks it.
- TV layout (`layout=tv`) renders the checkbox visibly: "Remember Me", 1080×47 px
  row between the password field and the Sign In button — i.e., **in the D-pad
  path to the button but bypassed entirely by OSK Enter**, which submits from the
  password field.
- Fresh storage renders the box **checked** (default true).

This explains the Enter-vs-button correlation: in the button flow the user D-pads
through/over the checkbox row and (at least once) re-checked it; OSK Enter always
submits with the stale sticky state.

### 4. The shell is not implicated

`grep enableAutoLogin` over `packages/`: the shell only READS it — the JEL-134
vault skips mirroring and the restore path skips restoring when it is `"false"`
(deliberate: the shell must not out-persist a user opt-out). No shell code writes
it. jellyfin-web behaves as designed; this is a TV UX trap, not a defect in the
vault.

## Verdict

Root cause confirmed: sticky `enableAutoLogin="false"` + OSK Enter submitting
without passing the visible-but-unnoticed "Remember Me" checkbox. Immediate user
remedy: check "Remember Me" once at the next login — the preference is sticky in
the good direction too. Fix decision (shell nudge vs no-shell-lever + upstream
report) routed to the board on JEL-138.
