import type { Employee } from "@/modules/employees/types";

/**
 * Returns employees assigned to the given shift.
 * In the app, ShiftDetailPage fetches from API and filters client-side.
 */
export function getEmployeesForShift(_shiftName: string): Employee[] {
  return [];
}
