"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/core/api/request";

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Runs cloud sync in the background when the dashboard is active.
 * Pushes pending local changes then pulls cloud changes (LWW).
 * Does not block UI; failures are silent.
 */
export function useSync() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const runSync = () => {
      apiFetch("/api/v1/sync/run", { method: "POST" })
        .then((r) => r.json())
        .catch(() => {});
    };

    runSync();
    intervalRef.current = setInterval(runSync, SYNC_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);
}
