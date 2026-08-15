import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Power, Megaphone, ArrowUpCircle, ToggleLeft, Banknote, Save } from "lucide-react";

type Cfg = {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  forceUpdate: boolean;
  minAppVersion: string;
  announcement: { enabled: boolean; message: string; link?: string };
  features: Record<string, boolean>;
  withdrawal: { enabled: boolean; minAmount: number; conversionRate: number };
};

const FEATURES = ["contests", "chat", "stories", "topups", "withdrawals", "posts"];

const DEFAULTS: Cfg = {
  maintenanceMode: false,
  maintenanceMessage: "",
  forceUpdate: false,
  minAppVersion: "",
  announcement: { enabled: false, message: "", link: "" },
  features: Object.fromEntries(FEATURES.map((f) => [f, true])),
  withdrawal: { enabled: true, minAmount: 100, conversionRate: 1 },
};

export default function AppControl() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [cfg, setCfg] = useState<Cfg>(DEFAULTS);

  useEffect(() => {
    if (data) {
      setCfg({
        ...DEFAULTS,
        ...data,
        announcement: { ...DEFAULTS.announcement, ...(data.announcement || {}) },
        features: { ...DEFAULTS.features, ...(data.features || {}) },
        withdrawal: { ...DEFAULTS.withdrawal, ...(data.withdrawal || {}) },
      });
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveAppSettings(cfg),
    onSuccess: () => {
      toast.success("App settings saved");
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  if (isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;

  return (
    <div>
      <PageHeader
        title="App Control Center"
        subtitle="Master switches the user app obeys at runtime"
        action={
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50">
            <Save size={16} /> Save All
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Maintenance */}
        <Card icon={Power} title="Maintenance Mode" tint="text-red-500">
          <Toggle label="App under maintenance (read-only / blocked)" checked={cfg.maintenanceMode} onChange={(v) => setCfg({ ...cfg, maintenanceMode: v })} />
          <textarea className={`${field} mt-3`} placeholder="Message shown to users during maintenance" value={cfg.maintenanceMessage} onChange={(e) => setCfg({ ...cfg, maintenanceMessage: e.target.value })} />
        </Card>

        {/* Force update */}
        <Card icon={ArrowUpCircle} title="Force Update" tint="text-blue-500">
          <Toggle label="Require minimum app version" checked={cfg.forceUpdate} onChange={(v) => setCfg({ ...cfg, forceUpdate: v })} />
          <input className={`${field} mt-3`} placeholder="Minimum version e.g. 1.4.0" value={cfg.minAppVersion} onChange={(e) => setCfg({ ...cfg, minAppVersion: e.target.value })} />
        </Card>

        {/* Announcement */}
        <Card icon={Megaphone} title="In-App Announcement Banner" tint="text-violet-500">
          <Toggle label="Show announcement banner" checked={cfg.announcement.enabled} onChange={(v) => setCfg({ ...cfg, announcement: { ...cfg.announcement, enabled: v } })} />
          <textarea className={`${field} mt-3`} placeholder="Announcement message" value={cfg.announcement.message} onChange={(e) => setCfg({ ...cfg, announcement: { ...cfg.announcement, message: e.target.value } })} />
          <input className={`${field} mt-3`} placeholder="Optional link URL" value={cfg.announcement.link || ""} onChange={(e) => setCfg({ ...cfg, announcement: { ...cfg.announcement, link: e.target.value } })} />
        </Card>

        {/* Feature flags */}
        <Card icon={ToggleLeft} title="Feature Flags" tint="text-green-500">
          <div className="space-y-1">
            {FEATURES.map((f) => (
              <Toggle key={f} label={f.charAt(0).toUpperCase() + f.slice(1)} checked={cfg.features[f] !== false} onChange={(v) => setCfg({ ...cfg, features: { ...cfg.features, [f]: v } })} />
            ))}
          </div>
        </Card>

        {/* Withdrawal config */}
        <Card icon={Banknote} title="Withdrawal Settings" tint="text-amber-500">
          <Toggle label="Allow withdrawals" checked={cfg.withdrawal.enabled} onChange={(v) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, enabled: v } })} />
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Min payout (coins)</label>
              <input type="number" className={field} value={cfg.withdrawal.minAmount} onChange={(e) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, minAmount: Number(e.target.value) } })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Coin → ₹ rate</label>
              <input type="number" step="0.01" className={field} value={cfg.withdrawal.conversionRate} onChange={(e) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, conversionRate: Number(e.target.value) } })} />
            </div>
          </div>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground mt-6">
        Note: these values are stored in <code>appConfig</code>. The user app must read them to honor maintenance / feature flags / force-update.
      </p>
    </div>
  );
}

function Card({ icon: Icon, title, tint, children }: any) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
        <Icon size={16} className={tint} /> {title}
      </h3>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center justify-between w-full py-1.5 text-left">
      <span className="text-sm text-foreground">{label}</span>
      <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-violet-500" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    </button>
  );
}
