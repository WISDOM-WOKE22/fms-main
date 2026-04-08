"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft, IconChevronRight, IconSearch, IconPlus, IconCamera, IconMapPin } from "@/core/layout/icons";
import { Badge, Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import type { ZoneRow, ZoneStatus, ZoneConfig, CameraVendor, StreamType } from "@/modules/zones/types";
import {
  MAX_ZONES_PER_LOCATION,
  createEmptyZone,
  normalizeZoneZones,
  isDvrMode,
  buildRtspPreview,
  VENDOR_OPTIONS,
  STREAM_TYPE_OPTIONS,
} from "@/modules/zones/types";
import styles from "./ZoneModal.module.css";

const ZONE_COUNT_OPTIONS = Array.from({ length: MAX_ZONES_PER_LOCATION + 1 }, (_, i) => i);

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];
const MODAL_CLOSE_DURATION = 220;

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function matchesSearch(zone: ZoneRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    zone.name.toLowerCase().includes(q) ||
    zone.createdBy.toLowerCase().includes(q)
  );
}

type TestState = { status: "idle" | "testing" | "success" | "error"; message?: string; latencyMs?: number };

export default function ZonesPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [zones, setZones] = useState<ZoneRow[]>([]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch("/api/v1/zones")
      .then((res) => res.json())
      .then((data: ZoneRow[]) => {
        if (mounted && Array.isArray(data)) {
          setZones(data.map((z: ZoneRow & { subZones?: ZoneConfig[] }) => ({ ...z, zones: z.zones ?? (z as any).subZones ?? [] })));
        }
      })
      .catch(() => {
        if (mounted) setZones([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, []);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");

  type ZoneModalMode = "view" | "edit";
  const [zoneModalZoneId, setZoneModalZoneId] = useState<string | null>(null);
  const [zoneModalClosing, setZoneModalClosing] = useState(false);
  const [savingZone, setSavingZone] = useState(false);
  const [zoneModalMode, setZoneModalMode] = useState<ZoneModalMode>("view");
  const [editForm, setEditForm] = useState<{
    name: string;
    status: ZoneStatus;
    numberOfZones: number;
    zones: ZoneConfig[];
  }>({
    name: "",
    status: "active",
    numberOfZones: 0,
    zones: [],
  });
  const [editTestStates, setEditTestStates] = useState<Record<number, TestState>>({});

  const filteredZones = useMemo(
    () => zones.filter((z) => matchesSearch(z, searchQuery)),
    [zones, searchQuery]
  );

  const totalPages = Math.max(1, Math.ceil(filteredZones.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedRows = useMemo(
    () => filteredZones.slice(start, start + rowsPerPage),
    [filteredZones, start, rowsPerPage]
  );

  const zoneModalZone = useMemo(
    () => (zoneModalZoneId ? zones.find((z) => z.id === zoneModalZoneId) ?? null : null),
    [zones, zoneModalZoneId]
  );
  const zoneModalZones = useMemo(
    () => normalizeZoneZones(zoneModalZone?.zones),
    [zoneModalZone]
  );

  const closeZoneModal = useCallback(() => {
    setZoneModalClosing(true);
    setTimeout(() => {
      setZoneModalZoneId(null);
      setZoneModalMode("view");
      setZoneModalClosing(false);
      setEditTestStates({});
    }, MODAL_CLOSE_DURATION);
  }, []);

  const openZoneModal = useCallback((zone: ZoneRow, mode: ZoneModalMode = "view") => {
    setZoneModalZoneId(zone.id);
    setZoneModalMode(mode);
    const zones = normalizeZoneZones(zone.zones);
    setEditForm({
      name: zone.name,
      status: zone.status,
      numberOfZones: zones.length,
      zones,
    });
    setZoneModalClosing(false);
    setEditTestStates({});
  }, []);

  const switchToEdit = useCallback(() => {
    if (zoneModalZone) setZoneModalMode("edit");
  }, [zoneModalZone]);

  const switchToView = useCallback(() => {
    if (zoneModalZone) {
      const zones = normalizeZoneZones(zoneModalZone.zones);
      setEditForm({
        name: zoneModalZone.name,
        status: zoneModalZone.status,
        numberOfZones: zones.length,
        zones,
      });
      setZoneModalMode("view");
      setEditTestStates({});
    }
  }, [zoneModalZone]);

  const saveZone = useCallback(async () => {
    if (!zoneModalZoneId) return;
    const name = editForm.name.trim();
    if (!name) return;
    setSavingZone(true);
    const zones = editForm.zones.slice(0, editForm.numberOfZones).map((zone) => ({
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
    try {
      const res = await apiFetch(`/api/v1/zones/${zoneModalZoneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, status: editForm.status, zones }),
      });
      if (!res.ok) throw new Error("Update failed");
      toast.success(t("toast.zoneUpdated"));
      setZones((prev) =>
        prev.map((z) =>
          z.id === zoneModalZoneId
            ? { ...z, name, status: editForm.status, zones }
            : z
        )
      );
      closeZoneModal();
    } catch {
      toast.error(t("toast.zoneUpdateError"));
    } finally {
      setSavingZone(false);
    }
  }, [zoneModalZoneId, editForm, closeZoneModal, t]);

  const setEditNumberOfZones = useCallback((n: number) => {
    const num = Math.min(MAX_ZONES_PER_LOCATION, Math.max(0, n));
    setEditForm((prev) => {
      const nextZones = Array(num)
        .fill(null)
        .map((_, i) => prev.zones[i] ?? createEmptyZone(i));
      return { ...prev, numberOfZones: num, zones: nextZones };
    });
  }, []);

  const setEditZoneField = useCallback((index: number, field: keyof ZoneConfig, value: string | number) => {
    setEditForm((prev) => {
      const next = [...prev.zones];
      next[index] = { ...(next[index] ?? createEmptyZone(index)), [field]: value };
      if (field === "dvrIp") {
        next[index].ip = value as string;
      }
      return { ...prev, zones: next };
    });
  }, []);

  const editGenerateRtsp = useCallback((index: number) => {
    setEditForm((prev) => {
      const next = [...prev.zones];
      const zone = next[index];
      if (zone && isDvrMode(zone)) {
        next[index] = { ...zone, rtsp: buildRtspPreview(zone) };
      }
      return { ...prev, zones: next };
    });
  }, []);

  const editTestConnection = useCallback(async (index: number) => {
    const zone = editForm.zones[index];
    if (!zone) return;
    setEditTestStates((prev) => ({ ...prev, [index]: { status: "testing" } }));
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
        setEditTestStates((prev) => ({
          ...prev,
          [index]: { status: "success", latencyMs: data.latencyMs },
        }));
      } else {
        setEditTestStates((prev) => ({
          ...prev,
          [index]: { status: "error", message: data.errorMessage || "Connection failed" },
        }));
      }
    } catch {
      setEditTestStates((prev) => ({
        ...prev,
        [index]: { status: "error", message: "Request failed" },
      }));
    }
  }, [editForm.zones]);

  useEffect(() => {
    if (!zoneModalZoneId || zoneModalClosing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeZoneModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoneModalZoneId, zoneModalClosing, closeZoneModal]);

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));
  const editZonesComplete = editForm.zones
    .slice(0, editForm.numberOfZones)
    .every((zone) => zone.name.trim() && (zone.rtsp.trim() || isDvrMode(zone)));

  return (
    <DashboardLayout title={t("nav.zones")}>
      <div className="w-full max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("zones.pageDescription")}</p>
          <Link
            href="/zones/new"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
            aria-label={t("zones.createZone")}
          >
            <IconPlus className="w-5 h-5" aria-hidden />
            {t("zones.createZone")}
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
                placeholder={t("zones.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="w-full pl-9 pr-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                aria-label={t("zones.searchPlaceholder")}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={8} showCheckbox={false} />
            ) : zones.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">
                  {t("zones.noZonesCreated")}
                </p>
                <p className="text-sm text-fms-text-tertiary mb-6 max-w-sm mx-auto">
                  {t("zones.noZonesCreatedDesc")}
                </p>
                <Link
                  href="/zones/new"
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                  aria-label={t("zones.createZone")}
                >
                  <IconPlus className="w-5 h-5" aria-hidden />
                  {t("zones.createZone")}
                </Link>
              </div>
            ) : paginatedRows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">
                {t("zones.noResults")}
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.zoneName")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.zones")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.assignedShifts")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.assignedEmployees")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.createdBy")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.status")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("zones.dateCreated")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left w-0">
                      {t("zones.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row) => (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openZoneModal(row, "view")}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openZoneModal(row, "view"); } }}
                      className={`border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors ${styles.rowClickable}`}
                    >
                      <td className="py-3.5 px-4 font-medium text-fms-text">
                        {row.name}
                      </td>
                      <td className={"py-3.5 px-4 " + styles.camerasCell}>
                        {(() => {
                          const rowZones = normalizeZoneZones(row.zones);
                          return rowZones.length === 0 ? (
                            t("zones.noZonesInLocation")
                          ) : (
                            <div className={styles.camerasCellContent}>
                              <span className={styles.cameraCountBadge}>
                                {t("zones.zoneCountDisplay", { count: rowZones.length })}
                              </span>
                              <span className={styles.cameraNamesSub}>
                                {rowZones.map((z) => z.name).join(", ")}
                              </span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {row.assignedShifts}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {row.assignedEmployees}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">
                        {row.createdBy}
                      </td>
                      <td className="py-3.5 px-4">
                        <Badge
                          variant={row.status === "active" ? "success" : "danger"}
                        >
                          {row.status === "active"
                            ? t("zones.active")
                            : t("zones.inactive")}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {formatDate(row.dateCreated)}
                      </td>
                      <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                        <div className={styles.actionCell}>
                          <button
                            type="button"
                            onClick={() => openZoneModal(row, "view")}
                            className={styles.editBtn}
                            aria-label={t("zones.viewZone")}
                          >
                            {t("zones.view")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filteredZones.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border bg-fms-bg-subtle/20">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">{t("zones.rowsPerPage")}</label>
                  <Select
                    value={rowsPerPage}
                    onChange={(e) => {
                      setRowsPerPage(Number(e.target.value));
                      setPage(1);
                    }}
                    selectSize="sm"
                    className="min-w-[72px]"
                    aria-label={t("zones.rowsPerPage")}
                  >
                    {ROWS_PER_PAGE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="text-sm text-fms-text-secondary">
                  {t("zones.pageOf", { current: page, total: totalPages })}
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
                  {t("zones.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("zones.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Zone modal (View + Edit in one) */}
      {zoneModalZoneId && zoneModalZone && (
        <div
          className={styles.overlay + (zoneModalClosing ? " " + styles.overlayClosing : "")}
          onClick={(e) => e.target === e.currentTarget && closeZoneModal()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="zone-modal-title"
        >
          <div
            className={styles.modal + (zoneModalClosing ? " " + styles.modalClosing : "")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalInner}>
              <div className={styles.modalHeader}>
                <h2 id="zone-modal-title" className={styles.modalTitle}>
                  {zoneModalZone.name}
                </h2>
                <div className={styles.modeTabs} role="tablist" aria-label={t("zones.zoneDetails")}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={zoneModalMode === "view"}
                    aria-controls="zone-panel-view"
                    id="zone-tab-view"
                    className={styles.modeTab + (zoneModalMode === "view" ? " " + styles.modeTabActive : "")}
                    onClick={() => setZoneModalMode("view")}
                  >
                    {t("zones.view")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={zoneModalMode === "edit"}
                    aria-controls="zone-panel-edit"
                    id="zone-tab-edit"
                    className={styles.modeTab + (zoneModalMode === "edit" ? " " + styles.modeTabActive : "")}
                    onClick={() => setZoneModalMode("edit")}
                  >
                    {t("zones.editZone")}
                  </button>
                </div>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeZoneModal}
                  aria-label={t("zones.close")}
                >
                  ×
                </button>
              </div>

              {zoneModalMode === "view" && (
                <div
                  id="zone-panel-view"
                  role="tabpanel"
                  aria-labelledby="zone-tab-view"
                  className={styles.modalBody + " " + styles.modalBodyView}
                >
                  <div className={styles.viewGrid}>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.zoneName")}</span>
                      <p className={styles.value}>{zoneModalZone.name}</p>
                    </div>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.status")}</span>
                      <p className={styles.value}>
                        {zoneModalZone.status === "active" ? t("zones.active") : t("zones.inactive")}
                      </p>
                    </div>
                    <div className={styles.viewField + " " + styles.viewGridFull}>
                      <span className={styles.label}>{t("zones.zones")}</span>
                      {zoneModalZones.length === 0 ? (
                        <p className={styles.noCameras}>{t("zones.noZonesInLocation")}</p>
                      ) : (
                        <ul className={styles.cameraList}>
                          {zoneModalZones.map((zone, idx) => (
                            <li key={idx} className={styles.cameraChip}>
                              <IconCamera className={styles.cameraChipIcon} aria-hidden />
                              <span className="block font-medium text-fms-text">{zone.name || t("zones.zoneNameFallback", { number: idx + 1 })}</span>
                              {zone.vendor && zone.vendor !== "generic" && (
                                <span className="block text-xs text-fms-accent font-medium capitalize">{zone.vendor}</span>
                              )}
                              <span className="block text-sm text-fms-text-secondary">{t("zones.cameraIp")}: {zone.dvrIp || zone.ip || "\u2014"}</span>
                              <span className="block text-sm text-fms-text-secondary">{t("zones.rtspUrl")}: {zone.rtsp || "\u2014"}</span>
                              {zone.vendor && zone.vendor !== "generic" && (
                                <>
                                  <span className="block text-xs text-fms-text-tertiary">
                                    {t("zones.channelId")}: {zone.channelId || 1} | {t("zones.streamType")}: {zone.streamType || "main"}
                                  </span>
                                </>
                              )}
                              {zone.hasPassword && (
                                <span className="block text-xs text-fms-text-tertiary">{t("zones.passwordStored")}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.assignedShifts")}</span>
                      <p className={styles.value}>{zoneModalZone.assignedShifts}</p>
                    </div>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.assignedEmployees")}</span>
                      <p className={styles.value}>{zoneModalZone.assignedEmployees}</p>
                    </div>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.createdBy")}</span>
                      <p className={styles.value}>{zoneModalZone.createdBy}</p>
                    </div>
                    <div className={styles.viewField}>
                      <span className={styles.label}>{t("zones.dateCreated")}</span>
                      <p className={styles.value}>{formatDate(zoneModalZone.dateCreated)}</p>
                    </div>
                  </div>
                  <div className={styles.actions + " " + styles.actionsView}>
                    <button type="button" className={styles.btnSecondary} onClick={closeZoneModal}>
                      {t("zones.close")}
                    </button>
                    <button type="button" className={styles.btnPrimary} onClick={switchToEdit}>
                      {t("zones.editZone")}
                    </button>
                  </div>
                </div>
              )}

              {zoneModalMode === "edit" && (
                <div
                  id="zone-panel-edit"
                  role="tabpanel"
                  aria-labelledby="zone-tab-edit"
                  className={styles.modalBody + " " + styles.modalBodyEdit}
                >
                  <div className={styles.editSection}>
                    <h3 className={styles.sectionTitle}>{t("zones.basicInfo")}</h3>
                    <div className={styles.field}>
                      <label htmlFor="edit-zone-name" className={styles.label}>
                        {t("zones.zoneName")}
                      </label>
                      <input
                        id="edit-zone-name"
                        type="text"
                        className={styles.input}
                        value={editForm.name}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder={t("zones.zoneNamePlaceholder")}
                        disabled={savingZone}
                      />
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("zones.status")}</span>
                      <div
                        role="group"
                        aria-label={t("zones.status")}
                        className="fms-status-toggle-group"
                      >
                        <button
                          type="button"
                          onClick={() => setEditForm((f) => ({ ...f, status: "active" }))}
                          disabled={savingZone}
                          className={"fms-status-toggle-btn" + (editForm.status === "active" ? " fms-status-toggle-btn-active" : "") + (savingZone ? " opacity-70 cursor-not-allowed" : "")}
                        >
                          {t("zones.active")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditForm((f) => ({ ...f, status: "inactive" }))}
                          disabled={savingZone}
                          className={"fms-status-toggle-btn" + (editForm.status === "inactive" ? " fms-status-toggle-btn-active" : "") + (savingZone ? " opacity-70 cursor-not-allowed" : "")}
                        >
                          {t("zones.inactive")}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className={styles.editSection}>
                    <h3 className={styles.sectionTitle}>
                      <IconMapPin className={styles.sectionTitleIcon} aria-hidden />
                      {t("zones.zones")}
                    </h3>
                    <div className={styles.field}>
                      <label htmlFor="edit-number-of-zones" className={styles.label}>
                        {t("zones.numberOfZones")}
                      </label>
                      <Select
                        id="edit-number-of-zones"
                        value={editForm.numberOfZones}
                        onChange={(e) => setEditNumberOfZones(Number(e.target.value))}
                        className="w-full"
                        aria-describedby="edit-number-of-zones-hint"
                        disabled={savingZone}
                      >
                        {ZONE_COUNT_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n === 0 ? t("zones.noZones") : t("zones.zoneCountOption", { count: n })}
                          </option>
                        ))}
                      </Select>
                      <p id="edit-number-of-zones-hint" className={styles.fieldHint}>
                        {t("zones.numberOfZonesHint")}
                      </p>
                    </div>
                    {editForm.numberOfZones > 0 && (
                      <div className={styles.cameraFieldsWrap}>
                        {editForm.zones.slice(0, editForm.numberOfZones).map((zone, i) => (
                          <EditZoneCameraCard
                            key={i}
                            index={i}
                            zone={zone}
                            disabled={savingZone}
                            testState={editTestStates[i] || { status: "idle" }}
                            onFieldChange={setEditZoneField}
                            onGenerateRtsp={editGenerateRtsp}
                            onTestConnection={editTestConnection}
                            t={t}
                            styles={styles}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={switchToView}
                      disabled={savingZone}
                    >
                      {t("employees.cancel")}
                    </button>
                    <button
                      type="button"
                      className={`${styles.btnPrimary} inline-flex items-center justify-center gap-2`}
                      onClick={saveZone}
                      disabled={!editForm.name.trim() || !editZonesComplete || savingZone}
                    >
                      {savingZone && (
                        <span
                          className="size-4 border-2 border-current border-r-transparent rounded-full animate-spin shrink-0"
                          aria-hidden
                        />
                      )}
                      {savingZone ? t("zones.saving") : t("zones.saveZone")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

/** Edit-mode zone camera card with DVR fields in the modal. */
function EditZoneCameraCard({
  index,
  zone,
  disabled,
  testState,
  onFieldChange,
  onGenerateRtsp,
  onTestConnection,
  t,
  styles: s,
}: {
  index: number;
  zone: ZoneConfig;
  disabled: boolean;
  testState: TestState;
  onFieldChange: (index: number, field: keyof ZoneConfig, value: string | number) => void;
  onGenerateRtsp: (index: number) => void;
  onTestConnection: (index: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  styles: Record<string, string>;
}) {
  const [showAdvanced, setShowAdvanced] = useState(isDvrMode(zone));
  const preview = isDvrMode(zone) ? buildRtspPreview(zone) : "";

  return (
    <div className={s.cameraSelectRow}>
      <div className={s.cameraRowHeader}>
        <p className={s.cameraSelectLabel}>
          {t("zones.zoneCardLabel", { number: index + 1 })}
        </p>
        <span className={s.subZonePill}>{t("zones.zoneShort", { number: index + 1 })}</span>
      </div>
      <div className="space-y-2">
        {/* Zone name */}
        <label htmlFor={`edit-zone-name-${index}`} className={s.label}>
          {t("zones.subZoneName")}
        </label>
        <input
          id={`edit-zone-name-${index}`}
          type="text"
          value={zone.name ?? ""}
          onChange={(e) => onFieldChange(index, "name", e.target.value)}
          placeholder={t("zones.subZoneNamePlaceholder", { number: index + 1 })}
          className={s.input}
          disabled={disabled}
        />

        {/* DVR toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs font-medium text-fms-accent hover:text-fms-accent-hover transition-colors"
        >
          {showAdvanced ? "- " : "+ "}{t("zones.dvrAdvancedMode")}
        </button>

        {showAdvanced ? (
          <div className="space-y-2 rounded-xl border border-fms-border bg-fms-bg-subtle/30 p-2.5">
            {/* Vendor */}
            <label htmlFor={`edit-vendor-${index}`} className={s.label}>{t("zones.vendor")}</label>
            <select
              id={`edit-vendor-${index}`}
              value={zone.vendor || "generic"}
              onChange={(e) => onFieldChange(index, "vendor", e.target.value)}
              disabled={disabled}
              className="w-full px-2 py-1.5 rounded-lg text-sm text-fms-text bg-fms-surface border border-fms-border"
            >
              {VENDOR_OPTIONS.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>

            {/* DVR IP + Port */}
            <div className="grid grid-cols-[1fr_4rem] gap-2">
              <div>
                <label htmlFor={`edit-dvr-ip-${index}`} className={s.label}>{t("zones.dvrIp")}</label>
                <input
                  id={`edit-dvr-ip-${index}`}
                  type="text"
                  value={zone.dvrIp || ""}
                  onChange={(e) => onFieldChange(index, "dvrIp", e.target.value)}
                  placeholder={t("zones.dvrIpPlaceholder")}
                  className={s.input}
                  disabled={disabled}
                />
              </div>
              <div>
                <label htmlFor={`edit-rtsp-port-${index}`} className={s.label}>{t("zones.rtspPort")}</label>
                <input
                  id={`edit-rtsp-port-${index}`}
                  type="number"
                  value={zone.rtspPort || 554}
                  onChange={(e) => onFieldChange(index, "rtspPort", Number(e.target.value) || 554)}
                  className={s.input}
                  disabled={disabled}
                />
              </div>
            </div>

            {/* Channel + Stream (non-generic) */}
            {zone.vendor !== "generic" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`edit-channel-${index}`} className={s.label}>{t("zones.channelId")}</label>
                  <input
                    id={`edit-channel-${index}`}
                    type="number"
                    min={1}
                    value={zone.channelId || 1}
                    onChange={(e) => onFieldChange(index, "channelId", Math.max(1, Number(e.target.value) || 1))}
                    className={s.input}
                    disabled={disabled}
                  />
                </div>
                <div>
                  <label htmlFor={`edit-stream-type-${index}`} className={s.label}>{t("zones.streamType")}</label>
                  <select
                    id={`edit-stream-type-${index}`}
                    value={zone.streamType || "main"}
                    onChange={(e) => onFieldChange(index, "streamType", e.target.value)}
                    disabled={disabled}
                    className="w-full px-2 py-1.5 rounded-lg text-sm text-fms-text bg-fms-surface border border-fms-border"
                  >
                    {STREAM_TYPE_OPTIONS.map((st) => (
                      <option key={st.value} value={st.value}>{st.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Generic path */}
            {zone.vendor === "generic" && (
              <>
                <label htmlFor={`edit-rtsp-path-${index}`} className={s.label}>{t("zones.rtspPath")}</label>
                <input
                  id={`edit-rtsp-path-${index}`}
                  type="text"
                  value={zone.rtspPath || ""}
                  onChange={(e) => onFieldChange(index, "rtspPath", e.target.value)}
                  placeholder={t("zones.rtspPathPlaceholder")}
                  className={s.input}
                  disabled={disabled}
                />
              </>
            )}

            {/* Credentials */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`edit-username-${index}`} className={s.label}>{t("zones.username")}</label>
                <input
                  id={`edit-username-${index}`}
                  type="text"
                  value={zone.username || ""}
                  onChange={(e) => onFieldChange(index, "username", e.target.value)}
                  placeholder={t("zones.usernamePlaceholder")}
                  className={s.input}
                  disabled={disabled}
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor={`edit-password-${index}`} className={s.label}>{t("zones.password")}</label>
                <input
                  id={`edit-password-${index}`}
                  type="password"
                  value={zone.password || ""}
                  onChange={(e) => onFieldChange(index, "password", e.target.value)}
                  placeholder={zone.hasPassword ? t("zones.passwordStored") : t("zones.passwordPlaceholder")}
                  className={s.input}
                  disabled={disabled}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {/* Generate + Preview */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onGenerateRtsp(index)}
                disabled={disabled}
                className="px-2.5 py-1 rounded-lg text-xs font-medium text-fms-accent border border-fms-accent hover:bg-fms-accent hover:text-white transition-colors disabled:opacity-50"
              >
                {t("zones.generateRtsp")}
              </button>
              {preview && (
                <code className="flex-1 text-xs text-fms-text-secondary bg-fms-bg-subtle px-1.5 py-0.5 rounded truncate">
                  {preview}
                </code>
              )}
            </div>
          </div>
        ) : (
          <>
            <label htmlFor={`edit-camera-ip-${index}`} className={s.label}>
              {t("zones.cameraIp")}
            </label>
            <input
              id={`edit-camera-ip-${index}`}
              type="text"
              value={zone.ip ?? ""}
              onChange={(e) => onFieldChange(index, "ip", e.target.value)}
              placeholder={t("zones.cameraIpPlaceholder")}
              className={s.input}
              disabled={disabled}
            />
            <label htmlFor={`edit-camera-rtsp-${index}`} className={s.label}>
              {t("zones.rtspUrl")}
            </label>
            <input
              id={`edit-camera-rtsp-${index}`}
              type="text"
              value={zone.rtsp ?? ""}
              onChange={(e) => onFieldChange(index, "rtsp", e.target.value)}
              placeholder={t("zones.rtspUrlPlaceholder")}
              className={s.input}
              disabled={disabled}
            />
          </>
        )}

        {/* Test Connection */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onTestConnection(index)}
            disabled={disabled || testState.status === "testing" || (!zone.rtsp?.trim() && !isDvrMode(zone))}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-fms-border text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testState.status === "testing" && (
              <span className="size-3 border-2 border-current border-r-transparent rounded-full animate-spin" aria-hidden />
            )}
            {testState.status === "testing" ? t("zones.testing") : t("zones.testConnection")}
          </button>
          {testState.status === "success" && (
            <span className="text-xs text-green-600 font-medium">
              {t("zones.testSuccess")} {testState.latencyMs != null && `(${testState.latencyMs}ms)`}
            </span>
          )}
          {testState.status === "error" && (
            <span className="text-xs text-red-500 font-medium truncate">
              {testState.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
