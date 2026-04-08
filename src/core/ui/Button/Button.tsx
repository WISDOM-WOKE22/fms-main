"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  loading?: boolean;
}

const variantClasses = {
  primary:
    "bg-[var(--color-fms-accent)] text-white shadow-sm hover:bg-[#0077ed] hover:shadow-md disabled:opacity-60",
  secondary:
    "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700 shadow-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/80",
  ghost:
    "bg-transparent text-neutral-500 hover:bg-[rgba(0,113,227,0.12)] hover:text-[var(--color-fms-accent)]",
};

const sizeClasses = {
  sm: "px-4 py-2 text-sm rounded-2xl",
  md: "px-6 py-3 text-base rounded-2xl",
  lg: "px-8 py-4 text-[1.0625rem] rounded-2xl",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      fullWidth = false,
      loading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref
  ) => (
    <button
      ref={ref}
      type={props.type ?? "button"}
      disabled={disabled || loading}
      className={[
        "inline-flex items-center justify-center gap-2 font-medium cursor-pointer transition-all duration-200 rounded-2xl active:scale-[0.98]",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-loading={loading ? "" : undefined}
      {...props}
    >
      {loading ? (
        <span
          className="size-4 border-2 border-current border-r-transparent rounded-full animate-spin"
          aria-hidden
        />
      ) : null}
      <span className={loading ? "opacity-70" : ""}>{children}</span>
    </button>
  )
);

Button.displayName = "Button";
export default Button;
