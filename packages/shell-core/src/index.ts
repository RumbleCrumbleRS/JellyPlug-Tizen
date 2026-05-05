// Public surface of @jellyfin-tv/shell-core.
// Each platform shell imports from here; nothing platform-specific lives here.

export * as input from "./input/index.js";
export * as nativeShell from "./native-shell/index.js";
export * as server from "./server/index.js";
