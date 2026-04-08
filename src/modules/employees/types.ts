export type EmployeeStatus = "checked-in" | "checked-out";

/** Effective face enrollment state (includes derived `expired` when link timed out). */
export type FaceEnrollmentDisplay = "not_enrolled" | "link_sent" | "enrolled" | "expired";

export interface EmployeeZoneRef {
  id: string;
  name: string;
}

/** Reference to a zone (child of a location) assigned to an employee. */
export interface EmployeeZoneRefItem {
  zoneId: string;
  zoneName?: string;
  name: string;
}

export interface Employee {
  id: string;
  name: string;
  /** Present in list API when set (used for enrollment link). */
  email?: string;
  zone: string;
  zoneId?: string;
  zoneIds?: string[];
  /** Assigned locations (parent zones). */
  locations?: EmployeeZoneRef[];
  /** Assigned zones (within locations). */
  zones?: EmployeeZoneRefItem[];
  shift: string;
  shiftId?: string;
  personTypeId?: string;
  personType?: string;
  status: EmployeeStatus;
  isActive: boolean;
  joinedDate: string;
  hasProfilePhoto?: boolean;
  faceEnrollment?: FaceEnrollmentDisplay;
  enrollmentExpiresAt?: string | null;
}

export interface EmployeeDetail extends Employee {
  email?: string;
  phone?: string;
}

export type ActivityType = "check-in" | "check-out";

export interface EmployeeActivity {
  id: string;
  employeeId: string;
  type: ActivityType;
  date: string;
  time: string;
  zone?: string;
}
