"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/core/ui";
import { apiFetch } from "@/core/api/request";

export type ConnectingPhase =
  | "connecting"
  | "getting-details"
  | "setting-data"
  | "creating-super-admin"
  | "ready";

const PHASE_ORDER: ConnectingPhase[] = [
  "connecting",
  "getting-details",
  "setting-data",
  "creating-super-admin",
  "ready",
];

export interface StepConnectingProps {
  onProceedToSignIn: () => void;
  isLoading?: boolean;
}

export default function StepConnecting({
  onProceedToSignIn,
  isLoading = false,
}: StepConnectingProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<ConnectingPhase>("connecting");

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
        if (!mounted) return;
        const nextPhase = PHASE_ORDER[i] as ConnectingPhase;
        setPhase(nextPhase);
        await new Promise((r) => setTimeout(r, 800));

        if (nextPhase === "creating-super-admin") {
          try {
            const res = await apiFetch("/api/v1/onboarding/create-super-admin", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
            if (!res.ok && mounted) {
              const data = (await res.json()) as { message?: string };
              console.warn("Create super admin:", data.message ?? res.statusText);
            }
          } catch (err) {
            if (mounted) console.warn("Create super admin failed:", err);
          }
          if (mounted) await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (mounted) {
        setPhase("ready");
      }
    };
    run();
    return () => {
      mounted = false;
    };
  }, []);

  const currentIndex = PHASE_ORDER.indexOf(phase);
  const isReady = phase === "ready";

  return (
    <div className="flex flex-col gap-8 w-full">
      {!isReady ? (
        <>
          <h1 className="text-[1.75rem] font-bold tracking-tight text-fms-text leading-tight m-0">
            {t("onboarding.connectingTitle")}
          </h1>
          <p className="text-[0.9375rem] leading-[1.45] text-fms-text-secondary m-0">
            {t("onboarding.connectingSubtitle")}
          </p>
          <ul className="list-none m-0 p-0 flex flex-col gap-4" aria-live="polite">
            {PHASE_ORDER.slice(0, -1).map((p, idx) => {
              const isActive = idx === currentIndex;
              const isDone = idx < currentIndex;
              const key = p;
              const label =
                p === "connecting"
                  ? t("onboarding.connectingCloud")
                  : p === "getting-details"
                    ? t("onboarding.gettingOrgDetails")
                    : p === "setting-data"
                      ? t("onboarding.settingOrgData")
                      : t("onboarding.creatingSuperAdmin");
              return (
                <li
                  key={key}
                  className={`flex items-center gap-3 text-[0.9375rem] ${
                    isActive
                      ? "text-fms-text font-semibold"
                      : isDone
                        ? "text-fms-text-secondary"
                        : "text-fms-text-tertiary"
                  }`}
                >
                  <span
                    className={`flex w-6 h-6 rounded-full items-center justify-center text-xs font-bold shrink-0 ${
                      isDone
                        ? "bg-fms-accent text-white"
                        : isActive
                          ? "bg-fms-accent-muted text-fms-accent"
                          : "bg-fms-bg-subtle text-fms-text-tertiary"
                    }`}
                  >
                    {isDone ? "✓" : idx + 1}
                  </span>
                  <span>{label}</span>
                  {isActive && (
                    <span className="inline-block w-2 h-2 rounded-full bg-fms-accent animate-pulse" />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <h1 className="text-[1.75rem] font-bold tracking-tight text-fms-text leading-tight m-0">
            {t("onboarding.allSetTitle")}
          </h1>
          <p className="text-[0.9375rem] leading-[1.45] text-fms-text-secondary m-0">
            {t("onboarding.allSetSubtitle")}
          </p>
          <Button
            type="button"
            size="lg"
            fullWidth
            onClick={onProceedToSignIn}
            loading={isLoading}
            disabled={isLoading}
            className="mt-4 !bg-fms-bg-subtle !text-fms-text hover:!bg-fms-surface-hover rounded-2xl"
          >
            {t("onboarding.proceedToSignIn")}
          </Button>
        </>
      )}
    </div>
  );
}
