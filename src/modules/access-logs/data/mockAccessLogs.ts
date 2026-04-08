import type { AccessLogEntry } from "../types";

/**
 * Mock access log entries for the Access Logs page.
 * In a real app these would come from an API.
 */
const rawLogs = [
  // Morning shift (with break) — check-in and check-out on same day
  { id: "1", employeeName: "Sarah Chen", activityType: "check-in", note: "On time", date: "2025-03-02", time: "09:05", zone: "Main Gate" },
  { id: "2", employeeName: "Sarah Chen", activityType: "check-out", note: "End of shift", date: "2025-03-02", time: "17:02", zone: "Main Gate" },

  // Morning shift (with shorter break)
  { id: "3", employeeName: "James Okonkwo", activityType: "check-in", note: "", date: "2025-03-02", time: "08:55", zone: "Building A" },
  { id: "4", employeeName: "James Okonkwo", activityType: "check-out", note: "", date: "2025-03-02", time: "16:05", zone: "Building A" },

  // Evening shift (with break)
  { id: "5", employeeName: "Amina Hassan", activityType: "check-in", note: "", date: "2025-03-02", time: "14:02", zone: "Main Gate" },
  { id: "6", employeeName: "Amina Hassan", activityType: "check-out", note: "End of shift", date: "2025-03-02", time: "22:10", zone: "Main Gate" },

  // Night shift (no break)
  { id: "7", employeeName: "Michael Brown", activityType: "check-in", note: "Night duty", date: "2025-03-02", time: "22:01", zone: "Building B" },
  { id: "8", employeeName: "Michael Brown", activityType: "check-out", note: "", date: "2025-03-03", time: "06:00", zone: "Building B" },

  // Evening shift (with break)
  { id: "9", employeeName: "Priya Sharma", activityType: "check-in", note: "", date: "2025-03-01", time: "14:10", zone: "Main Gate" },
  { id: "10", employeeName: "Priya Sharma", activityType: "check-out", note: "", date: "2025-03-01", time: "21:55", zone: "Main Gate" },

  // 24/7 coverage schedule (no break counted)
  { id: "11", employeeName: "David Kim", activityType: "check-in", note: "24/7 coverage", date: "2025-02-28", time: "08:35", zone: "Building A" },
  { id: "12", employeeName: "David Kim", activityType: "check-out", note: "", date: "2025-02-28", time: "20:40", zone: "Building A" },

  // A few tracking events for variety
  { id: "13", employeeName: "Emma Wilson", activityType: "tracking", note: "Patrol round", date: "2025-03-02", time: "11:15", zone: "Main Gate" },
  { id: "14", employeeName: "Ahmed Ibrahim", activityType: "tracking", note: "Zone visit logged", date: "2025-03-01", time: "16:30", zone: "Building A" },
];

export const MOCK_ACCESS_LOGS = rawLogs.sort((a, b) => {
  const tA = new Date(`${a.date}T${a.time}`).getTime();
  const tB = new Date(`${b.date}T${b.time}`).getTime();
  return tB - tA;
}) as AccessLogEntry[];
