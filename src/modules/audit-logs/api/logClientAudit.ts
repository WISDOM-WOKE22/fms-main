/**
 * Log audit entries from the client for resources that don't have a backend mutation (e.g. settings, recipients).
 * Only use for resources allowed by the API: "settings" | "recipient".
 */

import { apiFetch } from "@/core/api/request";

export type ClientAuditResource = "settings" | "recipient" | "report" | "license";

export interface LogClientAuditParams {
  action: string;
  resource: ClientAuditResource;
  resourceId?: string;
  /** Legacy: plain English description (not translated). */
  description?: string;
  /** Translation key for description (e.g. "auditLogs.descPreferencesUpdated"). */
  descriptionKey?: string;
  /** Params for the translation key (e.g. { name, status }). */
  descriptionParams?: Record<string, unknown>;
  changes?: Record<string, unknown>;
}

export async function logClientAudit(params: LogClientAuditParams): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId ?? undefined,
      changes: params.changes ?? undefined,
    };
    if (params.descriptionKey) {
      body.descriptionKey = params.descriptionKey;
      body.descriptionParams = params.descriptionParams ?? {};
    } else if (params.description) {
      body.description = params.description;
    }
    await apiFetch("/api/v1/audit-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Fire-and-forget; don't block UI
  }
}
