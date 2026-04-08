/**
 * Cookie keys and helpers for SSR-safe initial language/theme.
 * Values are set on the client when user changes language/theme and read on the server for initial HTML.
 */

export const COOKIE_LANG = "fms-lang";
export const COOKIE_THEME = "fms-theme";

const MAX_AGE_YEAR = 60 * 60 * 24 * 365;

export function setLangCookie(lang: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_LANG}=${lang}; path=/; max-age=${MAX_AGE_YEAR}; SameSite=Lax`;
}

export function setThemeCookie(theme: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_THEME}=${theme}; path=/; max-age=${MAX_AGE_YEAR}; SameSite=Lax`;
}
