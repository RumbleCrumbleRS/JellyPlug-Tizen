// window.NativeShell contract that the in-WebView jellyfin-web client calls.
// Each platform shell injects an implementation of NativeShell into the page.

export interface DeviceProfile {
  // Codec/container/DRM matrix used by jellyfin-web's playback engine.
  // Shape mirrors jellyfin-web's existing DeviceProfile so we stay drop-in.
  // TODO: import the canonical type from jellyfin-web typings when those are
  // published; for now we keep it loose.
  [key: string]: unknown;
}

export interface AppHost {
  exit(): void;
  deviceId(): string;
  deviceName(): string;
  appName(): string;
  appVersion(): string;
}

export interface NativeShell {
  AppHost: AppHost;
  getDeviceProfile(maxBitrate?: number): Promise<DeviceProfile> | DeviceProfile;
  getPlugins?(): string[];
  // Future: getDownloadablePackages, openExternalUrl, etc.
}

declare global {
  interface Window {
    NativeShell?: NativeShell;
  }
}

export {};
