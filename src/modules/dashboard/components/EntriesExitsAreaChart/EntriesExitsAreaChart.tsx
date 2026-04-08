"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface ChartTooltipPayloadItem {
  dataKey?: string;
  value?: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: string | number;
  entriesLabel: string;
  exitsLabel: string;
}

export type TimeRange = "hourly" | "daily" | "weekly" | "monthly";

export interface EntriesExitsDataPoint {
  date: string;
  entries: number;
  exits: number;
}

const ENTRIES_COLOR = "#10b981";
const ENTRIES_FILL = "rgba(16, 185, 129, 0.28)";
const EXITS_COLOR = "#3b82f6";
const EXITS_FILL = "rgba(59, 130, 246, 0.28)";

export interface EntriesExitsAreaChartProps {
  data?: EntriesExitsDataPoint[];
  timeRange?: TimeRange;
  onTimeRangeChange?: (range: TimeRange) => void;
  entriesLabel: string;
  exitsLabel: string;
  title: string;
}

function ChartTooltip({
  active,
  payload,
  label,
  entriesLabel,
  exitsLabel,
}: ChartTooltipProps) {
  if (!active || !payload?.length || !label) return null;
  const entriesEntry = payload.find((p) => p.dataKey === "entries");
  const exitsEntry = payload.find((p) => p.dataKey === "exits");
  return (
    <div
      className="rounded-2xl border border-fms-border bg-fms-surface-solid px-4 py-3 shadow-lg"
      style={{ boxShadow: "var(--fms-shadow-md)" }}
    >
      <div className="text-sm font-medium text-fms-text mb-2.5">{label}</div>
      <div className="flex flex-col gap-1.5">
        {entriesEntry != null && (
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: ENTRIES_COLOR }}
              aria-hidden
            />
            <span className="text-sm text-fms-text-secondary">{entriesLabel}:</span>
            <span className="text-sm font-semibold text-fms-text tabular-nums">{entriesEntry.value}</span>
          </div>
        )}
        {exitsEntry != null && (
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: EXITS_COLOR }}
              aria-hidden
            />
            <span className="text-sm text-fms-text-secondary">{exitsLabel}:</span>
            <span className="text-sm font-semibold text-fms-text tabular-nums">{exitsEntry.value}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function EntriesExitsAreaChart({
  data = [],
  timeRange = "daily",
  onTimeRangeChange,
  entriesLabel,
  exitsLabel,
  title,
}: EntriesExitsAreaChartProps) {
  const ranges: { key: TimeRange; label: string }[] = [
    { key: "hourly", label: "Hourly" },
    { key: "daily", label: "Daily" },
    { key: "weekly", label: "Weekly" },
    { key: "monthly", label: "Monthly" },
  ];

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <h2 className="text-base font-semibold text-fms-text m-0">{title}</h2>
        {onTimeRangeChange && (
          <div className="flex items-center gap-1 p-1 rounded-2xl bg-fms-bg-subtle border border-fms-border">
            {ranges.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => onTimeRangeChange(key)}
                className={`px-3 py-1.5 rounded-2xl text-sm font-medium transition-colors ${
                  timeRange === key
                    ? "bg-fms-surface text-fms-text shadow-sm border border-fms-border"
                    : "text-fms-text-tertiary hover:text-fms-text-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-fms-bg-subtle border border-fms-border p-4 sm:p-5">
        <ResponsiveContainer width="100%" height={380}>
          <AreaChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="entriesGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ENTRIES_COLOR} stopOpacity={0.4} />
                <stop offset="100%" stopColor={ENTRIES_COLOR} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="exitsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EXITS_COLOR} stopOpacity={0.4} />
                <stop offset="100%" stopColor={EXITS_COLOR} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--fms-border)"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              axisLine={{ stroke: "var(--fms-border)" }}
              tickLine={false}
              tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
              dy={8}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--fms-text-tertiary)", fontSize: 11 }}
              width={28}
              tickFormatter={(v) => String(v)}
            />
            <Tooltip
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={payload}
                  label={label}
                  entriesLabel={entriesLabel}
                  exitsLabel={exitsLabel}
                />
              )}
            />
            <Legend
              verticalAlign="bottom"
              height={36}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ paddingTop: 16 }}
              formatter={(value) => (
                <span style={{ color: "var(--fms-text-secondary)", fontSize: 13 }}>
                  {value}
                </span>
              )}
            />
            <Area
              type="monotone"
              dataKey="entries"
              name={entriesLabel}
              stroke={ENTRIES_COLOR}
              strokeWidth={2}
              fill="url(#entriesGradient)"
              isAnimationActive
              animationDuration={600}
              animationEasing="ease-out"
            />
            <Area
              type="monotone"
              dataKey="exits"
              name={exitsLabel}
              stroke={EXITS_COLOR}
              strokeWidth={2}
              fill="url(#exitsGradient)"
              isAnimationActive
              animationDuration={600}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
