// Shared test loader: evaluates src/lite.src.js in a bare sandbox (no
// window, no DOM) and returns the JellyPlugLite namespace. The source's
// UMD-ish footer attaches to `this` when `window` is undefined, which
// inside vm.runInContext is the sandbox object itself.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadLite(extras) {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "lite.src.js"),
    "utf8",
  );
  const sandbox = Object.assign(
    { Date, JSON, Math, Error, String, Object },
    extras,
  );
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "lite.src.js" });
  if (!sandbox.JellyPlugLite) {
    throw new Error("lite.src.js did not attach JellyPlugLite to the sandbox");
  }
  return sandbox.JellyPlugLite;
}

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

module.exports = { loadLite, fakeStorage };
