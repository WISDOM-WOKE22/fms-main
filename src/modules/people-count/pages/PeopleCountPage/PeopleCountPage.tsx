"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/core/layout";
import { apiFetch } from "@/core/api/request";
import { Select } from "@/core/ui";
import { IconUsers, IconLogin, IconLogout, IconChevronDown, IconChevronRight, IconX } from "@/core/layout/icons";
import { KpiCard } from "@/modules/dashboard/components/KpiCard";
import { EntriesExitsAreaChart } from "@/modules/dashboard/components/EntriesExitsAreaChart";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

type ZoneOption = { id: string; name: string };
type LocationOption = { id: string; name: string; zones: ZoneOption[] };
type SummaryResponse = { totalCount: number; totalEntries: number; totalExits: number };
type ChartPoint1 = { time: string; count: number };
type ChartPoint2 = { time: string; entries: number; exits: number };
type ChartPoint3 = { locationId: string; locationName: string; currentCount: number; zones: { zoneId: string; zoneName: string; count: number }[] };
type ChartsResponse = { countOverTime: ChartPoint1[]; entriesExitsOverTime: ChartPoint2[]; currentByLocation: ChartPoint3[] };
type TableZoneRow = { zoneId: string; zoneName: string; currentCount: number; totalEntries: number; totalExits: number; lastUpdated: string | null };
type TableLocationRow = { locationId: string; locationName: string; zonesCount: number; currentCount: number; totalEntries: number; totalExits: number; lastUpdated: string | null; zones: TableZoneRow[] };
type TableResponse = { rows: TableLocationRow[] };

const CHARTS_KEY = "people-count-charts-expanded";
const TABLE_KEY = "people-count-table-expanded";

function formatTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function normalizeChartsResponse(payload: Partial<ChartsResponse> | null | undefined): ChartsResponse {
  return {
    countOverTime: Array.isArray(payload?.countOverTime) ? payload.countOverTime : [],
    entriesExitsOverTime: Array.isArray(payload?.entriesExitsOverTime) ? payload.entriesExitsOverTime : [],
    currentByLocation: Array.isArray(payload?.currentByLocation) ? payload.currentByLocation : [],
  };
}

export default function PeopleCountPage() {
  const defaultDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [filters, setFilters] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [timeFrom, setTimeFrom] = useState("00:00");
  const [timeTo, setTimeTo] = useState("23:59");
  const [summary, setSummary] = useState<SummaryResponse>({ totalCount: 0, totalEntries: 0, totalExits: 0 });
  const [charts, setCharts] = useState<ChartsResponse>({ countOverTime: [], entriesExitsOverTime: [], currentByLocation: [] });
  const [tableRows, setTableRows] = useState<TableLocationRow[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chartsOpen, setChartsOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const chartsState = window.localStorage.getItem(CHARTS_KEY);
    const tableState = window.localStorage.getItem(TABLE_KEY);
    if (chartsState != null) setChartsOpen(chartsState !== "false");
    if (tableState != null) setTableOpen(tableState !== "false");
    apiFetch("/api/v1/people-count/filters")
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load people count filters");
        return (await r.json()) as { locations: LocationOption[] };
      })
      .then((data) => setFilters(data.locations ?? []))
      .catch(() => {
        setFilters([]);
        setError("Failed to load People Count data from database.");
      });
  }, []);

  const zones = useMemo(() => filters.find((loc) => loc.id === locationId)?.zones ?? [], [filters, locationId]);
  const resetFilters = () => {
    setLocationId("");
    setZoneId("");
    setDate(defaultDate);
    setTimeFrom("00:00");
    setTimeTo("23:59");
  };
  const entriesExitsAreaData = useMemo(
    () =>
      (charts.entriesExitsOverTime ?? []).map((point) => ({
        date: point.time,
        entries: point.entries,
        exits: point.exits,
      })),
    [charts.entriesExitsOverTime]
  );

  const countOverTimeAreaData = useMemo(() => charts.countOverTime ?? [], [charts.countOverTime]);

  const byLocationAreaData = useMemo(
    () =>
      (charts.currentByLocation ?? []).map((item) => ({
        locationName: item.locationName,
        currentCount: item.currentCount,
      })),
    [charts.currentByLocation]
  );
  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (locationId) sp.set("locationId", locationId);
    if (zoneId) sp.set("zoneId", zoneId);
    sp.set("date", date);
    sp.set("timeFrom", timeFrom);
    sp.set("timeTo", timeTo);
    return sp.toString();
  }, [locationId, zoneId, date, timeFrom, timeTo]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`/api/v1/people-count/summary?${params}`).then(async (r) => {
        if (!r.ok) throw new Error("Failed to load people count summary");
        return (await r.json()) as SummaryResponse;
      }),
      apiFetch(`/api/v1/people-count/charts?${params}`).then(async (r) => {
        if (!r.ok) throw new Error("Failed to load people count charts");
        return (await r.json()) as Partial<ChartsResponse>;
      }),
      apiFetch(`/api/v1/people-count/table?${params}`).then(async (r) => {
        if (!r.ok) throw new Error("Failed to load people count table");
        return (await r.json()) as TableResponse;
      }),
    ])
      .then(([s, c, t]: [SummaryResponse, Partial<ChartsResponse>, TableResponse]) => {
        setSummary({
          totalCount: Number(s?.totalCount ?? 0),
          totalEntries: Number(s?.totalEntries ?? 0),
          totalExits: Number(s?.totalExits ?? 0),
        });
        setCharts(normalizeChartsResponse(c));
        setTableRows(Array.isArray(t?.rows) ? t.rows : []);
      })
      .catch(() => {
        setSummary({ totalCount: 0, totalEntries: 0, totalExits: 0 });
        setCharts({ countOverTime: [], entriesExitsOverTime: [], currentByLocation: [] });
        setTableRows([]);
        setError("Failed to load People Count data from database.");
      })
      .finally(() => setLoading(false));
  }, [params]);

  return (
    <DashboardLayout title="People Count">
      <div className="space-y-6">
        <section className="rounded-2xl border border-fms-border bg-fms-surface p-4 grid grid-cols-1 md:grid-cols-[repeat(5,minmax(0,1fr))_auto] gap-3 items-end">
          <div className="w-full">
            <label className="block text-xs text-fms-text-secondary mb-1">Location</label>
            <Select value={locationId} onChange={(e) => { setLocationId(e.target.value); setZoneId(""); }} className="w-full">
              <option value="">All Locations</option>
              {filters.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </div>
          <div className="w-full">
            <label className="block text-xs text-fms-text-secondary mb-1">Zone</label>
            <Select value={zoneId} disabled={!locationId} onChange={(e) => setZoneId(e.target.value)} className="w-full">
              <option value="">All Zones</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </Select>
          </div>
          <div className="w-full">
            <label className="block text-xs text-fms-text-secondary mb-1">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-2xl border border-fms-border bg-fms-surface px-3 py-2.5 text-sm" />
          </div>
          <div className="w-full">
            <label className="block text-xs text-fms-text-secondary mb-1">From</label>
            <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} className="w-full rounded-2xl border border-fms-border bg-fms-surface px-3 py-2.5 text-sm" />
          </div>
          <div className="w-full">
            <label className="block text-xs text-fms-text-secondary mb-1">To</label>
            <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} className="w-full rounded-2xl border border-fms-border bg-fms-surface px-3 py-2.5 text-sm" />
          </div>
          <div className="flex items-end justify-end md:justify-self-end">
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-fms-border bg-fms-surface text-fms-text hover:bg-fms-bg-subtle"
              aria-label="Clear filters"
              title="Clear filters"
            >
              <IconX className="w-4 h-4" />
            </button>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KpiCard title="Total Count" value={summary.totalCount} icon={<IconUsers className="w-5 h-5" />} />
          <KpiCard title="Total Entries" value={summary.totalEntries} icon={<IconLogin className="w-5 h-5" />} />
          <KpiCard title="Total Exits" value={summary.totalExits} icon={<IconLogout className="w-5 h-5" />} />
        </section>

        {error && (
          <p className="text-sm text-amber-600 dark:text-amber-400 m-0" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between">
          <h3 className="m-0 text-base">Charts</h3>
          <button type="button" onClick={() => { const next = !chartsOpen; setChartsOpen(next); window.localStorage.setItem(CHARTS_KEY, String(next)); }} className="inline-flex items-center gap-1 text-sm">
            {chartsOpen ? "Collapse" : "Expand"}{chartsOpen ? <IconChevronDown className="w-4 h-4" /> : <IconChevronRight className="w-4 h-4" />}
          </button>
        </div>
        {chartsOpen && (
          <div className="flex flex-col gap-4">
            <section className="rounded-2xl border border-fms-border bg-fms-surface p-4">
              <p className="text-sm m-0 mb-2">People Count Over Time</p>
              {countOverTimeAreaData.length === 0 ? (
                <p className="text-sm text-fms-text-secondary m-0">No chart data available for selected filters.</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={countOverTimeAreaData}>
                    <defs>
                      <linearGradient id="peopleCountGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.36} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Area type="monotone" dataKey="count" stroke="#3b82f6" fill="url(#peopleCountGradient)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </section>

            <section className="rounded-2xl border border-fms-border bg-fms-surface p-4">
              {entriesExitsAreaData.length === 0 ? (
                <>
                  <p className="text-sm m-0 mb-2">Entries vs Exits Over Time</p>
                  <p className="text-sm text-fms-text-secondary m-0">No chart data available for selected filters.</p>
                </>
              ) : (
                <EntriesExitsAreaChart
                  title="Entries vs Exits Over Time"
                  entriesLabel="Entries"
                  exitsLabel="Exits"
                  data={entriesExitsAreaData}
                />
              )}
            </section>

            <section className="rounded-2xl border border-fms-border bg-fms-surface p-4">
              <p className="text-sm m-0 mb-2">Current Count by Location</p>
              {byLocationAreaData.length === 0 ? (
                <p className="text-sm text-fms-text-secondary m-0">No chart data available for selected filters.</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={byLocationAreaData}>
                    <defs>
                      <linearGradient id="locationCountGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.34} />
                        <stop offset="100%" stopColor="#14b8a6" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="locationName" />
                    <YAxis />
                    <Tooltip />
                    <Area type="monotone" dataKey="currentCount" stroke="#14b8a6" fill="url(#locationCountGradient)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </section>
          </div>
        )}

        <section className="rounded-2xl border border-fms-border bg-fms-surface p-4">
          <div className="flex items-center justify-between"><h3 className="m-0 text-base">Table</h3><button type="button" onClick={() => { const next = !tableOpen; setTableOpen(next); window.localStorage.setItem(TABLE_KEY, String(next)); }} className="inline-flex items-center gap-1 text-sm">{tableOpen ? "Collapse" : "Expand"}{tableOpen ? <IconChevronDown className="w-4 h-4" /> : <IconChevronRight className="w-4 h-4" />}</button></div>
          {tableOpen && (
            <div className="mt-4 overflow-x-auto">
              {loading ? (
                <p className="text-sm text-fms-text-secondary m-0">Loading people count data...</p>
              ) : tableRows.length === 0 ? (
                <p className="text-sm text-fms-text-secondary m-0">No data available for selected filters.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-fms-border">
                      <th className="text-left py-2 pr-3">Location / Zone</th>
                      <th className="text-left py-2 pr-3">Zones</th>
                      <th className="text-left py-2 pr-3">Current Count</th>
                      <th className="text-left py-2 pr-3">Total Entries</th>
                      <th className="text-left py-2 pr-3">Total Exits</th>
                      <th className="text-left py-2">Last Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row) => (
                      <Fragment key={row.locationId}>
                        <tr key={row.locationId} className="border-b border-fms-border">
                          <td className="py-2 pr-3 font-medium text-fms-text">
                            <button type="button" className="mr-2 text-fms-text-secondary" onClick={() => setExpanded((prev) => ({ ...prev, [row.locationId]: !prev[row.locationId] }))}>
                              {expanded[row.locationId] ? "▼" : "▶"}
                            </button>
                            {row.locationName}
                          </td>
                          <td className="py-2 pr-3 text-fms-text-secondary">{row.zonesCount} zones</td>
                          <td className="py-2 pr-3 tabular-nums">{row.currentCount}</td>
                          <td className="py-2 pr-3 tabular-nums">{row.totalEntries}</td>
                          <td className="py-2 pr-3 tabular-nums">{row.totalExits}</td>
                          <td className="py-2 text-fms-text-secondary">{formatTime(row.lastUpdated)}</td>
                        </tr>
                        {expanded[row.locationId] && row.zones.map((zone) => (
                          <tr key={zone.zoneId} className="border-b border-fms-border/50 bg-fms-bg-subtle/20">
                            <td className="py-2 pr-3 pl-8 text-fms-text-secondary">↳ {zone.zoneName}</td>
                            <td className="py-2 pr-3 text-fms-text-tertiary">-</td>
                            <td className="py-2 pr-3 tabular-nums">{zone.currentCount}</td>
                            <td className="py-2 pr-3 tabular-nums">{zone.totalEntries}</td>
                            <td className="py-2 pr-3 tabular-nums">{zone.totalExits}</td>
                            <td className="py-2 text-fms-text-secondary">{formatTime(zone.lastUpdated)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
