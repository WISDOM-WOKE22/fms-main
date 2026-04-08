"use client";

import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { IconBell, IconClock, IconChevronLeft, IconChevronRight } from "@/core/layout/icons";
import { Select } from "@/core/ui";
import {
  useNotificationStore,
  formatNotificationTime,
  type AppNotification,
} from "@/core/store/useNotificationStore";

const ROWS_PER_PAGE_OPTIONS = [10, 15, 20, 50];

type FilterTab = "all" | "unread";

export default function NotificationsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<FilterTab>("all");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const notifications = useNotificationStore((s) => s.notifications);
  const openNotification = useNotificationStore((s) => s.openNotification);
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead);

  const filtered = useMemo(() => {
    if (filter === "unread") return notifications.filter((n) => !n.read);
    return notifications;
  }, [notifications, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginated = useMemo(
    () => filtered.slice(start, start + rowsPerPage),
    [filtered, start, rowsPerPage]
  );

  useEffect(() => {
    setPage(1);
  }, [filter]);

  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <DashboardLayout title={t("notificationsPage.title")}>
      <div className="w-full">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="flex p-1 rounded-2xl bg-fms-bg-subtle border border-fms-border w-fit">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                filter === "all"
                  ? "bg-fms-surface text-fms-text shadow-sm"
                  : "text-fms-text-tertiary hover:text-fms-text-secondary"
              }`}
            >
              {t("notificationsPage.all")}
            </button>
            <button
              type="button"
              onClick={() => setFilter("unread")}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 ${
                filter === "unread"
                  ? "bg-fms-surface text-fms-text shadow-sm"
                  : "text-fms-text-tertiary hover:text-fms-text-secondary"
              }`}
            >
              {t("notificationsPage.unread")}
              {unreadCount > 0 && (
                <span className="min-w-5 h-5 px-1.5 rounded-full bg-fms-accent text-fms-accent-foreground text-xs font-semibold flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>
          </div>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllAsRead}
              className="text-sm font-medium text-fms-accent hover:text-fms-accent/90 transition-colors"
            >
              {t("notificationsPage.markAllRead")}
            </button>
          )}
        </div>

        <div className="rounded-2xl border border-fms-border bg-fms-surface overflow-hidden shadow-sm">
          {filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="w-14 h-14 rounded-2xl bg-fms-bg-subtle border border-fms-border flex items-center justify-center mx-auto mb-4">
                <IconBell className="w-7 h-7 text-fms-text-tertiary" />
              </div>
              <p className="text-base font-medium text-fms-text">
                {t("notificationsPage.empty")}
              </p>
              <p className="text-sm text-fms-text-tertiary mt-1">
                {t("notificationsPage.emptyDesc")}
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-fms-border">
                {paginated.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onOpen={() => openNotification(n)}
                  />
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border">
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-sm text-fms-text-secondary">
                      {t("notificationsPage.pageOf", {
                        current: page,
                        total: totalPages,
                      })}
                    </span>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-fms-text-secondary">
                        {t("notificationsPage.rowsPerPage")}
                      </label>
                      <Select
                        value={rowsPerPage}
                        onChange={(e) => {
                          setRowsPerPage(Number(e.target.value));
                          setPage(1);
                        }}
                        selectSize="sm"
                        className="min-w-[72px]"
                      >
                        {ROWS_PER_PAGE_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                    >
                      <IconChevronLeft className="w-4 h-4" />
                      {t("notificationsPage.previous")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                    >
                      {t("notificationsPage.next")}
                      <IconChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: AppNotification;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { title, message, createdAt, read } = notification;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`w-full text-start px-6 py-4 hover:bg-fms-surface-hover transition-colors duration-150 ${
          !read ? "bg-fms-accent-muted/20" : ""
        }`}
      >
        <div className="flex gap-4">
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-fms-text truncate">
              {title}
            </span>
            <span className="block text-sm text-fms-text-secondary line-clamp-2 mt-0.5">
              {message}
            </span>
            <span
              className="flex items-center gap-1.5 mt-2 text-xs text-fms-text-tertiary"
              aria-label={t("topbar.notificationTime")}
            >
              <IconClock className="w-4 h-4 shrink-0" />
              {formatNotificationTime(createdAt)}
              <span className="opacity-75">
                · {createdAt.toLocaleString()}
              </span>
            </span>
          </span>
        </div>
      </button>
    </li>
  );
}
