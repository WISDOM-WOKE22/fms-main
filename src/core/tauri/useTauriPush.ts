"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { isTauri } from "./isTauri";

/** Update hash without reload (assigning to location.hash can reload in Tauri webview). */
function doTauriNav(path: string, replace: boolean = false) {
  const hash = path.startsWith("/") ? path : `/${path}`;
  const base = window.location.pathname || "/";
  const url = `${base}${window.location.search}#${hash}`;
  if (replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * Returns push and replace that use hash navigation in Tauri (so the document
 * never leaves index.html) and normal router otherwise.
 */
export function useTauriPush(): (path: string) => void {
  const router = useRouter();
  return useCallback(
    (path: string) => {
      if (isTauri()) doTauriNav(path);
      else router.push(path);
    },
    [router]
  );
}

export function useTauriReplace(): (path: string) => void {
  const router = useRouter();
  return useCallback(
    (path: string) => {
      if (isTauri()) doTauriNav(path, true);
      else router.replace(path);
    },
    [router]
  );
}
