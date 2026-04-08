import { apiFetch } from "@/core/api/request";
import type { AccessLogEntry } from "../types";

export interface FetchAccessLogsParams {
  dateFrom?: string;
  dateTo?: string;
  activityType?: string;
  zone?: string;
  search?: string;
}

export async function fetchAccessLogs(params: FetchAccessLogsParams = {}): Promise<AccessLogEntry[]> {
  const sp = new URLSearchParams();
  if (params.dateFrom) sp.set("dateFrom", params.dateFrom);
  if (params.dateTo) sp.set("dateTo", params.dateTo);
  if (params.activityType && params.activityType !== "all") sp.set("activityType", params.activityType);
  if (params.zone && params.zone !== "all") sp.set("zone", params.zone);
  if (params.search?.trim()) sp.set("search", params.search.trim());
  const qs = sp.toString();
  const path = `/api/v1/access-logs${qs ? `?${qs}` : ""}`;
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch access logs");
  const data = await res.json();
  return Array.isArray(data) ? (data as AccessLogEntry[]) : [];
}

export async function fetchEmployeesForPeopleLog(): Promise<
  { id: string; personTypeId?: string | null; personType?: string; shiftId?: string; shift?: string }[]
> {
  const res = await apiFetch("/api/v1/employees");
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data as any;
}

export async function fetchPersonTypesForPeopleLog(): Promise<{ id: string; name: string }[]> {
  const res = await apiFetch("/api/v1/person-types");
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data as any;
}

export async function fetchShiftsForPeopleLog(): Promise<{ id: string; name: string; breakTime?: string }[]> {
  const res = await apiFetch("/api/v1/schedules");
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data as any;
}

export async function fetchTimeConfigForPeopleLog(): Promise<
  { checkInStart: string; checkInEnd: string; checkOutStart: string; checkOutEnd: string } | undefined
> {
  const res = await apiFetch("/api/v1/settings/time-config");
  if (!res.ok) return undefined;
  const data = await res.json();
  return data as any;
}

export async function fetchZonesForFilter(): Promise<string[]> {
  const res = await apiFetch("/api/v1/zones");
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .map((z: { name?: string }) => z.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}
