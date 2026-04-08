"use client";

import { useTranslation } from "react-i18next";
import { Button, Input } from "@/core/ui";
import { PasswordField } from "@/modules/onboarding/components/PasswordField";
import type { OnboardingData } from "@/modules/onboarding/types";

export interface StepAccountProps {
  data: OnboardingData;
  onChange: (data: Partial<OnboardingData>) => void;
  onNext: () => void;
  onFinish?: () => void;
  isLastStep?: boolean;
  isLoading?: boolean;
}

export default function StepAccount({
  data,
  onChange,
  onNext,
  onFinish,
  isLastStep = false,
  isLoading,
}: StepAccountProps) {
  const { t } = useTranslation();
  const canNext =
    (data.firstName ?? "").trim().length > 0 &&
    (data.lastName ?? "").trim().length > 0 &&
    (data.email ?? "").trim().length > 0 &&
    (data.password ?? "").length > 0 &&
    (data.password ?? "") === (data.confirmPassword ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canNext) return;
    if (isLastStep && onFinish) {
      onFinish();
    } else {
      onNext();
    }
  };

  const inputClass = "[&_input]:bg-fms-bg-subtle [&_input]:border-fms-border [&_input]:text-fms-text [&_input]:rounded-2xl [&_label]:text-fms-text";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full">
      <p className="text-[0.9375rem] leading-[1.45] text-fms-text-secondary m-0 mb-7">{t("onboarding.setupAccountSubtitle")}</p>
      <Input
        label={t("onboarding.firstName")}
        placeholder={t("onboarding.firstNamePlaceholder")}
        value={data.firstName ?? ""}
        onChange={(e) => onChange({ firstName: e.target.value })}
        disabled={isLoading}
        className={inputClass}
      />
      <Input
        label={t("onboarding.lastName")}
        placeholder={t("onboarding.lastNamePlaceholder")}
        value={data.lastName ?? ""}
        onChange={(e) => onChange({ lastName: e.target.value })}
        disabled={isLoading}
        className={inputClass}
      />
      <Input
        label={t("onboarding.email")}
        type="email"
        placeholder={t("onboarding.emailPlaceholder")}
        value={data.email ?? ""}
        onChange={(e) => onChange({ email: e.target.value })}
        disabled={isLoading}
        className={inputClass}
      />
      <PasswordField
        label={t("auth.password")}
        placeholder={t("auth.passwordPlaceholder")}
        value={data.password ?? ""}
        onChange={(password) => onChange({ password })}
        disabled={isLoading}
        autoComplete="new-password"
      />
      <PasswordField
        label={t("onboarding.confirmPassword")}
        placeholder={t("onboarding.confirmPasswordPlaceholder")}
        value={data.confirmPassword ?? ""}
        onChange={(confirmPassword) => onChange({ confirmPassword })}
        disabled={isLoading}
        autoComplete="new-password"
      />
      <Button
        type="submit"
        size="lg"
        fullWidth
        loading={isLoading}
        disabled={!canNext || isLoading}
        className="mt-3 !bg-fms-bg-subtle !text-fms-text hover:!bg-fms-surface-hover rounded-2xl"
      >
        {isLastStep ? t("onboarding.finish") : t("onboarding.next")}
      </Button>
    </form>
  );
}
