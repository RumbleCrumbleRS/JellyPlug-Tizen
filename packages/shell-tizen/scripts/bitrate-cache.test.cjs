/*
 * JELA-686 (JELA-679/P2): persist the bitrate detection across boots —
 * fleet-ON since JELA-817, opt-OUT since JELA-834 via
 * localStorage['jellyfin.shell.bitrateCache']='0'.
 *
 * Extracts the SHIPPED seed snippet and drives it against the
 * jellyfin-apiclient detectBitrate machinery copied VERBATIM (minified) out
 * of the live bundle node_modules.jellyfin-apiclient.bundle.js, pinning:
 *   - default ON (JELA-834): NO flag -> armed, and indistinguishable from a
 *     store seeded '1'. This is the first-install case; the old opt-in gate
 *     made it inert, so boot 1 spent the ladder and seeded nothing.
 *   - kill switch '0' -> shim inert, every boot runs the full ladder and
 *     nothing is written to localStorage
 *   - boot 1: detects normally (all three rungs: 500 KB / 1 MB / 3 MB) and
 *     persists {bps,t,id}
 *   - boot 2 (a fresh page, same localStorage): ZERO BitrateTest requests,
 *     identical value, hit counted
 *   - boot 2 with the vendor's real boot sequence: serverAddress() ->
 *     onNetworkChange() zeroes lastDetectedBitrate/lastDetectedBitrateTime
 *     BEFORE the probe. This is the case a one-shot field assignment at
 *     onApi would silently lose (see CONTROL below); the wrap survives it.
 *   - CONTROL: the same sequence WITHOUT the shim proves the ladder really
 *     does re-run, so the "zero requests" assertions above cannot pass
 *     vacuously
 *   - forced detectBitrate(true) always measures — this is the path the
 *     playback manager uses, so Direct Play / transcode decisions are made
 *     on a freshly measured value exactly as before
 *   - identity: a different serverId() or serverAddress() misses
 *   - TTL: default 24 h, tunable via 'jellyfin.shell.bitrateTtlMs'
 *   - IsInNetwork floor (140 Mbit/s) round-trips exactly
 *   - a corrupt/hostile store degrades to a real detection, never throws
 *   - a FAILED detection writes nothing (no poisoning the store)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");

// ---- pull the shipped snippet out of the seed array ----------------------
function shimSource() {
  const lines = text.split("\n");
  const flag = lines.findIndex(
    // JELA-834 pins the POLARITY, not just the key: the gate must read for
    // the kill switch. An opt-in '!=="1"' here is boot-1-dead, so a
    // regression to that shape fails this extractor outright.
    (l) => l.includes("jellyfin.shell.bitrateCache") && l.includes('==="0"'),
  );
  assert(flag !== -1, "could not find the bitrateCache shim in " + SRC);
  let a = flag;
  while (!lines[a].includes("try{(function(){")) a--;
  let b = flag;
  while (!lines[b].includes("})();}catch(_){}")) b++;
  const arr = lines
    .slice(a, b + 1)
    .join("\n")
    .replace(/,\s*$/, "");
  // eslint-disable-next-line no-eval
  return eval("[" + arr + "]").join("\n");
}
const SHIM = shimSource();

// ---- JELA-834: no opt-in survivor, in the SOURCE *or* the shipped min -----
// The extractor above proves the opt-out line exists; this proves the opt-in
// line does NOT, in both artifacts. A src edit that never made it through
// build_shell_min.py would leave the fleet on the boot-1-dead gate while this
// suite went green off the source alone.
{
  const OLD_OPTIN = 'localStorage.getItem("jellyfin.shell.bitrateCache")!=="1"';
  const MIN = SRC.endsWith("boot-shell.src.js")
    ? SRC.replace(/boot-shell\.src\.js$/, "boot-shell.min.js")
    : SRC.replace(/shell\.js$/, "shell.min.js");
  const NEW_OPTOUT =
    'localStorage.getItem("jellyfin.shell.bitrateCache")==="0"';
  for (const [label, body] of [
    [SRC, text],
    [MIN, fs.readFileSync(MIN, "utf8")],
  ]) {
    assert(
      !body.includes(OLD_OPTIN),
      "JELA-834: boot-1-dead opt-in gate still present in " + label,
    );
    assert(
      body.includes(NEW_OPTOUT),
      "JELA-834: opt-out gate missing from " + label,
    );
  }
  console.log("OK: JELA-834 — opt-out gate in src AND min, 0 opt-in survivors");
}

// ---- jellyfin-apiclient, verbatim ----------------------------------------
function J(e, t) {
  if (!t)
    return e.lastDetectedBitrate ? e.lastDetectedBitrate : Promise.reject();
  var r = Math.min(Math.round(0.7 * t), 2147483647);
  if (e.getMaxBandwidth) {
    var n = e.getMaxBandwidth();
    n && (r = Math.min(r, n));
  }
  return (
    (e.lastDetectedBitrate = r),
    (e.lastDetectedBitrateTime = new Date().getTime()),
    r
  );
}
function R(e, t, r, n) {
  if (r >= t.length) return J(e, n);
  var i = t[r];
  return e.getDownloadSpeed(i.bytes).then(
    function (n) {
      return n < i.threshold ? J(e, n) : R(e, t, r + 1, n);
    },
    function () {
      return J(e, n);
    },
  );
}
function D(e, t) {
  return R(
    e,
    [
      { bytes: 5e5, threshold: 5e5 },
      { bytes: 1e6, threshold: 2e7 },
      { bytes: 3e6, threshold: 5e7 },
    ],
    0,
  ).then(function (r) {
    return (
      t.IsInNetwork &&
        ((r = Math.max(r || 0, 14e7)),
        (e.lastDetectedBitrate = r),
        (e.lastDetectedBitrateTime = new Date().getTime())),
      r
    );
  });
}

const LADDER = [5e5, 1e6, 3e6];

// ---- one simulated app launch (fresh page, persistent localStorage) ------
function boot(store, opts) {
  opts = opts || {};
  const reqs = [];
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  function ApiClient(addr, id) {
    this._serverInfo = { Id: id };
    this._serverAddress = addr;
    this.enableAutomaticBitrateDetection = true;
  }
  ApiClient.prototype.serverId = function () {
    return this._serverInfo.Id;
  };
  ApiClient.prototype.accessToken = function () {
    return "tok";
  };
  ApiClient.prototype.serverAddress = function (e) {
    if (null != e) {
      this._serverAddress = e;
      this.onNetworkChange();
    }
    return this._serverAddress;
  };
  ApiClient.prototype.onNetworkChange = function () {
    this.lastDetectedBitrate = 0;
    this.lastDetectedBitrateTime = 0;
  };
  ApiClient.prototype.getEndpointInfo = function () {
    return Promise.resolve({ IsInNetwork: !!opts.inNetwork });
  };
  ApiClient.prototype.getDownloadSpeed = function (bytes) {
    reqs.push(bytes);
    return Promise.resolve(opts.speed === undefined ? 6e7 : opts.speed);
  };
  ApiClient.prototype.detectBitrate = function (e) {
    if (
      !e &&
      this.lastDetectedBitrate &&
      new Date().getTime() - (this.lastDetectedBitrateTime || 0) <= 36e5
    )
      return Promise.resolve(this.lastDetectedBitrate);
    var t = this;
    return this.getEndpointInfo().then(
      function (e) {
        return D(t, e);
      },
      function () {
        return D(t, {});
      },
    );
  };

  const api = new ApiClient(
    opts.addr || "https://srv.example",
    opts.id || "S-A",
  );
  // no __shellPaintGate in the sandbox -> the shim's documented fallback
  // arms immediately, which is the same code path onApi(cb) runs.
  const win = { localStorage, ApiClient: api };
  if (!opts.noShim) {
    new Function("window", "localStorage", SHIM)(win, localStorage);
  }
  return { api, reqs, win, store };
}

const ON = () => ({ "jellyfin.shell.bitrateCache": "1" });
const OFF = () => ({ "jellyfin.shell.bitrateCache": "0" });
const KEY = "jellyfin.shell.bitrate";

(async () => {
  // --- JELA-834: key-absent is ARMED and matches a seeded "1" --------------
  // The AC1 differential, pinned in the unit: a first-install boot (no key in
  // LS, because the JSI channel that seeds "1" only runs after the lite→SPA
  // handoff) must behave EXACTLY like a boot seeded "1". Under the old
  // opt-in gate the key-absent arm was inert, so boot 1 both SPENT the
  // 5.77 MB ladder and wrote nothing for boots 2..N to hit.
  // Compare structural facts only — bps is timing-derived in this sandbox.
  {
    const seen = [];
    for (const [name, store] of [
      ["key absent", {}],
      ['seeded "1"', ON()],
    ]) {
      const b1 = boot(store);
      await b1.api.detectBitrate();
      const b2 = boot(store);
      await b2.api.detectBitrate();
      assert.strictEqual(
        b1.win.__shellBitrate && b1.win.__shellBitrate.on,
        1,
        name + ": armed on boot 1",
      );
      assert.deepStrictEqual(b1.reqs, LADDER, name + ": boot 1 measures");
      assert.ok(store[KEY], name + ": boot 1 persists the measurement");
      assert.deepStrictEqual(
        b2.reqs,
        [],
        name + ": boot 2 costs zero requests",
      );
      assert.strictEqual(
        b2.win.__shellBitrate.hits,
        1,
        name + ": boot 2 hits=1",
      );
      seen.push(JSON.stringify([b1.reqs, b2.reqs, b2.win.__shellBitrate.hits]));
    }
    assert.strictEqual(
      seen[0],
      seen[1],
      'key-absent must be indistinguishable from seeded "1"',
    );
    console.log('OK: JELA-834 — key-absent arms, identical to seeded "1"');
  }

  // --- kill switch: "0" leaves the shim inert ------------------------------
  // Rollback is setItem(key,"0"), NEVER removeItem — key-absent is now ON.
  {
    const store = OFF();
    const b1 = boot(store);
    await b1.api.detectBitrate();
    const b2 = boot(store);
    await b2.api.detectBitrate();
    assert.deepStrictEqual(b1.reqs, LADDER, 'flag "0": boot 1 runs the ladder');
    assert.deepStrictEqual(b2.reqs, LADDER, 'flag "0": boot 2 runs it again');
    assert.strictEqual(store[KEY], undefined, 'flag "0": nothing stored');
    assert.strictEqual(b1.win.__shellBitrate, undefined, 'flag "0": no state');
    console.log('OK: kill switch "0" — shim inert, ladder runs every boot');
  }

  // --- CONTROL: without the shim the ladder really does re-run -------------
  {
    const store = ON();
    const b = boot(store, { noShim: true });
    // even a hand-seeded in-memory cache is wiped by the vendor's own boot
    // sequence, which is why this shim wraps instead of assigning fields.
    b.api.lastDetectedBitrate = 42e6;
    b.api.lastDetectedBitrateTime = new Date().getTime();
    b.api.serverAddress("https://srv.example");
    await b.api.detectBitrate();
    assert.deepStrictEqual(
      b.reqs,
      LADDER,
      "CONTROL: onNetworkChange() wipes a pre-seeded in-memory cache",
    );
    console.log(
      "OK: CONTROL — pre-seeded fields are wiped by onNetworkChange(); the zero-request assertions below are not vacuous",
    );
  }

  const store = ON();
  let first;

  // --- AC2 first-ever boot -------------------------------------------------
  {
    const b = boot(store);
    first = await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "boot 1 runs all three rungs");
    assert(store[KEY], "boot 1 persisted");
    const rec = JSON.parse(store[KEY]);
    assert.strictEqual(rec.bps, first, "persisted bps matches the result");
    assert.strictEqual(rec.id, "S-A|https://srv.example", "keyed on id|addr");
    assert.strictEqual(b.win.__shellBitrate.saves, 1, "save counted");
    console.log("OK: AC2 boot 1 — detects normally and persists");
  }

  // --- AC1 second boot -----------------------------------------------------
  {
    const b = boot(store);
    const v = await b.api.detectBitrate();
    assert.deepStrictEqual(
      b.reqs,
      [],
      "boot 2 issues ZERO BitrateTest requests",
    );
    assert.strictEqual(v, first, "boot 2 returns the persisted value");
    assert.strictEqual(b.win.__shellBitrate.hits, 1, "hit counted");
    console.log("OK: AC1 boot 2 — zero requests, same value");
  }

  // --- AC1 with the vendor's real boot sequence ----------------------------
  {
    const b = boot(store);
    b.api.serverAddress("https://srv.example");
    assert.strictEqual(
      b.api.lastDetectedBitrate,
      0,
      "onNetworkChange zeroed it",
    );
    const v = await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, [], "still zero after onNetworkChange()");
    assert.strictEqual(v, first, "still the persisted value");
    console.log("OK: AC1 boot 2 — survives the onNetworkChange() wipe");
  }

  // --- AC3/AC4 forced detection -------------------------------------------
  {
    const b = boot(store);
    await b.api.detectBitrate(true);
    assert.deepStrictEqual(
      b.reqs,
      LADDER,
      "detectBitrate(true) — the playback path — always measures",
    );
    console.log("OK: AC3/AC4 forced detection is never served from the store");
  }

  // --- AC4 identity --------------------------------------------------------
  {
    const b = boot(Object.assign(ON(), { [KEY]: store[KEY] }), { id: "S-B" });
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "different serverId misses");
  }
  {
    const b = boot(Object.assign(ON(), { [KEY]: store[KEY] }), {
      addr: "https://other.example",
    });
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "different serverAddress misses");
  }
  console.log("OK: AC4 a different server or address re-detects");

  // --- TTL -----------------------------------------------------------------
  {
    const rec = JSON.parse(store[KEY]);
    const aged = (h, extra) =>
      Object.assign(ON(), extra, {
        [KEY]: JSON.stringify(
          Object.assign({}, rec, { t: Date.now() - h * 3600 * 1000 }),
        ),
      });
    let b = boot(aged(23));
    await b.api.detectBitrate();
    assert.deepStrictEqual(
      b.reqs,
      [],
      "23 h old is still fresh (24 h default)",
    );

    b = boot(aged(25));
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "25 h old has expired");

    b = boot(aged(2, { "jellyfin.shell.bitrateTtlMs": "3600000" }));
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "ttlMs flag honoured (1 h)");

    // a clock that went backwards must not produce an immortal entry
    b = boot(
      Object.assign(ON(), {
        [KEY]: JSON.stringify(Object.assign({}, rec, { t: Date.now() + 6e5 })),
      }),
    );
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "future-dated entry is rejected");
    console.log("OK: TTL — 24 h default, tunable, clock-skew safe");
  }

  // --- IsInNetwork floor ---------------------------------------------------
  {
    const s = ON();
    const b1 = boot(s, { inNetwork: true });
    const v1 = await b1.api.detectBitrate();
    assert.strictEqual(v1, 14e7, "in-network floors at 140 Mbit/s");
    const b2 = boot(s, { inNetwork: true });
    const v2 = await b2.api.detectBitrate();
    assert.deepStrictEqual(
      b2.reqs,
      [],
      "in-network value is served from store",
    );
    assert.strictEqual(v2, v1, "and round-trips exactly");
    console.log("OK: IsInNetwork floor persists exactly");
  }

  // --- hostile store -------------------------------------------------------
  {
    for (const bad of [
      "not json",
      "null",
      "{}",
      '{"bps":0}',
      '{"bps":-5,"t":1,"id":"x"}',
      "[]",
    ]) {
      const b = boot(Object.assign(ON(), { [KEY]: bad }));
      const v = await b.api.detectBitrate();
      assert.deepStrictEqual(
        b.reqs,
        LADDER,
        "corrupt store re-detects: " + bad,
      );
      assert(v > 0, "and still returns a real value: " + bad);
    }
    // A non-number bps with an OTHERWISE VALID record (matching id, fresh
    // timestamp) would sail past a bare `j.bps>0` truth test — "9e9">0 is
    // true — and hand the web client a string to use as a bitrate.
    for (const bps of ['"9e9"', "true", '"abc"', "{}", "[]"]) {
      const s = Object.assign(ON(), {
        [KEY]: `{"bps":${bps},"t":${Date.now()},"id":"S-A|https://srv.example"}`,
      });
      const b = boot(s);
      const v = await b.api.detectBitrate();
      assert.deepStrictEqual(
        b.reqs,
        LADDER,
        "non-number bps re-detects: " + bps,
      );
      assert.strictEqual(typeof v, "number", "and yields a number: " + bps);
    }
    console.log("OK: corrupt/hostile store degrades to a real detection");
  }

  // --- a failed detection must not poison the store ------------------------
  {
    const s = ON();
    const b = boot(s, { speed: 0 });
    let rejected = false;
    await b.api.detectBitrate().catch(() => {
      rejected = true;
    });
    assert(rejected, "a failed detection still rejects");
    assert(!(KEY in s), "and writes nothing");
    console.log("OK: a failed detection writes nothing");
  }

  // --- double-arm is a no-op (doc.write re-eval of the seed) ---------------
  {
    const s = ON();
    const b = boot(s);
    new Function("window", "localStorage", SHIM)(b.win, {
      getItem: (k) => (k in s ? s[k] : null),
      setItem: (k, v) => {
        s[k] = String(v);
      },
    });
    await b.api.detectBitrate();
    assert.deepStrictEqual(b.reqs, LADDER, "still exactly one ladder, not two");
    console.log("OK: re-running the seed does not double-wrap");
  }

  console.log("bitrate-cache.test.cjs: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
