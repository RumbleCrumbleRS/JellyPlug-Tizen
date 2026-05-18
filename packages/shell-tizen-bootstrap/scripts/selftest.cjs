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

function makeEnv({ serverUrl, manifestResponse, manifestStatus, scriptErrors, scriptOk }) {
    const log = { appended: [], formAttached: false, errorShown: null };
    const head = { tagName: 'HEAD', appendChild(node) {
        log.appended.push({ tag: node.tagName, src: node.src });
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
    form.addEventListener = function(ev, cb){ if (ev === 'submit') log.formAttached = true; };
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
        store: { 'jellyfin.shell.serverUrl': savedUrl },
        getItem(k){ return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
        setItem(k, v){ this.store[k] = String(v); },
    };

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

    return {
        log,
        sandbox: {
            window: { __qaMarks: null },
            document,
            location: { reload: function(){ log.reloaded = true; } },
            localStorage,
            XMLHttpRequest: FakeXHR,
            setTimeout, clearTimeout, setImmediate,
            console: { warn: function(){}, log: function(){} },
            Date,
            encodeURIComponent,
            JSON,
        },
    };
}

async function runScenario(opts) {
    const env = makeEnv(opts);
    vm.createContext(env.sandbox);
    vm.runInContext(SOURCE, env.sandbox);
    await new Promise(function(resolve){ setTimeout(resolve, 50); });
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

    console.log('ALL SCENARIOS PASS');
})().catch(function(e){ console.error('SELFTEST ERROR', e); process.exit(1); });
