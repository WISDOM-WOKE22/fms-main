"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useAppPathname } from "@/core/tauri/TauriPathContext";
import { isTauri } from "@/core/tauri/isTauri";
import { useTranslation } from "react-i18next";
import { navSections } from "@/core/layout/nav-config";
import { useAuthStore } from "@/core/store/useAuthStore";
import { IconLogout, IconChevronLeft, IconChevronRight } from "@/core/layout/icons";
import { CompanyLogo } from "@/core/ui";
import styles from "./AppSidebar.module.css";

const BRAND_NAME = "EglobalSphere";

const POPUP_OFFSET = 12;

export interface AppSidebarProps {
  logoUrl?: string | null;
  orgName?: string;
  user?: { initials: string; name: string; role: string };
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function AppSidebar({
  logoUrl,
  orgName,
  user,
  collapsed = false,
  onToggleCollapse,
}: AppSidebarProps) {
  const pathname = useAppPathname();
  const { t } = useTranslation();
  const canAccess = useAuthStore((s) => s.canAccess);
  const logout = useAuthStore((s) => s.logout);

  const displayName = orgName ?? BRAND_NAME;
  const userInitials = user?.initials ?? "?";
  const userName = user?.name ?? "";
  const userRole = user?.role ?? "";

  const filteredSections = useMemo(() => {
    return navSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          if (!item.permissionKey) return true;
          return canAccess(item.permissionKey);
        }),
      }))
      .filter((section) => section.items.length > 0);
  }, [canAccess]);

  const [popup, setPopup] = useState<{
    content: string;
    top: number;
    left: number;
    rtl: boolean;
  } | null>(null);

  const showPopup = useCallback((e: React.MouseEvent<HTMLElement>, content: string) => {
    if (!collapsed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rtl =
      typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
    setPopup({
      content,
      left: rtl ? rect.left - POPUP_OFFSET : rect.right + POPUP_OFFSET,
      top: rect.top + rect.height / 2,
      rtl,
    });
  }, [collapsed]);

  const hidePopup = useCallback(() => setPopup(null), []);

  useEffect(() => {
    if (!collapsed) setPopup(null);
  }, [collapsed]);

  return (
    <aside
      className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : styles.sidebarExpanded}`}
    >
      {/* Logo + brand + collapse toggle */}
      <div className={styles.header} title={collapsed ? displayName : undefined}>
        <div className={styles.headerLeft}>
          <CompanyLogo
            companyName={displayName}
            logoUrl={logoUrl}
            size="sm"
            className={styles.logo}
          />
          <span className={styles.brandName}>{displayName}</span>
        </div>
        {onToggleCollapse && (
          <div
            className={styles.toggleWrap}
            onMouseEnter={(e) => showPopup(e, t("sidebar.expand"))}
            onMouseLeave={hidePopup}
          >
            <button
              type="button"
              onClick={onToggleCollapse}
              className={styles.toggleBtn}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? undefined : t("sidebar.collapse")}
            >
              {collapsed ? (
                <IconChevronRight className="w-5 h-5" aria-hidden />
              ) : (
                <IconChevronLeft className="w-5 h-5" aria-hidden />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Nav sections (filtered by permission for sub_admin) */}
      <nav className={styles.nav} aria-label="Main navigation">
        {filteredSections.map((section) => (
          <div key={section.headingKey} className={styles.section}>
            <h3 className={styles.sectionHeading}>{t(section.headingKey)}</h3>
            <ul className={styles.navList}>
              {section.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`${styles.navLink} ${isActive ? styles.navLinkActive : ""}`}
                      title={collapsed ? t(item.labelKey) : undefined}
                      onMouseEnter={(e) => showPopup(e, t(item.labelKey))}
                      onMouseLeave={hidePopup}
                    >
                      <span className={styles.navIcon}>
                        <Icon className="text-current" />
                      </span>
                      <span className={styles.navLabel}>{t(item.labelKey)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User block + logout */}
      <div className={styles.userBlock}>
        <div className={styles.userInner}>
          {!collapsed && (
            <>
              <div className={styles.userAvatar}>{userInitials}</div>
              <div className={styles.userInfo}>
                <p className={styles.userName}>{userName}</p>
                <p className={styles.userRole}>{userRole}</p>
              </div>
            </>
          )}
          <div className={styles.logoutWrap}>
            {isTauri() ? (
              <button
                type="button"
                className={styles.logoutBtn}
                aria-label="Log out"
                title={collapsed ? "Log out" : undefined}
                onMouseEnter={(e) => showPopup(e, "Log out")}
                onMouseLeave={hidePopup}
                onClick={() => {
                  logout();
                  // Navigate to login via hash so Tauri router shows LoginPage (no full reload)
                  const base = window.location.pathname || "/";
                  const search = window.location.search || "";
                  window.history.replaceState(null, "", `${base}${search}#/login`);
                  window.dispatchEvent(new HashChangeEvent("hashchange"));
                }}
              >
                <IconLogout className="w-5 h-5" />
              </button>
            ) : (
              <a
                href="/login"
                className={styles.logoutBtn}
                aria-label="Log out"
                title={collapsed ? "Log out" : undefined}
                onMouseEnter={(e) => showPopup(e, "Log out")}
                onMouseLeave={hidePopup}
                onClick={(e) => {
                  e.preventDefault();
                  logout();
                  window.location.href = "/login";
                }}
              >
                <IconLogout className="w-5 h-5" />
              </a>
            )}
          </div>
        </div>
      </div>

      {popup &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className={`${styles.sidebarPopup} ${popup.rtl ? styles.sidebarPopupRtl : ""}`}
            style={{
              left: popup.left,
              top: popup.top,
            }}
            role="tooltip"
          >
            {popup.content}
          </div>,
          document.body
        )}
    </aside>
  );
}
