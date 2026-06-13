# JEL-83 — HTTPS vs HTTP server connections + certificate handling on TV

**Verdict: PASS — cert handling is platform-owned and TV ≡ browser by construction; the only shell-owned piece (URL normalization) is correct and byte-identical across all artifacts.**

The shell carries **zero TLS code**. HTTPS-vs-HTTP and certificate trust are decided entirely by the platform network stack (the M63 WebView's network service on the TV, modern Chromium in the browser). The shell's only jobs are (a) normalize the server URL and (b) be a faithful, non-weakening conduit for whatever the platform decides. Both are proven hermetically — no TV, no server, no network required.

## What the issue asked

1. HTTPS connections work without certificate warnings.
2. Self-signed certs are handled gracefully (or the error is informative).
3. `normalizeServerUrl` correctly prepends `http://` for bare hostnames.
4. Compare browser behaviour for invalid certs.

## The two facts that decide everything

**(a) Every server connection is a `fetch`, never a top-level navigation.**
The connect screen probes `fetch(url + "/System/Info/Public")`; the web client itself is loaded by `fetch(url + "/web/") → document.write`. The only `location.replace()` in the shell targets the **local** `index.html`. The shell never points the top-level document at the remote server.

**(b) `fetch` delegates TLS entirely to the platform.**
The shell passes **no** certificate options on the fetch and installs **no** cert-error callback. Tizen's `setCertificateError` / native WebView cert override is a native-app API a web widget cannot reach — and this widget doesn't try. `config.xml` grants `<access origin="*" subdomains="true">` (so both `http://` and `https://` are reachable) but carries **no** certificate-bypass privilege or setting.

## Findings against each claim

### (1) HTTPS works without certificate warnings — holds by construction

On a server with a valid public certificate (e.g. `REDACTED-SERVER.example`, a real CA), the platform trusts the cert and `fetch` resolves. Because the shell never renders any certificate UI, there is no "certificate warning" that _could_ appear. Proven by running the real `validateServer` with a fetch stub that resolves a real `/System/Info/Public` — it returns the server identity and the connect flow proceeds.

### (2) Self-signed / invalid certs — graceful + informative

A self-signed or otherwise untrusted cert makes the platform net stack **reject** the fetch (real Chromium surfaces a `TypeError "Failed to fetch"`; the Fetch spec deliberately hides per-cert detail). The connect form's `.catch` then runs:

```
showError("Could not reach server: " + (err && err.message ? err.message : "unknown error"));
```

— no crash, the form stays put, the user can edit the URL and retry. Proven by running the real `validateServer` with a rejecting fetch stub: the rejection **propagates unchanged** to the connect-form catch (it is neither weakened nor swallowed). A valid-cert host that isn't Jellyfin (e.g. `https://example.com`) gets a distinct, shell-authored `"Not a Jellyfin server"` message — equally informative.

> **Caveat (informative, not a defect):** because TLS detail is hidden from `fetch`, the message for a cert failure is the generic network-error string, not "the certificate is self-signed". That is a Fetch-API limitation, identical on TV and browser — the shell surfaces everything the platform exposes.

### (3) `normalizeServerUrl` prepends `http://` for bare hostnames — correct

Run the **real** function from all four shipped JS artifacts (`shell.js`, `shell.min.js`, `boot-shell.src.js`, `boot-shell.min.js`) **and** the `shell-core` TS source over an input matrix:

| input                          | output                         | rule                                         |
| ------------------------------ | ------------------------------ | -------------------------------------------- |
| `REDACTED-SERVER.example`         | `http://REDACTED-SERVER.example`  | bare host → **default http://**              |
| `192.168.1.50:8096`            | `http://192.168.1.50:8096`     | bare host:port → http://                     |
| `https://REDACTED-SERVER.example` | `https://REDACTED-SERVER.example` | explicit https **preserved** (no downgrade)  |
| `http://192.168.1.50:8096`     | `http://192.168.1.50:8096`     | explicit http preserved                      |
| `https://jelly.example///`     | `https://jelly.example`        | trailing slashes stripped                    |
| `  jellyfin.local:8096  `      | `http://jellyfin.local:8096`   | whitespace trimmed                           |
| `HTTPS://Host`                 | `HTTPS://Host`                 | scheme test case-insensitive, case preserved |

All five sources produce identical output for every non-empty input. **One intentional divergence:** the JS artifacts return `""` for empty/blank input (the connect form then prompts "Please enter a server URL."), while the `shell-core` TS lib **throws** `"empty server URL"` so a programmatic caller can't silently probe an empty URL. Both are correct for their context and are asserted explicitly.

> **UX note:** a bare hostname always defaults to `http://`. An HTTPS-only server entered _without_ a scheme is probed over `http://` first and will fail unless the server redirects — the user must type `https://` explicitly. This matches the documented intent in `shell-core/src/server/index.ts` ("user can supply https:// explicitly").

### (4) Browser behaviour for invalid certs — same outcome, no bypass

The browser's clickable "your connection is not private → proceed anyway" interstitial exists **only for top-level navigation**. Because the shell gates every server connection behind a `fetch` (fact a), that interstitial path is **never reached** — an invalid-cert server is non-bypassable on the browser **and** the TV, by the same code. The certificate decision happens at probe time on both platforms, with no "proceed" escape hatch in either. This is the parity result: cert handling is identical TV-vs-browser because it is the same fetch-delegating code with **zero** user-agent branching in the connect/validate path.

## How it was verified

- **CI-wired guard:** `packages/shell-tizen/scripts/https-certificates.test.cjs` (wired into `pnpm --filter @jellyfin-tv/shell-tizen test`). Runs the real `normalizeServerUrl` over the input matrix across all 4 artifacts, exercises `validateServer` transparency (resolve + reject), and pins the cert-transparency source contract.
- **Narrated harness:** `tooling/tv-validate/https-certificates/verify-https-certificates.mjs` — the fuller walk including the `shell-core` TS source, the empty-input divergence, `config.xml` access/cert assertions, and deployed-blob guards. **All checks PASS.**

Run:

```
node tooling/tv-validate/https-certificates/verify-https-certificates.mjs
node packages/shell-tizen/scripts/https-certificates.test.cjs
```

## Bottom line

HTTPS to a real-CA server works with no warnings (the shell never shows one); self-signed/invalid certs fail gracefully with the platform's network-error message surfaced in-form; `normalizeServerUrl` defaults bare hosts to `http://` and preserves explicit `https://` without downgrade; and every one of these behaviours is identical on the TV and in the browser because the shell delegates the entire TLS decision to the platform with no cert bypass and no UA gating.
