"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft, IconPlus, IconCamera } from "@/core/layout/icons";
import { MultiSelect, Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
// MediaPipe packages are loaded as <script> tags at runtime (not bundled).
// They are Closure Compiler IIFEs that register exports on `window` via
// `.call(this)`.  Bundlers rebind `this` to the module scope which breaks them.
import styles from "./AddEmployeePage.module.css";

interface ZoneItemOption {
  name: string;
}

interface ZoneOption {
  id: string;
  name: string;
  zones: ZoneItemOption[];
}

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  personTypeId: string;
  zoneIds: string[];
  zoneKeys: string[];
  scheduleId: string;
  status: string;
  isActive: boolean;
  joinedDate: string;
}

const initialForm: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  personTypeId: "",
  zoneIds: [],
  zoneKeys: [],
  scheduleId: "",
  status: "-",
  isActive: true,
  joinedDate: new Date().toISOString().slice(0, 10),
};

type Landmark = { x: number; y: number; z: number };

function distance(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function eyeAspectRatio(landmarks: Landmark[], left: boolean): number {
  // MediaPipe eye landmarks for EAR-style blink approximation.
  const ids = left
    ? { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 }
    : { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 };
  const p1 = landmarks[ids.p1];
  const p2 = landmarks[ids.p2];
  const p3 = landmarks[ids.p3];
  const p4 = landmarks[ids.p4];
  const p5 = landmarks[ids.p5];
  const p6 = landmarks[ids.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0;
  const vertical = distance(p2, p6) + distance(p3, p5);
  const horizontal = 2 * distance(p1, p4);
  if (horizontal <= 0) return 0;
  return vertical / horizontal;
}

/** Matches Python `_is_head_straight` intent for the final enrollment frame. */
function isHeadStraightLandmarks(lm: Landmark[], canvasHeight: number): boolean {
  const le = lm[33];
  const re = lm[263];
  if (!le || !re) return true;
  return Math.abs((le.y - re.y) * canvasHeight) < 20;
}

/** Nose vs eye midline in normalized coords; ~0 frontal, positive when head turns left (camera view). */
function noseYawOffset(lm: Landmark[]): number {
  const le = lm[33];
  const re = lm[263];
  const nose = lm[1];
  if (!le || !re || !nose) return 0;
  const eyeMidX = (le.x + re.x) / 2;
  return nose.x - eyeMidX;
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.55, -size * 0.65);
  ctx.lineTo(-size * 0.55, size * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Direction hints toward the guide center (matches oval at ~50%, 44%). */
function drawPositionHints(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  cx: number,
  cy: number,
  deadNorm: number,
) {
  const targetX = 0.5;
  const targetY = 0.42;
  const dx = targetX - cx;
  const dy = targetY - cy;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 6;
  const margin = Math.min(cw, ch) * 0.06;
  if (Math.abs(dx) > deadNorm) {
    const pointEast = dx > 0;
    const ax = pointEast ? margin : cw - margin;
    const ay = ch * targetY;
    drawArrowHead(ctx, ax, ay, pointEast ? 0 : Math.PI, margin * 0.45);
  }
  if (Math.abs(dy) > deadNorm * 0.85) {
    const pointSouth = dy > 0;
    const ax = cw * 0.5;
    const ay = pointSouth ? margin : ch - margin;
    drawArrowHead(ctx, ax, ay, pointSouth ? Math.PI / 2 : -Math.PI / 2, margin * 0.45);
  }
  ctx.shadowBlur = 0;
}

function drawTurnCue(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  side: "left" | "right",
  pulse: number,
) {
  const alpha = 0.45 + Math.sin(pulse * 0.12) * 0.3;
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 8;
  const margin = Math.min(cw, ch) * 0.07;
  const cy = ch * 0.42;
  const angle = side === "left" ? Math.PI : 0;
  const ax = side === "left" ? margin : cw - margin;
  drawArrowHead(ctx, ax, cy, angle, margin * 0.55);
  ctx.shadowBlur = 0;
}

type RegPhase = "align" | "blink" | "turn_left" | "turn_right" | "final";

const REG_PHASE_ORDER: RegPhase[] = ["align", "blink", "turn_left", "turn_right", "final"];
const FACE_REG_TOTAL_STEPS = REG_PHASE_ORDER.length;

/**
 * Extra landmark pairs for a low-poly / “architectural” wireframe (468-point mesh indices).
 * Complements FACEMESH_CONTOURS with nose ridge, inter-eye, cheek spans, and mouth–chin axis.
 */
const FACE_WIREFRAME_EXTRA: ReadonlyArray<[number, number]> = [
  /* Inter-eye & glabella */
  [133, 362],
  [0, 168],
  [1, 0],
  [1, 133],
  [1, 362],
  /* Nose ridge */
  [168, 6],
  [6, 197],
  [197, 195],
  [195, 5],
  [5, 4],
  [4, 1],
  /* Philtrum / mouth / chin axis */
  [1, 17],
  [17, 152],
  [152, 377],
  [152, 400],
  [172, 152],
  [148, 152],
  [176, 148],
  [150, 176],
  [136, 172],
  [61, 291],
  /* Cheek & mid-face facets */
  [234, 454],
  [127, 356],
  [33, 127],
  [263, 356],
  [234, 116],
  [454, 345],
  /* Forehead to bridge */
  [10, 151],
  [151, 9],
  [9, 8],
  [8, 168],
  /* Outer eye to cheek */
  [33, 234],
  [263, 454],
  [7, 163],
  [382, 381],
  /* Jaw corners toward chin */
  [58, 172],
  [288, 397],
  [397, 365],
];

const FACE_WIREFRAME_VERTEX_IDX: ReadonlyArray<number> = [
  0, 1, 4, 5, 6, 7, 8, 9, 10, 17, 33, 58, 61, 116, 127, 133, 136, 148, 150, 151, 152, 163, 168,
  172, 176, 195, 197, 234, 263, 288, 291, 345, 356, 362, 365, 377, 381, 382, 397, 400, 454,
];

function drawSparseLandmarkEdges(
  ctx: CanvasRenderingContext2D,
  lm: Landmark[],
  edges: ReadonlyArray<[number, number]>,
  cw: number,
  ch: number,
  color: string,
  lineWidth: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const [ia, ib] of edges) {
    const a = lm[ia];
    const b = lm[ib];
    if (!a || !b) continue;
    ctx.moveTo(a.x * cw, a.y * ch);
    ctx.lineTo(b.x * cw, b.y * ch);
  }
  ctx.stroke();
}

function drawWireframeVertices(
  ctx: CanvasRenderingContext2D,
  lm: Landmark[],
  indices: ReadonlyArray<number>,
  cw: number,
  ch: number,
  r: number,
) {
  for (const i of indices) {
    const p = lm[i];
    if (!p) continue;
    const x = p.x * cw;
    const y = p.y * ch;
    ctx.beginPath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.32)";
    ctx.lineWidth = 0.75;
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

export default function AddEmployeePage() {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [faceError, setFaceError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  const [faceRegistered, setFaceRegistered] = useState(false);
  const [faceImageBase64, setFaceImageBase64] = useState<string | null>(null);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string | null>(null);
  const [savedEnrollmentUrl, setSavedEnrollmentUrl] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturingFace, setCapturingFace] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [meshStatus, setMeshStatus] = useState<string>("Initializing face mesh…");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const profilePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceMeshRef = useRef<any>(null);
  const faceMeshBusyRef = useRef(false);
  const faceMeshLoopRef = useRef<number | null>(null);
  const closeFaceModalTimerRef = useRef<number | null>(null);
  const autoCaptureDoneRef = useRef(false);
  const goodFrameCountRef = useRef(0);
  const regPhaseRef = useRef<RegPhase>("align");
  const blinkStageRef = useRef<"calib" | "wait_close" | "wait_open">("calib");
  const blinkCalibFramesRef = useRef(0);
  const blinkOpenBaselineRef = useRef(0.22);
  const blinkClosedStreakRef = useRef(0);
  const blinkOpenAgainStreakRef = useRef(0);
  const turnLeftStreakRef = useRef(0);
  const turnRightStreakRef = useRef(0);
  const lastMeshStatusRef = useRef("");
  const lastMeshStatusAtRef = useRef(0);
  const turnPulseRef = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const [faceRegStep, setFaceRegStep] = useState(1);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [schedules, setSchedules] = useState<{ id: string; name: string; scheduleType?: string }[]>([]);
  const [personTypes, setPersonTypes] = useState<{ id: string; name: string }[]>([]);

  // Onboarding camera option (loaded from settings)
  const [onboardingCamera, setOnboardingCamera] = useState<{ name: string; rtspIp: string } | null>(null);
  const [cameraSource, setCameraSource] = useState<"webcam" | "onboarding">("webcam");

  // Load onboarding camera setting
  useEffect(() => {
    apiFetch("/api/v1/settings/cameras")
      .then((r) => r.json())
      .then((data: { onboardingCamera?: { name: string; rtspIp: string } | null }) => {
        if (data?.onboardingCamera?.rtspIp) setOnboardingCamera(data.onboardingCamera);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch("/api/v1/person-types")
      .then((res) => res.json())
      .then((data: { id: string; name: string; status?: string }[]) => {
        if (Array.isArray(data))
          setPersonTypes(data.filter((pt) => pt.status !== "inactive").map((pt) => ({ id: pt.id, name: pt.name })));
        else setPersonTypes([]);
      })
      .catch(() => setPersonTypes([]));
  }, []);
  useEffect(() => {
    apiFetch("/api/v1/zones")
      .then((res) => res.json())
      .then((data: ZoneOption[]) => {
        if (Array.isArray(data)) {
          setZones(
            data.map((z: ZoneOption & { subZones?: { name: string }[] }) => ({
              id: z.id,
              name: z.name,
              zones: Array.isArray(z.zones) ? z.zones.map((zone) => ({ name: zone.name })) : Array.isArray(z.subZones) ? z.subZones.map((item) => ({ name: item.name })) : [],
            }))
          );
        }
      })
      .catch(() => setZones([]));
  }, []);

  useEffect(() => {
    if (!form.personTypeId) {
      setSchedules([]);
      return;
    }
    apiFetch(`/api/v1/schedules?personTypeId=${encodeURIComponent(form.personTypeId)}&activeOnly=true`)
      .then((res) => res.json())
      .then((data: { id: string; name: string; scheduleType?: string }[]) => {
        if (Array.isArray(data)) setSchedules(data.map((s) => ({ id: s.id, name: s.name, scheduleType: s.scheduleType })));
        else setSchedules([]);
      })
      .catch(() => setSchedules([]));
  }, [form.personTypeId]);

  const zoneOptions = useMemo(
    () =>
      zones.map((zone) => ({
        value: zone.id,
        label: zone.name,
      })),
    [zones]
  );

  const availableZoneOptions = useMemo(
    () =>
      form.zoneIds.flatMap((zoneId) => {
        const location = zones.find((item) => item.id === zoneId);
        if (!location) return [];
        return location.zones.map((zone) => ({
          value: `${zoneId}::${zone.name}`,
          label: `${location.name} - ${zone.name}`,
        }));
      }),
    [form.zoneIds, zones]
  );

  useEffect(() => {
    const validKeys = new Set(availableZoneOptions.map((option) => option.value));
    setForm((prev) => {
      const nextKeys = prev.zoneKeys.filter((key) => validKeys.has(key));
      return nextKeys.length === prev.zoneKeys.length ? prev : { ...prev, zoneKeys: nextKeys };
    });
  }, [availableZoneOptions]);

  useEffect(() => {
    if (!faceModalOpen) {
      if (closeFaceModalTimerRef.current != null) {
        window.clearTimeout(closeFaceModalTimerRef.current);
        closeFaceModalTimerRef.current = null;
      }
      if (streamRef?.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      // Reset FaceMesh so a fresh instance is created on next open
      faceMeshRef.current = null;
      setCameraReady(false);
      setCameraError(null);
      setMeshStatus("Initializing face mesh…");
      autoCaptureDoneRef.current = false;
      goodFrameCountRef.current = 0;
      regPhaseRef.current = "align";
      blinkStageRef.current = "calib";
      blinkCalibFramesRef.current = 0;
      blinkOpenBaselineRef.current = 0.22;
      blinkClosedStreakRef.current = 0;
      blinkOpenAgainStreakRef.current = 0;
      turnLeftStreakRef.current = 0;
      turnRightStreakRef.current = 0;
      lastMeshStatusRef.current = "";
      lastMeshStatusAtRef.current = 0;
      turnPulseRef.current = 0;
      setFaceRegStep(1);
      return;
    }
    let cancelled = false;
    const startCamera = async () => {
      try {
        // Wait for local Python AI service startup on first app launch.
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        let aiReady = false;
        const maxAttempts = 30; // up to ~60s
        for (let i = 0; i < maxAttempts; i += 1) {
          try {
            const healthRes = await apiFetch("/api/v1/face/health");
            const healthData = (await healthRes.json().catch(() => ({}))) as { ok?: boolean };
            if (healthData?.ok === true) {
              aiReady = true;
              break;
            }
          } catch {
            // ignore transient startup errors and keep retrying
          }
          if (i < maxAttempts - 1) {
            setMeshStatus(`Initializing face AI service... (${i + 1}/${maxAttempts})`);
            await wait(2000);
          }
        }
        if (!aiReady) {
          setCameraError(
            "Face AI service is not ready yet. Wait a moment and reopen registration."
          );
          return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera is not supported in this environment.");
        }
        let stream: MediaStream | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
            audio: false,
          });
        } catch {
          // Some desktop cameras do not support facingMode constraints.
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false,
          });
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (streamRef?.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
        }
        if (streamRef) streamRef.current = stream;
        if (videoRef?.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCameraReady(true);
        setMeshStatus(t("employees.faceRegStatusCenter"));
      } catch (error) {
        setCameraReady(false);
        const message =
          error instanceof Error
            ? error.message
            : "Failed to access camera.";
        setCameraError(
          `Failed to access camera. Check desktop app permissions for Camera and try again. ${message}`
        );
      }
    };
    startCamera();
    return () => {
      cancelled = true;
      if (closeFaceModalTimerRef.current != null) {
        window.clearTimeout(closeFaceModalTimerRef.current);
        closeFaceModalTimerRef.current = null;
      }
      if (streamRef?.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [faceModalOpen, t]);

  useEffect(() => {
    if (!faceModalOpen) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const playVideo = async () => {
      try {
        await video.play();
      } catch {
        // Ignore autoplay play errors; user can still capture once stream is active.
      }
    };
    void playVideo();
  }, [faceModalOpen, cameraReady]);

  const completeFaceCapture = (dataUrl: string, mode: "auto" | "manual") => {
    setFaceImageBase64(dataUrl);
    setFaceRegistered(true);
    setFaceError(null);
    setMeshStatus(
      mode === "auto"
        ? "Face captured successfully. Closing registration..."
        : "Face captured successfully."
    );
    if (mode === "auto") {
      if (closeFaceModalTimerRef.current != null) {
        window.clearTimeout(closeFaceModalTimerRef.current);
      }
      closeFaceModalTimerRef.current = window.setTimeout(() => {
        setFaceModalOpen(false);
      }, 700);
    } else {
      setFaceModalOpen(false);
    }
  };

  useEffect(() => {
    const stopLoop = () => {
      if (faceMeshLoopRef.current != null) {
        cancelAnimationFrame(faceMeshLoopRef.current);
        faceMeshLoopRef.current = null;
      }
      faceMeshBusyRef.current = false;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      goodFrameCountRef.current = 0;
    };

    if (!faceModalOpen || !cameraReady || !videoRef.current || !canvasRef.current) {
      stopLoop();
      return;
    }

    let cancelled = false;
    /** Capture a frame from the video, capping at 640×480 to keep base64 payloads small. */
    const captureFrame = (video: HTMLVideoElement, quality: number): string | null => {
      const srcW = video.videoWidth || 640;
      const srcH = video.videoHeight || 480;
      const MAX_W = 640;
      const MAX_H = 480;
      const scale = Math.min(1, MAX_W / srcW, MAX_H / srcH);
      const w = Math.round(srcW * scale);
      const h = Math.round(srcH * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      // Eagerly release canvas memory
      canvas.width = 0;
      canvas.height = 0;
      return dataUrl;
    };
    const autoCapture = () => {
      if (autoCaptureDoneRef.current) return;
      if (!videoRef.current) return;
      const dataUrl = captureFrame(videoRef.current, 0.9);
      if (!dataUrl) return;
      autoCaptureDoneRef.current = true;
      completeFaceCapture(dataUrl, "auto");
    };

    const startFaceMesh = async () => {
      try {
        if (cancelled) return;

        // --- Load MediaPipe as plain <script> tags so their IIFEs run on `window` ---
        const loadScript = (src: string): Promise<void> =>
          new Promise((resolve, reject) => {
            // Reuse if already loaded
            if (document.querySelector(`script[src="${src}"]`)) {
              resolve();
              return;
            }
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(s);
          });

        // Files are in public/mediapipe/ — served from root in both Next.js and Tauri
        await loadScript("/mediapipe/face_mesh/face_mesh.js");
        await loadScript("/mediapipe/drawing_utils/drawing_utils.js");

        const win = window as unknown as {
          FaceMesh?: new (cfg?: { locateFile?: (file: string) => string }) => any;
          /** Combined oval, brows, eyes, lips, nose — extra mid-face structure vs single regions */
          FACEMESH_CONTOURS?: unknown;
          FACEMESH_FACE_OVAL?: unknown;
          FACEMESH_LEFT_IRIS?: unknown;
          FACEMESH_RIGHT_IRIS?: unknown;
          drawConnectors?: (...args: any[]) => void;
        };

        if (!win.FaceMesh) {
          throw new Error("FaceMesh constructor not available on window after script load.");
        }
        const FaceMeshCtor = win.FaceMesh;
        const faceContours = win.FACEMESH_CONTOURS;
        const faceOval = win.FACEMESH_FACE_OVAL;
        const leftIrisMesh = win.FACEMESH_LEFT_IRIS;
        const rightIrisMesh = win.FACEMESH_RIGHT_IRIS;
        const drawConnectorsFn = win.drawConnectors;
        if (
          !drawConnectorsFn ||
          !faceContours ||
          !faceOval ||
          !leftIrisMesh ||
          !rightIrisMesh
        ) {
          throw new Error("MediaPipe face mesh drawing utils are unavailable.");
        }

        if (!faceMeshRef.current) {
          // locateFile points to local copies so no CDN / internet is needed
          const mesh = new FaceMeshCtor({
            locateFile: (file: string) =>
              `/mediapipe/face_mesh/${file}`,
          });
          mesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          mesh.onResults((results: any) => {
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

            const pushStatus = (i18nKey: string) => {
              const now = performance.now();
              if (
                i18nKey === lastMeshStatusRef.current &&
                now - lastMeshStatusAtRef.current < 260
              ) {
                return;
              }
              lastMeshStatusRef.current = i18nKey;
              lastMeshStatusAtRef.current = now;
              setMeshStatus(tRef.current(i18nKey));
            };

            const bumpPhase = (next: RegPhase) => {
              if (regPhaseRef.current === next) return;
              regPhaseRef.current = next;
              setFaceRegStep(REG_PHASE_ORDER.indexOf(next) + 1);
              goodFrameCountRef.current = 0;
              if (next === "blink") {
                blinkStageRef.current = "calib";
                blinkCalibFramesRef.current = 0;
                blinkClosedStreakRef.current = 0;
                blinkOpenAgainStreakRef.current = 0;
                blinkOpenBaselineRef.current = 0.12;
              }
              if (next === "turn_left") turnLeftStreakRef.current = 0;
              if (next === "turn_right") turnRightStreakRef.current = 0;
            };

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            turnPulseRef.current += 1;

            if (!results?.multiFaceLandmarks?.length) {
              goodFrameCountRef.current = 0;
              pushStatus("employees.faceRegStatusNoFace");
              return;
            }

            const lm = results.multiFaceLandmarks[0] as Landmark[];
            /** Contours + sparse low-poly extras + vertex dots + oval emphasis + irises. */
            const drawFaceGeometry = () => {
              drawConnectorsFn(ctx, lm as any, faceContours as any, {
                color: "rgba(255, 255, 255, 0.26)",
                lineWidth: 1,
              });
              drawSparseLandmarkEdges(
                ctx,
                lm,
                FACE_WIREFRAME_EXTRA,
                width,
                height,
                "rgba(255, 255, 255, 0.44)",
                1.1,
              );
              drawConnectorsFn(ctx, lm as any, faceOval as any, {
                color: "rgba(255, 255, 255, 0.38)",
                lineWidth: 1.15,
              });
              drawWireframeVertices(ctx, lm, FACE_WIREFRAME_VERTEX_IDX, width, height, 1.85);
              drawConnectorsFn(ctx, lm as any, leftIrisMesh as any, {
                color: "rgba(255, 255, 255, 0.62)",
                lineWidth: 1.2,
              });
              drawConnectorsFn(ctx, lm as any, rightIrisMesh as any, {
                color: "rgba(255, 255, 255, 0.62)",
                lineWidth: 1.2,
              });
            };
            drawFaceGeometry();

            const xs = lm.map((p) => p.x);
            const ys = lm.map((p) => p.y);
            const faceWidth = Math.max(...xs) - Math.min(...xs);
            const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
            const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
            const yaw = noseYawOffset(lm);

            const leftEarRatio = eyeAspectRatio(lm, true);
            const rightEarRatio = eyeAspectRatio(lm, false);
            const ear = (leftEarRatio + rightEarRatio) / 2;

            const alignCentered =
              cx > 0.26 && cx < 0.74 && cy > 0.2 && cy < 0.78;
            const alignBigEnough = faceWidth > 0.17;
            const notTooClose = faceWidth < 0.44;

            const finalCentered =
              cx > 0.31 && cx < 0.69 && cy > 0.24 && cy < 0.74;
            const finalSizeOk = faceWidth > 0.18 && faceWidth < 0.38;
            const headOk = isHeadStraightLandmarks(lm, height);
            const frontalPose = Math.abs(yaw) < 0.028;

            const dead = 0.055;
            const phase = regPhaseRef.current;

            if (phase === "align") {
              if (!alignCentered || !alignBigEnough || !notTooClose) {
                goodFrameCountRef.current = 0;
              } else {
                goodFrameCountRef.current += 1;
              }
              if (!alignCentered) {
                pushStatus("employees.faceRegStatusCenter");
                drawPositionHints(ctx, width, height, cx, cy, dead);
              } else if (!alignBigEnough) {
                pushStatus("employees.faceRegStatusCloser");
                drawPositionHints(ctx, width, height, cx, cy, dead);
              } else if (!notTooClose) {
                pushStatus("employees.faceRegStatusFarther");
                drawPositionHints(ctx, width, height, cx, cy, dead);
              } else if (goodFrameCountRef.current >= 8) {
                bumpPhase("blink");
                pushStatus("employees.faceRegStatusBlinkCalibrate");
              } else {
                pushStatus("employees.faceRegStatusCenter");
              }
            } else if (phase === "blink") {
              const base = Math.max(blinkOpenBaselineRef.current, 0.14);
              if (blinkStageRef.current === "calib") {
                blinkCalibFramesRef.current += 1;
                blinkOpenBaselineRef.current = Math.max(
                  blinkOpenBaselineRef.current,
                  ear,
                );
                pushStatus("employees.faceRegStatusBlinkCalibrate");
                if (blinkCalibFramesRef.current >= 18) {
                  blinkStageRef.current = "wait_close";
                  pushStatus("employees.faceRegStatusBlinkClose");
                }
              } else if (blinkStageRef.current === "wait_close") {
                const closed = ear < base * 0.58;
                if (closed) blinkClosedStreakRef.current += 1;
                else blinkClosedStreakRef.current = 0;
                pushStatus("employees.faceRegStatusBlinkClose");
                if (blinkClosedStreakRef.current >= 3) {
                  blinkStageRef.current = "wait_open";
                  blinkOpenAgainStreakRef.current = 0;
                  pushStatus("employees.faceRegStatusBlinkOpen");
                }
              } else if (blinkStageRef.current === "wait_open") {
                const open = ear > base * 0.82;
                if (open) blinkOpenAgainStreakRef.current += 1;
                else blinkOpenAgainStreakRef.current = 0;
                pushStatus("employees.faceRegStatusBlinkOpen");
                if (blinkOpenAgainStreakRef.current >= 4) {
                  bumpPhase("turn_left");
                  pushStatus("employees.faceRegStatusTurnLeft");
                }
              }
            } else if (phase === "turn_left") {
              const turned = yaw > 0.032;
              if (turned) turnLeftStreakRef.current += 1;
              else turnLeftStreakRef.current = 0;
              pushStatus("employees.faceRegStatusTurnLeft");
              if (!turned) {
                drawTurnCue(ctx, width, height, "left", turnPulseRef.current);
              }
              if (turnLeftStreakRef.current >= 14) {
                bumpPhase("turn_right");
                pushStatus("employees.faceRegStatusTurnRight");
              }
            } else if (phase === "turn_right") {
              const turned = yaw < -0.032;
              if (turned) turnRightStreakRef.current += 1;
              else turnRightStreakRef.current = 0;
              pushStatus("employees.faceRegStatusTurnRight");
              if (!turned) {
                drawTurnCue(ctx, width, height, "right", turnPulseRef.current);
              }
              if (turnRightStreakRef.current >= 14) {
                bumpPhase("final");
                pushStatus("employees.faceRegStatusStraighten");
              }
            } else if (phase === "final") {
              if (finalCentered && finalSizeOk && headOk && frontalPose) {
                goodFrameCountRef.current += 1;
              } else {
                goodFrameCountRef.current = 0;
              }
              if (!finalCentered || !finalSizeOk) {
                if (!finalCentered) {
                  pushStatus("employees.faceRegStatusCenter");
                } else {
                  pushStatus(
                    faceWidth <= 0.18
                      ? "employees.faceRegStatusCloser"
                      : "employees.faceRegStatusFarther",
                  );
                }
                drawPositionHints(ctx, width, height, cx, cy, 0.045);
              } else if (!headOk || !frontalPose) {
                pushStatus("employees.faceRegStatusStraighten");
              } else {
                pushStatus("employees.faceRegStatusHold");
              }

              if (
                !autoCaptureDoneRef.current &&
                goodFrameCountRef.current >= 14
              ) {
                autoCapture();
              }
            }
          });
          faceMeshRef.current = mesh;
        }

        const loop = async () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (!video) return;
          if (video.readyState >= 2 && !faceMeshBusyRef.current) {
            faceMeshBusyRef.current = true;
            try {
              await faceMeshRef.current.send({ image: video });
            } catch {
              // ignore per-frame errors so camera loop continues
            } finally {
              faceMeshBusyRef.current = false;
            }
          }
          faceMeshLoopRef.current = requestAnimationFrame(loop);
        };
        faceMeshLoopRef.current = requestAnimationFrame(loop);
      } catch (error) {
        const errMsg =
          error instanceof Error
            ? error.message
            : "Unknown Face Mesh initialization error.";
        setCameraError(
          `Face Mesh init failed: ${errMsg}. Please restart the app and try again.`,
        );
        setMeshStatus(`Face mesh initialization failed: ${errMsg}`);
      }
    };

    void startFaceMesh();
    return () => {
      cancelled = true;
      stopLoop();
    };
  }, [faceModalOpen, cameraReady]);

  const update = (key: keyof FormState, value: string | boolean) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "personTypeId") next.scheduleId = "";
      return next;
    });
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.firstName.trim()) next.firstName = t("employees.validationFirstName");
    if (!form.lastName.trim()) next.lastName = t("employees.validationLastName");
    if (!form.personTypeId) next.personTypeId = t("employees.validationPersonType");
    if (form.zoneIds.length === 0) next.zoneIds = t("employees.validationZones");
    if (availableZoneOptions.length > 0 && form.zoneKeys.length === 0) {
      next.zoneKeys = t("employees.validationSubZones");
    }
    if (!form.scheduleId) next.scheduleId = t("employees.validationShift");
    if (!form.joinedDate) next.joinedDate = t("employees.validationDateJoined");
    setErrors(next);
    setFaceError(null);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const scheduleId = form.scheduleId.trim();
    if (form.zoneIds.length === 0 || !scheduleId) {
      toast.error(t("employees.validationZone") + " / " + t("employees.validationShift"));
      return;
    }
    setSubmitting(true);
    setSavedEnrollmentUrl(null);
    try {
      const name = [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ") || form.firstName.trim() || form.lastName.trim();
      const subZones = form.zoneKeys
        .map((key) => {
          const [zoneId, ...nameParts] = key.split("::");
          return { zoneId, name: nameParts.join("::") };
        })
        .filter((z) => z.zoneId && z.name);
      const body = {
        name,
        zoneId: form.zoneIds[0],
        zoneIds: form.zoneIds,
        zones: subZones,
        scheduleId,
        joinedDate: form.joinedDate,
        isActive: form.isActive,
        personTypeId: form.personTypeId.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        status: form.status,
        profilePhotoData: profilePhotoPreview ?? undefined,
      };
      const res = await apiFetch("/api/v1/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string; detail?: string | { msg?: string }[] };
        const detail = data?.detail != null
          ? Array.isArray(data.detail)
            ? data.detail.map((d) => (typeof d === "object" && d && "msg" in d ? d.msg : String(d))).join(". ")
            : String(data.detail)
          : data?.message;
        throw new Error(detail ?? t("toast.employeeAddError"));
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new Error("Employee created response missing id.");
      }

      let enrollUrl: string | null = null;
      if (form.email.trim()) {
        const sendRes = await apiFetch(`/api/v1/employees/${created.id}/face-enrollment/send`, {
          method: "POST",
        });
        if (sendRes.ok) {
          const j = (await sendRes.json().catch(() => ({}))) as { token?: string };
          if (j.token && typeof window !== "undefined") {
            enrollUrl = `${window.location.origin}/enroll/${j.token}`;
          }
          toast.success(t("employees.toastEnrollmentLinkSentGeneric", { name }));
        } else {
          const errBody = (await sendRes.json().catch(() => ({}))) as { error?: string; message?: string };
          toast.error(errBody.error ?? errBody.message ?? t("employees.toastEnrollmentLinkFailed"));
        }
      }
      setSavedEnrollmentUrl(enrollUrl);

      /** Re-encode a data-URL at a different JPEG quality, cleaning up DOM elements afterwards. */
      const toJpegQuality = async (inputBase64: string, quality: number): Promise<string> => {
        const source = new Image();
        source.decoding = "async";
        source.src = inputBase64;
        await source.decode();
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(320, source.width);
        canvas.height = Math.max(240, source.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) { source.src = ""; return inputBase64; }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL("image/jpeg", quality);
        canvas.width = 0;
        canvas.height = 0;
        source.src = "";
        return result;
      };

      if (faceRegistered && faceImageBase64) {
        const qualityLevels = [null, 0.75, 0.65] as const;
        let lastFaceError = "Face registration failed.";
        let registered = false;
        for (const quality of qualityLevels) {
          let candidateBase64: string;
          if (quality === null) {
            candidateBase64 = faceImageBase64;
          } else {
            try {
              candidateBase64 = await toJpegQuality(faceImageBase64, quality);
            } catch {
              continue;
            }
          }
          try {
            const faceRes = await apiFetch(`/api/v1/employees/${created.id}/face`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                imageBase64: candidateBase64,
                qualityScore: 0.8,
              }),
            });
            if (faceRes.ok) {
              registered = true;
              break;
            }
            const data = (await faceRes.json().catch(() => ({}))) as { message?: string; error?: string };
            lastFaceError = data.message || data.error || lastFaceError;
          } catch (faceErr) {
            lastFaceError = faceErr instanceof Error ? faceErr.message : "Face registration request failed.";
          }
        }
        if (!registered) {
          toast.error(
            `${lastFaceError} ${t("employees.optionalFaceSaveNote")}`,
          );
        }
      }

      toast.success(t("toast.employeeAdded"));
      setSuccess(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.employeeAddError"));
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <DashboardLayout title={t("employees.addEmployee")}>
        <div className={styles.page}>
          <div className={styles.successCard}>
            <div className={styles.successIcon} aria-hidden>
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className={styles.successTitle}>{t("employees.addSuccessTitle")}</h2>
            <p className={styles.successText}>{t("employees.addSuccessText")}</p>
            {savedEnrollmentUrl && (
              <div className={styles.enrollmentLinkBox}>
                <p className={styles.enrollmentLinkLabel}>{t("employees.addSuccessEnrollmentHint")}</p>
                <div className={styles.enrollmentLinkRow}>
                  <code className={styles.enrollmentLinkCode}>{savedEnrollmentUrl}</code>
                  <button
                    type="button"
                    className={styles.enrollmentCopyBtn}
                    onClick={() => {
                      void navigator.clipboard.writeText(savedEnrollmentUrl);
                      toast.success(t("employees.enrollmentLinkCopied"));
                    }}
                  >
                    {t("employees.copyEnrollmentLink")}
                  </button>
                </div>
              </div>
            )}
            {!savedEnrollmentUrl && form.email.trim() === "" && (
              <p className={styles.enrollmentNoEmail}>{t("employees.enrollmentNoEmailHint")}</p>
            )}
            <div className={styles.successActions}>
              <button
                type="button"
                className={styles.submitBtn}
                onClick={() => {
                  setSuccess(false);
                  setForm(initialForm);
                  setErrors({});
                  setFaceRegistered(false);
                  setFaceImageBase64(null);
                  setProfilePhotoPreview(null);
                  setSavedEnrollmentUrl(null);
                }}
              >
                <IconPlus className="w-4 h-4" />
                {t("employees.addAnother")}
              </button>
              <Link href="/employees" className={styles.cancelLink}>
                {t("employees.backToEmployees")}
              </Link>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={t("employees.addEmployee")}>
      <div className={styles.page}>
        <Link
          href="/employees"
          className={styles.backLink}
          aria-label={t("employees.backToEmployees")}
        >
          <IconChevronLeft className="w-4 h-4" />
          {t("employees.backToEmployees")}
        </Link>

        <header className={styles.header}>
          <h1 className={styles.title}>{t("employees.addEmployee")}</h1>
          <p className={styles.subtitle}>{t("employees.addEmployeeSubtitle")}</p>
        </header>

        <div className={styles.card}>
          <form onSubmit={handleSubmit} className={styles.form} noValidate>
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t("employees.personalInfo")}</h2>
              <div className={styles.fieldGrid}>
                <div>
                  <label htmlFor="firstName" className={styles.label}>
                    {t("employees.firstName")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                  </label>
                  <input
                    id="firstName"
                    type="text"
                    value={form.firstName}
                    onChange={(e) => update("firstName", e.target.value)}
                    placeholder={t("employees.firstNamePlaceholder")}
                    className={`${styles.input} ${errors.firstName ? styles.inputError : ""}`}
                    autoComplete="given-name"
                  />
                  {errors.firstName && <p className={styles.errorText}>{errors.firstName}</p>}
                </div>
                <div>
                  <label htmlFor="lastName" className={styles.label}>
                    {t("employees.lastName")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                  </label>
                  <input
                    id="lastName"
                    type="text"
                    value={form.lastName}
                    onChange={(e) => update("lastName", e.target.value)}
                    placeholder={t("employees.lastNamePlaceholder")}
                    className={`${styles.input} ${errors.lastName ? styles.inputError : ""}`}
                    autoComplete="family-name"
                  />
                  {errors.lastName && <p className={styles.errorText}>{errors.lastName}</p>}
                </div>
                <div>
                  <label htmlFor="email" className={styles.label}>
                    {t("employees.email")} <span className={styles.labelOptional}>({t("employees.optional")})</span>
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => update("email", e.target.value)}
                    placeholder={t("employees.emailPlaceholder")}
                    className={styles.input}
                    autoComplete="email"
                  />
                </div>
                <div>
                  <label htmlFor="phone" className={styles.label}>
                    {t("employees.phone")} <span className={styles.labelOptional}>({t("employees.optional")})</span>
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder={t("employees.phonePlaceholder")}
                    className={styles.input}
                    autoComplete="tel"
                  />
                </div>
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t("employees.workInfo")}</h2>
              <div className={styles.fieldGrid}>
                <div>
                  <label htmlFor="personType" className={styles.label}>
                    {t("employees.personType")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                  </label>
                  <Select
                    id="personType"
                    value={form.personTypeId}
                    onChange={(e) => update("personTypeId", e.target.value)}
                    className="w-full"
                    error={errors.personTypeId}
                    aria-required
                  >
                    <option value="">{t("employees.selectPersonType")}</option>
                    {personTypes.map((pt) => (
                      <option key={pt.id} value={pt.id}>
                        {pt.name}
                      </option>
                    ))}
                  </Select>
                  {errors.personTypeId && <p className={styles.errorText}>{errors.personTypeId}</p>}
                </div>
                <div>
                  <div className={styles.fieldGridFull}>
                    <MultiSelect
                      label={
                        <>
                          {t("employees.zones")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                        </>
                      }
                      placeholder={t("employees.selectZones")}
                      options={zoneOptions}
                      values={form.zoneIds}
                      columns={2}
                      error={errors.zoneIds}
                      onChange={(values) => {
                        setForm((prev) => ({ ...prev, zoneIds: values }));
                        setErrors((prev) => ({ ...prev, zoneIds: undefined, zoneKeys: undefined }));
                      }}
                    />
                  </div>
                </div>
                <div className={styles.fieldGridFull}>
                  <MultiSelect
                    label={
                      <>
                        {t("employees.subZones")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                      </>
                    }
                    placeholder={t("employees.selectSubZones")}
                    hint={form.zoneIds.length > 0 ? t("employees.subZonesHint") : t("employees.noSubZonesAvailable")}
                    options={availableZoneOptions}
                    values={form.zoneKeys}
                    columns={2}
                    disabled={availableZoneOptions.length === 0}
                    error={errors.zoneKeys}
                    onChange={(values) => {
                      setForm((prev) => ({ ...prev, zoneKeys: values }));
                      setErrors((prev) => ({ ...prev, zoneKeys: undefined }));
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="shift" className={styles.label}>
                    {t("employees.shift")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                  </label>
                  <Select
                    id="shift"
                    value={form.scheduleId}
                    onChange={(e) => update("scheduleId", e.target.value)}
                    className="w-full"
                    error={errors.scheduleId}
                    aria-required
                    disabled={!form.personTypeId}
                  >
                    <option value="">
                      {!form.personTypeId
                        ? t("employees.selectPersonType")
                        : schedules.length === 0
                          ? t("shifts.noSchedulesForPersonType")
                          : t("employees.selectShift")}
                    </option>
                    {schedules.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.scheduleType === "24_7" ? "(24/7)" : "(Standard)"}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="joinedDate" className={styles.label}>
                    {t("employees.dateJoined")} <span className={styles.labelOptional}>({t("employees.required")})</span>
                  </label>
                  <input
                    id="joinedDate"
                    type="date"
                    value={form.joinedDate}
                    onChange={(e) => update("joinedDate", e.target.value)}
                    className={`${styles.input} ${errors.joinedDate ? styles.inputError : ""}`}
                  />
                  {errors.joinedDate && <p className={styles.errorText}>{errors.joinedDate}</p>}
                </div>
                <div className={styles.fieldGridFull}>
                  <div className="fms-toggle-row">
                    <span className={styles.toggleLabel}>{t("employees.active")}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={form.isActive}
                      data-checked={form.isActive}
                      className="fms-switch"
                      onClick={() => update("isActive", !form.isActive)}
                    >
                      <span className="fms-switch-thumb" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.section} aria-label={t("employees.photoAndFaceModuleTitle")}>
              <div className={styles.photoFaceCard}>
                <div className={styles.photoFaceBracketTop} aria-hidden />
                <h2 className={styles.photoFaceModuleTitle}>{t("employees.photoAndFaceModuleTitle")}</h2>
                <div className={styles.photoFaceTwoCol}>
                  <div className={styles.photoFaceCol}>
                    <h3 className={styles.photoFaceColTitle}>{t("employees.profilePhotoSection")}</h3>
                    <p className={styles.photoFaceColDesc}>{t("employees.profilePhotoWireframeDesc")}</p>
                    <input
                      ref={profilePhotoInputRef}
                      id="profilePhoto"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className={styles.photoFaceFileInput}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > 5 * 1024 * 1024) {
                          toast.error(t("employees.profilePhotoTooLarge"));
                          e.target.value = "";
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                          setProfilePhotoPreview(typeof reader.result === "string" ? reader.result : null);
                        };
                        reader.readAsDataURL(f);
                      }}
                    />
                    <button
                      type="button"
                      className={styles.photoFacePrimaryBtn}
                      onClick={() => profilePhotoInputRef.current?.click()}
                    >
                      {t("employees.uploadPhotoButton")}
                    </button>
                    <p className={styles.photoFaceColFoot}>({t("employees.optional")})</p>
                    {profilePhotoPreview && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={profilePhotoPreview} alt="" className={styles.profilePhotoThumb} />
                    )}
                  </div>
                  <div className={styles.photoFaceDivider} aria-hidden />
                  <div className={styles.photoFaceCol}>
                    <h3 className={styles.photoFaceColTitle}>{t("employees.faceEnrollmentColumnTitle")}</h3>
                    <p className={styles.photoFaceColDesc}>{t("employees.faceEnrollmentWireframeDesc")}</p>
                    <button
                      type="button"
                      className={styles.photoFacePrimaryBtn}
                      disabled
                      aria-disabled="true"
                      title={t("employees.enrollmentDisabledUntilSaved")}
                    >
                      {t("employees.sendEnrollmentLink")}
                    </button>
                    <p className={styles.photoFaceColFoot}>{t("employees.enrollmentDisabledUntilSaved")}</p>
                  </div>
                </div>
                <div className={styles.photoFaceBracketBottom} aria-hidden />
              </div>

              <div className={styles.photoFaceAdvanced}>
                <p className={styles.photoFaceAdvancedHint}>{t("employees.optionalFaceCaptureHint")}</p>
              {/* Camera source selector */}
              {onboardingCamera && (
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={() => setCameraSource("webcam")}
                    style={{
                      padding: "6px 14px", borderRadius: 10, fontSize: "0.8125rem", fontWeight: 600,
                      border: "1px solid",
                      borderColor: cameraSource === "webcam" ? "var(--fms-accent)" : "var(--fms-border)",
                      background: cameraSource === "webcam" ? "rgba(var(--fms-accent-rgb, 99,102,241), 0.1)" : "transparent",
                      color: cameraSource === "webcam" ? "var(--fms-accent)" : "var(--fms-text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    Webcam
                  </button>
                  <button
                    type="button"
                    onClick={() => setCameraSource("onboarding")}
                    style={{
                      padding: "6px 14px", borderRadius: 10, fontSize: "0.8125rem", fontWeight: 600,
                      border: "1px solid",
                      borderColor: cameraSource === "onboarding" ? "var(--fms-accent)" : "var(--fms-border)",
                      background: cameraSource === "onboarding" ? "rgba(var(--fms-accent-rgb, 99,102,241), 0.1)" : "transparent",
                      color: cameraSource === "onboarding" ? "var(--fms-accent)" : "var(--fms-text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    {onboardingCamera.name || "Onboarding Camera"}
                  </button>
                </div>
              )}
              {cameraSource === "onboarding" && onboardingCamera && (
                <p style={{ fontSize: "0.75rem", color: "var(--fms-text-tertiary)", marginBottom: 8 }}>
                  Using RTSP camera: {onboardingCamera.rtspIp}
                </p>
              )}
              {faceError && <p className={styles.errorText}>{faceError}</p>}
              <button
                type="button"
                onClick={() => {
                  setFaceError(null);
                  setFaceModalOpen(true);
                }}
                className={faceRegistered ? styles.facialBtnRegistered : styles.facialBtn}
                aria-label={t("employees.startFacialRegistration")}
              >
                {faceRegistered ? (
                  <svg
                    className={styles.facialBtnIcon}
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M5 12.5L9.5 17L19 7.5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <IconCamera className={styles.facialBtnIcon} aria-hidden />
                )}
                {faceRegistered ? t("employees.faceRegistered") : t("employees.registerFace")}
              </button>
              {faceRegistered && (
                <p className={styles.faceReadyText}>
                  Face verified. Complete employee details and submit.
                </p>
              )}
              </div>
            </section>

            <div className={styles.actions}>
              <button type="submit" className={styles.submitBtn} disabled={submitting}>
                {submitting ? t("employees.saving") : t("employees.saveEmployee")}
              </button>
              <Link href="/employees" className={styles.cancelLink}>
                {t("employees.cancel")}
              </Link>
            </div>
          </form>
        </div>

        {faceModalOpen && (
          <div
            className={styles.modalOverlay}
            onClick={() => setFaceModalOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="facial-modal-title"
          >
            <div
              className={styles.modal}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="facial-modal-title" className={styles.modalTitle}>
                {t("employees.facialModalTitle")}
              </h2>
              <p className={styles.modalHint}>{t("employees.facialModalHint")}</p>
              <p className={styles.faceRegStepBadge} aria-live="polite">
                {t("employees.faceRegStep", {
                  current: faceRegStep,
                  total: FACE_REG_TOTAL_STEPS,
                })}
              </p>
              <p className={styles.modalMeshStatus}>{meshStatus}</p>
              <div className={styles.modalCameraPlaceholder}>
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={styles.modalVideo}
                />
                <div className={styles.faceGuideStack} aria-hidden>
                  <div className={styles.faceGuideVignette} />
                  <div
                    className={`${styles.faceGuideBracket} ${styles.faceGuideBracketTl}`}
                  />
                  <div
                    className={`${styles.faceGuideBracket} ${styles.faceGuideBracketTr}`}
                  />
                  <div
                    className={`${styles.faceGuideBracket} ${styles.faceGuideBracketBl}`}
                  />
                  <div
                    className={`${styles.faceGuideBracket} ${styles.faceGuideBracketBr}`}
                  />
                </div>
                <canvas ref={canvasRef} className={styles.modalCanvas} />
                {!cameraReady && (
                  <div className={styles.modalCameraOverlay}>
                    <IconCamera className={styles.modalCameraIcon} aria-hidden />
                    <span className={styles.modalCameraText}>
                      {cameraError || t("employees.cameraPreview")}
                    </span>
                  </div>
                )}
              </div>
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.submitBtn}
                  disabled={!cameraReady || capturingFace}
                  onClick={() => {
                    if (!videoRef.current) return;
                    setCapturingFace(true);
                    try {
                      const video = videoRef.current;
                      const srcW = video.videoWidth || 640;
                      const srcH = video.videoHeight || 480;
                      const MAX_W = 640;
                      const MAX_H = 480;
                      const scale = Math.min(1, MAX_W / srcW, MAX_H / srcH);
                      const w = Math.round(srcW * scale);
                      const h = Math.round(srcH * scale);
                      const canvas = document.createElement("canvas");
                      canvas.width = w;
                      canvas.height = h;
                      const ctx = canvas.getContext("2d");
                      if (!ctx) throw new Error("Camera frame context unavailable");
                      ctx.drawImage(video, 0, 0, w, h);
                      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                      canvas.width = 0;
                      canvas.height = 0;
                      completeFaceCapture(dataUrl, "manual");
                    } catch (error) {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Failed to capture face image."
                      );
                    } finally {
                      setCapturingFace(false);
                    }
                  }}
                >
                  {faceRegistered ? "Capture again (manual fallback)" : t("employees.captureFace")}
                </button>
                <button
                  type="button"
                  className={styles.modalCancelBtn}
                  onClick={() => setFaceModalOpen(false)}
                >
                  {t("employees.cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
