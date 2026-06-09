// wgt-emulate Tizen native-API stub.
//
// The bootstrap WGT itself touches NO Tizen native APIs — it is pure web
// (localStorage / XHR / DOM), so it runs in a desktop browser unmodified. This
// stub only matters once a *real* hosted shell.min.js takes over, because that
// code reaches for window.tizen / window.webapis / NativeShell. Without a stub
// those references throw and the shell dies on a desktop browser.
//
// This is a SHIM, not an emulator: it satisfies the API surface the shell
// probes at startup so it gets far enough to render. It does not reproduce TV
// behaviour (real remote keys, productinfo, app lifecycle). For that fidelity,
// use the Tizen TV Emulator (see README, Tier 3).
(function () {
  if (
    window.tizen &&
    window.tizen.__wgtEmulateStub !== true &&
    window.tizen.application
  ) {
    // A real Tizen runtime is present (e.g. running inside the TV emulator) —
    // don't clobber it.
    return;
  }

  function noop() {}

  var tizen = {
    __wgtEmulateStub: true,
    application: {
      getCurrentApplication: function () {
        return {
          appInfo: { id: "JelShellTV.Jellyfin", packageId: "JelShellTV" },
          exit: function () {
            try {
              console.log("[tizen-stub] app.exit()");
            } catch (_) {}
          },
          hide: noop,
        };
      },
      getAppInfo: function () {
        return { id: "JelShellTV.Jellyfin" };
      },
    },
    tvinputdevice: {
      // The shell registers TV remote keys here. Accept and remember them so
      // nothing throws; real key delivery is the browser's own keydown events.
      _registered: [],
      getSupportedKeys: function () {
        // Codes MUST match the canonical 12-key contract pinned in
        // packages/shell-tizen/scripts/media-keys.test.cjs. (JEL-35) The earlier
        // list was incomplete (no MediaPlayPause / MediaTrackPrevious / MediaTrackNext).
        // Note 412/417 are Rewind/FastForward and 10232/10233 are TrackPrevious/
        // TrackNext — verified against the Samsung Tizen remote keycodes and
        // jellyfin-web 10.11.10's live KeyNames table. Keep in lockstep with the
        // keymap so the stub mirrors the 12 keys shell.js registers.
        return [
          { name: "MediaPlay", code: 415 },
          { name: "MediaPause", code: 19 },
          { name: "MediaPlayPause", code: 10252 },
          { name: "MediaStop", code: 413 },
          { name: "MediaRewind", code: 412 },
          { name: "MediaFastForward", code: 417 },
          { name: "MediaTrackPrevious", code: 10232 },
          { name: "MediaTrackNext", code: 10233 },
          { name: "ColorF0Red", code: 403 },
          { name: "ColorF1Green", code: 404 },
          { name: "ColorF2Yellow", code: 405 },
          { name: "ColorF3Blue", code: 406 },
        ];
      },
      registerKey: function (name) {
        this._registered.push(name);
      },
      registerKeyBatch: function (names) {
        var self = this;
        (names || []).forEach(function (n) {
          self._registered.push(n);
        });
        try {
          console.log("[tizen-stub] registerKeyBatch", names);
        } catch (_) {}
      },
      unregisterKey: noop,
    },
    systeminfo: {
      getCapability: function (key) {
        // Best-effort sane defaults for the few caps the shell tends to probe.
        if (key === "http://tizen.org/feature/screen.size.normal.1080.1920")
          return true;
        return null;
      },
      getPropertyValue: function (prop, onSuccess) {
        if (typeof onSuccess === "function") onSuccess({});
      },
    },
  };

  var webapis = {
    __wgtEmulateStub: true,
    productinfo: {
      getVersion: function () {
        return "EMU-0000";
      },
      getFirmware: function () {
        return "EMU-FW";
      },
      getModel: function () {
        return "EMU-MODEL";
      },
      getModelCode: function () {
        return "EMU";
      },
      getDuid: function () {
        return "emulated-duid";
      },
      isUdPanelSupported: function () {
        return false;
      },
      is8KPanelSupported: function () {
        return false;
      },
      getRealModel: function () {
        return "EMU-MODEL";
      },
    },
    avplay: {
      // Playback is out of scope for the browser harness; expose the surface so
      // probing it doesn't throw, but log loudly so nobody mistakes it for real.
      open: function (u) {
        try {
          console.warn("[tizen-stub] avplay.open is a no-op:", u);
        } catch (_) {}
      },
      prepare: noop,
      play: noop,
      pause: noop,
      stop: noop,
      close: noop,
      setListener: noop,
      setDisplayRect: noop,
      getState: function () {
        return "NONE";
      },
    },
    appcommon: {
      AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 1, SCREEN_SAVER_ON: 2 },
      setScreenSaver: noop,
    },
  };

  window.tizen = tizen;
  window.webapis = webapis;
  // Some Jellyfin Tizen shells expect a NativeShell shim too; provide a thin one
  // so feature probes don't crash. The hosted shell normally builds its own.
  if (!window.NativeShell) {
    window.NativeShell = {
      __wgtEmulateStub: true,
      AppHost: {
        init: function () {
          return Promise.resolve();
        },
        appName: function () {
          return "Jellyfin (wgt-emulate)";
        },
        appVersion: function () {
          return "emu";
        },
        deviceName: function () {
          return "wgt-emulate";
        },
        exit: noop,
        supports: function () {
          return false;
        },
      },
    };
  }

  try {
    console.log(
      "[tizen-stub] window.tizen / webapis / NativeShell stubbed for browser emulation",
    );
  } catch (_) {}
})();
