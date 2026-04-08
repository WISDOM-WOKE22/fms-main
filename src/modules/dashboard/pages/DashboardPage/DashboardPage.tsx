"use client";

import { Fragment, useMemo, useState, useEffect, useCallback } from "react";
import { useTauriReplace } from "@/core/tauri/useTauriPush";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import {
  Area,
  AreaChart,
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconBell,
  IconChevronDown,
  IconClock,
  IconFace,
  IconList,
  IconLogin,
  IconLogout,
  IconRefresh,
  IconShield,
  IconUser,
  IconUsers,
} from "@/core/layout/icons";
import { KpiCard } from "@/modules/dashboard/components/KpiCard";
import { ChartContainer, ChartTooltip, ChartTooltipContent, Select, type ChartConfig } from "@/core/ui";

type DashboardEmployee = {
  id: string;
  name: string;
  isActive: boolean;
  status?: "checked-in" | "checked-out";
  zone?: string;
  shift?: string;
  personType?: string;
  joinedDate?: string;
  faceEnrollment?: "not_enrolled" | "link_sent" | "enrolled" | "expired";
};

type DashboardAccessLog = {
  id: string;
  employeeId?: string;
  date: string;
  time: string;
  zone?: string;
  location?: string;
  personType?: string;
  shift?: string;
  activityType: "check-in" | "check-out" | "tracking" | "absent";
  attendanceStatus?: "on_time" | "late" | "early_leave" | "overtime" | "absent" | "none";
  breakStatus?: "on_time_for_break" | "late_for_break" | "returned_on_time" | "late_return" | "none";
};

type SectionKey = "liveOperations" | "peopleAnalytics" | "attendanceIntelligence" | "systemHealth";
type DatePreset = "today" | "yesterday" | "thisWeek" | "thisMonth" | "last30Days" | "custom";

const CHART_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#6366f1", "#94a3b8"];
function toISODate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function startOfWeek(now: Date): Date {
  const d = new Date(now);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function inRange(dateStr: string, from: string, to: string): boolean {
  if (!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}

function groupBy<T>(arr: T[], keyOf: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const key = keyOf(item) || "__unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function percent(part: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function dayName(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function formatHour(time: string): string {
  const h = Number((time || "00:00").slice(0, 2));
  return `${String(Number.isNaN(h) ? 0 : h).padStart(2, "0")}:00`;
}

function ChartCard({
  title,
  children,
  chartHeightClass = "h-[250px]",
}: {
  title: string;
  children: React.ReactNode;
  chartHeightClass?: string;
}) {
  return (
    <section className="rounded-2xl bg-fms-surface border border-fms-border p-4 sm:p-5 min-h-[320px]">
      <h3 className="text-sm font-semibold text-fms-text mb-4">{title}</h3>
      <div className={chartHeightClass}>
        <div className="h-full w-full rounded-xl border border-fms-border bg-fms-bg-subtle/20 p-2 sm:p-3">
          <div className="h-full w-full">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

function NoDataState({ label }: { label: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center rounded-lg border border-dashed border-fms-border/80">
      <p className="m-0 text-sm text-fms-text-tertiary">{label}</p>
    </div>
  );
}

function SectionBlock({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-fms-border bg-fms-surface mb-6 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-fms-bg-subtle/40 transition-colors"
      >
        <span className="text-base font-semibold text-fms-text">{title}</span>
        <IconChevronDown className={`w-4 h-4 text-fms-text-secondary transition-transform ${collapsed ? "" : "rotate-180"}`} />
      </button>
      {!collapsed && <div className="p-4">{children}</div>}
    </section>
  );
}

function Heatmap({
  title,
  rows,
  days,
  emptyLabel,
  lessLabel,
  moreLabel,
}: {
  title: string;
  rows: { day: string; hour: string; count: number }[];
  days: string[];
  emptyLabel: string;
  lessLabel: string;
  moreLabel: string;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
  const byKey = new Map(rows.map((r) => [`${r.day}-${r.hour}`, r.count]));
  const max = Math.max(1, ...rows.map((r) => r.count));

  const intensityBg = (value: number) => {
    if (value <= 0) return "var(--fms-bg-subtle)";
    const ratio = value / max;
    if (ratio <= 0.25) return "rgba(22, 163, 74, 0.28)";
    if (ratio <= 0.5) return "rgba(22, 163, 74, 0.46)";
    if (ratio <= 0.75) return "rgba(22, 163, 74, 0.68)";
    return "rgba(22, 163, 74, 0.9)";
  };

  return (
    <ChartCard title={title} chartHeightClass="h-[320px]">
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-x-auto">
          <div className="grid gap-1 w-full min-w-[680px]" style={{ gridTemplateColumns: "56px repeat(24, minmax(10px, 1fr))" }}>
            <div />
            {hours.map((hour, index) => (
              <div key={hour} className="text-[9px] text-fms-text-tertiary text-center leading-none">
                {index % 3 === 0 ? hour.slice(0, 2) : ""}
              </div>
            ))}

            {days.map((day) => (
              <Fragment key={day}>
                <div className="text-[11px] text-fms-text-secondary self-center pr-2">{day}</div>
                {hours.map((hour) => {
                  const value = byKey.get(`${day}-${hour}`) ?? 0;
                  return (
                    <div
                      key={`${day}-${hour}`}
                      className="w-full aspect-square rounded-[3px] border border-black/5 dark:border-white/10 transition-transform hover:scale-105"
                      style={{ backgroundColor: intensityBg(value) }}
                      title={`${day} ${hour} — ${value} ${emptyLabel}`}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-fms-text-tertiary">
          <span>{lessLabel}</span>
          {[0, 1, 2, 3, 4].map((level) => {
            const sample = level === 0 ? 0 : Math.ceil((max / 4) * level);
            return (
              <span
                key={level}
                className="inline-block h-2.5 w-2.5 rounded-[3px] border border-black/5 dark:border-white/10"
                style={{ backgroundColor: intensityBg(sample) }}
              />
            );
          })}
          <span>{moreLabel}</span>
        </div>
      </div>
    </ChartCard>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fms-text-tertiary">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[48px] rounded-2xl bg-fms-surface border border-fms-border px-3 py-2 text-sm text-fms-text hover:border-fms-border-strong focus:outline-none focus:border-fms-accent focus:ring-3 focus:ring-fms-accent-muted transition-colors"
      />
    </label>
  );
}

export default function DashboardPage() {
  const { t } = useTranslation();
  const replace = useTauriReplace();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [employees, setEmployees] = useState<DashboardEmployee[]>([]);
  const [logs, setLogs] = useState<DashboardAccessLog[]>([]);
  const [personTypes, setPersonTypes] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [zones, setZones] = useState<string[]>([]);

  const today = toISODate(new Date());
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [locationFilter, setLocationFilter] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("all");
  const [personTypeFilter, setPersonTypeFilter] = useState("all");
  const [scheduleFilter, setScheduleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    liveOperations: false,
    peopleAnalytics: false,
    attendanceIntelligence: false,
    systemHealth: true,
  });
  const unknown = t("dashboard.v2.unknown");
  const noDataLabel = t("dashboard.v2.noData");
  const checkInsLabel = t("dashboard.v2.checkIns");
  const checkOutsLabel = t("dashboard.v2.checkOuts");
  const checkinsLower = t("dashboard.v2.checkinsLower");
  const days = [
    t("dashboard.mon"),
    t("dashboard.tue"),
    t("dashboard.wed"),
    t("dashboard.thu"),
    t("dashboard.fri"),
    t("dashboard.sat"),
    t("dashboard.sun"),
  ];

  const checkFlowConfig = useMemo(() => ({
    checkIns: { label: checkInsLabel, color: "#10b981" },
    checkOuts: { label: checkOutsLabel, color: "#3b82f6" },
  } satisfies ChartConfig), [checkInsLabel, checkOutsLabel]);
  const presenceConfig = useMemo(() => ({
    value: { label: t("dashboard.v2.people"), color: "#14b8a6" },
  } satisfies ChartConfig), [t]);
  const growthConfig = useMemo(() => ({
    total: { label: t("dashboard.v2.kpiTotalPeople"), color: "#14b8a6" },
  } satisfies ChartConfig), [t]);
  const activeInactiveConfig = useMemo(() => ({
    active: { label: t("dashboard.v2.active"), color: "#10b981" },
    inactive: { label: t("dashboard.v2.inactive"), color: "#ef4444" },
  } satisfies ChartConfig), [t]);
  const lateTrendConfig = useMemo(() => ({
    value: { label: t("dashboard.v2.kpiLateArrivalsToday"), color: "#f59e0b" },
  } satisfies ChartConfig), [t]);
  const onTimeLateConfig = useMemo(() => ({
    onTime: { label: t("dashboard.v2.onTime"), color: "#10b981" },
    late: { label: t("dashboard.v2.late"), color: "#f59e0b" },
  } satisfies ChartConfig), [t]);
  const scheduleComplianceConfig = useMemo(() => ({
    score: { label: t("dashboard.v2.compliancePercent"), color: "#10b981" },
  } satisfies ChartConfig), [t]);
  const newRegistrationsConfig = useMemo(() => ({
    value: { label: t("dashboard.v2.newRegistrations"), color: "#3b82f6" },
  } satisfies ChartConfig), [t]);

  useEffect(() => {
    if (typeof window !== "undefined" && !window.localStorage.getItem("fms-session")) {
      replace("/login");
    }
  }, [replace]);

  const applyPreset = useCallback((preset: DatePreset) => {
    const d = new Date();
    if (preset === "today") {
      const iso = toISODate(d);
      setFromDate(iso);
      setToDate(iso);
    } else if (preset === "yesterday") {
      d.setDate(d.getDate() - 1);
      const iso = toISODate(d);
      setFromDate(iso);
      setToDate(iso);
    } else if (preset === "thisWeek") {
      setFromDate(toISODate(startOfWeek(new Date())));
      setToDate(toISODate(new Date()));
    } else if (preset === "thisMonth") {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      setFromDate(toISODate(start));
      setToDate(toISODate(new Date()));
    } else if (preset === "last30Days") {
      const start = new Date();
      start.setDate(start.getDate() - 29);
      setFromDate(toISODate(start));
      setToDate(toISODate(new Date()));
    }
    setDatePreset(preset);
  }, []);

  const fetchDashboard = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [employeesRes, logsRes, personTypesRes, schedulesRes, zonesRes] = await Promise.all([
        apiFetch("/api/v1/employees"),
        apiFetch(`/api/v1/access-logs?dateFrom=${encodeURIComponent(fromDate)}&dateTo=${encodeURIComponent(toDate)}`),
        apiFetch("/api/v1/person-types"),
        apiFetch("/api/v1/schedules"),
        apiFetch("/api/v1/zones"),
      ]);

      if (employeesRes.ok) {
        const e = (await employeesRes.json()) as DashboardEmployee[];
        setEmployees(Array.isArray(e) ? e : []);
      }
      if (logsRes.ok) {
        const l = (await logsRes.json()) as DashboardAccessLog[];
        setLogs(Array.isArray(l) ? l : []);
      }
      if (personTypesRes.ok) {
        const pt = (await personTypesRes.json()) as Array<{ name?: string }>;
        setPersonTypes(pt.map((p) => p.name || "").filter(Boolean));
      }
      if (schedulesRes.ok) {
        const sh = (await schedulesRes.json()) as Array<{ name?: string }>;
        setSchedules(sh.map((s) => s.name || "").filter(Boolean));
      }
      if (zonesRes.ok) {
        const z = (await zonesRes.json()) as Array<{ name?: string; zones?: Array<{ name?: string }> }>;
        setLocations(z.map((r) => r.name || "").filter(Boolean));
        setZones(Array.from(new Set(z.flatMap((r) => (r.zones ?? []).map((s) => s.name || "").filter(Boolean)))));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboard(true).finally(() => setRefreshing(false));
  }, [fetchDashboard]);

  const filteredEmployees = useMemo(
    () =>
      employees.filter((e) => {
        if (locationFilter !== "all" && (e.zone || unknown) !== locationFilter) return false;
        if (personTypeFilter !== "all" && (e.personType || unknown) !== personTypeFilter) return false;
        if (scheduleFilter !== "all" && (e.shift || unknown) !== scheduleFilter) return false;
        if (statusFilter === "active" && !e.isActive) return false;
        if (statusFilter === "inactive" && e.isActive) return false;
        return true;
      }),
    [employees, locationFilter, personTypeFilter, scheduleFilter, statusFilter]
  );

  const filteredLogs = useMemo(
    () =>
      logs.filter((l) => {
        if (!inRange(l.date, fromDate, toDate)) return false;
        if (locationFilter !== "all" && (l.location || l.zone || unknown) !== locationFilter) return false;
        if (zoneFilter !== "all" && (l.zone || unknown) !== zoneFilter) return false;
        if (personTypeFilter !== "all" && (l.personType || unknown) !== personTypeFilter) return false;
        if (scheduleFilter !== "all" && (l.shift || unknown) !== scheduleFilter) return false;
        return true;
      }),
    [logs, fromDate, toDate, locationFilter, zoneFilter, personTypeFilter, scheduleFilter]
  );

  const activePeople = filteredEmployees.filter((e) => e.isActive).length;
  const inactivePeople = filteredEmployees.length - activePeople;
  const checkInsToday = filteredLogs.filter((l) => l.activityType === "check-in" && l.date === today).length;
  const checkOutsToday = filteredLogs.filter((l) => l.activityType === "check-out" && l.date === today).length;
  const lateToday = filteredLogs.filter((l) => l.attendanceStatus === "late" && l.date === today).length;
  const onTimeToday = filteredLogs.filter((l) => l.attendanceStatus === "on_time" && l.date === today).length;
  const earlyLeavesToday = filteredLogs.filter((l) => l.attendanceStatus === "early_leave" && l.date === today).length;
  const overtimeToday = filteredLogs.filter((l) => l.attendanceStatus === "overtime" && l.date === today).length;
  const pendingEnrollment = filteredEmployees.filter((e) => e.faceEnrollment === "not_enrolled" || e.faceEnrollment === "link_sent").length;

  const eventsByTime = useMemo(() => {
    const singleDay = fromDate === toDate;
    const grouped = groupBy(filteredLogs, (l) => (singleDay ? formatHour(l.time) : l.date));
    return Object.entries(grouped)
      .map(([bucket, rows]) => ({
        bucket,
        checkIns: rows.filter((r) => r.activityType === "check-in").length,
        checkOuts: rows.filter((r) => r.activityType === "check-out").length,
      }))
      .sort((a, b) => (a.bucket > b.bucket ? 1 : -1));
  }, [filteredLogs, fromDate, toDate]);

  const attendanceDistribution = useMemo(() => {
    const statuses = ["on_time", "late", "early_leave", "overtime", "none"] as const;
    return statuses.map((s) => ({
      name: s === "none" ? t("dashboard.v2.noStatus247") : t(`dashboard.v2.attendance.${s}`),
      value: filteredLogs.filter((l) => (l.attendanceStatus || "none") === s).length,
    }));
  }, [filteredLogs, t]);

  const presenceByLocation = useMemo(() => {
    const grouped = groupBy(filteredEmployees.filter((e) => e.status === "checked-in"), (e) => e.zone || unknown);
    return Object.entries(grouped)
      .map(([name, rows]) => ({ name, value: rows.length }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [filteredEmployees, unknown]);

  const peopleByPersonType = useMemo(
    () =>
      Object.entries(groupBy(filteredEmployees, (e) => e.personType || unknown)).map(([name, rows]) => ({
        name,
        value: rows.length,
      })),
    [filteredEmployees, unknown]
  );

  const activeInactiveByType = useMemo(
    () =>
      Object.entries(groupBy(filteredEmployees, (e) => e.personType || unknown)).map(([type, rows]) => ({
        type,
        active: rows.filter((r) => r.isActive).length,
        inactive: rows.filter((r) => !r.isActive).length,
      })),
    [filteredEmployees, unknown]
  );

  const lateTrend = useMemo(() => {
    const grouped = groupBy(filteredLogs.filter((l) => l.attendanceStatus === "late"), (l) => l.date);
    return Object.entries(grouped)
      .map(([date, rows]) => ({ date, value: rows.length }))
      .sort((a, b) => (a.date > b.date ? 1 : -1));
  }, [filteredLogs]);

  const growthData = useMemo(() => {
    const grouped = groupBy(filteredEmployees.filter((e) => e.joinedDate), (e) => (e.joinedDate || "").slice(0, 10));
    let cumulative = 0;
    return Object.keys(grouped)
      .sort()
      .map((date) => {
        cumulative += grouped[date].length;
        return { date, total: cumulative };
      });
  }, [filteredEmployees]);

  const onTimeVsLateByType = useMemo(() => {
    const grouped = groupBy(filteredLogs, (l) => l.personType || unknown);
    return Object.entries(grouped).map(([type, rows]) => ({
      type,
      onTime: rows.filter((r) => r.attendanceStatus === "on_time").length,
      late: rows.filter((r) => r.attendanceStatus === "late").length,
    }));
  }, [filteredLogs, unknown]);

  const breakCompliance = useMemo(() => {
    const statuses = ["on_time_for_break", "late_for_break", "returned_on_time", "late_return", "none"] as const;
    return statuses.map((key) => ({
      name: key === "none" ? t("dashboard.v2.none") : t(`dashboard.v2.breakStatus.${key}`),
      value: filteredLogs.filter((l) => (l.breakStatus || "none") === key).length,
    }));
  }, [filteredLogs, t]);

  const heatmapRows = useMemo(() => {
    const grouped = groupBy(filteredLogs.filter((l) => l.activityType === "check-in"), (l) => `${days[new Date(`${l.date}T00:00:00`).getDay() === 0 ? 6 : new Date(`${l.date}T00:00:00`).getDay() - 1]}-${formatHour(l.time)}`);
    return Object.entries(grouped).map(([key, rows]) => {
      const [day, hour] = key.split("-");
      return { day, hour, count: rows.length };
    });
  }, [filteredLogs, days]);

  const attendanceBySchedule = useMemo(() => {
    const grouped = groupBy(filteredLogs, (l) => l.shift || unknown);
    return Object.entries(grouped)
      .map(([schedule, rows]) => {
        const onTime = rows.filter((r) => r.attendanceStatus === "on_time").length;
        const considered = rows.filter((r) => ["on_time", "late", "early_leave", "overtime"].includes(r.attendanceStatus || "none")).length;
        return { schedule, score: considered ? Math.round((onTime / considered) * 100) : 0 };
      })
      .sort((a, b) => b.score - a.score);
  }, [filteredLogs, unknown]);

  const enrollmentBreakdown = useMemo(() => {
    const grouped = groupBy(filteredEmployees, (e) => e.faceEnrollment || "not_enrolled");
    return [
      { name: t("dashboard.v2.enrollment.enrolled"), value: grouped.enrolled?.length || 0 },
      { name: t("dashboard.v2.enrollment.linkSentPending"), value: grouped.link_sent?.length || 0 },
      { name: t("dashboard.v2.enrollment.notEnrolled"), value: grouped.not_enrolled?.length || 0 },
    ];
  }, [filteredEmployees, t]);

  const byScheduleType = useMemo(() => {
    const grouped = groupBy(filteredEmployees, (e) => e.shift || t("dashboard.v2.unassigned"));
    return Object.entries(grouped).map(([name, rows]) => ({ name, value: rows.length }));
  }, [filteredEmployees, t]);

  const newThisMonth = useMemo(() => {
    const month = new Date().getMonth();
    const year = new Date().getFullYear();
    const entries = filteredEmployees.filter((e) => {
      if (!e.joinedDate) return false;
      const d = new Date(e.joinedDate);
      return d.getMonth() === month && d.getFullYear() === year;
    });
    const grouped = groupBy(entries, (e) => String(new Date(e.joinedDate || "").getDate()));
    return Array.from({ length: 31 }, (_, idx) => {
      const day = String(idx + 1);
      return { day, value: grouped[day]?.length || 0 };
    });
  }, [filteredEmployees]);

  return (
    <DashboardLayout title={t("dashboard.title")}>
      <div className="w-full max-w-none">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("dashboard.overview", "Overview dashboard")}</p>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-xl border border-fms-border bg-fms-surface px-3 py-2 text-fms-text-secondary hover:text-fms-text"
          >
            <IconRefresh className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            {t("dashboard.refresh", "Refresh")}
          </button>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3 mb-3">
            <DateField
              label={t("dashboard.v2.filters.dateFrom")}
              value={fromDate}
              onChange={(value) => {
                setFromDate(value);
                setDatePreset("custom");
              }}
            />
            <DateField
              label={t("dashboard.v2.filters.dateTo")}
              value={toDate}
              onChange={(value) => {
                setToDate(value);
                setDatePreset("custom");
              }}
            />
            <Select label={t("dashboard.v2.filters.location")} value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} selectSize="md">
              <option value="all">{t("dashboard.v2.allLocations")}</option>
              {locations.map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
            <Select label={t("dashboard.v2.filters.zone")} value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} selectSize="md">
              <option value="all">{t("dashboard.v2.allZones")}</option>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
            <Select label={t("dashboard.v2.filters.personType")} value={personTypeFilter} onChange={(e) => setPersonTypeFilter(e.target.value)} selectSize="md">
              <option value="all">{t("dashboard.v2.allTypes")}</option>
              {personTypes.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Select label={t("dashboard.v2.filters.schedule")} value={scheduleFilter} onChange={(e) => setScheduleFilter(e.target.value)} selectSize="md">
              <option value="all">{t("dashboard.v2.allSchedules")}</option>
              {schedules.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-wrap gap-2.5 rounded-3xl border border-fms-border bg-fms-bg-subtle/50 p-2">
            {[
              { key: "today", label: t("dashboard.v2.shortcuts.today") },
              { key: "yesterday", label: t("dashboard.v2.shortcuts.yesterday") },
              { key: "thisWeek", label: t("dashboard.v2.shortcuts.thisWeek") },
              { key: "thisMonth", label: t("dashboard.v2.shortcuts.thisMonth") },
              { key: "last30Days", label: t("dashboard.v2.shortcuts.last30Days") },
            ].map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key as DatePreset)}
                className={`min-h-11 px-5 rounded-full border text-sm font-medium tracking-tight transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent/35 focus:ring-offset-2 focus:ring-offset-fms-surface ${
                  datePreset === p.key
                    ? "border-fms-accent text-fms-accent bg-fms-surface shadow-[0_0_0_1px_var(--fms-accent)]"
                    : "border-fms-border text-fms-text-secondary bg-fms-surface hover:border-fms-border-strong hover:text-fms-text hover:-translate-y-px"
                }`}
              >
                {p.label}
              </button>
            ))}
            </div>
            <div className="ml-auto min-w-[170px]">
              <Select
                label={t("dashboard.v2.filters.status")}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}
                selectSize="sm"
              >
                <option value="all">{t("dashboard.v2.all")}</option>
                <option value="active">{t("dashboard.v2.active")}</option>
                <option value="inactive">{t("dashboard.v2.inactive")}</option>
              </Select>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <KpiCard title={t("dashboard.v2.kpiTotalPeople")} value={loading ? "—" : filteredEmployees.length} icon={<IconUsers className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiActivePeople")} value={loading ? "—" : activePeople} icon={<IconUser className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiInactivePeople")} value={loading ? "—" : inactivePeople} icon={<IconUsers className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiPersonTypes")} value={personTypes.length} icon={<IconList className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiCheckInsToday")} value={checkInsToday} icon={<IconLogin className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiCheckOutsToday")} value={checkOutsToday} icon={<IconLogout className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiLateArrivalsToday")} value={lateToday} icon={<IconClock className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiFaceEnrolled")} value={`${enrollmentBreakdown[0]?.value || 0} (${percent(enrollmentBreakdown[0]?.value || 0, filteredEmployees.length)})`} icon={<IconFace className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiOnTimeRateToday")} value={percent(onTimeToday, Math.max(1, onTimeToday + lateToday + earlyLeavesToday + overtimeToday))} icon={<IconShield className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiEarlyLeavesToday")} value={earlyLeavesToday} icon={<IconLogout className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiOvertimeEventsToday")} value={overtimeToday} icon={<IconClock className="w-5 h-5" />} />
          <KpiCard title={t("dashboard.v2.kpiPendingEnrollment")} value={pendingEnrollment} icon={<IconBell className="w-5 h-5" />} />
        </div>

        <SectionBlock title={t("dashboard.v2.sections.liveOperations")} collapsed={collapsed.liveOperations} onToggle={() => setCollapsed((s) => ({ ...s, liveOperations: !s.liveOperations }))}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
            <ChartCard title={t("dashboard.v2.charts.peoplePresenceByLocation")} chartHeightClass="h-[340px]">
              {presenceByLocation.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={presenceConfig}>
                <BarChart
                  data={presenceByLocation}
                  layout="vertical"
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="24%"
                  barGap={2}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis dataKey="name" type="category" width={130} tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="value" name={t("dashboard.v2.people")} fill="var(--color-value)" radius={[0, 6, 6, 0]} maxBarSize={22} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
            <ChartCard title={t("dashboard.v2.charts.attendanceStatusDistribution")}>
              {attendanceDistribution.every((item) => item.value === 0) ? <NoDataState label={noDataLabel} /> : <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={attendanceDistribution} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90}>
                    {attendanceDistribution.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>}
            </ChartCard>
          </div>
          <ChartCard title={t("dashboard.v2.charts.checkInOutOverTime")} chartHeightClass="h-[380px]">
            {eventsByTime.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={checkFlowConfig}>
              <AreaChart data={eventsByTime} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashboardCheckInsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-checkIns)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-checkIns)" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="dashboardCheckOutsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-checkOuts)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-checkOuts)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend />
                <Area type="monotone" dataKey="checkIns" name={checkInsLabel} stroke="var(--color-checkIns)" strokeWidth={2.2} fill="url(#dashboardCheckInsGradient)" />
                <Area type="monotone" dataKey="checkOuts" name={checkOutsLabel} stroke="var(--color-checkOuts)" strokeWidth={2.2} fill="url(#dashboardCheckOutsGradient)" />
              </AreaChart>
            </ChartContainer>}
          </ChartCard>
        </SectionBlock>

        <SectionBlock title={t("dashboard.v2.sections.peopleAnalytics")} collapsed={collapsed.peopleAnalytics} onToggle={() => setCollapsed((s) => ({ ...s, peopleAnalytics: !s.peopleAnalytics }))}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title={t("dashboard.v2.charts.peopleByPersonType")}>
              {peopleByPersonType.length === 0 ? <NoDataState label={noDataLabel} /> : <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={peopleByPersonType} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90}>
                    {peopleByPersonType.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>}
            </ChartCard>
            <ChartCard title={t("dashboard.v2.charts.activeInactiveByPersonType")}>
              {activeInactiveByType.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={activeInactiveConfig}>
                <BarChart
                  data={activeInactiveByType}
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="20%"
                  barGap={2}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                  <XAxis
                    dataKey="type"
                    tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    interval={0}
                    minTickGap={12}
                  />
                  <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend />
                  <Bar dataKey="active" stackId="a" fill="var(--color-active)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="inactive" stackId="a" fill="var(--color-inactive)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
            <ChartCard title={t("dashboard.v2.charts.lateArrivalsTrend")}>
              {lateTrend.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={lateTrendConfig}>
                <BarChart
                  data={lateTrend}
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="12%"
                  barGap={2}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={14}
                  />
                  <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" name={t("dashboard.v2.kpiLateArrivalsToday")} fill="var(--color-value)" radius={[6, 6, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
            <ChartCard title={t("dashboard.v2.charts.peopleGrowthOverTime")}>
              {growthData.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={growthConfig}>
                <AreaChart data={growthData} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashboardGrowthGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="total" name={t("dashboard.v2.kpiTotalPeople")} stroke="var(--color-total)" strokeWidth={2.2} fill="url(#dashboardGrowthGradient)" />
                </AreaChart>
              </ChartContainer>}
            </ChartCard>
          </div>
        </SectionBlock>

        <SectionBlock title={t("dashboard.v2.sections.attendanceIntelligence")} collapsed={collapsed.attendanceIntelligence} onToggle={() => setCollapsed((s) => ({ ...s, attendanceIntelligence: !s.attendanceIntelligence }))}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title={t("dashboard.v2.charts.onTimeVsLateByPersonType")}>
              {onTimeVsLateByType.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={onTimeLateConfig}>
                <BarChart
                  data={onTimeVsLateByType}
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="24%"
                  barGap={4}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                  <XAxis
                    dataKey="type"
                    tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    interval={0}
                    minTickGap={12}
                  />
                  <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend />
                  <Bar dataKey="onTime" fill="var(--color-onTime)" radius={[6, 6, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="late" fill="var(--color-late)" radius={[6, 6, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
            <ChartCard title={t("dashboard.v2.charts.breakComplianceDistribution")}>
              {breakCompliance.every((item) => item.value === 0) ? <NoDataState label={noDataLabel} /> : <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={breakCompliance} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90}>
                    {breakCompliance.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>}
            </ChartCard>
            {/* Section temporarily hidden per request: check-in heatmap + attendance compliance by schedule
            {heatmapRows.length === 0 ? (
              <ChartCard title={t("dashboard.v2.charts.checkInHeatmap")} chartHeightClass="h-[320px]">
                <NoDataState label={noDataLabel} />
              </ChartCard>
            ) : (
              <Heatmap
                title={t("dashboard.v2.charts.checkInHeatmap")}
                rows={heatmapRows}
                days={days}
                emptyLabel={checkinsLower}
                lessLabel={t("dashboard.v2.less")}
                moreLabel={t("dashboard.v2.more")}
              />
            )}
            <ChartCard title={t("dashboard.v2.charts.attendanceComplianceBySchedule")}>
              {attendanceBySchedule.length === 0 ? <NoDataState label={noDataLabel} /> : <ChartContainer config={scheduleComplianceConfig}>
                <BarChart
                  data={attendanceBySchedule}
                  layout="vertical"
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="24%"
                  barGap={2}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis dataKey="schedule" type="category" width={120} tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="score" name={t("dashboard.v2.compliancePercent")} fill="var(--color-score)" radius={[0, 6, 6, 0]} maxBarSize={22} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
            */}
          </div>
        </SectionBlock>

        <SectionBlock title={t("dashboard.v2.sections.systemHealth")} collapsed={collapsed.systemHealth} onToggle={() => setCollapsed((s) => ({ ...s, systemHealth: !s.systemHealth }))}>
          <div className="grid grid-cols-1 gap-4">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <ChartCard title={t("dashboard.v2.charts.faceEnrollmentStatusBreakdown")} chartHeightClass="h-[240px]">
                {enrollmentBreakdown.every((item) => item.value === 0) ? <NoDataState label={noDataLabel} /> : <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={enrollmentBreakdown} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85}>
                      {enrollmentBreakdown.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>}
              </ChartCard>
              <ChartCard title={t("dashboard.v2.charts.peopleByScheduleType")} chartHeightClass="h-[240px]">
                {byScheduleType.length === 0 ? <NoDataState label={noDataLabel} /> : <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={byScheduleType} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85}>
                      {byScheduleType.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>}
              </ChartCard>
            </div>
            <ChartCard title={t("dashboard.v2.charts.newPeopleRegisteredThisMonth")} chartHeightClass="h-[300px]">
              {newThisMonth.every((item) => item.value === 0) ? <NoDataState label={noDataLabel} /> : <ChartContainer config={newRegistrationsConfig}>
                <BarChart
                  data={newThisMonth}
                  margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                  barCategoryGap="8%"
                  barGap={1}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fms-border)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    interval={1}
                    minTickGap={8}
                  />
                  <YAxis tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" name={t("dashboard.v2.newRegistrations")} fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={16} />
                </BarChart>
              </ChartContainer>}
            </ChartCard>
          </div>
        </SectionBlock>
      </div>
    </DashboardLayout>
  );
}
