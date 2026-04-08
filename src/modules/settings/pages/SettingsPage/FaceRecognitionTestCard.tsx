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
      className="fixed inset-0 z-1000 bg-black/45 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recognition-test-modal-title"
      onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}
    >
      <div className="absolute left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-5xl max-h-[88vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-fms-border bg-fms-surface shadow-[0_24px_70px_rgba(0,0,0,0.35)] overflow-hidden">
        <div className="px-5 py-4 border-b border-fms-border flex items-start justify-between gap-3 bg-fms-surface">
          <div>
            <h3 id="recognition-test-modal-title" className="m-0 text-base font-semibold text-fms-text">
              {t("faceRecognition.modalTitle")}
            </h3>
            <p className="m-0 mt-1 text-sm text-fms-text-secondary">
              {t("faceRecognition.modalSubtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(false)}
            className="inline-flex items-center justify-center rounded-xl border border-fms-border px-3 py-1.5 text-sm text-fms-text-secondary hover:bg-fms-bg-subtle transition-colors"
          >
            {t("faceRecognition.close")}
          </button>
        </div>

        <div className="p-5 h-[calc(88vh-4.5rem)] grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5 overflow-hidden">
          <div className="min-h-0">
            <div className="relative rounded-2xl overflow-hidden border border-fms-border bg-fms-bg-subtle min-h-64">
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-[46vh] object-cover bg-slate-900" />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              {!cameraReady && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-fms-text-secondary p-4 text-center">
                  {cameraError ?? t("faceRecognition.cameraPlaceholder")}
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
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
                <span className="text-sm text-fms-text-secondary">{t("faceRecognition.recognizing")}</span>
              )}
              {lastUpdated && (
                <span className="text-xs text-fms-text-tertiary">
                  {t("faceRecognition.lastUpdate")}: {new Date(lastUpdated).toLocaleTimeString()}
                </span>
              )}
            </div>
            <div className="mt-3 rounded-xl border border-fms-border bg-fms-bg-subtle/40 px-3 py-2">
              <p className="m-0 text-sm text-fms-text">{statusView}</p>
            </div>
          </div>

          <div className="min-h-0">
            <div className="rounded-2xl border border-fms-border bg-fms-bg-subtle/20 h-full flex flex-col">
              <div className="px-4 py-3 border-b border-fms-border">
                <p className="m-0 text-sm font-semibold text-fms-text">
                  {t("faceRecognition.identifiedPersons")} ({seenPersons.length})
                </p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {seenPersons.length === 0 ? (
                  <p className="m-0 text-sm text-fms-text-secondary px-1 py-2">
                    {t("faceRecognition.noPersonYet")}
                  </p>
                ) : (
                  seenPersons.map((person) => (
                    <div key={person.personId} className="rounded-xl border border-fms-border bg-fms-surface px-3 py-2">
                      <p className="m-0 text-sm font-semibold text-fms-text">{person.name}</p>
                      <p className="m-0 mt-0.5 text-xs text-fms-text-secondary">
                        {t("faceRecognition.personId")}: {person.personId} &bull; {t("faceRecognition.bestScore")}: {person.score.toFixed(3)} &bull; {t("faceRecognition.sightings")}: {person.sightings}
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
