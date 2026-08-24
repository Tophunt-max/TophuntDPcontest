import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
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

  // The withdrawal being marked as paid, plus its bank reference.
  const [payFor, setPayFor] = useState<any | null>(null);
  const [payoutRef, setPayoutRef] = useState("");

  const actionMut = useMutation({
    mutationFn: ({ id, action, note, payoutRef }: { id: string; action: "approve" | "reject" | "paid"; note?: string; payoutRef?: string }) =>
      api.actionWithdrawal(id, action, note, payoutRef),
    onSuccess: () => { toast.success("Withdrawal updated"); setPayFor(null); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Withdrawals"
        subtitle="Cash payout requests"
        action={
          <button
            onClick={() => exportCsv(`withdrawals-${Date.now()}.csv`, data, ["id", "userId", "username", "amount", "cashAmount", "method", "accountDetails", "status", "payoutRef", "paidAt", "createdAt"])}
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
                  // Marking a payout paid requires the bank reference, so the
                  // transfer can be reconciled against a statement later.
                  <ActionBtn tone="blue" title="Mark as paid" onClick={() => { setPayFor(w); setPayoutRef(""); }}>
                    <BadgeCheck size={14} /> Paid
                  </ActionBtn>
                )}
                {w.status === "paid" && (
                  <span className="text-xs text-muted-foreground font-mono" title="Bank payout reference">
                    {w.payoutRef || "—"}
                  </span>
                )}
                {w.status === "rejected" && <span className="text-xs text-muted-foreground">—</span>}
              </div>
            ),
          },
        ]}
      />

      <Modal open={!!payFor} onClose={() => setPayFor(null)} title="Record the payout">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!payFor) return;
            actionMut.mutate({ id: payFor.id, action: "paid", payoutRef: payoutRef.trim() });
          }}
        >
          <p className="text-sm text-muted-foreground mb-4">
            Paying <span className="font-semibold text-foreground">{fmtNumber(payFor?.amount)} DP</span>
            {payFor?.cashAmount ? <> (₹{fmtNumber(payFor.cashAmount)})</> : null} to{" "}
            <span className="font-mono text-xs">{payFor?.accountDetails || "—"}</span>.
          </p>
          <label className="block text-sm font-medium mb-1.5" htmlFor="payoutRef">
            Bank reference (UTR / RRN)
          </label>
          <input
            id="payoutRef"
            autoFocus
            required
            minLength={4}
            maxLength={64}
            pattern="[A-Za-z0-9._/-]+"
            value={payoutRef}
            onChange={(e) => setPayoutRef(e.target.value)}
            placeholder="e.g. 412345678901"
            className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <p className="text-xs text-muted-foreground mt-2">
            Copy this from the transfer receipt. It must be unique and cannot be changed afterwards.
          </p>
          <div className="flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={() => setPayFor(null)}
              className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={actionMut.isPending || payoutRef.trim().length < 4}
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
            >
              Confirm payout sent
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
