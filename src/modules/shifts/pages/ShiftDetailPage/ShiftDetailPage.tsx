"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTauriPush } from "@/core/tauri/useTauriPush";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { isTauri } from "@/core/api/baseUrl";
import { IconChevronLeft } from "@/core/layout/icons";
import { Badge } from "@/core/ui/Badge";
import { toast } from "@/core/lib/toast";
import type { ShiftRow, ShiftStatus } from "@/modules/shifts/types";

type TabId = "details" | "employees";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function addMinutesToTime(timeStr: string, durationMinutes: number): string {
  if (!timeStr || durationMinutes <= 0) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface FormState {
  name: string;
  description: string;
  shiftStarts: string;
  shiftEnds: string;
  gracePeriodEnabled: boolean;
  gracePeriodMinutes: string;
  overtimeEnabled: boolean;
  overtimeThresholdMinutes: string;
  breakDuration: string;
  breakStarts: string;
  status: ShiftStatus;
}

const inputBase =
  "w-full px-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent";
const inputError = "border-red-500";

function parseBreakMinutes(breakTime: string): number {
  const match = breakTime.match(/^(\d+)\s*(min|hr|h)?/i);
  const num = match ? parseInt(match[1], 10) : 30;
  const unit = match?.[2]?.toLowerCase();
  return unit === "hr" || unit === "h" ? num * 60 : num;
}

function shiftToForm(s: ShiftRow): FormState {
  const breakStart = s.breakStartTime || "12:00";
  const breakEnd = s.breakEndTime || "";
  const breakMins = breakStart && breakEnd
    ? timeToMinutes(breakEnd) - timeToMinutes(breakStart)
    : s.breakTime ? parseBreakMinutes(s.breakTime) : 30;
  return {
    name: s.name,
    description: s.description ?? "",
    shiftStarts: s.startTime || "08:00",
    shiftEnds: s.endTime || "17:00",
    gracePeriodEnabled: s.gracePeriodEnabled ?? false,
    gracePeriodMinutes: String(s.gracePeriodMinutes ?? 30),
    overtimeEnabled: s.overtimeEnabled ?? false,
    overtimeThresholdMinutes: String(s.overtimeThresholdMinutes ?? 30),
    breakDuration: String(breakMins > 0 ? breakMins : 30),
    breakStarts: breakStart,
    status: s.status,
  };
}

export interface ShiftDetailPageProps {
  /** When rendered by Tauri hash router, id is passed as prop instead of route params. */
  tauriId?: string;
}

export default function ShiftDetailPage({ tauriId }: ShiftDetailPageProps = {}) {
  const { t } = useTranslation();
  const params = useParams();
  const push = useTauriPush();
  const id = (typeof params?.id === "string" ? params.id : null) ?? tauriId ?? "";
  const [activeTab, setActiveTab] = useState<TabId>("details");
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({ details: null, employees: null });
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [employees, setEmployees] = useState<{ id: string; name: string; zone: string; shift: string; status: string; isActive: boolean; joinedDate: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteModalClosing, setDeleteModalClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    apiFetch(`/api/v1/schedules/${id}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: ShiftRow | null) => {
        if (mounted) setShift(data ?? null);
      })
      .catch(() => {
        if (mounted) setShift(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [id]);

  useEffect(() => {
    if (!shift) return;
    apiFetch("/api/v1/employees")
      .then((res) => res.json())
      .then((data: { id: string; name: string; zone: string; shift: string; status?: string; isActive?: boolean; joinedDate?: string }[]) => {
        if (!Array.isArray(data)) return;
        setEmployees(
          data
            .filter((e) => e.shift === shift.name)
            .map((e) => ({
              id: e.id,
              name: e.name,
              zone: e.zone,
              shift: e.shift,
              status: e.status ?? "checked-out",
              isActive: e.isActive ?? true,
              joinedDate: e.joinedDate ?? "",
            }))
        );
      })
      .catch(() => setEmployees([]));
  }, [shift]);

  const [form, setForm] = useState<FormState>({
    name: "",
    description: "",
    shiftStarts: "08:00",
    shiftEnds: "17:00",
    gracePeriodEnabled: false,
    gracePeriodMinutes: "30",
    overtimeEnabled: false,
    overtimeThresholdMinutes: "30",
    breakDuration: "30",
    breakStarts: "12:00",
    status: "active",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  useEffect(() => {
    if (shift) setForm(shiftToForm(shift));
  }, [shift]);

  const breakEnds = useMemo(
    () =>
      form.breakStarts && form.breakDuration
        ? addMinutesToTime(form.breakStarts, Number(form.breakDuration) || 0)
        : "",
    [form.breakStarts, form.breakDuration]
  );

  const updateForm = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) next.name = t("shifts.validationShiftName");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const closeDeleteModal = () => {
    setDeleteModalClosing(true);
    setTimeout(() => {
      setDeleteModalOpen(false);
      setDeleteModalClosing(false);
    }, 200);
  };

  const handleDeleteConfirm = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/v1/schedules/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? data?.message ?? t("toast.shiftDeleteError"));
      }
      toast.success(t("toast.shiftDeleted"));
      push("/shifts");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.shiftDeleteError"));
    } finally {
      setDeleting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const breakMinutes = Number(form.breakDuration) || 0;
      const graceMins = form.gracePeriodEnabled
        ? Math.min(120, Math.max(1, parseInt(form.gracePeriodMinutes, 10) || 30))
        : null;
      const overtimeMins = form.overtimeEnabled
        ? Math.min(480, Math.max(1, parseInt(form.overtimeThresholdMinutes, 10) || 30))
        : null;
      const body: Record<string, unknown> = isTauri
        ? {
            name: form.name.trim(),
            description: form.description.trim() || "",
            breakTime: breakMinutes > 0 ? `${breakMinutes} min` : "",
            gracePeriodEnabled: form.gracePeriodEnabled,
            gracePeriodMinutes: graceMins,
            overtimeEnabled: form.overtimeEnabled,
            overtimeThresholdMinutes: overtimeMins,
            status: form.status,
          }
        : (() => {
            const b: Record<string, unknown> = {
              name: form.name,
              description: form.description.trim() || null,
              status: form.status,
              isActive: form.status === "active",
              startTime: form.shiftStarts,
              endTime: form.shiftEnds,
              gracePeriodEnabled: form.gracePeriodEnabled,
              gracePeriodMinutes: graceMins,
              overtimeEnabled: form.overtimeEnabled,
              overtimeThresholdMinutes: overtimeMins,
              breakEnabled: breakMinutes > 0,
            };
            if (breakMinutes > 0) {
              b.breakStartTime = form.breakStarts;
              b.breakEndTime = breakEnds || addMinutesToTime(form.breakStarts, breakMinutes);
              b.breakGracePeriodMinutes = 10;
              b.breakTime = `${breakMinutes} min`;
            } else {
              b.breakStartTime = null;
              b.breakEndTime = null;
              b.breakGracePeriodMinutes = null;
              b.breakTime = null;
            }
            return b;
          })();
      const res = await apiFetch(`/api/v1/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? t("toast.shiftUpdateError"));
      }
      const updated = (await res.json()) as ShiftRow;
      setShift(updated);
      setForm(shiftToForm(updated));
      toast.success(t("toast.shiftUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.shiftUpdateError"));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const el = tabRefs.current[activeTab];
    if (el?.parentElement) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle({ left: rect.left - parent.left, width: rect.width });
    }
  }, [activeTab]);

  useEffect(() => {
    const el = tabRefs.current.details;
    if (el?.parentElement && indicatorStyle.width === 0) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle({ left: rect.left - parent.left, width: rect.width });
    }
  }, [shift?.id, indicatorStyle.width]);

  if (loading) {
    return (
      <DashboardLayout title={t("nav.shifts")}>
        <div className="w-full max-w-none">
          <div className="rounded-2xl bg-fms-surface border border-fms-border p-12 text-center">
            <p className="text-fms-text-secondary m-0">{t("shifts.loading")}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }
  if (!shift) {
    return (
      <DashboardLayout title={t("nav.shifts")}>
        <div className="w-full max-w-none">
          <Link
            href="/shifts"
            className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
          >
            <IconChevronLeft className="w-4 h-4" />
            {t("shifts.backToShifts")}
          </Link>
          <div className="rounded-2xl bg-fms-surface border border-fms-border p-12 text-center">
            <p className="text-fms-text-secondary m-0">{t("shifts.shiftNotFound")}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const title = shift.name;

  return (
    <DashboardLayout title={title}>
      <div className="w-full max-w-none">
        <Link
          href="/shifts"
          className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
          aria-label={t("shifts.backToShifts")}
        >
          <IconChevronLeft className="w-4 h-4" />
          {t("shifts.backToShifts")}
        </Link>

        <div className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm">
          <div className="flex border-b border-fms-border bg-fms-bg-subtle/50 relative">
            <span
              className="absolute bottom-0 h-0.5 bg-fms-accent rounded-t transition-all duration-200 ease-out"
              style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
              aria-hidden
            />
            <button
              ref={(el) => { tabRefs.current.details = el; }}
              type="button"
              role="tab"
              aria-selected={activeTab === "details"}
              aria-controls="panel-details"
              id="tab-details"
              onClick={() => setActiveTab("details")}
              className={`px-5 py-3.5 text-sm font-medium transition-colors relative ${
                activeTab === "details"
                  ? "text-fms-text bg-fms-surface"
                  : "text-fms-text-tertiary hover:text-fms-text-secondary"
              }`}
            >
              {t("shifts.tabDetails")}
            </button>
            <button
              ref={(el) => { tabRefs.current.employees = el; }}
              type="button"
              role="tab"
              aria-selected={activeTab === "employees"}
              aria-controls="panel-employees"
              id="tab-employees"
              onClick={() => setActiveTab("employees")}
              className={`px-5 py-3.5 text-sm font-medium transition-colors relative ${
                activeTab === "employees"
                  ? "text-fms-text bg-fms-surface"
                  : "text-fms-text-tertiary hover:text-fms-text-secondary"
              }`}
            >
              {t("shifts.tabEmployees")} ({employees.length})
            </button>
          </div>

          <div className="p-6 sm:p-8">
            {activeTab === "details" && (
              <div
                id="panel-details"
                role="tabpanel"
                aria-labelledby="tab-details"
                className="transition-opacity duration-200"
              >
                <form onSubmit={handleSave} className="space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                      <label htmlFor="detail-name" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.shiftName")}
                      </label>
                      <input
                        id="detail-name"
                        type="text"
                        value={form.name}
                        onChange={(e) => updateForm("name", e.target.value)}
                        placeholder="e.g. Morning"
                        className={`${inputBase} ${errors.name ? inputError : ""}`}
                      />
                      {errors.name && <p className="mt-1.5 text-sm text-red-500">{errors.name}</p>}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="detail-description" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("shifts.shiftDescription")}
                    </label>
                    <textarea
                      id="detail-description"
                      value={form.description}
                      onChange={(e) => updateForm("description", e.target.value)}
                      rows={3}
                      className={`${inputBase} resize-y min-h-[80px]`}
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    <div>
                      <label htmlFor="detail-starts" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.shiftStarts")}
                      </label>
                      <input
                        id="detail-starts"
                        type="time"
                        value={form.shiftStarts}
                        onChange={(e) => updateForm("shiftStarts", e.target.value)}
                        className={inputBase}
                      />
                    </div>
                    <div>
                      <label htmlFor="detail-ends" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.shiftEnds")}
                      </label>
                      <input
                        id="detail-ends"
                        type="time"
                        value={form.shiftEnds}
                        onChange={(e) => updateForm("shiftEnds", e.target.value)}
                        className={inputBase}
                      />
                    </div>
                    <div className="w-full">
                      <label htmlFor="detail-grace-minutes" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.gracePeriodDuration")}
                      </label>
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <span className="text-sm text-fms-text-tertiary">{t("shifts.enableGracePeriod")}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={form.gracePeriodEnabled}
                          aria-label={t("shifts.enableGracePeriod")}
                          onClick={() => setForm((prev) => ({ ...prev, gracePeriodEnabled: !prev.gracePeriodEnabled }))}
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
                            id="detail-grace-minutes"
                            type="number"
                            min={1}
                            max={120}
                            value={form.gracePeriodMinutes}
                            onChange={(e) => updateForm("gracePeriodMinutes", e.target.value)}
                            className={`${inputBase} w-full`}
                          />
                          <p className="text-xs text-fms-text-tertiary">1–120 {t("shifts.minutes")}</p>
                        </div>
                      )}
                    </div>
                    <div className="w-full">
                      <label htmlFor="detail-overtime-threshold" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.enableOvertime")}
                      </label>
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <span className="text-sm text-fms-text-tertiary">{t("shifts.enableOvertime")}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={form.overtimeEnabled}
                          aria-label={t("shifts.enableOvertime")}
                          onClick={() => setForm((prev) => ({ ...prev, overtimeEnabled: !prev.overtimeEnabled }))}
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
                            id="detail-overtime-threshold"
                            type="number"
                            min={1}
                            max={480}
                            value={form.overtimeThresholdMinutes}
                            onChange={(e) => updateForm("overtimeThresholdMinutes", e.target.value)}
                            className={`${inputBase} w-full`}
                          />
                          <p className="text-xs text-fms-text-tertiary">1–480 {t("shifts.minutes")}</p>
                        </div>
                      )}
                    </div>
                    <div>
                      <label htmlFor="detail-break-dur" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.breakTimeDuration")}
                      </label>
                      <input
                        id="detail-break-dur"
                        type="number"
                        min={0}
                        max={120}
                        value={form.breakDuration}
                        onChange={(e) => updateForm("breakDuration", e.target.value)}
                        className={inputBase}
                      />
                    </div>
                    <div>
                      <label htmlFor="detail-break-starts" className="block text-sm font-medium text-fms-text mb-1.5">
                        {t("shifts.breakStarts")}
                      </label>
                      <input
                        id="detail-break-starts"
                        type="time"
                        value={form.breakStarts}
                        onChange={(e) => updateForm("breakStarts", e.target.value)}
                        className={inputBase}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="detail-break-ends" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("shifts.breakEnds")}
                    </label>
                    <input
                      id="detail-break-ends"
                      type="time"
                      value={breakEnds}
                      readOnly
                      disabled
                      className={`${inputBase} bg-fms-bg-subtle cursor-not-allowed opacity-90`}
                    />
                    <p className="mt-1.5 text-xs text-fms-text-tertiary">{t("shifts.breakEndsHint")}</p>
                  </div>

                  <div>
                    <span className="block text-sm font-medium text-fms-text mb-1.5">{t("shifts.status")}</span>
                    <div
                      role="group"
                      aria-label={t("shifts.status")}
                      className="fms-status-toggle-group"
                    >
                      <button
                        type="button"
                        onClick={() => updateForm("status", "active")}
                        className={"fms-status-toggle-btn" + (form.status === "active" ? " fms-status-toggle-btn-active" : "")}
                      >
                        {t("shifts.active")}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateForm("status", "inactive")}
                        className={"fms-status-toggle-btn" + (form.status === "inactive" ? " fms-status-toggle-btn-active" : "")}
                      >
                        {t("shifts.inactive")}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 pt-2 border-t border-fms-border">
                    <button
                      type="submit"
                      disabled={saving}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {saving ? t("shifts.saving") : t("employees.saveChanges")}
                    </button>
                    <button
                      type="button"
                      onClick={() => shift && setForm(shiftToForm(shift))}
                      className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle"
                    >
                      {t("employees.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteModalOpen(true)}
                      disabled={saving}
                      className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-red-500/60 text-red-600 hover:bg-red-500/10 dark:text-red-400 dark:border-red-400/60 dark:hover:bg-red-400/10"
                      aria-label={t("shifts.deleteShift")}
                    >
                      {t("shifts.deleteShift")}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {activeTab === "employees" && (
              <div
                id="panel-employees"
                role="tabpanel"
                aria-labelledby="tab-employees"
                className="transition-opacity duration-200"
              >
                {employees.length === 0 ? (
                  <div className="py-12 text-center text-sm text-fms-text-tertiary rounded-xl bg-fms-bg-subtle/30">
                    {t("shifts.noEmployeesInShift")}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-fms-border">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                            {t("shifts.employeeName")}
                          </th>
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                            {t("shifts.zone")}
                          </th>
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                            {t("employees.status")}
                          </th>
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                            {t("employees.active")}
                          </th>
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                            {t("shifts.joinedDate")}
                          </th>
                          <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left w-24">
                            {t("employees.quickActions")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {employees.map((emp) => (
                          <tr
                            key={emp.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => push(`/employees/${emp.id}`)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                push(`/employees/${emp.id}`);
                              }
                            }}
                            className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors cursor-pointer"
                            aria-label={`${t("shifts.view")} ${emp.name}`}
                          >
                            <td className="py-3.5 px-4 font-medium text-fms-text">{emp.name}</td>
                            <td className="py-3.5 px-4 text-fms-text-secondary">{emp.zone}</td>
                            <td className="py-3.5 px-4">
                              <Badge variant={emp.status === "checked-in" ? "success" : "purple"}>
                                {emp.status === "checked-in" ? t("employees.checkedIn") : t("employees.checkedOut")}
                              </Badge>
                            </td>
                            <td className="py-3.5 px-4">
                              <Badge variant={emp.isActive ? "success" : "danger"}>
                                {emp.isActive ? t("employees.active") : t("employees.inactive")}
                              </Badge>
                            </td>
                            <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                              {formatDate(emp.joinedDate)}
                            </td>
                            <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                              <Link
                                href={`/employees/${emp.id}`}
                                className="inline-flex items-center px-3 py-1.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle transition-colors"
                              >
                                {t("shifts.view")}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Delete shift confirmation modal */}
        {deleteModalOpen && (
          <div
            className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 transition-opacity duration-200 ${deleteModalClosing ? "opacity-0" : "opacity-100"}`}
            onClick={(e) => e.target === e.currentTarget && closeDeleteModal()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeDeleteModal();
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shift-delete-modal-title"
            aria-describedby="shift-delete-modal-desc"
          >
            <div
              className={`w-full max-w-md rounded-2xl bg-fms-surface border border-fms-border shadow-xl p-6 transition-transform duration-200 ${deleteModalClosing ? "scale-95" : "scale-100"}`}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="shift-delete-modal-title" className="text-lg font-semibold text-fms-text mb-2">
                {t("shifts.confirmDeleteTitle")}
              </h2>
              <p id="shift-delete-modal-desc" className="text-sm text-fms-text-secondary mb-6">
                {t("shifts.confirmDeleteMessage", { name: shift.name })}
                {employees.length > 0 && (
                  <span className="block mt-2 text-amber-600 dark:text-amber-400">
                    {t("shifts.confirmDeleteEmployeesWarning", { count: employees.length })}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-3 justify-end">
                <button
                  type="button"
                  onClick={closeDeleteModal}
                  disabled={deleting}
                  className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle disabled:opacity-60"
                >
                  {t("employees.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                  className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deleting ? t("shifts.deleting") : t("shifts.deleteShift")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
