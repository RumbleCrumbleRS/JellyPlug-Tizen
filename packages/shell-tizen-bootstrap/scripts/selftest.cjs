// JEL-2040 bootstrap selftest. Asserts the index.html <script> bootloader
// covers three branches:
//   1. No serverUrl in localStorage → connect form is rendered.
//   2. serverUrl + manifest.json 200 → hosted shell.min.js is appended with
//      a sha256 cache-buster query.
//   3. serverUrl + manifest.json error + shell.min.js script onerror →
//      bootloader falls back to baked boot-shell.min.js.
//
// Run: node packages/shell-tizen-bootstrap/scripts/selftest.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML = path.join(__dirname, '..', 'src', 'index.html');
const html = fs.readFileSync(INDEX_HTML, 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('bootloader <script> not found in index.html');
const SOURCE = match[1];

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

function makeEnv({ serverUrl, manifestResponse, manifestStatus, scriptErrors, scriptOk, scriptDelayedOk, navigatorUA, ensureBabelSpy, extraStore, fetchBodies }) {
    const log = { appended: [], formAttached: false, errorShown: null };
    const sandboxRef = {}; // filled at the bottom so inline exec sees the live sandbox
    const head = { tagName: 'HEAD', appendChild(node) {
        log.appended.push({ tag: node.tagName, src: node.src,
                            inline: node.tagName === 'SCRIPT' && !node.src && typeof node.text === 'string' });
        // JELA-66: an inline <script> (script.text set, no src) executes
        // synchronously during appendChild in a real browser — mirror that
        // so the LS-shell-cache scenarios can observe execution.
        if (node.tagName === 'SCRIPT' && !node.src && typeof node.text === 'string') {
            vm.runInContext(node.text, sandboxRef.sandbox);
            return;
        }
        // JELA-66: scriptDelayedOk[src] = ms — onload fires late (slow-network
        // race with the BOOT_BUDGET_MS baked-fallback timer).
        if (scriptDelayedOk && scriptDelayedOk[node.src] != null) {
            setTimeout(function(){ if (node.onload) node.onload(); }, scriptDelayedOk[node.src]);
            return;
        }
        setImmediate(function(){
            if (node.tagName !== 'SCRIPT') return;
            if (scriptErrors && scriptErrors[node.src]) {
                if (node.onerror) node.onerror();
            } else if (scriptOk && scriptOk[node.src]) {
                if (node.onload) node.onload();
            } else {
                if (node.onload) node.onload();
            }
        });
    }};

    const elements = {};
    function makeElement(tag) {
        const el = {
            tagName: tag.toUpperCase(),
            children: [],
            style: {},
            addEventListener: function(){},
            appendChild: function(c){ this.children.push(c); },
        };
        if (tag.toLowerCase() === 'script') {
            el.onload = null; el.onerror = null; el.src = '';
        }
        return el;
    }
    const bootRoot = makeElement('div'); bootRoot.id = 'boot-root';
    const bootError = makeElement('p'); bootError.id = 'boot-error'; bootError.hidden = true;
    const form = makeElement('form'); form.id = 'server-form';
    form.handlers = [];
    form.addEventListener = function(ev, cb){
        if (ev === 'submit') { log.formAttached = true; form.handlers.push(cb); }
    };
    form.submit = function(){
        const ev = { preventDefault: function(){ log.prevented = true; } };
        this.handlers.forEach(function(cb){ cb(ev); });
    };
    const input = makeElement('input'); input.id = 'server-input'; input.value = '';

    elements['boot-root'] = bootRoot;
    elements['boot-error'] = bootError;
    elements['server-form'] = form;
    elements['server-input'] = input;

    const document = {
        head: head,
        getElementById: function(id){ return elements[id] || null; },
        createElement: function(tag){ return makeElement(tag); },
    };

    let savedUrl = serverUrl;
    const localStorage = {
        store: Object.assign({ 'jellyfin.shell.serverUrl': savedUrl }, extraStore || {}),
        getItem(k){ return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
        setItem(k, v){ this.store[k] = String(v); },
        removeItem(k){ delete this.store[k]; },
    };
    if (savedUrl == null) delete localStorage.store['jellyfin.shell.serverUrl'];

    // JEL-125: prime-path observability — record prefetch URLs and eager
    // babel kicks issued by primeWebBoot.
    log.fetched = [];
    // JELA-66: URLs present in `fetchBodies` resolve with real text (the
    // shell byte-store path); everything else stays a forever-pending
    // promise (the prefetch prime path never consumes responses here).
    function fakeFetch(url){
        log.fetched.push(url);
        if (fetchBodies && Object.prototype.hasOwnProperty.call(fetchBodies, url)) {
            const body = fetchBodies[url];
            return Promise.resolve({ ok: true, text: function(){ return Promise.resolve(body); } });
        }
        return new Promise(function(){});
    }
    const win = { __qaMarks: null };
    if (ensureBabelSpy) {
        log.babelKicks = 0;
        win.__ensureBabel = function(){ log.babelKicks++; return Promise.resolve(); };
    }

    function FakeXHR(){
        this.open = function(method, url){ this.url = url; };
        this.send = function(){
            const self = this;
            setImmediate(function(){
                if (manifestResponse === 'timeout') {
                    if (self.ontimeout) self.ontimeout();
                    return;
                }
                if (manifestResponse === 'error') {
                    if (self.onerror) self.onerror();
                    return;
                }
                self.status = manifestStatus || 200;
                self.responseText = manifestResponse || '{}';
                if (self.onload) self.onload();
            });
        };
    }

    const sandbox = {
        window: win,
        document,
        location: { reload: function(){ log.reloaded = true; } },
        localStorage,
        XMLHttpRequest: FakeXHR,
        fetch: fakeFetch,
        setTimeout, clearTimeout, setImmediate,
        console: { warn: function(){}, log: function(){} },
        Date,
        encodeURIComponent,
        JSON,
        parseInt,
        Function,
    };
    if (navigatorUA) sandbox.navigator = { userAgent: navigatorUA };
    sandboxRef.sandbox = sandbox; // JELA-66: let head.appendChild run inline scripts in-context
    return { log, sandbox };
}

// JELA-66: mirror of the bootloader's hsbFnv (itself the shell's txFnv1a
// recipe) so scenarios can build integrity-valid shell-body records.
function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
}
function shellBodyRec(sha, url, body) {
    return JSON.stringify({ v: 1, sha, url, len: body.length, h: fnv(body), ts: 1, body });
}

async function runScenario(opts) {
    const env = makeEnv(opts);
    vm.createContext(env.sandbox);
    vm.runInContext(SOURCE, env.sandbox);
    await new Promise(function(resolve){ setTimeout(resolve, opts.settleMs || 50); });
    return env;
}

(async function(){
    // Scenario 1: no serverUrl → connect form rendered.
    {
        const r = await runScenario({ serverUrl: null });
        if (!r.log.formAttached) fail('scenario 1: connect form submit handler not attached');
        if (r.log.appended.length !== 0) fail('scenario 1: should not append script when no serverUrl');
        console.log('OK 1: no serverUrl → connect form rendered, no script append');
    }

    // Scenario 2: serverUrl + manifest 200 → hosted shell appended with hash.
    {
        const manifest = JSON.stringify({ version: '1.0.0', sha256: 'deadbeef', shellUrl: null });
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: manifest,
            manifestStatus: 200,
            scriptOk: { 'https://srv.example/shell/shell.min.js?v=deadbeef': true },
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1) fail('scenario 2: expected exactly 1 script append, got ' + scripts.length);
        if (scripts[0].src !== 'https://srv.example/shell/shell.min.js?v=deadbeef')
            fail('scenario 2: unexpected script src: ' + scripts[0].src);
        console.log('OK 2: manifest 200 → hosted shell with sha256 cache-buster');
    }

    // Scenario 3: serverUrl + manifest 200 + script onerror → fallback.
    {
        const manifest = JSON.stringify({ version: '1.0.0', sha256: 'feedface' });
        const hostedSrc = 'https://srv.example/shell/shell.min.js?v=feedface';
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: manifest,
            manifestStatus: 200,
            scriptErrors: { [hostedSrc]: true },
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length < 2) fail('scenario 3: expected hosted + baked script appends, got ' + scripts.length);
        const baked = scripts[scripts.length - 1];
        if (baked.src !== 'boot-shell.min.js')
            fail('scenario 3: expected boot-shell.min.js fallback, got ' + baked.src);
        console.log('OK 3: script onerror → boot-shell.min.js baked fallback');
    }

    // Scenario 4: manifest network error → unversioned shell.min.js with cache-buster.
    {
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'error',
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1) fail('scenario 4: expected 1 script append, got ' + scripts.length);
        if (!/^https:\/\/srv\.example\/shell\/shell\.min\.js\?t=\d+$/.test(scripts[0].src))
            fail('scenario 4: unexpected fallback src: ' + scripts[0].src);
        console.log('OK 4: manifest network error → shell.min.js?t=<now>');
    }

    // JEL-115 scenarios: first-connect submit must load the shell IN PLACE —
    // never location.reload() (the reload black-screened the M63 webview on
    // fresh installs) — and must normalize the typed URL like boot-shell's
    // normalizeServerUrl.

    // Scenario 5: fresh install → submit full URL → no reload, URL saved with
    // trailing slash stripped, shell load flow starts in place.
    {
        const r = await runScenario({ serverUrl: null, manifestResponse: 'error' });
        const form = r.sandbox.document.getElementById('server-form');
        r.sandbox.document.getElementById('server-input').value = 'https://srv.example/';
        form.submit();
        await new Promise(function(resolve){ setTimeout(resolve, 50); });
        if (r.log.reloaded) fail('scenario 5: first-connect submit must not location.reload()');
        const saved = r.sandbox.localStorage.getItem('jellyfin.shell.serverUrl');
        if (saved !== 'https://srv.example')
            fail('scenario 5: expected normalized save https://srv.example, got ' + saved);
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1) fail('scenario 5: expected in-place shell load (1 script), got ' + scripts.length);
        if (!/^https:\/\/srv\.example\/shell\/shell\.min\.js\?t=\d+$/.test(scripts[0].src))
            fail('scenario 5: unexpected in-place shell src: ' + scripts[0].src);
        console.log('OK 5: first-connect submit → in-place shell load, no reload');
    }

    // Scenario 6: bare host:port input → http:// scheme defaulted on save
    // (parity with boot-shell normalizeServerUrl).
    {
        const r = await runScenario({ serverUrl: null, manifestResponse: 'error' });
        r.sandbox.document.getElementById('server-input').value = '  192.168.1.5:8096/ ';
        r.sandbox.document.getElementById('server-form').submit();
        await new Promise(function(resolve){ setTimeout(resolve, 50); });
        const saved = r.sandbox.localStorage.getItem('jellyfin.shell.serverUrl');
        if (saved !== 'http://192.168.1.5:8096')
            fail('scenario 6: expected http://192.168.1.5:8096, got ' + saved);
        if (r.log.reloaded) fail('scenario 6: must not reload');
        console.log('OK 6: bare host normalized to http:// on first connect');
    }

    // Scenario 7: double submit → exactly one shell load (re-entry guard).
    {
        const r = await runScenario({ serverUrl: null, manifestResponse: 'error' });
        const form = r.sandbox.document.getElementById('server-form');
        r.sandbox.document.getElementById('server-input').value = 'https://srv.example';
        form.submit();
        form.submit();
        await new Promise(function(resolve){ setTimeout(resolve, 50); });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1)
            fail('scenario 7: double submit must load the shell once, got ' + scripts.length + ' appends');
        console.log('OK 7: re-entry guard — double submit loads shell once');
    }

    // JEL-125 scenarios: loadHostedShell must prime window.__shellPrefetch
    // (boot-shell adopts it when baseUrl matches) and eagerly kick babel on
    // legacy engines, overlapping both with the manifest-probe chain.

    // Scenario 8: stored-URL boot → prefetch primed with verbatim-URL /web/ base.
    {
        const r = await runScenario({ serverUrl: 'https://srv.example', manifestResponse: 'error' });
        const pf = r.sandbox.window.__shellPrefetch;
        if (!pf || pf.baseUrl !== 'https://srv.example/web/')
            fail('scenario 8: expected prefetch baseUrl https://srv.example/web/, got ' + (pf && pf.baseUrl));
        if (!r.log.fetched.includes('https://srv.example/web/index.html') ||
            !r.log.fetched.includes('https://srv.example/web/config.json'))
            fail('scenario 8: expected index+config prefetch, got ' + JSON.stringify(r.log.fetched));
        console.log('OK 8: stored-URL boot primes __shellPrefetch (index + config)');
    }

    // Scenario 9: first-connect submit on a legacy UA → prefetch primed from the
    // normalized URL + eager babel kick.
    {
        const r = await runScenario({
            serverUrl: null, manifestResponse: 'error',
            navigatorUA: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 Chrome/63.0.3239.84 TV Safari/537.36',
            ensureBabelSpy: true,
        });
        r.sandbox.document.getElementById('server-input').value = 'srv.example:8096/';
        r.sandbox.document.getElementById('server-form').submit();
        await new Promise(function(resolve){ setTimeout(resolve, 50); });
        const pf = r.sandbox.window.__shellPrefetch;
        if (!pf || pf.baseUrl !== 'http://srv.example:8096/web/')
            fail('scenario 9: expected prefetch baseUrl http://srv.example:8096/web/, got ' + (pf && pf.baseUrl));
        if (r.log.babelKicks !== 1)
            fail('scenario 9: expected 1 eager babel kick on legacy UA fresh connect, got ' + r.log.babelKicks);
        console.log('OK 9: first-connect submit primes prefetch + eager babel on legacy UA');
    }

    // Scenario 10: modern UA → prefetch primed, NO babel kick.
    {
        const r = await runScenario({
            serverUrl: 'https://srv.example', manifestResponse: 'error',
            navigatorUA: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            ensureBabelSpy: true,
        });
        if (!r.sandbox.window.__shellPrefetch)
            fail('scenario 10: prefetch must still prime on modern UA');
        if (r.log.babelKicks !== 0)
            fail('scenario 10: modern UA must not kick babel, got ' + r.log.babelKicks);
        console.log('OK 10: modern UA primes prefetch without babel kick');
    }

    // Scenario 11: babelPrime='0' kill switch + learned-unused streak both block the kick.
    {
        const r = await runScenario({
            serverUrl: 'https://srv.example', manifestResponse: 'error',
            navigatorUA: 'Mozilla/5.0 Chrome/63.0.3239.84 Safari/537.36',
            ensureBabelSpy: true,
            extraStore: { 'jellyfin.shell.legacy.babelPrime': '0' },
        });
        if (r.log.babelKicks !== 0)
            fail('scenario 11: babelPrime=0 must block the kick, got ' + r.log.babelKicks);
        const r2 = await runScenario({
            serverUrl: 'https://srv.example', manifestResponse: 'error',
            navigatorUA: 'Mozilla/5.0 Chrome/63.0.3239.84 Safari/537.36',
            ensureBabelSpy: true,
            extraStore: { 'jellyfin.shell.legacy.babelNeeded': '1', 'jellyfin.shell.legacy.babelUnusedStreak': '2' },
        });
        if (r2.log.babelKicks !== 0)
            fail('scenario 11: babelUnusedStreak>=2 must block the kick, got ' + r2.log.babelKicks);
        const r3 = await runScenario({
            serverUrl: 'https://srv.example', manifestResponse: 'error',
            navigatorUA: 'Mozilla/5.0 Chrome/63.0.3239.84 Safari/537.36',
            ensureBabelSpy: true,
            extraStore: { 'jellyfin.shell.legacy.babelNeeded': '1' },
        });
        if (r3.log.babelKicks !== 1)
            fail('scenario 11: learned-needed verdict with live streak must kick, got ' + r3.log.babelKicks);
        console.log('OK 11: babel kick gating — kill switch, unused streak, learned-needed');
    }

    // Scenario 12 (JEL-332): the diagnostic overlay's HSB_VERSION must stay in
    // lockstep with config.xml (the single source of truth build_bootstrap.py
    // copies into manifest.bootstrap.json). This guard makes drift a CI failure
    // so the overlay can never again mis-identify the installed bootstrap build.
    {
        const CONFIG_XML = path.join(__dirname, '..', 'src', 'config.xml');
        const configText = fs.readFileSync(CONFIG_XML, 'utf8');
        const cfgMatch = configText.match(/<widget[^>]*\bversion="([^"]+)"/);
        if (!cfgMatch) fail('scenario 12: widget version not found in config.xml');
        const configVersion = cfgMatch[1];

        const verMatch = SOURCE.match(/var HSB_VERSION\s*=\s*'([^']+)'/);
        if (!verMatch) fail('scenario 12: HSB_VERSION not found in index.html bootloader');
        const hsbVersion = verMatch[1];

        if (hsbVersion !== configVersion)
            fail('scenario 12: HSB_VERSION (' + hsbVersion + ') must equal config.xml widget '
                + 'version (' + configVersion + '). Bump both in lockstep — the overlay reports '
                + 'the installed bootstrap build and must not drift.');
        console.log('OK 12: HSB_VERSION ' + hsbVersion + ' matches config.xml widget version');
    }

    // Scenario 13 (JEL-379): the shell diag HUD (buildDiagSeedScript in
    // boot-shell.src.js) renders "shell v<ver>" as its first on-screen line.
    // Like the sibling HSB overlay (scenario 12), that version must report the
    // DEPLOYED widget version (config.xml) so an operator who enables the HUD
    // reads the installed bootstrap build, not a phantom 1.0.x line. This guard
    // makes drift between the two diag literals and config.xml a CI failure.
    {
        const CONFIG_XML = path.join(__dirname, '..', 'src', 'config.xml');
        const configText = fs.readFileSync(CONFIG_XML, 'utf8');
        const cfgMatch = configText.match(/<widget[^>]*\bversion="([^"]+)"/);
        if (!cfgMatch) fail('scenario 13: widget version not found in config.xml');
        const configVersion = cfgMatch[1];

        const BOOT_SRC = path.join(__dirname, '..', 'src', 'boot-shell.src.js');
        const bootSrc = fs.readFileSync(BOOT_SRC, 'utf8');
        const diagCalls = bootSrc.match(/buildDiagSeedScript\("([^"]+)"\)/g) || [];
        if (diagCalls.length < 2)
            fail('scenario 13: expected >=2 buildDiagSeedScript("<ver>") call sites in '
                + 'boot-shell.src.js, found ' + diagCalls.length);
        diagCalls.forEach(function (call) {
            const v = call.match(/buildDiagSeedScript\("([^"]+)"\)/)[1];
            if (v !== configVersion)
                fail('scenario 13: diag HUD version (' + v + ') in ' + call + ' must equal '
                    + 'config.xml widget version (' + configVersion + '). Bump in lockstep — the '
                    + 'HUD reports the installed bootstrap build and must not drift (JEL-379).');
        });
        console.log('OK 13: diag HUD version ' + configVersion
            + ' matches config.xml widget version (' + diagCalls.length + ' call sites)');
    }

    // Scenario 14 (JEL-627): package.json's version must track config.xml, the
    // single source of truth for the shipped build (scenarios 12/13 pin the two
    // diag literals to it; this pins the workspace manifest). Nothing consumes
    // package.json's version field, which is exactly how it silently drifted to
    // 2.0.0 while config.xml shipped 2.0.18 — a stale manifest misleads anyone
    // reading the workspace. Bump both in lockstep when cutting a release.
    {
        const CONFIG_XML = path.join(__dirname, '..', 'src', 'config.xml');
        const configText = fs.readFileSync(CONFIG_XML, 'utf8');
        const cfgMatch = configText.match(/<widget[^>]*\bversion="([^"]+)"/);
        if (!cfgMatch) fail('scenario 14: widget version not found in config.xml');
        const configVersion = cfgMatch[1];

        const PKG = path.join(__dirname, '..', 'package.json');
        const pkgVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
        if (!pkgVersion) fail('scenario 14: version field not found in package.json');

        if (pkgVersion !== configVersion)
            fail('scenario 14: package.json version (' + pkgVersion + ') must equal '
                + 'config.xml widget version (' + configVersion + '). config.xml is the '
                + 'source of truth for the shipped build — bump package.json in lockstep '
                + '(JEL-627).');
        console.log('OK 14: package.json version ' + pkgVersion
            + ' matches config.xml widget version');
    }

    // JEL-622 scenarios: warm-boot manifest cache. A prior boot cached the
    // manifest's sha256 (+ shellUrl) in localStorage; the bootloader must load
    // the version-pinned (HTTP-cacheable) shell URL IMMEDIATELY — no manifest
    // RTT on the critical path, no ?t=Date.now() cache-buster — while the
    // manifest revalidates in the background for the NEXT boot.

    // Scenario 15: cached hash + manifest timeout → shell?v=<cachedHash> loads
    // anyway (the manifest probe is fully off the critical path).
    {
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            extraStore: { 'jellyfin.shell.hsbCachedHash': 'cafebabe' },
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1)
            fail('scenario 15: expected exactly 1 script append, got ' + scripts.length);
        if (scripts[0].src !== 'https://srv.example/shell/shell.min.js?v=cafebabe')
            fail('scenario 15: expected version-pinned warm load, got ' + scripts[0].src);
        console.log('OK 15: cached manifest hash → shell?v=<hash> despite manifest timeout');
    }

    // Scenario 16: cached hash 'oldhash', live manifest says 'newhash' → THIS
    // boot still loads ?v=oldhash (stale-while-revalidate; no double load),
    // but the background revalidation stores newhash for the next boot.
    {
        const manifest = JSON.stringify({ version: '2.0.0', sha256: 'newhash', shellUrl: null });
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: manifest,
            manifestStatus: 200,
            extraStore: { 'jellyfin.shell.hsbCachedHash': 'oldhash' },
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1)
            fail('scenario 16: expected exactly 1 script append (no double load), got ' + scripts.length);
        if (scripts[0].src !== 'https://srv.example/shell/shell.min.js?v=oldhash')
            fail('scenario 16: warm boot must use the CACHED hash, got ' + scripts[0].src);
        const store = r.sandbox.localStorage.store;
        if (store['jellyfin.shell.hsbCachedHash'] !== 'newhash')
            fail('scenario 16: background revalidation must store the new hash, got '
                + store['jellyfin.shell.hsbCachedHash']);
        if (store['jellyfin.shell.hsbCachedVer'] !== '2.0.0')
            fail('scenario 16: background revalidation must store the new version, got '
                + store['jellyfin.shell.hsbCachedVer']);
        console.log('OK 16: warm boot uses cached hash; revalidation stores the new one for next boot');
    }

    // Scenario 17: cached manifest shellUrl is honored on the warm path, and a
    // cold-path manifest 200 persists shellUrl+hash so the NEXT boot is warm.
    {
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            extraStore: {
                'jellyfin.shell.hsbCachedHash': 'cafebabe',
                'jellyfin.shell.hsbCachedShellUrl': 'https://cdn.example/shell-2.min.js',
            },
        });
        const scripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT'; });
        if (scripts.length !== 1 || scripts[0].src !== 'https://cdn.example/shell-2.min.js?v=cafebabe')
            fail('scenario 17: expected cached shellUrl warm load, got '
                + JSON.stringify(scripts.map(function(s){ return s.src; })));
        const manifest = JSON.stringify({ version: '3.0.0', sha256: 'f00dfeed', shellUrl: 'https://cdn.example/shell-3.min.js' });
        const r2 = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: manifest,
            manifestStatus: 200,
        });
        const store2 = r2.sandbox.localStorage.store;
        if (store2['jellyfin.shell.hsbCachedHash'] !== 'f00dfeed'
            || store2['jellyfin.shell.hsbCachedShellUrl'] !== 'https://cdn.example/shell-3.min.js')
            fail('scenario 17: cold-path manifest 200 must persist hash+shellUrl for the next boot, got '
                + store2['jellyfin.shell.hsbCachedHash'] + ' / ' + store2['jellyfin.shell.hsbCachedShellUrl']);
        console.log('OK 17: cached shellUrl honored warm; cold 200 persists hash+shellUrl');
    }

    // JELA-66 scenarios: hosted-shell byte cache. When the cached manifest
    // sha is unchanged and integrity-valid shell bytes are persisted, the
    // bootloader must execute them inline — ZERO network script loads —
    // while the manifest still revalidates in the background. Every
    // degraded state (stale sha, corrupt record, kill switch) must fall
    // back to the JEL-622 pinned network load unchanged.

    // Scenario 18: warm boot + valid body record → inline execution, no
    // network script, background revalidation still persists a new hash.
    {
        const body = 'window.__testShellRan = (window.__testShellRan || 0) + 1;';
        const manifest = JSON.stringify({ version: '2.1.0', sha256: 'newhash', shellUrl: null });
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: manifest,
            manifestStatus: 200,
            extraStore: {
                'jellyfin.shell.hsbCachedHash': 'cafebabe',
                'jellyfin.shell.hsbShellBody':
                    shellBodyRec('cafebabe', 'https://srv.example/shell/shell.min.js?v=cafebabe', body),
            },
        });
        const netScripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT' && x.src; });
        const inlineScripts = r.log.appended.filter(function(x){ return x.inline; });
        if (netScripts.length !== 0)
            fail('scenario 18: LS hit must append NO network script, got '
                + JSON.stringify(netScripts.map(function(s){ return s.src; })));
        if (inlineScripts.length !== 1)
            fail('scenario 18: expected exactly 1 inline script, got ' + inlineScripts.length);
        if (r.sandbox.window.__testShellRan !== 1)
            fail('scenario 18: cached shell body did not execute');
        if (!r.sandbox.window.__hsbShellLs || r.sandbox.window.__hsbShellLs.st !== 'hit')
            fail('scenario 18: __hsbShellLs.st should be "hit", got '
                + JSON.stringify(r.sandbox.window.__hsbShellLs));
        if (r.sandbox.localStorage.store['jellyfin.shell.hsbCachedHash'] !== 'newhash')
            fail('scenario 18: background revalidation must still store the new hash');
        console.log('OK 18: LS-cached shell executes inline, zero network, revalidation intact');
    }

    // Scenario 19: warm boot, record sha ≠ cached sha (new build adopted
    // last boot) → pinned network load, then the background store fetches
    // the pinned URL and persists an integrity-valid record for NEXT boot.
    {
        const pinned = 'https://srv.example/shell/shell.min.js?v=freshsha';
        const newBody = 'window.__hsbNewShell=1;/*' + 'x'.repeat(1200) + '*/';
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            scriptOk: { [pinned]: true },
            fetchBodies: { [pinned]: newBody },
            extraStore: {
                'jellyfin.shell.hsbCachedHash': 'freshsha',
                'jellyfin.shell.hsbShellBody':
                    shellBodyRec('oldsha', 'https://srv.example/shell/shell.min.js?v=oldsha', 'window.__stale=1;'),
            },
        });
        const netScripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT' && x.src; });
        if (netScripts.length !== 1 || netScripts[0].src !== pinned)
            fail('scenario 19: stale record must fall back to the pinned network load, got '
                + JSON.stringify(netScripts.map(function(s){ return s.src; })));
        if (r.sandbox.window.__stale)
            fail('scenario 19: stale-sha body must NOT execute');
        let rec = null;
        try { rec = JSON.parse(r.sandbox.localStorage.store['jellyfin.shell.hsbShellBody']); } catch(_) {}
        if (!rec || rec.sha !== 'freshsha' || rec.body !== newBody || rec.h !== fnv(newBody))
            fail('scenario 19: background store must persist the new body keyed by freshsha, got '
                + JSON.stringify(rec && { sha: rec.sha, len: rec.len }));
        console.log('OK 19: stale record → network load; new bytes stored for next boot');
    }

    // Scenario 20: kill switch → network path even with a valid record.
    {
        const body = 'window.__testShellRan = 1;';
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            extraStore: {
                'jellyfin.shell.hsbCachedHash': 'cafebabe',
                'jellyfin.shell.hsbShellLsDisabled': '1',
                'jellyfin.shell.hsbShellBody':
                    shellBodyRec('cafebabe', 'https://srv.example/shell/shell.min.js?v=cafebabe', body),
            },
        });
        const netScripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT' && x.src; });
        if (netScripts.length !== 1
            || netScripts[0].src !== 'https://srv.example/shell/shell.min.js?v=cafebabe')
            fail('scenario 20: kill switch must force the pinned network load, got '
                + JSON.stringify(netScripts.map(function(s){ return s.src; })));
        if (r.sandbox.window.__testShellRan)
            fail('scenario 20: kill switch must not execute the cached body');
        console.log('OK 20: hsbShellLsDisabled=1 → pinned network load, no LS execution');
    }

    // Scenario 21: corrupt record (checksum mismatch) → record dropped +
    // pinned network load. A flipped byte must never execute.
    {
        const body = 'window.__testShellRan = 1;';
        const rec = JSON.parse(shellBodyRec('cafebabe', 'https://srv.example/shell/shell.min.js?v=cafebabe', body));
        rec.body = 'window.__corrupt = 1;'; // body no longer matches len/h
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            extraStore: {
                'jellyfin.shell.hsbCachedHash': 'cafebabe',
                'jellyfin.shell.hsbShellBody': JSON.stringify(rec),
            },
        });
        const netScripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT' && x.src; });
        if (netScripts.length !== 1
            || netScripts[0].src !== 'https://srv.example/shell/shell.min.js?v=cafebabe')
            fail('scenario 21: corrupt record must fall back to the pinned network load, got '
                + JSON.stringify(netScripts.map(function(s){ return s.src; })));
        if (r.sandbox.window.__corrupt)
            fail('scenario 21: corrupt body must NOT execute');
        console.log('OK 21: corrupt record dropped → pinned network load');
    }

    // Scenario 22: slow network — the hosted script's onload fires AFTER the
    // 4 s boot budget already triggered the baked fallback (done=true). The
    // byte store must still learn the shell bytes so the NEXT boot executes
    // from LS and never re-races the timer (QN90B/WAN field finding: this
    // race fired every boot, so a guarded store would never run).
    {
        const pinned = 'https://srv.example/shell/shell.min.js?v=slowsha';
        const body = 'window.__hsbSlowShell=1;/*' + 'x'.repeat(1200) + '*/';
        const r = await runScenario({
            serverUrl: 'https://srv.example',
            manifestResponse: 'timeout',
            scriptDelayedOk: { [pinned]: 4300 },
            fetchBodies: { [pinned]: body },
            extraStore: { 'jellyfin.shell.hsbCachedHash': 'slowsha' },
            settleMs: 5000,
        });
        const netScripts = r.log.appended.filter(function(x){ return x.tag === 'SCRIPT' && x.src; });
        if (netScripts.length !== 2 || netScripts[1].src !== 'boot-shell.min.js')
            fail('scenario 22: expected pinned load + baked fallback (budget raced), got '
                + JSON.stringify(netScripts.map(function(s){ return s.src; })));
        let rec = null;
        try { rec = JSON.parse(r.sandbox.localStorage.store['jellyfin.shell.hsbShellBody']); } catch(_) {}
        if (!rec || rec.sha !== 'slowsha' || rec.body !== body)
            fail('scenario 22: late onload must still store the shell bytes, got '
                + JSON.stringify(rec && { sha: rec.sha, len: rec.len }));
        console.log('OK 22: budget-raced late onload still stores bytes for the next boot');
    }

    console.log('ALL SCENARIOS PASS');
})().catch(function(e){ console.error('SELFTEST ERROR', e); process.exit(1); });
