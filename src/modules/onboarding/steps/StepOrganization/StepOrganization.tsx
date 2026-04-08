"use client";

import { useTranslation } from "react-i18next";
import { Button, Input } from "@/core/ui";
import { UploadLogo } from "@/modules/onboarding/components/UploadLogo";
import type { OnboardingData } from "@/modules/onboarding/types";

export interface StepOrganizationProps {
  data: OnboardingData;
  onChange: (data: Partial<OnboardingData>) => void;
  onNext: () => void;
  isLoading?: boolean;
}

export default function StepOrganization({ data, onChange, onNext, isLoading }: StepOrganizationProps) {
  const { t } = useTranslation();
  const canNext = (data.organizationName ?? "").trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canNext) return;
    onNext();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6 w-full">
      <p className="text-[0.9375rem] leading-normal text-fms-text-secondary m-0 mb-2">{t("onboarding.organizationDesc")}</p>
      <UploadLogo value={data.logoUrl ?? null} onChange={(logoUrl) => onChange({ logoUrl })} label={t("onboarding.uploadLogo")} />
      <Input
        label={t("onboarding.organizationName")}
        type="text"
        placeholder={t("onboarding.organizationNamePlaceholder")}
        value={data.organizationName ?? ""}
        onChange={(e) => onChange({ organizationName: e.target.value })}
        disabled={isLoading}
        autoFocus
        className="[&_input]:bg-fms-bg-subtle [&_input]:border-fms-border [&_input]:text-fms-text [&_input]:rounded-2xl [&_label]:text-fms-text"
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={isLoading}
        disabled={!canNext || isLoading}
        className="mt-2 !bg-fms-bg-subtle !text-fms-text hover:!bg-fms-surface-hover rounded-2xl"
      >
        {t("onboarding.next")}
      </Button>
    </form>
  );
}
