#!/usr/bin/env python3
"""JEL-131 QA capture harness splicer.

Extends the baked QA beacon (qaBeaconBody) in boot-shell.src.js with:
  - probe fields for the JEL-131 timing capture (tx hit/miss counters,
    __shellTxPrime, tx key count) and the JEL-138 creds investigation
    (enableAutoLogin, jellyfin_credentials token count, credsTrail,
    __shellCredsGuard, chkRememberLogin rendered state);
  - an ntfy cfg-topic command channel (JEL-130/132 pattern):
      jcmd:<id>:prep:<coldoff|warmlogin|coldon>  state setup between boots
      jcmd:<id>:login:<user>:<pass>              scripted manual-form login
                                                 with ms-precision timing marks
      jcmd:<id>:farewell                         clear jellyfin.qa.* and exit
and adds the QA localStorage seed to index.html (qa branch only, never
merged to main; retail builds do not contain any of this).

Run from the repo root of the qa/jel131-capture worktree. Idempotent.
"""

import re
import sys

BOOT = "packages/shell-tizen-bootstrap/src/boot-shell.src.js"
INDEX = "packages/shell-tizen-bootstrap/src/index.html"
TOPIC = "jel131cap-0baa6564"

# ---------------------------------------------------------------- probe ----
PROBE_RAW = """\
        // JEL-131/JEL-138 capture probe (names/counters only, never token values)
        try { p.ct = localStorage.getItem('jellyfin.shell.credsTrail'); } catch (e) { p.ct = 'ERR'; }
        try { p.cg = window.__shellCredsGuard || null; } catch (e) { p.cg = null; }
        try { p.cr = window.__shellCredsRestored || 0; } catch (e) { p.cr = -1; }
        try { p.eal = localStorage.getItem('enableAutoLogin'); } catch (e) { p.eal = 'ERR'; }
        try { p.lsn = localStorage.length; } catch (e) { p.lsn = -1; }
        try { p.tp = window.__shellTxPrime || null; } catch (e) { p.tp = null; }
        try { p.txh = window.__shellTxCacheHits || 0; p.txm = window.__shellTxCacheMisses || 0; } catch (e) {}
        try { var cr2 = localStorage.getItem('jellyfin_credentials'); if (cr2 == null) { p.cred = 'absent'; } else { var cj = JSON.parse(cr2); var sv2 = (cj && cj.Servers) || []; var tn = 0; for (var si = 0; si < sv2.length; si++) if (sv2[si] && sv2[si].AccessToken) tn++; p.cred = 'n=' + sv2.length + ' tok=' + tn; } } catch (e) { p.cred = 'ERR'; }
        try { var txn = 0; for (var ti = 0; ti < localStorage.length; ti++) { if (String(localStorage.key(ti)).indexOf('shell.tx') === 0) txn++; } p.txN = txn; } catch (e) { p.txN = -1; }
        try { p.bn = localStorage.getItem('jellyfin.shell.legacy.babelNeeded'); } catch (e) { p.bn = 'ERR'; }
        try { var ckp = document.querySelector('.chkRememberLogin'); p.chk = ckp ? (ckp.checked ? 1 : 0) : null; } catch (e) { p.chk = 'ERR'; }
        try { p.lg = window.__qaLoginMark || null; } catch (e) { p.lg = null; }
        try { p.cmdId = localStorage.getItem('jellyfin.qa.lastCmdId'); } catch (e) { p.cmdId = null; }
"""

# ------------------------------------------------------------- commands ----
CMDS_RAW = """\
    // JEL-131 capture: ntfy cfg-topic command channel (JEL-130/132 pattern).
    // Commands are id-suffixed and deduped via jellyfin.qa.lastCmdId (a
    // jellyfin.qa.* key, so prep wipes preserve it). login retries until the
    // manual form is visible and only then consumes its id.
    var SRV = 'https://REDACTED-SERVER.example';
    function ackExit(obj) {
        try {
            var xa = new XMLHttpRequest();
            xa.open('POST', beaconUrl, true);
            xa.setRequestHeader('Content-Type', 'application/json');
            xa.timeout = 2500;
            var dn = function () { try { tizen.application.getCurrentApplication().exit(); } catch (_) {} };
            xa.onloadend = dn; xa.ontimeout = dn; xa.onerror = dn;
            obj.ts = Date.now(); obj.serial = serial;
            xa.send(JSON.stringify(obj));
        } catch (e) { try { tizen.application.getCurrentApplication().exit(); } catch (_) {} }
    }
    function delVault(cb) {
        var done = false;
        function fin() { if (!done) { done = true; cb(); } }
        setTimeout(fin, 2500);
        try { var rq = indexedDB.deleteDatabase('jellyfin_shell'); rq.onsuccess = fin; rq.onerror = fin; rq.onblocked = fin; } catch (e) { fin(); }
    }
    function wipeNonQa() {
        var ks = [];
        try { for (var i = 0; i < localStorage.length; i++) ks.push(String(localStorage.key(i))); } catch (_) {}
        var n = 0;
        for (var j = 0; j < ks.length; j++) { if (ks[j].indexOf('jellyfin.qa.') !== 0) { try { localStorage.removeItem(ks[j]); n++; } catch (_) {} } }
        return n;
    }
    function rmTx() {
        var tk = [];
        try { for (var i = 0; i < localStorage.length; i++) { var kn = String(localStorage.key(i)); if (kn.indexOf('shell.tx') === 0) tk.push(kn); } } catch (_) {}
        for (var j = 0; j < tk.length; j++) { try { localStorage.removeItem(tk[j]); } catch (_) {} }
        return tk.length;
    }
    function doPrep(id, mode) {
        if (mode === 'coldoff') {
            var n = wipeNonQa();
            try { localStorage.setItem('jellyfin.shell.serverUrl', SRV); } catch (_) {}
            try { localStorage.setItem('jellyfin.shell.txPrimeDisabled', '1'); } catch (_) {}
            delVault(function () { ackExit({ prep: mode, id: id, wiped: n }); });
            return;
        }
        if (mode === 'warmlogin') {
            try { localStorage.removeItem('jellyfin_credentials'); } catch (_) {}
            delVault(function () { ackExit({ prep: mode, id: id }); });
            return;
        }
        if (mode === 'coldon') {
            try { localStorage.removeItem('jellyfin_credentials'); } catch (_) {}
            var n2 = rmTx();
            try { localStorage.removeItem('jellyfin.shell.txPrimeDisabled'); } catch (_) {}
            delVault(function () { ackExit({ prep: mode, id: id, tx: n2 }); });
            return;
        }
        ackExit({ prep: 'unknown', id: id });
    }
    var loginBusy = false;
    function doLogin(id, user, pass) {
        if (loginBusy) return true;
        var form = document.querySelector('.manualLoginForm');
        if (!form) return false;
        var vis = true;
        try { vis = form.getBoundingClientRect().height > 0 && !(form.classList && form.classList.contains('hide')); } catch (_) {}
        if (!vis) {
            var bm = document.querySelector('.btnManual');
            if (bm) { try { bm.click(); } catch (_) {} }
            return false;
        }
        var nameEl = document.querySelector('#txtManualName');
        var passEl = document.querySelector('#txtManualPassword');
        if (!nameEl || !passEl) return false;
        loginBusy = true;
        var chkPre = null;
        try { var ck = document.querySelector('.chkRememberLogin'); if (ck) { chkPre = ck.checked ? 1 : 0; ck.checked = true; } } catch (_) {}
        try { nameEl.value = user; passEl.value = pass; } catch (_) {}
        var mark = { id: id, t0: Date.now(), chkPre: chkPre, tHome: 0, tCards: 0 };
        try { window.__qaLoginMark = mark; } catch (_) {}
        try { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch (e) { mark.err = String((e && e.message) || e).slice(0, 80); }
        var iv = setInterval(function () {
            try {
                if (!mark.tHome && String(location.href).indexOf('home') >= 0) mark.tHome = Date.now();
                var nc = document.querySelectorAll('.card[data-id]').length;
                if (mark.tHome && !mark.tCards && nc > 0) {
                    mark.tCards = Date.now();
                    mark.cards = nc;
                    clearInterval(iv);
                    try {
                        var xb = new XMLHttpRequest();
                        xb.open('POST', beaconUrl, true);
                        xb.setRequestHeader('Content-Type', 'application/json');
                        xb.send(JSON.stringify({ ts: Date.now(), serial: serial, loginMark: mark, txh: window.__shellTxCacheHits || 0, txm: window.__shellTxCacheMisses || 0, tp: window.__shellTxPrime || null, eal: localStorage.getItem('enableAutoLogin'), cg: window.__shellCredsGuard || null }));
                    } catch (_) {}
                }
            } catch (_) {}
        }, 250);
        return true;
    }
    var farewellArmed = false;
    function doFarewell() {
        farewellArmed = true;
        var keys = [];
        try { for (var i = 0; i < localStorage.length; i++) keys.push(String(localStorage.key(i))); } catch (_) {}
        var n = 0;
        for (var j = 0; j < keys.length; j++) { if (keys[j].indexOf('jellyfin.qa.') === 0) { try { localStorage.removeItem(keys[j]); n++; } catch (_) {} } }
        ackExit({ farewell: 1, cleared: n });
    }
    var cfgBusy = false;
    function pollCfg() {
        if (farewellArmed || cfgBusy) return;
        var cfgUrl = null;
        try { cfgUrl = localStorage.getItem('jellyfin.qa.cfgUrl'); } catch (_) {}
        if (!cfgUrl) return;
        cfgBusy = true;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', cfgUrl, true);
            xhr.timeout = 4000;
            xhr.onloadend = function () { cfgBusy = false; };
            xhr.onload = function () {
                try {
                    if (xhr.status !== 200) return;
                    var rt = String(xhr.responseText || '');
                    var re = /jcmd:([a-z0-9]+):([a-z]+)(?::([^\\s"]+))?/g;
                    var m, last = null;
                    while ((m = re.exec(rt))) last = m;
                    if (!last) return;
                    var seen = null;
                    try { seen = localStorage.getItem('jellyfin.qa.lastCmdId'); } catch (_) {}
                    if (seen === last[1]) return;
                    if (last[2] === 'farewell') { try { localStorage.setItem('jellyfin.qa.lastCmdId', last[1]); } catch (_) {} doFarewell(); return; }
                    if (last[2] === 'prep') { try { localStorage.setItem('jellyfin.qa.lastCmdId', last[1]); } catch (_) {} doPrep(last[1], last[3] || ''); return; }
                    if (last[2] === 'login') {
                        var parts = String(last[3] || '').split(':');
                        if (doLogin(last[1], decodeURIComponent(parts[0] || ''), decodeURIComponent(parts[1] || ''))) {
                            try { localStorage.setItem('jellyfin.qa.lastCmdId', last[1]); } catch (_) {}
                        }
                        return;
                    }
                } catch (_) {}
            };
            xhr.send();
        } catch (e) { cfgBusy = false; }
    }
"""

SEED = """    <script data-jel131-qa>
        // JEL-131 QA capture seed - qa branch only, NOT for retail.
        try {
            localStorage.setItem("jellyfin.qa.overlay", "1");
            localStorage.setItem("jellyfin.qa.beaconUrl", "https://ntfy.envs.net/%TOPIC%-beacon");
            localStorage.setItem("jellyfin.qa.cfgUrl", "https://ntfy.envs.net/%TOPIC%-cfg/raw?poll=1");
        } catch (e) {}
    </script>
""".replace("%TOPIC%", TOPIC)


def esc(raw):
    """Escape raw JS into the contents of a double-quoted JS string literal."""
    return raw.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def main():
    src = open(BOOT, encoding="utf-8").read()
    if "jcmd:" in src:
        print("boot-shell.src.js already spliced")
    else:
        # 1) probe fields before `return p;` in collectProbe
        anchor_probe = esc(
            "        try { p.realCards = document.querySelectorAll('.card[data-id]').length; } catch (e) { p.realCards = -1; }\n"
        )
        assert src.count(anchor_probe) == 1, "probe anchor not unique"
        src = src.replace(anchor_probe, anchor_probe + esc(PROBE_RAW))

        # 2) command machinery before start(), and pollCfg interval inside start()
        anchor_start = esc(
            "    function start() {\n        try { postOnce(); } catch (_) {}\n        setInterval(postOnce, TICK_MS);\n    }\n"
        )
        assert src.count(anchor_start) == 1, "start anchor not unique"
        replacement = esc(CMDS_RAW) + esc(
            "    function start() {\n        try { postOnce(); } catch (_) {}\n        setInterval(postOnce, TICK_MS);\n        setInterval(pollCfg, 8000);\n    }\n"
        )
        src = src.replace(anchor_start, replacement)
        open(BOOT, "w", encoding="utf-8").write(src)
        print("boot-shell.src.js spliced")

    html = open(INDEX, encoding="utf-8").read()
    if "data-jel131-qa" in html:
        print("index.html already seeded")
    else:
        anchor = '    <div id="hsb-status" class="hsb-hidden"></div>\n'
        assert html.count(anchor) == 1, "index anchor not unique"
        html = html.replace(anchor, anchor + SEED)
        open(INDEX, "w", encoding="utf-8").write(html)
        print("index.html seeded")


if __name__ == "__main__":
    sys.exit(main())
