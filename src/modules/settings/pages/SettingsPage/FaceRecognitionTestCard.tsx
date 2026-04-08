"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/core/api/request";

type RecognitionResult = {
  status: string;
  personId?: string;
  name?: string;
  score?: number;
  bbox?: [number, number, number, number];
  personBbox?: [number, number, number, number];
  shouldLog?: boolean;
};

type RecognitionResponse = RecognitionResult & {
  results?: RecognitionResult[];
  countDetected?: number;
  countRecognized?: number;
  timingMs?: number;
  timing?: { detectMs?: number; recognizeMs?: number; totalMs?: number };
  pipeline?: string;
};

type PersonDetails = {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  zoneName?: string | null;
  personTypeName?: string | null;
};

type SeenPerson = {
  personId: string;
  name: string;
  score: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sightings: number;
  details?: PersonDetails | null;
};

const REQUEST_INTERVAL_MS = 700;
const MAX_FACES = 20;

export default function FaceRecognitionTestCard() {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [running, setRunning] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<RecognitionResponse | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [seenPersons, setSeenPersons] = useState<SeenPerson[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeRequestRef = useRef(false);
  const detailsCacheRef = useRef<Record<string, PersonDetails | null>>({});

  const stopRecognition = () => {
    setRunning(false);
    setCameraReady(false);
    setIsRecognizing(false);
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  useEffect(() => {
    return () => { stopRecognition(); };
  }, []);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!modalOpen) {
      stopRecognition();
      setResult(null);
      setLastUpdated(null);
      setSeenPersons([]);
      setCameraError(null);
    }
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modalOpen]);

  const fetchPersonDetails = useCallback(async (personId: string): Promise<PersonDetails | null> => {
    if (Object.prototype.hasOwnProperty.call(detailsCacheRef.current, personId)) {
      return detailsCacheRef.current[personId] ?? null;
    }
    try {
      const res = await apiFetch(`/api/v1/employees/${personId}`);
      if (!res.ok) { detailsCacheRef.current[personId] = null; return null; }
      const data = (await res.json()) as PersonDetails;
      detailsCacheRef.current[personId] = data;
      return data;
    } catch {
      detailsCacheRef.current[personId] = null;
      return null;
    }
  }, []);

  const registerSeenPerson = useCallback(async (recognition: RecognitionResult) => {
    if (recognition.status !== "recognized" || !recognition.personId) return;
    const personId = recognition.personId;
    const details = await fetchPersonDetails(personId);
    const seenAt = Date.now();
    const score = typeof recognition.score === "number" ? recognition.score : 0;
    const fallbackName = recognition.name?.trim() || details?.name?.trim() || t("faceRecognition.unknown");

    setSeenPersons((prev) => {
      const existing = prev.find((item) => item.personId === personId);
      if (existing) {
        return prev
          .map((item) =>
            item.personId === personId
              ? { ...item, name: fallbackName || item.name, score: Math.max(item.score, score), lastSeenAt: seenAt, sightings: item.sightings + 1, details: details ?? item.details ?? null }
              : item
          )
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      }
      return [{ personId, name: fallbackName, score, firstSeenAt: seenAt, lastSeenAt: seenAt, sightings: 1, details }, ...prev];
    });
  }, [fetchPersonDetails, t]);

  const drawOverlay = useCallback((recognition: RecognitionResponse | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const items = recognition?.results ?? [];
    if (!items.length) return;

    for (const face of items) {
      const bbox = face.bbox;
      if (!bbox || bbox.length !== 4) continue;
      const clampX = (v: number) => Math.max(0, Math.min(canvas.width, v));
      const clampY = (v: number) => Math.max(0, Math.min(canvas.height, v));
      const x1 = clampX(bbox[0]);
      const y1 = clampY(bbox[1]);
      const x2 = clampX(bbox[2]);
      const y2 = clampY(bbox[3]);
      const boxW = Math.max(1, x2 - x1);
      const boxH = Math.max(1, y2 - y1);

      const recognized = face.status === "recognized";
      const color = recognized ? "#22c55e" : "#f59e0b";
      // Show Name | ID: personId | score for recognized faces
      const scoreStr = typeof face.score === "number" ? face.score.toFixed(2) : "";
      const label = recognized
        ? `${face.name ?? t("faceRecognition.person")} | ID: ${face.personId ?? "?"} | ${scoreStr}`
        : `${t("faceRecognition.unknown")} ${scoreStr ? `(${scoreStr})` : ""}`;

      ctx.save();

      // Draw person bbox (dashed, lighter) if present from YOLO
      const pbox = face.personBbox;
      if (pbox && pbox.length === 4) {
        const px1 = clampX(pbox[0]);
        const py1 = clampY(pbox[1]);
        const px2 = clampX(pbox[2]);
        const py2 = clampY(pbox[3]);
        ctx.strokeStyle = recognized ? "rgba(34,197,94,0.35)" : "rgba(245,158,11,0.25)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(px1, py1, Math.max(1, px2 - px1), Math.max(1, py2 - py1));
        ctx.setLineDash([]);
      }

      // Face bbox (solid)
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, boxW, boxH);

      const fontSize = 14;
      ctx.font = `600 ${fontSize}px sans-serif`;
      const textWidth = ctx.measureText(label).width;
      const padX = 8;
      const padY = 6;
      const boxY = Math.max(0, y1 - fontSize - padY * 2 - 4);
      ctx.fillStyle = color;
      ctx.fillRect(x1, boxY, textWidth + padX * 2, fontSize + padY * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x1 + padX, boxY + fontSize + 1);
      ctx.restore();
    }
  }, [t]);

  const startRecognition = async () => {
    setCameraError(null);
    setResult(null);
    setLastUpdated(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(t("faceRecognition.cameraNotSupported"));
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setRunning(true);
      setCameraReady(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setCameraError(t("faceRecognition.cameraFailed", { message }));
      stopRecognition();
    }
  };

  useEffect(() => {
    if (!running || !cameraReady) return;
    const tick = async () => {
      if (activeRequestRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      activeRequestRef.current = true;
      setIsRecognizing(true);
      try {
        const width = Math.max(320, video.videoWidth || 640);
        const height = Math.max(240, video.videoHeight || 480);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        const payload = dataUrl.split(",")[1] ?? dataUrl;

        const res = await apiFetch("/api/v1/face/recognize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: payload, threshold: 0.5, maxFaces: MAX_FACES }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({ status: `http_error_${res.status}` }));
          const errResult: RecognitionResponse = { status: (errData as Record<string, unknown>)?.status as string ?? `error_${res.status}` };
          setResult(errResult);
          drawOverlay(errResult);
          setLastUpdated(Date.now());
        } else {
          const body = (await res.json().catch(() => ({}))) as RecognitionResponse;
          setResult(body);
          drawOverlay(body);
          setLastUpdated(Date.now());
          const recognizedItems = (body.results ?? []).filter(
            (item): item is RecognitionResult => item.status === "recognized" && !!item.personId
          );
          if (!recognizedItems.length && body.status === "recognized" && body.personId) {
            recognizedItems.push(body);
          }
          for (const item of recognizedItems) {
            void registerSeenPerson(item);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "recognition_error";
        const failed: RecognitionResponse = {
          status: msg.includes("fetch") || msg.includes("network") ? "ai_service_unreachable" : "recognition_error",
        };
        setResult(failed);
        drawOverlay(failed);
        setLastUpdated(Date.now());
      } finally {
        activeRequestRef.current = false;
        setIsRecognizing(false);
      }
    };

    timerRef.current = window.setInterval(tick, REQUEST_INTERVAL_MS);
    void tick();
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [running, cameraReady, registerSeenPerson, drawOverlay]);

  const statusView = useMemo(() => {
    if (!result) return t("faceRecognition.noResultYet");
    if ((result.results?.length ?? 0) > 0) {
      const detected = result.countDetected ?? result.results?.length ?? 0;
      const recognized = result.countRecognized ?? result.results?.filter((item) => item.status === "recognized").length ?? 0;
      let text = t("faceRecognition.detectedFaces", { detected, recognized });
      if (typeof result.timingMs === "number") {
        text += ` \u2022 ${t("faceRecognition.latency", { ms: result.timingMs })}`;
      }
      if (result.pipeline) {
        text += ` \u2022 ${result.pipeline}`;
      }
      if (result.timing) {
        const { detectMs, recognizeMs } = result.timing;
        if (typeof detectMs === "number" && typeof recognizeMs === "number") {
          text += ` (detect: ${detectMs}ms, match: ${recognizeMs}ms)`;
        }
      }
      return text;
    }
    if (result.status === "recognized") {
      const score = typeof result.score === "number" ? result.score.toFixed(3) : "n/a";
      return t("faceRecognition.recognized", { name: result.name ?? t("faceRecognition.unknown"), id: result.personId ?? "—", score });
    }
    if (result.status === "unknown") {
      const score = typeof result.score === "number" ? result.score.toFixed(3) : "0.000";
      return t("faceRecognition.noMatch", { score });
    }
    return t("faceRecognition.statusPrefix", { status: result.status });
  }, [result, t]);

  const modalContent = modalOpen ? (
    <div
      className="fixed inset-0 z-1000 bg-slate-950/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recognition-test-modal-title"
      onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}
    >
      <div className="absolute left-1/2 top-1/2 w-[calc(100vw-1.5rem)] max-w-6xl max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-fms-border/80 bg-fms-surface shadow-[0_30px_90px_rgba(0,0,0,0.45)] overflow-hidden">
        <div className="relative px-6 py-5 border-b border-fms-border bg-linear-to-r from-fms-bg-subtle/80 via-fms-surface to-fms-bg-subtle/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="recognition-test-modal-title" className="m-0 text-lg font-semibold text-fms-text flex items-center gap-2">
                <span className="inline-flex items-center justify-center rounded-xl bg-fms-accent/15 text-fms-accent p-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 8h.01M9 8h.01M8 13s1.5 2 4 2 4-2 4-2" strokeLinecap="round" />
                    <rect x="3" y="3" width="18" height="18" rx="5" />
                  </svg>
                </span>
                {t("faceRecognition.modalTitle")}
              </h3>
              <p className="m-0 mt-1 text-sm text-fms-text-secondary">
                {t("faceRecognition.modalSubtitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="inline-flex items-center justify-center rounded-xl border border-fms-border px-3 py-1.5 text-sm text-fms-text-secondary hover:bg-fms-bg-subtle transition-colors shrink-0"
            >
              {t("faceRecognition.close")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-fms-border px-2.5 py-1 text-xs text-fms-text-secondary">
              <span className={`w-2 h-2 rounded-full ${running ? "bg-emerald-500" : "bg-fms-text-tertiary"}`} />
              {running ? t("faceRecognition.recognizing") : t("faceRecognition.noResultYet")}
            </span>
            {lastUpdated && (
              <span className="inline-flex items-center rounded-full border border-fms-border px-2.5 py-1 text-xs text-fms-text-secondary">
                {t("faceRecognition.lastUpdate")}: {new Date(lastUpdated).toLocaleTimeString()}
              </span>
            )}
            {result?.pipeline && (
              <span className="inline-flex items-center rounded-full border border-fms-border px-2.5 py-1 text-xs text-fms-text-secondary">
                {result.pipeline}
              </span>
            )}
          </div>
        </div>

        <div className="p-5 h-[calc(90vh-7.5rem)] grid grid-cols-1 xl:grid-cols-[1.65fr_1fr] gap-5 overflow-hidden">
          <div className="min-h-0">
            <div className="relative rounded-2xl overflow-hidden border border-fms-border bg-slate-950 min-h-64">
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-[48vh] object-cover bg-slate-950" />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              {!cameraReady && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-sm text-fms-text-secondary p-4 text-center bg-slate-900/70">
                  <span className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 p-3 mb-3">
                    <svg className="w-5 h-5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14" />
                      <rect x="3" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </span>
                  {cameraError ?? t("faceRecognition.cameraPlaceholder")}
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {!running ? (
                <button
                  type="button"
                  onClick={startRecognition}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm transition-all duration-200"
                >
                  {t("faceRecognition.startTest")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopRecognition}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold border border-fms-border text-fms-text-secondary hover:bg-fms-bg-subtle transition-all duration-200"
                >
                  {t("faceRecognition.stopTest")}
                </button>
              )}
              {isRecognizing && (
                <span className="inline-flex items-center gap-2 rounded-xl border border-fms-border px-3 py-2 text-sm text-fms-text-secondary">
                  <span className="w-2 h-2 rounded-full bg-fms-accent animate-pulse" />
                  {t("faceRecognition.recognizing")}
                </span>
              )}
            </div>
            <div className="mt-3 rounded-xl border border-fms-border bg-fms-bg-subtle/40 px-3 py-2.5">
              <p className="m-0 text-sm text-fms-text">{statusView}</p>
            </div>
          </div>

          <div className="min-h-0">
            <div className="rounded-2xl border border-fms-border bg-fms-bg-subtle/20 h-full flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-fms-border bg-fms-surface/70">
                <p className="m-0 text-sm font-semibold text-fms-text">
                  {t("faceRecognition.identifiedPersons")} ({seenPersons.length})
                </p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
                {seenPersons.length === 0 ? (
                  <p className="m-0 text-sm text-fms-text-secondary px-1 py-2">
                    {t("faceRecognition.noPersonYet")}
                  </p>
                ) : (
                  seenPersons.map((person) => (
                    <div key={person.personId} className="rounded-xl border border-fms-border bg-fms-surface px-3 py-2.5 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="m-0 text-sm font-semibold text-fms-text">{person.name}</p>
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-500 px-2 py-0.5 text-[11px] font-semibold">
                          {person.score.toFixed(3)}
                        </span>
                      </div>
                      <p className="m-0 mt-0.5 text-xs text-fms-text-secondary">
                        {t("faceRecognition.personId")}: {person.personId}
                      </p>
                      <p className="m-0 mt-0.5 text-xs text-fms-text-secondary">
                        {t("faceRecognition.sightings")}: {person.sightings}
                      </p>
                      <p className="m-0 mt-0.5 text-xs text-fms-text-tertiary">
                        {t("faceRecognition.lastSeen")}: {new Date(person.lastSeenAt).toLocaleTimeString()}
                      </p>
                      {(person.details?.email || person.details?.phone || person.details?.zoneName || person.details?.personTypeName) && (
                        <p className="m-0 mt-1 text-xs text-fms-text-secondary">
                          {person.details?.personTypeName ? `${t("faceRecognition.type")}: ${person.details.personTypeName} \u2022 ` : ""}
                          {person.details?.zoneName ? `${t("faceRecognition.zone")}: ${person.details.zoneName} \u2022 ` : ""}
                          {person.details?.email ? `${t("faceRecognition.email")}: ${person.details.email} \u2022 ` : ""}
                          {person.details?.phone ? `${t("faceRecognition.phone")}: ${person.details.phone}` : ""}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="w-full mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm transition-all duration-200"
        >
          {t("faceRecognition.openTest")}
        </button>
      </div>
      <p className="mt-2 mb-0 text-sm text-fms-text-secondary">
        {t("faceRecognition.openTestHint")}
      </p>

      {mounted ? createPortal(modalContent, document.body) : null}
    </div>
  );
}
