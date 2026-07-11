"use strict";
const assert = require("node:assert");
const { loadLite, fakeStorage } = require("./lite-testkit.cjs");

const Lite = loadLite();

function makeSwr(storage, fresh, opts) {
  const calls = [];
  const swr = Lite.createSwr({
    storage,
    key: "k",
    now: () => 1234,
    fetchFresh: (cb) => {
      if (opts && opts.err) return cb(new Error("net down"), null);
      cb(null, fresh);
    },
  });
  return { swr, calls };
}

// cold boot: no cache -> single render from network, cache written
{
  const st = fakeStorage();
  const { swr } = makeSwr(st, { rows: [1] });
  const renders = [];
  swr.load((data, fromCache) => renders.push([data, fromCache]));
  assert.strictEqual(renders.length, 1);
  assert.deepStrictEqual(renders[0], [{ rows: [1] }, false]);
  assert.deepStrictEqual(JSON.parse(st.getItem("k")), {
    ts: 1234,
    data: { rows: [1] },
  });
}

// warm boot, unchanged payload: exactly ONE render (from cache), no flash
{
  const st = fakeStorage({ k: JSON.stringify({ ts: 1, data: { rows: [1] } }) });
  const { swr } = makeSwr(st, { rows: [1] });
  const renders = [];
  swr.load((data, fromCache) => renders.push(fromCache));
  assert.deepStrictEqual(renders, [true]);
}

// warm boot, changed payload: cache render first, then fresh render
{
  const st = fakeStorage({ k: JSON.stringify({ ts: 1, data: { rows: [1] } }) });
  const { swr } = makeSwr(st, { rows: [1, 2] });
  const renders = [];
  swr.load((data, fromCache) => renders.push([data.rows.length, fromCache]));
  assert.deepStrictEqual(renders, [
    [1, true],
    [2, false],
  ]);
  assert.deepStrictEqual(JSON.parse(st.getItem("k")).data, { rows: [1, 2] });
}

// network failure with cache: cached render stands, no error surfaced
{
  const st = fakeStorage({ k: JSON.stringify({ ts: 1, data: { rows: [1] } }) });
  const { swr } = makeSwr(st, null, { err: true });
  const renders = [];
  let error = null;
  swr.load(
    (data, fromCache) => renders.push(fromCache),
    (e) => (error = e),
  );
  assert.deepStrictEqual(renders, [true]);
  assert.strictEqual(error, null);
}

// network failure without cache: error surfaced, nothing rendered
{
  const st = fakeStorage();
  const { swr } = makeSwr(st, null, { err: true });
  const renders = [];
  let error = null;
  swr.load(
    () => renders.push(1),
    (e) => (error = e),
  );
  assert.strictEqual(renders.length, 0);
  assert.ok(error instanceof Error);
}

// corrupt cache is ignored, not fatal
{
  const st = fakeStorage({ k: "{not json" });
  const { swr } = makeSwr(st, { rows: [9] });
  const renders = [];
  swr.load((data, fromCache) => renders.push(fromCache));
  assert.deepStrictEqual(renders, [false]);
}

// quota failure on write degrades silently (fetch-only mode)
{
  const st = fakeStorage();
  st.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const { swr } = makeSwr(st, { rows: [1] });
  const renders = [];
  swr.load((data, fromCache) => renders.push(fromCache));
  assert.deepStrictEqual(renders, [false]);
}

console.log("swr.test.cjs OK");
