// Tizen shell entry point.
// Lifecycle:
//   1. Read serverUrl from tizen.preference.
//   2. If absent or invalid, mount the connect screen.
//   3. On validation, persist serverUrl and navigate the WebView to
//      `${serverUrl}/web/`. The web client owns the UI from there.
//
// This file is a stub for [JEL-3] (Tizen prototype) to flesh out. We keep it
// in tree so the workspace builds today.

export const PLATFORM = "tizen" as const;
