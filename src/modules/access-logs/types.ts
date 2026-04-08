/**
 * Activity types for access logs.
 * Check-in, Check-out, Tracking.
 */
export type AccessLogActivityType = "check-in" | "check-out" | "tracking" | "absent";

export type PeopleLogAttendanceStatus = "on_time" | "late" | "early_leave" | "overtime" | "absent" | "none";
export type PeopleLogBreakValue = "yes" | "no" | "none";
export type PeopleLogBreakStatus =
  | "on_time_for_break"
  | "late_for_break"
  | "returned_on_time"
  | "late_return"
  | "none";

export interface AccessLogEntry {
  id: string;
  employeeId?: string;
  employeeName: string;
  activityType: AccessLogActivityType;
  note: string;
  /** ISO date string (date only) */
  date: string;
  /** Time string e.g. "09:42" */
  time: string;
  zone: string;

  personTypeId?: string | null;
  personType?: string;
  shiftId?: string;
  shift?: string;

  attendanceStatus?: PeopleLogAttendanceStatus;
  breakValue?: PeopleLogBreakValue;
  breakStatus?: PeopleLogBreakStatus;
  is247?: boolean;
}
