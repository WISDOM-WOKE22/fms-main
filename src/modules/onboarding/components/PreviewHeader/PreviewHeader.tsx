"use client";

import { useTranslation } from "react-i18next";

export interface PreviewHeaderProps {
  logoUrl: string | null;
  organizationName: string;
}

const DEFAULT_NAME = "Eglobalsphere";

export default function PreviewHeader({ logoUrl, organizationName }: PreviewHeaderProps) {
  const { t } = useTranslation();
  const name = organizationName.trim() || DEFAULT_NAME;
  return (
    <div className="flex items-center gap-4 py-5 px-6 bg-fms-surface flex-shrink-0">
      <div className="w-12 h-12 border border-fms-border-strong rounded-2xl flex items-center justify-center flex-shrink-0 overflow-hidden">
        {logoUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={logoUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <span className="text-[0.6875rem] font-medium text-fms-text-tertiary">{t("onboarding.myLogo")}</span>
        )}
      </div>
      <span className="text-xl font-semibold text-fms-text tracking-tight">{name}</span>
    </div>
  );
}
