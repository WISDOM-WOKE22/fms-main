"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface PasswordFieldProps {
  id?: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  autoComplete?: string;
  className?: string;
}

export default function PasswordField({
  id: idProp,
  label,
  placeholder,
  value,
  onChange,
  error,
  disabled,
  autoComplete,
  className = "",
}: PasswordFieldProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const id = idProp ?? `password-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`.trim()}>
      <label htmlFor={id} className="text-sm font-medium text-fms-text">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className={`w-full py-3.5 pl-[18px] pr-11 text-base bg-fms-bg-subtle text-fms-text border rounded-2xl border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:border-fms-border-strong focus:ring-[3px] focus:ring-fms-border transition-colors ${
            error ? "border-red-500 focus:ring-red-500/20" : ""
          }`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete={autoComplete}
          aria-invalid={!!error}
        />
        <button
          type="button"
          className="absolute top-1/2 right-3 -translate-y-1/2 p-0 bg-transparent border-none text-fms-text-tertiary cursor-pointer flex items-center justify-center hover:text-fms-text-secondary"
          onClick={() => setVisible((v) => !v)}
          tabIndex={-1}
          aria-label={visible ? t("aria.hidePassword") : t("aria.showPassword")}
        >
          {visible ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      {error ? <span className="text-[0.8125rem] text-red-500" role="alert">{error}</span> : null}
    </div>
  );
}
