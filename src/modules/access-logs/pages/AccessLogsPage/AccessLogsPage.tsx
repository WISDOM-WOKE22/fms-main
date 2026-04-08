"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DashboardLayout } from "@/core/layout";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { useAppPreferences } from "@/core/contexts/AppPreferencesContext";
import { exportPdf } from "@/core/lib/exportPdf";
import { saveFile } from "@/core/lib/saveFile";
import { IconChevronLeft, IconChevronRight, IconDownload, IconSearch } from "@/core/layout/icons";
import { Badge, Select } from "@/core/ui";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import {
  fetchAccessLogs,
  fetchEmployeesForPeopleLog,
  fetchPersonTypesForPeopleLog,
  fetchShiftsForPeopleLog,
  fetchTimeConfigForPeopleLog,
  fetchZonesForFilter,
} from "@/modules/access-logs/api/accessLogs";
import type {
  AccessLogEntry,
  AccessLogActivityType,
  PeopleLogAttendanceStatus,
  PeopleLogBreakStatus,
  PeopleLogBreakValue,
} from "@/modules/access-logs/types";
import styles from "./ExportModal.module.css";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];

const ACTIVITY_TYPE_OPTIONS: AccessLogActivityType[] = ["check-in", "check-out", "tracking", "absent"];

const DAY_OF_WEEK_OPTIONS = [
  { value: "all", labelKey: "accessLogs.filterAll" },
  { value: "1", labelKey: "accessLogs.monday" },
  { value: "2", labelKey: "accessLogs.tuesday" },
  { value: "3", labelKey: "accessLogs.wednesday" },
  { value: "4", labelKey: "accessLogs.thursday" },
  { value: "5", labelKey: "accessLogs.friday" },
  { value: "6", labelKey: "accessLogs.saturday" },
  { value: "0", labelKey: "accessLogs.sunday" },
];

export type ExportFormat = "pdf" | "csv" | "excel";

export type ExportColumnKey =
  | "employeeName"
  | "personType"
  | "schedule"
  | "activityType"
  | "attendanceStatus"
  | "break"
  | "breakStatus"
  | "dateTime"
  | "location"
  | "zone";

const EXPORT_COLUMN_KEYS: ExportColumnKey[] = [
  "employeeName",
  "personType",
  "schedule",
  "activityType",
  "attendanceStatus",
  "break",
  "breakStatus",
  "dateTime",
  "location",
  "zone",
];

/** Format as "DD MMM YYYY, HH:MM AM/PM" (e.g. "2 Mar 2026, 09:45 AM"). */
function formatDateTime(date: string, time: string): string {
  const d = new Date(date + "T" + time);
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  const hour = d.getHours();
  const min = d.getMinutes();
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  const mm = min < 10 ? "0" + min : String(min);
  return `${day} ${month} ${year}, ${h12}:${mm} ${ampm}`;
}

function matchesSearch(entry: AccessLogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = (entry.employeeName ?? "").toLowerCase();
  const personType = (entry.personType ?? "").toLowerCase();
  const shift = (entry.shift ?? "").toLowerCase();
  const zone = (entry.zone ?? "").toLowerCase();
  const note = (entry.note ?? "").toLowerCase();
  return (
    name.includes(q) ||
    personType.includes(q) ||
    shift.includes(q) ||
    zone.includes(q) ||
    note.includes(q)
  );
}

function is247ShiftName(name: string | undefined | null): boolean {
  const n = (name ?? "").toLowerCase();
  return n.includes("24/7") || n.includes("24x7") || n.includes("24-7");
}

function compareTimeHHMM(a: string, b: string): number {
  const na = (a || "").trim();
  const nb = (b || "").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

function computeAttendanceStatus(
  activityType: AccessLogActivityType,
  time: string,
  timeConfig?: { checkInStart: string; checkInEnd: string; checkOutStart: string; checkOutEnd: string },
  is247?: boolean
): PeopleLogAttendanceStatus {
  if (is247) return "none";
  if (!timeConfig) return "none";
  if (activityType === "check-in") {
    return compareTimeHHMM(time, timeConfig.checkInEnd) <= 0 ? "on_time" : "late";
  }
  if (activityType === "check-out") {
    if (compareTimeHHMM(time, timeConfig.checkOutStart) < 0) return "early_leave";
    if (compareTimeHHMM(time, timeConfig.checkOutEnd) > 0) return "overtime";
    return "on_time";
  }
  return "none";
}

function computeBreakValue(
  is247?: boolean,
  shift?: {
    breakTime?: string | null;
    breakEnabled?: boolean;
    breakStartTime?: string | null;
    breakEndTime?: string | null;
  }
): PeopleLogBreakValue {
  if (is247) return "none";
  if (shift?.breakEnabled === true) return "yes";
  if ((shift?.breakStartTime ?? "").trim() && (shift?.breakEndTime ?? "").trim()) return "yes";
  const bt = (shift?.breakTime ?? "").trim();
  if (!bt || bt === "0") return "no";
  return "yes";
}

function computeBreakStatus(breakValue: PeopleLogBreakValue, is247?: boolean): PeopleLogBreakStatus {
  // Fallback only. When backend provides breakStatus we use it directly.
  if (is247 || breakValue !== "yes") return "none";
  return "on_time_for_break";
}

function ActivityBadge({ type }: { type: AccessLogActivityType }) {
  const { t } = useTranslation();
  if (type === "check-in") {
    return (
      <Badge variant="success">
        {t("accessLogs.activityCheckIn")}
      </Badge>
    );
  }
  if (type === "check-out") {
    return (
      <Badge variant="blue">
        {t("accessLogs.activityCheckOut")}
      </Badge>
    );
  }
  if (type === "absent") {
    return (
      <Badge variant="danger">
        {t("accessLogs.absent")}
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" className="bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/25">
      {t("accessLogs.activityTracking")}
    </Badge>
  );
}

function AttendanceStatusBadge({ status }: { status: PeopleLogAttendanceStatus }) {
  const { t } = useTranslation();
  if (status === "none") return <span className="text-fms-text-tertiary">—</span>;
  if (status === "on_time") return <Badge variant="success">{t("accessLogs.attOnTime")}</Badge>;
  if (status === "late") return <Badge variant="warning">{t("accessLogs.attLate")}</Badge>;
  if (status === "early_leave") return <Badge variant="warning">{t("accessLogs.attEarlyLeave")}</Badge>;
  if (status === "overtime") return <Badge variant="neutral">{t("accessLogs.attOvertime")}</Badge>;
  if (status === "absent") return <Badge variant="danger">{t("accessLogs.absent")}</Badge>;
  return <span className="text-fms-text-tertiary">—</span>;
}

function BreakBadge({ value }: { value: PeopleLogBreakValue }) {
  const { t } = useTranslation();
  if (value === "none") return <span className="text-fms-text-tertiary">—</span>;
  if (value === "yes") return <Badge variant="success">{t("accessLogs.breakYes")}</Badge>;
  if (value === "no") return <Badge variant="muted">{t("accessLogs.breakNo")}</Badge>;
  return <span className="text-fms-text-tertiary">—</span>;
}

function BreakStatusBadge({ status }: { status: PeopleLogBreakStatus }) {
  const { t } = useTranslation();
  if (status === "none") return <span className="text-fms-text-tertiary">—</span>;
  if (status === "on_time_for_break") return <Badge variant="success">{t("accessLogs.breakOnTimeForBreak")}</Badge>;
  if (status === "late_for_break") return <Badge variant="warning">{t("accessLogs.breakLateForBreak")}</Badge>;
  if (status === "returned_on_time") return <Badge variant="success">{t("accessLogs.breakReturnedOnTime")}</Badge>;
  if (status === "late_return") return <Badge variant="warning">{t("accessLogs.breakLateReturn")}</Badge>;
  return <span className="text-fms-text-tertiary">—</span>;
}

export default function AccessLogsPage() {
  const { t, i18n } = useTranslation();
  const { config } = useAppConfig();
  const { getLogoUrl } = useAppPreferences();
  const logoUrl = getLogoUrl(config.companyLogoUrl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<AccessLogEntry[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [dateFrom, setDateFrom] = useState<string>(todayIso);
  const [dateTo, setDateTo] = useState<string>(todayIso);

  const [personTypeFilter, setPersonTypeFilter] = useState<string>("all");
  const [scheduleFilter, setScheduleFilter] = useState<string>("all");
  const [eventFilter, setEventFilter] = useState<AccessLogActivityType | "all">("all");
  const [attendanceStatusFilter, setAttendanceStatusFilter] = useState<
    "all" | "on_time" | "late" | "early_leave" | "overtime" | "absent" | "none"
  >("all");
  const [breakFilter, setBreakFilter] = useState<"all" | "yes" | "no" | "none">("all");
  const [breakStatusFilter, setBreakStatusFilter] = useState<
    "all" | "on_time_for_break" | "late_for_break" | "returned_on_time" | "late_return" | "none"
  >("all");
  const [zoneFilter, setZoneFilter] = useState<string>("all");
  const [dayOfWeekFilter, setDayOfWeekFilter] = useState<string>("all");

  const [personTypeOptions, setPersonTypeOptions] = useState<{ id: string; name: string }[]>([]);
  const [scheduleOptions, setScheduleOptions] = useState<
    { id: string; name: string; breakTime?: string; breakEnabled?: boolean; breakStartTime?: string | null; breakEndTime?: string | null }[]
  >([]);
  const [timeConfig, setTimeConfig] = useState<
    { checkInStart: string; checkInEnd: string; checkOutStart: string; checkOutEnd: string } | undefined
  >(undefined);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [exportColumns, setExportColumns] = useState<Record<ExportColumnKey, boolean>>({
    employeeName: true,
    personType: true,
    schedule: true,
    activityType: true,
    attendanceStatus: true,
    break: true,
    breakStatus: true,
    dateTime: true,
    location: true,
    zone: true,
  });
  const [exportClosing, setExportClosing] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchAccessLogs({}),
      fetchEmployeesForPeopleLog(),
      fetchPersonTypesForPeopleLog(),
      fetchShiftsForPeopleLog(),
      fetchTimeConfigForPeopleLog().catch(() => undefined),
    ])
      .then(([data, employees, personTypes, shifts, tc]) => {
        if (!mounted) return;
        const employeesById = new Map<string, any>();
        employees.forEach((e) => employeesById.set(e.id, e));
        setPersonTypeOptions([{ id: "all", name: t("accessLogs.filterAll") }, ...personTypes]);
        setScheduleOptions([
          { id: "all", name: t("accessLogs.filterAll"), breakTime: "0", breakEnabled: false },
          ...shifts,
        ]);
        setTimeConfig(tc);
        const nextLogs = data.map((entry) => {
          const lookups = employeesById.get(entry.employeeId || "");
          const shiftName = ((entry as any).schedule as string) ?? (lookups?.shift as string) ?? "";
          const is247 = is247ShiftName(shiftName);
          const shiftConfig = shifts.find((s) => s.id === (lookups?.shiftId ?? ""));
          const attendanceStatus = computeAttendanceStatus(entry.activityType, entry.time, tc, is247);
          const apiBreakValue = (entry as any).breakValue as PeopleLogBreakValue | undefined;
          const apiBreakStatus = (entry as any).breakStatus as PeopleLogBreakStatus | undefined;
          const breakValue = apiBreakValue ?? computeBreakValue(is247, shiftConfig);
          const breakStatus = apiBreakStatus ?? computeBreakStatus(breakValue, is247);
          return {
            ...entry,
            personTypeId: lookups?.personTypeId ?? null,
            personType: lookups?.personType ?? "",
            shiftId: lookups?.shiftId ?? "",
            shift: shiftName,
            is247,
            attendanceStatus,
            breakValue,
            breakStatus,
          };
        });
        setLogs(nextLogs);
      })
      .catch(() => {
        if (!mounted) return;
        setError(t("accessLogs.loadError"));
        setLogs([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [t]);

  useEffect(() => {
    let mounted = true;
    fetchZonesForFilter()
      .then((names) => { if (mounted) setZones(names); })
      .catch(() => { if (mounted) setZones([]); });
    return () => { mounted = false; };
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (!matchesSearch(entry, searchQuery)) return false;
      if (dateFrom && (entry.date ?? "") < dateFrom) return false;
      if (dateTo && (entry.date ?? "") > dateTo) return false;
      if (personTypeFilter !== "all" && (entry.personTypeId || "") !== personTypeFilter) return false;
      if (scheduleFilter !== "all" && (entry.shiftId || "") !== scheduleFilter) return false;
      if (eventFilter !== "all" && entry.activityType !== eventFilter) return false;
      if (attendanceStatusFilter !== "all" && (entry.attendanceStatus || "none") !== attendanceStatusFilter) return false;
      if (breakFilter !== "all" && (entry.breakValue || "none") !== breakFilter) return false;
      if (breakStatusFilter !== "all" && (entry.breakStatus || "none") !== breakStatusFilter) return false;
      if (zoneFilter !== "all" && (entry.zone ?? "") !== zoneFilter) return false;
      if (dayOfWeekFilter !== "all" && entry.date) {
        const d = new Date(entry.date + "T00:00:00");
        if (String(d.getDay()) !== dayOfWeekFilter) return false;
      }
      return true;
    });
  }, [
    logs,
    searchQuery,
    dateFrom,
    dateTo,
    personTypeFilter,
    scheduleFilter,
    eventFilter,
    attendanceStatusFilter,
    breakFilter,
    breakStatusFilter,
    zoneFilter,
    dayOfWeekFilter,
  ]);

  const hasActiveFilters =
    searchQuery !== "" ||
    dateFrom !== "" ||
    dateTo !== "" ||
    personTypeFilter !== "all" ||
    scheduleFilter !== "all" ||
    eventFilter !== "all" ||
    attendanceStatusFilter !== "all" ||
    breakFilter !== "all" ||
    breakStatusFilter !== "all" ||
    zoneFilter !== "all" ||
    dayOfWeekFilter !== "all";

  const handleResetFilters = () => {
    setSearchQuery("");
    setDateFrom(todayIso);
    setDateTo(todayIso);
    setPersonTypeFilter("all");
    setScheduleFilter("all");
    setEventFilter("all");
    setAttendanceStatusFilter("all");
    setBreakFilter("all");
    setBreakStatusFilter("all");
    setZoneFilter("all");
    setDayOfWeekFilter("all");
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedLogs = useMemo(
    () => filteredLogs.slice(start, start + rowsPerPage),
    [filteredLogs, start, rowsPerPage]
  );

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setPage(1);
  };
  const handleEventFilterChange = (value: AccessLogActivityType | "all") => {
    setEventFilter(value);
    setPage(1);
  };
  const handleZoneFilterChange = (value: string) => {
    setZoneFilter(value);
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

  const closeExportModal = useCallback(() => {
    setExportClosing(true);
    const t = setTimeout(() => {
      setExportModalOpen(false);
      setExportClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const activityTypeLabel = useCallback(
    (type: AccessLogActivityType) => {
      if (type === "check-in") return t("accessLogs.activityCheckIn");
      if (type === "check-out") return t("accessLogs.activityCheckOut");
      if (type === "absent") return t("accessLogs.absent");
      return t("accessLogs.activityTracking");
    },
    [t]
  );

  const getColumnLabel = useCallback(
    (key: ExportColumnKey) => {
      return t(`accessLogs.${key}`);
    },
    [t]
  );

  const handleExport = useCallback(async () => {
    const selectedKeys = EXPORT_COLUMN_KEYS.filter((k) => exportColumns[k]);
    if (selectedKeys.length === 0) return;

    const headers = selectedKeys.map((k) => getColumnLabel(k));
    const attendanceLabel = (s: PeopleLogAttendanceStatus) => {
      if (s === "none") return "—";
      const k: Record<Exclude<PeopleLogAttendanceStatus, "none">, string> = {
        on_time: "attOnTime",
        late: "attLate",
        early_leave: "attEarlyLeave",
        overtime: "attOvertime",
        absent: "absent",
      };
      return t(`accessLogs.${k[s]}`);
    };
    const breakStatusLabel = (s: PeopleLogBreakStatus) => {
      if (s === "none") return "—";
      const k: Record<Exclude<PeopleLogBreakStatus, "none">, string> = {
        on_time_for_break: "breakOnTimeForBreak",
        late_for_break: "breakLateForBreak",
        returned_on_time: "breakReturnedOnTime",
        late_return: "breakLateReturn",
      };
      return t(`accessLogs.${k[s]}`);
    };
    const rowsForExport = filteredLogs.map((entry) =>
      selectedKeys.map((key) => {
        if (key === "employeeName") return entry.employeeName;
        if (key === "personType") return entry.personType || "—";
        if (key === "schedule") return entry.shift ? (entry.is247 ? `${entry.shift} (24/7)` : entry.shift) : "—";
        if (key === "activityType") return activityTypeLabel(entry.activityType);
        if (key === "attendanceStatus") return attendanceLabel(entry.attendanceStatus ?? "none");
        if (key === "break")
          return entry.breakValue === "none" ? "—" : entry.breakValue === "yes" ? t("accessLogs.breakYes") : t("accessLogs.breakNo");
        if (key === "breakStatus") return breakStatusLabel(entry.breakStatus ?? "none");
        if (key === "dateTime") return formatDateTime(entry.date, entry.time);
        if (key === "location") return entry.zone;
        if (key === "zone") return entry.zone;
        return "";
      })
    );

    if (exportFormat === "csv" || exportFormat === "excel") {
      const escapeCsv = (v: string) => {
        const s = String(v);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const csvContent = [headers.map(escapeCsv).join(","), ...rowsForExport.map((r) => r.map(escapeCsv).join(","))].join("\r\n");
      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
      const today = new Date().toISOString().slice(0, 10);
      const rangeLabel =
        dateFrom && dateTo
          ? `${dateFrom}_to_${dateTo}`
          : dateFrom
          ? `${dateFrom}_to_${today}`
          : dateTo
          ? `until_${dateTo}`
          : today;
      const ext = exportFormat === "excel" ? "xlsx" : "csv";
      const filename = `people_log_${rangeLabel}.${ext}`;
      await saveFile(blob, filename);
    } else {
      try {
        await exportPdf({
          title: t("nav.accessLogs"),
          description: t("accessLogs.pageDescription"),
          logoUrl: logoUrl || undefined,
          origin: typeof window !== "undefined" ? window.location.origin : "",
          headers,
          rows: rowsForExport,
          filename: `people_log_${new Date().toISOString().slice(0, 10)}`,
          locale: i18n.language === "ar" ? "ar" : "en",
        });
      } catch {
        // PDF generation failed; modal still closes below
      }
    }
    closeExportModal();
  }, [exportFormat, exportColumns, filteredLogs, getColumnLabel, activityTypeLabel, closeExportModal, logoUrl, t, i18n]);

  const hasSelectedColumns = EXPORT_COLUMN_KEYS.some((k) => exportColumns[k]);

  return (
    <DashboardLayout title={t("nav.accessLogs")}>
      <div className="w-full max-w-none">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">
            {t("accessLogs.pageDescription")}
          </p>
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl text-sm font-medium text-white bg-fms-accent hover:bg-fms-accent-hover border border-transparent focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 transition-colors shrink-0"
            aria-label={t("accessLogs.export")}
          >
            <IconDownload className="w-4 h-4 shrink-0" aria-hidden />
            {t("accessLogs.export")}
          </button>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
          <div className="border-b border-fms-border px-4 py-4">
            <div className="flex flex-col gap-3">
              <div className="relative min-w-[200px] flex-1 max-w-md">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fms-text-tertiary pointer-events-none">
                  <IconSearch className="w-4 h-4" />
                </span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={t("accessLogs.searchPlaceholder")}
                  className="w-full pl-9 pr-3 py-2 rounded-2xl border border-fms-border bg-fms-surface text-fms-text text-sm placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                  aria-label={t("accessLogs.searchPlaceholder")}
                />
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5 min-w-[180px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByPersonType")}</label>
                  <Select
                    value={personTypeFilter}
                    onChange={(e) => { setPersonTypeFilter(e.target.value); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[180px]"
                  >
                    {personTypeOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.name}</option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[180px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterBySchedule")}</label>
                  <Select
                    value={scheduleFilter}
                    onChange={(e) => { setScheduleFilter(e.target.value); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[180px]"
                  >
                    {scheduleOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.name}</option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[160px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByEvent")}</label>
                  <Select
                    value={eventFilter}
                    onChange={(e) => handleEventFilterChange(e.target.value as AccessLogActivityType | "all")}
                    selectSize="sm"
                    className="w-full min-w-[160px]"
                  >
                    <option value="all">{t("accessLogs.filterAll")}</option>
                    <option value="check-in">{t("accessLogs.activityCheckIn")}</option>
                    <option value="check-out">{t("accessLogs.activityCheckOut")}</option>
                    <option value="tracking">{t("accessLogs.activityTracking")}</option>
                    <option value="absent">{t("accessLogs.absent")}</option>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[180px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByAttendanceStatus")}</label>
                  <Select
                    value={attendanceStatusFilter}
                    onChange={(e) => { setAttendanceStatusFilter(e.target.value as typeof attendanceStatusFilter); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[180px]"
                  >
                    <option value="all">{t("accessLogs.filterAll")}</option>
                    <option value="on_time">{t("accessLogs.attOnTime")}</option>
                    <option value="late">{t("accessLogs.attLate")}</option>
                    <option value="early_leave">{t("accessLogs.attEarlyLeave")}</option>
                    <option value="overtime">{t("accessLogs.attOvertime")}</option>
                    <option value="absent">{t("accessLogs.absent")}</option>
                    <option value="none">—</option>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[140px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByBreak")}</label>
                  <Select
                    value={breakFilter}
                    onChange={(e) => { setBreakFilter(e.target.value as typeof breakFilter); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[140px]"
                  >
                    <option value="all">{t("accessLogs.filterAll")}</option>
                    <option value="yes">{t("accessLogs.breakYes")}</option>
                    <option value="no">{t("accessLogs.breakNo")}</option>
                    <option value="none">—</option>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[200px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByBreakStatus")}</label>
                  <Select
                    value={breakStatusFilter}
                    onChange={(e) => { setBreakStatusFilter(e.target.value as typeof breakStatusFilter); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[200px]"
                  >
                    <option value="all">{t("accessLogs.filterAll")}</option>
                    <option value="on_time_for_break">{t("accessLogs.breakOnTimeForBreak")}</option>
                    <option value="late_for_break">{t("accessLogs.breakLateForBreak")}</option>
                    <option value="returned_on_time">{t("accessLogs.breakReturnedOnTime")}</option>
                    <option value="late_return">{t("accessLogs.breakLateReturn")}</option>
                    <option value="none">—</option>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[140px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.filterByZone")}</label>
                  <Select
                    value={zoneFilter}
                    onChange={(e) => { setZoneFilter(e.target.value); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[140px]"
                  >
                    <option value="all">{t("accessLogs.filterAll")}</option>
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 min-w-[160px]">
                  <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.dayOfWeek")}</label>
                  <Select
                    value={dayOfWeekFilter}
                    onChange={(e) => { setDayOfWeekFilter(e.target.value); setPage(1); }}
                    selectSize="sm"
                    className="w-full min-w-[160px]"
                  >
                    {DAY_OF_WEEK_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                    ))}
                  </Select>
                </div>

                <div className="flex items-end gap-2 flex-wrap">
                  <div className="flex flex-col gap-1.5 min-w-[150px]">
                    <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.dateFrom")}</label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => handleDateFromChange(e.target.value)}
                      className="rounded-2xl border border-fms-border bg-fms-surface px-2.5 py-2 text-sm text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent-muted w-full"
                      aria-label={t("accessLogs.dateFrom")}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 min-w-[150px]">
                    <label className="text-sm font-medium text-fms-text-secondary">{t("accessLogs.dateTo")}</label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => handleDateToChange(e.target.value)}
                      className="rounded-2xl border border-fms-border bg-fms-surface px-2.5 py-2 text-sm text-fms-text focus:outline-none focus:ring-2 focus:ring-fms-accent-muted w-full"
                      aria-label={t("accessLogs.dateTo")}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleResetFilters}
                  disabled={!hasActiveFilters}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl text-sm font-medium border border-fms-border text-fms-text-secondary bg-fms-surface hover:bg-fms-bg-subtle focus:outline-none focus:ring-2 focus:ring-fms-accent-muted transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0"
                  aria-label={t("accessLogs.resetFilters")}
                >
                  {t("accessLogs.resetFilters")}
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={10} showCheckbox={false} />
            ) : error ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">{error}</p>
                <p className="text-sm text-fms-text-tertiary max-w-sm mx-auto">
                  {t("accessLogs.emptyDesc")}
                </p>
              </div>
            ) : logs.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">
                  {t("accessLogs.emptyTitle")}
                </p>
                <p className="text-sm text-fms-text-tertiary max-w-sm mx-auto">
                  {t("accessLogs.emptyDesc")}
                </p>
              </div>
            ) : paginatedLogs.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">
                {t("accessLogs.noResults")}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.employeeName")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.personType")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.schedule")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.event")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.attendanceStatus")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.break")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.breakStatus")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.dateTime")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.location")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("accessLogs.zone")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedLogs.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        {row.employeeId ? (
                          <Link
                            href={`/employees/${row.employeeId}`}
                            className="font-medium text-fms-text hover:text-fms-text cursor-pointer"
                          >
                            {row.employeeName}
                          </Link>
                        ) : (
                          <span className="font-medium text-fms-text">{row.employeeName}</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{row.personType || "—"}</td>
                      <td className="py-3.5 px-4">
                        <span className="text-fms-text-secondary">{row.shift || "—"}</span>
                        {row.is247 && (
                          <Badge variant="muted" className="ml-1.5">
                            24/7
                          </Badge>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <ActivityBadge type={row.activityType} />
                      </td>
                      <td className="py-3.5 px-4">
                        <AttendanceStatusBadge status={row.attendanceStatus ?? "none"} />
                      </td>
                      <td className="py-3.5 px-4">
                        <BreakBadge value={row.breakValue ?? "none"} />
                      </td>
                      <td className="py-3.5 px-4">
                        <BreakStatusBadge status={row.breakStatus ?? "none"} />
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums whitespace-nowrap">
                        {formatDateTime(row.date, row.time)}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{row.zone || "—"}</td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{row.zone || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filteredLogs.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-sm text-fms-text-secondary">
                  {t("accessLogs.pageOf", {
                    current: page,
                    total: totalPages,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary">{t("accessLogs.rowsPerPage")}</label>
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
                  {t("accessLogs.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("accessLogs.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>

        {exportModalOpen && (
          <div
            className={styles.overlay}
            data-closing={exportClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-modal-title"
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
                  aria-label={t("accessLogs.close")}
                >
                  ×
                </button>
                <h2 id="export-modal-title" className={styles.title}>
                  {t("accessLogs.exportModalTitle")}
                </h2>

                <div className={styles.section}>
                  <span className={styles.sectionLabel}>{t("accessLogs.exportFormat")}</span>
                  <div className={styles.formatOptions}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === "pdf"}
                      data-selected={exportFormat === "pdf" || undefined}
                      className={styles.formatOption}
                      onClick={() => setExportFormat("pdf")}
                    >
                      <span aria-hidden>{t("settings.formatPdf")}</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === "excel"}
                      data-selected={exportFormat === "excel" || undefined}
                      className={styles.formatOption}
                      onClick={() => setExportFormat("excel")}
                    >
                      <span aria-hidden>{t("settings.formatExcel")}</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === "csv"}
                      data-selected={exportFormat === "csv" || undefined}
                      className={styles.formatOption}
                      onClick={() => setExportFormat("csv")}
                    >
                      <span aria-hidden>{t("settings.formatCsv")}</span>
                    </button>
                  </div>
                </div>

                <div className={styles.section}>
                  <span className={styles.sectionLabel}>{t("accessLogs.exportColumns")}</span>
                  <p className={styles.sectionHint}>{t("accessLogs.exportColumnsHint")}</p>
                  <div className={styles.checkboxGroup}>
                    {EXPORT_COLUMN_KEYS.map((key) => {
                      const inputId = `access-logs-export-column-${key}`;
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
                  <button type="button" className={styles.closeBtn} onClick={closeExportModal}>
                    {t("accessLogs.close")}
                  </button>
                  <button
                    type="button"
                    className={styles.exportBtn}
                    disabled={!hasSelectedColumns}
                    onClick={handleExport}
                  >
                    {t("accessLogs.exportButton")}
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
