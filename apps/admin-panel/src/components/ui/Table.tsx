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

export function Table<T>({ columns, data, loading, empty = 'No data', keyFn }: TableProps<T>) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
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
                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">Loading...</span>
                </div>
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
    </div>
  );
}
