"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import { logClientAudit } from "@/modules/audit-logs/api/logClientAudit";
import { IconSettings, IconClock, IconCamera, IconPlus, IconPencil, IconGrid, IconShield, IconEye, IconFace } from "@/core/layout/icons";
import { useTheme } from "@/core/contexts/ThemeContext";
import { isTauri } from "@/core/tauri/isTauri";
import { useAppPreferences } from "@/core/contexts/AppPreferencesContext";
import { CURRENT_APP_VERSION, APP_NAME } from "@/modules/settings/constants";
import UploadLogo from "@/modules/onboarding/components/UploadLogo/UploadLogo";
import FaceRecognitionTestCard from "./FaceRecognitionTestCard";
import StreamTesterCard from "./StreamTesterCard";
import type { StreamTesterHandle } from "./StreamTesterCard";
import SystemInfoCard from "./SystemInfoCard";
import styles from "./UpdateModal.module.css";
import cameraStyles from "./CameraSection.module.css";
import pageStyles from "./SettingsPage.module.css";

const MODAL_CLOSE_DURATION = 220;

export type CameraType = "check_in" | "check_out";

export interface Camera {
  id: string;
  name: string;
  type: CameraType;
  /** Camera IP used for RTSP (e.g. 192.168.1.100 or full rtsp:// URL). */
  rtspIp: string;
}
const CHECK_DURATION_MS = 2200;

type UpdateModalState = "idle" | "checking" | "update_available" | "up_to_date";

/** Simulated check: sometimes returns a newer version for demo. In production, call your update API. */
async function checkForUpdate(): Promise<{ available: boolean; latestVersion?: string }> {
  await new Promise((r) => setTimeout(r, CHECK_DURATION_MS));
  const hasUpdate = Math.random() > 0.3;
  return hasUpdate ? { available: true, latestVersion: "1.1.0" } : { available: false };
}

type SettingsTab = "system" | "preferences" | "configurations" | "license";

const TIME_CONFIG_DEFAULTS = {
  checkInStart: "08:00",
  checkInEnd: "10:00",
  checkOutStart: "16:00",
  checkOutEnd: "18:00",
};

/** License display – loaded from API when License tab is active. */
const LICENSE_PLACEHOLDER = {
  expirationDate: null as Date | null,
  licenseKeyMasked: "••••-••••-••••-••••",
};

export default function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("system");
  const { theme, setTheme } = useTheme();
  const {
    applicationName,
    logoUrl,
    displayDensity,
    setApplicationName,
    setLogoUrl,
    setDisplayDensity,
    getDisplayName,
  } = useAppPreferences();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateModalClosing, setUpdateModalClosing] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateModalState>("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [automaticUpdateEnabled, setAutomaticUpdateEnabled] = useState(false);
  const [autoUpdateModalOpen, setAutoUpdateModalOpen] = useState(false);
  const [autoUpdateModalClosing, setAutoUpdateModalClosing] = useState(false);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [cameraModalClosing, setCameraModalClosing] = useState(false);
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null);
  const [cameraForm, setCameraForm] = useState({ name: "", type: "check_in" as CameraType, rtspIp: "" });
  const [licenseCopied, setLicenseCopied] = useState(false);
  const [licenseKeyVisible, setLicenseKeyVisible] = useState(false);
  const [licenseInfo, setLicenseInfo] = useState<{
    licenseKeyMasked: string;
    licenseKeyFull: string;
    expirationDate: Date | null;
  }>({
    licenseKeyMasked: LICENSE_PLACEHOLDER.licenseKeyMasked,
    licenseKeyFull: "",
    expirationDate: null,
  });
  const [checkInStartTime, setCheckInStartTime] = useState("08:00");
  const [checkInEndTime, setCheckInEndTime] = useState("10:00");
  const [checkOutStartTime, setCheckOutStartTime] = useState("16:00");
  const [checkOutEndTime, setCheckOutEndTime] = useState("18:00");
  const [timeConfigSavedFeedback, setTimeConfigSavedFeedback] = useState(false);
  const [timeConfigLoadError, setTimeConfigLoadError] = useState<string | null>(null);
  const [timeConfigSaving, setTimeConfigSaving] = useState(false);
  const [timeConfirmModalOpen, setTimeConfirmModalOpen] = useState(false);
  const [timeConfirmModalClosing, setTimeConfirmModalClosing] = useState(false);
  const [demoDataLoading, setDemoDataLoading] = useState(false);
  const [onboardingCamera, setOnboardingCamera] = useState<{ name: string; rtspIp: string } | null>(null);
  const [onboardingCameraModalOpen, setOnboardingCameraModalOpen] = useState(false);
  const [onboardingCameraModalClosing, setOnboardingCameraModalClosing] = useState(false);
  const [onboardingCameraForm, setOnboardingCameraForm] = useState({ name: "", rtspIp: "" });
  const [cameraSettingsLoadError, setCameraSettingsLoadError] = useState<string | null>(null);
  const [cameraSettingsSaving, setCameraSettingsSaving] = useState(false);
  const [preferencesSavedFeedback, setPreferencesSavedFeedback] = useState(false);
  const brandingPrevRef = useRef<{ applicationName: string | null; logoUrl: string | null } | null>(null);

  useEffect(() => {
    if (activeTab !== "license") return;
    let mounted = true;
    Promise.all([
      apiFetch("/api/v1/config").then((r) => r.json()),
      apiFetch("/api/v1/license").then((r) => r.json()),
    ])
      .then(([config, licenseData]) => {
        if (!mounted) return;
        const c = config as { licenseKeyMasked?: string };
        const lic = licenseData as { licenseKey?: string };
        setLicenseInfo((prev) => ({
          ...prev,
          licenseKeyMasked: typeof c?.licenseKeyMasked === "string" ? c.licenseKeyMasked.trim() : prev.licenseKeyMasked,
          licenseKeyFull: typeof lic?.licenseKey === "string" ? lic.licenseKey.trim() : prev.licenseKeyFull,
        }));
        logClientAudit({
          action: "viewed",
          resource: "license",
          descriptionKey: "auditLogs.descLicenseViewed",
          descriptionParams: {},
        });
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [activeTab]);

  useEffect(() => {
    const next = { applicationName: applicationName ?? null, logoUrl: logoUrl ?? null };
    if (
      brandingPrevRef.current !== null &&
      (brandingPrevRef.current.applicationName !== next.applicationName ||
        brandingPrevRef.current.logoUrl !== next.logoUrl)
    ) {
      setPreferencesSavedFeedback(true);
      const t = setTimeout(() => setPreferencesSavedFeedback(false), 2500);
      brandingPrevRef.current = next;
      return () => clearTimeout(t);
    }
    brandingPrevRef.current = next;
  }, [applicationName, logoUrl]);

  const saveBranding = useCallback(() => {
    logClientAudit({
      action: "update",
      resource: "settings",
      descriptionKey: "auditLogs.descBrandingUpdated",
      descriptionParams: {},
      changes: {
        applicationName: applicationName?.trim() ?? null,
        logoUpdated: !!(logoUrl && logoUrl.trim()),
      },
    });
    setPreferencesSavedFeedback(true);
    setTimeout(() => setPreferencesSavedFeedback(false), 2500);
  }, [applicationName, logoUrl]);

  const persistCameraSettings = useCallback(
    async (checkInOutCameras: Camera[], onboardingCameraValue: { name: string; rtspIp: string } | null) => {
      setCameraSettingsSaving(true);
      setCameraSettingsLoadError(null);
      try {
        const res = await apiFetch("/api/v1/settings/cameras", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkInOutCameras,
            onboardingCamera: onboardingCameraValue,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Failed to save");
        }
        const data = (await res.json()) as {
          checkInOutCameras: Camera[];
          onboardingCamera: { name: string; rtspIp: string } | null;
        };
        setCameras(data.checkInOutCameras);
        setOnboardingCamera(data.onboardingCamera);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to save camera settings.";
        setCameraSettingsLoadError(message);
        setTimeout(() => setCameraSettingsLoadError(null), 5000);
        throw e;
      } finally {
        setCameraSettingsSaving(false);
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    setTimeConfigLoadError(null);
    apiFetch("/api/v1/settings/time-config")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load"))))
      .then((data: { checkInStart?: string; checkInEnd?: string; checkOutStart?: string; checkOutEnd?: string }) => {
        if (cancelled) return;
        if (
          typeof data?.checkInStart === "string" &&
          typeof data?.checkInEnd === "string" &&
          typeof data?.checkOutStart === "string" &&
          typeof data?.checkOutEnd === "string"
        ) {
          setCheckInStartTime(data.checkInStart);
          setCheckInEndTime(data.checkInEnd);
          setCheckOutStartTime(data.checkOutStart);
          setCheckOutEndTime(data.checkOutEnd);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTimeConfigLoadError("Could not load time settings.");
          setCheckInStartTime(TIME_CONFIG_DEFAULTS.checkInStart);
          setCheckInEndTime(TIME_CONFIG_DEFAULTS.checkInEnd);
          setCheckOutStartTime(TIME_CONFIG_DEFAULTS.checkOutStart);
          setCheckOutEndTime(TIME_CONFIG_DEFAULTS.checkOutEnd);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "configurations") return;
    let cancelled = false;
    setCameraSettingsLoadError(null);
    apiFetch("/api/v1/settings/cameras")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load"))))
      .then(
        (data: {
          checkInOutCameras?: { id: string; name: string; type: CameraType; rtspIp: string }[];
          onboardingCamera?: { name: string; rtspIp: string } | null;
        }) => {
          if (cancelled) return;
          if (Array.isArray(data?.checkInOutCameras)) {
            setCameras(
              data.checkInOutCameras.filter(
                (c): c is Camera =>
                  c && typeof c.id === "string" && typeof c.name === "string" && (c.type === "check_in" || c.type === "check_out") && typeof c.rtspIp === "string"
              )
            );
          }
          if (data?.onboardingCamera && typeof data.onboardingCamera.name === "string" && typeof data.onboardingCamera.rtspIp === "string") {
            setOnboardingCamera({ name: data.onboardingCamera.name, rtspIp: data.onboardingCamera.rtspIp });
          } else {
            setOnboardingCamera(null);
          }
        }
      )
      .catch(() => {
        if (!cancelled) setCameraSettingsLoadError("Could not load camera settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const timeConfigValid =
    checkInStartTime < checkInEndTime && checkOutStartTime < checkOutEndTime;
  const timeConfigError =
    !timeConfigValid &&
    (checkInStartTime >= checkInEndTime
      ? "checkIn"
      : checkOutStartTime >= checkOutEndTime
        ? "checkOut"
        : null);

  const openTimeConfirmModal = useCallback(() => {
    if (!timeConfigValid) return;
    setTimeConfirmModalOpen(true);
    setTimeConfirmModalClosing(false);
  }, [timeConfigValid]);

  const closeTimeConfirmModal = useCallback(() => {
    setTimeConfirmModalClosing(true);
    const id = setTimeout(() => {
      setTimeConfirmModalOpen(false);
      setTimeConfirmModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const confirmSaveTimeConfig = useCallback(async () => {
    const config = {
      checkInStart: checkInStartTime,
      checkInEnd: checkInEndTime,
      checkOutStart: checkOutStartTime,
      checkOutEnd: checkOutEndTime,
    };
    setTimeConfigSaving(true);
    try {
      const res = await apiFetch("/api/v1/settings/time-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Failed to save");
      }
      setTimeConfigSavedFeedback(true);
      setTimeout(() => setTimeConfigSavedFeedback(false), 3000);
      closeTimeConfirmModal();
      // Audit log is written server-side by the PATCH handler
    } catch (e) {
      setTimeConfigSavedFeedback(false);
      const message = e instanceof Error ? e.message : "Failed to save time settings.";
      setTimeConfigLoadError(message);
      setTimeout(() => setTimeConfigLoadError(null), 5000);
    } finally {
      setTimeConfigSaving(false);
    }
  }, [
    checkInStartTime,
    checkInEndTime,
    checkOutStartTime,
    checkOutEndTime,
    closeTimeConfirmModal,
  ]);

  const copyLicenseKey = useCallback(() => {
    const text = licenseInfo.licenseKeyFull || licenseInfo.licenseKeyMasked || LICENSE_PLACEHOLDER.licenseKeyMasked;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setLicenseCopied(true);
        setTimeout(() => setLicenseCopied(false), 2000);
        toast.success(t("settings.licenseCopiedToast"));
        logClientAudit({
          action: "copied",
          resource: "license",
          descriptionKey: "auditLogs.descLicenseCopied",
          descriptionParams: {},
        });
      });
    }
  }, [licenseInfo.licenseKeyFull, licenseInfo.licenseKeyMasked, t]);

  const openUpdateModal = useCallback(() => {
    setUpdateState("checking");
    setLatestVersion(null);
    setUpdateModalOpen(true);
    setUpdateModalClosing(false);
    checkForUpdate().then((result) => {
      if (result.available && result.latestVersion) {
        setLatestVersion(result.latestVersion);
        setUpdateState("update_available");
      } else {
        setUpdateState("up_to_date");
      }
    });
  }, []);

  const closeUpdateModal = useCallback(() => {
    setUpdateModalClosing(true);
    const id = setTimeout(() => {
      setUpdateModalOpen(false);
      setUpdateState("idle");
      setLatestVersion(null);
      setUpdateModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const handleAgreeToUpdate = useCallback(() => {
    // In production: trigger update flow (e.g. download, install, reload)
    closeUpdateModal();
  }, [closeUpdateModal]);

  const openAutoUpdateModal = useCallback(() => {
    setAutoUpdateModalOpen(true);
    setAutoUpdateModalClosing(false);
  }, []);

  const closeAutoUpdateModal = useCallback(() => {
    setAutoUpdateModalClosing(true);
    const id = setTimeout(() => {
      setAutoUpdateModalOpen(false);
      setAutoUpdateModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const enableAutomaticUpdate = useCallback(() => {
    setAutomaticUpdateEnabled(true);
    closeAutoUpdateModal();
  }, [closeAutoUpdateModal]);

  const openCameraModal = useCallback((camera?: Camera) => {
    if (camera) {
      setEditingCameraId(camera.id);
      setCameraForm({ name: camera.name, type: camera.type, rtspIp: camera.rtspIp });
    } else {
      setEditingCameraId(null);
      setCameraForm({ name: "", type: "check_in", rtspIp: "" });
    }
    setCameraModalOpen(true);
    setCameraModalClosing(false);
  }, []);

  const closeCameraModal = useCallback(() => {
    setCameraModalClosing(true);
    const id = setTimeout(() => {
      setCameraModalOpen(false);
      setEditingCameraId(null);
      setCameraForm({ name: "", type: "check_in", rtspIp: "" });
      setCameraModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const saveCamera = useCallback(async () => {
    const name = cameraForm.name.trim();
    const rtspIp = cameraForm.rtspIp.trim();
    if (!name || !rtspIp) return;
    const newCameras = editingCameraId
      ? cameras.map((c) =>
          c.id === editingCameraId ? { ...c, name, type: cameraForm.type, rtspIp } : c
        )
      : [
          ...cameras,
          {
            id: String(Date.now()),
            name,
            type: cameraForm.type,
            rtspIp,
          } as Camera,
        ];
    try {
      await persistCameraSettings(newCameras, onboardingCamera);
      closeCameraModal();
    } catch {
      // Error already shown by persistCameraSettings
    }
  }, [cameraForm, editingCameraId, cameras, onboardingCamera, persistCameraSettings, closeCameraModal]);

  const openOnboardingCameraModal = useCallback((current?: { name: string; rtspIp: string }) => {
    if (current) {
      setOnboardingCameraForm({ name: current.name, rtspIp: current.rtspIp });
    } else {
      setOnboardingCameraForm({ name: "", rtspIp: "" });
    }
    setOnboardingCameraModalOpen(true);
    setOnboardingCameraModalClosing(false);
  }, []);

  const closeOnboardingCameraModal = useCallback(() => {
    setOnboardingCameraModalClosing(true);
    const id = setTimeout(() => {
      setOnboardingCameraModalOpen(false);
      setOnboardingCameraForm({ name: "", rtspIp: "" });
      setOnboardingCameraModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const saveOnboardingCamera = useCallback(async () => {
    const name = onboardingCameraForm.name.trim();
    const rtspIp = onboardingCameraForm.rtspIp.trim();
    if (!name || !rtspIp) return;
    try {
      await persistCameraSettings(cameras, { name, rtspIp });
      closeOnboardingCameraModal();
    } catch {
      // Error already shown by persistCameraSettings
    }
  }, [onboardingCameraForm, cameras, persistCameraSettings, closeOnboardingCameraModal]);

  const removeOnboardingCamera = useCallback(async () => {
    if (typeof window !== "undefined" && !window.confirm(t("settings.confirmRemoveCamera"))) return;
    try {
      await persistCameraSettings(cameras, null);
    } catch {
      // Error already shown by persistCameraSettings
    }
  }, [cameras, persistCameraSettings, t]);

  const removeCamera = useCallback(
    async (id: string) => {
      if (typeof window !== "undefined" && !window.confirm(t("settings.confirmRemoveCamera"))) return;
      const nextCameras = cameras.filter((c) => c.id !== id);
      try {
        await persistCameraSettings(nextCameras, onboardingCamera);
      } catch {
        // Error already shown by persistCameraSettings
      }
    },
    [cameras, onboardingCamera, persistCameraSettings, t]
  );

  // Connection test state
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [connectionTestResult, setConnectionTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  const testConnection = useCallback(async (rtspUrl: string, id: string) => {
    setTestingConnectionId(id);
    setConnectionTestResult((prev) => ({ ...prev, [id]: { ok: false, message: "Testing..." } }));
    try {
      // Normalize: if it's just an IP, prepend rtsp:// and default port
      let url = rtspUrl.trim();
      if (url && !url.startsWith("rtsp://")) {
        url = `rtsp://${url}${url.includes(":") ? "" : ":554"}`;
      }
      const res = await apiFetch("/api/v1/zones/cameras/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor: "generic", rtsp: url }),
      });
      const data = (await res.json()) as { ok?: boolean; latencyMs?: number; errorMessage?: string; errorCode?: string };
      if (data.ok) {
        setConnectionTestResult((prev) => ({ ...prev, [id]: { ok: true, message: `Connected${data.latencyMs ? ` (${data.latencyMs}ms)` : ""}` } }));
      } else {
        setConnectionTestResult((prev) => ({ ...prev, [id]: { ok: false, message: data.errorMessage || data.errorCode || "Unreachable" } }));
      }
    } catch (e) {
      setConnectionTestResult((prev) => ({ ...prev, [id]: { ok: false, message: e instanceof Error ? e.message : "Test failed" } }));
    } finally {
      setTestingConnectionId(null);
    }
  }, []);

  // Open stream tester modal for a specific camera
  const streamTesterRef = useRef<StreamTesterHandle>(null);
  const testStreamForCamera = useCallback((name: string, group: string, rtspUrl: string) => {
    // Normalize: ensure rtsp:// prefix for the player
    let url = rtspUrl.trim();
    if (url && !url.startsWith("rtsp://")) {
      url = `rtsp://${url}${url.includes(":") ? "" : ":554"}`;
    }
    streamTesterRef.current?.open({
      locationName: group,
      camera: { name, ip: "", rtsp: url } as import("@/modules/zones/types").ZoneConfig,
    });
  }, []);

  const settingsAuditRef = useRef({ applicationName, logoUrl, theme, displayDensity });
  useEffect(() => {
    const prev = settingsAuditRef.current;
    if (
      prev.applicationName !== applicationName ||
      prev.logoUrl !== logoUrl ||
      prev.theme !== theme ||
      prev.displayDensity !== displayDensity
    ) {
      settingsAuditRef.current = { applicationName, logoUrl, theme, displayDensity };
      const id = setTimeout(() => {
        logClientAudit({
          action: "update",
          resource: "settings",
          descriptionKey: "auditLogs.descPreferencesUpdated",
          descriptionParams: {},
          changes: { theme, displayDensity },
        });
      }, 1000);
      return () => clearTimeout(id);
    }
  }, [applicationName, logoUrl, theme, displayDensity]);

  useEffect(() => {
    if (!updateModalOpen || updateModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && updateState !== "checking") closeUpdateModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [updateModalOpen, updateModalClosing, updateState, closeUpdateModal]);

  useEffect(() => {
    if (!autoUpdateModalOpen || autoUpdateModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAutoUpdateModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [autoUpdateModalOpen, autoUpdateModalClosing, closeAutoUpdateModal]);

  useEffect(() => {
    if (!cameraModalOpen || cameraModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCameraModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cameraModalOpen, cameraModalClosing, closeCameraModal]);

  useEffect(() => {
    if (!onboardingCameraModalOpen || onboardingCameraModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOnboardingCameraModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onboardingCameraModalOpen, onboardingCameraModalClosing, closeOnboardingCameraModal]);

  useEffect(() => {
    if (!timeConfirmModalOpen || timeConfirmModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTimeConfirmModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [timeConfirmModalOpen, timeConfirmModalClosing, closeTimeConfirmModal]);

  return (
    <DashboardLayout title={t("nav.settings")}>
      <div className="w-full max-w-none">
        <p className="text-sm text-fms-text-secondary mb-4 m-0">
          {t("settings.pageDescription")}
        </p>

        <div className={pageStyles.tabBarWrap}>
          <div className={pageStyles.tabBar} role="tablist" aria-label={t("settings.tabsLabel")}>
            <button
            type="button"
            role="tab"
            aria-selected={activeTab === "system"}
            aria-controls="settings-panel-system"
            id="settings-tab-system"
            className={pageStyles.tab}
            onClick={() => setActiveTab("system")}
          >
            <span className="flex items-center gap-2">
              <IconSettings className="w-4 h-4" aria-hidden />
              {t("settings.tabSystem")}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "preferences"}
            aria-controls="settings-panel-preferences"
            id="settings-tab-preferences"
            className={pageStyles.tab}
            onClick={() => setActiveTab("preferences")}
          >
            <span className="flex items-center gap-2">
              <IconPencil className="w-4 h-4" aria-hidden />
              {t("settings.tabPreferences")}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "configurations"}
            aria-controls="settings-panel-configurations"
            id="settings-tab-configurations"
            className={pageStyles.tab}
            onClick={() => setActiveTab("configurations")}
          >
            <span className="flex items-center gap-2">
              <IconGrid className="w-4 h-4" aria-hidden />
              {t("settings.tabConfigurations")}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "license"}
            aria-controls="settings-panel-license"
            id="settings-tab-license"
            className={pageStyles.tab}
            onClick={() => setActiveTab("license")}
          >
            <span className="flex items-center gap-2">
              <IconShield className="w-4 h-4" aria-hidden />
              {t("settings.tabLicense")}
            </span>
          </button>
          </div>
          <button
            type="button"
            onClick={openUpdateModal}
            className={pageStyles.tabBarActionBtn}
            aria-label={t("settings.checkForUpdates")}
          >
            <IconClock className="w-4 h-4" aria-hidden />
            {t("settings.checkForUpdates")}
          </button>
        </div>

        {activeTab === "system" && (
          <div
            id="settings-panel-system"
            role="tabpanel"
            aria-labelledby="settings-tab-system"
            className={pageStyles.tabPanel}
          >
        {/* About application card */}
        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full">
          <div className="p-5 border-b border-fms-border bg-fms-bg-subtle/20">
            <h2 className="text-base font-semibold text-fms-text m-0 flex items-center gap-2">
              <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
                <IconSettings className="w-5 h-5" aria-hidden />
              </span>
              {t("settings.aboutApplication")}
            </h2>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-fms-text-tertiary uppercase tracking-wide m-0">
                  {t("settings.applicationName")}
                </p>
                <p className="text-fms-text font-medium m-0 mt-0.5">{APP_NAME}</p>
              </div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
                <span className="w-2 h-2 rounded-full bg-current animate-pulse" aria-hidden />
                <span className="text-sm font-medium">{t("settings.statusOperational")}</span>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-fms-text-tertiary uppercase tracking-wide m-0">
                {t("settings.currentVersion")}
              </p>
              <p className="text-fms-text font-semibold m-0 mt-0.5">{CURRENT_APP_VERSION}</p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={openUpdateModal}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                aria-label={t("settings.checkForUpdates")}
              >
                {t("settings.checkForUpdates")}
              </button>
            </div>
          </div>
        </section>

        {/* Automatic update card */}
        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full mt-6">
          <div className="p-5 border-b border-fms-border bg-fms-bg-subtle/20">
            <h2 className="text-base font-semibold text-fms-text m-0 flex items-center gap-2">
              <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
                <IconClock className="w-5 h-5" aria-hidden />
              </span>
              {t("settings.automaticUpdate")}
            </h2>
          </div>
          <div className="p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-fms-text-secondary m-0">
                {t("settings.automaticUpdateDescription")}
              </p>
              <p className="text-sm font-medium text-fms-text mt-2 m-0">
                {automaticUpdateEnabled
                  ? t("settings.automaticUpdateEnabled")
                  : t("settings.automaticUpdateDisabled")}
              </p>
            </div>
            {automaticUpdateEnabled ? (
              <button
                type="button"
                onClick={() => setAutomaticUpdateEnabled(false)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold border border-fms-border text-fms-text-secondary hover:bg-fms-bg-subtle transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                aria-label={t("settings.disableAutomaticUpdate")}
              >
                {t("settings.disableAutomaticUpdate")}
              </button>
            ) : (
              <button
                type="button"
                onClick={openAutoUpdateModal}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                aria-label={t("settings.enableAutomaticUpdate")}
              >
                {t("settings.enableAutomaticUpdate")}
              </button>
            )}
          </div>
        </section>

        {/* Demo data (desktop only; data stays local, not synced to cloud) */}
        {isTauri() && (
          <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full mt-6">
            <div className="p-5 border-b border-fms-border bg-fms-bg-subtle/20">
              <h2 className="text-base font-semibold text-fms-text m-0 flex items-center gap-2">
                <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
                  <IconGrid className="w-5 h-5" aria-hidden />
                </span>
                {t("settings.demoData")}
              </h2>
              <p className="text-sm text-fms-text-secondary mt-2 m-0">
                {t("settings.demoDataDescription")}
              </p>
            </div>
            <div className="p-5">
              <button
                type="button"
                onClick={async () => {
                  setDemoDataLoading(true);
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    const result = await invoke<{
                      person_types: number;
                      zones: number;
                      shifts: number;
                      employees: number;
                      activities: number;
                    }>("seed_demo_data");
                    toast.success(
                      t("settings.demoDataLoaded", {
                        personTypes: result.person_types,
                        zones: result.zones,
                        shifts: result.shifts,
                        employees: result.employees,
                        activities: result.activities,
                      })
                    );
                    window.location.reload();
                  } catch (err: unknown) {
                    const message =
                      err instanceof Error
                        ? err.message
                        : typeof err === "string"
                          ? err
                          : JSON.stringify(err);
                    console.error("[Demo data]", err);
                    toast.error(t("settings.demoDataError", { message }));
                  } finally {
                    setDemoDataLoading(false);
                  }
                }}
                disabled={demoDataLoading}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                aria-label={t("settings.loadDemoData")}
              >
                {demoDataLoading ? t("settings.saving") : t("settings.loadDemoData")}
              </button>
            </div>
          </section>
        )}

            <SystemInfoCard />
          </div>
        )}

        {activeTab === "configurations" && (
          <div
            id="settings-panel-configurations"
            role="tabpanel"
            aria-labelledby="settings-tab-configurations"
            className={pageStyles.tabPanel}
          >
            {cameraSettingsLoadError && (
              <p className="text-sm text-amber-600 dark:text-amber-400 mb-4 m-0" role="alert">
                {cameraSettingsLoadError}
              </p>
            )}
            {/* Check-in & check-out time (daily) */}
            <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm w-full">
              <div className="p-5 border-b border-fms-border bg-fms-bg-subtle/20">
                <h2 className="text-base font-semibold text-fms-text m-0 flex items-center gap-2">
                  <span className="rounded-xl bg-fms-accent-muted p-2 text-fms-accent">
                    <IconClock className="w-5 h-5" aria-hidden />
                  </span>
                  {t("settings.configTimeTitle")}
                </h2>
                <p className="text-sm text-fms-text-secondary mt-2 m-0">
                  {t("settings.configTimeDescription")}
                </p>
                {timeConfigLoadError && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-2 m-0" role="alert">
                    {timeConfigLoadError}
                  </p>
                )}
              </div>
              <div className="p-5 space-y-4">
                {timeConfigError && (
                  <p className="text-sm text-red-600 dark:text-red-400 m-0 flex items-center gap-1.5" role="alert">
                    <span aria-hidden>⚠</span>
                    {timeConfigError === "checkIn"
                      ? t("settings.timeConfigErrorCheckIn")
                      : t("settings.timeConfigErrorCheckOut")}
                  </p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-semibold text-fms-text mb-2 m-0">{t("settings.checkInTimeLabel")}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="config-check-in-start" className="block text-xs font-medium text-fms-text-secondary mb-1">
                          {t("settings.checkInStartTimeLabel")}
                        </label>
                        <input
                          id="config-check-in-start"
                          type="time"
                          value={checkInStartTime}
                          onChange={(e) => setCheckInStartTime(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-fms-border bg-fms-bg text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent focus:border-fms-accent"
                          aria-invalid={timeConfigError === "checkIn" ? "true" : undefined}
                        />
                      </div>
                      <div>
                        <label htmlFor="config-check-in-end" className="block text-xs font-medium text-fms-text-secondary mb-1">
                          {t("settings.checkInEndTimeLabel")}
                        </label>
                        <input
                          id="config-check-in-end"
                          type="time"
                          value={checkInEndTime}
                          onChange={(e) => setCheckInEndTime(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-fms-border bg-fms-bg text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent focus:border-fms-accent"
                          aria-invalid={timeConfigError === "checkIn" ? "true" : undefined}
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-fms-text mb-2 m-0">{t("settings.checkOutTimeLabel")}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="config-check-out-start" className="block text-xs font-medium text-fms-text-secondary mb-1">
                          {t("settings.checkOutStartTimeLabel")}
                        </label>
                        <input
                          id="config-check-out-start"
                          type="time"
                          value={checkOutStartTime}
                          onChange={(e) => setCheckOutStartTime(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-fms-border bg-fms-bg text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent focus:border-fms-accent"
                          aria-invalid={timeConfigError === "checkOut" ? "true" : undefined}
                        />
                      </div>
                      <div>
                        <label htmlFor="config-check-out-end" className="block text-xs font-medium text-fms-text-secondary mb-1">
                          {t("settings.checkOutEndTimeLabel")}
                        </label>
                        <input
                          id="config-check-out-end"
                          type="time"
                          value={checkOutEndTime}
                          onChange={(e) => setCheckOutEndTime(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-fms-border bg-fms-bg text-fms-text text-sm focus:outline-none focus:ring-2 focus:ring-fms-accent focus:border-fms-accent"
                          aria-invalid={timeConfigError === "checkOut" ? "true" : undefined}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={openTimeConfirmModal}
                    disabled={!timeConfigValid}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                    aria-label={t("settings.saveTimes")}
                  >
                    {t("settings.saveTimes")}
                  </button>
                  {timeConfigSavedFeedback && (
                    <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium" role="status">
                      {t("settings.timesSavedSuccess")}
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* Employee onboarding camera */}
            <section className={cameraStyles.card + " w-full mt-6"}>
              <div className={cameraStyles.cardHeader}>
                <h2 className={cameraStyles.cardTitle}>
                  <span className={cameraStyles.cardTitleIcon} aria-hidden>
                    <IconFace className="w-5 h-5" />
                  </span>
                  {t("settings.onboardingCameraTitle")}
                </h2>
                <p className={cameraStyles.cardDescription}>
                  {t("settings.onboardingCameraDescription")}
                </p>
              </div>
              <div className={cameraStyles.cardBody}>
                {!onboardingCamera ? (
                  <div className={cameraStyles.emptyState}>
                    <div className={cameraStyles.emptyStateIcon} aria-hidden>
                      <IconFace className="w-10 h-10" />
                    </div>
                    <p className={cameraStyles.emptyStateTitle}>{t("settings.noOnboardingCameraYet")}</p>
                    <p className={cameraStyles.emptyStateHint}>{t("settings.noOnboardingCameraHint")}</p>
                    <button
                      type="button"
                      onClick={() => openOnboardingCameraModal()}
                      className={cameraStyles.addCameraBtn}
                      aria-label={t("settings.addOnboardingCamera")}
                    >
                      <IconPlus className="w-5 h-5" aria-hidden />
                      {t("settings.addOnboardingCamera")}
                    </button>
                  </div>
                ) : (
                  <div className={cameraStyles.cameraItem}>
                    <div className={cameraStyles.cameraItemInfo}>
                      <p className={cameraStyles.cameraItemName}>{onboardingCamera.name}</p>
                      <p className={cameraStyles.cameraItemMeta}>
                        <span className={cameraStyles.cameraBadge + " " + cameraStyles.cameraBadgeOnboarding}>
                          {t("settings.onboardingCameraBadge")}
                        </span>
                        <span className="ml-2 text-fms-text-tertiary"> · {onboardingCamera.rtspIp}</span>
                      </p>
                      {connectionTestResult["onboarding"] && (
                        <p style={{ margin: "4px 0 0", fontSize: "0.6875rem", color: connectionTestResult["onboarding"].ok ? "#4ade80" : "#f87171" }}>
                          {connectionTestResult["onboarding"].message}
                        </p>
                      )}
                    </div>
                    <div className={cameraStyles.cameraItemActions}>
                      <button
                        type="button"
                        onClick={() => testConnection(onboardingCamera.rtspIp, "onboarding")}
                        className={cameraStyles.cameraItemBtn}
                        disabled={testingConnectionId === "onboarding"}
                        title={t("settings.testConnection")}
                      >
                        {testingConnectionId === "onboarding" ? "…" : <IconEye className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => testStreamForCamera(onboardingCamera.name, "Onboarding", onboardingCamera.rtspIp)}
                        className={cameraStyles.cameraItemBtn}
                        title={t("settings.testStream")}
                      >
                        <IconCamera className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openOnboardingCameraModal(onboardingCamera)}
                        className={cameraStyles.cameraItemBtn}
                        aria-label={t("settings.editCamera")}
                        title={t("settings.editCamera")}
                      >
                        <IconSettings className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={removeOnboardingCamera}
                        className={cameraStyles.cameraItemBtn + " " + cameraStyles.cameraItemBtnDanger}
                        aria-label={t("settings.removeCamera")}
                        title={t("settings.removeCamera")}
                      >
                        <span aria-hidden>×</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Check-in & check-out camera */}
            <section className={cameraStyles.card + " w-full mt-6"}>
              <div className={cameraStyles.cardHeader}>
                <h2 className={cameraStyles.cardTitle}>
                  <span className={cameraStyles.cardTitleIcon} aria-hidden>
                    <IconCamera className="w-5 h-5" />
                  </span>
                  {t("settings.cameraSectionTitle")}
                </h2>
                <p className={cameraStyles.cardDescription}>
                  {t("settings.cameraSectionDescription")}
                </p>
              </div>
              <div className={cameraStyles.cardBody}>
                {cameras.length === 0 ? (
                  <div className={cameraStyles.emptyState}>
                    <div className={cameraStyles.emptyStateIcon} aria-hidden>
                      <IconCamera className="w-10 h-10" />
                    </div>
                    <p className={cameraStyles.emptyStateTitle}>{t("settings.noCamerasYet")}</p>
                    <p className={cameraStyles.emptyStateHint}>{t("settings.noCamerasHint")}</p>
                    <button
                      type="button"
                      onClick={() => openCameraModal()}
                      className={cameraStyles.addCameraBtn}
                      aria-label={t("settings.addCamera")}
                    >
                      <IconPlus className="w-5 h-5" aria-hidden />
                      {t("settings.addCamera")}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className={cameraStyles.topBarWithAdd}>
                      <p className={cameraStyles.sectionTitle}>{t("settings.configuredCameras")}</p>
                      <button
                        type="button"
                        onClick={() => openCameraModal()}
                        className={cameraStyles.addCameraBtnSmall}
                        aria-label={t("settings.addCamera")}
                      >
                        <IconPlus className="w-4 h-4" aria-hidden />
                        {t("settings.addCamera")}
                      </button>
                    </div>
                    <ul className={cameraStyles.cameraList}>
                      {cameras.map((cam) => (
                        <li key={cam.id} className={cameraStyles.cameraItem}>
                          <div className={cameraStyles.cameraItemInfo}>
                            <p className={cameraStyles.cameraItemName}>{cam.name}</p>
                            <p className={cameraStyles.cameraItemMeta}>
                              <span
                                className={
                                  cam.type === "check_in"
                                    ? cameraStyles.cameraBadge + " " + cameraStyles.cameraBadgeCheckIn
                                    : cameraStyles.cameraBadge + " " + cameraStyles.cameraBadgeCheckOut
                                }
                              >
                                {cam.type === "check_in" ? t("settings.checkIn") : t("settings.checkOut")}
                              </span>
                              <span className="ml-2 text-fms-text-tertiary"> · {cam.rtspIp}</span>
                            </p>
                            {connectionTestResult[cam.id] && (
                              <p style={{ margin: "4px 0 0", fontSize: "0.6875rem", color: connectionTestResult[cam.id].ok ? "#4ade80" : "#f87171" }}>
                                {connectionTestResult[cam.id].message}
                              </p>
                            )}
                          </div>
                          <div className={cameraStyles.cameraItemActions}>
                            <button
                              type="button"
                              onClick={() => testConnection(cam.rtspIp, cam.id)}
                              className={cameraStyles.cameraItemBtn}
                              disabled={testingConnectionId === cam.id}
                              title={t("settings.testConnection")}
                            >
                              {testingConnectionId === cam.id ? "…" : <IconEye className="w-4 h-4" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => testStreamForCamera(cam.name, cam.type === "check_in" ? "Check-In" : "Check-Out", cam.rtspIp)}
                              className={cameraStyles.cameraItemBtn}
                              title={t("settings.testStream")}
                            >
                              <IconCamera className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openCameraModal(cam)}
                              className={cameraStyles.cameraItemBtn}
                              aria-label={t("settings.editCamera")}
                              title={t("settings.editCamera")}
                            >
                              <IconSettings className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeCamera(cam.id)}
                              className={cameraStyles.cameraItemBtn + " " + cameraStyles.cameraItemBtnDanger}
                              aria-label={t("settings.removeCamera")}
                              title={t("settings.removeCamera")}
                            >
                              <span aria-hidden>×</span>
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </section>

            <FaceRecognitionTestCard />

            <StreamTesterCard ref={streamTesterRef} />
          </div>
        )}

        {activeTab === "preferences" && (
          <div
            id="settings-panel-preferences"
            role="tabpanel"
            aria-labelledby="settings-tab-preferences"
            className={pageStyles.tabPanel}
          >
            <section className={pageStyles.prefCard}>
              <div className={pageStyles.prefCardHeader}>
                <h2 className={pageStyles.prefCardTitle}>
                  <span className={pageStyles.prefCardTitleIcon} aria-hidden>
                    <IconPencil className="w-5 h-5" />
                  </span>
                  {t("settings.preferencesAppearance")}
                </h2>
                <p className="text-sm text-fms-text-secondary mt-1.5 m-0">
                  {t("settings.preferencesBrandingDescription")}
                </p>
              </div>
              <div className={pageStyles.prefCardBody}>
                <div className={pageStyles.brandingGrid}>
                  <div className={pageStyles.brandingForm}>
                    <div className={pageStyles.prefField}>
                      <label htmlFor="pref-app-name" className={pageStyles.prefLabel}>
                        {t("settings.preferencesAppName")}
                      </label>
                      <input
                        id="pref-app-name"
                        type="text"
                        className={pageStyles.prefInput}
                        value={applicationName ?? ""}
                        onChange={(e) => setApplicationName(e.target.value || null)}
                        placeholder={getDisplayName(APP_NAME)}
                        aria-describedby="pref-app-name-hint"
                        maxLength={64}
                      />
                      <p id="pref-app-name-hint" className="text-xs text-fms-text-tertiary mt-1.5 m-0">
                        {t("settings.preferencesAppNameHint")}
                      </p>
                      {(applicationName ?? "").trim() && (
                        <div className={pageStyles.brandingActions}>
                          <button
                            type="button"
                            onClick={() => setApplicationName(null)}
                            className="text-xs font-medium text-fms-accent hover:underline focus:outline-none focus:ring-2 focus:ring-fms-accent rounded"
                          >
                            {t("settings.preferencesUseDefaultName")}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className={pageStyles.prefField + " " + pageStyles.logoUploadWrap}>
                      <label className={pageStyles.prefLabel}>{t("settings.preferencesLogo")}</label>
                      <UploadLogo
                        value={logoUrl}
                        onChange={setLogoUrl}
                        label={t("settings.preferencesLogoUpload")}
                      />
                      <p className="text-xs text-fms-text-tertiary mt-1.5 m-0">
                        {t("settings.preferencesLogoHint")}
                      </p>
                      {logoUrl && (
                        <div className={pageStyles.brandingActions}>
                          <button
                            type="button"
                            onClick={() => setLogoUrl(null)}
                            className="text-xs font-medium text-fms-accent hover:underline focus:outline-none focus:ring-2 focus:ring-fms-accent rounded"
                          >
                            {t("settings.preferencesClearLogo")}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className={pageStyles.brandingSaveRow}>
                      <button
                        type="button"
                        onClick={saveBranding}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                        aria-label={t("settings.save")}
                      >
                        {t("settings.save")}
                      </button>
                      {preferencesSavedFeedback && (
                        <p className={pageStyles.brandingSavedBadge} role="status">
                          <span aria-hidden>✓</span> {t("settings.preferencesSaved")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className={pageStyles.brandingPreview}>
                    <p className={pageStyles.brandingPreviewLabel}>{t("settings.preferencesLivePreview")}</p>
                    <div className={pageStyles.brandingPreviewStrip}>
                      {logoUrl && logoUrl.trim() ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={logoUrl}
                          alt=""
                          className={pageStyles.brandingPreviewLogo}
                        />
                      ) : (
                        <div className={pageStyles.brandingPreviewInitial} aria-hidden>
                          {(getDisplayName(APP_NAME).trim() || "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className={pageStyles.brandingPreviewName}>
                        {getDisplayName(APP_NAME) || "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className={pageStyles.prefCard}>
              <div className={pageStyles.prefCardHeader}>
                <h2 className={pageStyles.prefCardTitle}>
                  <span className={pageStyles.prefCardTitleIcon} aria-hidden>
                    <IconClock className="w-5 h-5" />
                  </span>
                  {t("settings.preferencesTheme")}
                </h2>
              </div>
              <div className={pageStyles.prefCardBody}>
                <p className={pageStyles.prefLabel}>{t("settings.preferencesThemeLabel")}</p>
                <div className={pageStyles.optionGroup} role="group" aria-label={t("settings.preferencesThemeLabel")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={theme === "light"}
                    className={pageStyles.optionCard}
                    onClick={() => setTheme("light")}
                  >
                    <div className={pageStyles.optionCardIcon} aria-hidden>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="5" />
                        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                      </svg>
                    </div>
                    <p className={pageStyles.optionCardTitle}>{t("topbar.light")}</p>
                    <p className={pageStyles.optionCardHint}>{t("settings.preferencesThemeLightHint")}</p>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={theme === "dark"}
                    className={pageStyles.optionCard}
                    onClick={() => setTheme("dark")}
                  >
                    <div className={pageStyles.optionCardIcon} aria-hidden>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    </div>
                    <p className={pageStyles.optionCardTitle}>{t("topbar.dark")}</p>
                    <p className={pageStyles.optionCardHint}>{t("settings.preferencesThemeDarkHint")}</p>
                  </button>
                </div>
              </div>
            </section>

            <section className={pageStyles.prefCard}>
              <div className={pageStyles.prefCardHeader}>
                <h2 className={pageStyles.prefCardTitle}>
                  <span className={pageStyles.prefCardTitleIcon} aria-hidden>
                    <IconSettings className="w-5 h-5" />
                  </span>
                  {t("settings.preferencesStyle")}
                </h2>
              </div>
              <div className={pageStyles.prefCardBody}>
                <p className={pageStyles.prefLabel}>{t("settings.preferencesDensityLabel")}</p>
                <div className={pageStyles.optionGroup} role="group" aria-label={t("settings.preferencesDensityLabel")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={displayDensity === "comfortable"}
                    className={pageStyles.optionCard}
                    onClick={() => setDisplayDensity("comfortable")}
                  >
                    <div className={pageStyles.optionCardIcon} aria-hidden>
                      <IconSettings className="w-5 h-5" />
                    </div>
                    <p className={pageStyles.optionCardTitle}>{t("settings.preferencesDensityComfortable")}</p>
                    <p className={pageStyles.optionCardHint}>{t("settings.preferencesDensityComfortableHint")}</p>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={displayDensity === "compact"}
                    className={pageStyles.optionCard}
                    onClick={() => setDisplayDensity("compact")}
                  >
                    <div className={pageStyles.optionCardIcon} aria-hidden>
                      <IconGrid className="w-5 h-5" />
                    </div>
                    <p className={pageStyles.optionCardTitle}>{t("settings.preferencesDensityCompact")}</p>
                    <p className={pageStyles.optionCardHint}>{t("settings.preferencesDensityCompactHint")}</p>
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeTab === "license" && (
          <div
            id="settings-panel-license"
            role="tabpanel"
            aria-labelledby="settings-tab-license"
            className={pageStyles.tabPanel}
          >
            <section className={pageStyles.prefCard}>
              <div className={pageStyles.prefCardHeader + " " + pageStyles.licenseCardHeader}>
                <h2 className={pageStyles.prefCardTitle}>
                  <span className={pageStyles.prefCardTitleIcon} aria-hidden>
                    <IconShield className="w-5 h-5" />
                  </span>
                  {t("settings.licenseTitle")}
                </h2>
                <p className={pageStyles.licenseSubtitle}>{t("settings.licenseSubtitle")}</p>
              </div>
              <div className={pageStyles.prefCardBody}>
                <div className={pageStyles.licenseGrid}>
                  <div className={pageStyles.licenseItem}>
                    <span className={pageStyles.prefLabel}>{t("settings.licenseDaysLeft")}</span>
                    <span className={pageStyles.licenseValue}>
                      {licenseInfo.expirationDate
                        ? (() => {
                            const now = new Date();
                            const exp = licenseInfo.expirationDate!;
                            const daysLeft = Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
                            return daysLeft === 0
                              ? t("settings.licenseExpired")
                              : t("settings.licenseDaysLeftCount", { count: daysLeft });
                          })()
                        : "—"}
                    </span>
                  </div>
                  <div className={pageStyles.licenseItem}>
                    <span className={pageStyles.prefLabel}>{t("settings.licenseExpiration")}</span>
                    <span className={pageStyles.licenseValue}>
                      {licenseInfo.expirationDate
                        ? licenseInfo.expirationDate.toLocaleString(undefined, {
                            dateStyle: "long",
                            timeStyle: "short",
                          })
                        : "—"}
                    </span>
                  </div>
                </div>
                <div className={pageStyles.licenseKeyBlock}>
                  <span className={pageStyles.prefLabel}>{t("settings.licenseKey")}</span>
                  <div className={pageStyles.licenseKeyRow}>
                    <code className={pageStyles.licenseKeyCode}>
                      {licenseKeyVisible
                        ? (licenseInfo.licenseKeyFull || licenseInfo.licenseKeyMasked || "••••-••••-••••-••••")
                        : "••••-••••-••••-••••"}
                    </code>
                    <div className={pageStyles.licenseKeyActions}>
                      <button
                        type="button"
                        onClick={() => setLicenseKeyVisible((v) => !v)}
                        className={pageStyles.licenseIconBtn}
                        aria-label={licenseKeyVisible ? t("settings.licenseHide") : t("settings.licenseShow")}
                        title={licenseKeyVisible ? t("settings.licenseHide") : t("settings.licenseShow")}
                      >
                        {licenseKeyVisible ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <IconEye className="w-4 h-4" aria-hidden />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={copyLicenseKey}
                        className={pageStyles.licenseCopyBtn}
                        aria-label={t("settings.licenseCopy")}
                        title={t("settings.licenseCopy")}
                      >
                        {licenseCopied ? (
                          <span className={pageStyles.licenseCopyText}>{t("settings.licenseCopied")}</span>
                        ) : (
                          <>
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                            <span className="hidden sm:inline">{t("settings.licenseCopy")}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Update check modal */}
        {updateModalOpen && (
          <div
            className={styles.overlay}
            data-closing={updateModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-modal-title"
            aria-busy={updateState === "checking"}
            onClick={(e) => e.target === e.currentTarget && updateState !== "checking" && closeUpdateModal()}
          >
            <div
              className={styles.modal}
              data-closing={updateModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeUpdateModal}
                  disabled={updateState === "checking"}
                  aria-label={t("settings.close")}
                >
                  ×
                </button>

                {updateState === "checking" && (
                  <>
                    <h2 id="update-modal-title" className={styles.title}>
                      {t("settings.updateModalTitle")}
                    </h2>
                    <div className={styles.checkingWrap}>
                      <div className={styles.spinner} aria-hidden />
                      <p className={styles.checkingText}>
                        {t("settings.checkingForUpdates")}
                      </p>
                    </div>
                  </>
                )}

                {updateState === "update_available" && latestVersion && (
                  <>
                    <h2 id="update-modal-title" className={styles.title}>
                      {t("settings.updateAvailable")}
                    </h2>
                    <div className={`${styles.resultIconWrap} ${styles.resultIconNew}`} aria-hidden>
                      <IconSettings className="w-6 h-6" />
                    </div>
                    <p className={styles.message}>{t("settings.updateAvailableMessage", { version: latestVersion })}</p>
                    <p className={styles.message}>{t("settings.agreeToUpdate")}</p>
                    <div className={styles.versionBadge}>{latestVersion}</div>
                    <div className={styles.actions}>
                      <button type="button" className={styles.btnSecondary} onClick={closeUpdateModal}>
                        {t("settings.cancel")}
                      </button>
                      <button type="button" className={styles.btnPrimary} onClick={handleAgreeToUpdate}>
                        {t("settings.updateNow")}
                      </button>
                    </div>
                  </>
                )}

                {updateState === "up_to_date" && (
                  <>
                    <h2 id="update-modal-title" className={styles.title}>
                      {t("settings.upToDate")}
                    </h2>
                    <div className={`${styles.resultIconWrap} ${styles.resultIconOk}`} aria-hidden>
                      <span aria-hidden>✓</span>
                    </div>
                    <p className={styles.message}>{t("settings.upToDateMessage")}</p>
                    <div className={styles.actions}>
                      <button type="button" className={styles.btnPrimary} onClick={closeUpdateModal}>
                        {t("settings.close")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Enable automatic update confirmation modal */}
        {autoUpdateModalOpen && (
          <div
            className={styles.overlay}
            data-closing={autoUpdateModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-update-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeAutoUpdateModal()}
          >
            <div
              className={styles.modal}
              data-closing={autoUpdateModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeAutoUpdateModal}
                  aria-label={t("settings.close")}
                >
                  ×
                </button>
                <h2 id="auto-update-modal-title" className={styles.title}>
                  {t("settings.autoUpdateModalTitle")}
                </h2>
                <p className={styles.message}>{t("settings.autoUpdateModalMessage")}</p>
                <div className={styles.actions}>
                  <button type="button" className={styles.btnSecondary} onClick={closeAutoUpdateModal}>
                    {t("settings.cancel")}
                  </button>
                  <button type="button" className={styles.btnPrimary} onClick={enableAutomaticUpdate}>
                    {t("settings.enable")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Confirm save check-in & check-out times */}
        {timeConfirmModalOpen && (
          <div
            className={styles.overlay}
            data-closing={timeConfirmModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="time-confirm-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeTimeConfirmModal()}
          >
            <div
              className={styles.modal}
              data-closing={timeConfirmModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeTimeConfirmModal}
                  aria-label={t("settings.close")}
                >
                  ×
                </button>
                <h2 id="time-confirm-modal-title" className={styles.title}>
                  {t("settings.confirmSaveTimesTitle")}
                </h2>
                <p className={styles.message}>
                  {t("settings.confirmSaveTimesMessage", {
                    checkInStart: checkInStartTime,
                    checkInEnd: checkInEndTime,
                    checkOutStart: checkOutStartTime,
                    checkOutEnd: checkOutEndTime,
                  })}
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={closeTimeConfirmModal}
                    disabled={timeConfigSaving}
                  >
                    {t("settings.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={confirmSaveTimeConfig}
                    disabled={timeConfigSaving}
                  >
                    {timeConfigSaving ? t("settings.saving") : t("settings.save")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Add/Edit camera modal */}
        {cameraModalOpen && (
          <div
            className={cameraStyles.modalOverlay + (cameraModalClosing ? " " + cameraStyles.modalOverlayClosing : "")}
            onClick={closeCameraModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="camera-modal-title"
          >
            <div
              className={
                cameraStyles.modal +
                (cameraModalClosing ? " " + cameraStyles.modalClosing : "")
              }
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="camera-modal-title" className={cameraStyles.modalTitle}>
                {editingCameraId ? t("settings.editCamera") : t("settings.addCamera")}
              </h2>
              <div className={cameraStyles.formField}>
                <label htmlFor="camera-name" className={cameraStyles.formLabel}>
                  {t("settings.cameraName")}
                </label>
                <input
                  id="camera-name"
                  type="text"
                  value={cameraForm.name}
                  onChange={(e) => setCameraForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t("settings.cameraNamePlaceholder")}
                  className={cameraStyles.formInput}
                  autoFocus
                />
              </div>
              <div className={cameraStyles.formField}>
                <label htmlFor="camera-type" className={cameraStyles.formLabel}>
                  {t("settings.cameraType")}
                </label>
                <Select
                  id="camera-type"
                  value={cameraForm.type}
                  onChange={(e) => setCameraForm((f) => ({ ...f, type: e.target.value as CameraType }))}
                  className="w-full"
                >
                  <option value="check_in">{t("settings.checkIn")}</option>
                  <option value="check_out">{t("settings.checkOut")}</option>
                </Select>
              </div>
              <div className={cameraStyles.formField}>
                <label htmlFor="camera-rtsp-ip" className={cameraStyles.formLabel}>
                  {t("settings.cameraIpRtsp")}
                </label>
                <input
                  id="camera-rtsp-ip"
                  type="text"
                  value={cameraForm.rtspIp}
                  onChange={(e) => setCameraForm((f) => ({ ...f, rtspIp: e.target.value }))}
                  placeholder={t("settings.cameraIpRtspPlaceholder")}
                  className={cameraStyles.formInput}
                />
                <p className={cameraStyles.formHint}>{t("settings.cameraIpRtspHint")}</p>
                {cameraForm.rtspIp.trim() && (
                  <button
                    type="button"
                    onClick={() => testConnection(cameraForm.rtspIp.trim(), "camera-form")}
                    disabled={testingConnectionId === "camera-form"}
                    style={{ marginTop: 6, fontSize: "0.75rem", fontWeight: 600, padding: "4px 12px", borderRadius: 8, border: "1px solid var(--fms-border)", background: "transparent", color: "var(--fms-text-secondary)", cursor: "pointer" }}
                  >
                    {testingConnectionId === "camera-form" ? "Testing..." : "Test Connection"}
                  </button>
                )}
                {connectionTestResult["camera-form"] && (
                  <p style={{ margin: "4px 0 0", fontSize: "0.6875rem", color: connectionTestResult["camera-form"].ok ? "#4ade80" : "#f87171" }}>
                    {connectionTestResult["camera-form"].message}
                  </p>
                )}
              </div>
              <div className={cameraStyles.modalActions}>
                <button
                  type="button"
                  onClick={closeCameraModal}
                  className={cameraStyles.btnSecondary}
                  disabled={cameraSettingsSaving}
                >
                  {t("settings.cancel")}
                </button>
                <button
                  type="button"
                  onClick={saveCamera}
                  className={cameraStyles.btnPrimary}
                  disabled={!cameraForm.name.trim() || !cameraForm.rtspIp.trim() || cameraSettingsSaving}
                >
                  {cameraSettingsSaving ? t("settings.saving") : editingCameraId ? t("settings.save") : t("settings.addCamera")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add/Edit employee onboarding camera modal */}
        {onboardingCameraModalOpen && (
          <div
            className={cameraStyles.modalOverlay + (onboardingCameraModalClosing ? " " + cameraStyles.modalOverlayClosing : "")}
            onClick={closeOnboardingCameraModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-camera-modal-title"
          >
            <div
              className={
                cameraStyles.modal +
                (onboardingCameraModalClosing ? " " + cameraStyles.modalClosing : "")
              }
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="onboarding-camera-modal-title" className={cameraStyles.modalTitle}>
                {onboardingCamera ? t("settings.editOnboardingCamera") : t("settings.addOnboardingCamera")}
              </h2>
              <div className={cameraStyles.formField}>
                <label htmlFor="onboarding-camera-name" className={cameraStyles.formLabel}>
                  {t("settings.cameraName")}
                </label>
                <input
                  id="onboarding-camera-name"
                  type="text"
                  value={onboardingCameraForm.name}
                  onChange={(e) => setOnboardingCameraForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t("settings.cameraNamePlaceholder")}
                  className={cameraStyles.formInput}
                  autoFocus
                />
              </div>
              <div className={cameraStyles.formField}>
                <label htmlFor="onboarding-camera-rtsp-ip" className={cameraStyles.formLabel}>
                  {t("settings.cameraIpRtsp")}
                </label>
                <input
                  id="onboarding-camera-rtsp-ip"
                  type="text"
                  value={onboardingCameraForm.rtspIp}
                  onChange={(e) => setOnboardingCameraForm((f) => ({ ...f, rtspIp: e.target.value }))}
                  placeholder={t("settings.cameraIpRtspPlaceholder")}
                  className={cameraStyles.formInput}
                />
                <p className={cameraStyles.formHint}>{t("settings.onboardingCameraRtspHint")}</p>
                {onboardingCameraForm.rtspIp.trim() && (
                  <button
                    type="button"
                    onClick={() => testConnection(onboardingCameraForm.rtspIp.trim(), "onboarding-form")}
                    disabled={testingConnectionId === "onboarding-form"}
                    style={{ marginTop: 6, fontSize: "0.75rem", fontWeight: 600, padding: "4px 12px", borderRadius: 8, border: "1px solid var(--fms-border)", background: "transparent", color: "var(--fms-text-secondary)", cursor: "pointer" }}
                  >
                    {testingConnectionId === "onboarding-form" ? "Testing..." : "Test Connection"}
                  </button>
                )}
                {connectionTestResult["onboarding-form"] && (
                  <p style={{ margin: "4px 0 0", fontSize: "0.6875rem", color: connectionTestResult["onboarding-form"].ok ? "#4ade80" : "#f87171" }}>
                    {connectionTestResult["onboarding-form"].message}
                  </p>
                )}
              </div>
              <div className={cameraStyles.modalActions}>
                <button
                  type="button"
                  onClick={closeOnboardingCameraModal}
                  className={cameraStyles.btnSecondary}
                  disabled={cameraSettingsSaving}
                >
                  {t("settings.cancel")}
                </button>
                <button
                  type="button"
                  onClick={saveOnboardingCamera}
                  className={cameraStyles.btnPrimary}
                  disabled={!onboardingCameraForm.name.trim() || !onboardingCameraForm.rtspIp.trim() || cameraSettingsSaving}
                >
                  {cameraSettingsSaving ? t("settings.saving") : onboardingCamera ? t("settings.save") : t("settings.addOnboardingCamera")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
