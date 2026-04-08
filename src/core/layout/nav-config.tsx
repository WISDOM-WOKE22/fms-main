"use client";

import {
  IconGrid,
  IconUsers,
  IconUser,
  IconList,
  IconClipboardCheck,
  IconClock,
  IconShield,
  IconFileText,
  IconBell,
  IconSettings,
  IconMapPin,
} from "./icons";
import type { AdminPermissionKey } from "@/modules/admins/types";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Permission required for sub_admin; super_admin always sees all. Omit for always-visible. */
  permissionKey?: AdminPermissionKey;
}

export interface NavSection {
  headingKey: string;
  items: NavItem[];
}

export const navSections: NavSection[] = [
  {
    headingKey: "nav.main",
    items: [
      { href: "/dashboard", labelKey: "nav.dashboard", icon: IconGrid, permissionKey: "dashboard" },
      { href: "/people-count", labelKey: "nav.peopleCount", icon: IconList, permissionKey: "dashboard" },
      { href: "/employees", labelKey: "nav.employees", icon: IconUsers, permissionKey: "employees" },
      { href: "/access-logs", labelKey: "nav.accessLogs", icon: IconList, permissionKey: "accessLogs" },
      { href: "/audit-logs", labelKey: "nav.auditLogs", icon: IconClipboardCheck, permissionKey: "auditLogs" },
      { href: "/zones", labelKey: "nav.zones", icon: IconMapPin, permissionKey: "zones" },
      { href: "/shifts", labelKey: "nav.shifts", icon: IconClock, permissionKey: "shifts" },
      { href: "/person-types", labelKey: "nav.personTypes", icon: IconUsers, permissionKey: "admins" },
      { href: "/admins", labelKey: "nav.admins", icon: IconShield, permissionKey: "admins" },
      { href: "/reports", labelKey: "nav.reports", icon: IconFileText, permissionKey: "reports" },
      { href: "/notifications", labelKey: "nav.notifications", icon: IconBell },
    ],
  },
  {
    headingKey: "nav.account",
    items: [
      { href: "/profile", labelKey: "nav.profile", icon: IconUser },
      { href: "/settings", labelKey: "nav.settings", icon: IconSettings, permissionKey: "settings" },
    ],
  },
];
