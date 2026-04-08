"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { useAppConfig } from "@/core/hooks/useAppConfig";
import { logClientAudit } from "@/modules/audit-logs/api/logClientAudit";
import { saveFile } from "@/core/lib/saveFile";
import { exportPdf } from "@/core/lib/exportPdf";
import {
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconPlus,
  IconFileText,
} from "@/core/layout/icons";
import { Badge, Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import type { ReportRecipient, ReportRecipientStatus } from "@/modules/reports/types";
import type { ExportFormat, ExportDataType } from "@/modules/settings/types";
import styles from "./RecipientModal.module.css";
import exportModalStyles from "./ExportSettingsModal.module.css";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];
const MODAL_CLOSE_DURATION = 220;
const EXPORT_SETTINGS_STORAGE_KEY = "fms-report-export-settings";
const EXPORT_FORMATS: ExportFormat[] = ["pdf", "excel", "csv"];
const EXPORT_DATA_TYPES: ExportDataType[] = [
  "accessLogs",
  "employeeCheckIn",
  "peopleCount",
  "peopleType",
  "performance",
  "auditLogs",
  "zones",
  "shifts",
];

const DEFAULT_EXPORT_DATA_TYPES: Record<ExportDataType, boolean> = {
  accessLogs: true,
  employeeCheckIn: true,
  peopleCount: false,
  peopleType: false,
  performance: false,
  auditLogs: true,
  zones: false,
  shifts: false,
};

function loadStoredExportSettings(): {
  format: ExportFormat;
  dataTypes: Record<ExportDataType, boolean>;
  includeIndividualSummary: boolean;
  splitByModuleFiles: boolean;
} {
  if (typeof window === "undefined") {
    return {
      format: "excel",
      dataTypes: { ...DEFAULT_EXPORT_DATA_TYPES },
      includeIndividualSummary: true,
      splitByModuleFiles: false,
    };
  }
  try {
    const raw = localStorage.getItem(EXPORT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        format: "excel",
        dataTypes: { ...DEFAULT_EXPORT_DATA_TYPES },
        includeIndividualSummary: true,
        splitByModuleFiles: false,
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {
        format: "excel",
        dataTypes: { ...DEFAULT_EXPORT_DATA_TYPES },
        includeIndividualSummary: true,
        splitByModuleFiles: false,
      };
    }
    const p = parsed as Record<string, unknown>;
    const format = EXPORT_FORMATS.includes(p.format as ExportFormat) ? (p.format as ExportFormat) : "excel";
    const dataTypes = { ...DEFAULT_EXPORT_DATA_TYPES };
    if (p.dataTypes && typeof p.dataTypes === "object") {
      const dt = p.dataTypes as Record<string, unknown>;
      for (const key of EXPORT_DATA_TYPES) {
        if (typeof dt[key] === "boolean") dataTypes[key] = dt[key] as boolean;
      }
    }
    const includeIndividualSummary =
      typeof p.includeIndividualSummary === "boolean" ? p.includeIndividualSummary : true;
    const splitByModuleFiles = typeof p.splitByModuleFiles === "boolean" ? p.splitByModuleFiles : false;
    return { format, dataTypes, includeIndividualSummary, splitByModuleFiles };
  } catch {
    return {
      format: "excel",
      dataTypes: { ...DEFAULT_EXPORT_DATA_TYPES },
      includeIndividualSummary: true,
      splitByModuleFiles: false,
    };
  }
}

function saveStoredExportSettings(
  format: ExportFormat,
  dataTypes: Record<ExportDataType, boolean>,
  includeIndividualSummary: boolean,
  splitByModuleFiles: boolean
) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      EXPORT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ format, dataTypes, includeIndividualSummary, splitByModuleFiles })
    );
  } catch {
    // ignore
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function matchesSearch(recipient: ReportRecipient, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    recipient.name.toLowerCase().includes(q) ||
    recipient.email.toLowerCase().includes(q) ||
    recipient.addedBy.toLowerCase().includes(q)
  );
}

const API_RECIPIENTS = "/api/v1/report-recipients";

function isDuplicateEmail(
  email: string,
  recipients: ReportRecipient[],
  excludeId?: string
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return recipients.some(
    (r) => r.id !== excludeId && r.email.trim().toLowerCase() === normalized
  );
}

export default function ReportsPage() {
  const { t, i18n } = useTranslation();
  const { config } = useAppConfig();
  const [loading, setLoading] = useState(true);
  const [recipients, setRecipients] = useState<ReportRecipient[]>([]);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRecipient, setSelectedRecipient] = useState<ReportRecipient | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalClosing, setModalClosing] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", email: "", status: "active" as ReportRecipientStatus });
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addModalClosing, setAddModalClosing] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", email: "", status: "active" as ReportRecipientStatus });
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmClosing, setDeleteConfirmClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fetchRecipients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(API_RECIPIENTS);
      if (!res.ok) throw new Error("Failed to fetch recipients");
      const data = await res.json();
      setRecipients(Array.isArray(data) ? data : []);
    } catch {
      setRecipients([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecipients();
  }, [fetchRecipients]);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalClosing, setExportModalClosing] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(() => loadStoredExportSettings().format);
  const [exportDataTypes, setExportDataTypes] = useState<Record<ExportDataType, boolean>>(() =>
    loadStoredExportSettings().dataTypes
  );
  const [includeIndividualSummary, setIncludeIndividualSummary] = useState<boolean>(
    () => loadStoredExportSettings().includeIndividualSummary
  );
  const [splitByModuleFiles, setSplitByModuleFiles] = useState<boolean>(
    () => loadStoredExportSettings().splitByModuleFiles
  );
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [generateModalClosing, setGenerateModalClosing] = useState(false);
  const [generateDateFrom, setGenerateDateFrom] = useState("");
  const [generateDateTo, setGenerateDateTo] = useState("");
  const [exportingReport, setExportingReport] = useState(false);

  const filteredRecipients = useMemo(() => {
    return recipients.filter((r) => {
      if (!matchesSearch(r, searchQuery)) return false;
      const addedDate = r.addedAt.slice(0, 10);
      if (dateFrom && addedDate < dateFrom) return false;
      if (dateTo && addedDate > dateTo) return false;
      return true;
    });
  }, [recipients, searchQuery, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedRows = useMemo(
    () => filteredRecipients.slice(start, start + rowsPerPage),
    [filteredRecipients, start, rowsPerPage]
  );

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));

  const openModal = useCallback((recipient: ReportRecipient) => {
    setSelectedRecipient(recipient);
    setEditForm({ name: recipient.name, email: recipient.email, status: recipient.status });
    setIsEditMode(false);
    setModalOpen(true);
    setModalClosing(false);
  }, []);

  const closeModal = useCallback(() => {
    setModalClosing(true);
    const id = setTimeout(() => {
      setModalOpen(false);
      setSelectedRecipient(null);
      setIsEditMode(false);
      setModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const openAddModal = useCallback(() => {
    setAddForm({ name: "", email: "", status: "active" });
    setAddModalOpen(true);
    setAddModalClosing(false);
  }, []);

  const closeAddModal = useCallback(() => {
    setAddModalClosing(true);
    const id = setTimeout(() => {
      setAddModalOpen(false);
      setAddForm({ name: "", email: "", status: "active" });
      setAddModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const submitAddRecipient = useCallback(async () => {
    const name = addForm.name.trim() || addForm.email.trim() || t("reports.newRecipient");
    const email = addForm.email.trim();
    if (!email) return;
    if (isDuplicateEmail(email, recipients)) {
      toast.error(t("reports.duplicateEmail"));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(API_RECIPIENTS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          status: addForm.status,
          addedByName: t("reports.addedByYou"),
        }),
      });
      if (!res.ok) throw new Error("Failed to add recipient");
      await fetchRecipients();
      closeAddModal();
    } finally {
      setSaving(false);
    }
  }, [addForm, t, closeAddModal, fetchRecipients, recipients]);

  const startEdit = useCallback(() => {
    if (selectedRecipient) {
      setEditForm({
        name: selectedRecipient.name,
        email: selectedRecipient.email,
        status: selectedRecipient.status,
      });
      setIsEditMode(true);
    }
  }, [selectedRecipient]);

  const cancelEdit = useCallback(() => {
    if (selectedRecipient) {
      setEditForm({
        name: selectedRecipient.name,
        email: selectedRecipient.email,
        status: selectedRecipient.status,
      });
      setIsEditMode(false);
    }
  }, [selectedRecipient]);

  const saveEdit = useCallback(async () => {
    if (!selectedRecipient) return;
    const email = editForm.email.trim();
    if (isDuplicateEmail(email, recipients, selectedRecipient.id)) {
      toast.error(t("reports.duplicateEmail"));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`${API_RECIPIENTS}/${selectedRecipient.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          email,
          status: editForm.status,
        }),
      });
      if (!res.ok) throw new Error("Failed to update recipient");
      const updated = await res.json();
      setSelectedRecipient(updated);
      await fetchRecipients();
      setIsEditMode(false);
    } finally {
      setSaving(false);
    }
  }, [selectedRecipient, editForm, fetchRecipients, recipients, t]);

  const openDeleteConfirm = useCallback(() => {
    setDeleteConfirmOpen(true);
    setDeleteConfirmClosing(false);
  }, []);

  const closeDeleteConfirm = useCallback(() => {
    setDeleteConfirmClosing(true);
    const id = setTimeout(() => {
      setDeleteConfirmOpen(false);
      setDeleteConfirmClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const deleteRecipient = useCallback(async () => {
    if (!selectedRecipient) return;
    setSaving(true);
    try {
      const res = await apiFetch(`${API_RECIPIENTS}/${selectedRecipient.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete recipient");
      await fetchRecipients();
      closeDeleteConfirm();
      closeModal();
    } finally {
      setSaving(false);
    }
  }, [selectedRecipient, closeDeleteConfirm, closeModal, fetchRecipients]);

  useEffect(() => {
    if (!modalOpen || modalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, modalClosing, closeModal]);

  useEffect(() => {
    if (!addModalOpen || addModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAddModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addModalOpen, addModalClosing, closeAddModal]);

  useEffect(() => {
    if (!deleteConfirmOpen || deleteConfirmClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDeleteConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteConfirmOpen, deleteConfirmClosing, closeDeleteConfirm]);

  const openExportModal = useCallback(() => {
    setExportModalOpen(true);
    setExportModalClosing(false);
  }, []);

  const closeExportModal = useCallback(() => {
    setExportModalClosing(true);
    const id = setTimeout(() => {
      setExportModalOpen(false);
      setExportModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const applyExportSettings = useCallback(() => {
    saveStoredExportSettings(exportFormat, exportDataTypes, includeIndividualSummary, splitByModuleFiles);
    const dataTypesList = EXPORT_DATA_TYPES.filter((k) => exportDataTypes[k]).join(", ");
    logClientAudit({
      action: "export",
      resource: "report",
      descriptionKey: "auditLogs.descReportExport",
      descriptionParams: { format: exportFormat, dataTypes: dataTypesList },
      changes: {
        format: exportFormat,
        dataTypes: exportDataTypes,
        includeIndividualSummary,
        splitByModuleFiles,
      },
    });
    closeExportModal();
  }, [
    closeExportModal,
    exportFormat,
    exportDataTypes,
    includeIndividualSummary,
    splitByModuleFiles,
  ]);

  const toggleExportDataType = useCallback((key: ExportDataType) => {
    setExportDataTypes((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    if (!exportModalOpen || exportModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeExportModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportModalOpen, exportModalClosing, closeExportModal]);

  const hasAnyExportDataType = Object.values(exportDataTypes).some(Boolean);

  const openGenerateModal = useCallback(() => {
    setGenerateDateFrom(dateFrom);
    setGenerateDateTo(dateTo);
    setGenerateModalOpen(true);
    setGenerateModalClosing(false);
  }, [dateFrom, dateTo]);

  const closeGenerateModal = useCallback(() => {
    setGenerateModalClosing(true);
    const id = setTimeout(() => {
      setGenerateModalOpen(false);
      setGenerateModalClosing(false);
    }, MODAL_CLOSE_DURATION);
    return () => clearTimeout(id);
  }, []);

  const exportGeneratedReport = useCallback(async () => {
    const nextDateFrom = generateDateFrom;
    const nextDateTo = generateDateTo;
    const selectedDataTypesRaw = EXPORT_DATA_TYPES.filter((k) => exportDataTypes[k]);
    const selectedDataTypes: ExportDataType[] = selectedDataTypesRaw.includes("auditLogs")
      ? selectedDataTypesRaw
      : [...selectedDataTypesRaw, "auditLogs" as ExportDataType];
    if (selectedDataTypesRaw.length === 0) {
      toast.error(t("reports.noDataTypeSelected"));
      return;
    }

    const headers = [
      t("reports.exportColumnModule"),
      t("reports.exportColumnPrimary"),
      t("reports.exportColumnSecondary"),
      t("reports.exportColumnDetails"),
      t("reports.exportColumnStatus"),
      t("reports.exportColumnDate"),
    ];
    const exportRows: string[][] = [];
    const moduleRows: Record<ExportDataType, string[][]> = {
      accessLogs: [],
      employeeCheckIn: [],
      peopleCount: [],
      peopleType: [],
      performance: [],
      auditLogs: [],
      zones: [],
      shifts: [],
    };
    const sectionHeaders = {
      accessLogs: [
        t("reports.exportColumnPrimary"),
        t("reports.exportColumnSecondary"),
        t("reports.exportColumnDetails"),
        t("reports.exportColumnStatus"),
        t("reports.exportColumnDate"),
      ],
      auditLogs: [
        t("reports.exportColumnPrimary"),
        t("reports.exportColumnSecondary"),
        t("reports.exportColumnDetails"),
        t("reports.exportColumnStatus"),
        t("reports.exportColumnDate"),
      ],
      zones: [
        t("reports.exportColumnPrimary"),
        t("reports.exportColumnSecondary"),
        t("reports.exportColumnDetails"),
        t("reports.exportColumnStatus"),
        t("reports.exportColumnDate"),
      ],
      peopleType: [
        t("reports.exportColumnPrimary"),
        t("reports.exportColumnSecondary"),
        t("reports.exportColumnDetails"),
        t("reports.exportColumnStatus"),
        t("reports.exportColumnDate"),
      ],
      shifts: [
        t("reports.exportColumnPrimary"),
        t("reports.exportColumnSecondary"),
        t("reports.exportColumnDetails"),
        t("reports.exportColumnStatus"),
        t("reports.exportColumnDate"),
      ],
      peopleCount: [
        "Location / Zone",
        "Zones",
        "Current Count",
        "Total Entries",
        "Total Exits",
        "Last Updated",
      ],
    };
    const sectionRows: Record<string, string[][]> = {
      accessLogs: [],
      employeeCheckIn: [],
      peopleCount: [],
      peopleType: [],
      auditLogs: [],
      zones: [],
      shifts: [],
    };
    const summaryHeaders = [
      t("reports.summaryPerson"),
      t("reports.summaryPeopleType"),
      t("reports.summaryActivities"),
      t("reports.kpiCheckIns"),
      t("reports.kpiCheckOuts"),
      t("reports.kpiProductivity"),
    ];
    const personSummaryMap = new Map<
      string,
      { peopleType: string; activities: number; checkIns: number; checkOuts: number }
    >();
    const personTypeByName = new Map<string, string>();
    let totalAudits = 0;
    let totalPeople = 0;
    let totalSchedules = 0;
    let totalCheckIns = 0;
    let totalCheckOuts = 0;
    let totalOnTimeCheckIns = 0;
    const dailyStats = new Map<string, { checkIns: number; checkOuts: number }>();
    const failedDataTypes: string[] = [];
    const skippedDataTypes: string[] = [];

    const formatTimestamp = (value: string) => {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      const localeTag = i18n.language === "ar" ? "ar" : "en";
      return d.toLocaleString(localeTag);
    };
    const formatTimeOnly = (value?: string | null) => {
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    const formatAccessActivityType = (value?: string) => {
      if (!value) return "—";
      if (value === "check-in") return t("accessLogs.activityCheckIn");
      if (value === "check-out") return t("accessLogs.activityCheckOut");
      if (value === "tracking") return t("accessLogs.activityTracking");
      return value;
    };
    const formatAuditAction = (action?: string) => {
      if (!action) return "—";
      const normalized = action.toLowerCase().replace(/_/g, "");
      const key = `auditLogs.action${normalized.charAt(0).toUpperCase() + normalized.slice(1)}` as keyof typeof t;
      const translated = t(key);
      if (translated !== key) return translated;
      return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    };
    const formatDateTimeFromParts = (date?: string, time?: string) => {
      if (!date && !time) return "—";
      if (!date || !time) return date || time || "—";
      const d = new Date(`${date}T${time}`);
      if (Number.isNaN(d.getTime())) return `${date} ${time}`;
      const localeTag = i18n.language === "ar" ? "ar" : "en";
      return d.toLocaleString(localeTag, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };
    const sanitizeFilenamePart = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60) || "module";
    const organizationSlug = sanitizeFilenamePart(config.companyName || "organization");
    const escapeCsv = (value: string) => {
      const s = String(value ?? "");
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const buildSummaryRows = () =>
      Array.from(personSummaryMap.entries())
        .map(([name, stat]) => {
          const productivityScore =
            stat.activities > 0 ? Math.max(0, Math.min(100, ((stat.checkIns + stat.checkOuts) / stat.activities) * 50)) : 0;
          return [
            name,
            stat.peopleType || "—",
            String(stat.activities),
            String(stat.checkIns),
            String(stat.checkOuts),
            `${productivityScore.toFixed(1)}%`,
          ];
        })
        .sort((a, b) => a[0].localeCompare(b[0]));

    const dateQuery = new URLSearchParams();
    if (nextDateFrom) dateQuery.set("dateFrom", nextDateFrom);
    if (nextDateTo) dateQuery.set("dateTo", nextDateTo);

    const today = new Date().toISOString().slice(0, 10);
    const rangeLabel =
      nextDateFrom && nextDateTo
        ? `${nextDateFrom}_to_${nextDateTo}`
        : nextDateFrom
        ? `${nextDateFrom}_to_${today}`
        : nextDateTo
        ? `until_${nextDateTo}`
        : today;

    setExportingReport(true);
    try {
      for (const dataType of selectedDataTypes) {
        const moduleLabel = t(`settings.dataType.${dataType}`);
        try {
          if (dataType === "performance") {
            skippedDataTypes.push(moduleLabel);
            continue;
          }

          if (dataType === "accessLogs" || dataType === "employeeCheckIn") {
            const res = await apiFetch(`/api/v1/access-logs${dateQuery.toString() ? `?${dateQuery.toString()}` : ""}`);
            if (!res.ok) throw new Error(`Failed to fetch ${dataType}`);
            const rows = (await res.json()) as Array<{
              employeeName?: string;
              personType?: string;
              activityType?: string;
              zone?: string;
              date?: string;
              time?: string;
              note?: string;
            }>;
            const filtered = dataType === "employeeCheckIn"
              ? rows.filter((entry) => entry.activityType === "check-in")
              : rows;
            const countForSummary = dataType === "accessLogs" || !selectedDataTypes.includes("accessLogs");
            const uniquePeople = new Set<string>();
            for (const row of filtered) {
              const statDate = row.date || "";
              const stats = dailyStats.get(statDate) || { checkIns: 0, checkOuts: 0 };
              if (row.activityType === "check-in") {
                stats.checkIns += 1;
                totalCheckIns += 1;
                if (row.time && row.time <= "10:00") totalOnTimeCheckIns += 1;
              }
              if (row.activityType === "check-out") {
                stats.checkOuts += 1;
                totalCheckOuts += 1;
              }
              dailyStats.set(statDate, stats);
              if (row.employeeName) uniquePeople.add(row.employeeName);
              const cleanRow = [
                row.employeeName || "—",
                row.zone || "—",
                dataType === "employeeCheckIn" ? t("accessLogs.activityCheckIn") : formatAccessActivityType(row.activityType),
                row.note || "—",
                formatDateTimeFromParts(row.date, row.time),
              ];
              if (countForSummary) {
                const personKey = row.employeeName || "—";
                const detectedPeopleType =
                  row.personType ||
                  personTypeByName.get(personKey) ||
                  "—";
                if (row.personType && !personTypeByName.has(personKey)) {
                  personTypeByName.set(personKey, row.personType);
                }
                const personStat = personSummaryMap.get(personKey) || {
                  peopleType: detectedPeopleType,
                  activities: 0,
                  checkIns: 0,
                  checkOuts: 0,
                };
                if (personStat.peopleType === "—" && detectedPeopleType !== "—") {
                  personStat.peopleType = detectedPeopleType;
                }
                personStat.activities += 1;
                if (row.activityType === "check-in") personStat.checkIns += 1;
                if (row.activityType === "check-out") personStat.checkOuts += 1;
                personSummaryMap.set(personKey, personStat);
              }
              sectionRows[dataType].push(cleanRow);
              moduleRows[dataType].push(cleanRow);
              exportRows.push([
                moduleLabel,
                ...cleanRow,
              ]);
            }
            totalPeople = Math.max(totalPeople, uniquePeople.size);
            continue;
          }

          if (dataType === "peopleType") {
            const res = await apiFetch("/api/v1/person-types");
            if (!res.ok) throw new Error("Failed to fetch person types");
            const personTypes = (await res.json()) as Array<{
              id?: string;
              name?: string;
              description?: string;
              status?: string;
              createdAt?: string;
            }>;

            for (const type of personTypes) {
              const cleanRow = [
                type.name || "—",
                type.id || "—",
                type.description || "—",
                type.status || "—",
                type.createdAt ? formatTimestamp(type.createdAt) : "—",
              ];
              sectionRows.peopleType.push(cleanRow);
              moduleRows.peopleType.push(cleanRow);
              exportRows.push([moduleLabel, ...cleanRow]);
            }
            continue;
          }

          if (dataType === "peopleCount") {
            const today = new Date().toISOString().slice(0, 10);
            const startDateStr = nextDateFrom || nextDateTo || today;
            const endDateStr = nextDateTo || nextDateFrom || today;
            const startDate = new Date(`${startDateStr}T00:00:00`);
            const endDate = new Date(`${endDateStr}T00:00:00`);
            const dateCursor = startDate <= endDate ? new Date(startDate) : new Date(endDate);
            const dateEnd = startDate <= endDate ? endDate : startDate;
            const targetDates: string[] = [];
            while (dateCursor <= dateEnd) {
              targetDates.push(dateCursor.toISOString().slice(0, 10));
              dateCursor.setDate(dateCursor.getDate() + 1);
            }

            let peopleCountFetchError = false;
            let peopleCountRows = 0;
            for (const targetDate of targetDates) {
              const params = new URLSearchParams({
                date: targetDate,
                timeFrom: "00:00",
                timeTo: "23:59",
              });
              const res = await apiFetch(`/api/v1/people-count/table?${params.toString()}`);
              if (!res.ok) {
                peopleCountFetchError = true;
                continue;
              }

              type PeopleCountPayload = {
                rows?: Array<{
                  locationName?: string;
                  zonesCount?: number;
                  currentCount?: number;
                  totalEntries?: number;
                  totalExits?: number;
                  lastUpdated?: string | null;
                  zones?: Array<{
                    zoneName?: string;
                    currentCount?: number;
                    totalEntries?: number;
                    totalExits?: number;
                    lastUpdated?: string | null;
                  }>;
                }>;
              };
              let payload: PeopleCountPayload | null = null;

              try {
                payload = (await res.json()) as PeopleCountPayload;
              } catch {
                peopleCountFetchError = true;
                continue;
              }
              if (!payload) continue;

              for (const row of payload.rows ?? []) {
                peopleCountRows += 1;
                const locationLabel = row.locationName || "—";
                const locationHasZones = (row.zones ?? []).length > 0;
                const locationDisplayLabel = `${locationHasZones ? "▼" : "▶"} ${locationLabel}`;
                const locationZones = String(row.zonesCount ?? 0);
                const locationCurrent = String(row.currentCount ?? 0);
                const locationEntries = String(row.totalEntries ?? 0);
                const locationExits = String(row.totalExits ?? 0);
                const locationLastUpdated = formatTimeOnly(row.lastUpdated);

                // PDF section + split-export CSV must match the People Count page table format.
                const locationSectionRow = [
                  locationDisplayLabel,
                  `${locationZones} zones`,
                  locationCurrent,
                  locationEntries,
                  locationExits,
                  locationLastUpdated,
                ];

                // Generic export table columns (used for non-split CSV / fallback table).
                const locationExportRow = [
                  locationDisplayLabel,
                  `${locationZones} zones`,
                  `Current: ${locationCurrent} | Entries: ${locationEntries} | Exits: ${locationExits}`,
                  "Location",
                  locationLastUpdated,
                ];

                sectionRows.peopleCount.push(locationSectionRow);
                moduleRows.peopleCount.push(locationSectionRow);
                exportRows.push([moduleLabel, ...locationExportRow]);

                for (const zone of row.zones ?? []) {
                  peopleCountRows += 1;
                  const zoneLabel = zone.zoneName ? `↳ ${zone.zoneName}` : "↳ —";
                  const zoneCurrent = String(zone.currentCount ?? 0);
                  const zoneEntries = String(zone.totalEntries ?? 0);
                  const zoneExits = String(zone.totalExits ?? 0);
                  const zoneLastUpdated = formatTimeOnly(zone.lastUpdated);

                  const zoneSectionRow = [
                    zoneLabel,
                    "-",
                    zoneCurrent,
                    zoneEntries,
                    zoneExits,
                    zoneLastUpdated,
                  ];

                  const zoneExportRow = [
                    zoneLabel,
                    "-",
                    `Current: ${zoneCurrent} | Entries: ${zoneEntries} | Exits: ${zoneExits}`,
                    "Zone",
                    zoneLastUpdated,
                  ];

                  sectionRows.peopleCount.push(zoneSectionRow);
                  moduleRows.peopleCount.push(zoneSectionRow);
                  exportRows.push([moduleLabel, ...zoneExportRow]);
                }
              }
            }

            if (peopleCountRows === 0 || peopleCountFetchError) {
              const noDataMessage = "No data available for selected date range.";

              const noDataSectionRow = [
                t("settings.dataType.peopleCount"),
                "-",
                "-",
                "-",
                "-",
                "-",
              ];
              const noDataExportRow = [
                t("settings.dataType.peopleCount"),
                "-",
                noDataMessage,
                "Info",
                "-",
              ];

              sectionRows.peopleCount.push(noDataSectionRow);
              moduleRows.peopleCount.push(noDataSectionRow);
              exportRows.push([moduleLabel, ...noDataExportRow]);
            }
            continue;
          }

          if (dataType === "auditLogs") {
            const params = new URLSearchParams();
            params.set("limit", "50000");
            if (nextDateFrom) params.set("dateFrom", nextDateFrom);
            if (nextDateTo) params.set("dateTo", nextDateTo);
            const res = await apiFetch(`/api/v1/audit-logs?${params.toString()}`);
            if (!res.ok) throw new Error("Failed to fetch audit logs");
            const payload = (await res.json()) as {
              items?: Array<{
                actorName?: string | null;
                action?: string;
                resource?: string;
                description?: string | null;
                timestamp?: string;
              }>;
            };
            totalAudits += (payload.items ?? []).length;
            for (const item of payload.items ?? []) {
              const cleanRow = [
                item.actorName || t("auditLogs.unknownUser"),
                item.resource || "—",
                item.description || "—",
                formatAuditAction(item.action),
                item.timestamp ? formatTimestamp(item.timestamp) : "—",
              ];
              sectionRows.auditLogs.push(cleanRow);
              moduleRows.auditLogs.push(cleanRow);
              exportRows.push([
                moduleLabel,
                ...cleanRow,
              ]);
            }
            continue;
          }

          if (dataType === "zones") {
            const res = await apiFetch("/api/v1/zones");
            if (!res.ok) throw new Error("Failed to fetch zones");
            const zones = (await res.json()) as Array<{
              name?: string;
              assignedPeople?: number;
              assignedSchedules?: number;
              status?: string;
              dateCreated?: string;
            }>;
            for (const zone of zones) {
              const cleanRow = [
                zone.name || "—",
                `${t("reports.assignedPeople")}: ${String(zone.assignedPeople ?? 0)}`,
                `${t("reports.assignedSchedules")}: ${String(zone.assignedSchedules ?? 0)}`,
                zone.status || "—",
                zone.dateCreated || "—",
              ];
              sectionRows.zones.push(cleanRow);
              moduleRows.zones.push(cleanRow);
              exportRows.push([
                moduleLabel,
                ...cleanRow,
              ]);
            }
            continue;
          }

          if (dataType === "shifts") {
            const res = await apiFetch("/api/v1/schedules");
            if (!res.ok) throw new Error("Failed to fetch schedules");
            const shifts = (await res.json()) as Array<{
              name?: string;
              personType?: string;
              assignedPeople?: number;
              status?: string;
              createdAt?: string;
            }>;
            totalSchedules = Math.max(totalSchedules, shifts.length);
            for (const shift of shifts) {
              const cleanRow = [
                shift.name || "—",
                shift.personType || "—",
                `${t("reports.assignedPeople")}: ${String(shift.assignedPeople ?? 0)}`,
                shift.status || "—",
                shift.createdAt ? formatTimestamp(shift.createdAt) : "—",
              ];
              sectionRows.shifts.push(cleanRow);
              moduleRows.shifts.push(cleanRow);
              exportRows.push([
                moduleLabel,
                ...cleanRow,
              ]);
            }
            continue;
          }
        } catch {
          failedDataTypes.push(moduleLabel);
        }
      }

      if (exportRows.length === 0) {
        toast.error(t("reports.noExportData"));
        return;
      }

      const summaryRows = includeIndividualSummary ? buildSummaryRows() : [];
      const splitExport = splitByModuleFiles && selectedDataTypes.length > 1;

      if (splitExport) {
        if (includeIndividualSummary && summaryRows.length > 0) {
          const summaryFilenameBase = `report_${sanitizeFilenamePart(t("reports.individualSummarySectionTitle"))}_${rangeLabel}`;
          if (exportFormat === "pdf") {
            await exportPdf({
              title: t("nav.reports"),
              description: t("reports.exportDescription", {
                modules: t("reports.individualSummarySectionTitle"),
                dateFrom: nextDateFrom || "—",
                dateTo: nextDateTo || "—",
              }),
              headers: summaryHeaders,
              rows: summaryRows,
              sections: [
                {
                  title: t("reports.individualSummarySectionTitle"),
                  headers: summaryHeaders,
                  rows: summaryRows,
                },
              ],
              filename: summaryFilenameBase,
              locale: i18n.language === "ar" ? "ar" : "en",
              origin: typeof window !== "undefined" ? window.location.origin : "",
            });
          } else {
            const csvContent = [
              summaryHeaders.map(escapeCsv).join(","),
              ...summaryRows.map((r) => r.map(escapeCsv).join(",")),
            ].join("\r\n");
            const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
            const ext = exportFormat === "excel" ? "xlsx" : "csv";
            await saveFile(blob, `${summaryFilenameBase}.${ext}`);
          }
        }

        for (const dataType of selectedDataTypes) {
          const rows = moduleRows[dataType];
          if (!rows || rows.length === 0) continue;
          const moduleLabel = t(`settings.dataType.${dataType}`);
          const moduleFilenameBase = `report_${sanitizeFilenamePart(moduleLabel)}_${rangeLabel}`;
          if (exportFormat === "pdf") {
            const moduleSections: Array<{ title: string; headers: string[]; rows: string[][] }> = [
              {
                title: moduleLabel,
                headers:
                  dataType === "auditLogs"
                    ? sectionHeaders.auditLogs
                    : dataType === "peopleCount"
                      ? sectionHeaders.peopleCount
                    : dataType === "peopleType"
                      ? sectionHeaders.peopleType
                    : dataType === "zones"
                      ? sectionHeaders.zones
                      : dataType === "shifts"
                        ? sectionHeaders.shifts
                        : sectionHeaders.accessLogs,
                rows,
              },
            ];
            if (sectionRows.auditLogs.length > 0 && dataType !== "auditLogs") {
              moduleSections.push({
                title: t("settings.dataType.auditLogs"),
                headers: sectionHeaders.auditLogs,
                rows: sectionRows.auditLogs,
              });
            }
            await exportPdf({
              title: t("nav.reports"),
              description: t("reports.exportDescription", {
                modules: moduleLabel,
                dateFrom: nextDateFrom || "—",
                dateTo: nextDateTo || "—",
              }),
              headers,
              rows: exportRows,
              sections: moduleSections,
              filename: moduleFilenameBase,
              locale: i18n.language === "ar" ? "ar" : "en",
              origin: typeof window !== "undefined" ? window.location.origin : "",
            });
          } else {
            const moduleHeaders =
              dataType === "peopleCount"
                ? ["Location / Zone", "Zones", "Current Count", "Total Entries", "Total Exits", "Last Updated"]
                : [
                    t("reports.exportColumnPrimary"),
                    t("reports.exportColumnSecondary"),
                    t("reports.exportColumnDetails"),
                    t("reports.exportColumnStatus"),
                    t("reports.exportColumnDate"),
                  ];
            const csvLines: string[] = [];
            csvLines.push(moduleHeaders.map(escapeCsv).join(","));
            csvLines.push(...rows.map((r) => r.map(escapeCsv).join(",")));
            if (sectionRows.auditLogs.length > 0 && dataType !== "auditLogs") {
              csvLines.push("");
              csvLines.push([t("settings.dataType.auditLogs")].map(escapeCsv).join(","));
              csvLines.push(sectionHeaders.auditLogs.map(escapeCsv).join(","));
              csvLines.push(...sectionRows.auditLogs.map((r) => r.map(escapeCsv).join(",")));
            }
            const csvContent = csvLines.join("\r\n");
            const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
            const ext = exportFormat === "excel" ? "xlsx" : "csv";
            await saveFile(blob, `${moduleFilenameBase}.${ext}`);
          }
        }
      } else if (exportFormat === "pdf") {
        const attendanceScore = totalCheckIns > 0 ? totalOnTimeCheckIns / totalCheckIns : 0;
        const completionScore = totalCheckIns > 0 ? Math.min(1, totalCheckOuts / totalCheckIns) : 0;
        const scheduleScore = totalSchedules > 0 ? 1 : 0;
        const productivity = (0.5 * attendanceScore + 0.3 * completionScore + 0.2 * scheduleScore) * 100;
        const productivitySeries = Array.from(dailyStats.entries())
          .filter(([date]) => !!date)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-14)
          .map(([date, s]) => {
            const daily = s.checkIns > 0 ? ((s.checkOuts / s.checkIns) * 100) : 0;
            return { label: date.slice(5), value: Math.max(0, Math.min(100, daily)) };
          });
        const sections = [
          includeIndividualSummary && summaryRows.length > 0
            ? { title: t("reports.individualSummarySectionTitle"), headers: summaryHeaders, rows: summaryRows }
            : null,
          selectedDataTypes.includes("accessLogs") && sectionRows.accessLogs.length > 0
            ? { title: t("settings.dataType.accessLogs"), headers: sectionHeaders.accessLogs, rows: sectionRows.accessLogs }
            : null,
          selectedDataTypes.includes("employeeCheckIn") && sectionRows.employeeCheckIn.length > 0
            ? { title: t("settings.dataType.employeeCheckIn"), headers: sectionHeaders.accessLogs, rows: sectionRows.employeeCheckIn }
            : null,
          selectedDataTypes.includes("peopleType") && sectionRows.peopleType.length > 0
            ? { title: t("settings.dataType.peopleType"), headers: sectionHeaders.peopleType, rows: sectionRows.peopleType }
            : null,
          selectedDataTypes.includes("peopleCount") && sectionRows.peopleCount.length > 0
            ? { title: t("settings.dataType.peopleCount"), headers: sectionHeaders.peopleCount, rows: sectionRows.peopleCount }
            : null,
          selectedDataTypes.includes("auditLogs") && sectionRows.auditLogs.length > 0
            ? { title: t("settings.dataType.auditLogs"), headers: sectionHeaders.auditLogs, rows: sectionRows.auditLogs }
            : null,
          selectedDataTypes.includes("zones") && sectionRows.zones.length > 0
            ? { title: t("settings.dataType.zones"), headers: sectionHeaders.zones, rows: sectionRows.zones }
            : null,
          selectedDataTypes.includes("shifts") && sectionRows.shifts.length > 0
            ? { title: t("settings.dataType.shifts"), headers: sectionHeaders.shifts, rows: sectionRows.shifts }
            : null,
        ].filter(Boolean) as Array<{ title: string; headers: string[]; rows: string[][] }>;
        await exportPdf({
          title: t("nav.reports"),
          description: t("reports.exportDescription", {
            modules: selectedDataTypes.map((type) => t(`settings.dataType.${type}`)).join(", "),
            dateFrom: nextDateFrom || "—",
            dateTo: nextDateTo || "—",
          }),
          headers,
          rows: exportRows,
          summaryCards: [
            { label: t("reports.kpiTotalAudits"), value: String(totalAudits) },
            { label: t("reports.kpiTotalPeople"), value: String(totalPeople) },
            { label: t("reports.kpiTotalSchedules"), value: String(totalSchedules) },
            { label: t("reports.kpiCheckIns"), value: String(totalCheckIns) },
            { label: t("reports.kpiCheckOuts"), value: String(totalCheckOuts) },
            { label: t("reports.kpiProductivity"), value: `${productivity.toFixed(1)}%` },
          ],
          productivity: {
            score: productivity,
            definition: t("reports.productivityDefinition"),
            series: productivitySeries,
          },
          sections,
          filename: `${organizationSlug}_report_${sanitizeFilenamePart(
            selectedDataTypes.map((type) => t(`settings.dataType.${type}`)).join("_")
          )}_${rangeLabel}`,
          locale: i18n.language === "ar" ? "ar" : "en",
          origin: typeof window !== "undefined" ? window.location.origin : "",
        });
      } else {
        const csvLines: string[] = [];
        if (includeIndividualSummary && summaryRows.length > 0) {
          csvLines.push([t("reports.individualSummarySectionTitle")].map(escapeCsv).join(","));
          csvLines.push(summaryHeaders.map(escapeCsv).join(","));
          csvLines.push(...summaryRows.map((r) => r.map(escapeCsv).join(",")));
          csvLines.push("");
        }
        csvLines.push(headers.map(escapeCsv).join(","));
        csvLines.push(...exportRows.map((row) => row.map(escapeCsv).join(",")));
        const csvContent = csvLines.join("\r\n");
        const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
        const ext = exportFormat === "excel" ? "xlsx" : "csv";
        await saveFile(
          blob,
          `${organizationSlug}_report_${sanitizeFilenamePart(
            selectedDataTypes.map((type) => t(`settings.dataType.${type}`)).join("_")
          )}_${rangeLabel}.${ext}`
        );
      }

      toast.success(t("reports.exportSuccess"));

      if (skippedDataTypes.length > 0) {
        toast.warning(t("reports.partialExportSkipped", { modules: skippedDataTypes.join(", ") }));
      }
      if (failedDataTypes.length > 0) {
        toast.warning(t("reports.partialExportFailed", { modules: failedDataTypes.join(", ") }));
      }

      logClientAudit({
        action: "export",
        resource: "report",
        descriptionKey: "auditLogs.descReportExport",
        descriptionParams: {
          format: exportFormat,
          dateFrom: nextDateFrom,
          dateTo: nextDateTo,
          dataTypes: selectedDataTypes.join(", "),
        },
        changes: {
          dateFrom: nextDateFrom,
          dateTo: nextDateTo,
          format: exportFormat,
          dataTypes: selectedDataTypes,
          includeIndividualSummary,
          splitByModuleFiles,
          exportedRows: exportRows.length,
          failedDataTypes,
          skippedDataTypes,
        },
      });
      setDateFrom(nextDateFrom);
      setDateTo(nextDateTo);
      setPage(1);
      closeGenerateModal();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("reports.downloadError");
      toast.error(errorMessage || t("reports.downloadError"));
    } finally {
      setExportingReport(false);
    }
  }, [
    generateDateFrom,
    generateDateTo,
    exportDataTypes,
    includeIndividualSummary,
    splitByModuleFiles,
    t,
    exportFormat,
    i18n.language,
    config.companyName,
    closeGenerateModal,
  ]);

  const applyGenerate = useCallback(() => {
    logClientAudit({
      action: "generate",
      resource: "report",
      descriptionKey: "auditLogs.descReportGenerate",
      descriptionParams: { dateFrom: generateDateFrom, dateTo: generateDateTo },
      changes: { dateFrom: generateDateFrom, dateTo: generateDateTo },
    });
    setDateFrom(generateDateFrom);
    setDateTo(generateDateTo);
    setPage(1);
    closeGenerateModal();
  }, [generateDateFrom, generateDateTo, closeGenerateModal]);

  useEffect(() => {
    if (!generateModalOpen || generateModalClosing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeGenerateModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [generateModalOpen, generateModalClosing, closeGenerateModal]);

  const getStatusVariant = (status: ReportRecipient["status"]) => {
    return status === "active" ? "success" : "danger";
  };

  return (
    <DashboardLayout title={t("nav.reports")}>
      <div className="w-full max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">
            {t("reports.pageDescription")}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={openGenerateModal}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold border border-fms-border text-fms-text bg-fms-surface hover:bg-fms-bg-subtle shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
              aria-label={t("reports.instantGenerate")}
            >
              {t("reports.instantGenerate")}
            </button>
            <button
              type="button"
              onClick={openExportModal}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold border border-fms-border text-fms-text bg-fms-surface hover:bg-fms-bg-subtle shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
              aria-label={t("reports.exportSettings")}
            >
              {t("reports.exportSettings")}
            </button>
            <button
              type="button"
              onClick={openAddModal}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
              aria-label={t("reports.addRecipient")}
            >
              <IconPlus className="w-5 h-5" aria-hidden />
              {t("reports.addRecipient")}
            </button>
          </div>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 border-b border-fms-border bg-fms-bg-subtle/20">
            <div className="relative flex-1 max-w-sm">
              <IconSearch
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fms-text-tertiary pointer-events-none"
                aria-hidden
              />
              <input
                type="search"
                placeholder={t("reports.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="w-full pl-9 pr-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent transition-shadow"
                aria-label={t("reports.searchPlaceholder")}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={5} showCheckbox={false} />
            ) : paginatedRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
                <div className="rounded-2xl bg-fms-bg-subtle p-4 mb-4 text-fms-text-tertiary">
                  <IconFileText className="w-10 h-10" aria-hidden />
                </div>
                <p className="text-sm text-fms-text-secondary m-0">
                  {t("reports.noResults")}
                </p>
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("reports.recipientName")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("reports.recipientEmail")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("reports.addedBy")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("reports.addedAt")}
                    </th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">
                      {t("reports.status")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row) => (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openModal(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openModal(row);
                        }
                      }}
                      className="border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors cursor-pointer"
                      aria-label={t("reports.viewRecipient")}
                    >
                      <td className="py-3.5 px-4 font-medium text-fms-text">
                        {row.name}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">
                        {row.email}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">
                        {row.addedBy}
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">
                        {formatDate(row.addedAt)}
                      </td>
                      <td className="py-3.5 px-4">
                        <Badge variant={getStatusVariant(row.status)}>
                          {row.status === "active" ? t("reports.active") : t("reports.inactive")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filteredRecipients.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border bg-fms-bg-subtle/20">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">{t("reports.rowsPerPage")}</label>
                  <Select
                    value={rowsPerPage}
                    onChange={(e) => {
                      setRowsPerPage(Number(e.target.value));
                      setPage(1);
                    }}
                    selectSize="sm"
                    className="min-w-[72px]"
                    aria-label={t("reports.rowsPerPage")}
                  >
                    {ROWS_PER_PAGE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="text-sm text-fms-text-secondary">
                  {t("reports.pageOf", { current: page, total: totalPages })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  <IconChevronLeft className="w-4 h-4" />
                  {t("reports.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("reports.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>

        {modalOpen && selectedRecipient && (
          <div
            className={styles.overlay}
            data-closing={modalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="recipient-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeModal()}
          >
            <div
              className={styles.modal}
              data-closing={modalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeModal}
                  aria-label={t("reports.close")}
                >
                  ×
                </button>
                <h2 id="recipient-modal-title" className={styles.title}>
                  {isEditMode ? t("reports.modalTitleEdit") : t("reports.modalTitleView")}
                </h2>

                {isEditMode ? (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="recipient-name">
                        {t("reports.recipientName")}
                      </label>
                      <input
                        id="recipient-name"
                        type="text"
                        className={styles.input}
                        value={editForm.name}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="recipient-email">
                        {t("reports.recipientEmail")}
                      </label>
                      <input
                        id="recipient-email"
                        type="email"
                        className={styles.input}
                        value={editForm.email}
                        onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.status")}</span>
                      <div className={styles.toggleGroup} role="group" aria-label={t("reports.status")}>
                        <button
                          type="button"
                          className={styles.toggleBtn}
                          data-active={editForm.status === "active" ? "true" : undefined}
                          onClick={() => setEditForm((f) => ({ ...f, status: "active" }))}
                        >
                          {t("reports.active")}
                        </button>
                        <button
                          type="button"
                          className={styles.toggleBtn}
                          data-active={editForm.status === "inactive" ? "true" : undefined}
                          onClick={() => setEditForm((f) => ({ ...f, status: "inactive" }))}
                        >
                          {t("reports.inactive")}
                        </button>
                      </div>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.addedBy")}</span>
                      <span className={styles.value}>{selectedRecipient.addedBy}</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.addedAt")}</span>
                      <span className={styles.value}>{formatDate(selectedRecipient.addedAt)}</span>
                    </div>
                    <div className={styles.actions}>
                      <button type="button" className={styles.btnSecondary} onClick={cancelEdit} disabled={saving}>
                        {t("reports.cancel")}
                      </button>
                      <button type="button" className={styles.btnPrimary} onClick={saveEdit} disabled={saving}>
                        {saving ? t("reports.saving") : t("reports.save")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.recipientName")}</span>
                      <span className={styles.value}>{selectedRecipient.name}</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.recipientEmail")}</span>
                      <span className={styles.value}>{selectedRecipient.email}</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.addedBy")}</span>
                      <span className={styles.value}>{selectedRecipient.addedBy}</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.addedAt")}</span>
                      <span className={styles.value}>{formatDate(selectedRecipient.addedAt)}</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>{t("reports.status")}</span>
                      <span className={styles.value}>
                        <Badge variant={getStatusVariant(selectedRecipient.status)}>
                          {selectedRecipient.status === "active" ? t("reports.active") : t("reports.inactive")}
                        </Badge>
                      </span>
                    </div>
                    <div className={styles.viewActions}>
                      <button type="button" className={styles.btnDanger} onClick={openDeleteConfirm}>
                        {t("reports.deleteRecipient")}
                      </button>
                      <button type="button" className={styles.btnPrimary} onClick={startEdit}>
                        {t("reports.editRecipient")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {deleteConfirmOpen && selectedRecipient && (
          <div
            className={styles.overlay}
            data-closing={deleteConfirmClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeDeleteConfirm()}
          >
            <div
              className={styles.modal}
              data-closing={deleteConfirmClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeDeleteConfirm}
                  aria-label={t("reports.close")}
                >
                  ×
                </button>
                <h2 id="delete-confirm-modal-title" className={styles.title}>
                  {t("reports.confirmDeleteTitle")}
                </h2>
                <p className={styles.deleteConfirmMessage}>
                  {t("reports.confirmDeleteMessage", { email: selectedRecipient.email })}
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={closeDeleteConfirm}
                    disabled={saving}
                  >
                    {t("reports.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnDanger}
                    onClick={deleteRecipient}
                    disabled={saving}
                  >
                    {saving ? t("reports.saving") : t("reports.deleteRecipient")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {addModalOpen && (
          <div
            className={styles.overlay}
            data-closing={addModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-recipient-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeAddModal()}
          >
            <div
              className={styles.modal}
              data-closing={addModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalInner}>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={closeAddModal}
                  aria-label={t("reports.close")}
                >
                  ×
                </button>
                <h2 id="add-recipient-modal-title" className={styles.title}>
                  {t("reports.modalTitleAdd")}
                </h2>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="add-recipient-name">
                    {t("reports.recipientName")}
                  </label>
                  <input
                    id="add-recipient-name"
                    type="text"
                    className={styles.input}
                    placeholder={t("reports.recipientNamePlaceholder")}
                    value={addForm.name}
                    onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="add-recipient-email">
                    {t("reports.recipientEmail")}
                  </label>
                  <input
                    id="add-recipient-email"
                    type="email"
                    className={styles.input}
                    placeholder={t("reports.recipientEmailPlaceholder")}
                    value={addForm.email}
                    onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>{t("reports.status")}</span>
                  <div className={styles.toggleGroup} role="group" aria-label={t("reports.status")}>
                    <button
                      type="button"
                      className={styles.toggleBtn}
                      data-active={addForm.status === "active" ? "true" : undefined}
                      onClick={() => setAddForm((f) => ({ ...f, status: "active" }))}
                    >
                      {t("reports.active")}
                    </button>
                    <button
                      type="button"
                      className={styles.toggleBtn}
                      data-active={addForm.status === "inactive" ? "true" : undefined}
                      onClick={() => setAddForm((f) => ({ ...f, status: "inactive" }))}
                    >
                      {t("reports.inactive")}
                    </button>
                  </div>
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.btnSecondary} onClick={closeAddModal} disabled={saving}>
                    {t("reports.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={submitAddRecipient}
                    disabled={!addForm.email.trim() || saving}
                  >
                    {saving ? t("reports.saving") : t("reports.addRecipient")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {exportModalOpen && (
          <div
            className={exportModalStyles.overlay}
            data-closing={exportModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-settings-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeExportModal()}
          >
            <div
              className={exportModalStyles.modal}
              data-closing={exportModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={exportModalStyles.modalInner}>
                <button
                  type="button"
                  className={exportModalStyles.closeBtn}
                  onClick={closeExportModal}
                  aria-label={t("settings.close")}
                >
                  ×
                </button>
                <h2 id="export-settings-modal-title" className={exportModalStyles.title}>
                  {t("settings.exportSettingsModalTitle")}
                </h2>
                <div className={exportModalStyles.section}>
                  <span className={exportModalStyles.sectionLabel}>
                    {t("settings.fileFormat")}
                  </span>
                  <p className={exportModalStyles.sectionHint}>
                    {t("settings.fileFormatHint")}
                  </p>
                  <div className={exportModalStyles.formatOptions}>
                    {EXPORT_FORMATS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        role="radio"
                        aria-checked={exportFormat === f}
                        data-selected={exportFormat === f ? "true" : undefined}
                        className={exportModalStyles.formatOption}
                        onClick={() => setExportFormat(f)}
                      >
                        {t(`settings.format${f.charAt(0).toUpperCase() + f.slice(1)}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={exportModalStyles.section}>
                  <span className={exportModalStyles.sectionLabel}>
                    {t("settings.dataToExport")}
                  </span>
                  <p className={exportModalStyles.sectionHint}>
                    {t("settings.dataToExportHint")}
                  </p>
                  <div className={exportModalStyles.checkboxGroup}>
                    {EXPORT_DATA_TYPES.map((key) => {
                      const inputId = `report-export-type-${key}`;
                      return (
                        <label key={key} className={exportModalStyles.checkboxRow} htmlFor={inputId}>
                          <input
                            id={inputId}
                            type="checkbox"
                            className={exportModalStyles.checkbox}
                            checked={exportDataTypes[key]}
                            onChange={(e) =>
                              setExportDataTypes((prev) => ({
                                ...prev,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                          <span className={exportModalStyles.checkboxLabel}>
                            {t(`settings.dataType.${key}`)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className={exportModalStyles.section}>
                  <span className={exportModalStyles.sectionLabel}>
                    {t("reports.exportAdvancedTitle")}
                  </span>
                  <p className={exportModalStyles.sectionHint}>
                    {t("reports.exportAdvancedHint")}
                  </p>
                  <div className={exportModalStyles.checkboxGroup}>
                    <label className={exportModalStyles.checkboxRow} htmlFor="report-export-individual-summary">
                      <input
                        id="report-export-individual-summary"
                        type="checkbox"
                        className={exportModalStyles.checkbox}
                        checked={includeIndividualSummary}
                        onChange={(e) => setIncludeIndividualSummary(e.target.checked)}
                      />
                      <span className={exportModalStyles.checkboxLabel}>
                        {t("reports.exportIncludeIndividualSummary")}
                      </span>
                    </label>
                    <label className={exportModalStyles.checkboxRow} htmlFor="report-export-split-modules">
                      <input
                        id="report-export-split-modules"
                        type="checkbox"
                        className={exportModalStyles.checkbox}
                        checked={splitByModuleFiles}
                        onChange={(e) => setSplitByModuleFiles(e.target.checked)}
                      />
                      <span className={exportModalStyles.checkboxLabel}>
                        {t("reports.exportSplitByModuleFiles")}
                      </span>
                    </label>
                  </div>
                </div>
                <div className={exportModalStyles.actions}>
                  <button
                    type="button"
                    className={exportModalStyles.btnSecondary}
                    onClick={closeExportModal}
                  >
                    {t("settings.cancel")}
                  </button>
                  <button
                    type="button"
                    className={exportModalStyles.btnPrimary}
                    onClick={applyExportSettings}
                    disabled={!hasAnyExportDataType}
                  >
                    {t("settings.apply")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {generateModalOpen && (
          <div
            className={exportModalStyles.overlay}
            data-closing={generateModalClosing ? "true" : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-modal-title"
            onClick={(e) => e.target === e.currentTarget && closeGenerateModal()}
          >
            <div
              className={exportModalStyles.modal}
              data-closing={generateModalClosing ? "true" : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={exportModalStyles.modalInner}>
                <button
                  type="button"
                  className={exportModalStyles.closeBtn}
                  onClick={closeGenerateModal}
                  aria-label={t("settings.close")}
                >
                  ×
                </button>
                <h2 id="generate-modal-title" className={exportModalStyles.title}>
                  {t("reports.generateModalTitle")}
                </h2>
                <p className={exportModalStyles.sectionHint}>
                  {t("reports.generateModalHint")}
                </p>
                <div className={exportModalStyles.dateField}>
                  <label className={exportModalStyles.sectionLabel} htmlFor="generate-date-from">
                    {t("reports.dateFrom")}
                  </label>
                  <input
                    id="generate-date-from"
                    type="date"
                    className={exportModalStyles.dateInput}
                    value={generateDateFrom}
                    onChange={(e) => setGenerateDateFrom(e.target.value)}
                  />
                </div>
                <div className={exportModalStyles.dateField}>
                  <label className={exportModalStyles.sectionLabel} htmlFor="generate-date-to">
                    {t("reports.dateTo")}
                  </label>
                  <input
                    id="generate-date-to"
                    type="date"
                    className={exportModalStyles.dateInput}
                    value={generateDateTo}
                    onChange={(e) => setGenerateDateTo(e.target.value)}
                  />
                </div>
                <div className={exportModalStyles.actions}>
                  <button
                    type="button"
                    className={exportModalStyles.btnSecondary}
                    onClick={applyGenerate}
                    disabled={exportingReport}
                  >
                    {t("reports.generate")}
                  </button>
                  <button
                    type="button"
                    className={exportModalStyles.btnPrimary}
                    onClick={exportGeneratedReport}
                    disabled={exportingReport}
                  >
                    {exportingReport ? t("reports.exporting") : t("reports.exportReport")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
