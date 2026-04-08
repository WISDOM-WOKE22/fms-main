"use client";

import { useCallback, useEffect, useState } from "react";
import { useTauriReplace } from "@/core/tauri/useTauriPush";
import OnboardingPage from "@/modules/onboarding/OnboardingPage";
import { apiFetch } from "@/core/api/request";

const CONFIG_RETRIES = 10;
const CONFIG_RETRY_DELAY_MS = 1200;

export default function Home() {
  const replace = useTauriReplace();
  const [ready, setReady] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [backendFailed, setBackendFailed] = useState(false);

  const tryFetch = useCallback(() => {
    setBackendFailed(false);
    setConnecting(true);
    let attempt = 0;
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      attempt += 1;
      apiFetch("/api/v1/config")
        .then(async (r) => {
          if (!r.ok) {
            const msg = r.status === 500 ? "Internal server error" : `Backend returned ${r.status}`;
            let body = msg;
            try {
              const j = (await r.json()) as { error?: string };
              if (j?.error) body = j.error;
            } catch {
              // ignore
            }
            throw new Error(body);
          }
          return r.json() as Promise<{ onboardingCompleted?: boolean }>;
        })
        .then((c) => {
          if (!cancelled) {
            setOnboardingCompleted(Boolean(c.onboardingCompleted));
            setConnecting(false);
            setReady(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < CONFIG_RETRIES) {
            setTimeout(run, CONFIG_RETRY_DELAY_MS);
          } else {
            setConnecting(false);
            setReady(true);
            setBackendFailed(true);
          }
        });
    };

    run();
  }, []);

  useEffect(() => {
    tryFetch();
  }, [tryFetch]);

  useEffect(() => {
    if (!ready) return;
    if (onboardingCompleted) {
      replace("/login");
      return;
    }
  }, [ready, onboardingCompleted, replace]);

  if (backendFailed) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-fms-bg text-fms-text px-6">
        <span className="text-sm font-medium text-fms-text">Backend unavailable</span>
        <p className="text-xs text-fms-text-secondary text-center max-w-sm">
          The app could not connect to the backend. Make sure the app is running from a terminal (e.g. <code className="bg-fms-surface px-1 rounded">pnpm tauri dev</code>) so the server can start.
        </p>
        <button
          type="button"
          onClick={() => {
            setReady(false);
            tryFetch();
          }}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-fms-accent text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!ready || onboardingCompleted) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3 bg-fms-bg text-fms-text">
        <span className="text-sm text-fms-text-secondary">
          {connecting ? "Connecting to backend…" : "Loading…"}
        </span>
        {connecting && (
          <span className="text-xs text-fms-text-tertiary">This may take a moment on first launch.</span>
        )}
      </div>
    );
  }

  return <OnboardingPage />;
}
