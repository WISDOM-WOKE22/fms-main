"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/core/api/request";

// ── Types ──────────────────────────────────────────────────────────

interface AiHealth {
  ok?: boolean;
  provider?: string;
  providerConfig?: string;
  selectedProviders?: string[];
  availableProviders?: string[];
  yoloAvailable?: boolean;
  yoloEnabled?: boolean;
  maxPersonsPerFrame?: number;
  eventCooldownSeconds?: number;
  registeredFaces?: number;
  captureBackend?: string;
  gstreamerAvailable?: boolean;
  gstreamerProfile?: string;
  captureOs?: string;
  activeCaptures?: number;
  activeCaptureBackends?: string[];
  captureConfig?: { protocol?: string; latencyMs?: number; aiFps?: number; aiWidth?: number; aiHeight?: number };
}

interface AiCameraStatus {
  cameraId: string;
  zoneId: string;
  rtspUrlMasked: string;
  enabled: boolean;
  running: boolean;
  framesProcessed: number;
  recognizedCount: number;
  lastAt: string | null;
  error: string | null;
  uptimeSeconds: number;
  samplingIntervalMs: number;
}

interface AiCamerasResponse {
  cameras: AiCameraStatus[];
  totalCameras: number;
  totalFrames: number;
  totalRecognized: number;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Styles ──────────────────────────────────────────────────────────

const card = "rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full mt-6";
const cardHeader = "p-5 border-b border-fms-border bg-fms-bg-subtle/20";
const cardTitle = "text-base font-semibold text-fms-text m-0 flex items-center gap-2";
const cardBody = "p-5";
const pill = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-xs font-semibold border";

// ── Component ───────────────────────────────────────────────────────

// ── Loading skeleton ────────────────────────────────────────────────

function SkeletonCard({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <section className={card}>
      <div className={cardHeader}>
        <h2 className={cardTitle}>
          <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent" style={{ opacity: 0.4 }}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
          </span>
          <span style={{ opacity: 0.5 }}>{title}</span>
        </h2>
      </div>
      <div className={cardBody}>
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex gap-4">
              <div style={{ height: 14, borderRadius: 6, background: "var(--fms-bg-subtle)", width: "30%", animation: "pulse 1.5s ease-in-out infinite", opacity: 0.5 }} />
              <div style={{ height: 14, borderRadius: 6, background: "var(--fms-bg-subtle)", width: "50%", animation: "pulse 1.5s ease-in-out infinite", animationDelay: `${i * 0.15}s`, opacity: 0.4 }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Component ───────────────────────────────────────────────────────

export default function SystemInfoCard() {
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null);
  const [aiCameras, setAiCameras] = useState<AiCamerasResponse | null>(null);
  const [sysLoading, setSysLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // AI worker control state
  const [confirmModal, setConfirmModal] = useState<"start" | "stop" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);

  // Initial load + poll every 3 seconds
  const loadData = useCallback(() => {
    apiFetch("/api/v1/face/health").then(r => r.json()).then(d => { setAiHealth(d as AiHealth); setStatsLoading(false); }).catch(() => {});
    apiFetch("/api/v1/ai/cameras/status").then(r => r.json()).then(d => setAiCameras(d as AiCamerasResponse)).catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
    pollRef.current = setInterval(loadData, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadData]);

  const workersRunning = (aiCameras?.totalCameras ?? 0) > 0;

  const handleStartAll = useCallback(async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/v1/ai/cameras/start-all", { method: "POST" });
      loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(false); setConfirmModal(null); }
  }, [loadData]);

  const handleStopAll = useCallback(async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/v1/ai/cameras/stop-all", { method: "POST" });
      loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(false); setConfirmModal(null); }
  }, [loadData]);

  // Show skeletons while data loads
  if (sysLoading && statsLoading) {
    return (
      <>
        <SkeletonCard title="AI Camera Workers" rows={3} />
      </>
    );
  }

  return (
    <>
      {/* ── AI Camera Workers ── */}
      <section className={card}>
        <div className={cardHeader}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className={cardTitle}>
                <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </span>
                AI Camera Workers
                {aiCameras && aiCameras.totalCameras > 0 && (
                  <span style={{ marginLeft: 8, fontSize: "0.75rem", fontWeight: 600, padding: "2px 8px", borderRadius: 8, background: "rgba(34,197,94,0.1)", color: "#4ade80" }}>
                    {aiCameras.totalCameras} active
                  </span>
                )}
              </h2>
              {aiCameras && aiCameras.totalCameras > 0 && (
                <div className="flex gap-4 mt-2">
                  <p className="text-xs text-fms-text-tertiary m-0">Frames: {aiCameras.totalFrames.toLocaleString()}</p>
                  <p className="text-xs text-fms-text-tertiary m-0">Recognized: {aiCameras.totalRecognized.toLocaleString()}</p>
                </div>
              )}
            </div>
            {/* Enable / Disable button */}
            <button
              type="button"
              onClick={() => setConfirmModal(workersRunning ? "stop" : "start")}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "7px 16px", borderRadius: 12, fontSize: "0.8125rem", fontWeight: 600,
                border: "1px solid",
                borderColor: workersRunning ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)",
                background: workersRunning ? "rgba(239,68,68,0.08)" : "rgba(34,197,94,0.08)",
                color: workersRunning ? "#f87171" : "#4ade80",
                cursor: "pointer", transition: "all 0.2s", flexShrink: 0,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: workersRunning ? "#f87171" : "#4ade80" }} />
              {workersRunning ? "Disable AI" : "Enable AI"}
            </button>
          </div>
        </div>
        <div className={cardBody}>
          {!aiCameras || aiCameras.cameras.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-fms-text-tertiary m-0">No AI camera workers running</p>
              <p className="text-xs text-fms-text-tertiary m-0 mt-1">Click &ldquo;Enable AI&rdquo; above to start monitoring all configured cameras</p>
            </div>
          ) : (
            <div className="space-y-2">
              {aiCameras.cameras.map((cam) => (
                <div key={cam.cameraId} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-fms-border bg-fms-bg-subtle/30">
                  {/* Status indicator — animated pulse when running */}
                  <span style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, background: cam.framesProcessed > 0 ? "#4ade80" : cam.running && !cam.error ? "#fbbf24" : cam.error ? "#f87171" : "#666", animation: cam.running && !cam.error ? "pulse 2s infinite" : "none" }} />
                  {/* Camera info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fms-text m-0 truncate">{cam.cameraId}</p>
                    <p className="text-xs text-fms-text-tertiary m-0 truncate">
                      {cam.rtspUrlMasked}
                      {cam.zoneId && <span> · Zone: {cam.zoneId.slice(-6)}</span>}
                    </p>
                    {cam.error && (
                      <p className="text-xs m-0 mt-0.5 truncate" style={{ color: "#f87171" }}>{cam.error}</p>
                    )}
                  </div>
                  {/* Stats */}
                  <div className="text-right shrink-0">
                    <p className="text-xs text-fms-text-secondary m-0">
                      {cam.framesProcessed > 0 ? `${cam.framesProcessed} frames · ${cam.recognizedCount} recognized` : cam.running ? "Connecting..." : "—"}
                    </p>
                    <p className="text-xs text-fms-text-tertiary m-0">
                      {cam.running ? `Up ${formatUptime(cam.uptimeSeconds)}` : cam.error ? "Error" : "Stopped"}
                    </p>
                  </div>
                  {/* Status badge */}
                  <span className={pill} style={{
                    borderColor: cam.running ? "rgba(34,197,94,0.3)" : cam.error ? "rgba(239,68,68,0.3)" : "var(--fms-border)",
                    background: cam.running ? "rgba(34,197,94,0.08)" : cam.error ? "rgba(239,68,68,0.08)" : "transparent",
                    color: cam.running ? "#4ade80" : cam.error ? "#f87171" : "var(--fms-text-tertiary)",
                    flexShrink: 0,
                  }}>
                    {cam.running ? "Running" : cam.error ? "Error" : "Idle"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Confirmation Modal ── */}
      {mounted && confirmModal && createPortal(
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => { if (!actionLoading) setConfirmModal(null); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--fms-surface, #1c1c1e)", border: "1px solid var(--fms-border, #333)",
              borderRadius: 16, padding: 24, maxWidth: 420, width: "calc(100% - 2rem)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
            }}
          >
            {/* Icon */}
            <div style={{
              width: 48, height: 48, borderRadius: 12, margin: "0 auto 16px",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: confirmModal === "start" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${confirmModal === "start" ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
            }}>
              {confirmModal === "start" ? (
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#4ade80" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              ) : (
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#f87171" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
              )}
            </div>

            <h3 style={{ textAlign: "center", margin: 0, fontSize: "1rem", fontWeight: 700, color: "var(--fms-text, #fff)" }}>
              {confirmModal === "start" ? "Enable AI Workers?" : "Disable AI Workers?"}
            </h3>
            <p style={{ textAlign: "center", margin: "8px 0 0", fontSize: "0.875rem", color: "var(--fms-text-secondary, #999)", lineHeight: 1.5 }}>
              {confirmModal === "start"
                ? "This will start AI recognition workers for all configured cameras. The system will begin processing RTSP feeds and identifying persons in real time. This increases CPU and network usage."
                : "This will stop all running AI camera workers. Person recognition will be paused across all cameras. You can re-enable them at any time."
              }
            </p>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                disabled={actionLoading}
                style={{
                  padding: "8px 20px", borderRadius: 10, fontSize: "0.8125rem", fontWeight: 600,
                  border: "1px solid var(--fms-border, #333)", background: "transparent",
                  color: "var(--fms-text-secondary, #999)", cursor: "pointer",
                  opacity: actionLoading ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmModal === "start" ? handleStartAll : handleStopAll}
                disabled={actionLoading}
                style={{
                  padding: "8px 20px", borderRadius: 10, fontSize: "0.8125rem", fontWeight: 600,
                  border: "1px solid",
                  borderColor: confirmModal === "start" ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
                  background: confirmModal === "start" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                  color: confirmModal === "start" ? "#4ade80" : "#f87171",
                  cursor: actionLoading ? "wait" : "pointer",
                  opacity: actionLoading ? 0.7 : 1,
                }}
              >
                {actionLoading
                  ? (confirmModal === "start" ? "Starting..." : "Stopping...")
                  : (confirmModal === "start" ? "Yes, Enable AI" : "Yes, Disable AI")
                }
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
