"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className = "", ...props }, ref) => {
    const inputId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`;
    return (
      <div className={`flex flex-col gap-1.5 ${className}`.trim()}>
        {label ? (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-fms-text-secondary"
          >
            {label}
          </label>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          className={[
            "w-full px-[18px] py-3.5 text-base bg-fms-surface text-fms-text",
            "border rounded-2xl border-fms-border",
            "placeholder:text-fms-text-tertiary",
            "hover:border-fms-border-strong",
            "focus:outline-none focus:border-fms-accent focus:ring-3 focus:ring-fms-accent-muted",
            "transition-colors",
            error && "border-red-500 focus:border-red-500 focus:ring-red-500/20",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {error ? (
          <span id={`${inputId}-error`} className="text-[0.8125rem] text-red-500" role="alert">
            {error}
          </span>
        ) : hint ? (
          <span id={`${inputId}-hint`} className="text-[0.8125rem] text-fms-text-tertiary">
            {hint}
          </span>
        ) : null}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
