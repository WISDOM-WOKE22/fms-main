"use client";

/**
 * Company logo: image from URL or fallback to first letter of company name.
 * Wraps image in a fixed-size box so the logo never stretches.
 */

export interface CompanyLogoProps {
  /** Company or organization name (used for initial when no image) */
  companyName: string;
  /** Optional logo image URL from env or API */
  logoUrl?: string | null;
  /** Size variant */
  size?: "sm" | "md";
  /** Additional class for the wrapper */
  className?: string;
}

function getInitial(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

const sizePx = { sm: 36, md: 48 };
const sizeClasses = {
  sm: "w-9 h-9 text-sm",
  md: "w-12 h-12 text-base",
};

export default function CompanyLogo({
  companyName,
  logoUrl,
  size = "sm",
  className = "",
}: CompanyLogoProps) {
  const initial = getInitial(companyName);
  const sizeClass = sizeClasses[size];
  const px = sizePx[size];

  if (logoUrl && logoUrl.trim()) {
    return (
      <div
        className={`rounded-2xl shrink-0 bg-fms-bg-subtle overflow-hidden flex items-center justify-center ${sizeClass} ${className}`}
        style={{
          width: px,
          height: px,
          minWidth: px,
          minHeight: px,
          maxWidth: px,
          maxHeight: px,
        }}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt=""
          className="w-full h-full object-contain"
          style={{ width: px, height: px, objectFit: "contain" }}
        />
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl flex items-center justify-center shrink-0 bg-fms-accent text-white font-bold ${sizeClass} ${className}`}
      aria-hidden
    >
      {initial}
    </div>
  );
}
