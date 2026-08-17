import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { AlertOctagon, RefreshCw, Trash2, ServerCrash } from "lucide-react";

const LEVELS = ["all", "error", "warn"] as const;
type Level = (typeof LEVELS)[number];

export default function Logs() {
  const qc = useQueryClient();
  const [level, setLevel] = useState<Level>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [clearing, setClearing] = useState(false);

  const stats = useQuery({ queryKey: ["logs-stats"], queryFn: api.logStats });
  const logs = useQuery({
    queryKey: ["logs", level, search],
    queryFn: () => api.logs({ level: level === "all" ? undefined : level, q: search || undefined, limit: 200 }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["logs"] });
    qc.invalidateQueries({ queryKey: ["logs-stats"] });
  };

  const clearAll = async () => {
    if (!window.confirm("Delete ALL stored error logs? This cannot be undone.")) return;
    setClearing(true);
    try {
      await api.clearLogs();
      refresh();
    } catch (e: any) {
      window.alert(e?.message || "Failed to clear logs.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <PageHeader title="Error Logs" subtitle="Server errors from the API worker (last 14 days)" />

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <ServerCrash size={14} /> Errors (24h)
          </div>
          <div className="text-2xl font-bold text-foreground">{stats.data ? fmtNumber(stats.data.last24h) : "—"}</div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <AlertOctagon size={14} /> Total stored
          </div>
          <div className="text-2xl font-bold text-foreground">{stats.data ? fmtNumber(stats.data.total) : "—"}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1 bg-muted/40 rounded-lg p-1">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-colors ${
                level === l ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}
          className="flex-1 min-w-[180px]"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search message… (press Enter)"
            className="w-full h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground outline-none focus:border-primary"
          />
        </form>
        <button
          onClick={refresh}
          className="h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground flex items-center gap-1.5 hover:bg-muted/40"
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          onClick={clearAll}
          disabled={clearing}
          className="h-9 px-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-600 flex items-center gap-1.5 hover:bg-red-100 disabled:opacity-50"
        >
          <Trash2 size={14} /> {clearing ? "Clearing…" : "Clear all"}
        </button>
      </div>

      <Table
        loading={logs.isLoading}
        data={logs.data ?? []}
        keyFn={(l: any) => l.id}
        empty="No errors logged 🎉"
        columns={[
          { key: "when", header: "When", render: (l: any) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateTime(l.createdAt)}</span> },
          {
            key: "level",
            header: "Level",
            render: (l: any) => <Badge variant={l.level === "error" ? "danger" : "warning"}>{l.level}</Badge>,
          },
          { key: "status", header: "Status", render: (l: any) => <span className="font-mono text-xs">{l.status ?? "—"}</span> },
          {
            key: "endpoint",
            header: "Endpoint",
            render: (l: any) => (
              <span className="font-mono text-xs text-muted-foreground">
                {l.method ? <span className="text-foreground">{l.method} </span> : null}
                {l.path || "—"}
              </span>
            ),
          },
          {
            key: "message",
            header: "Message",
            render: (l: any) => (
              <details className="max-w-xl">
                <summary className="cursor-pointer text-sm text-foreground truncate">{l.message}</summary>
                {l.stack ? (
                  <pre className="mt-2 p-3 rounded-lg bg-muted/50 text-[11px] leading-relaxed text-muted-foreground overflow-auto whitespace-pre-wrap max-h-64">
                    {l.stack}
                  </pre>
                ) : null}
                {l.requestId ? (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    requestId: <span className="font-mono">{l.requestId}</span>
                  </div>
                ) : null}
              </details>
            ),
          },
        ]}
      />
    </div>
  );
}
