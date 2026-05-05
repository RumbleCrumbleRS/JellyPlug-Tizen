// Connect-screen entry point shipped inside every platform shell.
// Validates the user-entered server URL and hands control back to the host
// shell, which then navigates the WebView to ${server}/web/.

import { validateServerUrl } from "../server/index.js";

interface ConnectHostBridge {
  // Each platform shell injects this onto window before the connect screen loads.
  onServerValidated(webUrl: string): void;
  saveServerUrl(url: string): void;
}

declare global {
  interface Window {
    ConnectHost?: ConnectHostBridge;
  }
}

const form = document.getElementById("connect") as HTMLFormElement;
const input = document.getElementById("server-url") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  try {
    const validated = await validateServerUrl(input.value);
    window.ConnectHost?.saveServerUrl(validated.url);
    window.ConnectHost?.onServerValidated(validated.webUrl);
  } catch (err) {
    errorEl.textContent =
      err instanceof Error ? err.message : "Could not reach server";
  }
});
