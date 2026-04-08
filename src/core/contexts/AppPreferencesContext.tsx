"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export const APP_PREFERENCES_STORAGE_KEY = "fms-app-preferences";

export interface AppPreferences {
  applicationName: string | null;
  logoUrl: string | null;
  /** "compact" | "comfortable" - optional display density */
  displayDensity?: "compact" | "comfortable";
}

const defaultPreferences: AppPreferences = {
  applicationName: null,
  logoUrl: null,
  displayDensity: "comfortable",
};

function loadStored(): AppPreferences {
  if (typeof window === "undefined") return defaultPreferences;
  try {
    const raw = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    if (!raw) return defaultPreferences;
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    return {
      applicationName: parsed.applicationName ?? defaultPreferences.applicationName,
      logoUrl: parsed.logoUrl ?? defaultPreferences.logoUrl,
      displayDensity: parsed.displayDensity ?? defaultPreferences.displayDensity,
    };
  } catch {
    return defaultPreferences;
  }
}

function saveStored(prefs: AppPreferences) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export interface AppPreferencesContextValue extends AppPreferences {
  setApplicationName: (value: string | null) => void;
  setLogoUrl: (value: string | null) => void;
  setDisplayDensity: (value: "compact" | "comfortable") => void;
  /** Resolve display name: preferences applicationName, or fallback */
  getDisplayName: (fallback: string) => string;
  /** Resolve logo: preferences logoUrl, or fallback */
  getLogoUrl: (fallback: string | null) => string | null;
}

const AppPreferencesContext = createContext<AppPreferencesContextValue | null>(null);

export function AppPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<AppPreferences>(defaultPreferences);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPrefs(loadStored());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveStored(prefs);
  }, [hydrated, prefs]);

  const setApplicationName = useCallback((applicationName: string | null) => {
    setPrefs((p) => ({ ...p, applicationName: applicationName || null }));
  }, []);

  const setLogoUrl = useCallback((logoUrl: string | null) => {
    setPrefs((p) => ({ ...p, logoUrl }));
  }, []);

  const setDisplayDensity = useCallback((displayDensity: "compact" | "comfortable") => {
    setPrefs((p) => ({ ...p, displayDensity }));
  }, []);

  const getDisplayName = useCallback(
    (fallback: string) => (prefs.applicationName?.trim() || fallback),
    [prefs.applicationName]
  );

  const getLogoUrl = useCallback(
    (fallback: string | null) => prefs.logoUrl ?? fallback,
    [prefs.logoUrl]
  );

  const value = useMemo<AppPreferencesContextValue>(
    () => ({
      ...prefs,
      setApplicationName,
      setLogoUrl,
      setDisplayDensity,
      getDisplayName,
      getLogoUrl,
    }),
    [
      prefs,
      setApplicationName,
      setLogoUrl,
      setDisplayDensity,
      getDisplayName,
      getLogoUrl,
    ]
  );

  return (
    <AppPreferencesContext.Provider value={value}>
      {children}
    </AppPreferencesContext.Provider>
  );
}

export function useAppPreferences(): AppPreferencesContextValue {
  const ctx = useContext(AppPreferencesContext);
  if (!ctx) {
    return {
      ...defaultPreferences,
      setApplicationName: () => {},
      setLogoUrl: () => {},
      setDisplayDensity: () => {},
      getDisplayName: (fallback: string) => fallback,
      getLogoUrl: (fallback: string | null) => fallback,
    };
  }
  return ctx;
}
