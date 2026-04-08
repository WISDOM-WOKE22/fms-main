export type ReportRecipientStatus = "active" | "inactive";

export interface ReportRecipient {
  id: string;
  name: string;
  email: string;
  addedBy: string;
  addedAt: string;
  status: ReportRecipientStatus;
}
