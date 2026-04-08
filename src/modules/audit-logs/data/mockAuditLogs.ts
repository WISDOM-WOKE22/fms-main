import type { AuditLogEntry } from "../types";

function entry(
  id: string,
  actorName: string,
  action: string,
  resource: string,
  date: string,
  time: string,
  resourceId: string | null = null
): AuditLogEntry {
  const timestamp = `${date}T${time}:00.000Z`;
  return {
    id,
    actorId: null,
    actorType: "admin",
    actorName,
    action,
    resource,
    resourceId,
    description: null,
    changes: null,
    timestamp,
  };
}

/**
 * Mock audit log entries for the Audit Logs page.
 * In a real app these would come from an API.
 */
export const MOCK_AUDIT_LOGS: AuditLogEntry[] = [
  entry("1", "Admin", "Updated employee", "Employees", "2025-03-02", "10:12", "1"),
  entry("2", "Admin", "Viewed report", "Reports", "2025-03-02", "09:55"),
  entry("3", "Admin", "Changed settings", "Settings", "2025-03-02", "09:30"),
  entry("4", "Admin", "Exported data", "Access Logs", "2025-03-02", "09:08"),
  entry("5", "Admin", "Signed in", "Auth", "2025-03-02", "08:45"),
  entry("6", "Sarah Chen", "Viewed dashboard", "Dashboard", "2025-03-02", "08:30"),
  entry("7", "Admin", "Created zone", "Zones", "2025-03-01", "16:20", "1"),
  entry("8", "Admin", "Edited shift", "Shifts", "2025-03-01", "15:45", "1"),
  entry("9", "James Okonkwo", "Viewed report", "Reports", "2025-03-01", "14:10"),
  entry("10", "Admin", "Exported data", "Audit Logs", "2025-03-01", "13:00"),
  entry("11", "Admin", "Signed out", "Auth", "2025-03-01", "12:30"),
  entry("12", "Amina Hassan", "Viewed employees", "Employees", "2025-03-01", "11:15"),
  entry("13", "Admin", "Updated settings", "Settings", "2025-02-28", "17:00"),
  entry("14", "Admin", "Added admin", "Admins", "2025-02-28", "16:22", "1"),
  entry("15", "Admin", "Signed in", "Auth", "2025-02-28", "08:00"),
  entry("16", "Michael Brown", "Viewed access logs", "Access Logs", "2025-02-27", "15:40"),
  entry("17", "Admin", "Deleted record", "Reports", "2025-02-27", "14:05"),
  entry("18", "Admin", "Changed settings", "Settings", "2025-02-26", "10:30"),
  entry("19", "Priya Sharma", "Viewed audit logs", "Audit Logs", "2025-02-26", "09:50"),
  entry("20", "Admin", "Exported data", "Employees", "2025-02-25", "11:20"),
].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

export const AUDIT_RESOURCES = [
  "Auth",
  "Dashboard",
  "Employees",
  "Access Logs",
  "Audit Logs",
  "Reports",
  "Settings",
  "Zones",
  "Shifts",
  "Admins",
] as const;
