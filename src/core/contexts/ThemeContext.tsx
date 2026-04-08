"use client";

import { useTheme as useNextTheme } from "next-themes";
import { useCallback, useMemo } from "react";

export type Theme = "light" | "dark";

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/**
 * useTheme must be used within the next-themes ThemeProvider (see core/providers/ThemeProvider).
 * Exposes theme as "light" | "dark" and adds toggleTheme for convenience.
 */
export function useTheme(): ThemeContextValue {
  const { theme, setTheme: setNextTheme, resolvedTheme } = useNextTheme();

  const effectiveTheme: Theme =
    (resolvedTheme as Theme) ?? (theme as Theme) ?? "dark";

  const setTheme = useCallback(
    (next: Theme) => {
      setNextTheme(next);
    },
    [setNextTheme]
  );

  const toggleTheme = useCallback(() => {
    setNextTheme(effectiveTheme === "light" ? "dark" : "light");
  }, [effectiveTheme, setNextTheme]);

  return useMemo(
    () => ({ theme: effectiveTheme, setTheme, toggleTheme }),
    [effectiveTheme, setTheme, toggleTheme]
  );
}
