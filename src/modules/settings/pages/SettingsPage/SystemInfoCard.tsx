"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
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

interface SystemInfo {
  cpuModel: string;
  cpuCores: number;
  arch: string;
  osName: string;
  osVersion: string;
  totalMemoryGB: number;
  availableMemoryGB: number;
  gpus: { name: string; vram: string; vendor: string }[];
}

// ── Helpers ─────────────────────────────────────────────────────────

const EMPTY_SYS: SystemInfo = {
  cpuModel: "Detecting...",
  cpuCores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0,
  arch: "—",
  osName: "—",
  osVersion: "",
  totalMemoryGB: 0,
  availableMemoryGB: 0,
  gpus: [],
};

/** Stable estimate — only uses fixed hardware specs (cores, total RAM, arch, GPU).
 *  Never uses fluctuating values like available memory. */
function estimateMaxCameras(
  cores: number,
  totalMemGB: number,
  hasGpu: boolean,
  arch: string,
): { max: number; rating: string; color: string } | null {
  // Don't compute until hardware data is loaded
  if (cores === 0 && totalMemGB === 0) return null;

  const isAppleSilicon = arch.includes("Apple Silicon") || arch.includes("ARM64");

  // Reserve 2 cores for OS + app
  const cpuBudget = Math.max(1, cores - 2);

  // Per-camera CPU cost depends on architecture:
  // Apple Silicon: ~0.15 core/camera (Neural Engine + CoreML offload)
  // Discrete GPU (CUDA/DML): ~0.2 core/camera
  // CPU only: ~0.4 core/camera
  const coresPerCam = isAppleSilicon ? 0.15 : hasGpu ? 0.2 : 0.4;
  const cpuMax = Math.floor(cpuBudget / coresPerCam);

  // Per-camera memory cost (from total, not available — stable):
  // Reserve 3 GB for OS + app, rest divided by per-camera cost
  const memPerCam = isAppleSilicon ? 0.15 : hasGpu ? 0.2 : 0.25;
  const memMax = totalMemGB > 3 ? Math.floor((totalMemGB - 3) / memPerCam) : 1;

  let max = Math.min(cpuMax, memMax);
  max = Math.max(1, Math.min(max, 200));

  let rating: string;
  let color: string;
  if (max >= 30) { rating = "Excellent"; color = "#22c55e"; }
  else if (max >= 15) { rating = "Good"; color = "#3b82f6"; }
  else if (max >= 5) { rating = "Moderate"; color = "#f59e0b"; }
  else { rating = "Limited"; color = "#ef4444"; }

  return { max, rating, color };
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
const sectionLabel = "text-xs font-semibold text-fms-text-tertiary uppercase tracking-wide m-0";
const sectionValue = "text-sm text-fms-text font-medium m-0 mt-0.5";
const gridRow = "grid grid-cols-2 sm:grid-cols-3 gap-4";
const pill = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-xs font-semibold border";
const dot = "w-2 h-2 rounded-full";

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
  const [sysInfo, setSysInfo] = useState<SystemInfo>(EMPTY_SYS);
  const [sysLoading, setSysLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sysLoadedRef = useRef(false);

  // Load real system info from backend (native Python process with full OS access)
  useEffect(() => {
    if (sysLoadedRef.current) return;
    sysLoadedRef.current = true;
    setSysLoading(true);
    apiFetch("/api/v1/system-info").then(r => r.json()).then((d: {
      cpu?: { model?: string; cores?: number; arch?: string; platform?: string };
      memory?: { totalGB?: number; availableGB?: number };
      gpus?: { name: string; vram: string; vendor: string }[];
      os?: { system?: string; release?: string; version?: string; machine?: string };
    }) => {
      const cpu = d.cpu ?? {};
      const mem = d.memory ?? {};
      const os = d.os ?? {};
      const system = os.system ?? "";

      let osName = system;
      if (system === "Darwin") osName = "macOS";
      else if (system === "Windows") osName = "Windows";
      else if (system === "Linux") osName = "Linux";

      let archLabel = cpu.arch ?? os.machine ?? "unknown";
      if (archLabel === "arm64" || archLabel === "aarch64") archLabel = "ARM64";
      if (archLabel === "x86_64" || archLabel === "AMD64") archLabel = "x86_64";
      // Enrich for Apple Silicon
      if (osName === "macOS" && (archLabel === "ARM64" || archLabel === "arm64")) {
        archLabel = "ARM64 (Apple Silicon)";
      }

      setSysInfo({
        cpuModel: cpu.model || "Unknown",
        cpuCores: cpu.cores || navigator.hardwareConcurrency || 0,
        arch: archLabel,
        osName,
        osVersion: os.release ?? "",
        totalMemoryGB: mem.totalGB ?? 0,
        availableMemoryGB: mem.availableGB ?? 0,
        gpus: Array.isArray(d.gpus) ? d.gpus : [],
      });
    }).catch(() => {}).finally(() => setSysLoading(false));
  }, []);

  // AI worker control state
  const [confirmModal, setConfirmModal] = useState<"start" | "stop" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);

  // Real-time system resource usage
  const [sysStats, setSysStats] = useState<{ cpuPercent?: number; memoryPercent?: number; processMemoryMB?: number; activeCaptures?: number } | null>(null);

  // Initial load + poll every 3 seconds
  const loadData = useCallback(() => {
    apiFetch("/api/v1/face/health").then(r => r.json()).then(d => { setAiHealth(d as AiHealth); setStatsLoading(false); }).catch(() => {});
    apiFetch("/api/v1/ai/cameras/status").then(r => r.json()).then(d => setAiCameras(d as AiCamerasResponse)).catch(() => {});
    apiFetch("/api/v1/system-stats").then(r => r.json()).then(d => { setSysStats(d as typeof sysStats); setStatsLoading(false); }).catch(() => {});
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

  const hasGpu = aiHealth?.provider ? aiHealth.provider !== "CPUExecutionProvider" : false;
  const providerLabel = aiHealth?.provider?.replace("ExecutionProvider", "") ?? "—";

  // Stable estimate — only recomputes when fixed hardware specs or GPU status change
  const estimate = useMemo(
    () => estimateMaxCameras(sysInfo.cpuCores, sysInfo.totalMemoryGB, hasGpu, sysInfo.arch),
    [sysInfo.cpuCores, sysInfo.totalMemoryGB, hasGpu, sysInfo.arch]
  );

  // Show skeletons while data loads
  if (sysLoading && statsLoading) {
    return (
      <>
        <SkeletonCard title="System Hardware" rows={4} />
        <SkeletonCard title="Real-Time Usage" rows={2} />
        <SkeletonCard title="AI Camera Workers" rows={3} />
        <SkeletonCard title="System Compatibility" rows={3} />
      </>
    );
  }

  return (
    <>
      {/* ── System Hardware ── */}
      <section className={card}>
        <div className={cardHeader}>
          <h2 className={cardTitle}>
            <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            </span>
            System Hardware
          </h2>
        </div>
        <div className={cardBody}>
          <div className={gridRow}>
            <div className="col-span-2 sm:col-span-3">
              <p className={sectionLabel}>CPU</p>
              <p className={sectionValue}>{sysInfo.cpuModel}</p>
            </div>
            <div>
              <p className={sectionLabel}>Cores</p>
              <p className={sectionValue}>{sysInfo.cpuCores || "—"}</p>
            </div>
            <div>
              <p className={sectionLabel}>OS</p>
              <p className={sectionValue}>{sysInfo.osName}{sysInfo.osVersion ? ` ${sysInfo.osVersion}` : ""}</p>
            </div>
            <div>
              <p className={sectionLabel}>Architecture</p>
              <p className={sectionValue}>{sysInfo.arch}</p>
            </div>
            {sysInfo.totalMemoryGB > 0 && (
              <div>
                <p className={sectionLabel}>Total Memory</p>
                <p className={sectionValue}>{sysInfo.totalMemoryGB} GB</p>
              </div>
            )}
            {sysInfo.availableMemoryGB > 0 && (
              <div>
                <p className={sectionLabel}>Available Memory</p>
                <p className={sectionValue}>{sysInfo.availableMemoryGB} GB</p>
              </div>
            )}
            <div>
              <p className={sectionLabel}>AI Provider</p>
              <p className={sectionValue}>
                <span className={pill} style={{ borderColor: hasGpu ? "rgba(34,197,94,0.3)" : "var(--fms-border)", background: hasGpu ? "rgba(34,197,94,0.08)" : "transparent", color: hasGpu ? "#4ade80" : "var(--fms-text-secondary)" }}>
                  <span className={dot} style={{ background: hasGpu ? "#4ade80" : "var(--fms-text-tertiary)" }} />
                  {providerLabel}
                </span>
              </p>
            </div>
            <div>
              <p className={sectionLabel}>Provider Mode</p>
              <p className={sectionValue}>{aiHealth?.providerConfig ?? "—"}</p>
            </div>
          </div>

          {/* GPU(s) detected from native OS */}
          {sysInfo.gpus.length > 0 && (
            <div className="mt-4 pt-4 border-t border-fms-border">
              <p className={sectionLabel + " mb-2"}>GPU{sysInfo.gpus.length > 1 ? "s" : ""}</p>
              <div className="space-y-2">
                {sysInfo.gpus.map((gpu, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-fms-border bg-fms-bg-subtle/30">
                    <span className={dot} style={{ background: "#4ade80", flexShrink: 0 }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-fms-text m-0">{gpu.name}</p>
                      <p className="text-xs text-fms-text-tertiary m-0">
                        {gpu.vendor ? `${gpu.vendor}` : ""}
                        {gpu.vram ? ` · ${gpu.vram}` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {aiHealth && Array.isArray(aiHealth.availableProviders) && aiHealth.availableProviders.length > 0 && (
            <div className="mt-4 pt-4 border-t border-fms-border">
              <p className={sectionLabel + " mb-2"}>Available Execution Providers</p>
              <div className="flex flex-wrap gap-2">
                {aiHealth.availableProviders.map((p) => {
                  const isActive = Array.isArray(aiHealth.selectedProviders) && aiHealth.selectedProviders.includes(p);
                  const label = p.replace("ExecutionProvider", "");
                  return (
                    <span key={p} className={pill} style={{ borderColor: isActive ? "rgba(99,102,241,0.3)" : "var(--fms-border)", background: isActive ? "rgba(99,102,241,0.08)" : "transparent", color: isActive ? "#818cf8" : "var(--fms-text-tertiary)" }}>
                      <span className={dot} style={{ background: isActive ? "#818cf8" : "var(--fms-text-tertiary)" }} />
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Capture backend info */}
          {aiHealth && (
            <div className="mt-4 pt-4 border-t border-fms-border">
              <p className={sectionLabel + " mb-2"}>RTSP Capture Backend</p>
              <div className={gridRow}>
                <div>
                  <p className="text-xs text-fms-text-tertiary m-0">Backend</p>
                  <p className="text-sm text-fms-text font-medium m-0 mt-0.5">
                    <span className={pill} style={{
                      borderColor: aiHealth.gstreamerAvailable ? "rgba(34,197,94,0.3)" : "var(--fms-border)",
                      background: aiHealth.gstreamerAvailable ? "rgba(34,197,94,0.08)" : "transparent",
                      color: aiHealth.gstreamerAvailable ? "#4ade80" : "var(--fms-text-secondary)",
                    }}>
                      <span className={dot} style={{ background: aiHealth.gstreamerAvailable ? "#4ade80" : "var(--fms-text-tertiary)" }} />
                      {aiHealth.gstreamerAvailable ? "GStreamer" : "OpenCV"}
                    </span>
                  </p>
                </div>
                {aiHealth.gstreamerProfile && aiHealth.gstreamerProfile !== "none" && (
                  <div>
                    <p className="text-xs text-fms-text-tertiary m-0">Pipeline Profile</p>
                    <p className="text-sm text-fms-text font-medium m-0 mt-0.5">{aiHealth.gstreamerProfile}</p>
                  </div>
                )}
                {aiHealth.captureConfig && (
                  <div>
                    <p className="text-xs text-fms-text-tertiary m-0">Capture Resolution</p>
                    <p className="text-sm text-fms-text font-medium m-0 mt-0.5">
                      {aiHealth.captureConfig.aiWidth}x{aiHealth.captureConfig.aiHeight} @ {aiHealth.captureConfig.aiFps} FPS
                    </p>
                  </div>
                )}
                {typeof aiHealth.activeCaptures === "number" && (
                  <div>
                    <p className="text-xs text-fms-text-tertiary m-0">Active Streams</p>
                    <p className="text-sm text-fms-text font-medium m-0 mt-0.5">{aiHealth.activeCaptures}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Real-Time System Usage ── */}
      <section className={card}>
        <div className={cardHeader}>
          <h2 className={cardTitle}>
            <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </span>
            Real-Time Usage
          </h2>
        </div>
        <div className={cardBody}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* CPU usage bar */}
            <div>
              <p className={sectionLabel}>CPU Usage</p>
              <div className="mt-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2.5 rounded-full bg-fms-bg-subtle overflow-hidden">
                    <div style={{ width: `${Math.min(100, sysStats?.cpuPercent ?? 0)}%`, background: (sysStats?.cpuPercent ?? 0) > 80 ? "#f87171" : (sysStats?.cpuPercent ?? 0) > 50 ? "#fbbf24" : "#4ade80", height: "100%", borderRadius: 99, transition: "width 0.5s" }} />
                  </div>
                  <span className="text-sm font-semibold text-fms-text" style={{ minWidth: 40, textAlign: "right" }}>
                    {sysStats?.cpuPercent != null ? `${sysStats.cpuPercent}%` : "—"}
                  </span>
                </div>
              </div>
            </div>
            {/* Memory usage bar */}
            <div>
              <p className={sectionLabel}>Memory Usage</p>
              <div className="mt-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2.5 rounded-full bg-fms-bg-subtle overflow-hidden">
                    <div style={{ width: `${Math.min(100, sysStats?.memoryPercent ?? 0)}%`, background: (sysStats?.memoryPercent ?? 0) > 85 ? "#f87171" : (sysStats?.memoryPercent ?? 0) > 60 ? "#fbbf24" : "#4ade80", height: "100%", borderRadius: 99, transition: "width 0.5s" }} />
                  </div>
                  <span className="text-sm font-semibold text-fms-text" style={{ minWidth: 40, textAlign: "right" }}>
                    {sysStats?.memoryPercent != null ? `${sysStats.memoryPercent}%` : "—"}
                  </span>
                </div>
              </div>
            </div>
            {/* AI process memory */}
            <div>
              <p className={sectionLabel}>AI Process Memory</p>
              <p className={sectionValue}>{sysStats?.processMemoryMB != null ? `${sysStats.processMemoryMB} MB` : "—"}</p>
            </div>
            {/* Active RTSP captures */}
            <div>
              <p className={sectionLabel}>Active RTSP Captures</p>
              <p className={sectionValue}>{sysStats?.activeCaptures ?? 0}</p>
            </div>
          </div>
        </div>
      </section>

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
                  <div className="text-right flex-shrink-0">
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

      {/* ── System Compatibility ── */}
      <section className={card}>
        <div className={cardHeader}>
          <h2 className={cardTitle}>
            <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
            </span>
            System Compatibility
          </h2>
        </div>
        <div className={cardBody}>
          {estimate == null ? (
            <p className="text-sm text-fms-text-tertiary m-0">Detecting system capabilities...</p>
          ) : (
          <div className={gridRow}>
            <div>
              <p className={sectionLabel}>Compatibility Rating</p>
              <p className={sectionValue}>
                <span style={{ color: estimate.color, fontWeight: 700 }}>{estimate.rating}</span>
              </p>
            </div>
            <div>
              <p className={sectionLabel}>Estimated Max Cameras</p>
              <p className={sectionValue} style={{ fontSize: "1.25rem", fontWeight: 700, color: estimate.color }}>{estimate.max}</p>
            </div>
            <div>
              <p className={sectionLabel}>GPU Acceleration</p>
              <p className={sectionValue}>
                <span className={pill} style={{ borderColor: hasGpu ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)", background: hasGpu ? "rgba(34,197,94,0.08)" : "rgba(245,158,11,0.08)", color: hasGpu ? "#4ade80" : "#fbbf24" }}>
                  <span className={dot} style={{ background: hasGpu ? "#4ade80" : "#fbbf24" }} />
                  {hasGpu ? `Active (${providerLabel})` : "CPU Only"}
                </span>
              </p>
            </div>
          </div>
          )}

          <div className="mt-4 pt-4 border-t border-fms-border">
            <p className={sectionLabel + " mb-2"}>Feature Compatibility</p>
            {typeof aiHealth?.registeredFaces === "number" && (
              <div className="mb-3 px-3 py-2 rounded-xl border" style={{
                borderColor: aiHealth.registeredFaces > 0 ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)",
                background: aiHealth.registeredFaces > 0 ? "rgba(34,197,94,0.06)" : "rgba(245,158,11,0.06)",
              }}>
                <p className="text-sm m-0" style={{ color: aiHealth.registeredFaces > 0 ? "#4ade80" : "#fbbf24" }}>
                  <span className="font-semibold">{aiHealth.registeredFaces}</span> registered face{aiHealth.registeredFaces !== 1 ? "s" : ""} in AI database
                  {aiHealth.registeredFaces === 0 && (
                    <span className="text-xs ml-2" style={{ color: "#fbbf24" }}>
                      — Register faces on employees to enable recognition
                    </span>
                  )}
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              {[
                { name: "Face Recognition (InsightFace)", ok: aiHealth?.ok ?? false },
                { name: "YOLO Person Detection", ok: aiHealth?.yoloAvailable ?? false },
                { name: "GPU Acceleration", ok: hasGpu },
                { name: "GStreamer Capture (HW decode)", ok: aiHealth?.gstreamerAvailable ?? false },
                { name: "Multi-Camera AI Workers", ok: sysInfo.cpuCores >= 4 },
                { name: "RTSP Stream Testing (FFmpeg)", ok: true },
              ].map((feat) => (
                <div key={feat.name} className="flex items-center gap-2">
                  <span style={{ width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 4, background: feat.ok ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)" }}>
                    {feat.ok ? (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 3v3m0 1.5h.005" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    )}
                  </span>
                  <span className="text-sm text-fms-text">{feat.name}</span>
                  <span className="text-xs text-fms-text-tertiary ml-auto">{feat.ok ? "Available" : "Unavailable"}</span>
                </div>
              ))}
            </div>
          </div>

          {estimate != null && (
          <div className="mt-4 pt-4 border-t border-fms-border">
            <p className="text-xs text-fms-text-tertiary m-0">
              Estimates based on {sysInfo.cpuModel}{sysInfo.totalMemoryGB > 0 ? `, ${sysInfo.totalMemoryGB}GB total memory` : ""}{hasGpu ? `, GPU (${providerLabel})` : ""}.
              {sysInfo.arch.includes("Apple Silicon") ? " Apple Silicon benefits from unified memory and Neural Engine acceleration via CoreML." : ""}
              {" "}Actual performance depends on camera resolution, network latency, and recognition model complexity.
            </p>
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
