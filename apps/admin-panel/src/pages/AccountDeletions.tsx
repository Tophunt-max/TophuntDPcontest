import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DeletionRequestStatus } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber, truncate } from "@/lib/format";
import { AlertTriangle, Clock, Trash2, Undo2, CheckCircle2 } from "lucide-react";

/**
 * Account deletions.
 *
 * `account_deletions` has existed since migration 0030 and nothing ever read it.
 * That made three operationally important questions unanswerable: how many people
 * are leaving, what they say on the way out, and — the one that actually breaks
 * things — whether a purge is stuck.
 *
 * The last one matters most. A purge spans D1, R2, Bunny, KV and Firebase, and it
 * runs from cron, so a failure produces no HTTP error for anyone to see: the
 * worker's error logging deliberately skips 4xx, and a cron failure only writes a
 * console line. A deletion that stalls mid-phase would sit there silently while
 * the user believes their data is gone. `overdue` and `failing` below are that
 * alarm, and the phase column says exactly where it stopped.
 */

const STATUS_FILTERS: { label: string; value: DeletionRequestStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
];

const statusVariant = (status: string): "primary" | "success" | "danger" | "warning" => {
  if (status === "completed") return "success";
  if (status === "cancelled") return "primary";
  if (status === "processing") return "warning";
  return "danger";
};

const DEFERRAL_LABELS: Record<string, string> = {
  pending_payout: "Payout in flight",
  active_contest: "Contest unfinished",
};

export default function AccountDeletions() {
  const [status, setStatus] = useState<DeletionRequestStatus | "">("");
  const q = useQuery({
    queryKey: ["account-deletions", status],
    queryFn: () => api.accountDeletions({ status: status || undefined, limit: 200 }),
    // Purge health is time-sensitive: a stuck deletion is a compliance clock.
    refetchInterval: 60_000,
  });

  const stats = q.data?.stats;
  const needsAttention = (stats?.overdue ?? 0) > 0 || (stats?.failing ?? 0) > 0;

  return (
    <div>
      <PageHeader
        title="Account Deletions"
        subtitle="Deletion requests, grace periods, and purge health"
      />

      {/* Purge health first. Everything else on this page is reporting; this is
          the only part that can require action. */}
      {needsAttention && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-red-900 text-sm">Purges need attention</p>
            <p className="text-xs text-red-800 mt-0.5">
              {(stats?.overdue ?? 0) > 0 && (
                <>
                  {fmtNumber(stats?.overdue)} request(s) are past their scheduled date and not yet
                  erased.{" "}
                </>
              )}
              {(stats?.failing ?? 0) > 0 && (
                <>{fmtNumber(stats?.failing)} request(s) recorded an error.</>
              )}{" "}
              Check the phase and error columns below — the sweep retries five times, then stops.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatTile
          icon={<Clock size={15} className="text-amber-600" />}
          label="In grace period"
          value={fmtNumber(stats?.pending)}
        />
        <StatTile
          icon={<Trash2 size={15} className="text-red-600" />}
          label="Purging now"
          value={fmtNumber(stats?.processing)}
        />
        <StatTile
          icon={<CheckCircle2 size={15} className="text-emerald-600" />}
          label="Erased"
          value={fmtNumber(stats?.completed)}
        />
        <StatTile
          icon={<Undo2 size={15} className="text-sky-600" />}
          label="Cancelled"
          value={fmtNumber(stats?.cancelled)}
        />
        <StatTile
          icon={<span className="text-xs font-bold text-muted-foreground">🪙</span>}
          label="Coins forfeited"
          value={fmtNumber(stats?.forfeitedCoinsTotal)}
        />
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value || "all"}
            onClick={() => setStatus(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
              status === f.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Table
        loading={q.isLoading}
        data={q.data?.requests ?? []}
        keyFn={(r) => r.uid}
        empty="No deletion requests"
        columns={[
          {
            key: "uid",
            header: "Account",
            render: (r) => <span className="font-mono text-xs">{r.uid}</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (r) => (
              <div className="flex items-center gap-1.5">
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                {r.isOverdue && <Badge variant="danger">overdue</Badge>}
              </div>
            ),
          },
          {
            key: "requested",
            header: "Requested",
            render: (r) => (
              <span className="text-muted-foreground">{fmtDateTime(r.requestedAt)}</span>
            ),
          },
          {
            key: "scheduled",
            header: "Erase on",
            render: (r) => (
              <span className={r.isOverdue ? "text-red-600 font-semibold" : "text-muted-foreground"}>
                {fmtDateTime(r.scheduledFor)}
              </span>
            ),
          },
          {
            key: "waiting",
            header: "Waiting on",
            render: (r) =>
              r.deferredReason ? (
                <Badge variant="warning">
                  {DEFERRAL_LABELS[r.deferredReason] ?? r.deferredReason}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          {
            key: "phase",
            header: "Phase",
            render: (r) => (
              <span className="text-xs font-mono text-muted-foreground">
                {r.phase ?? (r.status === "pending" ? "not started" : "—")}
                {r.attempts > 1 ? ` (${r.attempts} tries)` : ""}
              </span>
            ),
          },
          {
            key: "coins",
            header: "Coins",
            render: (r) => <span className="text-muted-foreground">{fmtNumber(r.balanceAtRequest)}</span>,
          },
          {
            key: "reason",
            header: "Reason given",
            render: (r) => (
              <span className="text-xs text-muted-foreground" title={r.reason ?? ""}>
                {r.reason ? truncate(r.reason, 60) : "—"}
              </span>
            ),
          },
          {
            key: "error",
            header: "Last error",
            render: (r) =>
              r.lastError ? (
                <span className="text-xs text-red-600" title={r.lastError}>
                  {truncate(r.lastError, 60)}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]}
      />
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-bold text-foreground">{value}</p>
    </div>
  );
}
