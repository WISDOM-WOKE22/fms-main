import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "@/locales/en/common.json";
import enAudit from "@/locales/en/audit.json";
import arCommon from "@/locales/ar/common.json";
import arAudit from "@/locales/ar/audit.json";

export const defaultNS = "common";
export const resources = {
  en: { [defaultNS]: { ...enCommon, ...enAudit } },
  ar: { [defaultNS]: { ...arCommon, ...arAudit } },
} as const;

export type SupportedLocale = keyof typeof resources;

function getStoredLanguage(): SupportedLocale {
  if (typeof window === "undefined") return "en";
  const fromScript = (window as Window & { __FMS_INITIAL_LANG?: string }).__FMS_INITIAL_LANG;
  if (fromScript === "ar" || fromScript === "en") return fromScript;
  try {
    const raw = localStorage.getItem("fms-app-store");
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { language?: string } };
      if (parsed.state?.language === "ar") return "ar";
    }
  } catch {
    // ignore
  }
  return "en";
}

const initialLng = typeof window !== "undefined" ? getStoredLanguage() : "en";

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: initialLng,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
