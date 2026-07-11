"use strict";
const assert = require("node:assert");
const { loadLite, fakeStorage } = require("./lite-testkit.cjs");

const Lite = loadLite();
const BASE = "https://jf.example.org";

// vm-sandbox arrays/objects carry a foreign prototype chain that
// deepStrictEqual rejects; JSON round-trip rehomes them
const norm = (x) => JSON.parse(JSON.stringify(x));

// --- readCreds -----------------------------------------------------------

// happy path: first server with a token wins, trailing slash stripped
{
  const st = fakeStorage({
    jellyfin_credentials: JSON.stringify({
      Servers: [
        { Id: "dead", LocalAddress: "https://old.example.org" }, // no token
        {
          Id: "live",
          AccessToken: "tok",
          UserId: "u1",
          ManualAddress: BASE + "/",
          RemoteAddress: "https://far.example.org",
        },
      ],
    }),
  });
  assert.deepStrictEqual(norm(Lite.readCreds(st)), {
    base: BASE,
    token: "tok",
    userId: "u1",
  });
}

// junk / missing storage never throws
assert.strictEqual(Lite.readCreds(fakeStorage()), null);
assert.strictEqual(
  Lite.readCreds(fakeStorage({ jellyfin_credentials: "{oops" })),
  null,
);
assert.strictEqual(
  Lite.readCreds(
    fakeStorage({ jellyfin_credentials: JSON.stringify({ Servers: [] }) }),
  ),
  null,
);

// --- createApi.home ------------------------------------------------------

function fakeServer(routes) {
  const hits = [];
  return {
    hits,
    fetchJson: (url, headers, cb) => {
      hits.push(url);
      assert.strictEqual(headers["X-Emby-Token"], "tok");
      const path = url.slice(BASE.length);
      const match = Object.keys(routes).find((r) => path.indexOf(r) === 0);
      if (!match) return cb(new Error("404 " + path), null);
      cb(null, routes[match]);
    },
  };
}

const movie = (id, name, tag) => ({
  Id: id,
  Name: name,
  Type: "Movie",
  ImageTags: tag ? { Primary: tag } : {},
});

{
  const server = fakeServer({
    "/Users/u1/Items/Resume": { Items: [movie("m1", "Heat", "t1")] },
    "/Shows/NextUp": {
      Items: [
        {
          Id: "e1",
          Name: "Pilot",
          Type: "Episode",
          SeriesName: "Dark",
          SeriesId: "s1",
          SeriesPrimaryImageTag: "ts",
        },
      ],
    },
    "/Users/u1/Views": {
      Items: [
        { Id: "v1", Name: "Movies", CollectionType: "movies" },
        { Id: "v2", Name: "Music", CollectionType: "music" }, // skipped
        { Id: "v3", Name: "Shows", CollectionType: "tvshows" },
      ],
    },
    "/Users/u1/Items/Latest?parentId=v1": [movie("m2", "Ronin", "t2")],
    "/Users/u1/Items/Latest?parentId=v3": [], // empty row -> dropped
  });
  const api = Lite.createApi({
    base: BASE,
    token: "tok",
    userId: "u1",
    fetchJson: server.fetchJson,
  });

  let sections = null;
  api.home((err, s) => {
    assert.strictEqual(err, null);
    sections = s;
  });
  assert.ok(sections, "home() should complete synchronously with a sync fetch");

  // order fixed: Resume, NextUp, Latest-per-view; empty rows dropped
  assert.deepStrictEqual(norm(sections.map((s) => s.id)), [
    "resume",
    "nextup",
    "latest-v1",
  ]);
  assert.strictEqual(sections[0].title, "Continue Watching");

  // episode cards use the SERIES poster (SeriesId + SeriesPrimaryImageTag)
  const ep = sections[1].items[0];
  assert.strictEqual(ep.name, "Dark");
  assert.strictEqual(
    ep.img,
    BASE + "/Items/s1/Images/Primary?maxWidth=400&tag=ts",
  );

  // movie card image uses its own Primary tag
  assert.strictEqual(
    sections[0].items[0].img,
    BASE + "/Items/m1/Images/Primary?maxWidth=400&tag=t1",
  );

  // music view was never fetched
  assert.ok(!server.hits.some((u) => u.indexOf("parentId=v2") >= 0));
}

// item without any image tag -> img null (renderer draws placeholder)
{
  const server = fakeServer({
    "/Users/u1/Items/Resume": {
      Items: [{ Id: "x", Name: "NoArt", Type: "Movie" }],
    },
    "/Shows/NextUp": { Items: [] },
    "/Users/u1/Views": { Items: [] },
  });
  const api = Lite.createApi({
    base: BASE,
    token: "tok",
    userId: "u1",
    fetchJson: server.fetchJson,
  });
  api.home((err, s) => {
    assert.strictEqual(s[0].items[0].img, null);
  });
}

// total failure -> error; partial failure with some rows -> rows win
{
  const dead = { fetchJson: (u, h, cb) => cb(new Error("down"), null) };
  const api = Lite.createApi({
    base: BASE,
    token: "tok",
    userId: "u1",
    fetchJson: dead.fetchJson,
  });
  let got;
  api.home((err, s) => (got = { err, s }));
  assert.ok(got.err instanceof Error);
  assert.strictEqual(got.s, null);
}
{
  const flaky = fakeServer({
    "/Users/u1/Items/Resume": { Items: [movie("m1", "Heat", "t1")] },
    "/Users/u1/Views": { Items: [] },
    // NextUp missing -> per-route error
  });
  const api = Lite.createApi({
    base: BASE,
    token: "tok",
    userId: "u1",
    fetchJson: flaky.fetchJson,
  });
  let got;
  api.home((err, s) => (got = { err, s }));
  assert.strictEqual(got.err, null);
  assert.deepStrictEqual(norm(got.s.map((x) => x.id)), ["resume"]);
}

console.log("api.test.cjs OK");
