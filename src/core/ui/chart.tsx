"use client";

import * as React from "react";
import { ResponsiveContainer, Tooltip, type TooltipProps } from "recharts";

export type ChartConfig = Record<
  string,
  {
    label?: string;
    color?: string;
  }
>;

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig;
  className?: string;
  children: React.ReactNode;
}) {
  const style = Object.entries(config).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value.color) acc[`--color-${key}`] = value.color;
    return acc;
  }, {});

  return (
    <div className={cx("w-full h-full", className)} style={style}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export function ChartTooltip(props: TooltipProps<number, string>) {
  return <Tooltip cursor={{ stroke: "var(--fms-border)" }} {...props} />;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string | number;
  hideLabel?: boolean;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-fms-border bg-fms-surface px-3 py-2 shadow-md">
      {!hideLabel ? <div className="mb-1 text-xs font-medium text-fms-text">{label}</div> : null}
      <div className="space-y-1">
        {payload.map((item, idx) => (
          <div key={`${item.name ?? "row"}-${idx}`} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ background: item.color || "var(--fms-text-tertiary)" }} />
            <span className="text-fms-text-secondary">{item.name}</span>
            <span className="ml-auto font-semibold text-fms-text tabular-nums">{item.value ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
