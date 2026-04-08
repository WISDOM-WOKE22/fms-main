"use client";

import { useRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IconClock, IconRefresh } from "@/core/layout/icons";

type SyncPendingItem = {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  createdAt: string;
  payload: unknown;
};

export interface SyncIndicatorProps {
  isOnline: boolean;
  syncEnabled: boolean;
  pendingCount: number;
  lastSyncedLabel: string | null;
  isSyncing: boolean;
  lastSyncErrors: string[];
  pendingItems: SyncPendingItem[];
  loadingPendingItems: boolean;
  fetchPendingItems: () => Promise<void>;
  runSync: () => Promise<void>;
}

export function SyncIndicator({
  isOnline,
  syncEnabled,
  pendingCount,
  lastSyncedLabel,
  isSyncing,
  lastSyncErrors,
  pendingItems,
  loadingPendingItems,
  fetchPendingItems,
  runSync,
}: SyncIndicatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleSyncNow = async () => {
    await runSync();
    setOpen(false);
  };

  const handleOpenDetails = async () => {
    await fetchPendingItems();
    setDetailsOpen(true);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative p-2.5 rounded-2xl text-fms-text-secondary hover:text-fms-text hover:bg-fms-surface-hover transition-all duration-200 ease-out flex items-center gap-1.5"
        aria-label={t("topbar.syncStatus")}
        aria-expanded={open}
        title={isOnline ? t("topbar.syncOnline") : t("topbar.syncOffline")}
      >
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            isOnline ? "bg-emerald-500" : "bg-fms-text-tertiary"
          }`}
          aria-hidden
        />
        <span className="sr-only">
          {isOnline ? t("topbar.syncOnline") : t("topbar.syncOffline")}
        </span>
      </button>

      {open && (
        <div
          className="absolute end-0 top-full mt-2 w-72 rounded-2xl border border-fms-border bg-fms-surface shadow-xl z-50 text-fms-text rtl:start-0 rtl:end-auto overflow-hidden"
          role="dialog"
          aria-label={t("topbar.syncStatus")}
        >
          <div className="px-4 py-3 border-b border-fms-border">
            <h2 className="text-sm font-semibold text-fms-text">
              {t("topbar.syncStatus")}
            </h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  isOnline ? "bg-emerald-500" : "bg-fms-text-tertiary"
                }`}
              />
              <span className="text-sm text-fms-text-secondary">
                {isOnline ? t("topbar.syncOnline") : t("topbar.syncOffline")}
              </span>
            </div>

            <div className="flex items-center gap-2 text-sm text-fms-text-secondary">
              <IconClock className="w-4 h-4 shrink-0 text-fms-text-tertiary" />
              <span>
                {lastSyncedLabel != null
                  ? t("topbar.syncLastSynced", { time: lastSyncedLabel })
                  : t("topbar.syncNeverSynced")}
              </span>
            </div>

            {syncEnabled ? (
              pendingCount > 0 ? (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  {t("topbar.syncPendingChanges", { count: pendingCount })}
                </p>
              ) : (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  {t("topbar.syncEverythingUpToDate")}
                </p>
              )
            ) : (
              <p className="text-xs text-fms-text-tertiary">
                {t("topbar.syncNotConfigured")}
              </p>
            )}

            {lastSyncErrors.length > 0 && (
              <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 space-y-1">
                <p className="text-xs font-medium text-red-600 dark:text-red-400">
                  {t("topbar.syncErrors", { count: lastSyncErrors.length })}
                </p>
                <ul className="text-xs text-fms-text-secondary list-disc list-inside space-y-0.5 max-h-24 overflow-y-auto">
                  {lastSyncErrors.slice(0, 5).map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                  {lastSyncErrors.length > 5 && (
                    <li>… +{lastSyncErrors.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}

            {syncEnabled && (
              <div className="space-y-2">
                {pendingCount > 0 && (
                  <button
                    type="button"
                    onClick={handleOpenDetails}
                    className="w-full py-2.5 rounded-xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle transition-colors"
                  >
                    {loadingPendingItems ? "Loading details..." : "Details"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={isSyncing}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-fms-accent-muted text-fms-text hover:bg-fms-accent-muted/80 disabled:opacity-50 transition-colors"
                >
                  <IconRefresh
                    className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                  />
                  {isSyncing ? t("topbar.syncSyncing") : t("topbar.syncNow")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {detailsOpen &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Sync details"
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDetailsOpen(false)}
          />
          <div
            className="relative w-full max-w-3xl max-h-[80vh] rounded-2xl border border-fms-border bg-fms-surface shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-fms-border flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fms-text">Sync Details ({pendingItems.length})</h3>
              <button
                type="button"
                onClick={() => setDetailsOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs border border-fms-border hover:bg-fms-bg-subtle"
              >
                Close
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto max-h-[calc(80vh-64px)]">
              {pendingItems.length === 0 ? (
                <p className="text-sm text-fms-text-secondary">No pending sync data.</p>
              ) : (
                pendingItems.map((item) => (
                  <div key={item.id} className="rounded-xl border border-fms-border bg-fms-bg-subtle/40">
                    <div className="px-3 py-2 text-xs text-fms-text-secondary border-b border-fms-border flex flex-wrap gap-3">
                      <span><strong>entity:</strong> {item.entity}</span>
                      <span><strong>action:</strong> {item.action}</span>
                      <span><strong>id:</strong> {item.entityId}</span>
                    </div>
                    <pre className="m-0 p-3 text-xs overflow-x-auto text-fms-text-secondary">
{JSON.stringify(item.payload, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
