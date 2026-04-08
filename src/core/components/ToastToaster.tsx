"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "next-themes";

export function ToastToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      position="top-right"
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      richColors
      closeButton
      duration={4000}
      offset="1.25rem"
      toastOptions={{
        className: "fms-toast",
        style: {
          borderRadius: "var(--radius-fms-lg, 14px)",
          border: "1px solid var(--fms-border)",
          boxShadow: "var(--fms-shadow-lg)",
        },
      }}
    />
  );
}
