import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber, exportCsv } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import {
  Check, X, QrCode, Save, Copy, Download, AlertTriangle,
  Coins, IndianRupee, Hourglass, ShieldAlert, Zap, Layers, Upload, Trash2, Loader2,
} from "lucide-react";
import { SegTabs, UserCell, MethodBadge, ActionBtn } from "@/components/finance/bits";

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

  const stats = useMemo(() => {
    const coins = data.reduce((s: number, d: any) => s + (Number(d.amount) || 0), 0);
    const rupees = data.reduce((s: number, d: any) => s + (Number(d.payAmount) || 0), 0);
    const dups = data.filter((d: any) => d.duplicateUtr).length;
    return { count: data.length, coins, rupees, dups };
  }, [data]);

  const actionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "approve" | "reject"; note?: string }) =>
      api.actionDeposit(id, action, note),
    onSuccess: () => { toast.success("Deposit updated"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Deposits"
        subtitle="Payment gateway & manual top-up approvals"
        action={
          <button
            onClick={() => exportCsv(`deposits-${Date.now()}.csv`, data, ["id", "userId", "username", "amount", "payAmount", "method", "utr", "status", "createdAt"])}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
          >
            <Download size={15} /> Export CSV
          </button>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Hourglass} label={`Requests (${tab || "all"})`} value={fmtNumber(stats.count)} gradient="gradient-orange" />
        <StatCard icon={Coins} label="Coins requested" value={fmtNumber(stats.coins)} gradient="gradient-purple" />
        <StatCard icon={IndianRupee} label="Amount" value={`₹${fmtNumber(stats.rupees)}`} gradient="gradient-green" />
        <StatCard icon={ShieldAlert} label="Duplicate UTRs" value={fmtNumber(stats.dups)} gradient="gradient-red" />
      </div>

      <GatewayConfig />

      <SegTabs tab={tab} setTab={setTab} tabs={TABS} />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(d: any) => d.id}
        empty="No deposit requests"
        columns={[
          {
            key: "user",
            header: "User",
            render: (d: any) => <UserCell name={d.fullName || d.username || d.userId} sub={d.userId} />,
          },
          {
            key: "amount",
            header: "Coins",
            render: (d: any) => (
              <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                <Coins size={14} className="text-amber-500" />{fmtNumber(d.amount)}
                {/* amount already includes the bonus — shown so an approver can
                    see why the coins exceed the base package. */}
                {d.bonusCoins ? <span className="text-green-600 font-semibold">(+{fmtNumber(d.bonusCoins)} bonus)</span> : null}
              </span>
            ),
          },
          { key: "pay", header: "Paid", render: (d: any) => <span className="font-medium">{d.payAmount ? `₹${fmtNumber(d.payAmount)}` : "—"}</span> },
          { key: "method", header: "Method", render: (d: any) => <MethodBadge method={d.method} /> },
          {
            key: "utr",
            header: "UTR / Ref",
            render: (d: any) => (
              <span className="font-mono text-xs flex items-center gap-1">
                {d.utr || "—"}
                {d.utr && <button title="Copy" onClick={() => { navigator.clipboard?.writeText(d.utr); toast.success("UTR copied"); }} className="text-muted-foreground hover:text-foreground"><Copy size={12} /></button>}
                {d.duplicateUtr && (
                  <span title="This UTR is used by more than one deposit!" className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5 font-semibold">
                    <AlertTriangle size={11} /> dup
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "proof",
            header: "Proof",
            render: (d: any) => (d.screenshotUrl ? <a href={d.screenshotUrl} target="_blank" rel="noreferrer" className="text-violet-600 text-xs font-medium underline">view</a> : <span className="text-muted-foreground">—</span>),
          },
          { key: "status", header: "Status", render: (d: any) => <Badge variant={d.status === "approved" ? "success" : d.status === "rejected" ? "danger" : "pending"}>{d.status}</Badge> },
          { key: "date", header: "Requested", render: (d: any) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateTime(d.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (d: any) => (
              <div className="flex items-center justify-end gap-1.5">
                {d.status === "pending" ? (
                  <>
                    <ActionBtn tone="green" title="Approve & credit coins" onClick={async () => {
                      if (await confirm({ title: "Approve deposit?", description: `Verify UTR "${d.utr}" in your bank, then credit ${d.amount} coins.` }))
                        actionMut.mutate({ id: d.id, action: "approve" });
                    }}><Check size={14} /> Approve</ActionBtn>
                    <ActionBtn tone="red" title="Reject" onClick={async () => {
                      if (await confirm({ title: "Reject deposit?", description: "The request will be rejected. No coins credited.", variant: "destructive" }))
                        actionMut.mutate({ id: d.id, action: "reject" });
                    }}><X size={14} /> Reject</ActionBtn>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/* ---------------- payment gateway config ---------------- */

// No coinRate: manual deposits are priced from the coin_packages table, the same
// source the in-app store uses. It used to live here and disagreed with the
// packages (15 coins cost ₹10 as a package but ₹15 through the manual flow).
type Gateway = { mode: string; qrImageUrl: string; upiId: string; note: string };
const GW_DEFAULT: Gateway = { mode: "auto", qrImageUrl: "", upiId: "", note: "" };

const MODES = [
  { k: "auto", l: "Auto", d: "Razorpay", icon: Zap },
  { k: "manual", l: "Manual", d: "QR / UPI", icon: QrCode },
  { k: "both", l: "Both", d: "Auto + Manual", icon: Layers },
];

function GatewayConfig() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [gw, setGw] = useState<Gateway>(GW_DEFAULT);
  const qrInputRef = useRef<HTMLInputElement>(null);
  const [qrUploading, setQrUploading] = useState(false);
  const [qrProgress, setQrProgress] = useState(0);

  const handleQrFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("QR must be a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("QR image is too large (max 5MB).");
      return;
    }
    setQrUploading(true);
    setQrProgress(0);
    try {
      const { publicUrl } = await api.uploadPaymentQr(file, setQrProgress);
      setGw((g) => ({ ...g, qrImageUrl: publicUrl }));
      toast.success("QR uploaded — remember to Save Gateway");
    } catch (err: any) {
      toast.error(err?.message || "QR upload failed");
    } finally {
      setQrUploading(false);
    }
  };

  useEffect(() => {
    if (data?.paymentGateway) setGw({ ...GW_DEFAULT, ...data.paymentGateway });
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveAppSettings({ paymentGateway: gw }),
    onSuccess: () => { toast.success("Payment gateway saved"); qc.invalidateQueries({ queryKey: ["app-settings"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-shadow";
  const manual = gw.mode === "manual" || gw.mode === "both";

  return (
    <div className="bg-card border border-border rounded-2xl p-5 mb-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl gradient-purple flex items-center justify-center shadow-lg">
            <QrCode size={18} className="text-white" />
          </div>
          <div>
            <h3 className="font-bold text-foreground leading-tight">Payment Gateway</h3>
            <p className="text-xs text-muted-foreground">Auto = Razorpay · Manual = your QR/UPI with UTR approval</p>
          </div>
        </div>
        <Badge variant="primary">{MODES.find((m) => m.k === gw.mode)?.l ?? gw.mode} active</Badge>
      </div>

      {/* Mode selector as cards */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {MODES.map((m) => {
          const active = gw.mode === m.k;
          const Icon = m.icon;
          return (
            <button
              key={m.k}
              onClick={() => setGw({ ...gw, mode: m.k })}
              className={`flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-all ${
                active ? "border-violet-500 bg-violet-50 ring-1 ring-violet-500/30" : "border-border bg-background hover:border-violet-300"
              }`}
            >
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${active ? "gradient-purple text-white" : "bg-secondary text-muted-foreground"}`}>
                <Icon size={14} />
              </div>
              <span className={`text-sm font-semibold ${active ? "text-violet-700" : "text-foreground"}`}>{m.l}</span>
              <span className="text-[11px] text-muted-foreground">{m.d}</span>
            </button>
          );
        })}
      </div>

      {manual && (
        <div className="flex flex-col md:flex-row gap-4 mb-4 pt-1">
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">QR image</label>
              <input ref={qrInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleQrFile} />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => qrInputRef.current?.click()}
                  disabled={qrUploading}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-background text-sm font-medium hover:border-violet-300 disabled:opacity-50"
                >
                  {qrUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                  {qrUploading ? `Uploading… ${qrProgress}%` : gw.qrImageUrl ? "Replace QR image" : "Upload QR image"}
                </button>
                {gw.qrImageUrl && !qrUploading && (
                  <button
                    type="button"
                    onClick={() => setGw({ ...gw, qrImageUrl: "" })}
                    className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-red-200 bg-red-50 text-sm text-red-600 hover:bg-red-100"
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">PNG, JPEG or WebP · up to 5MB</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">UPI ID</label>
              <input className={field} placeholder="yourname@upi" value={gw.upiId} onChange={(e) => setGw({ ...gw, upiId: e.target.value })} />
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2.5">
              <p className="text-xs text-muted-foreground">
                Pricing comes from <span className="font-semibold text-foreground">Coin Packages</span>. Manual deposits use
                the same packages as the in-app store, so there is no separate coin rate to set here.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Instructions (shown to user)</label>
              <input className={field} placeholder="Pay to the QR and enter UTR" value={gw.note} onChange={(e) => setGw({ ...gw, note: e.target.value })} />
            </div>
          </div>
          <div className="flex-shrink-0">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">QR preview</label>
            {gw.qrImageUrl ? (
              <img src={gw.qrImageUrl} alt="QR preview" className="w-28 h-28 object-contain rounded-xl border border-border bg-white p-1.5" />
            ) : (
              <div className="w-28 h-28 rounded-xl border border-dashed border-border bg-background flex flex-col items-center justify-center text-muted-foreground gap-1">
                <QrCode size={22} />
                <span className="text-[10px]">No QR set</span>
              </div>
            )}
          </div>
        </div>
      )}

      <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2.5 rounded-xl disabled:opacity-50 hover:opacity-90 transition-opacity">
        <Save size={15} /> {saveMut.isPending ? "Saving…" : "Save Gateway"}
      </button>
    </div>
  );
}
