"use client";

import { useEffect } from "react";
import { useTauriPush, useTauriReplace } from "@/core/tauri/useTauriPush";
import { useTranslation } from "react-i18next";
import { toast } from "@/core/lib/toast";
import { WindowBar } from "@/modules/onboarding/components";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { apiFetch } from "@/core/api/request";
import { useAuthStore } from "@/core/store/useAuthStore";
import type { CurrentAdmin } from "@/core/store/useAuthStore";
import { LoginForm } from "@/modules/auth/components/LoginForm";
import { DashboardPreview } from "@/modules/auth/components/DashboardPreview";

const SESSION_KEY = "fms-session";

export default function LoginPage() {
  const { t } = useTranslation();
  const push = useTauriPush();
  const replace = useTauriReplace();
  const { config } = useAppConfig();
  const setAdmin = useAuthStore((s) => s.setAdmin);
  const admin = useAuthStore((s) => s.admin);

  // Only redirect to dashboard when we have both a session and a known admin (avoids
  // landing on dashboard with no account after onboarding or stale session).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasSession = !!window.localStorage.getItem(SESSION_KEY);
    if (!hasSession) return;
    if (admin) {
      replace("/dashboard");
      return;
    }
    // Stale session (e.g. after onboarding or cleared store): clear so user can sign in
    window.localStorage.removeItem(SESSION_KEY);
  }, [admin, replace]);

  const handleSubmit = async (payload: { email: string; password: string }) => {
    const res = await apiFetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: payload.email,
        password: payload.password,
      }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      message?: string;
      admin?: CurrentAdmin;
    };
    if (data.success) {
      if (typeof window !== "undefined") window.localStorage.setItem(SESSION_KEY, "1");
      if (data.admin) setAdmin(data.admin);
      toast.success(t("toast.signInSuccess"));
      push("/dashboard");
      return;
    }
    const message =
      res.status === 503
        ? t("auth.signInNotConfigured")
        : (data.message || t("auth.signInFailed"));
    throw new Error(message);
  };

  return (
    <div className="h-screen min-h-0 flex flex-col relative bg-fms-bg text-fms-text overflow-hidden">
      <header className="relative z-10 py-5 px-8 pb-4 shrink-0">
        <span className="text-sm font-medium text-fms-text whitespace-nowrap">{t("app.platformName")}</span>
      </header>

      <div className="relative z-10 flex-1 grid grid-cols-[42%_58%] min-h-0 overflow-hidden max-md:grid-cols-1">
        <main className="flex flex-col py-8 px-12 md:px-14 overflow-hidden min-w-0">
          <div className="w-full max-w-[420px]">
            <div className="animate-fade-in-up">
              <h1 className="text-[1.75rem] font-bold tracking-tight text-fms-text leading-tight m-0 mb-2">
                {t("auth.signIn")}
              </h1>
              <p className="text-[0.9375rem] leading-[1.45] text-fms-text-secondary m-0 mb-7">
                {t("auth.signInDesc")}
              </p>
              <LoginForm onSubmit={handleSubmit} />
            </div>
          </div>
        </main>

        <aside className="hidden md:flex flex-col bg-fms-surface min-h-0 border-s border-fms-border overflow-hidden">
          <div className="flex flex-col" style={{ width: 1920 }}>
            <WindowBar />
            <DashboardPreview
              logoUrl={config.companyLogoUrl}
              organizationName={config.companyName}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
