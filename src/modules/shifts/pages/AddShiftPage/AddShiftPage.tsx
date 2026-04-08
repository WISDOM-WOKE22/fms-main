"use client";

import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useTauriPush } from "@/core/tauri/useTauriPush";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { isTauri } from "@/core/api/baseUrl";
import { IconChevronLeft } from "@/core/layout/icons";
import { Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import type { ShiftStatus } from "@/modules/shifts/types";

/** Parse "HH:mm" to minutes since midnight. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Given break start time "HH:mm" and duration in minutes, returns "HH:mm" for break end. */
function addMinutesToTime(timeStr: string, durationMinutes: number): string {
  if (!timeStr || durationMinutes <= 0) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

/** Parse "30 min" / "1 hr" from Rust backend breakTime. */
function parseBreakMinutesFromString(s: string): number {
  const match = String(s).trim().match(/^(\d+)\s*(min|hr|h)?/i);
  const num = match ? parseInt(match[1], 10) : 0;
  const unit = match?.[2]?.toLowerCase();
  return unit === "hr" || unit === "h" ? num * 60 : num;
}

type ScheduleTypeForm = "standard" | "24_7";

interface FormState {
  name: string;
  personTypeId: string;
  scheduleType: ScheduleTypeForm;
  description: string;
  shiftStarts: string;
  shiftEnds: string;
  gracePeriodEnabled: boolean;
  gracePeriodMinutes: string;
  breakEnabled: boolean;
  breakStarts: string;
  breakEndTime: string;
  breakGracePeriodMinutes: string;
  overtimeEnabled: boolean;
  overtimeThresholdMinutes: string;
  status: ShiftStatus;
  workingDays: string[];
}

const initialForm: FormState = {
  name: "",
  personTypeId: "",
  scheduleType: "standard",
  description: "",
  shiftStarts: "09:00",
  shiftEnds: "17:00",
  gracePeriodEnabled: false,
  gracePeriodMinutes: "30",
  breakEnabled: false,
  breakStarts: "12:00",
  breakEndTime: "13:00",
  breakGracePeriodMinutes: "10",
  overtimeEnabled: false,
  overtimeThresholdMinutes: "30",
  status: "active",
  workingDays: ["mon", "tue", "wed", "thu", "fri"],
};

const inputBase =
  "w-full px-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent";
const inputError = "border-red-500";

const DAYS_OF_WEEK = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

/** Segment control: selected = blue bg + white text, unselected = border + gray text (matches cloud Create schedule). */
function SegmentControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex gap-0 rounded-2xl border border-fms-border overflow-hidden bg-fms-surface"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          tabIndex={value === opt.value ? 0 : -1}
          onClick={() => onChange(opt.value)}
          className={`min-w-28 px-4 py-2.5 text-sm font-medium transition-colors ${
            value === opt.value
              ? "bg-fms-accent text-white"
              : "bg-fms-surface text-fms-text-tertiary hover:text-fms-text-secondary border-r border-fms-border last:border-r-0"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function AddShiftPage({ editId }: { editId?: string }) {
  const { t } = useTranslation();
  const push = useTauriPush();
  const [form, setForm] = useState<FormState>(initialForm);
  const [personTypes, setPersonTypes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(!!editId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [originalWorkingDays, setOriginalWorkingDays] = useState<string[] | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/person-types")
      .then((res) => res.json())
      .then((data: { id: string; name: string; status?: string }[]) => {
        if (Array.isArray(data)) setPersonTypes(data.filter((p) => p.status !== "inactive").map((p) => ({ id: p.id, name: p.name })));
        else setPersonTypes([]);
      })
      .catch(() => setPersonTypes([]));
  }, []);

  useEffect(() => {
    if (!editId) return;
    setLoading(true);
    setLoadError(null);
    apiFetch(`/api/v1/schedules/${editId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Schedule not found");
        return res.json();
      })
      .then((s: Record<string, unknown>) => {
        const startTime = (s.startTime as string) ?? "09:00";
        const endTime = (s.endTime as string) ?? "17:00";
        const breakStartTime = (s.breakStartTime as string) ?? "12:00";
        const breakEndTime = (s.breakEndTime as string) ?? "13:00";
        const breakDur =
          breakStartTime && breakEndTime
            ? timeToMinutes(breakEndTime) - timeToMinutes(breakStartTime)
            : parseBreakMinutesFromString((s.breakTime as string) ?? "") || 30;
        const hasBreak = breakDur > 0 || (s.breakTime as string)?.toString().trim();
        const computedBreakEnd = breakDur > 0 ? addMinutesToTime(breakStartTime, breakDur) : "13:00";
        setForm({
          name: String(s.name ?? ""),
          personTypeId: String(s.personTypeId ?? ""),
          scheduleType: (s.scheduleType === "24_7" ? "24_7" : "standard") as ScheduleTypeForm,
          description: String(s.description ?? "").slice(0, 300),
          shiftStarts: startTime,
          shiftEnds: endTime,
          gracePeriodEnabled: Boolean((s as Record<string, unknown>).gracePeriodEnabled ?? false),
          gracePeriodMinutes: String(((s as Record<string, unknown>).gracePeriodMinutes as number) ?? 30),
          breakEnabled: !!hasBreak,
          breakStarts: breakStartTime,
          breakEndTime: breakEndTime || computedBreakEnd,
          breakGracePeriodMinutes: String((s.breakGracePeriodMinutes as number) ?? 10),
          overtimeEnabled: Boolean((s as Record<string, unknown>).overtimeEnabled ?? false),
          overtimeThresholdMinutes: String(((s as Record<string, unknown>).overtimeThresholdMinutes as number) ?? 30),
          status: (s.status === "inactive" ? "inactive" : "active") as ShiftStatus,
          workingDays: (Array.isArray(s.workingDays) ? s.workingDays : ["mon", "tue", "wed", "thu", "fri"]) as string[],
        });
        setOriginalWorkingDays((Array.isArray(s.workingDays) ? s.workingDays : ["mon", "tue", "wed", "thu", "fri"]) as string[]);
      })
      .catch(() => setLoadError("Failed to load schedule"))
      .finally(() => setLoading(false));
  }, [editId]);

  const breakDurationDisplay = useMemo(() => {
    if (!form.breakStarts || !form.breakEndTime) return "—";
    const s = timeToMinutes(form.breakStarts);
    const e = timeToMinutes(form.breakEndTime);
    const d = e - s;
    if (d <= 0) return "—";
    if (d < 60) return `${d} minutes`;
    const h = Math.floor(d / 60);
    const m = d % 60;
    return m ? `${h} hour${h !== 1 ? "s" : ""}, ${m} minutes` : `${h} hour${h !== 1 ? "s" : ""}`;
  }, [form.breakStarts, form.breakEndTime]);

  const update = (key: keyof FormState, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof typeof errors]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const toggleWorkingDay = (day: string) => {
    setForm((prev) => {
      const days = prev.workingDays.includes(day)
        ? prev.workingDays.filter((d) => d !== day)
        : [...prev.workingDays, day];
      return { ...prev, workingDays: days };
    });
    if (errors.workingDays) setErrors((prev) => ({ ...prev, workingDays: undefined }));
  };

  const workingDaysChanged = editId && originalWorkingDays !== null &&
    JSON.stringify([...form.workingDays].sort()) !== JSON.stringify([...originalWorkingDays].sort());

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) next.name = t("shifts.validationShiftName");
    if (!isTauri && !form.personTypeId) next.personTypeId = t("shifts.validationPersonType");
    if (form.scheduleType === "standard") {
      if (form.workingDays.length === 0) next.workingDays = t("shifts.validationWorkingDays");
      if (form.gracePeriodEnabled) {
        const g = parseInt(form.gracePeriodMinutes, 10);
        if (isNaN(g) || g < 1 || g > 120) next.gracePeriodMinutes = "Grace period must be 1–120 minutes.";
      }
      if (form.breakEnabled) {
        if (timeToMinutes(form.breakEndTime) <= timeToMinutes(form.breakStarts))
          next.breakEndTime = t("shifts.breakEndsHint");
        const g = parseInt(form.breakGracePeriodMinutes, 10);
        if (isNaN(g) || g < 1 || g > 60) next.breakGracePeriodMinutes = "Break grace period must be 1–60 minutes.";
      }
      if (form.overtimeEnabled) {
        const o = parseInt(form.overtimeThresholdMinutes, 10);
        if (isNaN(o) || o < 1 || o > 480) next.overtimeThresholdMinutes = "Overtime threshold must be 1–480 minutes.";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const breakMins = form.breakEnabled
        ? Math.max(0, timeToMinutes(form.breakEndTime) - timeToMinutes(form.breakStarts))
        : 0;
      const breakGraceMins = form.breakEnabled ? Math.min(60, Math.max(1, parseInt(form.breakGracePeriodMinutes, 10) || 10)) : null;
      const graceMins =
        form.scheduleType === "standard" && form.gracePeriodEnabled
          ? Math.min(120, Math.max(1, parseInt(form.gracePeriodMinutes, 10) || 30))
          : null;
      const body: Record<string, unknown> = isTauri
        ? editId
          ? {
              name: form.name.trim(),
              description: form.description.trim().slice(0, 300) || "",
              breakTime: breakMins > 0 ? `${breakMins} min` : "",
              breakGracePeriodMinutes: breakGraceMins,
              gracePeriodEnabled: form.scheduleType === "standard" ? form.gracePeriodEnabled : false,
              gracePeriodMinutes: form.scheduleType === "standard" ? graceMins : null,
              overtimeEnabled: form.scheduleType === "standard" ? form.overtimeEnabled : false,
              overtimeThresholdMinutes:
                form.scheduleType === "standard" && form.overtimeEnabled
                  ? Math.min(480, Math.max(1, parseInt(form.overtimeThresholdMinutes, 10) || 30))
                  : null,
              status: form.status,
              personTypeId: form.personTypeId || null,
              workingDays: form.scheduleType === "standard" ? form.workingDays : null,
            }
          : {
              name: form.name.trim(),
              description: form.description.trim().slice(0, 300) || "",
              breakTime: breakMins > 0 ? `${breakMins} min` : "",
              breakGracePeriodMinutes: breakGraceMins,
              gracePeriodEnabled: form.scheduleType === "standard" ? form.gracePeriodEnabled : false,
              gracePeriodMinutes: form.scheduleType === "standard" ? graceMins : null,
              overtimeEnabled: form.scheduleType === "standard" ? form.overtimeEnabled : false,
              overtimeThresholdMinutes:
                form.scheduleType === "standard" && form.overtimeEnabled
                  ? Math.min(480, Math.max(1, parseInt(form.overtimeThresholdMinutes, 10) || 30))
                  : null,
              status: form.status,
              createdBy: "current-user",
              personTypeId: form.personTypeId || null,
              workingDays: form.scheduleType === "standard" ? form.workingDays : null,
            }
        : (() => {
            const b: Record<string, unknown> = {
              name: form.name.trim(),
              personTypeId: form.personTypeId,
              scheduleType: form.scheduleType,
              description: form.description.trim().slice(0, 300) || null,
              status: form.status,
              isActive: form.status === "active",
              createdBy: "current-user",
            };
            if (form.scheduleType === "standard") {
              b.startTime = form.shiftStarts;
              b.endTime = form.shiftEnds;
              b.gracePeriodEnabled = form.gracePeriodEnabled;
              b.gracePeriodMinutes =
                form.gracePeriodEnabled ? Math.min(120, Math.max(1, parseInt(form.gracePeriodMinutes, 10) || 30)) : null;
              b.breakEnabled = form.breakEnabled;
              if (form.breakEnabled) {
                b.breakStartTime = form.breakStarts;
                b.breakEndTime = form.breakEndTime;
                b.breakGracePeriodMinutes = Math.min(60, Math.max(1, parseInt(form.breakGracePeriodMinutes, 10) || 10));
              } else {
                b.breakStartTime = null;
                b.breakEndTime = null;
                b.breakGracePeriodMinutes = null;
              }
              b.overtimeEnabled = form.overtimeEnabled;
              b.overtimeThresholdMinutes =
                form.overtimeEnabled ? Math.min(480, Math.max(1, parseInt(form.overtimeThresholdMinutes, 10) || 30)) : null;
              b.workingDays = form.workingDays;
            }
            return b;
          })();
      const path = editId ? `/api/v1/schedules/${editId}` : "/api/v1/schedules";
      const res = await apiFetch(path, {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = "Failed to save schedule";
        try {
          const data = (await res.json()) as { message?: string; details?: unknown };
          if (data?.message) message = data.message;
        } catch {
          // non-JSON response
        }
        throw new Error(message);
      }
      toast.success(editId ? (t("shifts.scheduleSavedSuccess") || "Schedule saved successfully.") : t("toast.shiftCreated"));
      push("/shifts");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout title={editId ? t("shifts.edit") : t("shifts.createShift")}>
        <div className="p-6">{t("shifts.loading")}</div>
      </DashboardLayout>
    );
  }

  if (editId && loadError) {
    return (
      <DashboardLayout title={t("shifts.edit")}>
        <div className="w-full max-w-none">
          <Link
            href="/shifts"
            className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
            aria-label={t("shifts.backToShifts")}
          >
            <IconChevronLeft className="w-4 h-4" />
            {t("shifts.backToShifts")}
          </Link>
          <div className="rounded-2xl bg-fms-surface border border-fms-border p-6 text-center">
            <p className="text-fms-text-secondary m-0">{loadError}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={editId ? t("shifts.edit") : t("shifts.createShift")}>
      <div className="w-full max-w-none">
        <Link
          href="/shifts"
          className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
          aria-label={t("shifts.backToShifts")}
        >
          <IconChevronLeft className="w-4 h-4" />
          {t("shifts.backToShifts")}
        </Link>

        <p className="text-sm text-fms-text-secondary m-0 mb-6">{t("shifts.newShiftSubtitle")}</p>

        <form
          onSubmit={handleSubmit}
          className="w-full rounded-2xl bg-fms-surface border border-fms-border p-6 sm:p-8 space-y-6"
        >
          <div>
            <span className="block text-sm font-medium text-fms-text mb-2">{t("shifts.scheduleType")}</span>
            <SegmentControl
              value={form.scheduleType}
              onChange={(v) => update("scheduleType", v)}
              options={[
                { value: "standard" as const, label: t("shifts.standard") },
                { value: "24_7" as const, label: t("shifts.scheduleType24_7") },
              ]}
              ariaLabel={t("shifts.scheduleType")}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <label htmlFor="shift-name" className="block text-sm font-medium text-fms-text mb-1.5">
                {t("shifts.shiftName")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
              </label>
              <input
                id="shift-name"
                type="text"
                maxLength={100}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="e.g. Morning Shift"
                className={`${inputBase} ${errors.name ? inputError : ""}`}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "shift-name-error" : undefined}
              />
              {errors.name && (
                <p id="shift-name-error" className="mt-1.5 text-sm text-red-500">
                  {errors.name}
                </p>
              )}
            </div>
            <div>
              <Select
                id="shift-person-type"
                label={
                  <>
                    {t("shifts.personType")}{" "}
                    <span className="text-fms-text-tertiary font-normal">({t("employees.required")})</span>
                  </>
                }
                value={form.personTypeId}
                onChange={(e) => update("personTypeId", e.target.value)}
                error={errors.personTypeId}
                selectSize="md"
              >
                <option value="">{t("employees.selectPersonType")}</option>
                {personTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <label htmlFor="shift-description" className="block text-sm font-medium text-fms-text mb-1.5">
              {t("shifts.shiftDescription")}
            </label>
            <textarea
              id="shift-description"
              maxLength={300}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="Optional description"
              rows={3}
              className={`${inputBase} resize-y min-h-[80px]`}
            />
          </div>

          {form.scheduleType === "standard" && (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label htmlFor="shift-starts" className="block text-sm font-medium text-fms-text mb-1.5">
                {t("shifts.shiftStarts")}
              </label>
              <input
                id="shift-starts"
                type="time"
                value={form.shiftStarts}
                onChange={(e) => update("shiftStarts", e.target.value)}
                className={inputBase}
              />
            </div>
            <div>
              <label htmlFor="shift-ends" className="block text-sm font-medium text-fms-text mb-1.5">
                {t("shifts.shiftEnds")}
              </label>
              <input
                id="shift-ends"
                type="time"
                value={form.shiftEnds}
                onChange={(e) => update("shiftEnds", e.target.value)}
                className={inputBase}
              />
            </div>
          </div>

          {/* Working Days */}
          <div>
            <span className="block text-sm font-medium text-fms-text mb-2">
              {t("shifts.workingDays")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map((day) => (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => toggleWorkingDay(day.key)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    form.workingDays.includes(day.key)
                      ? "bg-fms-accent text-white"
                      : "bg-fms-surface text-fms-text-tertiary border border-fms-border"
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
            {errors.workingDays && (
              <p className="mt-1.5 text-sm text-red-500">{errors.workingDays}</p>
            )}
            {workingDaysChanged && (
              <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                {t("shifts.workingDaysWarning")}
              </p>
            )}
          </div>

          {/* Grace period (check-in): only for standard schedules; 1–120 minutes when enabled */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-fms-text">{t("shifts.enableGracePeriod")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.gracePeriodEnabled}
                aria-label={t("shifts.enableGracePeriod")}
                onClick={() => update("gracePeriodEnabled", !form.gracePeriodEnabled)}
                className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 ${
                  form.gracePeriodEnabled ? "bg-fms-accent" : "bg-fms-border"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    form.gracePeriodEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                  aria-hidden
                />
              </button>
            </div>
            {form.gracePeriodEnabled && (
              <div className="flex flex-col gap-2 w-full">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.gracePeriodMinutes}
                  onChange={(e) => update("gracePeriodMinutes", e.target.value)}
                  placeholder="30"
                  className={`${inputBase} w-full ${errors.gracePeriodMinutes ? inputError : ""}`}
                  aria-label={t("shifts.gracePeriodDuration")}
                  aria-invalid={!!errors.gracePeriodMinutes}
                />
                <span className="text-sm text-fms-text-tertiary">{t("shifts.gracePeriodDuration")} (1–120)</span>
              </div>
            )}
            {errors.gracePeriodMinutes && (
              <p className="text-sm text-red-500">{errors.gracePeriodMinutes}</p>
            )}
          </div>

          {/* Break configuration: Enable Break toggle → Break Start/End, Duration (display), Break Grace Period */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-fms-text">{t("shifts.enableBreak")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.breakEnabled}
                aria-label={t("shifts.enableBreak")}
                onClick={() => update("breakEnabled", !form.breakEnabled)}
                className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 ${
                  form.breakEnabled ? "bg-fms-accent" : "bg-fms-border"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    form.breakEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                  aria-hidden
                />
              </button>
            </div>
            {form.breakEnabled && (
              <div className="rounded-2xl border border-fms-border bg-fms-bg-subtle/30 p-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="break-start-time" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("shifts.breakStartTime")}
                    </label>
                    <input
                      id="break-start-time"
                      type="time"
                      value={form.breakStarts}
                      onChange={(e) => update("breakStarts", e.target.value)}
                      className={inputBase}
                    />
                  </div>
                  <div>
                    <label htmlFor="break-end-time" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("shifts.breakEndTime")}
                    </label>
                    <input
                      id="break-end-time"
                      type="time"
                      value={form.breakEndTime}
                      onChange={(e) => update("breakEndTime", e.target.value)}
                      className={`${inputBase} ${errors.breakEndTime ? inputError : ""}`}
                      aria-invalid={!!errors.breakEndTime}
                    />
                    {errors.breakEndTime && (
                      <p className="mt-1 text-xs text-red-500">{errors.breakEndTime}</p>
                    )}
                  </div>
                </div>
                <div>
                  <span className="block text-sm font-medium text-fms-text-tertiary mb-0.5">
                    {t("shifts.breakDuration")}
                  </span>
                  <p className="text-sm text-fms-text">{breakDurationDisplay}</p>
                </div>
                <div>
                  <label htmlFor="break-grace-period" className="block text-sm font-medium text-fms-text mb-1.5">
                    {t("shifts.breakGracePeriod")} (1–60 {t("shifts.minutes")})
                  </label>
                  <input
                    id="break-grace-period"
                    type="number"
                    min={1}
                    max={60}
                    value={form.breakGracePeriodMinutes}
                    onChange={(e) => update("breakGracePeriodMinutes", e.target.value)}
                    className={`${inputBase} max-w-[100px] ${errors.breakGracePeriodMinutes ? inputError : ""}`}
                    aria-invalid={!!errors.breakGracePeriodMinutes}
                  />
                  {errors.breakGracePeriodMinutes ? (
                    <p className="mt-1 text-xs text-red-500">{errors.breakGracePeriodMinutes}</p>
                  ) : (
                    <p className="mt-1 text-xs text-fms-text-tertiary">
                      {t("shifts.breakGracePeriodHelp")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Overtime tracking: toggle (default OFF); when ON, show threshold 1–480 minutes */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-fms-text">{t("shifts.enableOvertime")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.overtimeEnabled}
                aria-label={t("shifts.enableOvertime")}
                onClick={() => update("overtimeEnabled", !form.overtimeEnabled)}
                className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2 ${
                  form.overtimeEnabled ? "bg-fms-accent" : "bg-fms-border"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    form.overtimeEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                  aria-hidden
                />
              </button>
            </div>
            {form.overtimeEnabled && (
              <div className="flex flex-col gap-2 w-full">
                <input
                  type="number"
                  min={1}
                  max={480}
                  value={form.overtimeThresholdMinutes}
                  onChange={(e) => update("overtimeThresholdMinutes", e.target.value)}
                  placeholder="30"
                  className={`${inputBase} w-full ${errors.overtimeThresholdMinutes ? inputError : ""}`}
                  aria-label={t("shifts.overtimeThreshold")}
                  aria-invalid={!!errors.overtimeThresholdMinutes}
                />
                <span className="text-sm text-fms-text-tertiary">{t("shifts.overtimeThreshold")} (1–480 {t("shifts.minutes")})</span>
              </div>
            )}
            {errors.overtimeThresholdMinutes && (
              <p className="text-sm text-red-500">{errors.overtimeThresholdMinutes}</p>
            )}
          </div>
          </>
          )}

          <div>
            <span className="block text-sm font-medium text-fms-text mb-2">{t("shifts.status")}</span>
            <SegmentControl
              value={form.status}
              onChange={(v) => update("status", v)}
              options={[
                { value: "active" as const, label: t("shifts.active") },
                { value: "inactive" as const, label: t("shifts.inactive") },
              ]}
              ariaLabel={t("shifts.status")}
            />
          </div>

          <div className="flex flex-wrap gap-3 pt-2 border-t border-fms-border">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-50 disabled:pointer-events-none"
            >
              {submitting ? t("shifts.saving") : t("shifts.saveShift")}
            </button>
            <Link
              href="/shifts"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle"
            >
              {t("employees.cancel")}
            </Link>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
