"use client";

import { useEffect } from "react";
import "@/core/i18n/config";
import { useAppStore, isRtl } from "@/core/store/useAppStore";
import { setLangCookie } from "@/core/cookies";
import i18n from "@/core/i18n/config";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const language = useAppStore((s) => s.language);

  useEffect(() => {
    i18n.changeLanguage(language);
    setLangCookie(language);
    const dir = isRtl(language) ? "rtl" : "ltr";
    const lang = language === "ar" ? "ar" : "en";
    document.documentElement.setAttribute("dir", dir);
    document.documentElement.setAttribute("lang", lang);
  }, [language]);

  return <>{children}</>;
}
