"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useTauriPush } from "@/core/tauri/useTauriPush";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft } from "@/core/layout/icons";
import { toast } from "@/core/lib/toast";
import { ADMIN_PERMISSION_KEYS } from "@/modules/admins/data/mockAdmins";
import type { AdminPermissionKey, AdminRole, AdminStatus } from "@/modules/admins/types";

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

interface FormState {
  name: string;
  email: string;
  password: string;
  role: AdminRole;
  status: AdminStatus;
  permissions: AdminPermissionKey[];
}

const initialForm: FormState = {
  name: "",
  email: "",
  password: "",
  role: "sub_admin",
  status: "active",
  permissions: ["dashboard"],
};

const inputBase =
  "w-full px-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent";
const inputError = "border-red-500";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function AddAdminPage() {
  const { t } = useTranslation();
  const push = useTauriPush();
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof FormState, value: string | AdminPermissionKey[]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof FormState]) setErrors((prev) => ({ ...prev, [key as keyof FormState]: undefined }));
  };

  const togglePermission = (key: AdminPermissionKey) => {
    setForm((prev) => {
      const next = prev.permissions.includes(key)
        ? prev.permissions.filter((p) => p !== key)
        : [...prev.permissions, key];
      return { ...prev, permissions: next };
    });
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) next.name = t("admins.validationName");
    if (!form.email.trim()) next.email = t("admins.validationEmail");
    else if (!isValidEmail(form.email)) next.email = t("admins.validationEmailInvalid");
    if (!form.password.trim()) next.password = t("admins.validationPassword");
    else if (form.password.length < 6) next.password = t("admins.validationPasswordMin");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/v1/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: "sub_admin",
          status: "active",
          permissions: form.permissions,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string; message?: string };
        throw new Error(data.error ?? data.message ?? t("toast.adminCreateError"));
      }
      toast.success(t("toast.adminCreated"));
      push("/admins");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.adminCreateError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout title={t("admins.addAdmin")}>
      <div className="w-full max-w-none">
        <Link
          href="/admins"
          className="inline-flex items-center gap-2 text-sm font-medium text-fms-text-secondary hover:text-fms-text mb-6 transition-colors"
          aria-label={t("admins.backToAdmins")}
        >
          <IconChevronLeft className="w-4 h-4" />
          {t("admins.backToAdmins")}
        </Link>

        <p className="text-sm text-fms-text-secondary m-0 mb-6">
          {t("admins.newAdminSubtitle")}
        </p>

        <form
          onSubmit={handleSubmit}
          className="w-full rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm"
        >
          <div className="p-6 sm:p-8 space-y-8">
            <section className="space-y-4">
              <h2 className="text-base font-semibold text-fms-text m-0">
                {t("admins.profileInfo")}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="admin-name" className="block text-sm font-medium text-fms-text mb-1.5">
                    {t("admins.adminName")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
                  </label>
                  <input
                    id="admin-name"
                    type="text"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="e.g. Jordan Lee"
                    className={`${inputBase} ${errors.name ? inputError : ""}`}
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? "admin-name-error" : undefined}
                  />
                  {errors.name && (
                    <p id="admin-name-error" className="mt-1.5 text-sm text-red-500">
                      {errors.name}
                    </p>
                  )}
                </div>
                <div className="sm:col-span-2 sm:grid sm:grid-cols-2 sm:gap-4">
                  <div>
                    <label htmlFor="admin-email" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("admins.email")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
                    </label>
                    <input
                      id="admin-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => update("email", e.target.value)}
                      placeholder="e.g. jordan.lee@company.com"
                      className={`${inputBase} ${errors.email ? inputError : ""}`}
                      aria-invalid={!!errors.email}
                      aria-describedby={errors.email ? "admin-email-error" : undefined}
                    />
                    {errors.email && (
                      <p id="admin-email-error" className="mt-1.5 text-sm text-red-500">
                        {errors.email}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="admin-password" className="block text-sm font-medium text-fms-text mb-1.5">
                      {t("admins.password")} <span className="text-fms-text-tertiary">({t("employees.required")})</span>
                    </label>
                    <input
                      id="admin-password"
                      type="password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder={t("admins.passwordPlaceholder")}
                      className={`${inputBase} ${errors.password ? inputError : ""}`}
                      aria-invalid={!!errors.password}
                      aria-describedby={errors.password ? "admin-password-error" : undefined}
                      autoComplete="new-password"
                    />
                    {errors.password && (
                      <p id="admin-password-error" className="mt-1.5 text-sm text-red-500">
                        {errors.password}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-4 pt-6 border-t border-fms-border">
              <h2 className="text-base font-semibold text-fms-text m-0">
                {t("admins.moduleAccess")}
              </h2>
              <div className="space-y-3">
                {ADMIN_PERMISSION_KEYS.map((key) => {
                  const checked = form.permissions.includes(key);
                  const labelKey = PERMISSION_LABEL_KEYS[key];
                  return (
                    <div key={key} className="fms-toggle-row flex items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <span className="block text-sm font-medium text-fms-text">
                          {t(labelKey)}
                        </span>
                        <span className="block text-xs text-fms-text-tertiary mt-0.5">
                          {t("admins.accessModuleHint", { module: t(labelKey) })}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={t("admins.toggleAccess", { module: t(labelKey) })}
                        data-checked={checked}
                        className="fms-switch shrink-0"
                        onClick={() => togglePermission(key)}
                      >
                        <span className="fms-switch-thumb" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="flex flex-wrap gap-3 p-6 sm:p-8 pt-0 border-t border-fms-border bg-fms-bg-subtle/20">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover disabled:opacity-60 disabled:pointer-events-none"
            >
              {submitting ? t("admins.saving") : t("admins.createAdmin")}
            </button>
            <Link
              href="/admins"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-2xl text-sm font-medium border border-fms-border text-fms-text hover:bg-fms-bg-subtle"
            >
              {t("employees.cancel")}
            </Link>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
