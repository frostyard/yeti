import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right";
}

export function DataTable<T>({ columns, rows, rowKey, empty, onRowClick }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-layer/60">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn("section-label whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold", c.align === "right" && "text-right", c.className)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn("border-b border-border/60 last:border-0 transition-colors hover:bg-layer/40", onRowClick && "cursor-pointer")}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn("px-3 py-2 align-middle", c.align === "right" && "text-right", c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
