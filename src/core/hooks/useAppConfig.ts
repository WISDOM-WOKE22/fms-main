"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/core/api/request";

export interface AppConfig {
  companyName: string;
  companyLogoUrl: string | null;
}

const DEFAULT_CONFIG: AppConfig = {
  companyName: "EglobalSphere",
  companyLogoUrl: null,
};

/**
 * Fetches app config (company name, logo) from the API (Next.js or FastAPI sidecar).
 */
export function useAppConfig(): {
  config: AppConfig;
  loading: boolean;
  error: boolean;
  refetch: () => void;
} {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch("/api/v1/config");
      if (!res.ok) {
        let msg = `Config failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as {
        companyName?: string;
        companyLogoUrl?: string | null;
      };
      setConfig({
        companyName:
          typeof data.companyName === "string" && data.companyName.trim()
            ? data.companyName.trim()
            : DEFAULT_CONFIG.companyName,
        companyLogoUrl:
          typeof data.companyLogoUrl === "string" && data.companyLogoUrl.trim()
            ? data.companyLogoUrl.trim()
            : null,
      });
    } catch {
      setConfig(DEFAULT_CONFIG);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return { config, loading, error, refetch: fetchConfig };
}
