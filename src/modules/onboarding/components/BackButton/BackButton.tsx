"use client";

export interface BackButtonProps {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export default function BackButton({ onClick, label = "Back", disabled, className = "" }: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 py-2 bg-transparent border-none text-[0.9375rem] font-medium text-neutral-500 cursor-pointer transition-colors hover:text-[var(--color-fms-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`.trim()}
      disabled={disabled}
      aria-label={label}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
