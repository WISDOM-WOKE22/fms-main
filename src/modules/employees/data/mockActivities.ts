import type { EmployeeActivity } from "../types";

/** No demo data — activities would come from API. */
export const MOCK_ACTIVITIES: EmployeeActivity[] = [];

export function getActivitiesForEmployee(_employeeId: string): EmployeeActivity[] {
  return [];
}
