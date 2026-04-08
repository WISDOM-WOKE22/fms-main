"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useTauriPush } from "@/core/tauri/useTauriPush";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft, IconChevronRight, IconSearch, IconPlus } from "@/core/layout/icons";
import { Badge, Select } from "@/core/ui";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import type { ShiftRow } from "@/modules/shifts/types";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];

function formatWorkingDays(days: string[] | null, scheduleType: string): string {
  if (scheduleType === "24_7" || !days || days.length === 0) return "\u2014";
  if (days.length === 7) return "Every day";
  const ordered = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const sorted = ordered.filter((d) => days.includes(d));
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  if (sorted.length === 5 && weekdays.every((d) => sorted.includes(d))) return "Mon\u2013Fri";
  const labels: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return sorted.map((d) => labels[d]).join(", ");
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function matchesSearch(row: ShiftRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    (row.personType ?? "").toLowerCase().includes(q) ||
    (row.createdBy ?? "").toLowerCase().includes(q)
  );
}

function resolveBreakBadge(s: {
  breakBadge?: "Yes" | "No" | "—";
  breakEnabled?: boolean;
  breakTime?: unknown;
  breakStartTime?: unknown;
  breakEndTime?: unknown;
}): ShiftRow["breakBadge"] {
  if (s.breakBadge === "Yes" || s.breakBadge === "No") return s.breakBadge;
  if (s.breakEnabled === true) return "Yes";
  if (String(s.breakStartTime ?? "").trim() && String(s.breakEndTime ?? "").trim()) return "Yes";
  const bt = String(s.breakTime ?? "").trim();
  if (bt && bt !== "0") return "Yes";
  if (s.breakEnabled === false || bt === "0") return "No";
  return "—";
}

export default function ShiftsPage() {
  const { t } = useTranslation();
  const push = useTauriPush();
  const [loading, setLoading] = useState(true);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteModal, setDeleteModal] = useState<{ id: string; name: string } | null>(null);
  const [blockModal, setBlockModal] = useState<{ name: string; count: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchShifts = useCallback(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      apiFetch("/api/v1/schedules").then((res) => res.json()) as Promise<Record<string, unknown>[]>,
      apiFetch("/api/v1/person-types").then((res) => res.json()).catch(() => []) as Promise<{ id: string; name: string }[]>,
    ])
      .then(([data, personTypes]) => {
        if (!mounted || !Array.isArray(data)) return;
        const personTypeNameById = new Map<string, string>(
          (personTypes ?? []).map((pt) => [pt.id, pt.name ?? ""])
        );
        setShifts(
          data.map((s: Record<string, unknown>) => {
            const apiPersonType = String(s.personType ?? "").trim();
            const personTypeId = String(s.personTypeId ?? "");
            const resolvedPersonType = apiPersonType || personTypeNameById.get(personTypeId) || "";
            return {
            id: String(s.id ?? ""),
            name: String(s.name ?? ""),
            scheduleType: (s.scheduleType === "24_7" ? "24_7" : "standard") as ShiftRow["scheduleType"],
            personTypeId,
            personType: resolvedPersonType,
            assignedEmployees: Number(s.assignedEmployees ?? 0),
            createdBy: String(s.createdBy ?? ""),
            createdAt: String(s.createdAt ?? ""),
            status: (s.status === "active" || s.status === "inactive" ? s.status : "active") as ShiftRow["status"],
            isActive: Boolean(s.isActive ?? true),
            breakBadge: resolveBreakBadge(s),
            breakTime: s.breakTime != null ? String(s.breakTime) : null,
            startTime: s.startTime != null ? String(s.startTime) : null,
            endTime: s.endTime != null ? String(s.endTime) : null,
            gracePeriodEnabled: Boolean(s.gracePeriodEnabled ?? false),
            gracePeriodMinutes: s.gracePeriodMinutes != null ? Number(s.gracePeriodMinutes) : null,
            breakEnabled: Boolean(s.breakEnabled ?? false),
            breakStartTime: s.breakStartTime != null ? String(s.breakStartTime) : null,
            breakEndTime: s.breakEndTime != null ? String(s.breakEndTime) : null,
            breakGracePeriodMinutes: s.breakGracePeriodMinutes != null ? Number(s.breakGracePeriodMinutes) : null,
            overtimeEnabled: Boolean(s.overtimeEnabled ?? false),
            overtimeThresholdMinutes: s.overtimeThresholdMinutes != null ? Number(s.overtimeThresholdMinutes) : null,
            workingDays: Array.isArray(s.workingDays) ? (s.workingDays as string[]) : null,
            description: s.description != null ? String(s.description) : null,
          };
          })
        );
      })
      .catch(() => {
        if (mounted) setShifts([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const cleanup = fetchShifts();
    return cleanup;
  }, [fetchShifts]);

  useEffect(() => {
    const onFocus = () => fetchShifts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchShifts]);

  const filteredShifts = useMemo(
    () => shifts.filter((s) => matchesSearch(s, searchQuery)),
    [shifts, searchQuery]
  );

  const totalPages = Math.max(1, Math.ceil(filteredShifts.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedRows = useMemo(
    () => filteredShifts.slice(start, start + rowsPerPage),
    [filteredShifts, start, rowsPerPage]
  );

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));

  const handleConfirmDelete = async () => {
    if (!deleteModal) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/v1/schedules/${deleteModal.id}`, { method: "DELETE" });
      if (res.ok) {
        setShifts((prev) => prev.filter((r) => r.id !== deleteModal.id));
        setDeleteModal(null);
      } else {
        const err = await res.json().catch(() => ({}));
        if (String(err?.message ?? "").includes("assigned"))
          setBlockModal({ name: deleteModal.name, count: shifts.find((r) => r.id === deleteModal.id)?.assignedEmployees ?? 0 });
        setDeleteModal(null);
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DashboardLayout title={t("nav.shifts")}>
      <div className="w-full max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("shifts.pageDescription")}</p>
          <Link
            href="/shifts/new"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
            aria-label={t("shifts.createShift")}
          >
            <IconPlus className="w-5 h-5" aria-hidden />
            {t("shifts.createShift")}
          </Link>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 border-b border-fms-border">
            <div className="relative flex-1 max-w-sm">
              <IconSearch
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fms-text-tertiary pointer-events-none"
                aria-hidden
              />
              <input
                type="search"
                placeholder={t("shifts.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="w-full pl-9 pr-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                aria-label={t("shifts.searchPlaceholder")}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={8} showCheckbox={false} />
            ) : shifts.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">
                  {t("shifts.noSchedulesYet")}
                </p>
                <p className="text-sm text-fms-text-tertiary mb-6 max-w-sm mx-auto">
                  {t("shifts.noSchedulesSubtext")}
                </p>
                <Link
                  href="/shifts/new"
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                  aria-label={t("shifts.createShift")}
                >
                  <IconPlus className="w-5 h-5" aria-hidden />
                  {t("shifts.createShift")}
                </Link>
              </div>
            ) : paginatedRows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">
                {t("shifts.noResults")}
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.shiftName")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.personType")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.assignedEmployees")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.status")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.break")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.workingDays")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("shifts.createdAt")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left w-40">
                      {t("zones.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors"
                    >
                      <td className="py-3.5 px-4 font-medium text-fms-text">
                        <span className="inline-flex items-center gap-2">
                          {row.name}
                          {row.scheduleType === "24_7" && (
                            <Badge variant="blue" className="text-xs">
                              {t("shifts.badge24_7")}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{row.personType || "—"}</td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {row.assignedEmployees}
                      </td>
                      <td className="py-3.5 px-4">
                        <Badge variant={row.status === "active" ? "success" : "danger"}>
                          {row.status === "active" ? t("shifts.active") : t("shifts.inactive")}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">
                        {row.breakBadge === "Yes" ? (
                          <Badge variant="success">Yes</Badge>
                        ) : row.breakBadge === "No" ? (
                          <Badge variant="danger">No</Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">
                        {formatWorkingDays(row.workingDays, row.scheduleType)}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {formatDate(row.createdAt)}
                      </td>
                      <td className="py-3.5 px-4 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => push(`/shifts/${row.id}/edit`)}
                          className="inline-flex items-center px-3 py-1.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle transition-colors"
                        >
                          {t("shifts.edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (row.assignedEmployees > 0) setBlockModal({ name: row.name, count: row.assignedEmployees });
                            else setDeleteModal({ id: row.id, name: row.name });
                          }}
                          className="inline-flex items-center px-3 py-1.5 rounded-2xl text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                          {t("shifts.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filteredShifts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border bg-fms-bg-subtle/20">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">{t("shifts.rowsPerPage")}</label>
                  <Select
                    value={rowsPerPage}
                    onChange={(e) => {
                      setRowsPerPage(Number(e.target.value));
                      setPage(1);
                    }}
                    selectSize="sm"
                    className="min-w-[72px]"
                    aria-label={t("shifts.rowsPerPage")}
                  >
                    {ROWS_PER_PAGE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="text-sm text-fms-text-secondary">
                  {t("shifts.pageOf", { current: page, total: totalPages })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  <IconChevronLeft className="w-4 h-4" />
                  {t("shifts.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("shifts.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <div className="bg-fms-surface rounded-2xl shadow-xl max-w-md w-full p-6 border border-fms-border">
            <h2 id="delete-title" className="text-lg font-semibold text-fms-text mb-2">
              {t("shifts.deleteSchedule")}
            </h2>
            <p className="text-sm text-fms-text-secondary mb-6">
              {t("shifts.deleteConfirmMessage", { name: deleteModal.name })}
            </p>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setDeleteModal(null)} className="px-4 py-2 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle">
                {t("employees.cancel")}
              </button>
              <button type="button" onClick={handleConfirmDelete} disabled={deleting} className="px-4 py-2 rounded-2xl text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {deleting ? t("shifts.saving") : t("shifts.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {blockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true" aria-labelledby="block-title">
          <div className="bg-fms-surface rounded-2xl shadow-xl max-w-md w-full p-6 border border-fms-border">
            <h2 id="block-title" className="text-lg font-semibold text-fms-text mb-2">
              {t("shifts.cannotDelete")}
            </h2>
            <p className="text-sm text-fms-text-secondary mb-6">
              {t("shifts.cannotDeleteMessage", { count: blockModal.count })}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={() => setBlockModal(null)} className="px-4 py-2 rounded-2xl text-sm font-medium bg-fms-accent text-white hover:bg-fms-accent-hover">
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
