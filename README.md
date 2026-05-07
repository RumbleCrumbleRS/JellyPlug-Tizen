<h1 align="center">JellyPlug Tizen</h1>
<h3 align="center">Thin browser-shell for Jellyfin on Samsung Tizen TVs</h3>

---

<p align="center">
<img alt="Logo Banner" src="https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/branding/SVG/banner-logo-solid.svg?sanitize=true"/>
</p>

Loads the **live** Jellyfin web client from your server (`${server}/web/`) — no bundled web client, no `jellyfin-web` clone needed. Server-installed plugins and custom themes work on your TV the same as in the browser.

## Quick Start

Pick the path that matches you:

| Path | Best for | What you do |
| ---- | -------- | ----------- |
| **1. Pre-built WGT** | Most users. You just want Jellyfin on your Samsung TV. | Download the latest `JellyfinShell.wgt` from [Releases](https://github.com/RumbleCrumbleRS/JellyPlug-Tizen/releases) and sideload it. You still need Developer Mode + a Samsung/Tizen certificate to install. See [Deployment](#deployment). |
| **2. Samsung-Jellyfin-Installer** | Users who want a guided installer instead of the Tizen CLI. | Use the community installer at [Jellyfin2Samsung/Samsung-Jellyfin-Installer](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer). It wraps the certificate + sideload steps in a GUI. Community-maintained; not part of this project. |
| **3. Build from Source** | Developers, contributors, anyone tracking a non-release branch. | Follow [Build from Source](#build-from-source) below. |

> Samsung Tizen TVs require Developer Mode and a signed certificate to sideload any app. There is no public entry in the Samsung Smart Hub store.

## How it works

The shell never bundles `jellyfin-web`. On launch:

1. The widget shows a one-time connection screen asking for your Jellyfin server URL.
2. The URL is persisted in `localStorage`, so subsequent launches go straight to the web client.
3. The shell fetches `${server}/web/index.html`, rewrites `<base href>` so scripts, CSS, and XHR resolve to the live server, injects `window.NativeShell`, `tizen.*`, and `webapis.*`, then mounts the rewritten document at the widget origin.

Server updates, plugins, and themes take effect immediately — no app rebuild needed.

## Repository layout

This repository is the widget source. There is no bundler step; the build artifact is a Tizen `.wgt` produced directly from the files at the repo root.

```
.
├── config.xml         # Tizen widget manifest
├── index.html         # Bootstrap shell + connection screen
├── bootstrap.js       # Fetches ${server}/web/, rewrites, mounts
├── tizen.js           # window.NativeShell shim + Tizen key/system bridge
├── icon.png           # Widget icon
└── package.json       # Convenience `tizen package` wrapper
```

> **No `node_modules`, no `www/` output, no JS bundling.** A previous version of this repo used a Gulp pipeline to bundle `jellyfin-web` into `www/`. That pipeline has been removed; the widget loads `jellyfin-web` from your server at runtime.

## Build from Source

### Prerequisites

* Tizen Studio 4.6+ with the TV Extensions and CLI. See [Installing TV SDK](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html).
* Git
* A Samsung or Tizen developer certificate configured in Certificate Manager (required to sign the widget).

> **No Node.js or `pnpm` install required.** The shell ships only static HTML/JS/CSS; nothing is bundled or transpiled.

### Getting Started

1. Install prerequisites.
2. Install Certificate Manager using Tizen Studio Package Manager. See [Installing Required Extensions](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html#Installing-Required-Extensions).
3. Set up a Tizen certificate in Certificate Manager. See [Creating Certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html).
   > If you have installation problems with the Tizen certificate, try creating a Samsung certificate. In this case, you will also need a Samsung account.
4. Clone this repository.
   ```sh
   git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
   cd JellyPlug-Tizen
   ```

### Build WGT

> Make sure you select the appropriate Certificate Profile in Tizen Certificate Manager. This determines which devices you can install the widget on.

From the repository root:

```sh
tizen package -t wgt --
```

> You should get `JellyPlug-Tizen.wgt` (or similar, named after `<widget id>` in `config.xml`) in the project root.

If you have Node.js available you can equivalently run `npm run package`, which is just a wrapper around the same `tizen package` command.

## Deployment

### Deploy to Emulator

1. Run the emulator.
2. Install the package.
   ```sh
   tizen install -n JellyPlug-Tizen.wgt -t T-samsung-5.5-x86
   ```
   > Specify target with `-t` option. Use `sdb devices` to list them.

### Deploy to TV

1. Power on the TV.
2. Activate Developer Mode on TV. See [Enable Developer Mode on the TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html#Connecting-the-TV-and-SDK).
3. Connect to TV with one of the following options:
   * Device Manager from `Tools -> Device Manager` in Tizen Studio.

   * sdb:
      ```sh
      sdb connect YOUR_TV_IP
      ```
4. If you are using a Samsung certificate, allow installs onto your TV using your certificate with one of the following options:
   > If you need to change or create a new Samsung certificate (see [Getting Started](#getting-started) step 3), you will need to [re-build WGT](#build-wgt) once you have the Samsung certificate you'll use for the install.

   * Device Manager from `Tools -> Device Manager` in Tizen Studio:
      * Right-click on the connected device and select `Permit to install applications`.

   * Tizen CLI:
      ```sh
      tizen install-permit -t UE65NU7400
      ```
      > Specify target with `-t` option. Use `sdb devices` to list them.

   * sdb:
      ```sh
      sdb push ~/SamsungCertificate/<PROFILE_NAME>/*.xml /home/developer
      ```
5. Install the package.
   ```sh
   tizen install -n JellyPlug-Tizen.wgt -t UE65NU7400
   ```
   > Specify target with `-t` option. Use `sdb devices` to list them.

## Resetting the saved server URL

The connection screen only appears on first launch. To force it to appear again (e.g. after moving servers), clear the widget's local storage:

* Tizen emulator: `Settings > Apps > Jellyfin > Clear data`.
* Real TV: uninstall and reinstall the widget.
