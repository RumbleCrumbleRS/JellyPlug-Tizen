# On-device QA evidence policy

`tooling/tv-validate/` holds the on-device validation **harnesses** (the
`verify-*.mjs` / `*.py` / `*.cjs` drivers and their `README`s). Those are
source and belong in git.

Everything those harnesses **produce** is a different thing — `results-JEL-*.md`
writeups, ntfy/relay logs, localStorage trail dumps, beacon payloads,
screenshots, device-probe output, bundle checksums. It is debug information,
not code, and it is generated from one operator's physical TV talking to one
operator's personal Jellyfin server, so it tends to embed:

- the server hostname (historically a free dynamic-DNS name that resolves to a
  home IP),
- LAN IPs and device identifiers,
- session-shaped data.

In JEL-139 that evidence leaked a personal dynamic-DNS hostname into 13 tracked
files and the entire git history while the repo was public. It was scrubbed,
the history was rewritten, and the repo was made private. JEL-141 then removed
the remaining capture evidence outright: the repo should hold only relevant
code.

## Rules

1. **Harnesses go in git. Their output does not.** Only harness source
   (`*.mjs` / `*.cjs` / `*.py` / `*.sh`), `README.md`, this policy, and
   `.gitignore` may be tracked under `tooling/tv-validate/`. No results
   writeups, logs, payload dumps, screenshots, or checksums.

2. **Run output and verdicts go to the Paperclip issue**, not the repo —
   as a comment, attachment, or work product on the relevant `JEL-*` ticket,
   where it stays with the work and out of a clonable artifact. Do not
   re-introduce per-run `results-JEL-*.md` files.

3. **CI enforces both rules:**
   - `tooling/ci/check-no-debug-evidence.sh` (`JEL-141` guard) allowlists the
     file types above under `tooling/tv-validate/` and fails the build if any
     capture evidence is committed.
   - `tooling/ci/check-no-personal-endpoints.sh` (`JEL-139` guard) fails the
     build if any tracked file references a personal / dynamic-DNS server
     endpoint.

   Both run in the `verify-no-personal-endpoints` CI job. Run them locally
   before committing:

   ```
   tooling/ci/check-no-debug-evidence.sh
   tooling/ci/check-no-personal-endpoints.sh
   ```

   RFC1918 LAN IPs (`192.168.x` / `10.x` / `172.16–31.x`) are intentionally not
   flagged — they are non-routable and reveal nothing reachable from outside
   the LAN. Avoid adding new ones anyway, but they are not a CI failure.
