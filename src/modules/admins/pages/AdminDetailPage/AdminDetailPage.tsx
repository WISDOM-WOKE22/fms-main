"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { Select } from "@/core/ui";
import { IconChevronLeft, IconShield } from "@/core/layout/icons";
import { toast } from "@/core/lib/toast";
import { ADMIN_PERMISSION_KEYS } from "@/modules/admins/data/mockAdmins";
import type { AdminDetail as AdminDetailType, AdminPermissionKey, AdminRole, AdminStatus } from "@/modules/admins/types";
import styles from "./AdminDetailPage.module.css";

type TabId = "profile" | "permissions";

const PERMISSION_LABEL_KEYS: Record<AdminPermissionKey, string> = {
  dashboard: "nav.dashboard",
  employees: "nav.employees",
  accessLogs: "nav.accessLogs",
  auditLogs: "nav.auditLogs",
  zones: "nav.zones",
  shifts: "nav.shifts",
  admins: "nav.admins",
  reports: "nav.reports",
  settings: "nav.settings",
};

interface ProfileFormState {
  name: string;
  email: string;
  role: AdminRole;
  status: AdminStatus;
  permissions: AdminPermissionKey[];
}

function adminToForm(admin: AdminDetailType): ProfileFormState {
  return {
    name: admin.name,
    email: admin.email,
    role: admin.role,
    status: admin.status,
    permissions: [...admin.permissions],
  };
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatShortDate(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export interface AdminDetailPageProps {
  /** When rendered by Tauri hash router, id is passed as prop instead of route params. */
  tauriId?: string;
}

export default function AdminDetailPage({ tauriId }: AdminDetailPageProps = {}) {
  const { t } = useTranslation();
  const params = useParams();
  const id = (typeof params?.id === "string" ? params.id : null) ?? tauriId ?? "";
  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    profile: null,
    permissions: null,
  });
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const [admin, setAdmin] = useState<AdminDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    apiFetch(`/api/v1/admins/${id}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: AdminDetailType | null) => {
        if (mounted) setAdmin(data ?? null);
      })
      .catch(() => {
        if (mounted) setAdmin(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [id]);

  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [statusModalClosing, setStatusModalClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<ProfileFormState>({
    name: "",
    email: "",
    role: "sub_admin",
    status: "active",
    permissions: [],
  });

  useEffect(() => {
    if (admin) setForm(adminToForm(admin));
  }, [admin]);

  const updateForm = (key: keyof ProfileFormState, value: string | AdminPermissionKey[]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "role" && value === "super_admin") {
        next.permissions = [...ADMIN_PERMISSION_KEYS];
      }
      if (key === "role" && value === "sub_admin") {
        if (!next.permissions.includes("dashboard")) {
          next.permissions = ["dashboard", ...next.permissions.filter((p) => p !== "dashboard")];
        }
      }
      return next;
    });
  };

  const togglePermission = (key: AdminPermissionKey) => {
    if (form.role === "super_admin") return;
    setForm((prev) => {
      const next = prev.permissions.includes(key)
        ? prev.permissions.filter((p) => p !== key)
        : [...prev.permissions, key];
      return { ...prev, permissions: next };
    });
  };

  const startEditing = () => {
    if (admin) setForm(adminToForm(admin));
    setIsEditing(true);
  };

  const cancelEditing = () => {
    if (admin) setForm(adminToForm(admin));
    setIsEditing(false);
  };

  const saveProfile = async () => {
    if (!admin || !id) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/v1/admins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          status: form.status,
          permissions: form.permissions,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(data.error ?? data.message ?? t("toast.adminUpdateError"));
      }
      const updated = (await res.json()) as AdminDetailType;
      setAdmin(updated);
      setForm(adminToForm(updated));
      setIsEditing(false);
      toast.success(t("toast.adminUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.adminUpdateError"));
    } finally {
      setSaving(false);
    }
  };

  const openStatusModal = () => setStatusModalOpen(true);

  const closeStatusModal = () => {
    if (statusModalClosing) return;
    setStatusModalClosing(true);
    setTimeout(() => {
      setStatusModalOpen(false);
      setStatusModalClosing(false);
    }, 220);
  };

  const handleDeactivateActivateConfirm = async () => {
    if (!admin || !id) return;
    const isCurrentlyActive = admin.status === "active";
    const newStatus: AdminStatus = isCurrentlyActive ? "inactive" : "active";
    setSaving(true);
    try {
      const res = await apiFetch(`/api/v1/admins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(data.error ?? data.message ?? t("toast.adminStatusError"));
      }
      const updated = (await res.json()) as AdminDetailType;
      setAdmin(updated);
      setForm(adminToForm(updated));
      closeStatusModal();
      toast.success(
        newStatus === "active" ? t("toast.adminActivated") : t("toast.adminDeactivated")
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.adminStatusError"));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const el = tabRefs.current[activeTab];
    if (el?.parentElement) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle({
        left: rect.left - parent.left,
        width: rect.width,
      });
    }
  }, [activeTab]);

  useEffect(() => {
    const el = tabRefs.current.profile;
    if (el?.parentElement && indicatorStyle.width === 0) {
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicatorStyle({ left: rect.left - parent.left, width: rect.width });
    }
  }, [admin?.id, indicatorStyle.width]);

  if (loading) {
    return (
      <DashboardLayout title={t("nav.admins")}>
        <div className={styles.page}>
          <div className={styles.notFoundCard}>
            <p className={styles.notFoundText}>{t("admins.loading")}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }
  if (!admin) {
    return (
      <DashboardLayout title={t("nav.admins")}>
        <div className={styles.page}>
          <Link
            href="/admins"
            className={styles.backLink}
            aria-label={t("admins.backToAdmins")}
          >
            <IconChevronLeft className={styles.backLinkIcon} />
            {t("admins.backToAdmins")}
          </Link>
          <div className={styles.notFoundCard}>
            <div className={styles.notFoundIcon} aria-hidden>
              <IconShield className="w-8 h-8" />
            </div>
            <p className={styles.notFoundText}>{t("admins.adminNotFound")}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const isSuperAdmin = form.role === "super_admin";

  const isInactive = admin.status === "inactive";

  return (
    <DashboardLayout title={admin.name}>
      <div className={styles.page}>
        <div className={styles.topBar}>
          <Link
            href="/admins"
            className={styles.backLink}
            aria-label={t("admins.backToAdmins")}
          >
            <IconChevronLeft className={styles.backLinkIcon} />
            {t("admins.backToAdmins")}
          </Link>
          <button
            type="button"
            className={isInactive ? styles.activateButton : styles.deactivateButton}
            onClick={openStatusModal}
            disabled={saving}
            aria-label={isInactive ? t("admins.activateAccount") : t("admins.deactivateAccount")}
          >
            {saving ? (
              <span className={styles.buttonSpinner} aria-hidden />
            ) : null}
            {isInactive ? t("admins.activateAccount") : t("admins.deactivateAccount")}
          </button>
        </div>

        <div className={styles.card}>
          <div className={styles.profileHeader}>
            <div className={styles.avatar} aria-hidden>
              {getInitials(admin.name)}
            </div>
            <div className={styles.profileHeaderText}>
              <h1 className={styles.profileHeaderName}>{admin.name}</h1>
              <div className={styles.profileHeaderMeta}>
                <span
                  className={
                    admin.role === "super_admin"
                      ? `${styles.badgePill} ${styles.badgePillRole}`
                      : `${styles.badgePill} ${styles.badgePillSub}`
                  }
                >
                  {admin.role === "super_admin"
                    ? t("admins.superAdmin")
                    : t("admins.subAdmin")}
                </span>
                <span
                  className={
                    admin.status === "active"
                      ? `${styles.badgePill} ${styles.badgePillActive}`
                      : `${styles.badgePill} ${styles.badgePillInactive}`
                  }
                >
                  {admin.status === "active"
                    ? t("admins.active")
                    : t("admins.inactive")}
                </span>
                <span>{formatShortDate(admin.createdAt)}</span>
              </div>
            </div>
          </div>

          <div className={styles.tabList} role="tablist">
            <span
              className={styles.tabIndicator}
              style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
              aria-hidden
            />
            <button
              ref={(el) => { tabRefs.current.profile = el; }}
              role="tab"
              aria-selected={activeTab === "profile"}
              aria-controls="panel-profile"
              id="tab-profile"
              data-active={activeTab === "profile"}
              className={styles.tab}
              onClick={() => setActiveTab("profile")}
            >
              {t("admins.tabProfile")}
            </button>
            <button
              ref={(el) => { tabRefs.current.permissions = el; }}
              role="tab"
              aria-selected={activeTab === "permissions"}
              aria-controls="panel-permissions"
              id="tab-permissions"
              data-active={activeTab === "permissions"}
              className={styles.tab}
              onClick={() => setActiveTab("permissions")}
            >
              {t("admins.tabPermissions")}
            </button>
          </div>

          <div className={styles.panelWrap}>
            {activeTab === "profile" && (
              <div
                id="panel-profile"
                role="tabpanel"
                aria-labelledby="tab-profile"
                className={styles.panel}
              >
                <section className={styles.profileFormSection}>
                  <h2 className={styles.profileFormSectionTitle}>
                    {t("admins.profileInfo")}
                  </h2>
                  <div className={styles.profileFormGrid}>
                    <div className={`${styles.profileFormField} ${styles.profileFormFieldFull}`}>
                      <label className={styles.profileFormLabel}>{t("admins.adminName")}</label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => updateForm("name", e.target.value)}
                        readOnly={!isEditing}
                        className={`${styles.profileInput} ${!isEditing ? styles.profileInputReadOnly : ""}`}
                        aria-readonly={!isEditing}
                      />
                    </div>
                    <div className={`${styles.profileFormField} ${styles.profileFormFieldFull}`}>
                      <label className={styles.profileFormLabel}>{t("admins.email")}</label>
                      <input
                        type="email"
                        value={form.email}
                        onChange={(e) => updateForm("email", e.target.value)}
                        readOnly={!isEditing}
                        className={`${styles.profileInput} ${!isEditing ? styles.profileInputReadOnly : ""}`}
                        aria-readonly={!isEditing}
                      />
                    </div>
                    <div className={styles.profileFormField}>
                      <label className={styles.profileFormLabel}>{t("admins.role")}</label>
                      <Select
                        value={form.role}
                        onChange={(e) => updateForm("role", e.target.value as AdminRole)}
                        disabled={!isEditing}
                        className="w-full"
                        aria-readonly={!isEditing}
                      >
                        <option value="super_admin">{t("admins.superAdmin")}</option>
                        <option value="sub_admin">{t("admins.subAdmin")}</option>
                      </Select>
                    </div>
                    <div className={styles.profileFormField}>
                      <label className={styles.profileFormLabel}>{t("admins.status")}</label>
                      <Select
                        value={form.status}
                        onChange={(e) => updateForm("status", e.target.value as AdminStatus)}
                        disabled={!isEditing}
                        className="w-full"
                        aria-readonly={!isEditing}
                      >
                        <option value="active">{t("admins.active")}</option>
                        <option value="inactive">{t("admins.inactive")}</option>
                      </Select>
                    </div>
                    <div className={styles.profileFormField}>
                      <span className={styles.profileFormLabel}>{t("admins.createdDate")}</span>
                      <span className={styles.lastLogin}>{formatShortDate(admin.createdAt)}</span>
                    </div>
                    {admin.lastLoginAt && (
                      <div className={styles.profileFormField}>
                        <span className={styles.profileFormLabel}>{t("admins.lastLogin")}</span>
                        <span className={styles.lastLogin}>{formatDate(admin.lastLoginAt)}</span>
                      </div>
                    )}
                  </div>
                </section>
                <div className={styles.profileEditActions}>
                  {!isEditing ? (
                    <button type="button" className={styles.profileEditBtn} onClick={startEditing}>
                      {t("admins.editProfile")}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.profileSaveBtn}
                        onClick={saveProfile}
                        disabled={saving}
                      >
                        {saving ? t("admins.saving") : t("admins.saveChanges")}
                      </button>
                      <button
                        type="button"
                        className={styles.profileCancelBtn}
                        onClick={cancelEditing}
                        disabled={saving}
                      >
                        {t("admins.cancelEdit")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {activeTab === "permissions" && (
              <div
                id="panel-permissions"
                role="tabpanel"
                aria-labelledby="tab-permissions"
                className={styles.panel}
              >
                <section className={styles.profileFormSection}>
                  <h2 className={styles.profileFormSectionTitle}>
                    {t("admins.moduleAccess")}
                  </h2>
                  {isSuperAdmin ? (
                    <p className={styles.fullAccessNote}>{t("admins.fullAccessNote")}</p>
                  ) : (
                    <div>
                      {ADMIN_PERMISSION_KEYS.map((key) => {
                        const checked = form.permissions.includes(key);
                        const labelKey = PERMISSION_LABEL_KEYS[key];
                        return (
                          <div key={key} className="fms-toggle-row">
                            <div>
                              <span className={styles.permissionLabel}>{t(labelKey)}</span>
                              <p className={styles.permissionHint}>
                                {t("admins.accessModuleHint", { module: t(labelKey) })}
                              </p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={checked}
                              aria-label={t("admins.toggleAccess", { module: t(labelKey) })}
                              data-checked={checked}
                              className="fms-switch"
                              onClick={() => togglePermission(key)}
                            >
                              <span className="fms-switch-thumb" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
                {!isSuperAdmin && (
                  <div className={styles.profileEditActions}>
                    <button
                      type="button"
                      className={styles.profileSaveBtn}
                      onClick={saveProfile}
                      disabled={saving}
                    >
                      {saving ? t("admins.saving") : t("admins.savePermissions")}
                    </button>
                    <button
                      type="button"
                      className={styles.profileCancelBtn}
                      onClick={cancelEditing}
                      disabled={saving}
                    >
                      {t("admins.cancelEdit")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Deactivate / Activate confirmation dialog */}
        {statusModalOpen && admin && (
          <div
            className={styles.statusModalOverlay + (statusModalClosing ? " " + styles.statusModalOverlayClosing : "")}
            onClick={(e) => e.target === e.currentTarget && closeStatusModal()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeStatusModal();
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-status-modal-title"
            aria-describedby="admin-status-modal-desc"
          >
            <div
              className={styles.statusModal + (statusModalClosing ? " " + styles.statusModalClosing : "")}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="admin-status-modal-title" className={styles.statusModalTitle}>
                {admin.status === "active"
                  ? t("admins.confirmDeactivateTitle")
                  : t("admins.confirmActivateTitle")}
              </h2>
              <p id="admin-status-modal-desc" className={styles.statusModalMessage}>
                {admin.status === "active"
                  ? t("admins.confirmDeactivateMessage")
                  : t("admins.confirmActivateMessage")}
              </p>
              <div className={styles.statusModalActions}>
                <button
                  type="button"
                  onClick={closeStatusModal}
                  disabled={saving}
                  className={styles.statusModalCancelBtn}
                >
                  {t("employees.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleDeactivateActivateConfirm}
                  disabled={saving}
                  className={
                    admin.status === "active"
                      ? styles.statusModalConfirmDeactivate
                      : styles.statusModalConfirmActivate
                  }
                >
                  {saving ? (
                    <span className={styles.buttonSpinner} aria-hidden />
                  ) : null}
                  {admin.status === "active"
                    ? t("admins.deactivateAccount")
                    : t("admins.activateAccount")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
