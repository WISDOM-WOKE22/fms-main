"use client";

import { useEffect } from "react";
import { isTauri } from "./isTauri";
import TauriRouter from "./TauriRouter";

/**
 * When running inside Tauri desktop app, render the hash-based router so all
 * navigation stays on index.html and detail pages load correctly.
 * Also intercepts internal link clicks to use hash navigation.
 */
export default function TauriWrapper({ children }: { children: React.ReactNode }) {
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri || typeof document === "undefined") return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      const url = `${window.location.pathname}${window.location.search}#${href}`;
      window.history.pushState(null, "", url);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [tauri]);

  if (tauri) {
    return <TauriRouter />;
  }
  return <>{children}</>;
}
