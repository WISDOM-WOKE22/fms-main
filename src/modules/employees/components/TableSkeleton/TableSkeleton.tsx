"use client";

export interface TableSkeletonProps {
  rows?: number;
  cols?: number;
  showCheckbox?: boolean;
}

export default function TableSkeleton({
  rows = 10,
  cols = 7,
  showCheckbox = true,
}: TableSkeletonProps) {
  return (
    <div className="animate-pulse">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-fms-border">
            {showCheckbox && (
              <th className="w-10 py-3 px-4">
                <div className="h-4 w-4 rounded-2xl bg-fms-bg-subtle" />
              </th>
            )}
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i} className="text-left py-3 px-4">
                <div className="h-3.5 w-16 rounded-2xl bg-fms-bg-subtle" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIdx) => (
            <tr key={rowIdx} className="border-b border-fms-border last:border-b-0">
              {showCheckbox && (
                <td className="py-3 px-4">
                  <div className="h-4 w-4 rounded-2xl bg-fms-bg-subtle" />
                </td>
              )}
              {Array.from({ length: cols }).map((_, colIdx) => (
                <td key={colIdx} className="py-3 px-4">
                  <div
                    className="h-4 rounded-2xl bg-fms-bg-subtle"
                    style={{ width: colIdx === 0 ? 120 : colIdx === cols - 1 ? 80 : 72 }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
