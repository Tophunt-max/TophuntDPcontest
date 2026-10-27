import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Banknote, Coins, Lock, Save } from "lucide-react";

/**
 * Coin settings cards (withdrawal rules, buy rate, play-only free rewards).
 *
 * Shared by the Coin Economy hub (their home) and kept out of App Control so
 * there is exactly ONE editor for each coin setting. Each card posts only its
 * own appConfig key; the Worker merges, validates and audits it.
 */
export const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
export const label = "text-xs text-muted-foreground mb-1 block";

export type CardProps = {
  data: any;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  confirm?: (o: any) => Promise<boolean>;
};

// ----------------------------------------------------------------- withdrawal
export function WithdrawalCard({ data, pending, onSave, confirm }: CardProps) {
  const w = data.withdrawal || {};
  const [enabled, setEnabled] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [maxPerDay, setMaxPerDay] = useState("");
  const [rate, setRate] = useState("");
  // Platform fee on payouts (Worker lib/withdrawalFee.ts): % + flat, clamped to
  // [min, max], deducted from the rupees paid, locked on each request.
  const [feePercent, setFeePercent] = useState("");
  const [feeFlat, setFeeFlat] = useState("");
  const [feeMin, setFeeMin] = useState("");
  const [feeMax, setFeeMax] = useState("");
  const [sampleCoins, setSampleCoins] = useState("1000");
  useEffect(() => {
    setEnabled(w.enabled !== false);
    setFrozen(w.payoutsFrozen === true);
    // The STORED values (0 = no limit) — never a made-up default.
    setMinAmount(String(w.minAmount ?? 0));
    setMaxAmount(String(w.maxAmount ?? 0));
    setMaxPerDay(String(w.maxPerDay ?? 0));
    setRate(String(w.conversionRate ?? 1));
    setFeePercent(String(w.feePercent ?? 0));
    setFeeFlat(String(w.feeFlat ?? 0));
    setFeeMin(String(w.feeMin ?? 0));
    setFeeMax(String(w.feeMax ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Same formula as the server, for the live preview below.
  const paise = (n: number) => Math.round(n * 100 + 1e-9) / 100;
  const preview = (() => {
    const gross = paise((Number(sampleCoins) || 0) * (Number(rate) || 0));
    const pct = Math.min(50, Math.max(0, Number(feePercent) || 0));
    const flat = Math.max(0, Number(feeFlat) || 0);
    const fmin = Math.max(0, Number(feeMin) || 0);
    const fmax = Math.max(0, Number(feeMax) || 0);
    let fee = 0;
    if ((pct > 0 || flat > 0 || fmin > 0) && gross > 0) {
      fee = (gross * pct) / 100 + flat;
      if (fmin > 0) fee = Math.max(fee, fmin);
      if (fmax > 0) fee = Math.min(fee, fmax);
      fee = Math.min(paise(fee), gross);
    }
    return { gross, fee: paise(fee), net: paise(gross - fee) };
  })();

  const submit = async () => {
    const ints: [string, string][] = [["Min payout", minAmount], ["Max payout", maxAmount], ["Daily limit", maxPerDay]];
    for (const [n, v] of ints) {
      if (v.trim() === "" || !/^\d+$/.test(v.trim())) return toast.error(`${n}: poora number likho (0 = no limit).`);
    }
    const r = Number(rate);
    if (!rate.trim() || !Number.isFinite(r) || r <= 0) return toast.error("Coin → ₹ rate 0 se zyada hona chahiye.");
    const min = Number(minAmount);
    const max = Number(maxAmount);
    if (max > 0 && min > max) return toast.error("Min payout, max se zyada nahi ho sakta.");
    const fee = { feePercent: Number(feePercent), feeFlat: Number(feeFlat), feeMin: Number(feeMin), feeMax: Number(feeMax) };
    for (const [k, v] of Object.entries(fee)) {
      if (!Number.isFinite(v) || v < 0) return toast.error(`${k}: 0 ya usse zyada number likho.`);
    }
    if (fee.feePercent > 50) return toast.error("Platform fee 50% se zyada nahi ho sakti.");
    if (fee.feeMax > 0 && fee.feeMin > fee.feeMax) return toast.error("Min fee, max fee se zyada nahi ho sakti.");
    if (frozen && w.payoutsFrozen !== true && confirm) {
      const ok = await confirm({ title: "Emergency freeze?", description: "Saare naye payout requests turant ruk jayenge.", variant: "destructive" });
      if (!ok) return;
    }
    onSave({ withdrawal: { enabled, payoutsFrozen: frozen, minAmount: min, maxAmount: max, maxPerDay: Number(maxPerDay), conversionRate: r, ...fee } });
  };

  return (
    <Card icon={Banknote} title="Withdrawal Settings" tint="text-amber-500" onSave={submit} pending={pending}>
      <Toggle label="Withdrawals allow karo" checked={enabled} onChange={setEnabled} />
      <Toggle label="🚨 Emergency freeze (saare naye payout requests band)" checked={frozen} onChange={setFrozen} />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className={label}>Min payout (coins)</label>
          <input type="number" min={0} className={field} value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
        </div>
        <div>
          <label className={label}>Max per request (0 = no limit)</label>
          <input type="number" min={0} className={field} value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
        </div>
        <div>
          <label className={label}>Roz kitni requests (0 = no limit)</label>
          <input type="number" min={0} className={field} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
        </div>
        <div>
          <label className={label}>Coin → ₹ rate</label>
          <input type="number" step="0.01" min={0} className={field} value={rate} onChange={(e) => setRate(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">
            Payout rate: withdrawal par user ko 1 coin ke kitne ₹ milenge. Package ka daam "Coin Pricing" ke Buy rate se banta hai.
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <p className="text-sm font-semibold text-foreground">Platform fee (payout se katega)</p>
        <p className="text-xs text-muted-foreground mb-3">
          Fee = payout ka % + flat ₹, min/max ke beech. Request ke waqt lock hoti hai; reject par saare coins wapas, koi fee nahi. Sab 0 = no fee.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Fee % (0–50)</label>
            <input type="number" step="0.01" min={0} max={50} className={field} value={feePercent} onChange={(e) => setFeePercent(e.target.value)} />
          </div>
          <div>
            <label className={label}>Flat fee ₹ (har request)</label>
            <input type="number" step="0.01" min={0} className={field} value={feeFlat} onChange={(e) => setFeeFlat(e.target.value)} />
          </div>
          <div>
            <label className={label}>Min fee ₹ (0 = none)</label>
            <input type="number" step="0.01" min={0} className={field} value={feeMin} onChange={(e) => setFeeMin(e.target.value)} />
          </div>
          <div>
            <label className={label}>Max fee ₹ (0 = no cap)</label>
            <input type="number" step="0.01" min={0} className={field} value={feeMax} onChange={(e) => setFeeMax(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 rounded-xl bg-secondary px-3 py-2.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Preview:</span>
            <input type="number" min={0} className="w-24 px-2 py-1 rounded-lg border border-border bg-background text-sm" value={sampleCoins} onChange={(e) => setSampleCoins(e.target.value)} />
            <span className="text-muted-foreground">coins</span>
          </div>
          <div className="mt-1.5 text-foreground">
            Value ₹{preview.gross.toFixed(2)} − fee ₹{preview.fee.toFixed(2)} = <b>user ko ₹{preview.net.toFixed(2)}</b>
            {preview.net < 1 && preview.gross > 0 ? <span className="ml-2 text-xs font-medium text-red-600">₹1 se kam — request reject hogi</span> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------- coin pricing
/**
 * Buy rate: ₹ per BASE coin when buying a package (bonus coins are free).
 * The server refuses any buy rate (or payout rate, or package) under which a
 * package would pay out more than it costs, and names the minimum safe rate.
 */
export function CoinPricingCard({ data, pending, onSave }: CardProps) {
  const payout = Number(data.withdrawal?.conversionRate ?? 1) || 1;
  const stored = data.coinPricing?.buyRate;
  const [buyRate, setBuyRate] = useState("");
  useEffect(() => {
    setBuyRate(stored !== undefined && stored !== null && stored !== "" ? String(stored) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const r = Number(buyRate);
  const margin = buyRate.trim() && Number.isFinite(r) && r > 0 ? r / payout : null;
  const submit = () => {
    if (!buyRate.trim() || !Number.isFinite(r) || r <= 0) return toast.error("Buy rate 0 se zyada hona chahiye (₹ per coin).");
    if (r < payout) return toast.error(`Buy rate payout rate (₹${payout}/coin) se kam nahi ho sakta — warna har coin par nuksaan.`);
    onSave({ coinPricing: { buyRate: r } });
  };
  return (
    <Card icon={Coins} title="Diamond ka daam (Buy rate)" tint="text-pink-500" onSave={submit} pending={pending}>
      {stored === undefined || stored === null || stored === "" ? (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Buy rate abhi set nahi hai — daam DP coin payout rate (₹{payout}) se ban raha hai, isliye bonus wale packages bik nahi rahe (nuksaan se bachne ke liye). Buy rate set karo.
        </div>
      ) : null}
      <label className={label}>Buy rate (₹ per Diamond)</label>
      <input type="number" step="0.01" min={0} className={field} value={buyRate} placeholder={`e.g. ${(payout * 2).toFixed(2)}`} onChange={(e) => setBuyRate(e.target.value)} />
      <p className="mt-1 text-xs text-muted-foreground">
        Package daam = Diamond × buy rate (bonus free). DP coin payout ₹{payout}.
        {margin ? ` Har Diamond par ${(Math.max(0, (margin - 1) * 100)).toFixed(0)}% margin.` : ""} Diamond withdraw nahi hote, par do log aapas me khel kar unhe DP coin bana sakte hain. Isliye buy rate kabhi payout rate se kam nahi hona chahiye. Jo package bonus milakar nuksaan kare, use server bechne nahi deta, aur save karne par minimum safe rate bata deta hai.
      </p>
    </Card>
  );
}

/**
 * Free rewards as LOCKED (play-only) coins (worker lib/rewardLocking.ts).
 *
 * Locked coins can pay contest entry fees but never be withdrawn; a prize won
 * with them is withdrawable. Default for every reward: locked. A change applies
 * to coins credited from now on — balances already earned keep their status.
 */
const REWARD_LOCK_ROWS: { key: string; label: string }[] = [
  { key: "verification", label: "Signup bonus (turant + email/mobile verify)" },
  { key: "referral", label: "Referral bonus (dono ko)" },
  { key: "daily", label: "Daily login reward" },
  { key: "ads", label: "Rewarded ads" },
  { key: "tasks", label: "Daily tasks" },
];

export function RewardLockingCard({ data, pending, onSave }: CardProps) {
  const stored = (data.rewardLocking || {}) as Record<string, boolean>;
  const initial = () => Object.fromEntries(REWARD_LOCK_ROWS.map((r) => [r.key, stored[r.key] !== false]));
  const [locked, setLocked] = useState<Record<string, boolean>>(initial);
  useEffect(() => {
    setLocked(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return (
    <Card icon={Lock} title="Free rewards: Diamond ya DP coin?" tint="text-cyan-500" onSave={() => onSave({ rewardLocking: locked })} pending={pending}>
      <p className="mb-3 text-xs text-muted-foreground">
        ON = Diamond milenge: sirf contest entry fee me lagenge, withdraw nahi honge (jeet ka prize DP coin me milta hai).
        OFF = DP coin milenge: withdraw ho sakte hain, par entry fee nahi bhar sakte. Badlav sirf naye reward par lagta hai.
      </p>
      {REWARD_LOCK_ROWS.map((r) => (
        <Toggle key={r.key} label={r.label} checked={locked[r.key]} onChange={(v: boolean) => setLocked({ ...locked, [r.key]: v })} />
      ))}
    </Card>
  );
}

// -------------------------------------------------------------------- shared
export function Card({ icon: Icon, title, tint, children, onSave, pending }: any) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h3 className="font-bold text-foreground flex items-center gap-2">
          <Icon size={16} className={tint} /> {title}
        </h3>
        {onSave && (
          <button
            onClick={onSave}
            disabled={pending}
            className="flex items-center gap-1.5 gradient-purple text-white text-xs font-semibold px-3 py-1.5 rounded-xl disabled:opacity-50"
          >
            <Save size={13} /> Save
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center justify-between w-full py-1.5 text-left" type="button">
      <span className="text-sm text-foreground">{label}</span>
      <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-violet-500" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    </button>
  );
}
