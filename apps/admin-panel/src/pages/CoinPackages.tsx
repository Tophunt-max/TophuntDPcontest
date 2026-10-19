import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Plus, Trash2, Pencil } from "lucide-react";

export default function CoinPackages() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [dialog, setDialog] = useState<any | "new" | null>(null);

  const { data = [], isLoading } = useQuery({ queryKey: ["coin-packages"], queryFn: api.coinPackages });
  // Price = base coins × coin value (App Control → Withdrawal → "Coin → ₹ rate").
  const { data: settings } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const rateRaw = (settings as any)?.withdrawal?.conversionRate;
  const rate = rateRaw === undefined || rateRaw === null || rateRaw === "" ? 1 : Number(rateRaw);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["coin-packages"] });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteCoinPackage(id),
    onSuccess: () => { toast.success("Package deleted — app se turant hat gaya"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.updateCoinPackage(id, { active }),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Coin Packages"
        subtitle={`${data.length} top-up packages · Price = coins × coin value (₹${fmtNumber(rate)}/coin), bonus free — coin value App Control → Withdrawal mein badlo`}
        action={
          <button onClick={() => setDialog("new")} className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl">
            <Plus size={16} /> New Package
          </button>
        }
      />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(p: any) => p.id}
        empty="No packages yet"
        columns={[
          { key: "name", header: "Name", render: (p: any) => <span className="font-medium text-foreground">{p.name || "Untitled"}</span> },
          { key: "coins", header: "Coins", render: (p: any) => <span>{fmtNumber(p.coins)}{p.bonusCoins ? <span className="text-green-600"> +{fmtNumber(p.bonusCoins)}</span> : null}</span> },
          {
            key: "price",
            header: "Price (auto)",
            render: (p: any) => (
              <span className="font-bold">
                ₹{fmtNumber(p.priceInr)}
                {p.purchasable === false ? <span className="ml-2 text-xs font-medium text-red-600">₹1 se kam — app mein buy nahi hoga</span> : null}
              </span>
            ),
          },
          { key: "order", header: "Order", render: (p: any) => <span className="text-muted-foreground">{p.sortOrder}</span> },
          {
            key: "active",
            header: "Active",
            render: (p: any) => (
              <button onClick={() => toggleMut.mutate({ id: p.id, active: !p.active })}>
                <Badge variant={p.active ? "success" : "default"}>{p.active ? "active" : "hidden"}</Badge>
              </button>
            ),
          },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (p: any) => (
              <div className="flex items-center justify-end gap-1">
                <button title="Edit" onClick={() => setDialog(p)} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><Pencil size={15} /></button>
                <button title="Delete" onClick={async () => { if (await confirm({ title: "Delete package?", description: `Delete "${p.name}"?`, variant: "destructive" })) delMut.mutate(p.id); }} className="p-2 rounded-lg hover:bg-secondary text-red-600"><Trash2 size={15} /></button>
              </div>
            ),
          },
        ]}
      />

      {dialog && <PackageDialog pkg={dialog === "new" ? undefined : dialog} rate={rate} onClose={() => setDialog(null)} onDone={invalidate} />}
    </div>
  );
}

function PackageDialog({ pkg, rate, onClose, onDone }: { pkg?: any; rate: number; onClose: () => void; onDone: () => void }) {
  const isEdit = !!pkg;
  const [form, setForm] = useState({
    name: pkg?.name || "",
    coins: String(pkg?.coins ?? 0),
    bonusCoins: String(pkg?.bonusCoins ?? 0),
    sortOrder: String(pkg?.sortOrder ?? 0),
    active: pkg?.active !== false,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const payload = () => ({
    name: form.name,
    coins: Number(form.coins),
    bonusCoins: Number(form.bonusCoins),
    sortOrder: Number(form.sortOrder),
    active: form.active,
  });
  const mut = useMutation({
    mutationFn: () => (isEdit ? api.updateCoinPackage(pkg.id, payload()) : api.createCoinPackage(payload())),
    onSuccess: () => { toast.success(isEdit ? "Package updated — users ke app mein turant live" : "Package created — users ke app mein turant live"); onDone(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-4">{isEdit ? "Edit Package" : "New Package"}</h3>
        <div className="space-y-3">
          <input className={field} placeholder="Package name e.g. Starter Pack" value={form.name} onChange={(e) => set("name", e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <Num label="Coins" v={form.coins} on={(v: string) => set("coins", v)} cls={field} />
            <Num label="Bonus coins" v={form.bonusCoins} on={(v: string) => set("bonusCoins", v)} cls={field} />
            <Num label="Sort order" v={form.sortOrder} on={(v: string) => set("sortOrder", v)} cls={field} />
          </div>
          <div className="rounded-xl bg-secondary px-3 py-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Price (auto)</span>
              <span className="font-bold text-foreground">₹{fmtNumber(Math.round((Number(form.coins) || 0) * rate * 100) / 100)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {fmtNumber(Number(form.coins) || 0)} coins × ₹{fmtNumber(rate)} coin value. Bonus coins free hain. Price badalne ke liye App Control → Withdrawal → "Coin → ₹ rate" badlo.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Active (visible in app)</label>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-sm font-medium">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50">{isEdit ? "Save" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function Num({ label, v, on, cls }: any) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <input type="number" className={cls} value={v} onChange={(e) => on(e.target.value)} />
    </div>
  );
}
