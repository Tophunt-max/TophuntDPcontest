import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber, exportCsv } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Check, X, BadgeCheck, Download, Banknote, Coins, IndianRupee, Hourglass } from "lucide-react";
import { SegTabs, UserCell, MethodBadge, ActionBtn } from "@/components/finance/bits";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Paid" },
  { key: "rejected", label: "Rejected" },
  { key: "", label: "All" },
];

export default function Withdrawals() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("pending");

  const { data = [], isLoading } = useQuery({
    queryKey: ["withdrawals", tab],
    queryFn: () => api.withdrawals(tab || undefined),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["withdrawals"] });

  const stats = useMemo(() => {
    const dp = data.reduce((s: number, w: any) => s + (Number(w.amount) || 0), 0);
    const cash = data.reduce((s: number, w: any) => s + (Number(w.cashAmount) || 0), 0);
    const pending = data.filter((w: any) => w.status === "pending").length;
    return { count: data.length, dp, cash, pending };
  }, [data]);

  const actionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "approve" | "reject" | "paid"; note?: string }) =>
      api.actionWithdrawal(id, action, note),
    onSuccess: () => { toast.success("Withdrawal updated"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Withdrawals"
        subtitle="Cash payout requests"
        action={
          <button
            onClick={() => exportCsv(`withdrawals-${Date.now()}.csv`, data, ["id", "userId", "username", "amount", "cashAmount", "method", "accountDetails", "status", "createdAt"])}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
          >
            <Download size={15} /> Export CSV
          </button>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Banknote} label={`Requests (${tab || "all"})`} value={fmtNumber(stats.count)} gradient="gradient-blue" />
        <StatCard icon={Coins} label="DP to pay out" value={fmtNumber(stats.dp)} gradient="gradient-purple" />
        <StatCard icon={IndianRupee} label="Cash payout" value={`₹${fmtNumber(stats.cash)}`} gradient="gradient-green" />
        <StatCard icon={Hourglass} label="Pending" value={fmtNumber(stats.pending)} gradient="gradient-orange" />
      </div>

      <SegTabs tab={tab} setTab={setTab} tabs={TABS} />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(w: any) => w.id}
        empty="No withdrawal requests"
        columns={[
          {
            key: "user",
            header: "User",
            render: (w: any) => <UserCell name={w.fullName || w.username || w.userId} sub={`Balance: ${fmtNumber(w.balance)} DP`} />,
          },
          {
            key: "amount",
            header: "Amount",
            render: (w: any) => (
              <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                <Coins size={14} className="text-amber-500" />{fmtNumber(w.amount)} <span className="text-xs font-medium text-muted-foreground">DP</span>
              </span>
            ),
          },
          { key: "cash", header: "Cash", render: (w: any) => <span className="font-medium">{w.cashAmount ? `₹${fmtNumber(w.cashAmount)}` : "—"}</span> },
          { key: "method", header: "Method", render: (w: any) => <MethodBadge method={w.method} /> },
          { key: "account", header: "Account", render: (w: any) => <span className="text-xs text-muted-foreground font-mono">{w.accountDetails || "—"}</span> },
          { key: "status", header: "Status", render: (w: any) => <Badge variant={w.status === "approved" ? "success" : w.status === "paid" ? "paid" : w.status === "rejected" ? "danger" : "pending"}>{w.status}</Badge> },
          { key: "date", header: "Requested", render: (w: any) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateTime(w.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (w: any) => (
              <div className="flex items-center justify-end gap-1.5">
                {w.status === "pending" && (
                  <>
                    <ActionBtn tone="green" title="Approve" onClick={async () => {
                      if (await confirm({ title: "Approve payout?", description: `${w.amount} DP will be deducted from the user's balance.` }))
                        actionMut.mutate({ id: w.id, action: "approve" });
                    }}><Check size={14} /> Approve</ActionBtn>
                    <ActionBtn tone="red" title="Reject" onClick={async () => {
                      if (await confirm({ title: "Reject request?", description: "The request will be rejected.", variant: "destructive" }))
                        actionMut.mutate({ id: w.id, action: "reject" });
                    }}><X size={14} /> Reject</ActionBtn>
                  </>
                )}
                {w.status === "approved" && (
                  <ActionBtn tone="blue" title="Mark as paid" onClick={async () => {
                    if (await confirm({ title: "Mark as paid?", description: "Confirm the payout has been sent to the user." }))
                      actionMut.mutate({ id: w.id, action: "paid" });
                  }}><BadgeCheck size={14} /> Paid</ActionBtn>
                )}
                {(w.status === "paid" || w.status === "rejected") && <span className="text-xs text-muted-foreground">—</span>}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
