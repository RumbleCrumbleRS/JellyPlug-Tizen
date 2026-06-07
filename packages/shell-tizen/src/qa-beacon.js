/* JEL-1971: QA HTTP beacon — outbound DOM telemetry channel for the hourly
 * scout. Replaces `0 debug` AUL handshake (capped at ~2 sessions per TV boot,
 * see JEL-1969) and persistent WebInspector (Samsung silently ignores
 * `web-inspector="enable"` on consumer Tizen 5.0 release-signed WGTs, see
 * JEL-1970).
 *
 * Outbound HTTP works from the Tizen web app sandbox unrestricted because
 * config.xml `<access origin="*">` is already set. The QA host listens on a
 * fixed LAN port and persists each POST as a JSON line; scout polls
 * `GET /latest?serial=...` for current state.
 *
 * Gating:
 *   - off unless localStorage['jellyfin.qa.overlay'] === '1' (same flag as
 *     the QA HUD overlay). Production builds never trip the gate because
 *     index.html sets it only on QA-flavored WGTs.
 *   - beacon URL overridable via localStorage['jellyfin.qa.beaconUrl'];
 *     default `http://192.168.0.20:8731/qa-beacon`.
 *   - tick paused when document.hidden (no telemetry while app backgrounded).
 *   - deferred 5 s post-DOMContentLoaded so cold-boot critical path stays
 *     untouched.
 */
(function () {
  try {
    if (localStorage.getItem("jellyfin.qa.overlay") !== "1") return;
  } catch (e) {
    return;
  }

  var DEFAULT_URL = "http://192.168.0.20:8731/qa-beacon";
  var TICK_MS = 4000;
  var START_DELAY_MS = 5000;
  var MAX_TEXT_LEN = 120;
  var MAX_ERRORS = 20;

  var beaconUrl;
  try {
    beaconUrl = localStorage.getItem("jellyfin.qa.beaconUrl") || DEFAULT_URL;
  } catch (e) {
    beaconUrl = DEFAULT_URL;
  }

  var serial = null;
  try {
    if (
      typeof webapis !== "undefined" &&
      webapis.productinfo &&
      typeof webapis.productinfo.getDuid === "function"
    ) {
      serial = webapis.productinfo.getDuid();
    }
  } catch (e) {}
  if (!serial) {
    try {
      serial = localStorage.getItem("jellyfin.qa.beaconSerial");
      if (!serial) {
        serial = "shell-" + Math.random().toString(36).slice(2, 10);
        try {
          localStorage.setItem("jellyfin.qa.beaconSerial", serial);
        } catch (_) {}
      }
    } catch (e) {
      serial = "shell-unknown";
    }
  }

  var errors = [];
  var seenErrors = {};
  function pushError(s) {
    if (!s) return;
    s = String(s).slice(0, 240);
    if (seenErrors[s]) return;
    seenErrors[s] = 1;
    errors.push(s);
    if (errors.length > MAX_ERRORS) errors.shift();
  }
  try {
    window.addEventListener(
      "error",
      function (ev) {
        try {
          var msg =
            ev && ev.error && ev.error.stack
              ? ev.error.stack.split("\n")[0]
              : (ev && ev.message) || "";
          if (msg) pushError(msg);
        } catch (_) {}
      },
      true,
    );
    window.addEventListener(
      "unhandledrejection",
      function (ev) {
        try {
          var r = ev && ev.reason;
          var msg =
            r && r.stack
              ? r.stack.split("\n")[0]
              : (r && r.message) || String(r || "");
          if (msg) pushError("unhandled: " + msg);
        } catch (_) {}
      },
      true,
    );
  } catch (e) {}

  function descActive() {
    try {
      var el = document.activeElement;
      if (!el) return null;
      var r =
        typeof el.getBoundingClientRect === "function"
          ? el.getBoundingClientRect()
          : null;
      var txt = "";
      try {
        txt = (el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_TEXT_LEN);
      } catch (_) {}
      return {
        tag: el.tagName || null,
        id: el.id || "",
        className:
          typeof el.className === "string"
            ? el.className.slice(0, MAX_TEXT_LEN)
            : "",
        textContent: txt,
        rect: r
          ? {
              x: Math.round(r.left),
              y: Math.round(r.top),
              w: Math.round(r.width),
              h: Math.round(r.height),
            }
          : null,
      };
    } catch (_) {
      return null;
    }
  }

  function getHudText() {
    try {
      var hud = document.getElementById("__qa_hud");
      if (!hud) return null;
      return (hud.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    } catch (_) {
      return null;
    }
  }

  function getQcState() {
    try {
      var creds = localStorage.getItem("jellyfin_credentials");
      if (creds) {
        var p = JSON.parse(creds);
        var s = p && p.Servers && p.Servers[0];
        if (s && s.AccessToken) return "loggedIn";
      }
    } catch (_) {}
    try {
      if (document.querySelector(".btnUseQuickConnect, .qcCode"))
        return "quickConnect";
    } catch (_) {}
    try {
      if (
        document.querySelector(
          ".manualLoginForm, .loginForm, #txtUserName, #txtManualName",
        )
      )
        return "manualLogin";
    } catch (_) {}
    try {
      if (document.querySelector(".userItemContainer, .btnUser"))
        return "userPicker";
    } catch (_) {}
    return "unknown";
  }

  function countCards() {
    try {
      var n = document.querySelectorAll(
        ".card, .listItem, .cardScalable",
      ).length;
      return n;
    } catch (_) {
      return -1;
    }
  }

  // JEL-1974 (v68): one-shot read of `jellyfin.qa.bootMarks.prior` —
  // the boot-mark IIFE in index.html rotated last boot's marks into
  // this key. Beacon emits as payload.priorBootMarks on FIRST POST
  // only, then nulls so subsequent 4 s ticks don't re-send (marks
  // never change mid-boot). Server collector accepts arbitrary fields
  // and persists into ndjson, so no schema change needed.
  var priorBootMarks = null;
  try {
    var rawMarks = localStorage.getItem("jellyfin.qa.bootMarks.prior");
    if (rawMarks) priorBootMarks = JSON.parse(rawMarks);
  } catch (_) {
    priorBootMarks = null;
  }

  function takePriorBootMarks() {
    var v = priorBootMarks;
    priorBootMarks = null;
    return v;
  }

  function buildPayload() {
    var active = descActive();
    var hud = getHudText();
    var cards = countCards();
    var snap = errors.slice(); // copy
    errors.length = 0;
    seenErrors = {};

    var focus = null;
    if (active && active.rect) {
      focus = { y: active.rect.y, w: active.rect.w };
    }

    return {
      ts: Date.now(),
      serial: serial,
      url: (location && location.href) || "",
      title: document.title || "",
      activeElement: active,
      focus: focus,
      hud: hud,
      cards: cards,
      errors: snap,
      qcState: getQcState(),
      screenshotBase64: null,
      ua: (navigator && navigator.userAgent) || "",
      visibility:
        document.visibilityState || (document.hidden ? "hidden" : "visible"),
      priorBootMarks: takePriorBootMarks(),
    };
  }

  var inflight = false;
  function postOnce() {
    if (inflight) return;
    if (document.hidden) return;
    inflight = true;
    var body;
    try {
      body = JSON.stringify(buildPayload());
    } catch (e) {
      inflight = false;
      return;
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", beaconUrl, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 2500;
      xhr.onloadend = function () {
        inflight = false;
      };
      xhr.ontimeout = function () {
        inflight = false;
      };
      xhr.onerror = function () {
        inflight = false;
      };
      xhr.send(body);
    } catch (e) {
      inflight = false;
    }
  }

  function start() {
    try {
      postOnce();
    } catch (_) {}
    setInterval(postOnce, TICK_MS);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(start, START_DELAY_MS);
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(start, START_DELAY_MS);
    });
  }

  try {
    window.__qaBeacon = {
      post: postOnce,
      url: function () {
        return beaconUrl;
      },
      serial: function () {
        return serial;
      },
    };
  } catch (_) {}
})();
