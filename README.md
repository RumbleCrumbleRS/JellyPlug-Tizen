<h1 align="center">JellyPlug Tizen</h1>
<h3 align="center">Thin browser-shell for Jellyfin on Samsung Tizen TVs</h3>

---

<p align="center">
<img alt="Logo Banner" src="https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/branding/SVG/banner-logo-solid.svg?sanitize=true"/>
</p>

Loads the **live** Jellyfin web client from your server (`${server}/web/`) — no bundled web client, no jellyfin-web clone needed. Server-installed plugins and custom themes work on your TV the same as in the browser.

## Quick Start

Pick the path that matches you:

| Path | Best for | What you do |
| ---- | -------- | ----------- |
| **1. Pre-built WGT** | Most users. You just want Jellyfin on your Samsung TV. | Download the latest `JellyfinShell.wgt` from [Releases](https://github.com/RumbleCrumbleRS/JellyPlug-Tizen/releases) and sideload it. You still need Developer Mode + a Samsung/Tizen certificate to install. See [Deployment](#deployment). |
| **2. Samsung-Jellyfin-Installer** | Users who want a guided installer instead of the Tizen CLI. | Use the community installer at [Jellyfin2Samsung/Samsung-Jellyfin-Installer](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer). It wraps the certificate + sideload steps in a GUI. Community-maintained; not part of this project. |
| **3. Build from Source** | Developers, contributors, anyone tracking a non-release branch. | Follow [Build from Source](#build-from-source) below. |

> Samsung Tizen TVs require Developer Mode and a signed certificate to sideload any app. There is no public entry in the Samsung Smart Hub store.

## How it works

The shell never bundles `jellyfin-web`. When you point it at your Jellyfin server:

1. The widget fetches `${server}/web/index.html` from your server.
2. `<base href>` is rewritten so scripts, CSS, and XHR resolve to the live server.
3. `window.NativeShell`, `tizen.*`, and `webapis.*` are injected at widget origin.

Server updates, plugins, and themes take effect immediately — no app rebuild needed.

## Build from Source

### Prerequisites

* Tizen Studio 4.6+ with IDE or Tizen Studio 4.6+ with CLI. See [Installing TV SDK](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html).
* Git
* Node.js 20+
* pnpm (`npm install -g pnpm`)

> **No Jellyfin Web clone needed.** The shell loads the web client live from your server at runtime.

### Getting Started

1. Install prerequisites.
2. Install Certificate Manager using Tizen Studio Package Manager. See [Installing Required Extensions](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html#Installing-Required-Extensions).
3. Setup Tizen certificate in Certificate Manager. See [Creating Certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html).
   > If you have installation problems with the Tizen certificate, try creating a Samsung certificate. In this case, you will also need a Samsung account.
4. Clone this repository.
   ```sh
   git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
   cd JellyPlug-Tizen
   ```
5. Install dependencies.
   ```sh
   pnpm install
   ```

### Build WGT

> Make sure you select the appropriate Certificate Profile in Tizen Certificate Manager. This determines which devices you can install the widget on.

```sh
pnpm -C packages/shell-tizen build
```

> You should get `packages/shell-tizen/dist/JellyfinShell.wgt`.

## Deployment

### Deploy to Emulator

1. Run emulator.
2. Install package.
   ```sh
   tizen install -n packages/shell-tizen/dist/JellyfinShell.wgt -t T-samsung-5.5-x86
   ```
   > Specify target with `-t` option. Use `sdb devices` to list them.

### Deploy to TV

1. Run TV.
2. Activate Developer Mode on TV. See [Enable Developer Mode on the TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html#Connecting-the-TV-and-SDK).
3. Connect to TV with one of the following options:
   * Device Manager from `Tools -> Device Manager` in Tizen Studio.

   * sdb:
      ```sh
      sdb connect YOUR_TV_IP
      ```
4. If you are using a Samsung certificate, allow installs onto your TV using your certificate with one of the following options:
   > If you need to change or create a new Samsung certificate (see [Getting-Started](#getting-started) step 3), you will need to [re-build WGT](#build-wgt) once you have the Samsung certificate you'll use for the install.

   * Device Manager from `Tools -> Device Manager` in Tizen Studio:
      * Right-click on the connected device, and select `Permit to install applications`.

   * Tizen CLI:
      ```sh
      tizen install-permit -t UE65NU7400
      ```
      > Specify target with `-t` option. Use `sdb devices` to list them.

   * sdb:
      ```sh
      sdb push ~/SamsungCertificate/<PROFILE_NAME>/*.xml /home/developer
      ```
5. Install package.
   ```sh
   tizen install -n packages/shell-tizen/dist/JellyfinShell.wgt -t UE65NU7400
   ```
   > Specify target with `-t` option. Use `sdb devices` to list them.
