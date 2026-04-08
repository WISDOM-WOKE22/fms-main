"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { IconChevronLeft, IconChevronRight, IconSearch, IconPlus } from "@/core/layout/icons";
import { Badge, Select } from "@/core/ui";
import { toast } from "@/core/lib/toast";
import { TableSkeleton } from "@/modules/employees/components/TableSkeleton";
import styles from "./PersonTypeModal.module.css";

export interface PersonTypeRow {
  id: string;
  name: string;
  description?: string;
  status: string;
  createdAt?: string;
  assignedCount?: number;
}

const ROWS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 50];
const MODAL_CLOSE_DURATION = 220;

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function matchesSearch(row: PersonTypeRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    (row.description ?? "").toLowerCase().includes(q)
  );
}

type ViewEditForm = { name: string; description: string; status: string };
type CreateForm = { name: string; description: string; status: string };

export default function PersonTypesPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<PersonTypeRow[]>([]);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [searchQuery, setSearchQuery] = useState("");

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ name: "", description: "", status: "active" });
  const [creating, setCreating] = useState(false);

  const [viewModalId, setViewModalId] = useState<string | null>(null);
  const [viewModalClosing, setViewModalClosing] = useState(false);
  const [editForm, setEditForm] = useState<ViewEditForm>({ name: "", description: "", status: "active" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const fetchList = useCallback(() => {
    setLoading(true);
    apiFetch("/api/v1/person-types")
      .then((res) => res.json())
      .then((data: PersonTypeRow[]) => {
        if (Array.isArray(data)) setList(data);
        else setList([]);
      })
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const filtered = useMemo(() => list.filter((row) => matchesSearch(row, searchQuery)), [list, searchQuery]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const start = (page - 1) * rowsPerPage;
  const paginatedRows = useMemo(
    () => filtered.slice(start, start + rowsPerPage),
    [filtered, start, rowsPerPage]
  );

  const viewModalRow = useMemo(
    () => (viewModalId ? list.find((r) => r.id === viewModalId) ?? null : null),
    [list, viewModalId]
  );

  const closeViewModal = useCallback(() => {
    setViewModalClosing(true);
    setTimeout(() => {
      setViewModalId(null);
      setDeleteConfirmOpen(false);
      setViewModalClosing(false);
    }, MODAL_CLOSE_DURATION);
  }, []);

  const openViewModal = useCallback((row: PersonTypeRow) => {
    setViewModalId(row.id);
    setEditForm({
      name: row.name,
      description: row.description ?? "",
      status: row.status ?? "active",
    });
    setViewModalClosing(false);
    setDeleteConfirmOpen(false);
  }, []);

  const openCreateModal = useCallback(() => {
    setCreateForm({ name: "", description: "", status: "active" });
    setCreateModalOpen(true);
  }, []);

  const closeCreateModal = useCallback(() => {
    setCreateModalOpen(false);
  }, []);

  const createPersonType = useCallback(async () => {
    const name = createForm.name.trim();
    if (!name) {
      toast.error(t("personTypes.validationName"));
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch("/api/v1/person-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: createForm.description.trim() || undefined,
          status: createForm.status || "active",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? t("personTypes.personTypeCreateError"));
      }
      toast.success(t("personTypes.personTypeCreated"));
      closeCreateModal();
      fetchList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("personTypes.personTypeCreateError"));
    } finally {
      setCreating(false);
    }
  }, [createForm, closeCreateModal, fetchList, t]);

  const savePersonType = useCallback(async () => {
    if (!viewModalId) return;
    const name = editForm.name.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/v1/person-types/${viewModalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: editForm.description.trim() || undefined,
          status: editForm.status || "active",
        }),
      });
      if (!res.ok) throw new Error("Update failed");
      toast.success(t("personTypes.personTypeUpdated"));
      setList((prev) =>
        prev.map((r) =>
          r.id === viewModalId
            ? { ...r, name, description: editForm.description.trim() || undefined, status: editForm.status }
            : r
        )
      );
      closeViewModal();
    } catch {
      toast.error(t("personTypes.personTypeUpdateError"));
    } finally {
      setSaving(false);
    }
  }, [viewModalId, editForm, closeViewModal, t]);

  const deletePersonType = useCallback(async () => {
    if (!viewModalId) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/v1/person-types/${viewModalId}`, { method: "DELETE" });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        const count = data?.count;
        toast.error(
          typeof count === "number"
            ? t("personTypes.cannotDeleteInUse", { count })
            : t("personTypes.cannotDeleteInUseShort")
        );
        setDeleteConfirmOpen(false);
        return;
      }
      if (!res.ok) throw new Error("Delete failed");
      setDeleteConfirmOpen(false);
      toast.success(t("personTypes.personTypeDeleted"));
      setList((prev) => prev.filter((r) => r.id !== viewModalId));
      closeViewModal();
    } catch {
      toast.error(t("personTypes.personTypeDeleteError"));
      setDeleteConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }, [viewModalId, closeViewModal, t]);

  useEffect(() => {
    if (!viewModalId || viewModalClosing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (deleteConfirmOpen) setDeleteConfirmOpen(false);
        else closeViewModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewModalId, viewModalClosing, closeViewModal, deleteConfirmOpen]);

  useEffect(() => {
    if (!createModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCreateModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createModalOpen, closeCreateModal]);

  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));

  return (
    <DashboardLayout title={t("nav.personTypes")}>
      <div className="w-full max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <p className="text-sm text-fms-text-secondary m-0">{t("personTypes.pageDescription")}</p>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
            aria-label={t("personTypes.addPersonType")}
          >
            <IconPlus className="w-5 h-5" aria-hidden />
            {t("personTypes.addPersonType")}
          </button>
        </div>

        <section className="rounded-2xl bg-fms-surface border border-fms-border overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 border-b border-fms-border">
            <div className="relative flex-1 max-w-sm">
              <IconSearch
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fms-text-tertiary pointer-events-none"
                aria-hidden
              />
              <input
                type="search"
                placeholder={t("personTypes.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="w-full pl-9 pr-4 py-2.5 rounded-2xl text-sm text-fms-text bg-fms-surface border border-fms-border placeholder:text-fms-text-tertiary focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:border-fms-accent"
                aria-label={t("personTypes.searchPlaceholder")}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={rowsPerPage} cols={5} showCheckbox={false} />
            ) : list.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-fms-text-secondary font-medium mb-1">{t("personTypes.emptyTitle")}</p>
                <p className="text-sm text-fms-text-tertiary mb-6 max-w-sm mx-auto">{t("personTypes.emptyMessage")}</p>
                <button
                  type="button"
                  onClick={openCreateModal}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold text-white bg-fms-accent hover:bg-fms-accent-hover shadow-sm hover:shadow-md transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-fms-accent-muted focus:ring-offset-2"
                  aria-label={t("personTypes.addPersonType")}
                >
                  <IconPlus className="w-5 h-5" aria-hidden />
                  {t("personTypes.addPersonType")}
                </button>
              </div>
            ) : paginatedRows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-fms-text-tertiary">{t("personTypes.noResults")}</div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-fms-border bg-fms-bg-subtle/30">
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">{t("personTypes.typeName")}</th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">{t("personTypes.description")}</th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">{t("personTypes.status")}</th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left">{t("personTypes.createdAt")}</th>
                    <th className="py-3.5 px-4 font-medium text-fms-text-tertiary text-left w-0">{t("personTypes.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row) => (
                    <tr
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openViewModal(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openViewModal(row);
                        }
                      }}
                      className={`border-b border-fms-border last:border-b-0 hover:bg-fms-bg-subtle/50 transition-colors ${styles.rowClickable}`}
                    >
                      <td className="py-3.5 px-4 font-medium text-fms-text">{row.name}</td>
                      <td className="py-3.5 px-4 text-fms-text-secondary">{row.description || "—"}</td>
                      <td className="py-3.5 px-4">
                        <Badge variant={row.status === "active" ? "success" : "neutral"}>
                          {row.status === "active" ? t("personTypes.active") : t("personTypes.inactive")}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4 text-fms-text-secondary tabular-nums">{formatDate(row.createdAt)}</td>
                      <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                        <div className={styles.actionCell}>
                          <button
                            type="button"
                            onClick={() => openViewModal(row)}
                            className={styles.viewBtn}
                            aria-label={t("personTypes.editPersonType")}
                          >
                            {t("personTypes.editPersonType")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && filtered.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-t border-fms-border bg-fms-bg-subtle/20">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-fms-text-secondary whitespace-nowrap">{t("personTypes.rowsPerPage")}</label>
                  <Select
                    value={rowsPerPage}
                    onChange={(e) => {
                      setRowsPerPage(Number(e.target.value));
                      setPage(1);
                    }}
                    selectSize="sm"
                    className="min-w-[72px]"
                    aria-label={t("personTypes.rowsPerPage")}
                  >
                    {ROWS_PER_PAGE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="text-sm text-fms-text-secondary">
                  {t("personTypes.pageOf", { current: page, total: totalPages })}
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
                  {t("personTypes.previous")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-2xl text-sm font-medium text-fms-text-secondary hover:text-fms-text hover:bg-fms-bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {t("personTypes.next")}
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Create modal */}
      {createModalOpen && (
        <div
          className={styles.overlay}
          onClick={(e) => e.target === e.currentTarget && closeCreateModal()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-person-type-modal-title"
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalInner}>
              <div className={styles.modalHeader}>
                <h2 id="create-person-type-modal-title" className={styles.modalTitle}>
                  {t("personTypes.addPersonType")}
                </h2>
                <button type="button" className={styles.closeBtn} onClick={closeCreateModal} aria-label={t("personTypes.close")}>
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                <div className={styles.field}>
                  <label htmlFor="create-type-name" className={styles.label}>
                    {t("personTypes.typeName")}
                  </label>
                  <input
                    id="create-type-name"
                    type="text"
                    className={styles.input}
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t("personTypes.typeNamePlaceholder")}
                    disabled={creating}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="create-description" className={styles.label}>
                    {t("personTypes.description")}
                  </label>
                  <textarea
                    id="create-description"
                    className={styles.textarea}
                    value={createForm.description}
                    onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder={t("personTypes.descriptionPlaceholder")}
                    disabled={creating}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>{t("personTypes.status")}</span>
                  <div role="group" aria-label={t("personTypes.status")} className={styles.statusToggles}>
                    <button
                      type="button"
                      onClick={() => setCreateForm((f) => ({ ...f, status: "active" }))}
                      disabled={creating}
                      className={styles.statusBtn + (createForm.status === "active" ? " " + styles.statusBtnActive : "")}
                    >
                      {t("personTypes.active")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateForm((f) => ({ ...f, status: "inactive" }))}
                      disabled={creating}
                      className={styles.statusBtn + (createForm.status === "inactive" ? " " + styles.statusBtnActive : "")}
                    >
                      {t("personTypes.inactive")}
                    </button>
                  </div>
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.btnSecondary} onClick={closeCreateModal} disabled={creating}>
                    {t("personTypes.close")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btnPrimary} inline-flex items-center justify-center gap-2`}
                    onClick={createPersonType}
                    disabled={!createForm.name.trim() || creating}
                  >
                    {creating && (
                      <span className="size-4 border-2 border-current border-r-transparent rounded-full animate-spin shrink-0" aria-hidden />
                    )}
                    {creating ? t("personTypes.savePersonType") : t("personTypes.savePersonType")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* View / Edit modal */}
      {viewModalId && viewModalRow && (
        <div
          className={styles.overlay + (viewModalClosing ? " " + styles.overlayClosing : "")}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            if (deleteConfirmOpen) setDeleteConfirmOpen(false);
            else closeViewModal();
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="view-person-type-modal-title"
        >
          <div
            className={styles.modal + (viewModalClosing ? " " + styles.modalClosing : "")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalInner}>
              <div className={styles.modalHeader}>
                <h2 id="view-person-type-modal-title" className={styles.modalTitle}>
                  {viewModalRow.name}
                </h2>
                <div className={styles.modalHeaderActions}>
                  <button
                    type="button"
                    className={`${styles.btnPrimary} inline-flex items-center justify-center gap-2`}
                    onClick={savePersonType}
                    disabled={!editForm.name.trim() || saving}
                  >
                    {saving && (
                      <span className="size-4 border-2 border-current border-r-transparent rounded-full animate-spin shrink-0" aria-hidden />
                    )}
                    {saving ? t("personTypes.save") : t("personTypes.save")}
                  </button>
                </div>
              </div>

              <div className={styles.modalBody + " " + styles.modalBodyEdit}>
                <div className={styles.field}>
                  <label htmlFor="edit-type-name" className={styles.label}>
                    {t("personTypes.typeName")}
                  </label>
                  <input
                    id="edit-type-name"
                    type="text"
                    className={styles.input}
                    value={editForm.name}
                    onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t("personTypes.typeNamePlaceholder")}
                    disabled={saving}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="edit-description" className={styles.label}>
                    {t("personTypes.description")}
                  </label>
                  <textarea
                    id="edit-description"
                    className={styles.textarea}
                    value={editForm.description}
                    onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder={t("personTypes.descriptionPlaceholder")}
                    disabled={saving}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>{t("personTypes.status")}</span>
                  <div role="group" aria-label={t("personTypes.status")} className={styles.statusToggles}>
                    <button
                      type="button"
                      onClick={() => setEditForm((f) => ({ ...f, status: "active" }))}
                      disabled={saving}
                      className={styles.statusBtn + (editForm.status === "active" ? " " + styles.statusBtnActive : "")}
                    >
                      {t("personTypes.active")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditForm((f) => ({ ...f, status: "inactive" }))}
                      disabled={saving}
                      className={styles.statusBtn + (editForm.status === "inactive" ? " " + styles.statusBtnActive : "")}
                    >
                      {t("personTypes.inactive")}
                    </button>
                  </div>
                </div>
                <div className={styles.actions + " " + styles.actionsRow}>
                  <button
                    type="button"
                    className={styles.btnDanger}
                    onClick={() => setDeleteConfirmOpen(true)}
                    disabled={saving || deleting}
                  >
                    {t("personTypes.deletePersonType")}
                  </button>
                  <button type="button" className={styles.btnSecondary} onClick={closeViewModal} disabled={saving}>
                    {t("personTypes.close")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete warning modal */}
      {deleteConfirmOpen && viewModalRow && (
        <div
          className={styles.overlay}
          onClick={(e) => e.target === e.currentTarget && setDeleteConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-warning-modal-title"
        >
          <div className={styles.deleteWarningModal} onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-warning-modal-title" className={styles.modalTitle}>
              {t("personTypes.confirmDeleteTitle")}
            </h2>
            <div className={styles.modalBody}>
              {(viewModalRow.assignedCount ?? 0) > 0 ? (
                <>
                  <p className={styles.deleteWarningText}>
                    {t("personTypes.deleteAssignedWarning", { count: viewModalRow.assignedCount })}
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setDeleteConfirmOpen(false)}
                    >
                      {t("personTypes.close")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.deleteWarningText}>
                    {t("personTypes.confirmDeleteMessage")}
                  </p>
                  <div className={styles.actions + " " + styles.actionsRow}>
                    <button
                      type="button"
                      className={styles.btnDanger}
                      onClick={deletePersonType}
                      disabled={deleting}
                    >
                      {deleting ? (
                        <span className="inline-block size-4 border-2 border-current border-r-transparent rounded-full animate-spin" aria-hidden />
                      ) : (
                        t("personTypes.deletePersonType")
                      )}
                    </button>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setDeleteConfirmOpen(false)}
                      disabled={deleting}
                    >
                      {t("personTypes.close")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
