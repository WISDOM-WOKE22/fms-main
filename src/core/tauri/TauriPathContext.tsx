"use client";

import { createContext, useContext } from "react";
import { usePathname } from "next/navigation";

export const TauriPathContext = createContext<string | null>(null);

/** Pathname that respects Tauri hash routing when in desktop app. */
export function useAppPathname(): string {
  const tauriPath = useContext(TauriPathContext);
  const nextPath = usePathname();
  return tauriPath ?? nextPath ?? "/";
}
