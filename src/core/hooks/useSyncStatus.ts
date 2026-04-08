"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/core/api/request";

const SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const STATUS_POLL_MS = 30 * 1000; // 30 seconds

export interface SyncStatusState {
  isOnline: boolean;
  syncEnabled: boolean;
  pendingCount: number;
  lastSyncCursor: string | null;
  lastSyncedAt: number | null;
  isSyncing: boolean;
  lastSyncErrors: string[];
  pendingItems: SyncPendingItem[];
  loadingPendingItems: boolean;
}

export interface SyncPendingItem {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  createdAt: string;
  payload: unknown;
}

function formatRelativeTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day !== 1 ? "s" : ""} ago`;
}

/**
 * Fetches sync status from the API and runs sync on an interval.
 * Tracks online state, last synced time, and pending changes.
 */
export function useSyncStatus() {
  const [state, setState] = useState<SyncStatusState>({
    isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
    syncEnabled: false,
    pendingCount: 0,
    lastSyncCursor: null,
    lastSyncedAt: null,
    isSyncing: false,
    lastSyncErrors: [],
    pendingItems: [],
    loadingPendingItems: false,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/v1/sync/status");
      if (!res.ok) return;
      const data = (await res.json()) as {
        syncEnabled?: boolean;
        pendingCount?: number;
        lastSyncCursor?: string | null;
      };
      setState((prev) => ({
        ...prev,
        syncEnabled: data.syncEnabled ?? false,
        pendingCount: data.pendingCount ?? 0,
        lastSyncCursor: data.lastSyncCursor ?? null,
      }));
    } catch {
      // ignore
    }
  }, []);

  const runSync = useCallback(async () => {
    setState((prev) => ({ ...prev, isSyncing: true, lastSyncErrors: [] }));
    try {
      const res = await apiFetch("/api/v1/sync/run", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        pushed?: number;
        pulled?: number;
        errors?: string[];
      };
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (res.ok) {
        setState((prev) => ({
          ...prev,
          lastSyncedAt: Date.now(),
          lastSyncErrors: errors,
        }));
        await fetchStatus();
      } else {
        setState((prev) => ({ ...prev, lastSyncErrors: errors }));
      }
    } catch {
      setState((prev) => ({ ...prev, lastSyncErrors: ["Sync request failed"] }));
    } finally {
      setState((prev) => ({ ...prev, isSyncing: false }));
    }
  }, [fetchStatus]);

  const fetchPendingItems = useCallback(async () => {
    setState((prev) => ({ ...prev, loadingPendingItems: true }));
    try {
      const res = await apiFetch("/api/v1/sync/pending");
      if (!res.ok) return;
      const data = (await res.json()) as SyncPendingItem[];
      setState((prev) => ({
        ...prev,
        pendingItems: Array.isArray(data) ? data : [],
      }));
    } catch {
      // ignore
    } finally {
      setState((prev) => ({ ...prev, loadingPendingItems: false }));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    statusIntervalRef.current = setInterval(fetchStatus, STATUS_POLL_MS);
    return () => {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current);
        statusIntervalRef.current = null;
      }
    };
  }, [fetchStatus]);

  useEffect(() => {
    runSync();
    intervalRef.current = setInterval(runSync, SYNC_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [runSync]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setState((prev) => ({ ...prev, isOnline: true }));
    const handleOffline = () => setState((prev) => ({ ...prev, isOnline: false }));
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const lastSyncedLabel =
    state.lastSyncedAt != null
      ? formatRelativeTime(Date.now() - state.lastSyncedAt)
      : null;

  return {
    ...state,
    lastSyncedLabel,
    refetchStatus: fetchStatus,
    fetchPendingItems,
    runSync,
  };
}
