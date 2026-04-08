import type { Metadata } from "next";
import { ThemeProvider } from "@/core/providers/ThemeProvider";
import { I18nProvider } from "@/core/providers/I18nProvider";
import { AppPreferencesProvider } from "@/core/contexts/AppPreferencesContext";
import { ToastToaster } from "@/core/components/ToastToaster";
import TauriWrapper from "@/core/tauri/TauriWrapper";
import "./globals.css";

export const metadata: Metadata = {
  title: "FMS — Facility Management System",
  description: "Monitor check-in, check-out, attendance and performance. Offline-first.",
};

/**
 * Inline script runs before paint: reads localStorage and sets window + document
 * so lang/theme persist without flash. Required for static export (no server/cookies).
 */
const INITIAL_SCRIPT = `(function(){try{var raw=localStorage.getItem("fms-app-store");if(raw){var p=JSON.parse(raw);if(p.state&&p.state.language==="ar"){window.__FMS_INITIAL_LANG="ar";document.documentElement.setAttribute("dir","rtl");document.documentElement.setAttribute("lang","ar");}}var th=localStorage.getItem("fms-theme");if(th==="light"||th==="dark"){window.__FMS_INITIAL_THEME=th;document.documentElement.setAttribute("data-theme",th);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/svg+xml" href="/vite.svg" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script
          dangerouslySetInnerHTML={{
            __html: INITIAL_SCRIPT,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <AppPreferencesProvider>
              <TauriWrapper>
                <div data-fms-root>{children}</div>
                <ToastToaster />
              </TauriWrapper>
            </AppPreferencesProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
