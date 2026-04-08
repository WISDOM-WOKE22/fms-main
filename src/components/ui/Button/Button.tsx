"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  loading?: boolean;
}

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
  ) => {
    return (
      <button
        ref={ref}
        type={props.type ?? "button"}
        disabled={disabled || loading}
        className={`${styles.root} ${styles[variant]} ${styles[size]} ${fullWidth ? styles.fullWidth : ""} ${className}`.trim()}
        data-loading={loading ? "" : undefined}
        {...props}
      >
        {loading ? (
          <span className={styles.spinner} aria-hidden />
        ) : null}
        <span className={styles.label}>{children}</span>
      </button>
    );
  }
);

Button.displayName = "Button";

export default Button;
