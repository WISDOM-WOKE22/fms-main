"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "@/core/layout/icons";

export interface MultiSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface MultiSelectProps {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: ReactNode;
  className?: string;
  columns?: 1 | 2;
  disabled?: boolean;
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function MultiSelect({
  options,
  values,
  onChange,
  label,
  hint,
  error,
  placeholder = "Select options",
  className,
  columns = 1,
  disabled = false,
}: MultiSelectProps) {
  const generatedId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selectedOptions = useMemo(
    () => options.filter((option) => values.includes(option.value)),
    [options, values]
  );

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggleValue = (nextValue: string, checked: boolean) => {
    if (disabled) return;
    if (checked) {
      onChange(Array.from(new Set([...values, nextValue])));
      return;
    }
    onChange(values.filter((value) => value !== nextValue));
  };

  const summary = useMemo(() => {
    if (selectedOptions.length === 0) return placeholder;
    const labels = selectedOptions.map((option) =>
      typeof option.label === "string" ? option.label : null
    );
    if (labels.every(Boolean) && selectedOptions.length <= 2) {
      return labels.join(", ");
    }
    return `${selectedOptions.length} selected`;
  }, [placeholder, selectedOptions]);

  return (
    <div ref={rootRef} className={cx("flex flex-col gap-1.5", className)}>
      {label ? <span className="text-sm font-medium text-fms-text-secondary">{label}</span> : null}
      {hint ? <span className="text-[0.8125rem] text-fms-text-tertiary">{hint}</span> : null}

      <div className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen((prev) => !prev)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`multi-select-panel-${generatedId}`}
          className={cx(
            "flex min-h-[48px] w-full items-center justify-between gap-3 rounded-2xl border bg-fms-surface px-4 py-3 text-left text-sm transition-colors",
            "border-fms-border text-fms-text hover:border-fms-border-strong",
            "focus:outline-none focus:border-fms-accent focus:ring-3 focus:ring-fms-accent-muted",
            disabled && "cursor-not-allowed opacity-70",
            !!error && "border-red-500 focus:border-red-500 focus:ring-red-500/20"
          )}
        >
          <span className={cx("truncate", selectedOptions.length === 0 && "text-fms-text-tertiary")}>
            {summary}
          </span>
          <IconChevronDown
            className={cx(
              "h-4 w-4 shrink-0 text-fms-text-tertiary transition-transform",
              open && "rotate-180"
            )}
            aria-hidden
          />
        </button>

        {open && (
          <div
            id={`multi-select-panel-${generatedId}`}
            role="listbox"
            aria-multiselectable="true"
            className="absolute z-20 mt-2 w-full rounded-2xl border border-fms-border bg-fms-surface p-2 shadow-xl"
          >
            <div
              className={cx(
                "grid max-h-72 gap-2 overflow-auto",
                columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"
              )}
            >
              {options.map((option, index) => {
                const inputId = `multi-select-${generatedId}-${index}`;
                const checked = values.includes(option.value);
                const optionDisabled = disabled || option.disabled;
                return (
                  <label
                    key={option.value}
                    htmlFor={inputId}
                    className={cx(
                      "flex items-center gap-3 rounded-2xl border border-fms-border bg-fms-surface px-3 py-2.5",
                      "transition-colors",
                      optionDisabled
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:border-fms-border-strong hover:bg-fms-bg-subtle/50",
                      checked && "border-fms-accent bg-fms-accent-muted/40"
                    )}
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      className="h-4.5 w-4.5 rounded-md border-fms-border text-fms-accent focus:ring-fms-accent-muted"
                      checked={checked}
                      disabled={optionDisabled}
                      onChange={(event) => toggleValue(option.value, event.target.checked)}
                    />
                    <span className="min-w-0 text-sm text-fms-text">{option.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error ? <span className="text-[0.8125rem] text-red-500">{error}</span> : null}
    </div>
  );
}

export default MultiSelect;
