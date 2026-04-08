/** Resource values used in API and filters. */
export const AUDIT_RESOURCE_KEYS = [
  "employee",
  "zone",
  "shift",
  "admin",
  "person_type",
  "settings",
  "recipient",
  "report",
] as const;

export type AuditResourceKey = (typeof AUDIT_RESOURCE_KEYS)[number];
