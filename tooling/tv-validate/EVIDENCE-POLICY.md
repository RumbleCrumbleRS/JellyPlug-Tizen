# On-device QA evidence policy

`tooling/tv-validate/` holds the on-device validation **harnesses** (the
`verify-*.mjs` / `*.py` drivers and their `README`s). Those are source and
belong in git.

The **raw capture evidence** those harnesses produce — ntfy/relay logs,
localStorage trail dumps, beacon payloads, screenshots, device probe output —
is a different thing. It is generated from one operator's physical TV talking
to one operator's personal Jellyfin server, so it tends to embed:

- the server hostname (historically a free dynamic-DNS name that resolves to a
  home IP),
- LAN IPs and device identifiers,
- session-shaped data.

In JEL-139 that evidence leaked a personal dynamic-DNS hostname into 13 tracked
files and the entire git history while the repo was public. It was scrubbed,
the history was rewritten, and the repo was made private.

## Rules

1. **Harnesses go in git. Raw capture evidence does not.** Attach raw captures
   to the Paperclip issue instead (issue attachments / work products), where
   they stay with the ticket and out of a clonable public artifact.

2. **If a small excerpt must live in the repo** (e.g. a worked example in a
   `results-JEL-*.md`), redact first:
   - server hostnames → a reserved `*.example` placeholder
     (`REDACTED-SERVER.example`),
   - never commit a real dynamic-DNS hostname (`*.ddns.net`, `*.duckdns.org`,
     `*.hopto.org`, …). The reserved `.example` TLD never resolves, so it is
     safe.

3. **CI enforces rule 2.** `tooling/ci/check-no-personal-endpoints.sh` runs in
   the `verify-no-personal-endpoints` CI job and fails the build if any tracked
   file references a personal / dynamic-DNS server endpoint. Run it locally
   before committing capture excerpts:

   ```
   tooling/ci/check-no-personal-endpoints.sh
   ```

   RFC1918 LAN IPs (`192.168.x` / `10.x` / `172.16–31.x`) are intentionally not
   flagged — they are non-routable and reveal nothing reachable from outside
   the LAN. Avoid adding new ones anyway, but they are not a CI failure.
