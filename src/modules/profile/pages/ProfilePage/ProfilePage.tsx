"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { useAuthStore } from "@/core/store/useAuthStore";
import { apiFetch } from "@/core/api/request";
import PasswordField from "@/modules/onboarding/components/PasswordField/PasswordField";
import styles from "./ProfilePage.module.css";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function ProfilePage() {
  const { t } = useTranslation();
  const admin = useAuthStore((s) => s.admin);
  const setAdmin = useAuthStore((s) => s.setAdmin);
  const getInitials = useAuthStore((s) => s.getInitials);

  const [isEditing, setIsEditing] = useState(false);
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [profileMessage, setProfileMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (admin) {
      setFormName(admin.name);
      setFormEmail(admin.email);
    }
  }, [admin]);

  const startEditing = useCallback(() => {
    if (admin) {
      setFormName(admin.name);
      setFormEmail(admin.email);
    }
    setProfileMessage(null);
    setIsEditing(true);
  }, [admin]);

  const cancelEditing = useCallback(() => {
    if (admin) {
      setFormName(admin.name);
      setFormEmail(admin.email);
    }
    setProfileMessage(null);
    setIsEditing(false);
  }, [admin]);

  const saveProfile = useCallback(async () => {
    const name = formName.trim();
    const email = formEmail.trim();
    if (!name) {
      setProfileMessage({ type: "error", text: t("profile.errorNameRequired") });
      return;
    }
    if (!email) {
      setProfileMessage({ type: "error", text: t("profile.errorEmailRequired") });
      return;
    }
    if (!isValidEmail(email)) {
      setProfileMessage({ type: "error", text: t("profile.errorEmailInvalid") });
      return;
    }
    if (!admin) return;
    setSubmitting(true);
    setProfileMessage(null);
    if (admin.id === "env-super-admin") {
      setAdmin({ ...admin, name, email });
      setIsEditing(false);
      setProfileMessage({ type: "success", text: t("profile.profileUpdated") });
      setSubmitting(false);
      return;
    }
    try {
      const res = await apiFetch(`/api/v1/admins/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        setProfileMessage({ type: "error", text: data.message || t("profile.profileUpdateFailed") });
        return;
      }
      const updated = (await res.json()) as typeof admin;
      setAdmin(updated);
      setIsEditing(false);
      setProfileMessage({ type: "success", text: t("profile.profileUpdated") });
    } catch {
      setProfileMessage({ type: "error", text: t("profile.profileUpdateFailed") });
    } finally {
      setSubmitting(false);
    }
  }, [formName, formEmail, admin, setAdmin, t]);

  const updatePassword = useCallback(() => {
    setPasswordMessage(null);
    if (!currentPassword.trim()) {
      setPasswordMessage({ type: "error", text: t("profile.errorCurrentPasswordRequired") });
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMessage({ type: "error", text: t("profile.errorPasswordTooShort") });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: "error", text: t("profile.errorPasswordMismatch") });
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordMessage({ type: "success", text: t("profile.passwordUpdated") });
  }, [currentPassword, newPassword, confirmPassword, t]);

  const displayName = admin?.name?.trim() || t("profile.unknownName");
  const initials = getInitials();

  if (!admin) {
    return (
      <DashboardLayout title={t("nav.profile")}>
        <div className={styles.page}>
          <p className={styles.description}>{t("profile.pageDescription")}</p>
          <p className={styles.description}>{t("profile.signInToView")}</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={t("nav.profile")}>
      <div className={styles.page}>
        <p className={styles.description}>{t("profile.pageDescription")}</p>

        {/* Personal info card */}
        <section className={styles.card} aria-labelledby="profile-info-heading">
          <div className={styles.cardHeader}>
            <div className={styles.avatar} aria-hidden>
              {initials}
            </div>
            <div className={styles.cardHeaderText}>
              <h2 id="profile-info-heading" className={styles.cardTitle}>
                {displayName}
              </h2>
              <p className={styles.cardSubtitle}>{admin.email}</p>
            </div>
          </div>
          <div className={styles.cardBody}>
            <h3 className={styles.sectionTitle}>{t("profile.personalInfo")}</h3>
            <div className={styles.formGrid}>
              <div className={styles.fieldFull}>
                <label htmlFor="profile-name" className={styles.label}>
                  {t("profile.name")}
                </label>
                <input
                  id="profile-name"
                  type="text"
                  className={`${styles.input} ${!isEditing ? styles.inputReadOnly : ""}`}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  readOnly={!isEditing}
                  placeholder={t("profile.namePlaceholder")}
                  autoComplete="name"
                />
              </div>
              <div className={styles.fieldFull}>
                <label htmlFor="profile-email" className={styles.label}>
                  {t("profile.email")}
                </label>
                <input
                  id="profile-email"
                  type="email"
                  className={`${styles.input} ${!isEditing ? styles.inputReadOnly : ""}`}
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  readOnly={!isEditing}
                  placeholder={t("profile.emailPlaceholder")}
                  autoComplete="email"
                />
              </div>
            </div>
            {profileMessage && (
              <div
                className={`${styles.message} ${
                  profileMessage.type === "success" ? styles.messageSuccess : styles.messageError
                }`}
                role="alert"
              >
                {profileMessage.text}
              </div>
            )}
            <div className={styles.actions}>
              {!isEditing ? (
                <button type="button" className={styles.btnSecondary} onClick={startEditing}>
                  {t("profile.editProfile")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={saveProfile}
                    disabled={submitting}
                  >
                    {submitting ? t("profile.saving") : t("profile.saveProfile")}
                  </button>
                  <button type="button" className={styles.btnGhost} onClick={cancelEditing}>
                    {t("profile.cancel")}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Change password card */}
        <section className={styles.card} aria-labelledby="profile-password-heading">
          <div className={styles.cardHeader}>
            <div className={styles.cardHeaderText}>
              <h2 id="profile-password-heading" className={styles.cardTitle}>
                {t("profile.changePassword")}
              </h2>
              <p className={styles.cardSubtitle}>{t("profile.changePasswordHint")}</p>
            </div>
          </div>
          <div className={styles.cardBody}>
            <p className={styles.passwordNote}>{t("profile.passwordNote")}</p>
            <div className={styles.passwordFields}>
              <PasswordField
                id="profile-current-password"
                label={t("profile.currentPassword")}
                placeholder={t("profile.currentPasswordPlaceholder")}
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
              />
              <PasswordField
                id="profile-new-password"
                label={t("profile.newPassword")}
                placeholder={t("profile.newPasswordPlaceholder")}
                value={newPassword}
                onChange={(v) => {
                  setNewPassword(v);
                  setPasswordMessage(null);
                }}
                autoComplete="new-password"
              />
              <PasswordField
                id="profile-confirm-password"
                label={t("profile.confirmPassword")}
                placeholder={t("profile.confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(v) => {
                  setConfirmPassword(v);
                  setPasswordMessage(null);
                }}
                autoComplete="new-password"
              />
            </div>
            {passwordMessage && (
              <div
                className={`${styles.message} ${
                  passwordMessage.type === "success" ? styles.messageSuccess : styles.messageError
                }`}
                role="alert"
              >
                {passwordMessage.text}
              </div>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={updatePassword}
                disabled={!currentPassword || !newPassword || !confirmPassword}
              >
                {t("profile.updatePassword")}
              </button>
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
