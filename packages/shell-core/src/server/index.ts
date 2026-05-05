// Validate a Jellyfin server URL by hitting /System/Info/Public.
// Returns server identity on success; throws on any failure.

export interface PublicServerInfo {
  ServerName: string;
  Version: string;
  Id: string;
  ProductName?: string;
  StartupWizardCompleted?: boolean;
}

export interface ValidatedServer {
  url: string; // normalized, no trailing slash
  webUrl: string; // url + "/web/"
  info: PublicServerInfo;
}

export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("empty server URL");
  if (!/^https?:\/\//i.test(s)) {
    // Default to http; user can supply https:// explicitly.
    s = "http://" + s;
  }
  // Drop any trailing slash for consistent concatenation.
  return s.replace(/\/+$/, "");
}

export async function validateServerUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<ValidatedServer> {
  const url = normalizeServerUrl(rawUrl);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/System/Info/Public`, {
      method: "GET",
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`server returned ${res.status}`);
    }
    const info = (await res.json()) as PublicServerInfo;
    if (!info?.Id || !info?.Version) {
      throw new Error("invalid /System/Info/Public response");
    }
    return { url, webUrl: `${url}/web/`, info };
  } finally {
    clearTimeout(timer);
  }
}
