"use client";

import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useTauriPush } from "@/core/tauri/useTauriPush";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { toast } from "@/core/lib/toast";
import {
  IconUsers,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconPlus,
  IconEllipsisVertical,
} from "@/core/layout/icons";
import { KpiCard } from "@/modules/dashboard/components/KpiCard";
import { Badge, Select } from "@/core/ui";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import type { Employee, FaceEnrollmentDisplay } from "@/modules/employees/types";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];

type ActiveFilter = "all" | "active" | "inactive";
type RowActionKind = "send_link" | "view_person" | "edit_person";

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function matchesSearch(employee: Employee, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = (employee.name ?? "").toLowerCase();
  const zone = (employee.zone ?? "").toLowerCase();
  const shift = (employee.shift ?? (employee as { schedule?: string }).schedule ?? "").toLowerCase();
  const zoneNamesFromList = (employee.zones ?? [])
    .map((z) => ((z as { name?: string; zoneName?: string }).name ?? (z as { zoneName?: string }).zoneName ?? "").toLowerCase())
    .filter(Boolean)
    .join(" ");
  return (
    name.includes(q) ||
    zone.includes(q) ||
    shift.includes(q) ||
    zoneNamesFromList.includes(q)
  );
}

function mapEmployeeListItem(item: Record<string, unknown>): Employee {
  return {
    ...item,
    shift: (item.shift as string) ?? (item.schedule as string) ?? "",
    zone: (item.zone as string) ?? "",
    name: (item.name as string) ?? "",
    email: (item.email as string) ?? undefined,
    faceEnrollment: item.faceEnrollment as FaceEnrollmentDisplay | undefined,
    hasProfilePhoto: !!item.hasProfilePhoto,
    enrollmentExpiresAt: (item.enrollmentExpiresAt as string) ?? undefined,
  } as Employee;
}

export default function EmployeesPage() {
  const { t } = useTranslation();
  const push = useTauriPush();
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [actionsMenuId, setActionsMenuId] = useState<string | null>(null);
  const [statusDialogEmployee, setStatusDialogEmployee] = useState<Employee | null>(null);
  const [statusActionLoading, setStatusActionLoading] = useState(false);
  const [rowActionLoading, setRowActionLoading] = useState<{ id: string; action: RowActionKind } | null>(null);
  /** Portal menu panel (for click-outside). */
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  /** Ellipsis button for the open row — used for position + click-outside. */
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [menuCoords, setMenuCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch("/api/v1/employees")
      .then((res) => res.json())
      .then((data: unknown) => {
        if (!mounted || !Array.isArray(data)) return;
        setEmployees(data.map((item: Record<string, unknown>) => mapEmployeeListItem(item)));
      })
      .catch(() => {
        if (mounted) setEmployees([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!actionsMenuId) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (actionsMenuRef.current?.contains(t) || menuTriggerRef.current?.contains(t)) return;
      setActionsMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActionsMenuId(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [actionsMenuId]);

  const totalEmployees = employees.length;
  const activeEmployees = employees.filter((e) => e.isActive).length;
  const inactiveEmployees = employees.filter((e) => !e.isActive).length;

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (!matchesSearch(e, searchQuery)) return false;
      if (activeFilter === "active" && !e.isActive) return false;
      if (activeFilter === "inactive" && e.isActive) return false;
      return true;
    });
  }, [employees, searchQuery, activeFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedRows = useMemo(
    () => filteredEmployees.slice(start, start + rowsPerPage),
    [filteredEmployees, start, rowsPerPage]
  );

  const actionsMenuRow = useMemo(
    () => (actionsMenuId ? paginatedRows.find((r) => r.id === actionsMenuId) : undefined),
    [actionsMenuId, paginatedRows],
  );

  const updateActionsMenuPosition = useCallback(() => {
    if (!actionsMenuId) {
      setMenuCoords(null);
      return;
    }
    const el = menuTriggerRef.current;
    if (!el) {
      setMenuCoords(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setMenuCoords({
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [actionsMenuId]);

  useLayoutEffect(() => {
    if (!actionsMenuId) {
      setMenuCoords(null);
      return;
    }
    if (!paginatedRows.some((r) => r.id === actionsMenuId)) {
      setActionsMenuId(null);
      setMenuCoords(null);
      return;
    }
    updateActionsMenuPosition();
  }, [actionsMenuId, paginatedRows, updateActionsMenuPosition]);

  useEffect(() => {
    if (!actionsMenuId) return;
    const onScrollOrResize = () => updateActionsMenuPosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [actionsMenuId, updateActionsMenuPosition]);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setPage(1);
  };
  const handleActiveFilterChange = (value: ActiveFilter) => {
    setActiveFilter(value);
    setPage(1);
  };

  const allOnPageSelected =
    paginatedRows.length > 0 && paginatedRows.every((e) => selectedIds.has(e.id));
  const someSelected = selectedIds.size > 0;

  const toggleSelectAll = () => {
    if (allOnPageSelected) {
      const next = new Set(selectedIds);
      paginatedRows.forEach((e) => next.delete(e.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      paginatedRows.forEach((e) => next.add(e.id));
      setSelectedIds(next);
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));

  const refreshEmployees = () => {
    apiFetch("/api/v1/employees")
      .then((res) => res.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) return;
        setEmployees(data.map((item: Record<string, unknown>) => mapEmployeeListItem(item)));
      })
      .catch(() => {});
  };

  const isActionBusy = (rowId: string, action: RowActionKind) =>
    rowActionLoading?.id === rowId && rowActionLoading?.action === action;

  const openPersonPage = (row: Employee, mode: "view" | "edit") => {
    setActionsMenuId(null);
    setRowActionLoading({ id: row.id, action: mode === "edit" ? "edit_person" : "view_person" });
    if (mode === "edit") {
      toast.info(t("employees.toastOpeningEditPerson", { name: row.name }));
      push(`/employees/${row.id}?mode=edit`);
    } else {
      toast.info(t("employees.toastOpeningViewPerson", { name: row.name }));
      push(`/employees/${row.id}`);
    }
    // Keep spinner visible briefly to communicate action.
    window.setTimeout(() => setRowActionLoading((prev) => (prev?.id === row.id ? null : prev)), 500);
  };

  const sendEnrollmentLinkForRow = async (row: Employee) => {
    if (!row.email?.trim()) {
      toast.error(t("employees.toastEnrollmentLinkNoEmail"));
      return;
    }
    setRowActionLoading({ id: row.id, action: "send_link" });
    try {
      const res = await apiFetch(`/api/v1/employees/${row.id}/face-enrollment/send`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; token?: string };
      if (!res.ok) {
        toast.error(data.error ?? data.message ?? t("employees.toastEnrollmentLinkFailed"));
        return;
      }
      if (data.token && typeof window !== "undefined") {
        const url = `${window.location.origin}/enroll/${data.token}`;
        try {
          await navigator.clipboard.writeText(url);
          toast.success(t("employees.toastEnrollmentLinkSentCopied", { name: row.name }));
        } catch {
          toast.success(t("employees.toastEnrollmentLinkSentNoClipboard", { url }));
        }
      } else {
        toast.success(t("employees.toastEnrollmentLinkSentGeneric", { name: row.name }));
      }
      refreshEmployees();
    } catch {
      toast.error(t("employees.toastEnrollmentLinkNetworkError"));
    } finally {
      setRowActionLoading((prev) => (prev?.id === row.id ? null : prev));
    }
  };

  const confirmStatusToggle = async () => {
    if (!statusDialogEmployee) return;
    setStatusActionLoading(true);
    try {
      const nextActive = !statusDialogEmployee.isActive;
      const res = await apiFetch(`/api/v1/employees/${statusDialogEmployee.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!res.ok) throw new Error("update failed");
      toast.success(nextActive ? t("toast.employeeActivated") : t("toast.employeeDeactivated"));
      setStatusDialogEmployee(null);
      refreshEmployees();
    } catch {
      toast.error(t("toast.employeeStatusError"));
    } finally {
      setStatusActionLoading(false);
    }
  };

  const faceEnrollmentLabel = (fe?: FaceEnrollmentDisplay) => {
    switch (fe) {
      case "link_sent":
        return t("employees.faceEnrollmentLinkSent");
      case "enrolled":
        return t("employees.faceEnrollmentEnrolled");
      case "expired":
        return t("employees.faceEnrollmentExpired");
      default:
        return t("employees.faceEnrollmentNotEnrolled");
    }
  };

  const faceEnrollmentBadgeVariant = (fe?: FaceEnrollmentDisplay): "success" | "warning" | "danger" | "neutral" => {
    if (fe === "enrolled") return "success";
    if (fe === "link_sent") return "warning";
    if (fe === "expired") return "danger";
    return "neutral";
  };

  return (
    <DashboardLayout title={t("nav.employees")}>
      <div className="w-full max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("employees.title")}</p>
          <Link
            href="/employees/new"
            className="add-employee-btn inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
            aria-label={t("employees.addEmployee")}
          >
            <IconPlus className="w-5 h-5" aria-hidden />
            {t("employees.addEmployee")}
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <KpiCard
            title={t("employees.totalEmployees")}
            value={totalEmployees}
            icon={<IconUsers className="w-5 h-5" />}
          />
          <KpiCard
            title={t("employees.activeEmployees")}
            value={activeEmployees}
            icon={<IconUsers className="w-5 h-5" />}
          />
          <KpiCard
            title={t("employees.inactiveEmployees")}
            value={inactiveEmployees}
            icon={<IconUsers className="w-5 h-5" />}
          />
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
          <div className="border-b border-fms-border px-4 py-4 flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-4">
              <div className="flex-1 min-w-0 flex items-center gap-3">
                <div className="relative flex-1 min-w-0 max-w-md">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fms-text-tertiary pointer-events-none">
                    <IconSearch className="w-4 h-4" />
                  </span>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    placeholder={t("employees.searchPlaceholder")}
                    className="w-full pl-9 pr-3 py-2 rounded-2xl border border-fms-border bg-fms-surface text-fms-text text-sm placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                    aria-label={t("employees.searchPlaceholder")}
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">
                    {t("employees.filterByActive")}
                  </label>
                  <Select
                    value={activeFilter}
                    onChange={(e) => handleActiveFilterChange(e.target.value as ActiveFilter)}
                    selectSize="sm"
                    className="min-w-[100px]"
                  >
                    <option value="all">{t("employees.filterAll")}</option>
                    <option value="active">{t("employees.active")}</option>
                    <option value="inactive">{t("employees.inactive")}</option>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-fms-text-tertiary">
                  {someSelected ? t("employees.selectedCount", { count: selectedIds.size }) : "\u00A0"}
                </span>
              </div>
            </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={8} showCheckbox />
            ) : employees.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
                <div className="rounded-2xl bg-fms-bg-subtle p-6 mb-5 flex items-center justify-center w-16 h-16 text-fms-text-tertiary" aria-hidden>
                  <IconUsers className="w-10 h-10" />
                </div>
                <h3 className="text-lg font-semibold text-fms-text m-0 mb-2">
                  {t("employees.emptyTableTitle")}
                </h3>
                <p className="text-sm text-fms-text-secondary max-w-md m-0 mb-6">
                  {t("employees.emptyTableMessage")}
                </p>
                <Link
                  href="/employees/new"
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 focus:ring-offset-fms-bg"
                  aria-label={t("employees.emptyTableAction")}
                >
                  <IconPlus className="w-5 h-5" aria-hidden />
                  {t("employees.emptyTableAction")}
                </Link>
              </div>
            ) : paginatedRows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">
                {t("employees.noResults")}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="w-12 py-3 px-4 text-left">
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={toggleSelectAll}
                        aria-label={t("employees.selectAll")}
                        className="rounded border-fms-border text-fms-accent focus:ring-fms-accent-muted"
                      />
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.employeeName")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.zones")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.shift")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.status")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.active")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.faceEnrollment")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("employees.joinedDate")}
                    </th>
                    <th className="py-3 px-4 font-medium text-fms-text-tertiary text-right w-14">
                      <span className="sr-only">{t("employees.quickActions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row) => (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => push(`/employees/${row.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          push(`/employees/${row.id}`);
                        }
                      }}
                      className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors cursor-pointer"
                      aria-label={`${t("employees.viewProfile")} ${row.name}`}
                    >
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleSelect(row.id)}
                          aria-label={`Select ${row.name}`}
                          className="rounded border-fms-border text-fms-accent focus:ring-fms-accent-muted"
                        />
                      </td>
                      <td className="py-3 px-4 font-medium text-fms-text">{row.name}</td>
                      <td className="py-3 px-4 text-fms-text-secondary">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-fms-text-secondary">
                            {row.zones?.length
                              ? row.zones.map((zone) => zone.name).join(", ")
                              : row.zone}
                          </span>
                          {!!row.zones?.length && (
                            <span className="text-xs text-fms-text-tertiary">
                              {row.zones.map((z) => z.name).join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-fms-text-secondary">{row.shift ?? (row as { schedule?: string }).schedule ?? ""}</td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={row.status === "checked-in" ? "success" : "purple"}
                        >
                          {row.status === "checked-in"
                            ? t("employees.checkedIn")
                            : t("employees.checkedOut")}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={row.isActive ? "success" : "danger"}>
                          {row.isActive ? t("employees.active") : t("employees.inactive")}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={faceEnrollmentBadgeVariant(row.faceEnrollment)}>
                          {faceEnrollmentLabel(row.faceEnrollment)}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-fms-text-secondary tabular-nums">
                        {formatDate(row.joinedDate)}
                      </td>
                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex justify-end">
                          <button
                            ref={row.id === actionsMenuId ? menuTriggerRef : undefined}
                            type="button"
                            className="inline-flex items-center justify-center rounded-full p-2 text-fms-text-secondary hover:bg-fms-bg-subtle hover:text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent-muted disabled:opacity-50"
                            aria-expanded={actionsMenuId === row.id}
                            aria-haspopup="menu"
                            aria-label={t("employees.rowActionsMenuLabel", { name: row.name })}
                            disabled={!!rowActionLoading}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActionsMenuId((id) => (id === row.id ? null : row.id));
                            }}
                          >
                            {rowActionLoading?.id === row.id ? (
                              <span
                                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                                aria-hidden
                              />
                            ) : (
                              <IconEllipsisVertical className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filteredEmployees.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">{t("employees.rowsPerPage")}</label>
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
                <span className="text-sm text-fms-text-secondary">
                  {t("employees.pageOf", {
                    current: page,
                    total: totalPages,
                  })}
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
                  {t("employees.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("employees.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {typeof document !== "undefined" &&
        actionsMenuId &&
        actionsMenuRow &&
        menuCoords != null &&
        createPortal(
          <div
            ref={actionsMenuRef}
            role="menu"
            className="min-w-[12.5rem] rounded-2xl border border-fms-border bg-fms-surface py-1 shadow-xl"
            style={{
              position: "fixed",
              top: menuCoords.top,
              right: menuCoords.right,
              zIndex: 100000,
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!actionsMenuRow.email?.trim() || !!rowActionLoading}
              className="flex w-full px-4 py-2.5 text-left text-sm text-fms-text hover:bg-fms-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                void sendEnrollmentLinkForRow(actionsMenuRow);
              }}
            >
              {isActionBusy(actionsMenuRow.id, "send_link")
                ? t("employees.sendingEnrollmentLink")
                : t("employees.sendEnrollmentLink")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!!rowActionLoading}
              className="flex w-full px-4 py-2.5 text-left text-sm text-fms-text hover:bg-fms-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                openPersonPage(actionsMenuRow, "view");
              }}
            >
              {isActionBusy(actionsMenuRow.id, "view_person")
                ? t("employees.openingPerson")
                : t("employees.view")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!!rowActionLoading}
              className="flex w-full px-4 py-2.5 text-left text-sm text-fms-text hover:bg-fms-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                openPersonPage(actionsMenuRow, "edit");
              }}
            >
              {isActionBusy(actionsMenuRow.id, "edit_person")
                ? t("employees.openingEditPerson")
                : t("employees.editPerson")}
            </button>
            <div className="my-1 h-px bg-fms-border" role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={!!rowActionLoading}
              className="flex w-full px-4 py-2.5 text-left text-sm text-fms-text hover:bg-fms-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                setActionsMenuId(null);
                setStatusDialogEmployee(actionsMenuRow);
              }}
            >
              {actionsMenuRow.isActive ? t("employees.deactivateAccount") : t("employees.activateAccount")}
            </button>
          </div>,
          document.body,
        )}

      {statusDialogEmployee && (
        <div
          className="fixed inset-0 z-[100010] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="employee-status-dialog-title"
          aria-describedby="employee-status-dialog-desc"
          onClick={(e) => {
            if (e.target === e.currentTarget && !statusActionLoading) {
              setStatusDialogEmployee(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-fms-border bg-fms-surface p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="employee-status-dialog-title" className="m-0 mb-2 text-lg font-semibold text-fms-text">
              {statusDialogEmployee.isActive
                ? t("employees.confirmEmployeeDeactivateTitle", { name: statusDialogEmployee.name })
                : t("employees.confirmEmployeeActivateTitle", { name: statusDialogEmployee.name })}
            </h2>
            <p id="employee-status-dialog-desc" className="m-0 mb-6 text-sm leading-relaxed text-fms-text-secondary">
              {statusDialogEmployee.isActive
                ? t("employees.confirmEmployeeDeactivateMessage")
                : t("employees.confirmEmployeeActivateMessage")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded-2xl border border-fms-border px-4 py-2 text-sm font-medium text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50"
                disabled={statusActionLoading}
                onClick={() => setStatusDialogEmployee(null)}
              >
                {t("employees.cancel")}
              </button>
              <button
                type="button"
                className={`rounded-2xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                  statusDialogEmployee.isActive
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-fms-accent hover:bg-fms-accent-hover"
                }`}
                disabled={statusActionLoading}
                onClick={() => void confirmStatusToggle()}
              >
                {statusDialogEmployee.isActive
                  ? t("employees.deactivateAccount")
                  : t("employees.activateAccount")}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
