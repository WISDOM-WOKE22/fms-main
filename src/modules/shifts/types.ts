export type ShiftStatus = "active" | "inactive";
export type ScheduleType = "standard" | "24_7";

export interface ShiftRow {
  id: string;
  name: string;
  scheduleType: ScheduleType;
  personTypeId: string;
  personType: string;
  assignedEmployees: number;
  status: ShiftStatus;
  isActive: boolean;
  breakBadge: "Yes" | "No" | "—";
  breakTime: string | null;
  startTime: string | null;
  endTime: string | null;
  gracePeriodEnabled: boolean;
  gracePeriodMinutes: number | null;
  breakEnabled: boolean;
  breakStartTime: string | null;
  breakEndTime: string | null;
  breakGracePeriodMinutes: number | null;
  overtimeEnabled: boolean;
  overtimeThresholdMinutes: number | null;
  workingDays: string[] | null;
  createdBy: string;
  createdAt: string;
  description?: string | null;
}
