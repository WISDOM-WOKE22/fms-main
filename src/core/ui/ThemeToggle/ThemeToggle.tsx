"use client";

import { useTheme } from "@/core/contexts/ThemeContext";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex items-center gap-2.5 px-3 py-2 rounded-[20px] bg-white/65 dark:bg-neutral-800/70 border border-white/40 dark:border-white/10 backdrop-blur-xl hover:bg-neutral-100 dark:hover:bg-neutral-700/80 transition-colors active:scale-[0.98]"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      <span
        className={`flex items-center w-10 h-[22px] p-0.5 rounded-[11px] transition-colors ${
          isDark ? "bg-[rgba(41,151,255,0.18)]" : "bg-neutral-200 dark:bg-neutral-700"
        }`}
      >
        <span
          className={`block w-[18px] h-[18px] rounded-full bg-white dark:bg-[var(--color-fms-accent-dark)] shadow-sm transition-transform ${
            isDark ? "translate-x-[18px]" : "translate-x-0"
          }`}
        />
      </span>
      <span className="flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors">
        {isDark ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </span>
    </button>
  );
}
