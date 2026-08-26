# Upstream report — `n00bcodr/Jellyfin-Enhanced`

**Status: DRAFT (JELA-766) — not yet filed.** On acceptance, file on
`n00bcodr/Jellyfin-Enhanced` via `gh api repos/n00bcodr/Jellyfin-Enhanced/issues`
from RumbleCrumbleRS, then flip this header to FILED with the link (same route as
`docs/imageloader-worker-upstream-report.md`, JELA-701, and the two JELA-734
drafts).

Verified against tag `12.4.1.0` (our deployed version, current upstream latest,
released 2026-08-23). The three client files cited below are byte-identical
between what our production server serves and the upstream tag, so every line
number is upstream's. The `IsAdmin` round-trip in mechanism 3 was run for real
against our production server on 2026-08-26: `POST settings.json` with
`"IsAdmin": false` added → `200 {"success":true}` → `GET` returns the file
byte-identical to its pre-POST state, `IsAdmin` absent.

Observed counts (internal context, not part of the filed body): seven
`POST /JellyfinEnhanced/user-settings/{userId}/settings.json` during one
read-only home → series → season → episode → Back ×3 walk (JELA-759 capture,
n=1), and one POST inside every ~18 s item-detail dwell (JELA-757). The
drill capture was lost with `/tmp`, so the seven is not re-confirmed; the
per-detail-view mechanism below is source-confirmed and fully accounts for a
write on every one of the walk's five item-detail renders, plus one per boot
from mechanism 3.

---

## Title

The client rewrites an unchanged `settings.json` on every item-detail view
(reviews `toggle` write-back), and the `isAdmin` write-back can never converge
because `UserSettings` has no `IsAdmin` property

## Body

Hi — we run Jellyfin Enhanced 12.4.1.0 on Samsung TVs and census every request
the client makes. During a read-only walk (home → series → season → episode →
Back ×3, no setting touched) the client POSTed
`/JellyfinEnhanced/user-settings/{userId}/settings.json` once per item-detail
view — seven times in one walk, each with its own CORS preflight, and each
write-back byte-identical to the file already on disk. On a TV every request
counts, and a config file rewritten on every navigation is also flash-write
amplification and a cache-buster for any client that tries to cache config.
We traced it to four small, independently fixable pieces (all cited at tag
`12.4.1.0`).

### 1. The per-view trigger: the reviews section's `toggle` listener fires on its own programmatic `open`

`js/elsewhere/reviews.js` rebuilds the reviews `<details>` section on every
item-detail `viewshow` (including Back navigations — `addReviewsToPage` L602-605
removes any existing section and builds a fresh one). When
`reviewsExpandedByDefault` is true it opens the section at build time:

```js
// L659-661
if (JE.currentSettings?.reviewsExpandedByDefault) {
  reviewsSection.setAttribute("open", "");
}
```

and ~150 lines later, in the same synchronous block, attaches the persistence
listener:

```js
// L807-820
// Persist user's expand/collapse choice for future pages
reviewsSection.addEventListener('toggle', function () {
    ...
    JE.currentSettings.reviewsExpandedByDefault = reviewsSection.open;
    ...
    JE.saveUserSettings('settings.json', JE.currentSettings);
```

Per the HTML spec, adding the `open` attribute to a `<details>` element queues a
toggle task; the task runs after the current script block, by which time the
listener is attached. So the listener's very first firing is the section's own
programmatic open — it "persists" the exact value it was rendered from and POSTs
the whole settings object. Once per item-detail view (Movie / Series / Season /
Episode all render the section), forward and Back alike, for every user who has
`reviewsExpandedByDefault: true`.

Fix: only save when the value actually changed —

```js
if (JE.currentSettings.reviewsExpandedByDefault !== reviewsSection.open) {
  JE.currentSettings.reviewsExpandedByDefault = reviewsSection.open;
  JE.saveUserSettings("settings.json", JE.currentSettings);
}
```

(or attach the listener before setting the attribute and skip the first event).

### 2. `saveUserSettings` exempts `settings.json` from its own identical-payload check

`js/enhanced/config.js` L60-67 already keeps a per-file cache of the last saved
JSON and skips identical saves — for every file **except** `settings.json`:

```js
// For non-settings files, skip the POST if nothing has changed.
// settings.json is exempt: loadSettings() merges defaults so the first
// save per session will always differ from the raw server value — that
// write-back is intentional and must not be suppressed.
if (fileName !== "settings.json" && _lastSavedJson[cacheKey] === serialized) {
  return; // no-op — identical to last save
}
```

The comment's justification only covers the _first_ save per session, but the
exemption is permanent, so every duplicate `settings.json` save goes to the
wire. Seeding `_lastSavedJson` is enough to keep the intended first write-back
while suppressing the rest — with that in place, mechanism 1's redundant saves
would at least stop POSTing (they would still serialize per view, so fixing 1 is
still worth it).

### 3. The `isAdmin` write-back can never converge: `UserSettings` silently drops it

`js/arr/arr-links.js` L53-57 tries to persist the viewer's admin status exactly
once:

```js
// Update settings.json if the value changed
if (JE?.currentSettings && JE.currentSettings.isAdmin !== isAdmin && typeof JE.saveUserSettings === 'function') {
    JE.currentSettings.isAdmin = isAdmin;
    await JE.saveUserSettings('settings.json', JE.currentSettings);
```

but the server binds the POST body to `UserSettings`
(`Controllers/JellyfinEnhancedController.cs` L3731), and
`Configuration/UserConfiguration.cs`'s `UserSettings` class has **no `IsAdmin`
property** — the deserializer drops the key, and the saved file never contains
it. We verified the round-trip live on 12.4.1.0: POST the current settings plus
`"IsAdmin": false` → `200 {"success":true,"file":"settings.json"}` → GET returns
the file byte-identical to its pre-POST state, no `IsAdmin`.

So on the next session `loadSettings()` yields `isAdmin: undefined`,
`undefined !== false`, and the "if the value changed" write fires again — one
guaranteed spurious `settings.json` POST per session, for every user, forever.
Fix: either add `IsAdmin` to `UserSettings`, or keep `isAdmin` purely in-memory
(it is re-derived from `user.Policy.IsAdministrator` at init anyway, so
persisting it mostly risks staleness).

### 4. The server rewrites the file even when the payload is identical

`SaveUserSettingsSettings` (`Controllers/JellyfinEnhancedController.cs`
L3728-3776) already serializes both the existing config and the incoming one and
compares them — but only to build the change log; `SaveUserConfiguration` runs
unconditionally (L3763), so an identical POST still rewrites the file on disk.
Skipping the save when `existingJson == newJson` would make the endpoint
idempotent for no-op writes and cap the damage of any future client-side
regression of this kind.

### Impact

- One `settings.json` POST + CORS preflight per item-detail view for any user
  with `reviewsExpandedByDefault: true` (mechanism 1), plus one per session for
  every user (mechanism 3) — in our read-only walk that was 14 requests that
  carried no information.
- Every one of those POSTs rewrites the settings file on the server's disk
  (mechanism 4).
- Any client-side config cache has to invalidate on every write, so these no-op
  writes also defeat config caching for clients that census-optimize like ours.

Happy to open a PR for any subset of 1-4 if that helps.
