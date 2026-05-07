(function () {
    'use strict';

    var STORAGE_KEY = 'jellyfin-server-url';
    var bootMessage = null;
    var errorEl = null;
    var formEl = null;
    var inputEl = null;

    function setState(state) {
        document.body.setAttribute('data-state', state);
    }

    function setBootMessage(text) {
        if (bootMessage) bootMessage.textContent = text;
    }

    function setError(text) {
        if (errorEl) errorEl.textContent = text || '';
    }

    function normalizeServerUrl(value) {
        if (!value) return null;
        var trimmed = String(value).trim().replace(/\/+$/, '');
        if (!trimmed) return null;
        if (!/^https?:\/\//i.test(trimmed)) trimmed = 'http://' + trimmed;
        try {
            var u = new URL(trimmed);
            return u.origin + u.pathname.replace(/\/+$/, '');
        } catch (e) {
            return null;
        }
    }

    function showConnectionScreen(message) {
        setError(message || '');
        setState('connect');
        if (inputEl) {
            try { inputEl.focus(); } catch (e) { /* ignore */ }
        }
    }

    function fetchText(url) {
        return fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
            return res.text();
        });
    }

    function rewriteAndMount(serverUrl, html, nativeShimSource) {
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // Strip any pre-existing base so ours wins.
        var existingBase = doc.querySelector('base');
        if (existingBase) existingBase.parentNode.removeChild(existingBase);

        var base = doc.createElement('base');
        base.setAttribute('href', serverUrl + '/web/');
        if (doc.head.firstChild) {
            doc.head.insertBefore(base, doc.head.firstChild);
        } else {
            doc.head.appendChild(base);
        }

        // Strip any existing CSP from upstream — we replace it with the
        // permissive widget policy so cross-origin XHR/img/media work.
        var existingCsp = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
        for (var i = 0; i < existingCsp.length; i++) {
            existingCsp[i].parentNode.removeChild(existingCsp[i]);
        }
        var csp = doc.createElement('meta');
        csp.setAttribute('http-equiv', 'Content-Security-Policy');
        csp.setAttribute('content', "default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: gap: file: filesystem: ws: wss:;");
        base.parentNode.insertBefore(csp, base.nextSibling);

        // webapis.js comes from the Tizen platform path; keep it widget-relative.
        var webapis = doc.createElement('script');
        webapis.setAttribute('src', '$WEBAPIS/webapis/webapis.js');
        csp.parentNode.insertBefore(webapis, csp.nextSibling);

        // jellyfin-web reads window.appMode to enable native paths.
        var appMode = doc.createElement('script');
        appMode.text = "window.appMode='cordova';";
        webapis.parentNode.insertBefore(appMode, webapis.nextSibling);

        // Inline the NativeShell shim so it survives document.open().
        var shim = doc.createElement('script');
        shim.text = nativeShimSource;
        appMode.parentNode.insertBefore(shim, appMode.nextSibling);

        // Defer apploader / main bundle so the shim definitely runs first.
        var loaders = doc.querySelectorAll('script[src*="apploader"], script[src^="main"], script[src*="main."]');
        for (var j = 0; j < loaders.length; j++) loaders[j].setAttribute('defer', '');

        var rendered = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

        document.open('text/html', 'replace');
        document.write(rendered);
        document.close();
    }

    function loadJellyfinWeb(serverUrl) {
        setState('loading');
        setBootMessage('Connecting to ' + serverUrl + '…');
        var indexUrl = serverUrl + '/web/index.html';
        return Promise.all([
            fetchText(indexUrl),
            fetchText('tizen.js')
        ]).then(function (parts) {
            setBootMessage('Loading web client…');
            rewriteAndMount(serverUrl, parts[0], parts[1]);
        });
    }

    function trySaved() {
        var saved = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
        if (!saved) {
            showConnectionScreen('');
            return;
        }
        loadJellyfinWeb(saved).catch(function (err) {
            console.error('Failed to load saved server', err);
            showConnectionScreen('Could not reach ' + saved + ' (' + err.message + ')');
        });
    }

    function handleSubmit(event) {
        event.preventDefault();
        var raw = inputEl ? inputEl.value : '';
        var normalized = normalizeServerUrl(raw);
        if (!normalized) {
            setError('Enter a valid server URL.');
            return;
        }
        setError('');
        try { localStorage.setItem(STORAGE_KEY, normalized); } catch (e) { /* ignore */ }
        loadJellyfinWeb(normalized).catch(function (err) {
            console.error('Failed to load entered server', err);
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
            showConnectionScreen('Could not reach ' + normalized + ' (' + err.message + ')');
        });
    }

    function init() {
        bootMessage = document.getElementById('boot-message');
        errorEl = document.getElementById('connection-error');
        formEl = document.getElementById('server-form');
        inputEl = document.getElementById('server-url');
        if (formEl) formEl.addEventListener('submit', handleSubmit);

        // Tizen Back key on the connection screen exits the app; on the
        // loaded web client, jellyfin-web owns navigation/back semantics.
        document.addEventListener('tizenhwkey', function (e) {
            if (e.keyName === 'back' && document.body.getAttribute('data-state') === 'connect') {
                try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* ignore */ }
            }
        });

        trySaved();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
