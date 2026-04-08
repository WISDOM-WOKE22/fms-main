"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { toast } from "@/core/lib/toast";
import { exportPdf } from "@/core/lib/exportPdf";
import { saveFile } from "@/core/lib/saveFile";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { useAppPreferences } from "@/core/contexts/AppPreferencesContext";
import { MultiSelect, Select } from "@/core/ui";
import {
  IconChevronLeft,
  IconDownload,
  IconLogin,
  IconLogout,
  IconUser,
} from "@/core/layout/icons";
import type { EmployeeDetail, EmployeeStatus } from "@/modules/employees/types";
import type { EmployeeActivity } from "@/modules/employees/types";
import styles from "./EmployeeDetailPage.module.css";
import exportModalStyles from "@/modules/access-logs/pages/AccessLogsPage/ExportModal.module.css";

type ExportFormat = "pdf" | "excel";
type ActivityExportColumnKey = "activityType" | "date" | "time" | "zone";
const ACTIVITY_EXPORT_COLUMN_KEYS: ActivityExportColumnKey[] = ["activityType", "date", "time", "zone"];

type TabId = "profile" | "activities";

interface ZoneOption {
  id: string;
  name: string;
  zones: { name: string }[];
}

interface ShiftOption {
  id: string;
  name: string;
  scheduleType?: string;
  breakEnabled?: boolean;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  breakTime?: string | null;
  overtimeEnabled?: boolean;
  overtimeThresholdMinutes?: number | null;
}

interface TimeConfig {
  checkInStart: string;
  checkInEnd: string;
  checkOutStart: string;
  checkOutEnd: string;
}

interface ProfileFormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  personTypeId: string;
  zoneIds: string[];
  zoneKeys: string[];
  shiftId: string;
  status: EmployeeStatus;
  isActive: boolean;
  joinedDate: string;
}

function employeeToForm(emp: EmployeeDetail): ProfileFormState {
  const { firstName, lastName } = splitName(emp.name);
  const zoneIds = emp.zoneIds?.length ? emp.zoneIds : (emp.locations?.map((l) => l.id) ?? emp.zones?.map((z) => z.zoneId) ?? (emp.zoneId ? [emp.zoneId] : []));
  const zoneKeys = emp.zones?.map((z) => `${z.zoneId}::${z.name}`) ?? [];
  return {
    firstName,
    lastName,
    email: emp.email ?? "",
    phone: emp.phone ?? "",
    personTypeId: emp.personTypeId ?? "",
    zoneIds,
    zoneKeys,
    shiftId: emp.shiftId ?? "",
    status: emp.status,
    isActive: emp.isActive,
    joinedDate: emp.joinedDate || new Date().toISOString().slice(0, 10),
  };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatActivityDate(dateStr: string, timeStr: string): string {
  const d = new Date(dateStr + "T" + timeStr);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getActivityDateGroupKey(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dNorm = new Date(d);
  dNorm.setHours(0, 0, 0, 0);
  if (dNorm.getTime() === today.getTime()) return "today";
  if (dNorm.getTime() === yesterday.getTime()) return "yesterday";
  return dateStr;
}

function parseMinutes(hhmm: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toDateTime(activity: EmployeeActivity): Date {
  return new Date(`${activity.date}T${activity.time}`);
}

function computeActivityMetrics(
  activities: EmployeeActivity[],
  timeConfig?: TimeConfig,
  shift?: ShiftOption | null
) {
  const sorted = [...activities].sort((a, b) => toDateTime(a).getTime() - toDateTime(b).getTime());

  if (sorted.length === 0) {
    return {
      totalCheckIns: 0,
      totalCheckOuts: 0,
      lateCheckIns: 0,
      earlyCheckOuts: 0,
      weeklyHours: 0,
      monthlyHours: 0,
      avgDailyHours: 0,
      productivity: 0,
      dailyProductivitySeries: [],
      overtimeMinutes: 0,
      breakMinutesPlanned: 0,
      breakDaysPlanned: 0,
      mostProductivePeriods: [] as Array<{ label: string; value: number }>,
      mostActiveLocation: "—",
      mostActiveLocationCount: 0,
      dataDuration: { from: "—", to: "—", days: 0 },
    };
  }

  const days = new Map<string, { checkins: EmployeeActivity[]; checkouts: EmployeeActivity[] }>();
  for (const a of sorted) {
    const bucket = days.get(a.date) ?? { checkins: [], checkouts: [] };
    if (a.type === "check-in") bucket.checkins.push(a);
    else bucket.checkouts.push(a);
    days.set(a.date, bucket);
  }

  const checkInEndMinutes = parseMinutes(timeConfig?.checkInEnd ?? "10:00");
  const checkOutStartMinutes = parseMinutes(timeConfig?.checkOutStart ?? "16:00");
  const checkOutEndMinutes = parseMinutes(timeConfig?.checkOutEnd ?? "18:00");

  const scheduleType = (shift?.scheduleType ?? "").toLowerCase();
  const nameHint = (shift?.name ?? "").toLowerCase();
  const is247 = scheduleType.includes("24/7") || scheduleType.includes("24x7") || scheduleType.includes("24-7") || scheduleType.includes("24_7") || nameHint.includes("24/7");

  const parseDurationMinutes = (v: string | null | undefined): number | null => {
    const s = (v ?? "").trim();
    if (!s) return null;
    if (s.includes(":")) {
      const mins = parseMinutes(s);
      return mins == null ? null : mins;
    }
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  };

  const plannedBreakMinutesPerDay = (() => {
    if (is247) return 0;
    const start = shift?.breakStartTime ?? null;
    const end = shift?.breakEndTime ?? null;
    const bt = shift?.breakTime ?? null;

    if (shift?.breakEnabled === true) {
      if (start && end) {
        const s = parseMinutes(start);
        const e = parseMinutes(end);
        if (s != null && e != null && e > s) return e - s;
      }
      const fromBt = parseDurationMinutes(bt);
      if (fromBt != null) return fromBt;
    }

    // Fallbacks when the backend returns only some fields.
    if (start && end) {
      const s = parseMinutes(start);
      const e = parseMinutes(end);
      if (s != null && e != null && e > s) return e - s;
    }

    const fromBt = parseDurationMinutes(bt);
    if (fromBt != null && fromBt > 0) return fromBt;
    return 0;
  })();

  let totalCheckIns = 0;
  let totalCheckOuts = 0;
  let lateCheckIns = 0;
  let earlyCheckOuts = 0;
  let totalWorkMinutes = 0;
  let workedDays = 0;
  let overtimeMinutes = 0;
  let breakMinutesPlanned = 0;
  let breakDaysPlanned = 0;

  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  const zoneCounts = new Map<string, number>();
  for (const a of sorted) {
    if (a.type !== "check-in") continue;
    const z = (a.zone ?? "").trim() || "—";
    zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  }
  let mostActiveLocation = "—";
  let mostActiveLocationCount = 0;
  for (const [z, c] of zoneCounts) {
    if (c > mostActiveLocationCount) {
      mostActiveLocation = z;
      mostActiveLocationCount = c;
    }
  }

  // Compute per-day minutes and scores once, then reuse for week/month sums.
  const perDay = Array.from(days.entries())
    .map(([date, bucket]) => {
      const dayDate = new Date(`${date}T00:00:00`);
      minDate = !minDate || dayDate < minDate ? dayDate : minDate;
      maxDate = !maxDate || dayDate > maxDate ? dayDate : maxDate;

      totalCheckIns += bucket.checkins.length;
      totalCheckOuts += bucket.checkouts.length;

      for (const ci of bucket.checkins) {
        const mins = parseMinutes(ci.time);
        if (mins != null && checkInEndMinutes != null && mins > checkInEndMinutes) lateCheckIns += 1;
      }
      for (const co of bucket.checkouts) {
        const mins = parseMinutes(co.time);
        if (mins != null && checkOutStartMinutes != null && mins < checkOutStartMinutes) earlyCheckOuts += 1;
      }

      const pairs = Math.min(bucket.checkins.length, bucket.checkouts.length);
      let dayMinutes = 0;
      let dayOvertimeMinutes = 0;
      let onTimeCheckIns = 0;
      const checkInsForPunctuality = bucket.checkins.length;
      for (let i = 0; i < bucket.checkins.length; i++) {
        const ci = bucket.checkins[i];
        const ciMins = parseMinutes(ci.time);
        if (ciMins != null && checkInEndMinutes != null && ciMins <= checkInEndMinutes) onTimeCheckIns += 1;
      }

      let checkoutOnTimeLike = 0;
      let checkoutsForCompletion = 0;

      for (let i = 0; i < pairs; i++) {
        const checkIn = bucket.checkins[i]!;
        const checkOut = bucket.checkouts[i]!;
        const ciMins = parseMinutes(checkIn.time);
        const coMins = parseMinutes(checkOut.time);

        const diffMs = toDateTime(checkOut).getTime() - toDateTime(checkIn).getTime();
        if (diffMs > 0) dayMinutes += Math.floor(diffMs / 60000);

        if (coMins != null && checkOutEndMinutes != null && coMins > checkOutEndMinutes) {
          dayOvertimeMinutes += coMins - checkOutEndMinutes;
        }

        if (coMins != null && checkOutStartMinutes != null && checkOutEndMinutes != null) {
          checkoutsForCompletion += 1;
          const isCompleted = coMins >= checkOutStartMinutes && coMins <= checkOutEndMinutes;
          if (isCompleted) checkoutOnTimeLike += 1;
        }
      }

      if (dayMinutes > 0) {
        workedDays += 1;
        totalWorkMinutes += dayMinutes;
        if (!is247 && plannedBreakMinutesPerDay > 0 && shift?.breakEnabled !== false) {
          breakDaysPlanned += 1;
          breakMinutesPlanned += plannedBreakMinutesPerDay;
        }
      }
      overtimeMinutes += dayOvertimeMinutes;

      const punctuality = checkInsForPunctuality > 0 && checkInEndMinutes != null ? onTimeCheckIns / checkInsForPunctuality : 0;
      const completion =
        checkoutsForCompletion > 0 && checkOutStartMinutes != null && checkOutEndMinutes != null
          ? checkoutOnTimeLike / checkoutsForCompletion
          : bucket.checkouts.length > 0
            ? 1
            : 0;
      const hoursScore = clamp(dayMinutes / (8 * 60), 0, 1);
      const dayProductivity = clamp((punctuality * 0.45 + completion * 0.35 + hoursScore * 0.2) * 100, 0, 100);

      return {
        date,
        dayMinutes,
        dayProductivity,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const { weekStart, weekEnd, monthStart, monthEnd, dataDurationDays, dataFromStr, dataToStr } = (() => {
    const maxD = maxDate!;
    const weekStartTmp = new Date(maxD);
    const dow = weekStartTmp.getDay(); // 0=Sun
    const diffToMonday = (dow + 6) % 7;
    weekStartTmp.setDate(weekStartTmp.getDate() - diffToMonday);
    weekStartTmp.setHours(0, 0, 0, 0);
    const weekEndTmp = new Date(weekStartTmp);
    weekEndTmp.setDate(weekEndTmp.getDate() + 6);
    weekEndTmp.setHours(23, 59, 59, 999);

    const monthStartTmp = new Date(maxD.getFullYear(), maxD.getMonth(), 1);
    monthStartTmp.setHours(0, 0, 0, 0);
    const monthEndTmp = new Date(maxD.getFullYear(), maxD.getMonth() + 1, 0);
    monthEndTmp.setHours(23, 59, 59, 999);

    const minD = minDate!;
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysInclusive = Math.floor((maxD.getTime() - minD.getTime()) / msPerDay) + 1;

    // Use the original "YYYY-MM-DD" keys to avoid UTC shifting.
    const fromStr = perDay[0]?.date ?? "—";
    const toStr = perDay[perDay.length - 1]?.date ?? "—";
    return {
      weekStart: weekStartTmp,
      weekEnd: weekEndTmp,
      monthStart: monthStartTmp,
      monthEnd: monthEndTmp,
      dataDurationDays: daysInclusive,
      dataFromStr: fromStr,
      dataToStr: toStr,
    };
  })();

  let weekMinutes = 0;
  let monthMinutes = 0;
  for (const d of perDay) {
    const dayDate = new Date(`${d.date}T00:00:00`);
    if (dayDate >= weekStart && dayDate <= weekEnd) weekMinutes += d.dayMinutes;
    if (dayDate >= monthStart && dayDate <= monthEnd) monthMinutes += d.dayMinutes;
  }

  // Fix: compute "hours per week/month" relative to the exported activities range.
  // We average across the weeks/months that contain worked days in the dataset.
  const formatDateKeyLocal2 = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const getMondayStartKey2 = (dateKey: string): string => {
    const d = new Date(`${dateKey}T00:00:00`);
    const dow = d.getDay(); // 0=Sun ... 6=Sat
    const diffToMonday = (dow + 6) % 7;
    d.setDate(d.getDate() - diffToMonday);
    return formatDateKeyLocal2(d);
  };

  const getMonthKey2 = (dateKey: string): string => {
    const d = new Date(`${dateKey}T00:00:00`);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  };

  const weekMinutesByKey = new Map<string, number>();
  const monthMinutesByKey = new Map<string, number>();

  for (const d of perDay) {
    if (d.dayMinutes <= 0) continue;
    const weekKey = getMondayStartKey2(d.date);
    weekMinutesByKey.set(weekKey, (weekMinutesByKey.get(weekKey) ?? 0) + d.dayMinutes);
    const monthKey = getMonthKey2(d.date);
    monthMinutesByKey.set(monthKey, (monthMinutesByKey.get(monthKey) ?? 0) + d.dayMinutes);
  }

  weekMinutes = weekMinutesByKey.size > 0 ? totalWorkMinutes / weekMinutesByKey.size : 0;
  monthMinutes = monthMinutesByKey.size > 0 ? totalWorkMinutes / monthMinutesByKey.size : 0;

  const avgDailyMinutes = workedDays > 0 ? totalWorkMinutes / workedDays : 0;

  // Overall productivity (dataset aggregate) for KPI.
  const attendanceScore = totalCheckIns > 0 && checkInEndMinutes != null ? (totalCheckIns - lateCheckIns) / totalCheckIns : 0;
  const completionScore =
    totalCheckIns > 0 && totalCheckOuts >= 0
      ? Math.min(1, totalCheckOuts / totalCheckIns)
      : 0;
  const hoursScore = clamp(avgDailyMinutes / (8 * 60), 0, 1);
  const productivity = clamp((attendanceScore * 0.4 + completionScore * 0.3 + hoursScore * 0.3) * 100, 0, 100);

  const dailyProductivitySeries = perDay.map((d) => {
    const dt = new Date(`${d.date}T00:00:00`);
    const label = dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { label, value: d.dayProductivity };
  });

  const mostProductivePeriods = [...dailyProductivitySeries]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  return {
    totalCheckIns,
    totalCheckOuts,
    lateCheckIns,
    earlyCheckOuts,
    weeklyHours: weekMinutes / 60,
    monthlyHours: monthMinutes / 60,
    avgDailyHours: avgDailyMinutes / 60,
    productivity,
    dailyProductivitySeries: dailyProductivitySeries.slice(-14),
    overtimeMinutes,
    breakMinutesPlanned,
    breakDaysPlanned,
    mostProductivePeriods,
    mostActiveLocation,
    mostActiveLocationCount,
    dataDuration: { from: dataFromStr, to: dataToStr, days: dataDurationDays },
  };
}

export interface EmployeeDetailPageProps {
  /** When rendered by Tauri hash router, id is passed as prop instead of route params. */
  tauriId?: string;
}

export default function EmployeeDetailPage({ tauriId }: EmployeeDetailPageProps = {}) {
  const { t, i18n } = useTranslation();
  const params = useParams();
  const id = (typeof params?.id === "string" ? params.id : null) ?? tauriId ?? "";
  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    profile: null,
    activities: null,
  });
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [activities, setActivities] = useState<EmployeeActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [personTypes, setPersonTypes] = useState<{ id: string; name: string }[]>([]);
  const [timeConfig, setTimeConfig] = useState<TimeConfig | undefined>(undefined);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    apiFetch(`/api/v1/employees/${id}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: EmployeeDetail | null) => {
        if (mounted && data) setEmployee({ ...data, id });
        else if (mounted) setEmployee(null);
      })
      .catch(() => {
        if (mounted) setEmployee(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    apiFetch("/api/v1/zones")
      .then((res) => res.json())
      .then((data: ZoneOption[]) => {
        if (Array.isArray(data)) {
          setZones(
            data.map((z: ZoneOption & { subZones?: { name: string }[] }) => ({
              id: z.id,
              name: z.name,
              zones: Array.isArray(z.zones) ? z.zones.map((zone) => ({ name: zone.name })) : Array.isArray(z.subZones) ? z.subZones.map((item) => ({ name: item.name })) : [],
            }))
          );
        }
      })
      .catch(() => setZones([]));
    apiFetch("/api/v1/schedules")
      .then((res) => res.json())
      .then((data: ShiftOption[]) => {
        if (Array.isArray(data)) {
          setShifts(
            data.map((shift) => ({
              id: shift.id,
              name: shift.name,
              scheduleType: (shift as any).scheduleType ?? (shift as any).schedule_type ?? undefined,
              breakEnabled: (shift as any).breakEnabled ?? (shift as any).break_enabled ?? undefined,
              breakStartTime: (shift as any).breakStartTime ?? (shift as any).break_start_time ?? undefined,
              breakEndTime: (shift as any).breakEndTime ?? (shift as any).break_end_time ?? undefined,
              breakTime: (shift as any).breakTime ?? (shift as any).break_time ?? undefined,
              overtimeEnabled: (shift as any).overtimeEnabled ?? (shift as any).overtime_enabled ?? undefined,
              overtimeThresholdMinutes:
                (shift as any).overtimeThresholdMinutes ?? (shift as any).overtime_threshold_minutes ?? null,
            }))
          );
        }
      })
      .catch(() => setShifts([]));
    apiFetch("/api/v1/person-types")
      .then((res) => res.json())
      .then((data: { id: string; name: string }[]) => {
        if (Array.isArray(data)) setPersonTypes(data.map((pt) => ({ id: pt.id, name: pt.name })));
      })
      .catch(() => setPersonTypes([]));
    apiFetch("/api/v1/settings/time-config")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TimeConfig | null) => {
        if (!data) return;
        setTimeConfig(data);
      })
      .catch(() => setTimeConfig(undefined));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    apiFetch(`/api/v1/employees/${id}/activities`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: EmployeeActivity[]) => {
        setActivities(Array.isArray(data) ? data : []);
      })
      .catch(() => setActivities([]));
  }, [id]);

  const { config } = useAppConfig();
  const { getLogoUrl } = useAppPreferences();
  const logoUrl = getLogoUrl(config.companyLogoUrl);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportClosing, setExportClosing] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("excel");
  const [exportColumns, setExportColumns] = useState<Record<ActivityExportColumnKey, boolean>>({
    activityType: true,
    date: true,
    time: true,
    zone: true,
  });
  const [activityDateFrom, setActivityDateFrom] = useState("");
  const [activityDateTo, setActivityDateTo] = useState("");
  const [activityEventFilter, setActivityEventFilter] = useState<"all" | "check-in" | "check-out">("all");
  const [activityAttendanceFilter, setActivityAttendanceFilter] = useState<"all" | "checked-in" | "checked-out">("all");
  const [activityLocationFilter, setActivityLocationFilter] = useState<string>("all");
  const [activityScheduleFilter, setActivityScheduleFilter] = useState<string>("all");

  const [isEditing, setIsEditing] = useState(true);
  const [form, setForm] = useState<ProfileFormState>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    personTypeId: "",
    zoneIds: [],
    zoneKeys: [],
    shiftId: "",
    status: "checked-out",
    isActive: true,
    joinedDate: "",
  });

  const zoneOptions = useMemo(
    () => zones.map((zone) => ({ value: zone.id, label: zone.name })),
    [zones]
  );

  const availableZoneOptions = useMemo(
    () =>
      form.zoneIds.flatMap((zoneId) => {
        const location = zones.find((item) => item.id === zoneId);
        if (!location) return [];
        return location.zones.map((zone) => ({
          value: `${zoneId}::${zone.name}`,
          label: `${location.name} - ${zone.name}`,
        }));
      }),
    [form.zoneIds, zones]
  );

  useEffect(() => {
    if (employee) setForm(employeeToForm(employee));
  }, [employee]);

  useEffect(() => {
    const validKeys = new Set(availableZoneOptions.map((option) => option.value));
    setForm((prev) => {
      const nextKeys = prev.zoneKeys.filter((key) => validKeys.has(key));
      return nextKeys.length === prev.zoneKeys.length ? prev : { ...prev, zoneKeys: nextKeys };
    });
  }, [availableZoneOptions]);

  const updateForm = (
    key: keyof ProfileFormState,
    value: string | boolean | string[]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const startEditing = () => {
    if (employee) setForm(employeeToForm(employee));
    setIsEditing(true);
  };

  const handleDeactivateActivate = async () => {
    if (!employee || togglingStatus) return;
    const nextActive = !employee.isActive;
    setTogglingStatus(true);
    try {
      const res = await apiFetch(`/api/v1/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!res.ok) throw new Error("Update failed");
      setEmployee((prev) => (prev ? { ...prev, isActive: nextActive } : null));
      toast.success(nextActive ? t("toast.employeeActivated") : t("toast.employeeDeactivated"));
    } catch {
      toast.error(t("toast.employeeStatusError"));
    } finally {
      setTogglingStatus(false);
    }
  };

  const saveProfile = async () => {
    if (!employee || savingProfile || form.zoneIds.length === 0 || !form.shiftId) return;
    setSavingProfile(true);
    try {
      const name = [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ") || employee.name;
      const zonesPayload = form.zoneKeys
        .map((key) => {
          const [zoneId, ...nameParts] = key.split("::");
          return { zoneId, name: nameParts.join("::") };
        })
        .filter((z) => z.zoneId && z.name);

      const res = await apiFetch(`/api/v1/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          personTypeId: form.personTypeId.trim() || undefined,
          status: form.status,
          isActive: form.isActive,
          zoneId: form.zoneIds[0],
          zoneIds: form.zoneIds,
          zones: zonesPayload,
          shiftId: form.shiftId,
          joinedDate: form.joinedDate,
        }),
      });
      if (!res.ok) throw new Error("Update failed");
      const data = (await res.json()) as EmployeeDetail;
      setEmployee(data);
      setIsEditing(false);
      toast.success(t("toast.employeeUpdated"));
    } catch {
      toast.error(t("toast.employeeUpdateError"));
    } finally {
      setSavingProfile(false);
    }
  };

  const closeExportModal = useCallback(() => {
    setExportClosing(true);
    const t = setTimeout(() => {
      setExportModalOpen(false);
      setExportClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const getActivityExportColumnLabel = useCallback(
    (key: ActivityExportColumnKey) => {
      if (key === "activityType") return t("accessLogs.activityType");
      if (key === "date") return t("employees.exportDate");
      if (key === "time") return t("accessLogs.time");
      return t("accessLogs.zone");
    },
    [t]
  );

  const activityTypeLabel = useCallback(
    (type: string) => {
      if (type === "check-in") return t("employees.activityCheckIn");
      return t("employees.activityCheckOut");
    },
    [t]
  );

  const formatActivityDateTime = useCallback((dateStr: string, timeStr: string) => {
    const d = new Date(dateStr + "T" + timeStr);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, []);

  const handleExportActivities = useCallback(async () => {
    const selectedKeys = ACTIVITY_EXPORT_COLUMN_KEYS.filter((k) => exportColumns[k]);
    if (selectedKeys.length === 0) return;

    const headers = selectedKeys.map((k) => getActivityExportColumnLabel(k));
    const activitiesForExport = activities.filter((a) => {
      if (activityDateFrom && a.date < activityDateFrom) return false;
      if (activityDateTo && a.date > activityDateTo) return false;
      if (activityEventFilter !== "all" && a.type !== activityEventFilter) return false;
      if (activityAttendanceFilter !== "all") {
        const attendance = a.type === "check-in" ? "checked-in" : "checked-out";
        if (attendance !== activityAttendanceFilter) return false;
      }
      if (activityLocationFilter !== "all" && (a.zone || "") !== activityLocationFilter) return false;
      if (activityScheduleFilter !== "all" && employee?.shift !== activityScheduleFilter) return false;
      return true;
    });

    const rowsForExport = activitiesForExport.map((a) =>
      selectedKeys.map((key) => {
        if (key === "activityType") return activityTypeLabel(a.type);
        if (key === "date") return a.date;
        if (key === "time") return formatActivityDateTime(a.date, a.time);
        if (key === "zone") return a.zone || "—";
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
      const filename = `activities-${employee?.name?.replace(/\s+/g, "-") ?? "employee"}-${new Date().toISOString().slice(0, 10)}.csv`;
      await saveFile(blob, filename);
    } else {
      try {
        const selectedShift =
          shifts.find((s) => (employee?.shiftId ? s.id === employee.shiftId : s.name === employee?.shift)) ?? null;
        const metrics = computeActivityMetrics(activitiesForExport, timeConfig, selectedShift);
        await exportPdf({
          title: t("employees.exportModalTitle"),
          description: employee ? `${employee.name} – ${t("employees.tabActivities")}` : t("employees.tabActivities"),
          logoUrl: logoUrl || undefined,
          origin: typeof window !== "undefined" ? window.location.origin : "",
          headers,
          rows: rowsForExport,
          summaryCards: [
            { label: t("employees.kpiWeeklyHours"), value: `${metrics.weeklyHours.toFixed(1)}h` },
            { label: t("employees.kpiProductivity"), value: `${metrics.productivity.toFixed(1)}%` },
            { label: t("employees.kpiAverageDailyHours"), value: `${metrics.avgDailyHours.toFixed(1)}h` },
            { label: t("employees.kpiTotalCheckIns"), value: String(metrics.totalCheckIns) },
            { label: t("employees.kpiTotalCheckOuts"), value: String(metrics.totalCheckOuts) },
            { label: t("employees.kpiMonthlyHours"), value: `${metrics.monthlyHours.toFixed(1)}h` },
            { label: t("employees.kpiLateCheckIns"), value: String(metrics.lateCheckIns) },
            { label: t("employees.kpiEarlyCheckOuts"), value: String(metrics.earlyCheckOuts) },
            {
              label: t("employees.kpiOvertimeHours"),
              value: `${(metrics.overtimeMinutes / 60).toFixed(1)}h`,
            },
            {
              label: t("employees.kpiBreakMinutes"),
              value: `${(metrics.breakMinutesPlanned / 60).toFixed(1)}h`,
            },
          ],
          highlights: [
            {
              label: t("employees.kpiMostProductivePeriod"),
              value:
                metrics.mostProductivePeriods.length > 0
                  ? metrics.mostProductivePeriods
                      .map((p) => `${p.label} (${p.value.toFixed(0)}%)`)
                      .join(", ")
                  : "—",
            },
            {
              label: t("employees.kpiMostActiveLocation"),
              value:
                metrics.mostActiveLocationCount > 0
                  ? `${metrics.mostActiveLocation} (${metrics.mostActiveLocationCount})`
                  : "—",
            },
            {
              label: t("employees.kpiDataDuration"),
              value:
                metrics.dataDuration.days > 0
                  ? `${metrics.dataDuration.from} - ${metrics.dataDuration.to} (${metrics.dataDuration.days}d)`
                  : "—",
            },
          ],
          productivity: {
            score: metrics.productivity,
            definition: t("employees.productivityDefinition"),
            series: metrics.dailyProductivitySeries,
            chartStyle: "area",
          },
          sections: [
            {
              title: t("employees.tabActivities"),
              headers,
              rows: rowsForExport,
            },
          ],
          filename: `activities-${employee?.name?.replace(/\s+/g, "-") ?? "employee"}-${new Date().toISOString().slice(0, 10)}`,
          locale: i18n.language === "ar" ? "ar" : "en",
        });
      } catch {
        // PDF generation failed
      }
    }
    closeExportModal();
  }, [
    exportFormat,
    exportColumns,
    activities,
    activityDateFrom,
    activityDateTo,
    activityEventFilter,
    activityAttendanceFilter,
    activityLocationFilter,
    activityScheduleFilter,
    employee,
    shifts,
    timeConfig,
    getActivityExportColumnLabel,
    activityTypeLabel,
    formatActivityDateTime,
    closeExportModal,
    logoUrl,
    t,
    i18n,
  ]);

  const hasSelectedExportColumns = ACTIVITY_EXPORT_COLUMN_KEYS.some((k) => exportColumns[k]);

  useEffect(() => {
    const el = tabRefs.current[activeTab];
    if (el && el.parentElement) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle({
        left: rect.left - parent.left,
        width: rect.width,
      });
    }
  }, [activeTab]);

  useEffect(() => {
    const el = tabRefs.current.profile;
    if (el && el.parentElement) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle((s) =>
        s.width === 0
          ? { left: rect.left - parent.left, width: rect.width }
          : s
      );
    }
  }, [employee?.id]);

  const employeeShift = employee?.shift ?? "";
  const activityLocationOptions = useMemo(
    () => Array.from(new Set(activities.map((a) => a.zone || "").filter(Boolean))),
    [activities]
  );

  const filteredActivities = useMemo(
    () =>
      activities.filter((a) => {
        if (activityDateFrom && a.date < activityDateFrom) return false;
        if (activityDateTo && a.date > activityDateTo) return false;
        if (activityEventFilter !== "all" && a.type !== activityEventFilter) return false;
        if (activityAttendanceFilter !== "all") {
          const attendance = a.type === "check-in" ? "checked-in" : "checked-out";
          if (attendance !== activityAttendanceFilter) return false;
        }
        if (activityLocationFilter !== "all" && (a.zone || "") !== activityLocationFilter) return false;
        if (activityScheduleFilter !== "all" && employeeShift !== activityScheduleFilter) return false;
        return true;
      }),
    [
      activities,
      activityDateFrom,
      activityDateTo,
      activityEventFilter,
      activityAttendanceFilter,
      activityLocationFilter,
      activityScheduleFilter,
      employeeShift,
    ]
  );

  const activityGroups = filteredActivities.reduce<Record<string, EmployeeActivity[]>>(
    (acc, a) => {
      const key = getActivityDateGroupKey(a.date);
      if (!acc[key]) acc[key] = [];
      acc[key].push(a);
      return acc;
    },
    {}
  );
  const keys = Object.keys(activityGroups);
  const groupOrder = [
    ...(keys.includes("today") ? ["today"] : []),
    ...(keys.includes("yesterday") ? ["yesterday"] : []),
    ...keys.filter((k) => k !== "today" && k !== "yesterday").sort().reverse(),
  ];

  const resetActivityFilters = () => {
    setActivityDateFrom("");
    setActivityDateTo("");
    setActivityEventFilter("all");
    setActivityAttendanceFilter("all");
    setActivityLocationFilter("all");
    setActivityScheduleFilter("all");
  };

  if (loading) {
    return (
      <DashboardLayout title={t("nav.employees")}>
        <div className={styles.page}>
          <div className={styles.notFoundCard}>
            <p className={styles.notFoundText}>{t("employees.loading")}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }
  if (!employee) {
    return (
      <DashboardLayout title={t("nav.employees")}>
        <div className={styles.page}>
          <Link
            href="/employees"
            className={styles.backLink}
            aria-label={t("employees.backToEmployees")}
          >
            <IconChevronLeft className="w-4 h-4" />
            {t("employees.employeeProfile")}
          </Link>
          <div className={styles.notFoundCard}>
            <div className={styles.notFoundIcon} aria-hidden>
              <IconUser className="w-8 h-8" />
            </div>
            <p className={styles.notFoundText}>
              {t("employees.employeeNotFound")}
            </p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={employee.name}>
      <div className={styles.page}>
        <div className={styles.topBar}>
          <Link
            href="/employees"
            className={styles.backLink}
            aria-label={t("employees.backToEmployees")}
          >
            <IconChevronLeft className={styles.backLinkIcon} />
            {t("employees.employeeProfile")}
          </Link>
          {activeTab === "activities" ? (
            <button
              type="button"
              onClick={() => setExportModalOpen(true)}
              className={styles.exportButtonTop}
              aria-label={t("employees.exportActivities")}
            >
              <IconDownload className={styles.exportButtonTopIcon} aria-hidden />
              {t("employees.exportActivities")}
            </button>
          ) : (
            <button
              type="button"
              className={employee.isActive ? styles.deactivateButton : styles.activateButton}
              onClick={handleDeactivateActivate}
              disabled={togglingStatus}
            >
              {togglingStatus ? (
                <span className={styles.buttonSpinner} aria-hidden />
              ) : null}
              {employee.isActive ? t("employees.deactivateAccount") : t("employees.activateAccount")}
            </button>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.tabList} role="tablist">
            <span
              className={styles.tabIndicator}
              style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
              aria-hidden
            />
            <button
              ref={(el) => {
                tabRefs.current.profile = el;
              }}
              role="tab"
              aria-selected={activeTab === "profile"}
              aria-controls="panel-profile"
              id="tab-profile"
              data-active={activeTab === "profile"}
              className={styles.tab}
              onClick={() => setActiveTab("profile")}
            >
              {t("employees.tabProfile")}
            </button>
            <button
              ref={(el) => {
                tabRefs.current.activities = el;
              }}
              role="tab"
              aria-selected={activeTab === "activities"}
              aria-controls="panel-activities"
              id="tab-activities"
              data-active={activeTab === "activities"}
              className={styles.tab}
              onClick={() => setActiveTab("activities")}
            >
              {t("employees.tabActivities")}
            </button>
          </div>

          <div className={styles.panelWrap}>
            {activeTab === "profile" && (
              <div
                id="panel-profile"
                role="tabpanel"
                aria-labelledby="tab-profile"
                className={styles.panel}
              >
                <div className={styles.profileLayout}>
                  <div
                    className={styles.profileForm}
                    data-view-mode={!isEditing}
                    aria-readonly={!isEditing}
                  >
                    <section className={styles.profileFormSection}>
                      <h2 className={styles.profileFormSectionTitle}>
                        {t("employees.personalInfo")}
                      </h2>
                      <div className={styles.profileFormGrid}>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.firstName")}
                          </label>
                          <input
                            type="text"
                            value={form.firstName}
                            onChange={(e) => updateForm("firstName", e.target.value)}
                            disabled={!isEditing}
                            readOnly={!isEditing}
                            aria-readonly={!isEditing}
                            className={
                              isEditing
                                ? styles.profileInput
                                : styles.profileInputDisabled
                            }
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.lastName")}
                          </label>
                          <input
                            type="text"
                            value={form.lastName}
                            onChange={(e) => updateForm("lastName", e.target.value)}
                            disabled={!isEditing}
                            readOnly={!isEditing}
                            aria-readonly={!isEditing}
                            className={
                              isEditing
                                ? styles.profileInput
                                : styles.profileInputDisabled
                            }
                          />
                        </div>
                        <div
                          className={`${styles.profileFormField} ${styles.profileFormFieldFull}`}
                        >
                          <label className={styles.profileFormLabel}>
                            {t("employees.email")}
                          </label>
                          <input
                            type="email"
                            value={form.email}
                            onChange={(e) => updateForm("email", e.target.value)}
                            disabled={!isEditing}
                            readOnly={!isEditing}
                            aria-readonly={!isEditing}
                            className={
                              isEditing
                                ? styles.profileInput
                                : styles.profileInputDisabled
                            }
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.phone")}
                          </label>
                          <input
                            type="tel"
                            value={form.phone}
                            onChange={(e) => updateForm("phone", e.target.value)}
                            disabled={!isEditing}
                            readOnly={!isEditing}
                            aria-readonly={!isEditing}
                            className={
                              isEditing
                                ? styles.profileInput
                                : styles.profileInputDisabled
                            }
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.personType")}
                          </label>
                          <Select
                            value={form.personTypeId}
                            onChange={(e) =>
                              updateForm("personTypeId", e.target.value)
                            }
                            disabled={!isEditing}
                            className={isEditing ? "w-full" : `w-full ${styles.profileSelectDisabled}`}
                            aria-readonly={!isEditing}
                          >
                            <option value="">—</option>
                            {personTypes.map((pt) => (
                              <option key={pt.id} value={pt.id}>
                                {pt.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div
                          className={`${styles.profileFormField} ${styles.profileFormFieldFull}`}
                        >
                          <span className={styles.profileFormLabel}>
                            {t("employees.verification")}
                          </span>
                          <span className={styles.verifiedBadge}>
                            {t("employees.verified")}
                          </span>
                        </div>
                      </div>
                    </section>

                    <section className={styles.profileFormSection}>
                      <h2 className={styles.profileFormSectionTitle}>
                        {t("employees.workInfo")}
                      </h2>
                      <div className={styles.profileFormGrid}>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.zones")}
                          </label>
                          <MultiSelect
                            options={zoneOptions}
                            values={form.zoneIds}
                            onChange={(values) => updateForm("zoneIds", values)}
                            disabled={!isEditing}
                            placeholder={t("employees.selectZones")}
                            className={isEditing ? "w-full" : `w-full ${styles.profileSelectDisabled}`}
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.subZones")}
                          </label>
                          <MultiSelect
                            options={availableZoneOptions}
                            values={form.zoneKeys}
                            onChange={(values) => updateForm("zoneKeys", values)}
                            disabled={!isEditing || form.zoneIds.length === 0}
                            placeholder={
                              form.zoneIds.length === 0
                                ? t("employees.noSubZonesAvailable")
                                : t("employees.selectSubZones")
                            }
                            hint={t("employees.subZonesHint")}
                            className={isEditing ? "w-full" : `w-full ${styles.profileSelectDisabled}`}
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.shift")}
                          </label>
                          <Select
                            value={form.shiftId}
                            onChange={(e) => updateForm("shiftId", e.target.value)}
                            disabled={!isEditing}
                            className={isEditing ? "w-full" : `w-full ${styles.profileSelectDisabled}`}
                            aria-readonly={!isEditing}
                          >
                            <option value="">—</option>
                            {shifts.map((shift) => (
                              <option key={shift.id} value={shift.id}>
                                {shift.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.dateJoined")}
                          </label>
                          <input
                            type="date"
                            value={form.joinedDate}
                            onChange={(e) =>
                              updateForm("joinedDate", e.target.value)
                            }
                            disabled={!isEditing}
                            readOnly={!isEditing}
                            aria-readonly={!isEditing}
                            className={
                              isEditing
                                ? styles.profileInput
                                : styles.profileInputDisabled
                            }
                          />
                        </div>
                        <div className={styles.profileFormField}>
                          <label className={styles.profileFormLabel}>
                            {t("employees.status")}
                          </label>
                          <Select
                            value={form.status}
                            onChange={(e) =>
                              updateForm(
                                "status",
                                e.target.value as EmployeeStatus
                              )
                            }
                            disabled={!isEditing}
                            className={isEditing ? "w-full" : `w-full ${styles.profileSelectDisabled}`}
                            aria-readonly={!isEditing}
                          >
                            <option value="checked-out">
                              {t("employees.checkedOut")}
                            </option>
                            <option value="checked-in">
                              {t("employees.checkedIn")}
                            </option>
                          </Select>
                        </div>
                        <div
                          className={`${styles.profileFormField} ${styles.profileFormFieldFull}`}
                        >
                          <div className="fms-toggle-row">
                            <span className={styles.profileFormLabel}>
                              {t("employees.active")}
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={form.isActive}
                              data-checked={form.isActive}
                              disabled={!isEditing}
                              className="fms-switch"
                              onClick={() =>
                                isEditing &&
                                updateForm("isActive", !form.isActive)
                              }
                            >
                              <span className="fms-switch-thumb" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </section>

                    <div className={styles.profileEditActions}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className={styles.profileSaveBtn}
                            onClick={saveProfile}
                            disabled={savingProfile}
                          >
                            {savingProfile ? t("zones.saving") : t("employees.saveChanges")}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.profileEditBtn}
                          onClick={startEditing}
                        >
                          {t("employees.editProfile")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "activities" && (
              <div
                id="panel-activities"
                role="tabpanel"
                aria-labelledby="tab-activities"
                className={styles.panel}
              >
                <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.dateFrom")}
                    </label>
                    <input
                      type="date"
                      value={activityDateFrom}
                      onChange={(e) => setActivityDateFrom(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-fms-border bg-fms-surface text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.dateTo")}
                    </label>
                    <input
                      type="date"
                      value={activityDateTo}
                      onChange={(e) => setActivityDateTo(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-fms-border bg-fms-surface text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.event")}
                    </label>
                    <Select
                      value={activityEventFilter}
                      onChange={(e) => setActivityEventFilter(e.target.value as "all" | "check-in" | "check-out")}
                      className="w-full"
                    >
                      <option value="all">{t("accessLogs.filterAll")}</option>
                      <option value="check-in">{t("employees.activityCheckIn")}</option>
                      <option value="check-out">{t("employees.activityCheckOut")}</option>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.attendanceStatus")}
                    </label>
                    <Select
                      value={activityAttendanceFilter}
                      onChange={(e) =>
                        setActivityAttendanceFilter(e.target.value as "all" | "checked-in" | "checked-out")
                      }
                      className="w-full"
                    >
                      <option value="all">{t("accessLogs.filterAll")}</option>
                      <option value="checked-in">{t("employees.checkedIn")}</option>
                      <option value="checked-out">{t("employees.checkedOut")}</option>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.location")}
                    </label>
                    <Select
                      value={activityLocationFilter}
                      onChange={(e) => setActivityLocationFilter(e.target.value)}
                      className="w-full"
                    >
                      <option value="all">{t("accessLogs.filterAll")}</option>
                      {activityLocationOptions.map((location) => (
                        <option key={location} value={location}>
                          {location}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-fms-text-secondary mb-1">
                      {t("accessLogs.schedule")}
                    </label>
                    <Select
                      value={activityScheduleFilter}
                      onChange={(e) => setActivityScheduleFilter(e.target.value)}
                      className="w-full"
                    >
                      <option value="all">{t("accessLogs.filterAll")}</option>
                      {employee.shift ? (
                        <option value={employee.shift}>{employee.shift}</option>
                      ) : null}
                    </Select>
                  </div>
                </div>

                <div className="mb-4">
                  <button
                    type="button"
                    onClick={resetActivityFilters}
                    className="inline-flex items-center justify-center px-3 py-2 rounded-xl text-sm font-medium border border-fms-border text-fms-text-secondary hover:bg-fms-bg-subtle transition-colors"
                  >
                    {t("accessLogs.resetFilters")}
                  </button>
                </div>

                {filteredActivities.length === 0 ? (
                  <div className={styles.emptyActivities}>
                    <div className={styles.emptyActivitiesIcon} aria-hidden>
                      <IconLogin className="w-10 h-10" />
                    </div>
                    <p className={styles.emptyActivitiesText}>
                      {t("employees.noActivities")}
                    </p>
                  </div>
                ) : (
                  <div className={styles.timeline}>
                    {groupOrder.map((key) => {
                      const items = activityGroups[key];
                      if (!items?.length) return null;
                      const label =
                        key === "today"
                          ? t("employees.today")
                          : key === "yesterday"
                            ? t("employees.yesterday")
                            : formatDate(key);
                      return (
                        <div key={key} className={styles.timelineGroup}>
                          <div className={styles.timelineGroupLabel}>
                            {label}
                          </div>
                          <div className={styles.timelineList}>
                            {items.map((activity) => (
                              <ActivityItem
                                key={activity.id}
                                activity={activity}
                                formatDate={formatActivityDate}
                                t={t}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {exportModalOpen && (
        <div
          className={exportModalStyles.overlay}
          data-closing={exportClosing ? "true" : undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby="employee-export-modal-title"
          onClick={(e) => e.target === e.currentTarget && closeExportModal()}
        >
          <div
            className={exportModalStyles.modal}
            data-closing={exportClosing ? "true" : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={exportModalStyles.modalWrapper}>
              <button
                type="button"
                className={exportModalStyles.closeIcon}
                onClick={closeExportModal}
                aria-label={t("accessLogs.close")}
              >
                ×
              </button>
              <h2 id="employee-export-modal-title" className={exportModalStyles.title}>
                {t("employees.exportModalTitle")}
              </h2>

              <div className={exportModalStyles.section}>
                <span className={exportModalStyles.sectionLabel}>{t("accessLogs.exportFormat")}</span>
                <div className={exportModalStyles.formatOptions}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={exportFormat === "pdf"}
                    data-selected={exportFormat === "pdf" || undefined}
                    className={exportModalStyles.formatOption}
                    onClick={() => setExportFormat("pdf")}
                  >
                    <span aria-hidden>{t("settings.formatPdf")}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={exportFormat === "excel"}
                    data-selected={exportFormat === "excel" || undefined}
                    className={exportModalStyles.formatOption}
                    onClick={() => setExportFormat("excel")}
                  >
                    <span aria-hidden>{t("settings.formatExcel")}</span>
                  </button>
                </div>
              </div>

              <div className={exportModalStyles.section}>
                <span className={exportModalStyles.sectionLabel}>{t("accessLogs.exportColumns")}</span>
                <p className={exportModalStyles.sectionHint}>{t("accessLogs.exportColumnsHint")}</p>
                <div className={exportModalStyles.checkboxGroup}>
                  {ACTIVITY_EXPORT_COLUMN_KEYS.map((key) => {
                    const inputId = `employee-activities-export-column-${key}`;
                    return (
                      <label key={key} className={exportModalStyles.checkboxRow} htmlFor={inputId}>
                        <input
                          id={inputId}
                          type="checkbox"
                          className={exportModalStyles.checkbox}
                          checked={exportColumns[key]}
                          onChange={(e) =>
                            setExportColumns((prev) => ({
                              ...prev,
                              [key]: e.target.checked,
                            }))
                          }
                        />
                        <span className={exportModalStyles.checkboxLabel}>
                          {getActivityExportColumnLabel(key)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className={exportModalStyles.actions}>
                <button type="button" className={exportModalStyles.closeBtn} onClick={closeExportModal}>
                  {t("accessLogs.close")}
                </button>
                <button
                  type="button"
                  className={exportModalStyles.exportBtn}
                  disabled={!hasSelectedExportColumns}
                  onClick={handleExportActivities}
                >
                  {t("accessLogs.exportButton")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function ActivityItem({
  activity,
  formatDate,
  t,
}: {
  activity: EmployeeActivity;
  formatDate: (date: string, time: string) => string;
  t: (key: string, options?: Record<string, string>) => string;
}) {
  const isCheckIn = activity.type === "check-in";
  return (
    <div className={styles.activityItem}>
      <div
        className={`${styles.activityIcon} ${isCheckIn ? styles.activityIconCheckIn : styles.activityIconCheckOut}`}
        aria-hidden
      >
        {isCheckIn ? (
          <IconLogin className="w-4 h-4" />
        ) : (
          <IconLogout className="w-4 h-4" />
        )}
      </div>
      <div className={styles.activityBody}>
        <p className={styles.activityTitle}>
          {isCheckIn
            ? t("employees.activityCheckIn")
            : t("employees.activityCheckOut")}
          {activity.zone
            ? ` ${t("employees.atZone", ({ zone: activity.zone }))}`
            : ""}
        </p>
        <p className={styles.activityMeta}>
          {formatDate(activity.date, activity.time)}
        </p>
      </div>
    </div>
  );
}
