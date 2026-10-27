import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BellRing, PiggyBank } from "lucide-react";
import { api, describeError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { fmtNumber } from "@/lib/format";
import { Card, Toggle, field, label, type CardProps } from "./CoinCards";

/**
 * Free rewards budget + coin alerts / report email.
 *
 *   freeRewardsBudgetId          a `free_rewards` promo budget that caps the
 *                                recurring free coins (daily login, ads,
 *                                tasks). Empty = no cap. Linking needs the
 *                                approval password (worker routes/admin.ts).
 *   coinAlerts.dailyFreeCoinsPerUser   alert when one user gets more free coins
 *                                in 24h (worker lib/coinAlerts.ts, default 300)
 *   coinReport.{enabled,daily,weekly}  report email to `adminAlertEmail`
 */
export function FreeRewardsBudgetCard({ data, pending, onSave }: CardProps) {
  const { data: budgets = [] } = useQuery({ queryKey: ["promo-budgets"], queryFn: api.promoBudgets });
  const [id, setId] = useState("");
  useEffect(() => setId(String(data.freeRewardsBudgetId || "")), [data]);
  const options = budgets.filter((b) => b.kind === "free_rewards" && b.status !== "closed");
  const current = budgets.find((b) => b.id === id);
  return (
    <Card icon={PiggyBank} title="Free rewards budget" tint="text-purple-600" onSave={() => onSave({ freeRewardsBudgetId: id || null })} pending={pending}>
      <p className="mb-3 text-xs text-muted-foreground">
        Roz wale free coin (daily login, rewarded ads, daily tasks) is budget se katenge. Budget khatam = ye rewards band, jab tak total na badhao.
        Verification aur referral ek-baar wale hain, un par ye limit nahi lagti. Khaali = koi limit nahi. Save par approval password maanga jayega.
      </p>
      <label className={label}>Budget</label>
      <select className={field} value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Koi limit nahi</option>
        {options.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} · {fmtNumber(b.remainingCoins)} bache / {fmtNumber(b.totalCoins)}
            {b.status === "paused" ? " (paused)" : ""}
          </option>
        ))}
      </select>
      {current ? (
        <p className={`mt-2 text-xs ${current.remainingCoins <= 0 || !current.live ? "text-red-600" : "text-muted-foreground"}`}>
          {current.remainingCoins <= 0
            ? "Ye budget khatam ho gaya. Users ko free Diamond abhi nahi mil rahe."
            : !current.live
              ? "Ye budget abhi active nahi (paused ya time window ke bahar). Free Diamond nahi milenge."
              : `${fmtNumber(current.spentCoins)} Diamond diye ja chuke.${current.perUserLimit ? ` Per user max ${fmtNumber(current.perUserLimit)}.` : ""}`}
        </p>
      ) : null}
      {options.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Pehle Budgets tab me "Free rewards" type ka budget banao.</p>
      ) : null}
    </Card>
  );
}

export function CoinAlertsCard({ data, pending, onSave }: CardProps) {
  const [threshold, setThreshold] = useState("300");
  const [report, setReport] = useState({ enabled: true, daily: true, weekly: true });
  useEffect(() => {
    setThreshold(String(data.coinAlerts?.dailyFreeCoinsPerUser ?? 300));
    const r = data.coinReport || {};
    setReport({ enabled: r.enabled !== false, daily: r.daily !== false, weekly: r.weekly !== false });
  }, [data]);
  const email = String(data.adminAlertEmail || "");

  const send = useMutation({
    mutationFn: (period: "daily" | "weekly") => api.sendCoinReport(period),
    onSuccess: (r) => toast.success(`Report bhej di: ${r.to}`),
    onError: (e) => toast.error(describeError(e)),
  });
  const run = useMutation({
    mutationFn: () => api.runCoinAlerts(),
    onSuccess: (r) => {
      const parts = [
        r.budgets ? `${r.budgets} budget 80%+` : "",
        r.liability ? "liability > net cash" : "",
        r.heavyEarners ? `${r.heavyEarners} heavy earner` : "",
      ].filter(Boolean);
      toast.success(parts.length ? `Alert bheje: ${parts.join(", ")}` : "Sab theek, koi alert nahi");
    },
    onError: (e) => toast.error(describeError(e)),
  });

  const save = () => {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 1) {
      toast.error("Threshold 1 ya usse zyada poora number hona chahiye");
      return;
    }
    onSave({ coinAlerts: { dailyFreeCoinsPerUser: n }, coinReport: report });
  };

  return (
    <Card icon={BellRing} title="Diamond / DP coin alerts aur report email" tint="text-red-500" onSave={save} pending={pending}>
      <p className="mb-3 text-xs text-muted-foreground">
        Har 6 ghante check: koi budget 80% se zyada use hua, liability net cash se zyada, ya kisi user ne 24 ghante me threshold se zyada free coin
        liye. Alert notification me aata hai aur email par bhi.
      </p>
      <p className="mb-3 text-sm">
        Email:{" "}
        {email ? (
          <span className="font-medium text-foreground">{email}</span>
        ) : (
          <span className="text-red-600">set nahi hai</span>
        )}{" "}
        <Link href="/app-settings" className="text-xs text-primary underline">badlo</Link>
      </p>
      <label className={label}>Ek user, 24 ghante me free reward (Diamond + DP coin, isse zyada par alert)</label>
      <input type="number" min={1} className={field} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      <div className="mt-3">
        <Toggle label="Report email bhejo" checked={report.enabled} onChange={(v) => setReport({ ...report, enabled: v })} />
        <Toggle label="Roz (subah 8:30 IST)" checked={report.daily} onChange={(v) => setReport({ ...report, daily: v })} />
        <Toggle label="Har somvar (weekly)" checked={report.weekly} onChange={(v) => setReport({ ...report, weekly: v })} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!email || send.isPending}
          onClick={() => send.mutate("daily")}
          className="px-3 py-1.5 rounded-xl bg-secondary text-xs font-semibold disabled:opacity-50"
        >
          Aaj ki report abhi bhejo
        </button>
        <button
          type="button"
          disabled={!email || send.isPending}
          onClick={() => send.mutate("weekly")}
          className="px-3 py-1.5 rounded-xl bg-secondary text-xs font-semibold disabled:opacity-50"
        >
          7 din ki report bhejo
        </button>
        <button
          type="button"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          className="px-3 py-1.5 rounded-xl bg-secondary text-xs font-semibold disabled:opacity-50"
        >
          Alerts abhi check karo
        </button>
      </div>
    </Card>
  );
}
