/**
 * API base URL for backend requests.
 * - In Tauri desktop: uses dynamic port via get_api_port so CSP and port conflicts are avoided.
 * - NEXT_PUBLIC_API_URL: optional override for web/dev.
 */
export const isTauri =
  typeof window !== "undefined" &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

let cachedBase: string | null = null;

/**
 * Returns the API base URL. In Tauri, this is async and uses the in-process API port.
 * Cache result so callers can await once and reuse.
 */
export async function getApiBase(): Promise<string> {
  if (typeof window === "undefined") return "";
  if (cachedBase) return cachedBase;

  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (envUrl) {
    cachedBase = envUrl.replace(/\/$/, "");
    return cachedBase;
  }

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const port = await invoke<number>("get_api_port");
    cachedBase = `http://127.0.0.1:${port}`;
    return cachedBase;
  }

  cachedBase = "http://localhost:8000";
  return cachedBase;
}

/**
 * Synchronous getter for contexts that cannot be async (e.g. initial render).
 * In Tauri, returns a placeholder until getApiBase() has been awaited at least once.
 */
export function getApiBaseSync(): string {
  if (typeof window === "undefined") return "";
  if (cachedBase) return cachedBase;
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");
  return "http://127.0.0.1:8000";
}
