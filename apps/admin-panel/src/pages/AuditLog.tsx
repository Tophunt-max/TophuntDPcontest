import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { ShieldAlert, AlertTriangle } from "lucide-react";

export default function AuditLog() {
  const audit = useQuery({ queryKey: ["audit-log"], queryFn: () => api.auditLog() });
  const fraud = useQuery({ queryKey: ["fraud-votes"], queryFn: api.fraudVotes });

  return (
    <div>
      <PageHeader title="Audit & Security" subtitle="Admin activity trail and vote-fraud signals" />

      {/* Fraud detection */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-1 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-500" /> Suspicious Devices
        </h3>
        <p className="text-xs text-muted-foreground mb-4">Devices used by more than one voter account (possible vote stuffing)</p>
        {fraud.isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : (fraud.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No suspicious activity detected 🎉</p>
        ) : (
          <div className="space-y-2 max-h-52 overflow-auto">
            {fraud.data!.map((f) => (
              <div key={f.deviceId} className="flex items-center gap-3 p-2.5 rounded-lg bg-amber-50/60 border border-amber-100">
                <ShieldAlert size={15} className="text-amber-600 flex-shrink-0" />
                <span className="text-xs font-mono text-foreground flex-1 truncate">{f.deviceId}</span>
                <Badge variant="danger">{f.accounts} accounts</Badge>
                <span className="text-xs text-muted-foreground">{fmtNumber(f.totalVotes)} votes</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Audit trail */}
      <h3 className="font-bold text-foreground mb-3">Admin Activity</h3>
      <Table
        loading={audit.isLoading}
        data={audit.data ?? []}
        keyFn={(a: any) => a.id}
        empty="No admin actions recorded yet"
        columns={[
          { key: "action", header: "Action", render: (a: any) => <Badge variant="primary">{a.action}</Badge> },
          {
            key: "target",
            header: "Target",
            render: (a: any) => (
              <span className="text-sm">
                {a.targetType ? <span className="text-muted-foreground">{a.targetType}: </span> : null}
                <span className="font-mono text-xs">{a.targetId || "—"}</span>
              </span>
            ),
          },
          { key: "admin", header: "By", render: (a: any) => <span className="text-muted-foreground">{a.adminEmail || a.adminUid || "—"}</span> },
          {
            key: "detail",
            header: "Detail",
            render: (a: any) => <span className="text-xs text-muted-foreground">{a.detail ? JSON.stringify(a.detail) : "—"}</span>,
          },
          { key: "date", header: "When", render: (a: any) => <span className="text-muted-foreground">{fmtDateTime(a.createdAt)}</span> },
        ]}
      />
    </div>
  );
}
