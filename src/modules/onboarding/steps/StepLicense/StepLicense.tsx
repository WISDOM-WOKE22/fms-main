"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/core/ui";
import { apiFetch } from "@/core/api/request";
import type { OnboardingData } from "@/modules/onboarding/types";

export interface StepLicenseProps {
  data: OnboardingData;
  onChange: (data: Partial<OnboardingData>) => void;
  onNext: () => void;
  isLoading?: boolean;
}

export default function StepLicense({
  data,
  onChange,
  onNext,
  isLoading = false,
}: StepLicenseProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [devMode, setDevMode] = useState(false);

  const licenseKey = data.licenseKey ?? "";
  const canSubmit = licenseKey.trim().length > 0 && !validating && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;

    setValidating(true);
    const maxRetries = 5;
    const retryDelayMs = 1500;
    let lastError: string | null = null;

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const res = await apiFetch("/api/v1/license/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ licenseKey: licenseKey.trim() }),
          });
          let result: { valid?: boolean; message?: string };
          try {
            result = (await res.json()) as { valid?: boolean; message?: string };
          } catch {
            result = { valid: false, message: res.ok ? undefined : "Invalid response from server." };
          }

          if (res.ok && result.valid) {
            if ((result as any).licenseSource === "dev_fallback") {
              setDevMode(true);
            }
            onNext();
            return;
          }
          lastError = result.message || t("onboarding.licenseInvalid");
          break;
        } catch {
          lastError =
            attempt < maxRetries
              ? (t("onboarding.licenseConnecting") ?? "Connecting to backend… Please wait, then try again.")
              : (t("onboarding.licenseValidationFailed") ?? "Could not reach the backend. Please ensure the app started correctly and try again.");
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
      }
      setError(lastError ?? t("onboarding.licenseValidationFailed"));
    } finally {
      setValidating(false);
    }
  };

  const inputClass =
    "[&_input]:bg-fms-bg-subtle [&_input]:border-fms-border [&_input]:text-fms-text [&_input]:rounded-2xl [&_label]:text-fms-text";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full">
      <h1 className="text-[1.75rem] font-bold tracking-tight text-fms-text leading-tight m-0 mb-2">
        {t("onboarding.licenseTitle")}
      </h1>
      <p className="text-[0.9375rem] leading-[1.45] text-fms-text-secondary m-0 mb-7">
        {t("onboarding.licenseSubtitle")}
      </p>
      <p className="text-xs text-fms-text-tertiary m-0 mb-4">
        {t("onboarding.licenseHint") ?? "If validation fails, wait a few seconds for the backend to finish starting, then try again."}
      </p>
      {devMode && (
        <p className="text-xs text-amber-500 m-0 mb-2">
          Development License Mode — not valid for production use.
        </p>
      )}
      <Input
        label={t("onboarding.licenseKeyLabel")}
        placeholder={t("onboarding.licenseKeyPlaceholder")}
        value={licenseKey}
        onChange={(e) => {
          onChange({ licenseKey: e.target.value });
          setError(null);
        }}
        disabled={isLoading || validating}
        className={inputClass}
        error={error ?? undefined}
        autoComplete="off"
      />
      <Button
        type="submit"
        size="lg"
        fullWidth
        loading={validating || isLoading}
        disabled={!canSubmit}
        className="mt-3 !bg-fms-bg-subtle !text-fms-text hover:!bg-fms-surface-hover rounded-2xl"
      >
        {validating ? t("onboarding.validating") : t("onboarding.validateAndContinue")}
      </Button>
    </form>
  );
}
