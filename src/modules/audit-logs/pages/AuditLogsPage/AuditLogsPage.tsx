"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { useAppPreferences } from "@/core/contexts/AppPreferencesContext";
import { exportPdf } from "@/core/lib/exportPdf";
import { saveFile } from "@/core/lib/saveFile";
import { IconChevronLeft, IconChevronRight, IconDownload, IconSearch } from "@/core/layout/icons";
import { Badge, Select, type BadgeVariant } from "@/core/ui";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import { AUDIT_RESOURCE_KEYS } from "@/modules/audit-logs/data/auditResources";
import type { AuditLogEntry, AuditLogRow } from "@/modules/audit-logs/types";
import { auditEntryToRow } from "@/modules/audit-logs/types";
import styles from "./ExportModal.module.css";
import detailStyles from "./DetailModal.module.css";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];

type ExportFormat = "pdf" | "excel";
type ExportColumnKey = "user" | "action" | "resource" | "description" | "time";
const EXPORT_COLUMN_KEYS: ExportColumnKey[] = ["user", "action", "resource", "description", "time"];

function formatDateTime(date: string, time: string): string {
  const d = new Date(date + "T" + time);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatActionFallback(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map audit action to badge variant for consistent visual meaning. */
function getActionBadgeVariant(action: string): BadgeVariant {
  const normalized = action?.toLowerCase().replace(/[_-]/g, "") ?? "";
  switch (normalized) {
    case "create":
    case "checkin":
    case "reactivate":
    case "faceregistered":
      return "success";
    case "update":
    case "sendenrollmentlink":
      return "warning";
    case "delete":
    case "block":
    case "blocked":
    case "removed":
    case "deactivate":
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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

export default function AuditLogsPage() {
  const { t, i18n } = useTranslation();
  const { config } = useAppConfig();
  const { getLogoUrl } = useAppPreferences();
  const logoUrl = getLogoUrl(config.companyLogoUrl);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleFilters, setVisibleFilters] = useState<Set<"date" | "resource">>(new Set());
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [resourceFilter, setResourceFilter] = useState<string>("all");
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("excel");
  const [exportColumns, setExportColumns] = useState<Record<ExportColumnKey, boolean>>({
    user: true,
    action: true,
    resource: true,
    description: true,
    time: true,
  });
  const [exportClosing, setExportClosing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detailLog, setDetailLog] = useState<AuditLogEntry | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);

  /** Fetch all audit logs matching current table filters (for export). Single request with high limit. */
  const fetchAllLogsForExport = useCallback(async (): Promise<AuditLogEntry[]> => {
    const params = new URLSearchParams();
    params.set("limit", "50000");
    params.set("offset", "0");
    if (searchQuery.trim()) params.set("search", searchQuery.trim());
    if (resourceFilter !== "all") params.set("resource", resourceFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    const res = await apiFetch(`/api/v1/audit-logs?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to fetch audit logs");
    const data = (await res.json()) as { items: AuditLogEntry[]; total: number };
    return data.items ?? [];
  }, [searchQuery, resourceFilter, dateFrom, dateTo]);

  const resourceLabel = useCallback(
    (resourceKey: string) => {
      const key = `auditLogs.resource${resourceKey.charAt(0).toUpperCase() + resourceKey.slice(1)}` as keyof typeof t;
      return t(key);
    },
    [t]
  );

  const actionLabel = useCallback(
    (action: string) => {
      const normalized = action?.toLowerCase().replace(/[_-]/g, "") ?? "";
      const key = `auditLogs.action${normalized.charAt(0).toUpperCase() + normalized.slice(1)}` as keyof typeof t;
      const translated = t(key);
      return translated !== key ? translated : formatActionFallback(action);
    },
    [t]
  );

  const userLabel = useCallback(
    (user: string | null | undefined) =>
      !user || user === "System" ? t("auditLogs.unknownUser") : user,
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

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", String(rowsPerPage));
    params.set("offset", String((page - 1) * rowsPerPage));
    if (searchQuery.trim()) params.set("search", searchQuery.trim());
    if (resourceFilter !== "all") params.set("resource", resourceFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    try {
      const res = await apiFetch(`/api/v1/audit-logs?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = (await res.json()) as { items: AuditLogEntry[]; total: number };
      setLogs(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, rowsPerPage, searchQuery, resourceFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const rows: AuditLogRow[] = useMemo(
    () => logs.map((e) => auditEntryToRow(e)),
    [logs]
  );

  const totalPages = Math.max(1, Math.ceil(total / rowsPerPage));
  const hasActiveFilters =
    searchQuery !== "" ||
    dateFrom !== "" ||
    dateTo !== "" ||
    resourceFilter !== "all" ||
    visibleFilters.size > 0;

  const handleResetFilters = () => {
    setSearchQuery("");
    setVisibleFilters(new Set());
    setDateFrom("");
    setDateTo("");
    setResourceFilter("all");
    setPage(1);
  };

  const addVisibleFilter = (key: "date" | "resource") => {
    setVisibleFilters((prev) => new Set(prev).add(key));
    setPage(1);
  };
  const removeVisibleFilter = (key: "date" | "resource") => {
    setVisibleFilters((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (key === "date") {
      setDateFrom("");
      setDateTo("");
    } else setResourceFilter("all");
    setPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setPage(1);
  };
  const handleResourceFilterChange = (value: string) => {
    setResourceFilter(value);
    setPage(1);
  };
  const handleDateFromChange = (value: string) => {
    setDateFrom(value);
    setPage(1);
  };
  const handleDateToChange = (value: string) => {
    setDateTo(value);
    setPage(1);
  };

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));

  const openDetail = useCallback(async (entry: AuditLogEntry) => {
    try {
      const res = await apiFetch(`/api/v1/audit-logs/${entry.id}`);
      if (!res.ok) return;
      const data = (await res.json()) as AuditLogEntry;
      setDetailLog(data);
      setDetailClosing(false);
    } catch {
      setDetailLog(entry);
      setDetailClosing(false);
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

  const closeExportModal = useCallback(() => {
    setExportClosing(true);
    const id = setTimeout(() => {
      setExportModalOpen(false);
      setExportClosing(false);
    }, 200);
    return () => clearTimeout(id);
  }, []);

  const getColumnLabel = useCallback(
    (key: ExportColumnKey) =>
      key === "description" ? t("auditLogs.detailDescription") : t(`auditLogs.${key}`),
    [t]
  );

  const handleExport = useCallback(async () => {
    const selectedKeys = EXPORT_COLUMN_KEYS.filter((k) => exportColumns[k]);
    if (selectedKeys.length === 0) return;

    setExporting(true);
    try {
      const allItems = await fetchAllLogsForExport();
      const exportRows: AuditLogRow[] = allItems.map((e) => auditEntryToRow(e));

      const headers = selectedKeys.map((k) => getColumnLabel(k));
      const rowsForExport = exportRows.map((entry) =>
        selectedKeys.map((key) => {
          if (key === "user") return userLabel(entry.user);
          if (key === "action") return actionLabel(entry.action);
          if (key === "resource") return resourceLabel(entry.resource);
          if (key === "description") return descriptionLabel(entry);
          if (key === "time") return formatDateTime(entry.date, entry.time);
          return "";
        })
      );

      if (exportFormat === "excel") {
        const escapeCsv = (v: string) => {
          const s = String(v);
          if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        };
        const csvContent = [headers.map(escapeCsv).join(","), ...rowsForExport.map((r) => r.map(escapeCsv).join(","))].join("\r\n");
        const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
        const filename = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        await saveFile(blob, filename);
      } else {
        await exportPdf({
          title: t("nav.auditLogs"),
          description: t("auditLogs.pageDescription"),
          logoUrl: logoUrl || undefined,
          origin: typeof window !== "undefined" ? window.location.origin : "",
          headers,
          rows: rowsForExport,
          filename: `audit-logs-${new Date().toISOString().slice(0, 10)}`,
          locale: i18n.language === "ar" ? "ar" : "en",
        });
      }
      closeExportModal();
    } catch {
      // Keep modal open on error so user can retry
    } finally {
      setExporting(false);
    }
  }, [exportFormat, exportColumns, fetchAllLogsForExport, resourceLabel, actionLabel, userLabel, descriptionLabel, getColumnLabel, closeExportModal, logoUrl, t, i18n]);

  const hasSelectedColumns = EXPORT_COLUMN_KEYS.some((k) => exportColumns[k]);

  return (
    <DashboardLayout title={t("nav.auditLogs")}>
      <div className="w-full max-w-none">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0 leading-relaxed max-w-2xl">
            {t("auditLogs.pageDescription")}
          </p>
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl text-sm font-medium text-white bg-fms-accent hover:bg-fms-accent-hover border border-transparent focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 transition-colors shrink-0"
            aria-label={t("auditLogs.export")}
          >
            <IconDownload className="w-4 h-4 shrink-0" aria-hidden />
            {t("auditLogs.export")}
          </button>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
          <div className="border-b border-fms-border px-4 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="relative min-w-[200px] flex-1 max-w-md">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fms-text-tertiary pointer-events-none">
                  <IconSearch className="w-4 h-4" />
                </span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={t("auditLogs.searchPlaceholder")}
                  className="w-full pl-9 pr-3 py-2 rounded-2xl border border-fms-border bg-fms-surface text-fms-text text-sm placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                  aria-label={t("auditLogs.searchPlaceholder")}
                />
              </div>
              <div className="flex flex-col gap-1.5 min-w-[140px] shrink-0">
                <label className="text-sm font-medium text-fms-text-secondary whitespace-nowrap">
                  {t("auditLogs.addFilter")}
                </label>
                <Select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value as "" | "date" | "resource";
                    if (v) addVisibleFilter(v);
                  }}
                  selectSize="sm"
                  className="w-full min-w-[140px]"
                  aria-label={t("auditLogs.addFilter")}
                >
                  <option value="">—</option>
                  {!visibleFilters.has("date") && (
                    <option value="date">{t("auditLogs.filterDateRange")}</option>
                  )}
                  {!visibleFilters.has("resource") && (
                    <option value="resource">{t("auditLogs.filterByResource")}</option>
                  )}
                </Select>
              </div>
              {visibleFilters.has("date") && (
                <div className="flex items-end gap-2 flex-wrap shrink-0">
                  <div className="flex flex-col gap-1.5 min-w-[120px]">
                    <label className="text-sm font-medium text-fms-text-secondary whitespace-nowrap">
                      {t("auditLogs.dateFrom")}
                    </label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => handleDateFromChange(e.target.value)}
                      className="rounded-2xl border border-fms-border bg-fms-surface px-2.5 py-2 text-sm text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent-muted w-full"
                      aria-label={t("auditLogs.dateFrom")}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 min-w-[120px]">
                    <label className="text-sm font-medium text-fms-text-secondary whitespace-nowrap">
                      {t("auditLogs.dateTo")}
                    </label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => handleDateToChange(e.target.value)}
                      className="rounded-2xl border border-fms-border bg-fms-surface px-2.5 py-2 text-sm text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent-muted w-full"
                      aria-label={t("auditLogs.dateTo")}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeVisibleFilter("date")}
                    className="mb-0.5 p-1.5 rounded-lg text-fms-text-tertiary hover:text-fms-text hover:bg-fms-bg-subtle focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                    aria-label={`${t("auditLogs.removeFilter")}: ${t("auditLogs.filterDateRange")}`}
                    title={t("auditLogs.removeFilter")}
                  >
                    <span className="text-lg leading-none" aria-hidden>×</span>
                  </button>
                </div>
              )}
              {visibleFilters.has("resource") && (
                <div className="flex items-end gap-2 shrink-0">
                  <div className="flex flex-col gap-1.5 min-w-[140px]">
                    <label className="text-sm font-medium text-fms-text-secondary whitespace-nowrap">
                      {t("auditLogs.filterByResource")}
                    </label>
                    <Select
                      value={resourceFilter}
                      onChange={(e) => handleResourceFilterChange(e.target.value)}
                      selectSize="sm"
                      className="w-full min-w-[140px]"
                    >
                      <option value="all">{t("auditLogs.filterAll")}</option>
                      {AUDIT_RESOURCE_KEYS.map((res) => (
                        <option key={res} value={res}>
                          {resourceLabel(res)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeVisibleFilter("resource")}
                    className="mb-0.5 p-1.5 rounded-lg text-fms-text-tertiary hover:text-fms-text hover:bg-fms-bg-subtle focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                    aria-label={`${t("auditLogs.removeFilter")}: ${t("auditLogs.filterByResource")}`}
                    title={t("auditLogs.removeFilter")}
                  >
                    <span className="text-lg leading-none" aria-hidden>×</span>
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={handleResetFilters}
                disabled={!hasActiveFilters}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl text-sm font-medium border border-fms-border text-fms-text-secondary bg-fms-surface hover:bg-fms-bg-subtle focus:outline-none focus:ring-2 focus:ring-fms-accent-muted transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0"
                aria-label={t("auditLogs.resetFilters")}
              >
                {t("auditLogs.resetFilters")}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={4} showCheckbox={false} />
            ) : logs.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">
                  {t("auditLogs.emptyTitle")}
                </p>
                <p className="text-sm text-fms-text-tertiary max-w-sm mx-auto">
                  {t("auditLogs.emptyDesc")}
                </p>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">
                {t("auditLogs.noResults")}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("auditLogs.user")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("auditLogs.action")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("auditLogs.resource")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("auditLogs.detailDescription")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("auditLogs.time")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
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
                      <td className="py-3.5 px-4 font-medium text-fms-text">{userLabel(row.user)}</td>
                      <td className="py-3.5 px-4">
                        <Badge variant={getActionBadgeVariant(row.action)}>
                          {actionLabel(row.action)}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{resourceLabel(row.resource)}</td>
                      <td
                        className="py-3.5 px-4 text-fms-text-secondary max-w-48 sm:max-w-64 truncate"
                        title={descriptionLabel(row)}
                      >
                        {descriptionLabel(row)}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums whitespace-nowrap">
                        {formatDateTime(row.date, row.time)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-sm text-fms-text-secondary">
                  {t("auditLogs.pageOf", { current: page, total: totalPages })}
                </span>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary">{t("auditLogs.rowsPerPage")}</label>
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
                  onClick={goPrev}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  <IconChevronLeft className="w-4 h-4" />
                  {t("auditLogs.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("auditLogs.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Detail modal */}
        {detailLog && (
          <div
            className={detailStyles.overlay}
            data-closing={detailClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeDetailModal()}
          >
            <div
              className={detailStyles.modal}
              data-closing={detailClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={detailStyles.header}>
                <h2 id="audit-detail-modal-title" className={detailStyles.title}>
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

        {exportModalOpen && (
          <div
            className={styles.overlay}
            data-closing={exportClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-export-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeExportModal()}
          >
            <div
              className={styles.modal}
              data-closing={exportClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalWrapper}>
                <button
                  type="button"
                  className={styles.closeIcon}
                  onClick={closeExportModal}
                  aria-label={t("auditLogs.close")}
                >
                  ×
                </button>
                <h2 id="audit-export-modal-title" className={styles.title}>
                  {t("auditLogs.exportModalTitle")}
                </h2>
                <div className={styles.section}>
                  <span className={styles.sectionLabel}>{t("auditLogs.exportFormat")}</span>
                  <div className={styles.formatOptions}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === "pdf"}
                      data-selected={exportFormat === "pdf" ? "true" : undefined}
                      className={styles.formatOption}
                      onClick={() => setExportFormat("pdf")}
                    >
                      <span aria-hidden>{t("auditLogs.exportPdf")}</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === "excel"}
                      data-selected={exportFormat === "excel" ? "true" : undefined}
                      className={styles.formatOption}
                      onClick={() => setExportFormat("excel")}
                    >
                      <span aria-hidden>{t("auditLogs.exportExcel")}</span>
                    </button>
                  </div>
                </div>
                <div className={styles.section}>
                  <span className={styles.sectionLabel}>{t("auditLogs.exportColumns")}</span>
                  <p className={styles.sectionHint}>{t("auditLogs.exportColumnsHint")}</p>
                  <div className={styles.checkboxGroup}>
                    {EXPORT_COLUMN_KEYS.map((key) => {
                      const inputId = `audit-logs-export-column-${key}`;
                      return (
                        <label key={key} className={styles.checkboxRow} htmlFor={inputId}>
                          <input
                            id={inputId}
                            type="checkbox"
                            className={styles.checkbox}
                            checked={exportColumns[key]}
                            onChange={(e) =>
                              setExportColumns((prev) => ({
                                ...prev,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                          <span className={styles.checkboxLabel}>{getColumnLabel(key)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.closeBtn}
                    onClick={closeExportModal}
                    disabled={exporting}
                  >
                    {t("auditLogs.close")}
                  </button>
                  <button
                    type="button"
                    className={styles.exportBtn}
                    disabled={!hasSelectedColumns || exporting}
                    onClick={handleExport}
                  >
                    {exporting ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <span
                          className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0"
                          aria-hidden
                        />
                        {t("auditLogs.exporting")}
                      </span>
                    ) : (
                      t("auditLogs.exportButton")
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
