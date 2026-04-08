/**
 * Central API request helper: adds audit actor headers from the current
 * logged-in admin so audit logs show the account that performed the action.
 */

import { getApiBase } from "@/core/api/baseUrl";
import { useAuthStore } from "@/core/store/useAuthStore";

/** Headers to send with API requests so the backend can attribute audit logs to the current user. */
export function getAuditHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const admin = useAuthStore.getState().admin;
  if (!admin) return {};
  return {
    "x-actor-id": admin.id,
    "x-actor-name": (admin.name || admin.email || "").trim() || admin.email,
    "x-actor-type": "admin",
  };
}

function mergeHeaders(init?: RequestInit): HeadersInit {
  const audit = getAuditHeaders();
  const existing = init?.headers;
  if (!existing) return audit;
  if (existing instanceof Headers) {
    const out: Record<string, string> = { ...audit };
    existing.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(existing)) {
    const out = new Headers(audit);
    existing.forEach(([k, v]) => out.set(k, v));
    return out;
  }
  return { ...audit, ...(existing as Record<string, string>) };
}

/**
 * Get the appropriate fetch implementation.
 * Inside Tauri production builds the WebView loads from tauri://localhost,
 * which triggers mixed-content blocks when fetching http://127.0.0.1.
 * In that case we must route through the Tauri plugin-http.
 * In dev mode (http://localhost:3000) native fetch works fine and avoids
 * the IPC overhead — important for large payloads like face-image base64
 * which can crash the WebView if piped through IPC.
 */
async function getFetchImpl() {
  if (typeof window === "undefined") return fetch;
  const hasTauri = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!hasTauri) return fetch;

  // Dev mode: webview is loaded from localhost dev server (http://localhost:3000)
  // so native fetch can reach http://127.0.0.1 directly — avoids IPC overhead.
  // In production, hostname is "tauri.localhost" (Windows) or protocol is "tauri:" (macOS/Linux).
  const host = window.location.hostname;
  const isDevMode = (host === "localhost" || host === "127.0.0.1") && window.location.protocol === "http:";
  if (isDevMode) return fetch;

  // Production (tauri://) — must use plugin-http to bypass mixed-content
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch;
  } catch {
    return fetch;
  }
}

/**
 * Fetch the API with audit actor headers so backend audit logs show the current account.
 * path: path without base URL (e.g. "/api/v1/admins").
 * In Tauri, uses dynamic API port from get_api_port.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const base = await getApiBase();
  const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const fetchImpl = await getFetchImpl();
  return fetchImpl(url, {
    ...init,
    headers: mergeHeaders(init),
  });
}

