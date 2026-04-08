"use client";

import { useTranslation } from "react-i18next";
import {
  IconUsers,
  IconLogin,
  IconLogout,
  IconGrid,
  IconMapPin,
  IconClock,
} from "@/core/layout/icons";
import { CompanyLogo } from "@/core/ui";
import { navSections } from "@/core/layout/nav-config";
import { EntriesExitsAreaChart } from "@/modules/dashboard/components/EntriesExitsAreaChart";
import type { EntriesExitsDataPoint } from "@/modules/dashboard/components/EntriesExitsAreaChart";
import styles from "./DashboardPreview.module.css";

const PREVIEW_CHART_DATA: EntriesExitsDataPoint[] = [
  { date: "Mon", entries: 42, exits: 38 },
  { date: "Tue", entries: 56, exits: 51 },
  { date: "Wed", entries: 48, exits: 44 },
  { date: "Thu", entries: 61, exits: 58 },
  { date: "Fri", entries: 72, exits: 69 },
  { date: "Sat", entries: 28, exits: 26 },
  { date: "Sun", entries: 18, exits: 16 },
];

const PREVIEW_ACCESS_LOGS: { time: string; name: string; zone: string; action: "check-in" | "check-out" }[] = [
  { time: "09:02", name: "Sarah Chen", zone: "Main Gate", action: "check-in" },
  { time: "09:15", name: "James Okonkwo", zone: "Building A", action: "check-in" },
  { time: "09:28", name: "Amina Hassan", zone: "Main Gate", action: "check-in" },
  { time: "12:00", name: "David Kim", zone: "Building B", action: "check-out" },
  { time: "12:33", name: "Emma Wilson", zone: "Main Gate", action: "check-out" },
  { time: "14:00", name: "Michael Brown", zone: "Building A", action: "check-in" },
  { time: "14:22", name: "Fatima Al-Rashid", zone: "Building B", action: "check-in" },
  { time: "17:05", name: "Omar Hassan", zone: "Main Gate", action: "check-out" },
  { time: "17:18", name: "Lisa Park", zone: "Building A", action: "check-out" },
  { time: "17:45", name: "Ahmed Ibrahim", zone: "Building B", action: "check-out" },
];

const PREVIEW_AUDIT_LOGS: { time: string; user: string; action: string; resource: string }[] = [
  { time: "08:12", user: "Admin", action: "Login", resource: "auth" },
  { time: "08:45", user: "Admin", action: "View list", resource: "employees" },
  { time: "09:00", user: "Admin", action: "Create", resource: "zone" },
  { time: "09:30", user: "Admin", action: "Update", resource: "shift" },
  { time: "10:15", user: "Admin", action: "Export", resource: "accessLogs" },
  { time: "11:00", user: "Admin", action: "View", resource: "dashboard" },
  { time: "13:22", user: "Admin", action: "Edit", resource: "employee" },
  { time: "14:00", user: "Admin", action: "Login", resource: "auth" },
  { time: "15:45", user: "Admin", action: "Delete", resource: "admin" },
  { time: "16:30", user: "Admin", action: "View list", resource: "auditLogs" },
];

export interface DashboardPreviewProps {
  logoUrl: string | null;
  organizationName: string;
}

const DEFAULT_ORG = "EglobalSphere";

/**
 * Fixed 16-inch (1920px) dashboard preview; overflow allowed, chart 600px, full sidebar.
 */
export default function DashboardPreview({ logoUrl, organizationName }: DashboardPreviewProps) {
  const { t } = useTranslation();
  const orgName = organizationName?.trim() || DEFAULT_ORG;

  return (
    <div className={styles.root} aria-hidden>
      <aside className={styles.sidebar}>
        <div className={styles.logoBlock}>
          <div className={styles.logoBox}>
            <CompanyLogo companyName={orgName} logoUrl={logoUrl} size="sm" className={styles.logoImg} />
          </div>
          <span className={styles.orgName}>{orgName}</span>
        </div>
        <nav className={styles.nav}>
          {navSections.map((section) => (
            <div key={section.headingKey} className={styles.navSection}>
              <h3 className={styles.navSectionHeading}>{t(section.headingKey)}</h3>
              <ul className={styles.navList}>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.href === "/dashboard";
                  return (
                    <li key={item.href}>
                      <div className={`${styles.navItem} ${isActive ? styles.navItemActive : ""}`}>
                        <Icon className={styles.navIcon} />
                        <span>{t(item.labelKey)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className={styles.userBlock}>
          <div className={styles.userInner}>
            <div className={styles.userAvatar}>WW</div>
            <div className={styles.userInfo}>
              <p className={styles.userName}>Wisdom</p>
              <p className={styles.userRole}>Admin</p>
            </div>
          </div>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topBar}>
          <h2 className={styles.topBarTitle}>{t("dashboard.title")}</h2>
        </header>
        <div className={styles.content}>
          <p className={styles.overview}>{t("dashboard.overview")}</p>

          {/* KPI cards — real size, false numbers */}
          <div className={styles.kpiGrid}>
            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span>{t("dashboard.totalEmployees")}</span>
                <IconUsers className={styles.kpiIcon} />
              </div>
              <p className={styles.kpiValue}>124</p>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span>{t("dashboard.totalCheckInToday")}</span>
                <IconLogin className={styles.kpiIcon} />
              </div>
              <p className={styles.kpiValue}>89</p>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span>{t("dashboard.totalCheckOutToday")}</span>
                <IconLogout className={styles.kpiIcon} />
              </div>
              <p className={styles.kpiValue}>72</p>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span>{t("dashboard.agentState")}</span>
                <IconGrid className={styles.kpiIcon} />
              </div>
              <p className={styles.kpiValue}>{t("dashboard.agentStateCheckIn")}</p>
            </div>
          </div>

          {/* Chart — same Entries/Exits area chart as real dashboard, with sample data */}
          <section className={styles.chartSection}>
            <EntriesExitsAreaChart
              title={t("dashboard.entriesExits")}
              entriesLabel={t("dashboard.checkIns")}
              exitsLabel={t("dashboard.checkOuts")}
              timeRange="daily"
              data={PREVIEW_CHART_DATA}
            />
          </section>

          {/* Tables — false data */}
          <div className={styles.tablesRow}>
            <section className={styles.tableCard}>
              <div className={styles.tableHeader}>
                <h3>{t("dashboard.latestAccessLogs")}</h3>
                <span className={styles.viewAll}>{t("dashboard.viewAll")}</span>
              </div>
              <div className={styles.table}>
                {PREVIEW_ACCESS_LOGS.map((row, i) => (
                  <div key={`access-${i}-${row.time}-${row.name}`} className={styles.tableRow}>
                    <span>{row.time}</span>
                    <span>{row.name}</span>
                    <span>{row.zone}</span>
                    <span className={row.action === "check-in" ? styles.badgeIn : styles.badgeOut}>
                      {row.action === "check-in" ? t("dashboard.agentStateCheckIn") : t("dashboard.agentStateCheckOut")}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <section className={styles.tableCard}>
              <div className={styles.tableHeader}>
                <h3>{t("dashboard.latestAuditLogs")}</h3>
                <span className={styles.viewAll}>{t("dashboard.viewAll")}</span>
              </div>
              <div className={styles.table}>
                {PREVIEW_AUDIT_LOGS.map((row, i) => (
                  <div key={`audit-${i}-${row.time}-${row.resource}`} className={styles.tableRow}>
                    <span>{row.time}</span>
                    <span>{row.user}</span>
                    <span>{row.action}</span>
                    <span>{row.resource}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
