/*
 * JELA-833: the /shell/tx-bundle client must COALESCE the hashes it actually
 * discovered — never union the manifest.
 *
 * JELA-824 shipped `ids = Object.keys(mf.entries)`: all 192 manifest entries,
 * 18.8 MB on the wire, `no-store`, every boot, against a ~200 KB baseline of
 * `immutable` per-body GETs (85-97x). The regression was invisible to the
 * per-request tests because every individual behaviour still worked — what was
 * wrong was the SIZE OF THE ID SET. So the first thing pinned here is the
 * negative: ceTxdState must issue NO request at all, and no batch may ever
 * contain a hash nobody asked for.
 *
 * Drives the SHIPPED txBundleAttach() out of both src/shell.js and the
 * bootstrap's boot-shell.src.js under a fake clock + fake fetch, pinning:
 *   - AC2 (bytes): boot-time union is gone; a batch carries exactly the wanted
 *     hashes, deduped, and never a manifest entry that was not wanted
 *   - AC1 (count): a burst of wants collapses to ONE POST; the window DOUBLES
 *     per batch so the batch count is bounded by the log of the discovery span
 *   - one POST in flight at a time — wants raised mid-flight ride the next one
 *   - TXB_MIN: a lone hash is NOT a `no-store` POST, it falls back to the
 *     `immutable` per-body GET (this is also the JEL-621 primer's shape)
 *   - TXB_MAX bounds one response
 *   - AC4 (kill switch): txBundleDisabled=1 leaves d.want undefined in the
 *     SAME boot, which is what routes txDropResolve to the per-body path
 *   - failure isolation: a non-ok, a malformed body, a rejected fetch and a
 *     server-omitted hash all resolve null (= "use the per-body GET"), never
 *     reject and never wedge the queue
 *   - the JELA-824 serialisation is gone: one hash's batch never waits on
 *     another hash's batch
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const SOURCES = [
  ["shell.js", path.join(__dirname, "..", "src", "shell.js")],
  [
    "boot-shell.src.js",
    path.join(
      __dirname,
      "..",
      "..",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.src.js",
    ),
  ],
];

function extractFn(text, name, file) {
  const marker = "function " + name + "(";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + file);
  const i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name + " in " + file);
}

function extractConsts(text, file) {
  const out = [];
  for (const n of ["TXB_W0", "TXB_WMAX", "TXB_MAX", "TXB_MIN"]) {
    const m = new RegExp("var " + n + " = (\\d+);").exec(text);
    assert(m, "could not find var " + n + " in " + file);
    out.push([n, Number(m[1])]);
  }
  return out;
}

// A controllable clock: setTimeout queues, tick(ms) fires what is due.
function makeClock() {
  let now = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    // Advance to the earliest due timer, repeatedly, up to `ms` of clock time.
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < timers.get(next).at))
            next = id;
        }
        if (next === null) break;
        const t = timers.get(next);
        timers.delete(next);
        now = t.at;
        t.fn();
        await drainMicrotasks();
      }
      now = target;
      await drainMicrotasks();
    },
  };
}

const drainMicrotasks = () => new Promise((r) => setImmediate(r));

// Builds a live txBundleAttach bound to injected globals.
function build(text, file, opts) {
  opts = opts || {};
  const consts = extractConsts(text, file);
  const clock = makeClock();
  const posts = []; // {url, ids, resolve, reject}

  const sandbox = {
    Promise,
    Math,
    Date: { now: clock.now },
    JSON,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    txBundleDisabled: () => !!opts.disabled,
    fetch(url, init) {
      const ids = JSON.parse(init.body);
      assert.strictEqual(init.method, "POST", "bundle must be a POST");
      assert.strictEqual(
        init.credentials,
        "omit",
        "bundle must not carry credentials",
      );
      return new Promise((resolve, reject) => {
        posts.push({ url, ids, resolve, reject });
      });
    },
  };
  vm.createContext(sandbox);
  const preamble = consts.map(([n, v]) => `var ${n} = ${v};`).join("\n");
  vm.runInContext(
    preamble +
      "\n" +
      extractFn(text, "txBundleAttach", file) +
      "\nthis.__a = txBundleAttach;",
    sandbox,
  );

  const d = { ok: true, base: "https://s/shell/", h: 0, m: 0, r: 0, f: 0 };
  sandbox.__a(d, "https://s");
  return {
    d,
    posts,
    clock,
    consts: Object.fromEntries(consts),
    // Answer the oldest unanswered POST with a hash->body map.
    async answer(map, mode) {
      const p = posts.find((x) => !x.done);
      assert(p, "no outstanding POST to answer");
      p.done = true;
      if (mode === "reject") p.reject(new Error("net"));
      else if (mode === "notok") p.resolve({ ok: false });
      else if (mode === "badjson")
        p.resolve({ ok: true, json: () => Promise.reject(new Error("bad")) });
      else p.resolve({ ok: true, json: () => Promise.resolve(map) });
      await drainMicrotasks();
      await drainMicrotasks();
      await drainMicrotasks();
    },
  };
}

const settled = (p) => {
  const box = { done: false, value: undefined };
  p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
};

(async () => {
  for (const [label, file] of SOURCES) {
    const text = fs.readFileSync(file, "utf8");
    const L = (s) => `${label}: ${s}`;

    // ---------------------------------------------------------------- A. the
    // regression itself: no boot-time union, anywhere.
    {
      assert(
        !/Object\.keys\(e\)/.test(text),
        L("A: ceTxdState still unions Object.keys(e) — the JELA-824 defect"),
      );
      assert(
        !/bulkReady/.test(text),
        L("A: bulkReady survives — txDropResolve would still serialise on it"),
      );
      const ce = extractFn(text, "ceTxdState", file);
      assert(
        !/fetch\(/.test(ce),
        L("A: ceTxdState must issue NO request of its own"),
      );

      const h = build(text, file);
      await h.clock.advance(60000);
      assert.strictEqual(
        h.posts.length,
        0,
        L("A: attaching the coalescer must not POST anything by itself"),
      );
      console.log("OK " + L("A: no boot-time union; ceTxdState is inert"));
    }

    // ------------------------------------------------- B. AC1/AC2: a burst of
    // wants becomes ONE POST carrying exactly those hashes.
    {
      const h = build(text, file);
      const want = ["aa", "bb", "cc", "dd"].map((x) => settled(h.d.want(x)));
      // deliberate duplicate: must not grow the id set
      const dup = settled(h.d.want("bb"));

      assert.strictEqual(
        h.posts.length,
        0,
        L("B: nothing fires before the window"),
      );
      await h.clock.advance(h.consts.TXB_W0);
      assert.strictEqual(
        h.posts.length,
        1,
        L("B: the burst collapsed to ONE POST"),
      );
      assert.deepStrictEqual(
        [...h.posts[0].ids].sort(),
        ["aa", "bb", "cc", "dd"],
        L("B: the batch carries exactly the wanted hashes, deduped"),
      );
      assert.strictEqual(
        h.posts[0].url,
        "https://s/shell/tx-bundle",
        L("B: posts to /shell/tx-bundle"),
      );

      await h.answer({ aa: "A", bb: "B", cc: "C", dd: "D" });
      assert.deepStrictEqual(
        want.map((w) => w.value),
        ["A", "B", "C", "D"],
        L("B: every waiter gets its own body"),
      );
      assert.strictEqual(
        dup.value,
        "B",
        L("B: the duplicate waiter resolves too"),
      );
      assert.strictEqual(
        h.d.bulkBatches,
        1,
        L("B: bulkBatches counted one POST"),
      );
      assert.strictEqual(
        h.d.bulkWanted,
        4,
        L("B: bulkWanted counts distinct hashes"),
      );

      // A hash already in the map answers with no further request.
      const again = settled(h.d.want("aa"));
      await h.clock.advance(5000);
      assert.strictEqual(
        again.value,
        "A",
        L("B: a cached body resolves immediately"),
      );
      assert.strictEqual(
        h.posts.length,
        1,
        L("B: a cached body issues no POST"),
      );
      console.log(
        "OK " + L("B: a burst coalesces to one POST of exactly the wanted set"),
      );
    }

    // ------------------------------------- C. the window DOUBLES per batch, so
    // the batch count is bounded by log(discovery span), not by hash count.
    {
      const h = build(text, file);
      const W0 = h.consts.TXB_W0;
      // batch 1 at W0
      settled(h.d.want("a1"));
      settled(h.d.want("a2"));
      await h.clock.advance(W0);
      assert.strictEqual(h.posts.length, 1, L("C: batch 1 fired at W0"));
      await h.answer({ a1: "x", a2: "y" });

      // batch 2 must wait 2*W0
      settled(h.d.want("b1"));
      settled(h.d.want("b2"));
      await h.clock.advance(W0);
      assert.strictEqual(
        h.posts.length,
        1,
        L("C: batch 2 did not fire at W0 — the window must have doubled"),
      );
      await h.clock.advance(W0);
      assert.strictEqual(h.posts.length, 2, L("C: batch 2 fired at 2*W0"));
      await h.answer({ b1: "x", b2: "y" });

      // and it keeps doubling, up to the cap
      settled(h.d.want("c1"));
      settled(h.d.want("c2"));
      await h.clock.advance(2 * W0);
      assert.strictEqual(h.posts.length, 2, L("C: batch 3 window is 4*W0"));
      await h.clock.advance(2 * W0);
      assert.strictEqual(h.posts.length, 3, L("C: batch 3 fired at 4*W0"));
      await h.answer({ c1: "x", c2: "y" });

      // The cap holds: however many batches run, the window never exceeds WMAX.
      for (let i = 0; i < 12; i++) {
        settled(h.d.want("d" + i + "a"));
        settled(h.d.want("d" + i + "b"));
        await h.clock.advance(h.consts.TXB_WMAX);
        await h.answer({});
      }
      assert.strictEqual(
        h.posts.length,
        15,
        L("C: every batch still fires within the WMAX cap"),
      );
      console.log(
        "OK " +
          L("C: the debounce window doubles per batch, capped at TXB_WMAX"),
      );
    }

    // ---------------------------------- D. one POST in flight; wants raised
    // mid-flight ride the NEXT batch rather than opening their own.
    {
      const h = build(text, file);
      settled(h.d.want("p1"));
      settled(h.d.want("p2"));
      await h.clock.advance(h.consts.TXB_W0);
      assert.strictEqual(h.posts.length, 1, L("D: first batch out"));

      const mid = ["q1", "q2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_WMAX * 4);
      assert.strictEqual(
        h.posts.length,
        1,
        L("D: a second POST must not start while one is in flight"),
      );
      assert.ok(
        mid.every((m) => !m.done),
        L("D: mid-flight wants are still pending"),
      );

      await h.answer({ p1: "P1", p2: "P2" });
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(
        h.posts.length,
        2,
        L("D: the next batch fired after settle"),
      );
      assert.deepStrictEqual(
        [...h.posts[1].ids].sort(),
        ["q1", "q2"],
        L("D: it carries exactly the mid-flight wants"),
      );
      await h.answer({ q1: "Q1", q2: "Q2" });
      assert.deepStrictEqual(
        mid.map((m) => m.value),
        ["Q1", "Q2"],
        L("D: mid-flight waiters resolved from the second batch"),
      );
      console.log(
        "OK " + L("D: one POST in flight; mid-flight wants ride the next"),
      );
    }

    // ------------------------------------- E. TXB_MIN: a lone hash is a GET,
    // not a `no-store` POST. Same round trip, and only the GET is cacheable.
    {
      const h = build(text, file);
      const solo = settled(h.d.want("lonely"));
      await h.clock.advance(h.consts.TXB_WMAX * 2);
      assert.strictEqual(
        h.posts.length,
        0,
        L("E: a sub-TXB_MIN batch must not become a bundle POST"),
      );
      assert.strictEqual(
        solo.value,
        null,
        L("E: the lone waiter resolves null = use the per-body GET"),
      );
      assert.strictEqual(
        h.d.bulkSolo,
        1,
        L("E: bulkSolo counted the fallback"),
      );

      // ...and the queue is not wedged: a real batch still works afterwards.
      const pair = ["m1", "m2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(h.posts.length, 1, L("E: a later batch still fires"));
      await h.answer({ m1: "M1", m2: "M2" });
      assert.deepStrictEqual(
        pair.map((p) => p.value),
        ["M1", "M2"],
        L("E: and resolves normally"),
      );
      console.log(
        "OK " + L("E: a lone hash falls back to the immutable per-body GET"),
      );
    }

    // ---------------------------------------------- F. TXB_MAX bounds one POST.
    {
      const h = build(text, file);
      const n = h.consts.TXB_MAX + 5;
      for (let i = 0; i < n; i++) settled(h.d.want("h" + i));
      await h.clock.advance(h.consts.TXB_W0);
      assert.strictEqual(h.posts.length, 1, L("F: one POST"));
      assert.strictEqual(
        h.posts[0].ids.length,
        h.consts.TXB_MAX,
        L("F: capped at TXB_MAX ids"),
      );
      await h.answer({});
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(
        h.posts.length,
        2,
        L("F: the remainder went out next"),
      );
      assert.strictEqual(
        h.posts[1].ids.length,
        5,
        L("F: exactly the remainder"),
      );
      console.log("OK " + L("F: TXB_MAX bounds a single response"));
    }

    // -------------------------------- G. AC4: the kill switch, in the SAME boot.
    {
      const h = build(text, file, { disabled: true });
      assert.strictEqual(
        h.d.want,
        undefined,
        L("G: txBundleDisabled=1 must leave d.want undefined"),
      );
      assert.strictEqual(
        h.d.bulkBodies,
        undefined,
        L("G: and install no bundle state at all"),
      );
      await h.clock.advance(60000);
      assert.strictEqual(h.posts.length, 0, L("G: and issue no POST"));
      // txDropResolve reads exactly this to choose the per-body path.
      assert(
        /d\.want \? d\.want\(hash\)/.test(text),
        L("G: txDropResolve must gate on d.want"),
      );
      assert(
        /d\.want\?d\.want\(hash\)/.test(text),
        L("G: the inline seed must gate on d.want too"),
      );
      console.log(
        "OK " + L("G: kill switch disarms the bundle in the same boot"),
      );
    }

    // ------------------------------- H. failure isolation. Every failure mode
    // resolves null (= per-body GET), never rejects, never wedges the queue.
    for (const mode of ["reject", "notok", "badjson"]) {
      const h = build(text, file);
      const w = ["f1", "f2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_W0);
      await h.answer(null, mode);
      assert.deepStrictEqual(
        w.map((x) => x.value),
        [null, null],
        L("H: " + mode + " resolves every waiter null"),
      );
      const after = ["g1", "g2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(
        h.posts.length,
        2,
        L("H: " + mode + " left the queue usable"),
      );
      await h.answer({ g1: "G1", g2: "G2" });
      assert.deepStrictEqual(
        after.map((x) => x.value),
        ["G1", "G2"],
        L("H: " + mode + " — later batches still work"),
      );
    }
    console.log(
      "OK " + L("H: net failure, non-ok and bad JSON all fall back cleanly"),
    );

    // A hash the server omits from an otherwise-good map is a per-body GET.
    {
      const h = build(text, file);
      const [a, b] = ["k1", "k2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_W0);
      await h.answer({ k1: "K1" }); // k2 deliberately absent
      assert.strictEqual(a.value, "K1", L("I: the present hash is served"));
      assert.strictEqual(
        b.value,
        null,
        L("I: the omitted hash resolves null = per-body GET"),
      );
      // and asking again re-queues it rather than answering from a poisoned map
      const retry = settled(h.d.want("k2"));
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(retry.done, true, L("I: a re-want settles"));
      console.log("OK " + L("I: a server-omitted hash falls back per-body"));
    }

    // ------------------- J. the JELA-824 serialisation is gone: one hash never
    // waits on an unrelated hash's batch.
    {
      const h = build(text, file);
      const [s1, s2] = ["s1", "s2"].map((x) => settled(h.d.want(x)));
      await h.clock.advance(h.consts.TXB_W0);
      await h.answer({ s1: "S1", s2: "S2" });
      assert.ok(s1.done && s2.done, L("J: the first batch settled"));
      // A later, still-unanswered batch must not retroactively block them.
      settled(h.d.want("t1"));
      settled(h.d.want("t2"));
      await h.clock.advance(h.consts.TXB_WMAX);
      assert.strictEqual(
        h.posts.length,
        2,
        L("J: a second batch is outstanding"),
      );
      assert.strictEqual(s1.value, "S1", L("J: earlier waiters stay resolved"));
      console.log(
        "OK " + L("J: no global barrier — batches settle independently"),
      );
    }
  }

  console.log("all checks passed");
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
