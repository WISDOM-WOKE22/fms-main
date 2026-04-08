/** Module keys that can be granted to sub-admins (match nav sections). "settings" is super_admin only. */
export type AdminPermissionKey =
  | "dashboard"
  | "employees"
  | "accessLogs"
  | "auditLogs"
  | "zones"
  | "shifts"
  | "admins"
  | "reports"
  | "settings";

export type AdminRole = "super_admin" | "sub_admin";

export type AdminStatus = "active" | "inactive";

export interface Admin {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminStatus;
  /** For sub_admin: list of module keys they can access. Super admin has full access. */
  permissions: AdminPermissionKey[];
  createdAt: string;
}

export interface AdminDetail extends Admin {
  lastLoginAt?: string;
}
