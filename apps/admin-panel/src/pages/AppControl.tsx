import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Power, Megaphone, ArrowUpCircle, ToggleLeft, Banknote, Save, Radio, CalendarClock } from "lucide-react";
import { AuthMethodsCard } from "@/components/AuthMethodsCard";

/**
 * App Control Center.
 *
 * Every card saves ONLY its own fields. "Save All" used to resend the entire
 * stored appConfig (legal text, rewards, onboarding, ads…), so a save here could
 * silently overwrite a change made on another page since this one loaded, and
 * wrote audit rows for sections nobody touched.
 *
 * A save is live at once: the Worker pushes the new config over realtime to
 * every open app (signed in or not), so maintenance / flags / banner change in
 * seconds. The server validates everything again and also ENFORCES maintenance,
 * feature flags and the hard minimum version on its API.
 */

const FEATURES: { key: string; label: string }[] = [
  { key: "contests", label: "Contests (start / join / vote)" },
  { key: "chat", label: "Chat" },
  { key: "stories", label: "Stories" },
  { key: "posts", label: "Posts" },
  { key: "topups", label: "Coin top-up / store" },
  { key: "withdrawals", label: "Withdrawals" },
];

const PRESETS: { label: string; hint: string; features: Record<string, boolean> }[] = [
  { label: "💸 Payments band", hint: "Top-up + withdrawal off", features: { topups: false, withdrawals: false } },
  {
    label: "📖 Read-only mode",
    hint: "Sab dekh sakte hain, kuch naya post/join/chat nahi",
    features: { contests: false, chat: false, stories: false, posts: false, topups: false, withdrawals: false },
  },
  { label: "✅ Sab on", hint: "Saare features wapas on", features: Object.fromEntries(FEATURES.map((f) => [f.key, true])) },
];

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "text-xs text-muted-foreground mb-1 block";

/** ms -> value for <input type="datetime-local"> (local time), "" for none. */
function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string): number | null => (v ? new Date(v).getTime() : null);
const fmt = (ms: number) => new Date(ms).toLocaleString();

export default function AppControl() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveAppSettings(patch),
    onSuccess: () => {
      toast.success("✅ Live — sab users ke app mein turant bhej diya");
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;

  const sched = data.maintenanceSchedule;
  const inWindow = !!sched?.startAt && now >= sched.startAt && now < sched.endAt;
  const maintenanceLive = data.maintenanceMode === true || inWindow;
  const upcoming = !!sched?.startAt && sched.startAt > now ? sched : null;

  return (
    <div>
      <PageHeader title="App Control Center" subtitle="Har change turant users ke app mein (realtime) — server bhi enforce karta hai" />

      {maintenanceLive && (
        <div className="mb-5 rounded-2xl border border-red-300 bg-red-50 text-red-800 px-4 py-3 text-sm font-semibold flex items-center gap-2">
          <Power size={16} /> App abhi MAINTENANCE mein hai — users app use nahi kar pa rahe.
          {inWindow && sched?.endAt ? <span className="font-normal">Schedule {fmt(sched.endAt)} par khatam hoga.</span> : null}
        </div>
      )}
      {!maintenanceLive && upcoming && (
        <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 text-amber-800 px-4 py-3 text-sm flex items-center gap-2">
          <CalendarClock size={16} /> Scheduled maintenance: {fmt(upcoming.startAt)} → {fmt(upcoming.endAt)}. Users ko pehle se notice dikh raha hai.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <AuthMethodsCard />
        <MaintenanceCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} confirm={confirm} />
        <ForceUpdateCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} confirm={confirm} />
        <AnnouncementCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} />
        <FeaturesCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} confirm={confirm} />
        <WithdrawalCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} confirm={confirm} />
      </div>

      <p className="text-xs text-muted-foreground mt-6 flex items-center gap-1.5">
        <Radio size={12} /> Har card sirf apni settings save karta hai. Open apps ko realtime push jaata hai; band apps khulte hi naya config lete hain.
      </p>
    </div>
  );
}

type CardProps = {
  data: any;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  confirm?: (o: any) => Promise<boolean>;
};

// ---------------------------------------------------------------- maintenance
function MaintenanceCard({ data, pending, onSave, confirm }: CardProps) {
  const [on, setOn] = useState(false);
  const [message, setMessage] = useState("");
  const [eta, setEta] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setOn(data.maintenanceMode === true);
    setMessage(data.maintenanceMessage || "");
    setEta(toLocalInput(data.maintenanceEta));
    setStart(toLocalInput(data.maintenanceSchedule?.startAt));
    setEnd(toLocalInput(data.maintenanceSchedule?.endAt));
    setNotice(data.maintenanceSchedule?.notice || "");
  }, [data]);

  const submit = async () => {
    const s = fromLocalInput(start);
    const e = fromLocalInput(end);
    if ((s === null) !== (e === null)) return toast.error("Schedule ke liye start aur end dono do (ya dono khaali).");
    if (s !== null && e !== null && e <= s) return toast.error("Schedule end, start ke baad hona chahiye.");
    if (message.length > 500) return toast.error("Message 500 characters se chhota rakho.");
    if (on && data.maintenanceMode !== true && confirm) {
      const ok = await confirm({
        title: "Maintenance ON karein?",
        description: "Sabhi users ka app turant band ho jayega (staff andar ja sakte hain). Server bhi saari writes rok dega.",
        variant: "destructive",
      });
      if (!ok) return;
    }
    onSave({
      maintenanceMode: on,
      maintenanceMessage: message,
      maintenanceEta: fromLocalInput(eta),
      maintenanceSchedule: s === null ? null : { startAt: s, endAt: e, notice },
    });
  };

  return (
    <Card icon={Power} title="Maintenance Mode" tint="text-red-500" onSave={submit} pending={pending}>
      <Toggle label="Abhi maintenance ON (app band)" checked={on} onChange={setOn} />
      <textarea className={`${field} mt-3`} placeholder="Users ko dikhne wala message" value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} />
      <div className="mt-3">
        <label className={label}>Wapas kab tak? (countdown, optional)</label>
        <input type="datetime-local" className={field} value={eta} onChange={(e) => setEta(e.target.value)} />
      </div>
      <div className="mt-4 pt-3 border-t border-border">
        <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <CalendarClock size={13} /> Scheduled maintenance (apne aap on/off)
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Start</label>
            <input type="datetime-local" className={field} value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className={label}>End</label>
            <input type="datetime-local" className={field} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <input className={`${field} mt-3`} placeholder="Pehle se dikhne wala notice (48 ghante pehle se)" value={notice} maxLength={500} onChange={(e) => setNotice(e.target.value)} />
        {(start || end) && (
          <button className="text-xs text-red-600 mt-2" onClick={() => { setStart(""); setEnd(""); setNotice(""); }}>
            Schedule hatao
          </button>
        )}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------- force update
function ForceUpdateCard({ data, pending, onSave, confirm }: CardProps) {
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<"hard" | "soft">("hard");
  const [minV, setMinV] = useState("");
  const [android, setAndroid] = useState("");
  const [ios, setIos] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setOn(data.forceUpdate === true);
    setMode(data.forceUpdateMode === "soft" ? "soft" : "hard");
    setMinV(data.minAppVersion || "");
    setAndroid(data.updateUrls?.android || data.updateUrl || "");
    setIos(data.updateUrls?.ios || "");
    setMessage(data.updateMessage || "");
  }, [data]);

  const submit = async () => {
    if (minV && !/^v?\d{1,4}(\.\d{1,4}){0,3}$/i.test(minV.trim())) return toast.error("Version aisa likho: 1.4.0");
    if (on && !minV.trim()) return toast.error("Force update ke liye minimum version zaroori hai.");
    for (const [n, u] of [["Android", android], ["iOS", ios]]) {
      if (u && !/^https:\/\/\S+$/i.test(u.trim())) return toast.error(`${n} store link https:// se shuru hona chahiye.`);
    }
    if (on && mode === "hard" && confirm && !(data.forceUpdate === true && data.forceUpdateMode !== "soft")) {
      const ok = await confirm({
        title: "Hard update ON karein?",
        description: `${minV} se purane Android/iOS app ab use nahi ho payenge jab tak user update na kare. Web par asar nahi.`,
        variant: "destructive",
      });
      if (!ok) return;
    }
    onSave({
      forceUpdate: on,
      forceUpdateMode: mode,
      minAppVersion: minV.trim(),
      updateUrls: { android: android.trim(), ios: ios.trim() },
      updateMessage: message,
    });
  };

  return (
    <Card icon={ArrowUpCircle} title="Force Update" tint="text-blue-500" onSave={submit} pending={pending}>
      <Toggle label="Minimum app version lagu karo (sirf Android/iOS)" checked={on} onChange={setOn} />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className={label}>Minimum version</label>
          <input className={field} placeholder="1.4.0" value={minV} onChange={(e) => setMinV(e.target.value)} />
        </div>
        <div>
          <label className={label}>Type</label>
          <select className={field} value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="hard">Hard — update ke bina app nahi</option>
            <option value="soft">Soft — "Baad mein" option</option>
          </select>
        </div>
      </div>
      <input className={`${field} mt-3`} placeholder="Play Store link (https://play.google.com/...)" value={android} onChange={(e) => setAndroid(e.target.value)} />
      <input className={`${field} mt-3`} placeholder="App Store link (https://apps.apple.com/...)" value={ios} onChange={(e) => setIos(e.target.value)} />
      <textarea className={`${field} mt-3`} placeholder="Optional message (kya naya hai)" value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} />
    </Card>
  );
}

// --------------------------------------------------------------- announcement
function AnnouncementCard({ data, pending, onSave }: CardProps) {
  const a = data.announcement || {};
  const [on, setOn] = useState(false);
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [tone, setTone] = useState("info");
  const [audience, setAudience] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [republish, setRepublish] = useState(false);
  useEffect(() => {
    setOn(!!a.enabled);
    setMessage(a.message || "");
    setLink(a.link || "");
    setTone(a.tone || "info");
    setAudience(a.audience || "all");
    setStart(toLocalInput(a.startAt));
    setEnd(toLocalInput(a.endAt));
    setRepublish(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const submit = () => {
    const l = link.trim();
    if (l && !/^https?:\/\/\S/i.test(l)) return toast.error("Link pura http(s) URL hona chahiye — ya khaali chhodo.");
    if (on && !message.trim()) return toast.error("Banner on hai to message likho.");
    if (message.length > 300) return toast.error("Message 300 characters se chhota rakho.");
    const s = fromLocalInput(start);
    const e = fromLocalInput(end);
    if (s && e && e <= s) return toast.error("End, start ke baad hona chahiye.");
    onSave({ announcement: { enabled: on, message, link: l || null, tone, audience, startAt: s, endAt: e, republish } });
  };

  const TONE_BG: Record<string, string> = { info: "bg-violet-600", warning: "bg-amber-600", success: "bg-emerald-600", danger: "bg-red-600" };

  return (
    <Card icon={Megaphone} title="In-App Announcement Banner" tint="text-violet-500" onSave={submit} pending={pending}>
      <Toggle label="Banner dikhao" checked={on} onChange={setOn} />
      <textarea className={`${field} mt-3`} placeholder="Announcement message" value={message} maxLength={300} onChange={(e) => setMessage(e.target.value)} />
      <input className={`${field} mt-3`} placeholder="Optional link URL (https://...)" value={link} onChange={(e) => setLink(e.target.value)} />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className={label}>Rang / type</label>
          <select className={field} value={tone} onChange={(e) => setTone(e.target.value)}>
            <option value="info">Info (purple)</option>
            <option value="success">Success (green)</option>
            <option value="warning">Warning (amber)</option>
            <option value="danger">Urgent (red)</option>
          </select>
        </div>
        <div>
          <label className={label}>Kisko dikhe</label>
          <select className={field} value={audience} onChange={(e) => setAudience(e.target.value)}>
            <option value="all">Sabko (guest bhi)</option>
            <option value="signedIn">Sirf logged-in users</option>
          </select>
        </div>
        <div>
          <label className={label}>Kab se (optional)</label>
          <input type="datetime-local" className={field} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className={label}>Kab tak (optional)</label>
          <input type="datetime-local" className={field} value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm">
        <input type="checkbox" className="accent-violet-500" checked={republish} onChange={(e) => setRepublish(e.target.checked)} />
        Jinhone band kiya tha unhe bhi dobara dikhao
      </label>
      {message.trim() && (
        <div className={`mt-3 rounded-xl text-white text-xs px-3 py-2 ${TONE_BG[tone] || TONE_BG.info}`}>Preview: {message}</div>
      )}
      <p className="text-[11px] text-muted-foreground mt-2">Message, link ya rang badalne par ye naya announcement maana jaata hai aur sabko dobara dikhta hai.</p>
    </Card>
  );
}

// ------------------------------------------------------------------- features
function FeaturesCard({ data, pending, onSave, confirm }: CardProps) {
  const initial = useMemo(
    () => Object.fromEntries(FEATURES.map((f) => [f.key, data.features?.[f.key] !== false])) as Record<string, boolean>,
    [data],
  );
  const [features, setFeatures] = useState(initial);
  useEffect(() => setFeatures(initial), [initial]);

  const submit = async () => {
    const turningOff = FEATURES.filter((f) => initial[f.key] && !features[f.key]).map((f) => f.label);
    if (turningOff.length && confirm) {
      const ok = await confirm({
        title: "Features band karein?",
        description: `${turningOff.join(", ")} — app se turant gayab, aur server bhi in actions ko rok dega.`,
        variant: "destructive",
      });
      if (!ok) return;
    }
    onSave({ features });
  };

  return (
    <Card icon={ToggleLeft} title="Feature Flags" tint="text-green-500" onSave={submit} pending={pending}>
      <div className="flex flex-wrap gap-2 mb-3">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            title={p.hint}
            onClick={() => setFeatures({ ...features, ...p.features })}
            className="text-xs border border-border rounded-full px-3 py-1.5 hover:bg-secondary"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        {FEATURES.map((f) => (
          <Toggle key={f.key} label={f.label} checked={features[f.key] !== false} onChange={(v) => setFeatures({ ...features, [f.key]: v })} />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">Preset sirf switches set karta hai — Save dabane par lagta hai.</p>
    </Card>
  );
}

// ----------------------------------------------------------------- withdrawal
function WithdrawalCard({ data, pending, onSave, confirm }: CardProps) {
  const w = data.withdrawal || {};
  const [enabled, setEnabled] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [maxPerDay, setMaxPerDay] = useState("");
  const [rate, setRate] = useState("");
  useEffect(() => {
    setEnabled(w.enabled !== false);
    setFrozen(w.payoutsFrozen === true);
    // The STORED values (0 = no limit) — never a made-up default.
    setMinAmount(String(w.minAmount ?? 0));
    setMaxAmount(String(w.maxAmount ?? 0));
    setMaxPerDay(String(w.maxPerDay ?? 0));
    setRate(String(w.conversionRate ?? 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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
    if (frozen && w.payoutsFrozen !== true && confirm) {
      const ok = await confirm({ title: "Emergency freeze?", description: "Saare naye payout requests turant ruk jayenge.", variant: "destructive" });
      if (!ok) return;
    }
    onSave({ withdrawal: { enabled, payoutsFrozen: frozen, minAmount: min, maxAmount: max, maxPerDay: Number(maxPerDay), conversionRate: r } });
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
        </div>
      </div>
    </Card>
  );
}

// -------------------------------------------------------------------- shared
function Card({ icon: Icon, title, tint, children, onSave, pending }: any) {
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

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center justify-between w-full py-1.5 text-left" type="button">
      <span className="text-sm text-foreground">{label}</span>
      <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-violet-500" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    </button>
  );
}
