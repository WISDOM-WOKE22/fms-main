/** Single audit log entry from API (list or detail). */
export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorType: string | null;
  actorName: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  description: string | null;
  changes: string | null; // JSON string
  timestamp: string; // ISO
}

/** For table display: derived user label and date/time split. */
export interface AuditLogRow extends AuditLogEntry {
  user: string;
  date: string;
  time: string;
}

export function auditEntryToRow(entry: AuditLogEntry): AuditLogRow {
  const d = new Date(entry.timestamp);
  const date = entry.timestamp.slice(0, 10);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    ...entry,
    user: entry.actorName ?? entry.actorId ?? "",
    date,
    time,
  };
}
