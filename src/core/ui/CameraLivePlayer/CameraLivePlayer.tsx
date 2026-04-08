"use client";

import { useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import { apiFetch } from "@/core/api/request";
import { getApiBaseSync } from "@/core/api/baseUrl";
import type { ZoneConfig } from "@/modules/zones/types";
import { isDvrMode } from "@/modules/zones/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PlayerStatus =
  | "idle"
  | "starting"
  | "connecting"
  | "online"
  | "reconnecting"
  | "error"
  | "offline"
  | "no-ffmpeg";

export interface PlayerState {
  status: PlayerStatus;
  errorMessage?: string;
  rtspUrlMasked?: string;
  reconnectCount?: number;
  uptimeSeconds?: number;
  streamId?: string;
  // AI recognition fields
  aiEnabled?: boolean;
  aiRunning?: boolean;
  aiError?: string | null;
  aiFramesProcessed?: number;
  aiRecognizedCount?: number;
  aiLastAt?: string | null;
  /** Latest AI detection results for overlay rendering. */
  aiResults?: AiDetectionResult[] | null;
  /** Track manager stats from Python (totalTracks, identifiedTracks, unknownTracks). */
  aiTrackStats?: { totalTracks: number; identifiedTracks: number; unknownTracks: number } | null;
  /** Recognition latency in ms from the last frame. */
  aiLatencyMs?: number | null;
  /** Number of results served from track cache (InsightFace skipped). */
  aiCachedCount?: number | null;
}

export interface AiDetectionResult {
  faceIndex?: number;
  status?: string;
  personId?: string;
  name?: string;
  score?: number;
  bbox?: [number, number, number, number];
  personBbox?: [number, number, number, number];
  /** ByteTrack persistent track ID (-1 if not tracked). */
  trackId?: number;
  /** True if identity was served from track cache (InsightFace skipped). */
  trackCached?: boolean;
  /** YOLO person detection confidence. */
  detectionConf?: number;
}

interface CameraLivePlayerProps {
  camera: ZoneConfig | null;
  /** Optional zone/camera metadata forwarded to stream start. */
  zoneId?: string;
  cameraId?: string;
  onStatusChange?: (state: PlayerState) => void;
  className?: string;
}

const STATUS_POLL_MS = 2000;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function CameraLivePlayer({
  camera,
  zoneId,
  cameraId,
  onStatusChange,
  className,
}: CameraLivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const emit = useCallback((s: PlayerState) => {
    onStatusChangeRef.current?.(s);
  }, []);

  const cleanup = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const id = streamIdRef.current;
    streamIdRef.current = null;
    if (id) apiFetch(`/api/v1/streams/${id}/stop`, { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cleanup(); };
  }, [cleanup]);

  useEffect(() => {
    // Camera changed — stop previous, start new
    cleanup();
    emit({ status: "idle" });

    if (!camera) return;

    let cancelled = false;
    const streamId = { current: null as string | null };

    (async () => {
      emit({ status: "starting" });

      const body = buildPayload(camera);
      if (zoneId) body.zoneId = zoneId;
      if (cameraId) body.cameraId = cameraId;

      // 1. Call start
      let data: { streamId: string; playbackUrl: string; rtspUrlMasked: string };
      try {
        const res = await apiFetch("/api/v1/streams/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to start" }));
          const msg = (err as { error?: string }).error || "Failed to start";
          if (!cancelled) emit({ status: msg.toLowerCase().includes("ffmpeg") ? "no-ffmpeg" : "error", errorMessage: msg });
          return;
        }
        data = await res.json();
      } catch (e) {
        if (!cancelled) emit({ status: "error", errorMessage: e instanceof Error ? e.message : "Network error" });
        return;
      }

      if (cancelled) { apiFetch(`/api/v1/streams/${data.streamId}/stop`, { method: "POST" }).catch(() => {}); return; }

      streamIdRef.current = data.streamId;
      streamId.current = data.streamId;
      emit({ status: "connecting", streamId: data.streamId, rtspUrlMasked: data.rtspUrlMasked });

      // 2. Poll status until online or error
      let hlsAttached = false;

      const poll = async () => {
        if (cancelled || streamIdRef.current !== streamId.current) return;
        try {
          const res = await apiFetch(`/api/v1/streams/${streamId.current}/status`);
          if (!res.ok) {
            if (!cancelled) emit({ status: "error", errorMessage: "Stream ended", streamId: streamId.current! });
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            return;
          }
          const d = await res.json() as Record<string, unknown>;
          const st = (d.status as string) as PlayerStatus;

          if (!cancelled) {
            emit({
              status: st,
              errorMessage: (d.errorMessage as string) || undefined,
              rtspUrlMasked: d.rtspUrlMasked as string | undefined,
              reconnectCount: d.reconnectCount as number | undefined,
              uptimeSeconds: d.uptimeSeconds as number | undefined,
              streamId: streamId.current!,
              aiEnabled: d.aiEnabled as boolean | undefined,
              aiRunning: d.aiRunning as boolean | undefined,
              aiError: d.aiError as string | null | undefined,
              aiFramesProcessed: d.aiFramesProcessed as number | undefined,
              aiRecognizedCount: d.aiRecognizedCount as number | undefined,
              aiLastAt: d.aiLastAt as string | null | undefined,
              aiResults: Array.isArray(d.aiResults) ? d.aiResults as AiDetectionResult[] : null,
              aiTrackStats: d.aiTrackStats as PlayerState["aiTrackStats"] ?? null,
              aiLatencyMs: d.aiLatencyMs as number | null ?? null,
              aiCachedCount: d.aiCachedCount as number | null ?? null,
            });
          }

          if (st === "online" && !hlsAttached && !cancelled) {
            hlsAttached = true;
            attachHls(videoRef.current, data.playbackUrl, hlsRef);
          }

          if (st === "error" || st === "offline") {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          }
        } catch { /* keep polling */ }
      };

      poll();
      pollRef.current = setInterval(poll, STATUS_POLL_MS);
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      const id = streamIdRef.current;
      streamIdRef.current = null;
      if (id) apiFetch(`/api/v1/streams/${id}/stop`, { method: "POST" }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  return (
    <video
      ref={videoRef}
      className={className}
      autoPlay
      muted
      playsInline
      style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0c0c0c" }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  HLS                                                                */
/* ------------------------------------------------------------------ */

function attachHls(
  video: HTMLVideoElement | null,
  playbackUrl: string,
  hlsRef: React.MutableRefObject<Hls | null>,
) {
  if (!video) return;
  const base = getApiBaseSync();
  const fullUrl = `${base}${playbackUrl}`;

  if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

  if (Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      liveDurationInfinity: true,
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 6,
      maxMaxBufferLength: 12,
      backBufferLength: 0,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingTimeOut: 15000,
      levelLoadingMaxRetry: 6,
      levelLoadingRetryDelay: 1000,
    });
    hls.loadSource(fullUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d.fatal) {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
    hlsRef.current = hls;
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = fullUrl;
    video.addEventListener("loadedmetadata", () => { video.play().catch(() => {}); }, { once: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildPayload(cam: ZoneConfig): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (isDvrMode(cam)) {
    b.vendor = cam.vendor || "generic";
    b.dvrIp = cam.dvrIp || cam.ip;
    b.rtspPort = cam.rtspPort || 554;
    b.channelId = cam.channelId || 1;
    b.streamType = cam.streamType || "main";
    b.username = cam.username || "";
    b.password = cam.password || "";
    b.rtspPath = cam.rtspPath || "";
  } else {
    b.vendor = "generic";
    b.rtsp = cam.rtsp;
    if (cam.ip) b.dvrIp = cam.ip;
  }
  return b;
}
