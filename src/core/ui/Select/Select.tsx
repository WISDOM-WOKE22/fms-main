"use client";

import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { IconChevronDown } from "@/core/layout/icons";

type SelectSize = "sm" | "md";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
  selectSize?: SelectSize;
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const sizeClasses: Record<SelectSize, string> = {
  sm: "min-h-9 px-3 py-1.5 pr-10 text-sm",
  md: "min-h-[48px] px-4 py-3 pr-11 text-sm",
};

const iconSizeClasses: Record<SelectSize, string> = {
  sm: "w-4 h-4",
  md: "w-4 h-4",
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      id,
      label,
      hint,
      error,
      className,
      wrapperClassName,
      selectSize = "md",
      children,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = id ?? `select-${generatedId}`;
    const describedBy = error
      ? `${selectId}-error`
      : hint
        ? `${selectId}-hint`
        : undefined;

    return (
      <div className={cx("flex flex-col gap-1.5", wrapperClassName)}>
        {label ? (
          <label htmlFor={selectId} className="text-sm font-medium text-fms-text-secondary">
            {label}
          </label>
        ) : null}

        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            className={cx(
              "w-full appearance-none rounded-2xl border bg-fms-surface text-fms-text",
              "border-fms-border placeholder:text-fms-text-tertiary",
              "hover:border-fms-border-strong",
              "focus:outline-none focus:border-fms-accent focus:ring-3 focus:ring-fms-accent-muted",
              "disabled:opacity-70 disabled:cursor-not-allowed transition-colors",
              sizeClasses[selectSize],
              !!error && "border-red-500 focus:border-red-500 focus:ring-red-500/20",
              className
            )}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            {...props}
          >
            {children}
          </select>

          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-fms-text-tertiary">
            <IconChevronDown className={iconSizeClasses[selectSize]} aria-hidden />
          </span>
        </div>

        {error ? (
          <span id={`${selectId}-error`} className="text-[0.8125rem] text-red-500" role="alert">
            {error}
          </span>
        ) : hint ? (
          <span id={`${selectId}-hint`} className="text-[0.8125rem] text-fms-text-tertiary">
            {hint}
          </span>
        ) : null}
      </div>
    );
  }
);

Select.displayName = "Select";

export default Select;
