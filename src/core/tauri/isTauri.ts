/**
 * Detect if the app is running inside the Tauri desktop shell.
 * Tauri 2 injects __TAURI_INTERNALS__ on the window.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}
