"use client";

export type BadgeVariant = "success" | "neutral" | "warning" | "muted" | "danger" | "purple" | "blue";

const variantStyles: Record<BadgeVariant, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  neutral: "bg-fms-bg-subtle text-fms-text border-fms-border",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25",
  muted: "bg-fms-bg-subtle text-fms-text-tertiary border-fms-border",
  danger: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/25",
  purple: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/25",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25",
};

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export default function Badge({ children, variant = "neutral", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-2xl text-xs font-medium border ${variantStyles[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
