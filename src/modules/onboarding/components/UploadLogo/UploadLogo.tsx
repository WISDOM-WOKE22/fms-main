"use client";

import { useRef } from "react";

export interface UploadLogoProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  label?: string;
  disabled?: boolean;
}

export default function UploadLogo({ value, onChange, label = "Upload Logo", disabled }: UploadLogoProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      onChange(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
        aria-label={label}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center justify-center w-full min-h-[120px] p-6 bg-fms-bg-subtle border border-dashed border-fms-border-strong rounded-2xl cursor-pointer transition-colors hover:border-fms-accent hover:bg-fms-accent-muted disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        aria-label={label}
      >
        {value ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={value} alt="Organization logo" className="max-w-full max-h-[140px] object-contain rounded-2xl" />
        ) : (
          <span className="flex flex-col items-center gap-2.5 text-[0.9375rem] font-medium text-fms-text-tertiary">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-fms-text-tertiary" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            {label}
          </span>
        )}
      </button>
    </div>
  );
}
