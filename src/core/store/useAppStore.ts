import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setLangCookie } from "@/core/cookies";

export type AppLanguage = "en" | "ar";

declare global {
  interface Window {
    __FMS_INITIAL_LANG?: string;
  }
}

interface AppState {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
}

const STORAGE_KEY = "fms-app-store";

function getStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  const fromScript = window.__FMS_INITIAL_LANG;
  if (fromScript === "ar" || fromScript === "en") return fromScript;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { language?: string } };
      if (parsed.state?.language === "ar") return "ar";
    }
  } catch {
    // ignore
  }
  return "en";
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      language: getStoredLanguage(),
      setLanguage: (language) => {
        set({ language });
        setLangCookie(language);
      },
    }),
    { name: STORAGE_KEY, partialize: (s) => ({ language: s.language }) }
  )
);

export function isRtl(lang: AppLanguage): boolean {
  return lang === "ar";
}
