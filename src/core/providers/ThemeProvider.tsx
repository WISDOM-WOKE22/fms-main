"use client";

import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { setThemeCookie } from "@/core/cookies";

const STORAGE_KEY = "fms-theme";

function ThemeCookieSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme) setThemeCookie(resolvedTheme);
  }, [resolvedTheme]);
  return null;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="dark"
      storageKey={STORAGE_KEY}
      enableSystem={false}
      themes={["light", "dark"]}
      disableTransitionOnChange={false}
    >
      <ThemeCookieSync />
      {children}
    </NextThemesProvider>
  );
}
