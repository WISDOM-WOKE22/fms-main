"use client";

import { useState, useTransition, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { BackButton, ProgressBar, WindowBar } from "@/modules/onboarding/components";
import { DashboardPreview } from "@/modules/auth/components/DashboardPreview";
import StepLicense from "@/modules/onboarding/steps/StepLicense/StepLicense";
import StepConnecting from "@/modules/onboarding/steps/StepConnecting/StepConnecting";
import { apiFetch } from "@/core/api/request";
import { useTauriReplace } from "@/core/tauri/useTauriPush";
import { isTauri } from "@/core/tauri/isTauri";
import {
  defaultOnboardingData,
  type OnboardingData,
  ONBOARDING_STORAGE_KEY,
} from "@/modules/onboarding/types";

const TOTAL_STEPS = 2;
const SESSION_KEY = "fms-session";
const PREVIEW_ORG_NAME = "EglobalSphere";

export default function OnboardingPage() {
  const { t } = useTranslation();
  const replace = useTauriReplace();
  const [step, setStep] = useState(1);
  const [data, setData] = useState<OnboardingData>(() => defaultOnboardingData);
  const [isPending, startTransition] = useTransition();
  const [config, setConfig] = useState<{
    companyName: string;
    companyLogoUrl: string | null;
  } | null>(null);

  useEffect(() => {
    if (step < 2) return;
    let mounted = true;
    apiFetch("/api/v1/config")
      .then((r) => r.json())
      .then((c: { companyName?: string; companyLogoUrl?: string | null }) => {
        if (mounted)
          setConfig({
            companyName: c.companyName ?? PREVIEW_ORG_NAME,
            companyLogoUrl: c.companyLogoUrl ?? null,
          });
      })
      .catch(() => {
        if (mounted)
          setConfig({ companyName: PREVIEW_ORG_NAME, companyLogoUrl: null });
      });
    return () => {
      mounted = false;
    };
  }, [step]);

  const updateData = (partial: Partial<OnboardingData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  };

  const handleNext = () => {
    startTransition(() => setStep((s) => Math.min(s + 1, TOTAL_STEPS)));
  };

  const handleBack = () => {
    startTransition(() => setStep((s) => Math.max(s - 1, 1)));
  };

  const handleProceedToSignIn = async () => {
    try {
      await apiFetch("/api/v1/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: data.licenseKey?.trim() || "" }),
      });
    } catch {
      // continue to login even if save fails
    }
    startTransition(() => {
      try {
        if (typeof window !== "undefined") {
          localStorage.removeItem(ONBOARDING_STORAGE_KEY);
          // Clear any stale session so we land on login (not dashboard) and can sign in
          localStorage.removeItem(SESSION_KEY);
        }
        if (isTauri()) {
          replace("/login");
        } else {
          window.location.href = "/login";
        }
      } catch {
        if (isTauri()) replace("/login");
        else window.location.href = "/login";
      }
    });
  };

  const previewName = step >= 2 && config ? config.companyName : PREVIEW_ORG_NAME;
  const previewLogo = step >= 2 && config ? config.companyLogoUrl : null;

  return (
    <div className="h-screen min-h-0 flex flex-col relative bg-fms-bg text-fms-text overflow-hidden">
      <header className="relative z-10 flex items-center gap-6 py-5 px-8 pb-4 shrink-0">
        <span className="text-sm font-medium text-fms-text whitespace-nowrap">{t("app.platformName")}</span>
        <div className="flex-1 max-w-[280px]">
          <ProgressBar
            currentStep={step}
            totalSteps={TOTAL_STEPS}
            ariaLabel={t("onboarding.stepOf", { current: step, total: TOTAL_STEPS })}
          />
        </div>
      </header>

      <div className="relative z-10 flex-1 grid grid-cols-[42%_58%] min-h-0 overflow-hidden max-md:grid-cols-1">
        <main className="flex flex-col py-12 px-14 overflow-hidden min-w-0">
          <div className="w-full max-w-[440px]">
            {step > 1 && (
              <BackButton
                onClick={handleBack}
                label={t("onboarding.back")}
                disabled={isPending}
                className="text-fms-text-secondary hover:text-fms-text mb-4"
              />
            )}
            <div className="animate-fade-in-up">
              {step === 1 && (
                <StepLicense
                  data={data}
                  onChange={updateData}
                  onNext={handleNext}
                  isLoading={isPending}
                />
              )}
              {step === 2 && (
                <StepConnecting
                  onProceedToSignIn={handleProceedToSignIn}
                  isLoading={isPending}
                />
              )}
            </div>
          </div>
        </main>

        <aside className="hidden md:flex flex-col bg-fms-surface min-h-0 border-s border-fms-border overflow-hidden">
          <div className="flex flex-col" style={{ width: 1920 }}>
            <WindowBar />
            <DashboardPreview
              logoUrl={previewLogo}
              organizationName={previewName}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
