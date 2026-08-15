import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Check, X, QrCode, Save, Copy } from "lucide-react";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "", label: "All" },
];

export default function Deposits() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("pending");

  const { data = [], isLoading } = useQuery({
    queryKey: ["deposits", tab],
    queryFn: () => api.deposits(tab || undefined),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["deposits"] });

  const actionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "approve" | "reject"; note?: string }) =>
      api.actionDeposit(id, action, note),
    onSuccess: () => { toast.success("Deposit updated"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Deposits" subtitle="Payment gateway & manual top-up approvals" />

      <GatewayConfig />

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
        keyFn={(d: any) => d.id}
        empty="No deposit requests"
        columns={[
          {
            key: "user",
            header: "User",
            render: (d: any) => (
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{d.fullName || d.username || d.userId}</p>
                <p className="text-xs text-muted-foreground truncate">{d.userId}</p>
              </div>
            ),
          },
          { key: "amount", header: "Coins", render: (d: any) => <span className="font-bold">{fmtNumber(d.amount)}</span> },
          { key: "pay", header: "Paid", render: (d: any) => <span>{d.payAmount ? `₹${fmtNumber(d.payAmount)}` : "—"}</span> },
          { key: "method", header: "Method", render: (d: any) => <Badge variant="info">{d.method}</Badge> },
          {
            key: "utr",
            header: "UTR / Ref",
            render: (d: any) => (
              <span className="font-mono text-xs flex items-center gap-1">
                {d.utr || "—"}
                {d.utr && <button title="Copy" onClick={() => navigator.clipboard?.writeText(d.utr)} className="text-muted-foreground hover:text-foreground"><Copy size={12} /></button>}
              </span>
            ),
          },
          {
            key: "proof",
            header: "Proof",
            render: (d: any) => (d.screenshotUrl ? <a href={d.screenshotUrl} target="_blank" rel="noreferrer" className="text-violet-600 text-xs underline">view</a> : <span className="text-muted-foreground">—</span>),
          },
          { key: "status", header: "Status", render: (d: any) => <Badge variant={d.status === "approved" ? "success" : d.status === "rejected" ? "danger" : "pending"}>{d.status}</Badge> },
          { key: "date", header: "Requested", render: (d: any) => <span className="text-muted-foreground">{fmtDateTime(d.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (d: any) => (
              <div className="flex items-center justify-end gap-1">
                {d.status === "pending" && (
                  <>
                    <IconBtn title="Approve & credit coins" onClick={async () => {
                      if (await confirm({ title: "Approve deposit?", description: `Verify UTR "${d.utr}" in your bank, then credit ${d.amount} coins.` }))
                        actionMut.mutate({ id: d.id, action: "approve" });
                    }}><Check size={15} className="text-green-600" /></IconBtn>
                    <IconBtn title="Reject" onClick={async () => {
                      if (await confirm({ title: "Reject deposit?", description: "The request will be rejected. No coins credited.", variant: "destructive" }))
                        actionMut.mutate({ id: d.id, action: "reject" });
                    }}><X size={15} className="text-red-600" /></IconBtn>
                  </>
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

type Gateway = { mode: string; qrImageUrl: string; upiId: string; coinRate: number; note: string };
const GW_DEFAULT: Gateway = { mode: "auto", qrImageUrl: "", upiId: "", coinRate: 1, note: "" };

function GatewayConfig() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [gw, setGw] = useState<Gateway>(GW_DEFAULT);

  useEffect(() => {
    if (data?.paymentGateway) setGw({ ...GW_DEFAULT, ...data.paymentGateway });
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveAppSettings({ paymentGateway: gw }),
    onSuccess: () => { toast.success("Payment gateway saved"); qc.invalidateQueries({ queryKey: ["app-settings"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  const manual = gw.mode === "manual" || gw.mode === "both";

  return (
    <div className="bg-card border border-border rounded-2xl p-5 mb-6">
      <h3 className="font-bold text-foreground mb-1 flex items-center gap-2"><QrCode size={16} className="text-violet-600" /> Payment Gateway</h3>
      <p className="text-xs text-muted-foreground mb-4">Choose how users top up. Auto = Razorpay; Manual = your QR/UPI with UTR approval.</p>

      <div className="flex gap-2 mb-4">
        {[
          { k: "auto", l: "Auto (Razorpay)" },
          { k: "manual", l: "Manual (QR/UPI)" },
          { k: "both", l: "Both" },
        ].map((m) => (
          <button
            key={m.k}
            onClick={() => setGw({ ...gw, mode: m.k })}
            className={`px-4 py-2 rounded-xl text-sm font-medium ${gw.mode === m.k ? "gradient-purple text-white" : "bg-secondary text-foreground"}`}
          >
            {m.l}
          </button>
        ))}
      </div>

      {manual && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">QR image URL</label>
            <input className={field} placeholder="https://…/qr.png" value={gw.qrImageUrl} onChange={(e) => setGw({ ...gw, qrImageUrl: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">UPI ID</label>
            <input className={field} placeholder="yourname@upi" value={gw.upiId} onChange={(e) => setGw({ ...gw, upiId: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Coin rate (₹ per coin)</label>
            <input type="number" step="0.01" className={field} value={gw.coinRate} onChange={(e) => setGw({ ...gw, coinRate: Number(e.target.value) })} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Instructions (shown to user)</label>
            <input className={field} placeholder="Pay to the QR and enter UTR" value={gw.note} onChange={(e) => setGw({ ...gw, note: e.target.value })} />
          </div>
          {gw.qrImageUrl ? <img src={gw.qrImageUrl} alt="QR preview" className="w-28 h-28 object-contain rounded-xl border border-border bg-white p-1" /> : null}
        </div>
      )}

      <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50">
        <Save size={15} /> Save Gateway
      </button>
    </div>
  );
}
