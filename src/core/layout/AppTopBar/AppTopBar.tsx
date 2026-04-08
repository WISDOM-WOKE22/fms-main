"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { IconBell, IconUser, IconSettings, IconX, IconClock } from "@/core/layout/icons";
import { useTheme } from "@/core/contexts/ThemeContext";
import { useSyncStatus } from "@/core/hooks/useSyncStatus";
import { SyncIndicator } from "@/core/layout/AppTopBar/SyncIndicator";
import { useAuthStore } from "@/core/store/useAuthStore";
import { useAppStore, type AppLanguage } from "@/core/store/useAppStore";
import {
  useNotificationStore,
  formatNotificationTime,
  type AppNotification,
} from "@/core/store/useNotificationStore";

export type { AppNotification };

const LANGUAGE_OPTIONS: { value: AppLanguage; labelKey: string }[] = [
  { value: "en", labelKey: "topbar.english" },
  { value: "ar", labelKey: "topbar.arabic" },
];

export interface AppTopBarProps {
  title?: string;
  logoUrl?: string | null;
  orgName?: string;
}

const NOTIFICATION_POPUP_CLOSE_MS = 200;

export default function AppTopBar({ title }: AppTopBarProps) {
  const { t } = useTranslation();
  const admin = useAuthStore((s) => s.admin);
  const isSuperAdmin = admin?.role === "super_admin";
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [popupClosing, setPopupClosing] = useState(false);
  const notifications = useNotificationStore((s) => s.notifications);
  const selectedId = useNotificationStore((s) => s.selectedId);
  const openNotification = useNotificationStore((s) => s.openNotification);
  const closeDetail = useNotificationStore((s) => s.closeDetail);
  const selectedNotification = useMemo(
    () => notifications.find((n) => n.id === selectedId) ?? null,
    [notifications, selectedId]
  );
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  useEffect(() => {
    if (!profileOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileOpen]);

  useEffect(() => {
    if (!notificationsOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (notificationRef.current && !notificationRef.current.contains(e.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [notificationsOpen]);

  const openNotificationDetail = useCallback(
    (n: AppNotification) => {
      openNotification(n);
      setPopupClosing(false);
      setNotificationsOpen(false);
    },
    [openNotification]
  );

  const closeNotificationPopup = useCallback(() => {
    setPopupClosing(true);
    const id = setTimeout(() => {
      closeDetail();
      setPopupClosing(false);
    }, NOTIFICATION_POPUP_CLOSE_MS);
    return () => clearTimeout(id);
  }, [closeDetail]);

  useEffect(() => {
    if (!selectedId || popupClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNotificationPopup();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, popupClosing, closeNotificationPopup]);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const syncStatus = useSyncStatus();

  return (
    <header
      className="sticky top-0 z-10 h-14 flex-shrink-0 flex items-center justify-between px-6 border-b border-fms-glass-border bg-fms-glass-bg rtl:flex-row-reverse text-fms-text backdrop-blur-xl backdrop-saturate-150 text-fms-text"
      style={{ WebkitBackdropFilter: "blur(20px) saturate(180%)" }}
    >
      <h1 className="text-[1.0625rem] font-semibold tracking-tight m-0">
        {title ?? t("nav.dashboard")}
      </h1>

      <div className="flex items-center gap-1">
        <SyncIndicator
          isOnline={syncStatus.isOnline}
          syncEnabled={syncStatus.syncEnabled}
          pendingCount={syncStatus.pendingCount}
          lastSyncedLabel={syncStatus.lastSyncedLabel}
          isSyncing={syncStatus.isSyncing}
          lastSyncErrors={syncStatus.lastSyncErrors}
          pendingItems={syncStatus.pendingItems}
          loadingPendingItems={syncStatus.loadingPendingItems}
          fetchPendingItems={syncStatus.fetchPendingItems}
          runSync={syncStatus.runSync}
        />
        <div className="relative" ref={notificationRef}>
          <button
            type="button"
            onClick={() => setNotificationsOpen((o) => !o)}
            className="relative p-2.5 rounded-2xl text-fms-text-secondary hover:text-fms-text hover:bg-fms-surface-hover transition-all duration-200 ease-out"
            aria-label={t("topbar.notifications")}
            aria-expanded={notificationsOpen}
          >
            <IconBell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 end-1.5 min-w-[1.125rem] h-[1.125rem] rounded-full bg-fms-accent text-fms-accent-foreground text-[0.625rem] font-semibold flex items-center justify-center px-1">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {notificationsOpen && (
            <div
              className="absolute end-0 top-full mt-2 w-[22rem] max-h-[28rem] flex flex-col rounded-2xl border border-fms-border bg-fms-surface shadow-xl z-50 text-fms-text rtl:start-0 rtl:end-auto overflow-hidden transition-all duration-200 ease-out"
              role="dialog"
              aria-label={t("topbar.notifications")}
            >
              <div className="px-4 py-3 border-b border-fms-border flex-shrink-0">
                <h2 className="text-sm font-semibold text-fms-text">
                  {t("topbar.notifications")}
                </h2>
              </div>
              <div className="overflow-y-auto flex-1 min-h-0">
                {notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <div className="w-12 h-12 rounded-2xl bg-fms-bg-subtle border border-fms-border flex items-center justify-center mx-auto mb-3">
                      <IconBell className="w-6 h-6 text-fms-text-tertiary" />
                    </div>
                    <p className="text-sm font-medium text-fms-text-secondary">
                      {t("topbar.noNotifications")}
                    </p>
                    <p className="text-xs text-fms-text-tertiary mt-1">
                      {t("topbar.noNotificationsDesc")}
                    </p>
                  </div>
                ) : (
                  <>
                    <ul className="py-1">
                      {notifications.map((n) => (
                        <li key={n.id} className="border-b border-fms-border last:border-b-0">
                          <button
                            type="button"
                            onClick={() => openNotificationDetail(n)}
                            className={`w-full text-start px-4 py-3.5 flex gap-3 hover:bg-fms-surface-hover transition-colors duration-150 ${
                              !n.read ? "bg-fms-accent-muted/25" : ""
                            }`}
                          >
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm font-medium text-fms-text truncate">
                                {n.title}
                              </span>
                              <span className="block text-xs text-fms-text-secondary line-clamp-2 mt-0.5">
                                {n.message}
                              </span>
                              <span className="flex items-center gap-1 mt-1.5 text-[0.6875rem] text-fms-text-tertiary">
                                <IconClock className="w-3.5 h-3.5 flex-shrink-0" />
                                {formatNotificationTime(n.createdAt)}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="border-t border-fms-border flex-shrink-0 px-3 py-2">
                      <Link
                        href="/notifications"
                        onClick={() => setNotificationsOpen(false)}
                        className="block w-full text-center py-2.5 rounded-xl text-sm font-medium text-fms-accent hover:bg-fms-accent-muted/30 transition-colors duration-150"
                      >
                        {t("topbar.viewAll")}
                      </Link>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setProfileOpen((o) => !o)}
            className="p-1.5 rounded-2xl text-fms-text-secondary hover:text-fms-text hover:bg-fms-surface-hover transition-all duration-200 ease-out flex items-center justify-center"
            aria-label={t("topbar.profileMenu")}
            aria-expanded={profileOpen}
          >
            <span className="w-8 h-8 rounded-full bg-fms-accent-muted flex items-center justify-center border border-fms-border">
              <IconUser className="w-4 h-4 text-fms-text" />
            </span>
          </button>

          {profileOpen && (
            <div
              className="absolute end-0 top-full mt-2 w-64 rounded-2xl border border-fms-border bg-fms-surface shadow-xl py-2 z-50 text-fms-text rtl:start-0 rtl:end-auto"
              role="menu"
            >
              <div className="px-2 py-1.5">
                <Link
                  href="/profile"
                  onClick={() => setProfileOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-fms-text hover:bg-fms-surface-hover transition-colors duration-200 ease-out"
                  role="menuitem"
                >
                  <span className="w-8 h-8 rounded-full bg-fms-accent-muted flex items-center justify-center flex-shrink-0">
                    <IconUser className="w-4 h-4 text-fms-text" />
                  </span>
                  <span className="text-sm font-medium">{t("nav.profile")}</span>
                </Link>
                {isSuperAdmin && (
                  <Link
                    href="/settings"
                    onClick={() => setProfileOpen(false)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-fms-text hover:bg-fms-surface-hover transition-colors duration-200 ease-out"
                    role="menuitem"
                  >
                    <span className="w-8 h-8 rounded-full bg-fms-bg-subtle flex items-center justify-center flex-shrink-0 border border-fms-border">
                      <IconSettings className="w-4 h-4 text-fms-text-secondary" />
                    </span>
                    <span className="text-sm font-medium">{t("nav.settings")}</span>
                  </Link>
                )}
              </div>
              <div className="h-px bg-fms-border mx-2" aria-hidden />
              <div className="px-3 py-2 border-b border-fms-border">
                <p className="text-[0.6875rem] font-bold uppercase tracking-wider text-fms-text-tertiary">
                  {t("topbar.theme")}
                </p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isDark}
                  aria-label={isDark ? t("topbar.switchToLight") : t("topbar.switchToDark")}
                  onClick={toggleTheme}
                  className="mt-2 w-full flex items-center p-1 rounded-2xl bg-fms-bg-subtle border border-fms-border hover:bg-fms-surface-hover transition-colors"
                >
                  <span
                    className={`flex-1 py-2 rounded-l-2xl text-sm font-medium transition-colors rtl:rounded-r-2xl rtl:rounded-l-none ${
                      !isDark ? "bg-fms-accent-muted text-fms-text" : "text-fms-text-tertiary"
                    }`}
                  >
                    {t("topbar.light")}
                  </span>
                  <span
                    className={`flex-1 py-2 rounded-r-2xl text-sm font-medium transition-colors rtl:rounded-l-2xl rtl:rounded-r-none ${
                      isDark ? "bg-fms-accent-muted text-fms-text" : "text-fms-text-tertiary"
                    }`}
                  >
                    {t("topbar.dark")}
                  </span>
                </button>
              </div>
              <div className="px-3 py-2">
                <p className="text-[0.6875rem] font-bold uppercase tracking-wider text-fms-text-tertiary">
                  {t("topbar.language")}
                </p>
                <div className="mt-2 flex p-1.5 rounded-2xl bg-fms-bg-subtle border border-fms-border gap-0">
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setLanguage(opt.value)}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium transition-colors ${
                        language === opt.value
                          ? "bg-fms-accent-muted text-fms-text"
                          : "text-fms-text-tertiary hover:text-fms-text-secondary"
                      }`}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Notification detail popup — portaled to body so it overlays the entire screen */}
      {selectedNotification &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-popup-title"
          >
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200"
              style={{ opacity: popupClosing ? 0 : 1 }}
              onClick={closeNotificationPopup}
            />
            <div
              className="relative w-full max-w-md rounded-2xl border border-fms-border bg-fms-surface shadow-2xl overflow-hidden transition-all duration-200"
              style={{
                opacity: popupClosing ? 0 : 1,
                transform: popupClosing ? "scale(0.98)" : "scale(1)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 pt-6 pb-5">
                <div className="flex items-start justify-between gap-3">
                  <h2
                    id="notification-popup-title"
                    className="text-lg font-semibold text-fms-text flex-1 min-w-0 leading-tight"
                  >
                    {selectedNotification.title}
                  </h2>
                  <button
                    type="button"
                    onClick={closeNotificationPopup}
                    className="shrink-0 p-2 rounded-xl text-fms-text-tertiary hover:text-fms-text hover:bg-fms-surface-hover transition-colors duration-150"
                    aria-label={t("topbar.close")}
                  >
                    <IconX className="w-5 h-5" />
                  </button>
                </div>
                <p className="mt-4 text-sm text-fms-text-secondary leading-relaxed whitespace-pre-wrap">
                  {selectedNotification.message}
                </p>
                <div className="mt-5 pt-4 border-t border-fms-border/80 flex items-center gap-2 text-xs text-fms-text-tertiary">
                  <IconClock className="w-4 h-4 shrink-0" />
                  <span>{formatNotificationTime(selectedNotification.createdAt)}</span>
                  <span className="opacity-70">
                    · {selectedNotification.createdAt.toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="px-6 py-4 border-t border-fms-border bg-fms-bg-subtle/50">
                <button
                  type="button"
                  onClick={closeNotificationPopup}
                  className="w-full py-3 rounded-xl text-sm font-medium text-fms-text bg-fms-surface hover:bg-fms-surface-hover border border-fms-border transition-colors duration-150"
                >
                  {t("topbar.close")}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </header>
  );
}
