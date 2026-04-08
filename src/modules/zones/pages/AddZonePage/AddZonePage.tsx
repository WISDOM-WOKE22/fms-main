"use client";

import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft, IconMapPin } from "@/core/layout/icons";
import { Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import type { ZoneStatus, ZoneConfig, CameraVendor, StreamType } from "@/modules/zones/types";
import {
  MAX_ZONES_PER_LOCATION,
  createEmptyZone,
  isDvrMode,
  buildRtspPreview,
  VENDOR_OPTIONS,
  STREAM_TYPE_OPTIONS,
} from "@/modules/zones/types";

interface FormState {
  name: string;
  status: ZoneStatus;
  numberOfZones: number;
  zones: ZoneConfig[];
}

const initialForm: FormState = {
  name: "",
  status: "active",
  numberOfZones: 0,
  zones: [],
};

type TestState = { status: "idle" | "testing" | "success" | "error"; message?: string; latencyMs?: number };

export default function AddZonePage() {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<{ name?: string; zones?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [testStates, setTestStates] = useState<Record<number, TestState>>({});

  const update = (key: keyof FormState, value: string | number) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "numberOfZones") {
        const n = Math.min(MAX_ZONES_PER_LOCATION, Math.max(0, Number(value) || 0));
        const nextZones = Array(n)
          .fill(null)
          .map((_, i) => prev.zones[i] ?? createEmptyZone(i));
        next.zones = nextZones;
      }
      return next;
    });
    if (key === "name" && errors.name) {
      setErrors((prev) => ({ ...prev, name: undefined }));
    }
    if (key === "numberOfZones" && errors.zones) {
      setErrors((prev) => ({ ...prev, zones: undefined }));
    }
  };

  const setZoneField = useCallback((index: number, field: keyof ZoneConfig, value: string | number) => {
    setForm((prev) => {
      const next = [...prev.zones];
      next[index] = { ...(next[index] ?? createEmptyZone(index)), [field]: value };
      // Auto-populate ip from dvrIp for backward compat
      if (field === "dvrIp") {
        next[index].ip = value as string;
      }
      return { ...prev, zones: next };
    });
    if (errors.zones) setErrors((prev) => ({ ...prev, zones: undefined }));
  }, [errors.zones]);

  const generateRtsp = useCallback((index: number) => {
    setForm((prev) => {
      const next = [...prev.zones];
      const zone = next[index];
      if (zone && isDvrMode(zone)) {
        const preview = buildRtspPreview(zone);
        // For the actual URL we need the backend, but we can set the preview
        next[index] = { ...zone, rtsp: preview };
      }
      return { ...prev, zones: next };
    });
  }, []);

  const testConnection = useCallback(async (index: number) => {
    const zone = form.zones[index];
    if (!zone) return;
    setTestStates((prev) => ({ ...prev, [index]: { status: "testing" } }));
    try {
      const body: Record<string, unknown> = {};
      if (isDvrMode(zone)) {
        body.vendor = zone.vendor || "generic";
        body.dvrIp = zone.dvrIp || zone.ip;
        body.rtspPort = zone.rtspPort || 554;
        body.channelId = zone.channelId || 1;
        body.streamType = zone.streamType || "main";
        body.username = zone.username || "";
        body.password = zone.password || "";
        body.rtspPath = zone.rtspPath || "";
      } else {
        body.vendor = "generic";
        body.rtsp = zone.rtsp;
      }
      const res = await apiFetch("/api/v1/zones/cameras/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStates((prev) => ({
          ...prev,
          [index]: { status: "success", latencyMs: data.latencyMs },
        }));
      } else {
        setTestStates((prev) => ({
          ...prev,
          [index]: { status: "error", message: data.errorMessage || "Connection failed" },
        }));
      }
    } catch {
      setTestStates((prev) => ({
        ...prev,
        [index]: { status: "error", message: "Request failed" },
      }));
    }
  }, [form.zones]);

  const zoneCountOptions = useMemo(
    () => Array.from({ length: MAX_ZONES_PER_LOCATION + 1 }, (_, i) => i),
    []
  );

  const activeZones = form.zones.slice(0, form.numberOfZones);

  const validate = (): boolean => {
    const next: { name?: string; zones?: string } = {};
    if (!form.name.trim()) next.name = t("zones.validationZoneName");
    const hasIncompleteZone = activeZones.some(
      (zone) => !zone.name.trim() || (!zone.rtsp.trim() && !isDvrMode(zone))
    );
    if (hasIncompleteZone) next.zones = t("zones.validationZones");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const zones = activeZones.map((zone) => ({
        name: zone.name.trim(),
        ip: zone.dvrIp?.trim() || zone.ip.trim(),
        rtsp: zone.rtsp.trim(),
        vendor: zone.vendor || "generic",
        dvrIp: zone.dvrIp?.trim() || "",
        rtspPort: zone.rtspPort || 554,
        channelId: zone.channelId || 1,
        streamType: zone.streamType || "main",
        username: zone.username?.trim() || "",
        password: zone.password || "",
        rtspPath: zone.rtspPath?.trim() || "",
      }));
      const res = await apiFetch("/api/v1/zones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          status: form.status,
          zones,
          createdBy: "current-user",
        }),
      });
      if (!res.ok) throw new Error("Create zone failed");
      toast.success(t("toast.zoneCreated"));
      setForm(initialForm);
      setErrors({});
      setTestStates({});
    } catch {
      const msg = t("toast.zoneCreateError");
      setErrors((prev) => ({ ...prev, name: msg }));
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout title={t("zones.createZone")}>
      <div className="w-full max-w-none">
        <Link
          href="/zones"
          className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
          aria-label={t("zones.backToZones")}
        >
          <IconChevronLeft className="w-4 h-4" />
          {t("zones.backToZones")}
        </Link>

        <p className="text-sm text-fms-text-secondary m-0 mb-6">{t("zones.newZoneSubtitle")}</p>

        <form onSubmit={handleSubmit} className="w-full">
          <div className="rounded-3xl border border-fms-border bg-fms-surface p-6 shadow-sm space-y-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
              <div>
                <label htmlFor="zone-name" className="block text-sm font-medium text-fms-text mb-1.5">
                  {t("zones.zoneName")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
                </label>
                <input
                  id="zone-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder={t("zones.zoneNamePlaceholder")}
                  disabled={submitting}
                  className={`w-full px-4 py-3 rounded-2xl text-sm text-fms-text bg-fms-surface border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent disabled:opacity-70 disabled:cursor-not-allowed transition-all duration-300 ${errors.name ? "border-red-500" : "border-fms-border"}`}
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? "zone-name-error" : undefined}
                />
                {errors.name && (
                  <p id="zone-name-error" className="mt-1.5 text-sm text-red-500">
                    {errors.name}
                  </p>
                )}
              </div>

              <div>
                <span className="block text-sm font-medium text-fms-text mb-1.5">
                  {t("zones.status")}
                </span>
                <div role="group" aria-label={t("zones.status")} className="fms-status-toggle-group">
                  <button
                    type="button"
                    onClick={() => update("status", "active")}
                    disabled={submitting}
                    className={"fms-status-toggle-btn" + (form.status === "active" ? " fms-status-toggle-btn-active" : "") + (submitting ? " opacity-70 cursor-not-allowed" : "")}
                  >
                    {t("zones.active")}
                  </button>
                  <button
                    type="button"
                    onClick={() => update("status", "inactive")}
                    disabled={submitting}
                    className={"fms-status-toggle-btn" + (form.status === "inactive" ? " fms-status-toggle-btn-active" : "") + (submitting ? " opacity-70 cursor-not-allowed" : "")}
                  >
                    {t("zones.inactive")}
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-fms-border bg-linear-to-br from-fms-bg-subtle/60 via-fms-surface to-fms-bg-subtle/30 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-xl">
                  <p className="mb-1 text-sm font-semibold text-fms-text flex items-center gap-2">
                    <IconMapPin className="w-4 h-4 text-fms-accent" aria-hidden />
                    {t("zones.zones")}
                  </p>
                  <p className="m-0 text-sm text-fms-text-secondary">{t("zones.numberOfZonesHint")}</p>
                </div>

                <div className="w-full lg:max-w-xs">
                  <label htmlFor="zone-number-of-zones" className="block text-sm font-medium text-fms-text mb-1.5">
                    {t("zones.numberOfZones")}
                  </label>
                  <Select
                    id="zone-number-of-zones"
                    value={form.numberOfZones}
                    onChange={(e) => update("numberOfZones", Number(e.target.value))}
                    disabled={submitting}
                    className="w-full"
                    aria-describedby="zone-number-of-zones-hint"
                  >
                    {zoneCountOptions.map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? t("zones.noZones") : t("zones.zoneCountOption", { count: n })}
                      </option>
                    ))}
                  </Select>
                  <p id="zone-number-of-zones-hint" className="mt-1.5 text-xs text-fms-text-tertiary">
                    {t("zones.numberOfZonesHint")}
                  </p>
                </div>
              </div>

              {errors.zones && (
                <p className="mt-4 text-sm text-red-500">{errors.zones}</p>
              )}

              {form.numberOfZones > 0 && (
                <div className="mt-5 grid gap-4 xl:grid-cols-2">
                  {activeZones.map((zone, index) => (
                    <ZoneCameraCard
                      key={index}
                      index={index}
                      zone={zone}
                      disabled={submitting}
                      testState={testStates[index] || { status: "idle" }}
                      onFieldChange={setZoneField}
                      onGenerateRtsp={generateRtsp}
                      onTestConnection={testConnection}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-70 disabled:cursor-not-allowed disabled:pointer-events-none transition-all duration-300"
              >
                {submitting && (
                  <span
                    className="size-4 border-2 border-white border-r-transparent rounded-full animate-spin shrink-0"
                    aria-hidden
                  />
                )}
                {submitting ? t("zones.saving") : t("zones.saveZone")}
              </button>
              <Link
                href="/zones"
                className={`inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle transition-colors duration-300 ${submitting ? "pointer-events-none opacity-60" : ""}`}
              >
                {t("employees.cancel")}
              </Link>
            </div>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}

/** Reusable zone camera card with DVR fields, RTSP preview, and test connection. */
function ZoneCameraCard({
  index,
  zone,
  disabled,
  testState,
  onFieldChange,
  onGenerateRtsp,
  onTestConnection,
  t,
}: {
  index: number;
  zone: ZoneConfig;
  disabled: boolean;
  testState: TestState;
  onFieldChange: (index: number, field: keyof ZoneConfig, value: string | number) => void;
  onGenerateRtsp: (index: number) => void;
  onTestConnection: (index: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [showAdvanced, setShowAdvanced] = useState(isDvrMode(zone));
  const preview = isDvrMode(zone) ? buildRtspPreview(zone) : zone.rtsp || "";

  return (
    <section className="group rounded-3xl border border-fms-border bg-fms-surface/95 p-4 shadow-sm transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-lg">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-fms-text-tertiary">
            {t("zones.zoneCardLabel", { number: index + 1 })}
          </p>
          <p className="mt-1 text-sm font-medium text-fms-text">{zone.name.trim() || t("zones.zoneNameFallback", { number: index + 1 })}</p>
        </div>
        <span className="inline-flex items-center justify-center rounded-2xl bg-fms-accent-muted px-3 py-1 text-xs font-semibold text-fms-accent">
          {t("zones.zoneShort", { number: index + 1 })}
        </span>
      </div>

      <div className="space-y-3">
        {/* Zone name */}
        <div>
          <label htmlFor={`zone-sub-zone-name-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1.5">
            {t("zones.subZoneName")}
          </label>
          <input
            id={`zone-sub-zone-name-${index}`}
            type="text"
            value={zone.name}
            onChange={(e) => onFieldChange(index, "name", e.target.value)}
            placeholder={t("zones.subZoneNamePlaceholder", { number: index + 1 })}
            disabled={disabled}
            className="w-full px-4 py-3 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent disabled:opacity-70 disabled:cursor-not-allowed transition-all duration-300"
          />
        </div>

        {/* DVR toggle */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs font-medium text-fms-accent hover:text-fms-accent-hover transition-colors"
          >
            {showAdvanced ? "- " : "+ "}{t("zones.dvrAdvancedMode")}
          </button>
        </div>

        {showAdvanced && (
          <div className="space-y-3 rounded-2xl border border-fms-border bg-fms-bg-subtle/30 p-3">
            {/* Vendor */}
            <div>
              <label htmlFor={`zone-vendor-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                {t("zones.vendor")}
              </label>
              <select
                id={`zone-vendor-${index}`}
                value={zone.vendor || "generic"}
                onChange={(e) => onFieldChange(index, "vendor", e.target.value as CameraVendor)}
                disabled={disabled}
                className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
              >
                {VENDOR_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-fms-text-tertiary">{t("zones.vendorHint")}</p>
            </div>

            {/* DVR IP + Port */}
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <div>
                <label htmlFor={`zone-dvr-ip-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                  {t("zones.dvrIp")}
                </label>
                <input
                  id={`zone-dvr-ip-${index}`}
                  type="text"
                  value={zone.dvrIp || ""}
                  onChange={(e) => onFieldChange(index, "dvrIp", e.target.value)}
                  placeholder={t("zones.dvrIpPlaceholder")}
                  disabled={disabled}
                  className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                />
              </div>
              <div>
                <label htmlFor={`zone-rtsp-port-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                  {t("zones.rtspPort")}
                </label>
                <input
                  id={`zone-rtsp-port-${index}`}
                  type="number"
                  value={zone.rtspPort || 554}
                  onChange={(e) => onFieldChange(index, "rtspPort", Number(e.target.value) || 554)}
                  disabled={disabled}
                  className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                />
              </div>
            </div>

            {/* Channel + Stream type (for Hikvision/Dahua) */}
            {zone.vendor !== "generic" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`zone-channel-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                    {t("zones.channelId")}
                  </label>
                  <input
                    id={`zone-channel-${index}`}
                    type="number"
                    min={1}
                    value={zone.channelId || 1}
                    onChange={(e) => onFieldChange(index, "channelId", Math.max(1, Number(e.target.value) || 1))}
                    placeholder={t("zones.channelIdPlaceholder")}
                    disabled={disabled}
                    className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                  />
                </div>
                <div>
                  <label htmlFor={`zone-stream-type-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                    {t("zones.streamType")}
                  </label>
                  <select
                    id={`zone-stream-type-${index}`}
                    value={zone.streamType || "main"}
                    onChange={(e) => onFieldChange(index, "streamType", e.target.value as StreamType)}
                    disabled={disabled}
                    className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                  >
                    {STREAM_TYPE_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Generic path */}
            {zone.vendor === "generic" && (
              <div>
                <label htmlFor={`zone-rtsp-path-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                  {t("zones.rtspPath")}
                </label>
                <input
                  id={`zone-rtsp-path-${index}`}
                  type="text"
                  value={zone.rtspPath || ""}
                  onChange={(e) => onFieldChange(index, "rtspPath", e.target.value)}
                  placeholder={t("zones.rtspPathPlaceholder")}
                  disabled={disabled}
                  className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                />
              </div>
            )}

            {/* Credentials */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`zone-username-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                  {t("zones.username")}
                </label>
                <input
                  id={`zone-username-${index}`}
                  type="text"
                  value={zone.username || ""}
                  onChange={(e) => onFieldChange(index, "username", e.target.value)}
                  placeholder={t("zones.usernamePlaceholder")}
                  disabled={disabled}
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                />
              </div>
              <div>
                <label htmlFor={`zone-password-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1">
                  {t("zones.password")}
                </label>
                <input
                  id={`zone-password-${index}`}
                  type="password"
                  value={zone.password || ""}
                  onChange={(e) => onFieldChange(index, "password", e.target.value)}
                  placeholder={zone.hasPassword ? t("zones.passwordStored") : t("zones.passwordPlaceholder")}
                  disabled={disabled}
                  autoComplete="new-password"
                  className="w-full px-3 py-2 rounded-xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted"
                />
              </div>
            </div>

            {/* RTSP Preview + Generate */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onGenerateRtsp(index)}
                disabled={disabled}
                className="px-3 py-1.5 rounded-xl text-xs font-medium text-fms-accent border border-fms-accent hover:bg-fms-accent hover:text-white transition-colors disabled:opacity-50"
              >
                {t("zones.generateRtsp")}
              </button>
              {preview && (
                <code className="flex-1 text-xs text-fms-text-secondary bg-fms-bg-subtle px-2 py-1 rounded-lg truncate">
                  {preview}
                </code>
              )}
            </div>
          </div>
        )}

        {/* Manual RTSP (always visible) */}
        {!showAdvanced && (
          <>
            <div>
              <label htmlFor={`zone-sub-zone-ip-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1.5">
                {t("zones.cameraIp")}
              </label>
              <input
                id={`zone-sub-zone-ip-${index}`}
                type="text"
                value={zone.ip}
                onChange={(e) => onFieldChange(index, "ip", e.target.value)}
                placeholder={t("zones.cameraIpPlaceholder")}
                disabled={disabled}
                className="w-full px-4 py-3 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent disabled:opacity-70 disabled:cursor-not-allowed transition-all duration-300"
              />
            </div>

            <div>
              <label htmlFor={`zone-sub-zone-rtsp-${index}`} className="block text-xs font-medium text-fms-text-secondary mb-1.5">
                {t("zones.rtspUrl")}
              </label>
              <input
                id={`zone-sub-zone-rtsp-${index}`}
                type="text"
                value={zone.rtsp}
                onChange={(e) => onFieldChange(index, "rtsp", e.target.value)}
                placeholder={t("zones.rtspUrlPlaceholder")}
                disabled={disabled}
                className="w-full px-4 py-3 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent disabled:opacity-70 disabled:cursor-not-allowed transition-all duration-300"
              />
            </div>
          </>
        )}

        {/* Test Connection button + status */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onTestConnection(index)}
            disabled={disabled || testState.status === "testing" || (!zone.rtsp.trim() && !isDvrMode(zone))}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-fms-border text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testState.status === "testing" && (
              <span className="size-3 border-2 border-current border-r-transparent rounded-full animate-spin" aria-hidden />
            )}
            {testState.status === "testing" ? t("zones.testing") : t("zones.testConnection")}
          </button>
          {testState.status === "success" && (
            <span className="text-xs text-green-600 font-medium">
              {t("zones.testSuccess")} {testState.latencyMs != null && `(${t("zones.testLatency", { ms: testState.latencyMs })})`}
            </span>
          )}
          {testState.status === "error" && (
            <span className="text-xs text-red-500 font-medium">
              {t("zones.testFailed")}: {testState.message}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
