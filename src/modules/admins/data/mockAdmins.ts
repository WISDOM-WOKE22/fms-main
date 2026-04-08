import type { Admin, AdminDetail } from "../types";

export const ADMIN_PERMISSION_KEYS = [
  "dashboard",
  "employees",
  "accessLogs",
  "auditLogs",
  "zones",
  "shifts",
  "admins",
  "reports",
] as const;

export const MOCK_ADMINS: Admin[] = [
  {
    id: "1",
    name: "Alex Morgan",
    email: "alex.morgan@company.com",
    role: "super_admin",
    status: "active",
    permissions: ["dashboard", "employees", "accessLogs", "auditLogs", "zones", "shifts", "admins", "reports"],
    createdAt: "2024-01-15T10:00:00Z",
  },
  {
    id: "2",
    name: "Jordan Lee",
    email: "jordan.lee@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "zones", "shifts"],
    createdAt: "2024-02-20T14:30:00Z",
  },
  {
    id: "3",
    name: "Samira Hassan",
    email: "samira.hassan@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "accessLogs", "auditLogs"],
    createdAt: "2024-03-10T09:15:00Z",
  },
  {
    id: "4",
    name: "Chris Park",
    email: "chris.park@company.com",
    role: "sub_admin",
    status: "inactive",
    permissions: ["dashboard", "reports"],
    createdAt: "2024-04-05T11:00:00Z",
  },
  {
    id: "5",
    name: "Rita Okonkwo",
    email: "rita.okonkwo@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "zones", "shifts", "reports"],
    createdAt: "2024-05-12T08:45:00Z",
  },
];

const DETAILS: Record<string, Omit<AdminDetail, "id">> = {
  "1": {
    name: "Alex Morgan",
    email: "alex.morgan@company.com",
    role: "super_admin",
    status: "active",
    permissions: ["dashboard", "employees", "accessLogs", "auditLogs", "zones", "shifts", "admins", "reports"],
    createdAt: "2024-01-15T10:00:00Z",
    lastLoginAt: "2025-03-02T08:22:00Z",
  },
  "2": {
    name: "Jordan Lee",
    email: "jordan.lee@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "zones", "shifts"],
    createdAt: "2024-02-20T14:30:00Z",
    lastLoginAt: "2025-03-01T16:45:00Z",
  },
  "3": {
    name: "Samira Hassan",
    email: "samira.hassan@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "accessLogs", "auditLogs"],
    createdAt: "2024-03-10T09:15:00Z",
    lastLoginAt: "2025-02-28T12:10:00Z",
  },
  "4": {
    name: "Chris Park",
    email: "chris.park@company.com",
    role: "sub_admin",
    status: "inactive",
    permissions: ["dashboard", "reports"],
    createdAt: "2024-04-05T11:00:00Z",
    lastLoginAt: "2024-11-20T09:00:00Z",
  },
  "5": {
    name: "Rita Okonkwo",
    email: "rita.okonkwo@company.com",
    role: "sub_admin",
    status: "active",
    permissions: ["dashboard", "employees", "zones", "shifts", "reports"],
    createdAt: "2024-05-12T08:45:00Z",
    lastLoginAt: "2025-03-02T07:30:00Z",
  },
};

export function getAdminDetail(id: string): AdminDetail | null {
  const detail = DETAILS[id];
  if (!detail) return null;
  return { ...detail, id };
}
