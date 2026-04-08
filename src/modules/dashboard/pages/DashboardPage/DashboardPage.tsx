"use client";

import { useState, useEffect, useCallback } from "react";
import { useTauriReplace } from "@/core/tauri/useTauriPush";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import {
  IconUsers,
  IconLogin,
  IconLogout,
  IconGrid,
  IconList,
  IconMapPin,
  IconClock,
  IconPlus,
  IconRefresh,
} from "@/core/layout/icons";
import { useAuthStore } from "@/core/store/useAuthStore";
import { Badge, type BadgeVariant } from "@/core/ui/Badge";
import { KpiCard } from "@/modules/dashboard/components/KpiCard";
import { EntriesExitsAreaChart } from "@/modules/dashboard/components/EntriesExitsAreaChart";
import type { TimeRange } from "@/modules/dashboard/components/EntriesExitsAreaChart";
import type { AuditLogEntry } from "@/modules/audit-logs/types";
import detailStyles from "@/modules/audit-logs/pages/AuditLogsPage/DetailModal.module.css";

export type AgentState = "check-in" | "check-out" | "attendance" | "tracking";

const AGENT_STATE_KEYS: Record<AgentState, string> = {
  "check-in": "dashboard.agentStateCheckIn",
  "check-out": "dashboard.agentStateCheckOut",
  attendance: "dashboard.agentStateAttendance",
  tracking: "dashboard.agentStateTracking",
};

interface DashboardStats {
  totalEmployees: number;
  checkInToday: number;
  checkOutToday: number;
  currentlyCheckedIn: number;
  latestAccessLogs: { id: string; date: string; time: string; employee: string; zone: string; action: "check-in" | "check-out" }[];
  latestAuditLogs: { id: string; date: string; time: string; user: string | null; action: string; resource: string }[];
  chartData: { date: string; entries: number; exits: number }[];
}

/** Map audit action to badge variant (matches audit logs page). */
function getActionBadgeVariant(action: string): BadgeVariant {
  const normalized = action?.toLowerCase().replace(/_/g, "") ?? "";
  switch (normalized) {
    case "create":
    case "checkin":
      return "success";
    case "update":
      return "warning";
    case "delete":
    case "block":
    case "blocked":
    case "removed":
      return "danger";
    case "view":
    case "viewed":
      return "muted";
    case "copied":
    case "checkout":
      return "purple";
    default:
      return "neutral";
  }
}

function formatActionFallback(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatChangesJson(changes: string | null): string {
  if (!changes?.trim()) return "";
  try {
    const parsed = JSON.parse(changes) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return changes;
  }
}

const SESSION_KEY = "fms-session";

export default function DashboardPage() {
  const { t } = useTranslation();
  const replace = useTauriReplace();
  const canAccess = useAuthStore((s) => s.canAccess);
  const [timeRange, setTimeRange] = useState<TimeRange>("daily");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [detailLog, setDetailLog] = useState<AuditLogEntry | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);

  const actionLabel = useCallback(
    (action: string) => {
      const normalized = action?.toLowerCase().replace(/_/g, "") ?? "";
      const key = `auditLogs.action${normalized.charAt(0).toUpperCase() + normalized.slice(1)}` as keyof typeof t;
      const translated = t(key);
      return translated !== key ? translated : formatActionFallback(action);
    },
    [t]
  );

  const resourceLabel = useCallback(
    (resource: string) => {
      const resourceKey = resource?.toLowerCase() ?? "";
      const key = `auditLogs.resource${resourceKey.charAt(0).toUpperCase() + resourceKey.slice(1)}` as keyof typeof t;
      const translated = t(key);
      return translated !== key ? translated : resource;
    },
    [t]
  );

  const descriptionLabel = useCallback(
    (entry: AuditLogEntry): string => {
      const desc = entry.description?.trim();
      if (!desc) return t("auditLogs.detailNoDescription");
      if (desc.startsWith("auditLogs.desc")) {
        let params: Record<string, unknown> = {};
        try {
          if (entry.changes) {
            const parsed = JSON.parse(entry.changes) as Record<string, unknown>;
            params = { ...(parsed._i18n as Record<string, unknown>) };
          }
        } catch {
          // ignore
        }
        if (params.status !== undefined && params.statusLabel === undefined) {
          params.statusLabel = params.status === "active" ? t("zones.active") : t("zones.inactive");
        }
        const out = t(desc, params);
        return out !== desc ? out : entry.description ?? t("auditLogs.detailNoDescription");
      }
      return desc;
    },
    [t]
  );

  const userLabel = useCallback(
    (user: string | null | undefined) =>
      !user || user === "System" ? t("auditLogs.unknownUser") : user,
    [t]
  );

  const openDetail = useCallback(async (row: { id: string }) => {
    try {
      const res = await apiFetch(`/api/v1/audit-logs/${row.id}`);
      if (!res.ok) return;
      const data = (await res.json()) as AuditLogEntry;
      setDetailLog(data);
      setDetailClosing(false);
    } catch {
      // keep modal closed on error
    }
  }, []);

  const closeDetailModal = useCallback(() => {
    setDetailClosing(true);
    const id = setTimeout(() => {
      setDetailLog(null);
      setDetailClosing(false);
    }, 200);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && !window.localStorage.getItem(SESSION_KEY)) {
      replace("/login");
    }
  }, [replace]);

  const fetchStats = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/dashboard/stats?timeRange=${timeRange}`);
      if (!res.ok) throw new Error("Failed to fetch dashboard stats");
      const data = (await res.json()) as DashboardStats;
      setStats(data);
    } catch {
      if (!opts?.silent) setStats(null);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [timeRange]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStats({ silent: true }).finally(() => setRefreshing(false));
  }, [fetchStats]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const agentState: AgentState = (stats?.currentlyCheckedIn ?? 0) > 0 ? "check-in" : "check-out";
  const accessLogs = stats?.latestAccessLogs ?? [];
  const auditLogs = stats?.latestAuditLogs ?? [];
  const chartData = stats?.chartData ?? [];

  return (
    <DashboardLayout title={t("dashboard.title")}>
      <div className="w-full max-w-none">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("dashboard.overview")}</p>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            aria-label={t("dashboard.refreshLabel")}
            title={t("dashboard.refreshLabel")}
            className="inline-flex items-center justify-center gap-2 min-w-11 min-h-11 px-3 py-2 rounded-xl text-fms-text-secondary bg-fms-surface border border-fms-border shadow-sm transition-all duration-200 hover:bg-fms-surface-hover hover:border-fms-border-strong hover:text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent/40 focus:ring-offset-2 focus:ring-offset-fms-bg disabled:opacity-60 disabled:pointer-events-none active:scale-[0.98]"
          >
            <span
              className={`inline-flex transition-transform duration-200 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden
            >
              <IconRefresh className="w-5 h-5" />
            </span>
            <span className="text-sm font-medium hidden sm:inline">{t("dashboard.refresh")}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
          <KpiCard
            title={t("dashboard.totalEmployees")}
            value={loading ? "—" : String(stats?.totalEmployees ?? 0)}
            icon={<IconUsers className="w-5 h-5" />}
          />
          <KpiCard
            title={t("dashboard.totalCheckInToday")}
            value={loading ? "—" : String(stats?.checkInToday ?? 0)}
            icon={<IconLogin className="w-5 h-5" />}
          />
          <KpiCard
            title={t("dashboard.totalCheckOutToday")}
            value={loading ? "—" : String(stats?.checkOutToday ?? 0)}
            icon={<IconLogout className="w-5 h-5" />}
          />
          <KpiCard
            title={t("dashboard.agentState")}
            value={loading ? "—" : t(AGENT_STATE_KEYS[agentState])}
            icon={<IconGrid className="w-5 h-5" />}
          />
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border p-6 mb-6">
          <EntriesExitsAreaChart
            title={t("dashboard.entriesExits")}
            entriesLabel={t("dashboard.checkIns")}
            exitsLabel={t("dashboard.checkOuts")}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            data={chartData}
          />
        </section>

        <section className="mb-6" aria-label={t("dashboard.quickActions")}>
          <p className="text-xs font-semibold text-fms-text-tertiary uppercase tracking-wider mb-3">
            {t("dashboard.quickActions")}
          </p>
          <div className="flex flex-wrap gap-3">
            {canAccess("employees") && (
              <Link
                href="/employees/new"
                className="group flex items-center gap-3 rounded-xl border border-fms-border bg-fms-surface px-4 py-3 min-w-0 transition-all duration-200 hover:border-fms-accent/40 hover:bg-fms-accent-muted/50 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-fms-accent/30 focus:ring-offset-2 focus:ring-offset-fms-bg"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 [.group:hover_&]:bg-emerald-500/20 [.group:hover_&]:text-emerald-600">
                  <IconUsers className="w-4 h-4" />
                </span>
                <span className="text-sm font-medium text-fms-text group-hover:text-fms-text">{t("dashboard.addEmployee")}</span>
                <IconPlus className="w-4 h-4 shrink-0 text-fms-text-tertiary group-hover:text-fms-accent transition-colors" />
              </Link>
            )}
            {canAccess("zones") && (
              <Link
                href="/zones/new"
                className="group flex items-center gap-3 rounded-xl border border-fms-border bg-fms-surface px-4 py-3 min-w-0 transition-all duration-200 hover:border-fms-accent/40 hover:bg-fms-accent-muted/50 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-fms-accent/30 focus:ring-offset-2 focus:ring-offset-fms-bg"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-600 [.group:hover_&]:bg-amber-500/20 [.group:hover_&]:text-amber-600">
                  <IconMapPin className="w-4 h-4" />
                </span>
                <span className="text-sm font-medium text-fms-text group-hover:text-fms-text">{t("dashboard.createZone")}</span>
                <IconPlus className="w-4 h-4 shrink-0 text-fms-text-tertiary group-hover:text-fms-accent transition-colors" />
              </Link>
            )}
            {canAccess("shifts") && (
              <Link
                href="/shifts/new"
                className="group flex items-center gap-3 rounded-xl border border-fms-border bg-fms-surface px-4 py-3 min-w-0 transition-all duration-200 hover:border-fms-accent/40 hover:bg-fms-accent-muted/50 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-fms-accent/30 focus:ring-offset-2 focus:ring-offset-fms-bg"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-600 [.group:hover_&]:bg-violet-500/20 [.group:hover_&]:text-violet-600">
                  <IconClock className="w-4 h-4" />
                </span>
                <span className="text-sm font-medium text-fms-text group-hover:text-fms-text">{t("dashboard.createShift")}</span>
                <IconPlus className="w-4 h-4 shrink-0 text-fms-text-tertiary group-hover:text-fms-accent transition-colors" />
              </Link>
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
            <div className="flex items-center justify-between gap-4 p-4 border-b border-fms-border">
              <h3 className="text-base font-semibold text-fms-text m-0">{t("dashboard.latestAccessLogs")}</h3>
              {canAccess("accessLogs") && (
                <Link
                  href="/access-logs"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-fms-text-secondary hover:text-fms-text transition-colors"
                >
                  {t("dashboard.viewAll")}
                  <IconList className="w-4 h-4" />
                </Link>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fms-border">
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableTime")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableEmployee")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableZone")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableEvent")}</th>
                  </tr>
                </thead>
                <tbody>
                  {accessLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 px-4 text-center text-fms-text-tertiary text-sm">
                        {t("dashboard.noAccessLogs")}
                      </td>
                    </tr>
                  ) : (
                    accessLogs.map((row) => (
                      <tr key={row.id} className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50">
                        <td className="py-3 px-4 text-fms-text-secondary tabular-nums">{row.date} {row.time}</td>
                        <td className="py-3 px-4 text-fms-text">{row.employee}</td>
                        <td className="py-3 px-4 text-fms-text-secondary">{row.zone}</td>
                        <td className="py-3 px-4">
                          <Badge variant={row.action === "check-in" ? "success" : "purple"}>
                            {row.action === "check-in" ? t("dashboard.agentStateCheckIn") : t("dashboard.agentStateCheckOut")}
                          </Badge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
            <div className="flex items-center justify-between gap-4 p-4 border-b border-fms-border">
              <h3 className="text-base font-semibold text-fms-text m-0">{t("dashboard.latestAuditLogs")}</h3>
              {canAccess("auditLogs") && (
                <Link
                  href="/audit-logs"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-fms-text-secondary hover:text-fms-text transition-colors"
                >
                  {t("dashboard.viewAll")}
                  <IconList className="w-4 h-4" />
                </Link>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fms-border">
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableUser")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableAction")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableResource")}</th>
                    <th className="text-left py-3 px-4 font-medium text-fms-text-tertiary">{t("dashboard.tableTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 px-4 text-center text-fms-text-tertiary text-sm">
                        {t("dashboard.noAuditLogs")}
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((row) => (
                      <tr
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openDetail(row)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openDetail(row);
                          }
                        }}
                        className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors cursor-pointer"
                        aria-label={t("auditLogs.viewDetails")}
                      >
                        <td className="py-3 px-4 font-medium text-fms-text">{userLabel(row.user)}</td>
                        <td className="py-3 px-4">
                          <Badge variant={getActionBadgeVariant(row.action)}>
                            {actionLabel(row.action)}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-fms-text-secondary">{resourceLabel(row.resource)}</td>
                        <td className="py-3 px-4 text-fms-text-secondary tabular-nums whitespace-nowrap">{row.date} {row.time}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Audit log detail modal (same as audit logs page) */}
        {detailLog && (
          <div
            className={detailStyles.overlay}
            data-closing={detailClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-audit-detail-title"
            onClick={(e) => e.target === e.currentTarget && closeDetailModal()}
          >
            <div
              className={detailStyles.modal}
              data-closing={detailClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={detailStyles.header}>
                <h2 id="dashboard-audit-detail-title" className={detailStyles.title}>
                  {t("auditLogs.detailModalTitle")}
                </h2>
                <button
                  type="button"
                  className={detailStyles.closeBtn}
                  onClick={closeDetailModal}
                  aria-label={t("auditLogs.close")}
                >
                  ×
                </button>
              </div>
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailDescription")}</span>
                <p
                  className={
                    detailLog.description
                      ? `${detailStyles.sectionValue} ${detailStyles.sectionValueTruncated}`
                      : detailStyles.sectionValueMuted
                  }
                  title={descriptionLabel(detailLog)}
                >
                  {descriptionLabel(detailLog)}
                </p>
              </div>
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailActor")}</span>
                <p className={detailStyles.sectionValue}>
                  {userLabel(detailLog.actorName ?? detailLog.actorId ?? null)}
                </p>
              </div>
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailResource")}</span>
                <p className={detailStyles.sectionValue}>{resourceLabel(detailLog.resource)}</p>
              </div>
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailAction")}</span>
                <p className={detailStyles.sectionValue}>
                  <Badge variant={getActionBadgeVariant(detailLog.action)}>
                    {actionLabel(detailLog.action)}
                  </Badge>
                </p>
              </div>
              {detailLog.resourceId && (
                <div className={detailStyles.section}>
                  <span className={detailStyles.sectionLabel}>{t("auditLogs.detailResourceId")}</span>
                  <p className={detailStyles.sectionValue}>{detailLog.resourceId}</p>
                </div>
              )}
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailTimestamp")}</span>
                <p className={detailStyles.sectionValue}>
                  {new Date(detailLog.timestamp).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })}
                </p>
              </div>
              <div className={detailStyles.section}>
                <span className={detailStyles.sectionLabel}>{t("auditLogs.detailChanges")}</span>
                {detailLog.changes ? (
                  <pre className={detailStyles.changesBlock}>{formatChangesJson(detailLog.changes)}</pre>
                ) : (
                  <p className={detailStyles.sectionValueMuted}>{t("auditLogs.detailNoChanges")}</p>
                )}
              </div>
              <div className={detailStyles.actions}>
                <button type="button" className={detailStyles.closeAction} onClick={closeDetailModal}>
                  {t("auditLogs.close")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
