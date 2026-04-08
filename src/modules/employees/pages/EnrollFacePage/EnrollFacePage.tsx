"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/core/api/request";
import { toast } from "@/core/lib/toast";

type SessionState =
  | { loading: true }
  | { loading: false; valid: false; message: string }
  | {
      loading: false;
      valid: true;
      employeeName: string;
      expired: boolean;
    };

type CaptureKey = "front" | "right" | "left";

const CAPTURE_ORDER: CaptureKey[] = ["front", "right", "left"];

function snapVideoFrame(video: HTMLVideoElement): string {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return "";
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.88);
}

export function EnrollFacePage() {
  const { t } = useTranslation();
  const params = useParams();
  const token = typeof params?.token === "string" ? params.token : "";

  const [session, setSession] = useState<SessionState>({ loading: true });
  const [step, setStep] = useState<"intro" | "capture" | "review" | "done">("intro");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [captureIndex, setCaptureIndex] = useState(0);
  const [shots, setShots] = useState<Partial<Record<CaptureKey, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((tr) => tr.stop());
    setStream(null);
  }, [stream]);

  useEffect(() => {
    if (!token || token === "placeholder") {
      setSession({
        loading: false,
        valid: false,
        message: t("enroll.invalidLink"),
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/v1/public/face-enrollment/${encodeURIComponent(token)}`);
        const data = (await res.json()) as {
          valid?: boolean;
          code?: string;
          message?: string;
          employeeName?: string;
          expired?: boolean;
        };
        if (cancelled) return;
        if (!res.ok || data.valid === false) {
          setSession({
            loading: false,
            valid: false,
            message: data.message ?? t("enroll.invalidLink"),
          });
          return;
        }
        setSession({
          loading: false,
          valid: true,
          employeeName: data.employeeName ?? "",
          expired: !!data.expired,
        });
      } catch {
        if (!cancelled) {
          setSession({ loading: false, valid: false, message: t("enroll.sessionError") });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
  }, [stream]);

  const startCamera = async () => {
    setCameraError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      setStream(s);
      setStep("capture");
      setCaptureIndex(0);
      setShots({});
    } catch {
      setCameraError(t("enroll.cameraDenied"));
    }
  };

  const currentKey = CAPTURE_ORDER[captureIndex] ?? "front";

  const takeShot = () => {
    const v = videoRef.current;
    if (!v) return;
    const data = snapVideoFrame(v);
    if (!data) {
      toast.error(t("enroll.captureFailed"));
      return;
    }
    setShots((prev) => ({ ...prev, [currentKey]: data }));
    if (captureIndex + 1 >= CAPTURE_ORDER.length) {
      stopCamera();
      setStep("review");
    } else {
      setCaptureIndex((i) => i + 1);
    }
  };

  const submit = async () => {
    const front = shots.front;
    if (!front) {
      toast.error(t("enroll.needFront"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/public/face-enrollment/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frontImageBase64: front,
          rightImageBase64: shots.right ?? undefined,
          leftImageBase64: shots.left ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error || data.message || t("enroll.submitFailed"));
      }
      setStep("done");
      toast.success(t("enroll.success"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("enroll.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (session.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-fms-bg p-6">
        <p className="text-fms-text-secondary">{t("enroll.loading")}</p>
      </div>
    );
  }

  if (!session.valid) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-fms-bg p-6 text-center max-w-md mx-auto">
        <h1 className="text-xl font-semibold text-fms-text m-0 mb-2">{t("enroll.invalidTitle")}</h1>
        <p className="text-sm text-fms-text-secondary m-0">{session.message}</p>
      </div>
    );
  }

  if (session.expired) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-fms-bg p-6 text-center max-w-md mx-auto">
        <h1 className="text-xl font-semibold text-fms-text m-0 mb-2">{t("enroll.expiredTitle")}</h1>
        <p className="text-sm text-fms-text-secondary m-0">{t("enroll.expiredBody")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fms-bg text-fms-text p-6">
      <div className="max-w-lg mx-auto flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold m-0 mb-1">{t("enroll.title")}</h1>
          <p className="text-sm text-fms-text-secondary m-0">
            {t("enroll.welcome", { name: session.employeeName })}
          </p>
        </header>

        {step === "intro" && (
          <div className="rounded-2xl border border-fms-border bg-fms-surface p-6 flex flex-col gap-4">
            <p className="text-sm text-fms-text-secondary m-0">{t("enroll.introBody")}</p>
            <button
              type="button"
              onClick={() => void startCamera()}
              className="inline-flex justify-center items-center px-5 py-3 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover"
            >
              {t("enroll.startCamera")}
            </button>
            {cameraError && <p className="text-sm text-red-600 m-0">{cameraError}</p>}
          </div>
        )}

        {step === "capture" && (
          <div className="rounded-2xl border border-fms-border bg-fms-surface p-4 flex flex-col gap-4">
            <p className="text-sm font-medium m-0">{t(`enroll.pose.${currentKey}`)}</p>
            <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3]">
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            </div>
            <button
              type="button"
              onClick={takeShot}
              className="inline-flex justify-center items-center px-5 py-3 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover"
            >
              {t("enroll.capture")}
            </button>
            <p className="text-xs text-fms-text-tertiary m-0">
              {t("enroll.progress", { current: captureIndex + 1, total: CAPTURE_ORDER.length })}
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="rounded-2xl border border-fms-border bg-fms-surface p-6 flex flex-col gap-4">
            <p className="text-sm text-fms-text-secondary m-0">{t("enroll.reviewBody")}</p>
            <div className="grid grid-cols-3 gap-2">
              {CAPTURE_ORDER.map((k) => (
                <div key={k} className="flex flex-col gap-1">
                  <span className="text-xs text-fms-text-tertiary">{t(`enroll.poseShort.${k}`)}</span>
                  {shots[k] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={shots[k]} alt="" className="rounded-lg w-full aspect-square object-cover" />
                  ) : (
                    <div className="rounded-lg bg-fms-bg-subtle aspect-square" />
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => submit()}
                className="inline-flex justify-center items-center px-5 py-3 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-50"
              >
                {submitting ? t("enroll.submitting") : t("enroll.submit")}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  setStep("intro");
                  setCaptureIndex(0);
                  setShots({});
                }}
                className="inline-flex justify-center items-center px-5 py-3 rounded-2xl text-sm font-medium border border-fms-border"
              >
                {t("enroll.startOver")}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="rounded-2xl border border-fms-border bg-fms-surface p-8 text-center">
            <p className="text-lg font-medium m-0 mb-2">{t("enroll.doneTitle")}</p>
            <p className="text-sm text-fms-text-secondary m-0">{t("enroll.doneBody")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
