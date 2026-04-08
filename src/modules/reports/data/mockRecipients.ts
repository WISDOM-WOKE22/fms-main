import type { ReportRecipient } from "../types";

export const MOCK_REPORT_RECIPIENTS: ReportRecipient[] = [
  {
    id: "1",
    name: "Finance Team",
    email: "finance@company.com",
    addedBy: "Alex Morgan",
    addedAt: "2024-11-01T09:00:00Z",
    status: "active",
  },
  {
    id: "2",
    name: "HR Operations",
    email: "hr-ops@company.com",
    addedBy: "Jordan Lee",
    addedAt: "2024-11-15T14:30:00Z",
    status: "active",
  },
  {
    id: "3",
    name: "Operations Lead",
    email: "ops.lead@company.com",
    addedBy: "Alex Morgan",
    addedAt: "2024-12-02T10:15:00Z",
    status: "active",
  },
  {
    id: "4",
    name: "Compliance",
    email: "compliance@company.com",
    addedBy: "Samira Hassan",
    addedAt: "2024-12-10T11:00:00Z",
    status: "inactive",
  },
  {
    id: "5",
    name: "Executive Summary",
    email: "exec-reports@company.com",
    addedBy: "Alex Morgan",
    addedAt: "2025-01-08T08:45:00Z",
    status: "active",
  },
  {
    id: "6",
    name: "Legacy Distribution",
    email: "legacy-reports@company.com",
    addedBy: "Jordan Lee",
    addedAt: "2024-09-20T16:00:00Z",
    status: "inactive",
  },
];
