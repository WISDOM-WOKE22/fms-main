"use client";

import { useState, useCallback, useEffect, useRef, useMemo, useImperativeHandle, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/core/api/request";
import { IconCamera, IconSearch, IconX } from "@/core/layout/icons";
import { CameraLivePlayer } from "@/core/ui";
import type { PlayerState, AiDetectionResult } from "@/core/ui";
import type { ZoneConfig } from "@/modules/zones/types";
import s from "./StreamTesterModal.module.css";

export interface StreamTesterHandle {
  open: (cam?: { locationName: string; camera: ZoneConfig }) => void;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ZoneWithCameras {
  id: string;
  name: string;
  zones: ZoneConfig[];
}

const MODAL_CLOSE_DURATION = 220;

/* ------------------------------------------------------------------ */
/*  Card (sits on Settings > Configurations tab)                       */
/* ------------------------------------------------------------------ */

const StreamTesterCard = forwardRef<StreamTesterHandle>(function StreamTesterCard(_props, ref) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalClosing, setModalClosing] = useState(false);
  const [testCamera, setTestCamera] = useState<{ locationName: string; camera: ZoneConfig } | null>(null);

  const openModal = useCallback((initialCam?: { locationName: string; camera: ZoneConfig }) => {
    setTestCamera(initialCam ?? null);
    setModalOpen(true);
    setModalClosing(false);
  }, []);

  const closeModal = useCallback(() => {
    setModalClosing(true);
    setTimeout(() => {
      setModalOpen(false);
      setModalClosing(false);
      setTestCamera(null);
    }, MODAL_CLOSE_DURATION);
  }, []);

  useImperativeHandle(ref, () => ({ open: openModal }), [openModal]);

  return (
    <>
      <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full mt-6">
        <div className="p-5 border-b border-fms-border bg-fms-bg-subtle/20">
          <h2 className="text-base font-semibold text-fms-text m-0 flex items-center gap-2">
            <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
              <IconCamera className="w-5 h-5" aria-hidden />
            </span>
            {t("settings.streamTesterTitle")}
          </h2>
          <p className="text-sm text-fms-text-secondary mt-2 m-0">
            {t("settings.streamTesterDescription")}
          </p>
        </div>
        <div className="p-5">
          <button
            type="button"
            onClick={() => openModal()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out"
          >
            <IconCamera className="w-4 h-4" aria-hidden />
            {t("settings.streamTesterOpen")}
          </button>
        </div>
      </section>

      {modalOpen && (
        <StreamTesterModal closing={modalClosing} onClose={closeModal} initialCamera={testCamera} />
      )}
    </>
  );
});

export default StreamTesterCard;

/* ------------------------------------------------------------------ */
/*  Modal                                                              */
/* ------------------------------------------------------------------ */

function StreamTesterModal({
  closing,
  onClose,
  initialCamera,
}: {
  closing: boolean;
  onClose: () => void;
  /** Pre-select a camera on open (e.g. from "Test Stream" on a camera card). */
  initialCamera?: { locationName: string; camera: ZoneConfig } | null;
}) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);

  const [locations, setLocations] = useState<ZoneWithCameras[]>([]);
  const [checkInOutCameras, setCheckInOutCameras] = useState<{ id: string; name: string; type: string; rtspIp: string }[]>([]);
  const [onboardingCam, setOnboardingCam] = useState<{ name: string; rtspIp: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const [selectedCamera, setSelectedCamera] = useState<{
    locationName: string;
    camera: ZoneConfig;
  } | null>(null);

  // The camera passed to the player — only set after selection, null-ed to stop
  const [activeCamera, setActiveCamera] = useState<ZoneConfig | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>({ status: "idle" });

  // AI recognition state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFrames, setAiFrames] = useState(0);
  const [aiRecognized, setAiRecognized] = useState(0);
  const [aiLastAt, setAiLastAt] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // AI overlay canvas + grace cache (keeps boxes visible for 2s after last update)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const cachedResultsRef = useRef<{ items: AiDetectionResult[]; at: number }>({ items: [], at: 0 });
  const GRACE_MS = 2000;

  /* ---- data ---- */

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      apiFetch("/api/v1/zones").then((r) => r.json()).catch(() => []),
      apiFetch("/api/v1/settings/cameras").then((r) => r.json()).catch(() => ({})),
    ]).then(([zonesData, camerasData]) => {
      if (!alive) return;
      if (Array.isArray(zonesData))
        setLocations(zonesData.filter((z: ZoneWithCameras) => Array.isArray(z.zones) && z.zones.length > 0));
      const cd = camerasData as { checkInOutCameras?: { id: string; name: string; type: string; rtspIp: string }[]; onboardingCamera?: { name: string; rtspIp: string } | null };
      if (Array.isArray(cd.checkInOutCameras)) setCheckInOutCameras(cd.checkInOutCameras);
      if (cd.onboardingCamera) setOnboardingCam(cd.onboardingCamera);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => searchRef.current?.focus(), 120);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Pre-select initial camera if provided
  const initialAppliedRef = useRef(false);
  useEffect(() => {
    if (initialCamera && !initialAppliedRef.current && !loading) {
      initialAppliedRef.current = true;
      setSelectedCamera(initialCamera);
      setActiveCamera(initialCamera.camera);
    }
  }, [initialCamera, loading]);

  // Stop stream when modal closes
  useEffect(() => {
    if (closing) setActiveCamera(null);
  }, [closing]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter(
      (loc) => loc.name.toLowerCase().includes(q) || loc.zones.some((z) => z.name.toLowerCase().includes(q))
    );
  }, [locations, searchQuery]);

  // Convert check-in/out and onboarding cameras to ZoneConfig for the player
  const extraCameras = useMemo(() => {
    const items: { group: string; label: string; cam: ZoneConfig }[] = [];
    for (const c of checkInOutCameras) {
      const typeLabel = c.type === "check_in" ? "Check-In" : "Check-Out";
      items.push({
        group: typeLabel,
        label: c.name,
        cam: { name: c.name, ip: "", rtsp: c.rtspIp } as ZoneConfig,
      });
    }
    if (onboardingCam) {
      items.push({
        group: "Onboarding",
        label: onboardingCam.name,
        cam: { name: onboardingCam.name, ip: "", rtsp: onboardingCam.rtspIp } as ZoneConfig,
      });
    }
    return items;
  }, [checkInOutCameras, onboardingCam]);

  const filteredExtras = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return extraCameras;
    return extraCameras.filter((e) => e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q));
  }, [extraCameras, searchQuery]);

  const selectCamera = useCallback((locationName: string, camera: ZoneConfig) => {
    setSelectedCamera({ locationName, camera });
    setActiveCamera(camera);
  }, []);

  const clearSelection = useCallback(() => {
    setActiveCamera(null);
    setSelectedCamera(null);
    setPlayerState({ status: "idle" });
    setAiEnabled(false);
    setAiRunning(false);
    setAiError(null);
    setAiFrames(0);
    setAiRecognized(0);
    setAiLastAt(null);
  }, []);

  const toggleAi = useCallback(async () => {
    const sid = playerState.streamId;
    if (!sid) return;
    const next = !aiEnabled;
    try {
      const res = await apiFetch(`/api/v1/streams/${sid}/ai/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) {
        const data = (await res.json()) as { aiEnabled?: boolean; aiRunning?: boolean };
        setAiEnabled(data.aiEnabled ?? next);
        setAiRunning(data.aiRunning ?? false);
        if (!next) { setAiError(null); }
      }
    } catch { /* ignore toggle errors */ }
  }, [playerState.streamId, aiEnabled]);

  // Sync AI state from status polling
  useEffect(() => {
    if (playerState.aiEnabled !== undefined) setAiEnabled(playerState.aiEnabled);
    if (playerState.aiRunning !== undefined) setAiRunning(playerState.aiRunning);
    if (playerState.aiError !== undefined) setAiError(playerState.aiError ?? null);
    if (playerState.aiFramesProcessed !== undefined) setAiFrames(playerState.aiFramesProcessed);
    if (playerState.aiRecognizedCount !== undefined) setAiRecognized(playerState.aiRecognizedCount);
    if (playerState.aiLastAt !== undefined) setAiLastAt(playerState.aiLastAt ?? null);
  }, [playerState]);

  // Update grace cache when new AI results arrive
  useEffect(() => {
    const results = playerState.aiResults;
    if (results && results.length > 0) {
      cachedResultsRef.current = { items: results, at: Date.now() };
    }
  }, [playerState.aiResults]);

  // Draw AI overlay boxes on canvas
  useEffect(() => {
    if (!aiEnabled) {
      // Clear canvas when AI disabled
      const canvas = overlayCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    let raf: number;
    const draw = () => {
      const canvas = overlayCanvasRef.current;
      const wrap = videoWrapRef.current;
      if (!canvas || !wrap) { raf = requestAnimationFrame(draw); return; }

      // Find the video element inside the wrapper
      const video = wrap.querySelector("video");
      const ctx = canvas.getContext("2d");
      if (!ctx || !video) { raf = requestAnimationFrame(draw); return; }

      // Size canvas to match the displayed video area
      const rect = video.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      ctx.clearRect(0, 0, cw, ch);

      const cached = cachedResultsRef.current;
      const age = Date.now() - cached.at;
      if (!cached.items.length || age > GRACE_MS) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // Map AI coords (in source video pixels) to canvas pixels
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      // object-fit:contain — compute the displayed area within the element
      const videoAspect = vw / vh;
      const elemAspect = rect.width / rect.height;
      let scaleX: number, scaleY: number, offsetX: number, offsetY: number;
      if (videoAspect > elemAspect) {
        // Video is wider — bars on top/bottom
        scaleX = (rect.width * dpr) / vw;
        scaleY = scaleX;
        offsetX = 0;
        offsetY = (ch - vh * scaleY) / 2;
      } else {
        // Video is taller — bars on left/right
        scaleY = (rect.height * dpr) / vh;
        scaleX = scaleY;
        offsetY = 0;
        offsetX = (cw - vw * scaleX) / 2;
      }

      const clampX = (v: number) => Math.max(0, Math.min(cw, v * scaleX + offsetX));
      const clampY = (v: number) => Math.max(0, Math.min(ch, v * scaleY + offsetY));
      // Fade out near end of grace period
      const alpha = age > GRACE_MS * 0.7 ? Math.max(0.2, 1 - (age - GRACE_MS * 0.7) / (GRACE_MS * 0.3)) : 1;
      ctx.globalAlpha = alpha;

      for (const det of cached.items) {
        const recognized = det.status === "recognized";
        const isCached = det.trackCached === true;
        // Green for recognized, amber for unknown, cyan tint for cached
        const color = recognized ? (isCached ? "#06b6d4" : "#22c55e") : "#f59e0b";

        // Draw person bbox (dashed) if present
        const pbox = det.personBbox;
        if (pbox && pbox.length === 4) {
          const px1 = clampX(pbox[0]), py1 = clampY(pbox[1]);
          const px2 = clampX(pbox[2]), py2 = clampY(pbox[3]);
          ctx.save();
          ctx.strokeStyle = recognized ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.2)";
          ctx.lineWidth = 1.5 * dpr;
          ctx.setLineDash([6 * dpr, 4 * dpr]);
          ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);
          ctx.restore();
        }

        // Draw face bbox (solid)
        const bbox = det.bbox;
        if (!bbox || bbox.length !== 4) continue;
        const x1 = clampX(bbox[0]), y1 = clampY(bbox[1]);
        const x2 = clampX(bbox[2]), y2 = clampY(bbox[3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([]);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        // Label with track info
        const last4 = det.personId ? det.personId.slice(-4).toUpperCase() : "";
        const trackLabel = det.trackId != null && det.trackId >= 0 ? `T${det.trackId}` : "";
        const cachedLabel = isCached ? " [cached]" : "";
        const scoreLabel = det.score != null ? ` ${Math.round(det.score * 100)}%` : "";
        const label = recognized
          ? `${det.name ?? "Person"} | ${last4}${scoreLabel}${cachedLabel}`
          : `Unknown${scoreLabel}`;

        const fontSize = Math.round(13 * dpr);
        ctx.font = `600 ${fontSize}px sans-serif`;
        const textW = ctx.measureText(label).width;
        const padX = 6 * dpr;
        const padY = 4 * dpr;
        const labelY = Math.max(0, y1 - fontSize - padY * 2 - 2 * dpr);

        ctx.fillStyle = color;
        ctx.fillRect(x1, labelY, textW + padX * 2, fontSize + padY * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, x1 + padX, labelY + fontSize + padY - 1);

        // Track ID badge (small, bottom-left of person box)
        if (trackLabel && pbox && pbox.length === 4) {
          const tFontSize = Math.round(10 * dpr);
          ctx.font = `700 ${tFontSize}px sans-serif`;
          const tw = ctx.measureText(trackLabel).width;
          const tx = clampX(pbox[0]) + 2 * dpr;
          const ty = clampY(pbox[3]) - 4 * dpr;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(tx, ty - tFontSize - 2 * dpr, tw + 6 * dpr, tFontSize + 4 * dpr);
          ctx.fillStyle = "#a5f3fc";
          ctx.fillText(trackLabel, tx + 3 * dpr, ty - 2 * dpr);
        }
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [aiEnabled]);

  const isLive = playerState.status === "online";
  const isConnecting = playerState.status === "starting" || playerState.status === "connecting";
  const isReconnecting = playerState.status === "reconnecting";
  const isError = playerState.status === "error";
  const isNoFfmpeg = playerState.status === "no-ffmpeg";

  /* ---- render ---- */

  if (!mounted) return null;

  return createPortal(
    <div
      className={
        s.overlay +
        (closing ? " " + s.overlayClosing : "") +
        " flex items-center justify-center animate-in fade-in duration-200"
      }
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stream-tester-title"
    >
      <div
        className={s.modal + (closing ? " " + s.modalClosing : "")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={s.header}>
          <div className={s.headerLeft}>
            <span className={s.headerIcon}>
              <IconCamera className="w-5 h-5" aria-hidden />
            </span>
            <div>
              <h2 id="stream-tester-title" className={s.headerTitle}>{t("settings.streamTesterTitle")}</h2>
              <p className={s.headerSubtitle}>{t("settings.streamTesterModalHint")}</p>
            </div>
          </div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label={t("zones.close")}>
            <IconX className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className={s.body}>
          {/* Sidebar */}
          <div className={s.sidebar}>
            <div className={s.searchWrap}>
              <div style={{ position: "relative" }}>
                <IconSearch className={s.searchIcon} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  placeholder={t("settings.streamTesterSearch")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={s.searchInput}
                  aria-label={t("settings.streamTesterSearch")}
                />
              </div>
            </div>
            <div className={s.sidebarList}>
              {loading ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "2.5rem 0" }}>
                  <span className={s.spinner} style={{ width: "1.25rem", height: "1.25rem" }} />
                </div>
              ) : filtered.length === 0 ? (
                <p style={{ textAlign: "center", padding: "2rem 1rem", fontSize: "0.8125rem", color: "var(--fms-text-tertiary)", margin: 0 }}>
                  {searchQuery.trim() ? t("settings.streamTesterNoResults") : t("settings.streamTesterNoCameras")}
                </p>
              ) : (
                <>
                  {filtered.map((loc) => (
                    <LocationGroup key={loc.id} location={loc} selectedCamera={selectedCamera} onSelect={selectCamera} t={t} />
                  ))}
                  {/* Check-in/out and onboarding cameras */}
                  {filteredExtras.length > 0 && (
                    <>
                      {/* Group by type */}
                      {(["Check-In", "Check-Out", "Onboarding"] as const).map((group) => {
                        const items = filteredExtras.filter((e) => e.group === group);
                        if (!items.length) return null;
                        return (
                          <div key={group}>
                            <div style={{ padding: "8px 14px 4px", fontSize: "0.6875rem", fontWeight: 700, color: "var(--fms-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                              {group} {group === "Onboarding" ? "Camera" : "Cameras"}
                            </div>
                            {items.map((item, idx) => {
                              const isSelected = selectedCamera?.locationName === item.group && selectedCamera?.camera.name === item.cam.name;
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  className={s.cameraBtn + (isSelected ? " " + s.cameraBtnSelected : "")}
                                  onClick={() => selectCamera(item.group, item.cam)}
                                >
                                  <span className={s.cameraBtnIcon}>
                                    <IconCamera className="w-3.5 h-3.5" />
                                  </span>
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <p className={s.cameraBtnName}>{item.label}</p>
                                    <p className={s.cameraBtnMeta}>{item.cam.rtsp || "\u2014"}</p>
                                  </div>
                                  <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "1px 6px", borderRadius: 6, background: group === "Check-In" ? "rgba(34,197,94,0.12)" : group === "Check-Out" ? "rgba(245,158,11,0.12)" : "rgba(99,102,241,0.12)", color: group === "Check-In" ? "#4ade80" : group === "Check-Out" ? "#fbbf24" : "#818cf8" }}>
                                    {group}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Canvas */}
          <div className={s.canvas}>
            {!selectedCamera ? (
              <div className={s.emptyState}>
                <div className={s.emptyStateInner}>
                  <div className={s.emptyStateIcon}>
                    <IconCamera className="w-7 h-7 text-fms-text-tertiary" />
                  </div>
                  <p className={s.emptyStateTitle}>{t("settings.streamTesterSelectPrompt")}</p>
                  <p className={s.emptyStateHint}>{t("settings.streamTesterSelectHint")}</p>
                </div>
              </div>
            ) : (
              <div className={s.canvasInner}>
                {/* Camera info */}
                <div className={s.cameraInfo}>
                  <div className={s.cameraInfoLeft}>
                    <p className={s.cameraInfoLocation}>{selectedCamera.locationName}</p>
                    <p className={s.cameraInfoName}>{selectedCamera.camera.name}</p>
                    {selectedCamera.camera.vendor && selectedCamera.camera.vendor !== "generic" && (
                      <span style={{ display: "inline-block", marginTop: 2, fontSize: "0.6875rem", fontWeight: 600, color: "var(--fms-accent)", textTransform: "capitalize" as const }}>
                        {selectedCamera.camera.vendor}
                        {selectedCamera.camera.channelId ? ` Ch.${selectedCamera.camera.channelId}` : ""}
                        {selectedCamera.camera.streamType ? ` (${selectedCamera.camera.streamType})` : ""}
                      </span>
                    )}
                  </div>
                  <div className={s.cameraInfoRight}>
                    {isLive && (
                      <span className={s.liveBadge}>
                        <span className={s.liveDot} />
                        Live
                      </span>
                    )}
                    {isReconnecting && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.6875rem", fontWeight: 600, color: "var(--fms-text-tertiary)" }}>
                        <span className={s.spinner} style={{ width: "0.75rem", height: "0.75rem", borderWidth: 1.5, borderColor: "var(--fms-text-tertiary)", borderTopColor: "var(--fms-accent)" }} />
                        Reconnecting
                      </span>
                    )}
                    <button type="button" className={s.closeBtn} onClick={clearSelection} aria-label="Close">
                      <IconX className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Video viewport */}
                <div className={s.videoWrap} ref={videoWrapRef} style={{ position: "relative" }}>
                  {/* AI overlay canvas — positioned over the video */}
                  <canvas
                    ref={overlayCanvasRef}
                    style={{
                      position: "absolute", top: 0, left: 0,
                      width: "100%", height: "100%",
                      pointerEvents: "none", zIndex: 2,
                    }}
                  />
                  {/* HLS video player (hidden until online) */}
                  <CameraLivePlayer
                    camera={activeCamera}
                    zoneId={selectedCamera ? locations.find(l => l.name === selectedCamera.locationName)?.id : undefined}
                    cameraId={selectedCamera ? `${selectedCamera.locationName}::${selectedCamera.camera.name}` : undefined}
                    onStatusChange={setPlayerState}
                    className={s.videoImg}
                  />

                  {/* Overlays for non-live states */}
                  {(isConnecting || isReconnecting) && (
                    <div className={s.videoOverlay}>
                      <div className={s.videoPlaceholder}>
                        <div className={s.videoPlaceholderIcon} style={{ background: "rgba(255,255,255,0.07)" }}>
                          <span className={s.spinner} style={{ width: "1.5rem", height: "1.5rem" }} />
                        </div>
                        <p className={s.videoPlaceholderTitle} style={{ color: "rgba(255,255,255,0.8)" }}>
                          {isReconnecting ? t("settings.streamTesterReconnecting") : t("settings.streamTesterConnecting")}
                        </p>
                        <p className={s.videoPlaceholderHint} style={{ color: "rgba(255,255,255,0.35)" }}>
                          {playerState.errorMessage || t("settings.streamTesterTestingHint")}
                        </p>
                      </div>
                    </div>
                  )}

                  {isError && (
                    <div className={s.videoOverlay}>
                      <div className={s.videoPlaceholder}>
                        <div className={s.videoPlaceholderIcon} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                          <svg className="w-6 h-6" style={{ color: "#f87171" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </div>
                        <p className={s.videoPlaceholderTitle} style={{ color: "#f87171" }}>{t("settings.streamTesterFailed")}</p>
                        <p className={s.videoPlaceholderHint} style={{ color: "rgba(255,255,255,0.35)" }}>{playerState.errorMessage}</p>
                        <button
                          type="button"
                          className={s.retryBtn}
                          onClick={() => { setActiveCamera(null); setTimeout(() => setActiveCamera(selectedCamera?.camera ?? null), 50); }}
                        >
                          {t("settings.streamTesterRetest")}
                        </button>
                      </div>
                    </div>
                  )}

                  {isNoFfmpeg && (
                    <div className={s.videoOverlay}>
                      <div className={s.videoPlaceholder}>
                        <div className={s.videoPlaceholderIcon} style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)" }}>
                          <svg className="w-6 h-6" style={{ color: "#fbbf24" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                        <p className={s.videoPlaceholderTitle} style={{ color: "#fbbf24" }}>{t("settings.streamTesterNoFfmpeg")}</p>
                        <p className={s.videoPlaceholderHint} style={{ color: "rgba(255,255,255,0.35)" }}>{t("settings.streamTesterNoFfmpegHint")}</p>
                      </div>
                    </div>
                  )}

                  {playerState.status === "idle" && !activeCamera && (
                    <div className={s.videoOverlay}>
                      <div className={s.videoPlaceholder}>
                        <div className={s.videoPlaceholderIcon} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                          <IconCamera className="w-6 h-6 opacity-15" />
                        </div>
                        <p className={s.videoPlaceholderTitle} style={{ color: "rgba(255,255,255,0.35)" }}>
                          {t("settings.streamTesterReadyPrompt")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* AI Recognition panel */}
                {isLive && (
                  <div style={{ padding: "8px 12px", borderTop: "1px solid var(--fms-border)", background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={toggleAi}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "5px 14px", borderRadius: 12, fontSize: "0.75rem", fontWeight: 600,
                        border: "1px solid",
                        borderColor: aiEnabled ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.12)",
                        background: aiEnabled ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.04)",
                        color: aiEnabled ? "#4ade80" : "rgba(255,255,255,0.55)",
                        cursor: "pointer", transition: "all 0.2s",
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: aiRunning ? "#4ade80" : aiEnabled ? "#fbbf24" : "rgba(255,255,255,0.2)" }} />
                      {aiEnabled ? "AI On" : "AI Off"}
                    </button>
                    {aiEnabled && (
                      <>
                        <span style={{ fontSize: "0.6875rem", color: "rgba(255,255,255,0.45)" }}>
                          Frames: {aiFrames} &bull; Recognized: {aiRecognized}
                        </span>
                        {playerState.aiLatencyMs != null && (
                          <span style={{ fontSize: "0.6875rem", color: "rgba(255,255,255,0.45)" }}>
                            {playerState.aiLatencyMs}ms
                          </span>
                        )}
                        {playerState.aiCachedCount != null && playerState.aiCachedCount > 0 && (
                          <span style={{ fontSize: "0.6875rem", padding: "1px 6px", borderRadius: 6, background: "rgba(6,182,212,0.15)", color: "#22d3ee" }}>
                            {playerState.aiCachedCount} cached
                          </span>
                        )}
                        {playerState.aiTrackStats && (
                          <span style={{ fontSize: "0.6875rem", color: "rgba(255,255,255,0.35)" }}>
                            Tracks: {playerState.aiTrackStats.totalTracks} ({playerState.aiTrackStats.identifiedTracks} ID)
                          </span>
                        )}
                        {aiLastAt && (
                          <span style={{ fontSize: "0.6875rem", color: "rgba(255,255,255,0.35)" }}>
                            Last: {new Date(aiLastAt).toLocaleTimeString()}
                          </span>
                        )}
                        {aiError && (
                          <span style={{ fontSize: "0.6875rem", color: "#f87171" }}>
                            {aiError.length > 60 ? aiError.slice(0, 60) + "…" : aiError}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Bottom bar */}
                <div className={s.bottomBar}>
                  <code className={s.bottomBarUrl}>
                    {playerState.rtspUrlMasked || "\u00a0"}
                  </code>
                  <div className={s.bottomBarActions}>
                    {playerState.uptimeSeconds != null && isLive && (
                      <span className={s.statusText} style={{ color: "var(--fms-text-tertiary)" }}>
                        {formatUptime(playerState.uptimeSeconds)}
                      </span>
                    )}
                    {playerState.reconnectCount != null && playerState.reconnectCount > 0 && (
                      <span className={s.statusText} style={{ color: "var(--fms-text-tertiary)" }}>
                        Reconnects: {playerState.reconnectCount}
                      </span>
                    )}
                    {isLive && (
                      <button type="button" className={s.stopBtn} onClick={clearSelection}>
                        <span className={s.stopIcon} />
                        {t("settings.streamTesterStop")}
                      </button>
                    )}
                    {isError && (
                      <button
                        type="button"
                        className={s.playBtn}
                        onClick={() => { setActiveCamera(null); setTimeout(() => setActiveCamera(selectedCamera?.camera ?? null), 50); }}
                      >
                        <IconCamera className="w-3.5 h-3.5" />
                        {t("settings.streamTesterRetest")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar: location group                                            */
/* ------------------------------------------------------------------ */

function LocationGroup({
  location,
  selectedCamera,
  onSelect,
  t,
}: {
  location: ZoneWithCameras;
  selectedCamera: { locationName: string; camera: ZoneConfig } | null;
  onSelect: (locationName: string, camera: ZoneConfig) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button type="button" className={s.locationBtn} onClick={() => setExpanded(!expanded)}>
        <svg className={s.chevron + (expanded ? " " + s.chevronExpanded : "")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className={s.locationName}>{location.name}</span>
        <span className={s.locationCount}>{location.zones.length}</span>
      </button>
      {expanded && (
        <div className={s.cameraGroup}>
          {location.zones.map((cam, idx) => {
            const isSelected =
              selectedCamera?.locationName === location.name &&
              selectedCamera?.camera.name === cam.name &&
              selectedCamera?.camera.ip === cam.ip;
            return (
              <button
                key={idx}
                type="button"
                className={s.cameraBtn + (isSelected ? " " + s.cameraBtnSelected : "")}
                onClick={() => onSelect(location.name, cam)}
              >
                <span className={s.cameraBtnIcon}>
                  <IconCamera className="w-3.5 h-3.5" />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p className={s.cameraBtnName}>{cam.name || t("zones.zoneNameFallback", { number: idx + 1 })}</p>
                  <p className={s.cameraBtnMeta}>{cam.dvrIp || cam.ip || cam.rtsp || "\u2014"}</p>
                </div>
                {cam.vendor && cam.vendor !== "generic" && (
                  <span className={s.vendorPill}>{cam.vendor}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatUptime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
