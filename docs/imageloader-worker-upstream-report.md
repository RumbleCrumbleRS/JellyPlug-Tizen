# Upstream report — `jellyfin/jellyfin-web`

**Status: DRAFT (JELA-701), awaiting sign-off before filing.** The text below is the report
as it will be filed; this header will be updated with the issue link once it is.

Verified against tag `v10.11.11` (our deployed version) and `HEAD` (`1fdc517`) — the shape
is identical in both. The minimal reproduction below was run for real on 2026-08-24
(headless Chromium 63 against the production server) and produced the exact module-scope
`SecurityError` in the chunk-load stack. Local evidence:
`docs/jela696-worker-shim-blast-radius.md` (JELA-696 sweep), shell workaround in PR #155
(JELA-695).

---

## Title

`imageLoader` constructs its blurhash worker at module scope — one `SecurityError` there
silently empties every card surface in the app

## Body

Hi — we ship a client for older Samsung TVs that embeds jellyfin-web with the document on a
different origin from the `/web/` assets. On that setup **every native card surface renders
zero cards** — library grids, suggestions, collections, favourites, item detail rows, and
search — with nothing in `window.onerror` or `unhandledrejection`. We traced it to a single
unprotected statement, and we now carry a workaround, but the failure mode is general enough
(any cross-origin embedding) that it seems worth fixing at the source.

### The mechanism

`src/components/images/imageLoader.js` builds the blurhash worker at module scope:

```js
import Worker from './blurhash.worker.ts'; // eslint-disable-line import/default
...
const worker = new Worker();          // line 6 — module scope, unguarded
worker.addEventListener('message', …); // lines 8-19
```

`worker-loader` (`webpack.common.js` lines 272-283) compiles that constructor to
`new Worker(__webpack_public_path__ + 'blurhash.worker.bundle.js')`, and with
`publicPath: ''` the URL resolves against the document's base URI. In any host where the
document's origin differs from the asset origin — an embedding webview, a portal that owns
the document and points a `<base>` at the server — that URL is cross-origin, and a
cross-origin dedicated `Worker` constructor throws `SecurityError` synchronously, per spec.

The throw itself would be survivable; where it happens is what makes it fatal. It aborts the
module body before the default export (lines 249-256) is assigned. By then webpack has
already installed the export getters and cached the module — with
`output.strictModuleErrorHandling` at its default `false`, a module whose evaluation throws
**stays cached half-built** — so every later importer receives a namespace whose `default`
is `undefined`, permanently and silently.

### Blast radius

`cardBuilder.js` line 83: `setCardData` opens with
`imageLoader.getPrimaryImageAspectRatio(items)`, and `buildCardsHtmlInternal` (line 148)
calls it unconditionally. So every native `cardBuilder.getCardsHtml()` call throws
`TypeError: Cannot read property 'getPrimaryImageAspectRatio' of undefined` for the lifetime
of the document. `imageLoader.lazyChildren` (line 1084 and 55 other chunks in the built
`10.11.11` bundles) is a second, independent route to the same `undefined`.

Measured A/B on `10.11.11` (identical build, the only variable being whether the module-scope
construction throws), cards rendered per surface:

| surface                                             |                                   throwing | guarded |
| --------------------------------------------------- | -----------------------------------------: | ------: |
| Movies grid                                         |                                          0 |      58 |
| Movies › Suggestions                                |                                          0 |      56 |
| TV Shows grid                                       |                                          0 |       9 |
| Collections                                         |                                          0 |      48 |
| Search                                              | 0 — React error boundary replaces the page |     138 |
| Movie detail (native rows: Cast & Crew, similar, …) |                                          0 |      57 |
| Series detail (incl. Seasons, Next Up)              |                                          0 |      62 |

Search fails worst: it is a React surface, so the throw hits the error boundary and the
whole page becomes an error screen rather than an empty shelf.

Notably, **`window.onerror` and `unhandledrejection` both stayed at 0 through all of it** —
the throws happen inside rendering call stacks that swallow them, so no error telemetry
would ever surface this. It presents as "the server returned no items".

### Reproduction

The throw itself, from any page _not_ on your Jellyfin origin:

```js
new Worker("http://YOUR_SERVER:8096/web/blurhash.worker.bundle.js");
// → SecurityError, synchronously
```

The full failure, without any TV — serve this from any other origin (`python3 -m
http.server`), pointing at a stock install (the server answers `/web/` requests that carry
an `Origin` header with `Access-Control-Allow-Origin: *`, and `<script>` tags load
cross-origin regardless, so the app otherwise boots normally):

```html
<!DOCTYPE html>
<html>
  <body>
    <script>
      fetch("http://YOUR_SERVER:8096/web/index.html")
        .then((r) => r.text())
        .then((html) => {
          html = html.replace(
            /<head([^>]*)>/i,
            '<head$1><base href="http://YOUR_SERVER:8096/web/">',
          );
          document.open();
          document.write(html);
          document.close();
        });
    </script>
  </body>
</html>
```

We verified this exact file against a `10.11.11` server: the app boots, and the moment the
first view chunk containing `imageLoader` is ensured, the constructor throws —

```
DOMException: Failed to construct 'Worker': Script at
'http://YOUR_SERVER:8096/web/blurhash.worker.bundle.js' cannot be accessed from origin
'http://127.0.0.1:8123'.
    at new <anonymous> (.../web/12011.<contenthash>.chunk.js:...)
    at Module.<imageLoader id> (...)
```

— surfacing once as an uncaught chunk-load rejection that nothing retries, after which the
view that needed the chunk never renders and every card surface stays empty. Nothing in the
message points at `imageLoader` or explains why cards are gone from then on.

### The fix

Guard the one unprotected statement:

```js
let worker;
try {
    worker = new Worker();
    worker.addEventListener('message', ({ data: { pixels, hsh, width, height } }) => {
        ...
    });
} catch (err) {
    console.error('[imageLoader] blurhash worker unavailable, placeholders disabled', err);
}
```

Everything downstream already degrades gracefully: `itemBlurhashing` wraps
`worker.postMessage` in a try/catch whose handler marks the target `non-blurhashable`
(lines 65-69), which is also the path taken when a hash is absent. So with the guard, an
environment that cannot construct the worker loses blurhash placeholders and nothing else —
instead of losing every card in the app. Lazy construction on first use would work equally
well; the essential property is that the module body completes.

Happy to send that as a PR if the shape looks right to you.

### Environment

- jellyfin-web `10.11.11` (deployed, minified bundles read directly); source confirmed
  identical at tag `v10.11.11` and `HEAD` (`1fdc517`)
- Jellyfin server `10.11.11`, Linux x64
- Observed in production on Tizen 5.0 (Chromium 63); the minimal reproduction above was
  verified on headless Chromium 63. The mechanism is engine-independent — the same-origin
  check on dedicated workers is spec behaviour everywhere

Thanks — this is meant as a useful report from an embedding that hit it, not a complaint.
