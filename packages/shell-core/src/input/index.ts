// Translate platform TV-remote keycodes into W3C standard `KeyboardEvent.key`
// values that jellyfin-web's focus engine expects.
//
// Each platform shell imports the relevant translator and uses it in its
// dispatch path. Tables stay here so all three platforms share canonical
// names and we avoid drift.

export type StandardKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Enter"
  | "Escape" // mapped from "Back" on TV
  | "Backspace"
  | "MediaPlay"
  | "MediaPause"
  | "MediaPlayPause"
  | "MediaStop"
  | "MediaTrackNext"
  | "MediaTrackPrevious"
  | "MediaFastForward"
  | "MediaRewind"
  | "ColorF0Red"
  | "ColorF1Green"
  | "ColorF2Yellow"
  | "ColorF3Blue"
  | "Home"
  | "ContextMenu";

// Tizen: tizen.tvinputdevice keycodes.
// See https://docs.tizen.org/application/web/api/latest/device_api/tv/tizen/tvinputdevice.html
export const TIZEN_KEYMAP: Readonly<Record<number, StandardKey>> =
  Object.freeze({
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    13: "Enter",
    10009: "Escape", // Tizen "Back"
    415: "MediaPlay",
    19: "MediaPause",
    10252: "MediaPlayPause",
    413: "MediaStop",
    417: "MediaTrackNext",
    412: "MediaTrackPrevious",
    10233: "MediaFastForward",
    10232: "MediaRewind",
    403: "ColorF0Red",
    404: "ColorF1Green",
    405: "ColorF2Yellow",
    406: "ColorF3Blue",
  });

// webOS Magic Remote / standard remote keycodes.
// See https://webostv.developer.lge.com/develop/references/key-codes
export const WEBOS_KEYMAP: Readonly<Record<number, StandardKey>> =
  Object.freeze({
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    13: "Enter",
    461: "Escape", // webOS "Back"
    415: "MediaPlay",
    19: "MediaPause",
    413: "MediaStop",
    417: "MediaTrackNext",
    412: "MediaTrackPrevious",
    403: "ColorF0Red",
    404: "ColorF1Green",
    405: "ColorF2Yellow",
    406: "ColorF3Blue",
  });

// Android TV KeyEvent codes (android.view.KeyEvent.KEYCODE_*).
// Subset relevant to media playback + d-pad.
export const ANDROID_KEYMAP: Readonly<Record<number, StandardKey>> =
  Object.freeze({
    19: "ArrowUp",
    20: "ArrowDown",
    21: "ArrowLeft",
    22: "ArrowRight",
    23: "Enter", // KEYCODE_DPAD_CENTER
    4: "Escape", // KEYCODE_BACK
    126: "MediaPlay",
    127: "MediaPause",
    85: "MediaPlayPause",
    86: "MediaStop",
    87: "MediaTrackNext",
    88: "MediaTrackPrevious",
    90: "MediaFastForward",
    89: "MediaRewind",
  });

export function translate(
  platform: "tizen" | "webos" | "android",
  keycode: number,
): StandardKey | undefined {
  switch (platform) {
    case "tizen":
      return TIZEN_KEYMAP[keycode];
    case "webos":
      return WEBOS_KEYMAP[keycode];
    case "android":
      return ANDROID_KEYMAP[keycode];
  }
}
