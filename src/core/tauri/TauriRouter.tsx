"use client";

import { useState, useEffect, useCallback } from "react";
import { TauriPathContext } from "./TauriPathContext";
import { isTauri } from "./isTauri";

// Lazy pages to avoid loading everything when not in Tauri
import DashboardPage from "@/modules/dashboard/pages/DashboardPage/DashboardPage";
import PeopleCountPage from "@/modules/people-count/pages/PeopleCountPage/PeopleCountPage";
import EmployeesPage from "@/modules/employees/pages/EmployeesPage/EmployeesPage";
import EmployeeDetailPage from "@/modules/employees/pages/EmployeeDetailPage/EmployeeDetailPage";
import AddEmployeePage from "@/modules/employees/pages/AddEmployeePage/AddEmployeePage";
import AdminsPage from "@/modules/admins/pages/AdminsPage/AdminsPage";
import AdminDetailPage from "@/modules/admins/pages/AdminDetailPage/AdminDetailPage";
import AddAdminPage from "@/modules/admins/pages/AddAdminPage/AddAdminPage";
import ShiftsPage from "@/modules/shifts/pages/ShiftsPage/ShiftsPage";
import ShiftDetailPage from "@/modules/shifts/pages/ShiftDetailPage/ShiftDetailPage";
import AddShiftPage from "@/modules/shifts/pages/AddShiftPage/AddShiftPage";
import ZonesPage from "@/modules/zones/pages/ZonesPage/ZonesPage";
import AddZonePage from "@/modules/zones/pages/AddZonePage/AddZonePage";
import PersonTypesPage from "@/modules/person-types/pages/PersonTypesPage/PersonTypesPage";
import AccessLogsPage from "@/modules/access-logs/pages/AccessLogsPage/AccessLogsPage";
import AuditLogsPage from "@/modules/audit-logs/pages/AuditLogsPage/AuditLogsPage";
import ReportsPage from "@/modules/reports/pages/ReportsPage/ReportsPage";
import NotificationsPage from "@/modules/notifications/pages/NotificationsPage/NotificationsPage";
import SettingsPage from "@/modules/settings/pages/SettingsPage/SettingsPage";
import ProfilePage from "@/modules/profile/pages/ProfilePage/ProfilePage";
import LoginPage from "@/modules/auth/pages/LoginPage/LoginPage";
import OnboardingPage from "@/modules/onboarding/OnboardingPage";
import { apiFetch } from "@/core/api/request";

function getPathFromHash(): string {
  if (typeof window === "undefined") return "/";
  const hash = window.location.hash.slice(1);
  if (hash.startsWith("/")) return hash;
  if (hash === "") return "/";
  return "/" + hash;
}

interface RouteMatch {
  path: string;
  title: string;
  useDashboardLayout: boolean;
  render: () => React.ReactNode;
}

function matchRoute(path: string): RouteMatch | null {
  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const normalized = "/" + segments.join("/");

  const titleFor = (t: string) => t;

  // Exact routes with dashboard layout (root / uses home/onboarding/login)
  const exact: Record<string, { title: string; render: () => React.ReactNode; noLayout?: boolean }> = {
    "/": { title: "Home", render: () => <TauriHomeOrLogin />, noLayout: true },
    "/dashboard": { title: "Dashboard", render: () => <DashboardPage /> },
    "/people-count": { title: "People Count", render: () => <PeopleCountPage /> },
    "/employees": { title: "People", render: () => <EmployeesPage /> },
    "/employees/new": { title: "Add Person", render: () => <AddEmployeePage /> },
    "/admins": { title: "Admins", render: () => <AdminsPage /> },
    "/admins/new": { title: "Add Admin", render: () => <AddAdminPage /> },
    "/shifts": { title: "Schedules", render: () => <ShiftsPage /> },
    "/shifts/new": { title: "Add Schedule", render: () => <AddShiftPage /> },
    "/zones": { title: "Locations", render: () => <ZonesPage /> },
    "/zones/new": { title: "Add Location", render: () => <AddZonePage /> },
    "/person-types": { title: "Person Types", render: () => <PersonTypesPage /> },
    "/access-logs": { title: "Access Logs", render: () => <AccessLogsPage /> },
    "/audit-logs": { title: "Audit Logs", render: () => <AuditLogsPage /> },
    "/reports": { title: "Reports", render: () => <ReportsPage /> },
    "/notifications": { title: "Notifications", render: () => <NotificationsPage /> },
    "/settings": { title: "Settings", render: () => <SettingsPage /> },
    "/profile": { title: "Profile", render: () => <ProfilePage /> },
    "/login": { title: "Login", render: () => <LoginPage />, noLayout: true },
  };

  const exactMatch = exact[normalized];
  if (exactMatch) {
    return {
      path: normalized,
      title: exactMatch.title,
      useDashboardLayout: !exactMatch.noLayout && normalized !== "/login",
      render: exactMatch.render,
    };
  }

  // Dynamic: /employees/:id
  if (segments[0] === "employees" && segments.length === 2 && segments[1]) {
    const id = segments[1];
    return {
      path: normalized,
      title: "Person",
      useDashboardLayout: true,
      render: () => <EmployeeDetailPage tauriId={id} />,
    };
  }
  if (segments[0] === "admins" && segments.length === 2 && segments[1]) {
    const id = segments[1];
    return {
      path: normalized,
      title: "Admin",
      useDashboardLayout: true,
      render: () => <AdminDetailPage tauriId={id} />,
    };
  }
  if (segments[0] === "shifts" && segments.length === 3 && segments[2] === "edit" && segments[1]) {
    const id = segments[1];
    return {
      path: normalized,
      title: "Edit Schedule",
      useDashboardLayout: true,
      render: () => <AddShiftPage editId={id} />,
    };
  }
  if (segments[0] === "shifts" && segments.length === 2 && segments[1]) {
    const id = segments[1];
    return {
      path: normalized,
      title: "Schedule",
      useDashboardLayout: true,
      render: () => <ShiftDetailPage tauriId={id} />,
    };
  }

  return null;
}

function TauriHomeOrLogin() {
  const [ready, setReady] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/v1/config")
      .then((r) => r.json())
      .then((c: { onboardingCompleted?: boolean }) => {
        if (mounted) {
          setOnboardingCompleted(Boolean(c.onboardingCompleted));
          setReady(true);
        }
      })
      .catch(() => {
        if (mounted) setReady(true);
      });
    return () => { mounted = false; };
  }, []);

  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center bg-fms-bg text-fms-text">
        <span className="text-sm text-fms-text-secondary">Loading…</span>
      </div>
    );
  }
  if (onboardingCompleted) {
    return <LoginPage />;
  }
  return <OnboardingPage />;
}

export default function TauriRouter() {
  const [path, setPath] = useState("/");
  const [ready, setReady] = useState(false);

  const syncFromHash = useCallback(() => {
    const next = getPathFromHash();
    setPath(next);
  }, []);

  useEffect(() => {
    syncFromHash();
    setReady(true);
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [syncFromHash]);

  const route = matchRoute(path);
  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center bg-fms-bg text-fms-text">
        <span className="text-sm text-fms-text-secondary">Loading…</span>
      </div>
    );
  }

  if (!route) {
    return (
      <TauriPathContext.Provider value={path}>
        <div className="h-screen flex items-center justify-center bg-fms-bg text-fms-text">
          <p className="text-fms-text-secondary">Page not found.</p>
        </div>
      </TauriPathContext.Provider>
    );
  }

  // Pages already wrap themselves in DashboardLayout (with sidebar); do not wrap again
  // or we get a duplicate sidebar in the desktop app.
  const content = route.render();
  return <TauriPathContext.Provider value={path}>{content}</TauriPathContext.Provider>;
}
