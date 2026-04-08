"use client";

import { useState, useCallback, useEffect } from "react";
import { useAppPathname } from "@/core/tauri/TauriPathContext";
import { useTauriReplace } from "@/core/tauri/useTauriPush";
import { AppSidebar } from "@/core/layout/AppSidebar";
import { AppTopBar } from "@/core/layout/AppTopBar";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { useAppPreferences } from "@/core/contexts/AppPreferencesContext";
import { useAuthStore } from "@/core/store/useAuthStore";
import { navSections } from "@/core/layout/nav-config";
import type { AdminPermissionKey } from "@/modules/admins/types";

const SIDEBAR_COLLAPSED_KEY = "fms-sidebar-collapsed";
const SESSION_KEY = "fms-session";

/** Map pathname to required permission key for route guard. */
function getPermissionForPath(pathname: string): AdminPermissionKey | null {
  for (const section of navSections) {
    for (const item of section.items) {
      if (!item.permissionKey) continue;
      if (pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href))) {
        return item.permissionKey;
      }
    }
  }
  return null;
}

export interface DashboardLayoutProps {
  children: React.ReactNode;
  /** Page title shown in top bar (e.g. "Dashboard") */
  title?: string;
}

export default function DashboardLayout({ children, title = "Dashboard" }: DashboardLayoutProps) {
  const { config } = useAppConfig();
  const { getDisplayName, getLogoUrl } = useAppPreferences();
  const admin = useAuthStore((s) => s.admin);
  const canAccess = useAuthStore((s) => s.canAccess);
  const getInitials = useAuthStore((s) => s.getInitials);
  const pathname = useAppPathname();
  const replace = useTauriReplace();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Redirect to login if no session (e.g. direct link to /dashboard while logged out)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.localStorage.getItem(SESSION_KEY)) {
      replace("/login");
      return;
    }
    const perm = getPermissionForPath(pathname);
    if (perm && admin && admin.role === "sub_admin" && !canAccess(perm)) {
      replace("/dashboard");
    }
  }, [pathname, admin, canAccess, replace]);

  const orgName = getDisplayName(config.companyName);
  const logoUrl = getLogoUrl(config.companyLogoUrl);

  const user = admin
    ? {
        initials: getInitials(),
        name: admin.name,
        role: admin.role === "super_admin" ? "Super Admin" : "Sub Admin",
      }
    : { initials: "?", name: "", role: "" };

  return (
    <div className="h-screen w-full flex overflow-hidden bg-fms-bg text-fms-text">
      <AppSidebar
        logoUrl={logoUrl}
        orgName={orgName}
        user={user}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <AppTopBar title={title} logoUrl={logoUrl} orgName={orgName} />
        <main className="flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}
