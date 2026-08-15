import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber, exportCsv } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Check, X, BadgeCheck, Download } from "lucide-react";

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
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70"
          >
            <Download size={15} /> Export CSV
          </button>
        }
      />

      <div className="flex gap-1 mb-4 bg-secondary/50 p-1 rounded-xl w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === t.key ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Table
        loading={isLoading}
        data={data}
        keyFn={(w: any) => w.id}
        empty="No withdrawal requests"
        columns={[
          {
            key: "user",
            header: "User",
            render: (w: any) => (
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{w.fullName || w.username || w.userId}</p>
                <p className="text-xs text-muted-foreground truncate">Balance: {fmtNumber(w.balance)} DP</p>
              </div>
            ),
          },
          { key: "amount", header: "Amount", render: (w: any) => <span className="font-bold">{fmtNumber(w.amount)} DP</span> },
          { key: "cash", header: "Cash", render: (w: any) => <span>{w.cashAmount ? `₹${fmtNumber(w.cashAmount)}` : "—"}</span> },
          { key: "method", header: "Method", render: (w: any) => <Badge variant="info">{w.method}</Badge> },
          { key: "account", header: "Account", render: (w: any) => <span className="text-xs text-muted-foreground">{w.accountDetails || "—"}</span> },
          { key: "status", header: "Status", render: (w: any) => <Badge variant={w.status === "approved" ? "success" : w.status === "paid" ? "paid" : w.status === "rejected" ? "danger" : "pending"}>{w.status}</Badge> },
          { key: "date", header: "Requested", render: (w: any) => <span className="text-muted-foreground">{fmtDateTime(w.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (w: any) => (
              <div className="flex items-center justify-end gap-1">
                {w.status === "pending" && (
                  <>
                    <IconBtn title="Approve" onClick={async () => {
                      if (await confirm({ title: "Approve payout?", description: `${w.amount} DP will be deducted from the user's balance.` }))
                        actionMut.mutate({ id: w.id, action: "approve" });
                    }}><Check size={15} className="text-green-600" /></IconBtn>
                    <IconBtn title="Reject" onClick={async () => {
                      if (await confirm({ title: "Reject request?", description: "The request will be rejected.", variant: "destructive" }))
                        actionMut.mutate({ id: w.id, action: "reject" });
                    }}><X size={15} className="text-red-600" /></IconBtn>
                  </>
                )}
                {w.status === "approved" && (
                  <IconBtn title="Mark as paid" onClick={async () => {
                    if (await confirm({ title: "Mark as paid?", description: "Confirm the payout has been sent to the user." }))
                      actionMut.mutate({ id: w.id, action: "paid" });
                  }}><BadgeCheck size={15} className="text-blue-600" /></IconBtn>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function IconBtn({ children, title, onClick }: any) {
  return (
    <button title={title} onClick={onClick} className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
      {children}
    </button>
  );
}
