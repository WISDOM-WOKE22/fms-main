"use client";

export interface KpiCardProps {
  title: string;
  value: string | number;
  icon?: React.ReactNode;
}

export default function KpiCard({ title, value, icon }: KpiCardProps) {
  return (
    <div className="rounded-2xl bg-fms-surface border border-fms-border p-6 flex flex-col gap-2 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-fms-text-secondary">{title}</span>
        {icon ? <span className="shrink-0 text-fms-text-tertiary">{icon}</span> : null}
      </div>
      <p className="text-[2rem] font-bold text-fms-text m-0 tabular-nums leading-tight">{value}</p>
    </div>
  );
}
