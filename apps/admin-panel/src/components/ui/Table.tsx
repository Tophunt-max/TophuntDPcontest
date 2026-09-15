import { ReactNode } from 'react';

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  empty?: string;
  keyFn?: (row: T) => string;
}

const Spinner = () => (
  <div className="flex items-center justify-center gap-2 text-muted-foreground py-14">
    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    <span className="text-sm">Loading...</span>
  </div>
);

/**
 * Responsive data table.
 *
 * On `sm` and up it is a real `<table>` inside a horizontal-scroll wrapper. Below
 * `sm` a table with 6–10 columns is unreadable — it either scrolls sideways off the
 * screen or squashes to nothing — so each row is re-laid-out as a stacked "label:
 * value" CARD instead, using the same column `header`/`render`. One component, so
 * every admin page (~20 of them) becomes mobile-friendly at once.
 */
export function Table<T>({ columns, data, loading, empty = 'No data', keyFn }: TableProps<T>) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Tablet / desktop: the real table. */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              {columns.map(col => (
                <th key={col.key} className={`text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap ${col.className || ''}`}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.length} className="text-center py-16">
                <Spinner />
              </td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={columns.length} className="text-center py-16 text-muted-foreground text-sm">{empty}</td></tr>
            ) : data.map((row, i) => (
              <tr key={keyFn ? keyFn(row) : i} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                {columns.map(col => (
                  <td key={col.key} className={`px-4 py-3 ${col.className || ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: each row as a stacked card. */}
      <div className="sm:hidden divide-y divide-border">
        {loading ? (
          <Spinner />
        ) : data.length === 0 ? (
          <div className="text-center py-14 text-muted-foreground text-sm">{empty}</div>
        ) : data.map((row, i) => (
          <div key={keyFn ? keyFn(row) : i} className="p-4 space-y-2.5">
            {columns.map(col => (
              <div key={col.key} className="flex items-start justify-between gap-3">
                {col.header ? (
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground pt-0.5 flex-shrink-0">
                    {col.header}
                  </span>
                ) : null}
                <div className="text-sm text-right min-w-0 break-words ml-auto">
                  {col.render(row)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
