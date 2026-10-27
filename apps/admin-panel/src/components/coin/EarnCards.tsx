import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarCheck, Crown, ListChecks, Plus, ShieldCheck, Trash2, Tv } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Card, Toggle, field, label } from "./CoinCards";

/**
 * Free-coin ("Earn") settings, one card per source, for the Coin Economy hub.
 *
 * Two stores back these:
 *   appConfig     verificationReward, ads          → POST /admin/app-settings
 *   gamification  dailyLoginReward, dailyStreakBonus,
 *                 dailyTasks, hallOfFameRewards     → POST /admin/rewards
 * Each card posts ONLY its own keys; the Worker validates every coin amount as a
 * whole number and audits the change.
 */
const hint = "text-[11px] text-muted-foreground mt-1";
const num = (v: string) => (v === "" ? 0 : Number(v));

function useAppSettingsSave(message: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveAppSettings(patch),
    onSuccess: () => {
      toast.success(message);
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["verification-reward"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
}

function useRewardsSave(message: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveRewards(patch),
    onSuccess: () => {
      toast.success(message);
      qc.invalidateQueries({ queryKey: ["rewards"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
}

// ─── Verification reward (appConfig.verificationReward) ─────────────────────

export function VerificationRewardCard({ data }: { data: any }) {
  const stored = data?.verificationReward || {};
  const read = () => ({
    enabled: stored.enabled !== false,
    completionReward: Number(stored.completionReward ?? 90),
    maxTotalReward: Number(stored.maxTotalReward ?? 100),
    requireEmail: stored.requireEmail !== false,
    requirePhone: stored.requirePhone !== false,
  });
  const [v, setV] = useState(read);
  useEffect(() => {
    setV(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const { data: info } = useQuery({ queryKey: ["verification-reward"], queryFn: api.verificationReward });
  const save = useAppSettingsSave("Verification reward saved");
  const error = useMemo(() => {
    for (const [name, n] of [["On completion", v.completionReward], ["Maximum", v.maxTotalReward]] as const) {
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return `${name}: 0 se 1,000,000 ke beech poora number.`;
    }
    if (v.completionReward > v.maxTotalReward) return "On completion, Maximum se zyada nahi ho sakta.";
    if (!v.requireEmail && !v.requirePhone && v.completionReward > 0) return "Email ya mobile me se kam se kam ek verify karna zaroori rakho.";
    return null;
  }, [v]);
  const stats = info?.stats;
  return (
    <Card
      icon={ShieldCheck}
      title="Email + mobile verification bonus"
      tint="text-emerald-500"
      pending={save.isPending}
      onSave={() => (error ? toast.error(error) : save.mutate({ verificationReward: { ...v, registrationReward: 0 } }))}
    >
      <Toggle label="Enabled" checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} />
      <div className="grid grid-cols-2 gap-3 mt-2">
        <div>
          <label className={label}>On completion (coins)</label>
          <input type="number" min={0} className={field} value={v.completionReward} onChange={(e) => setV({ ...v, completionReward: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Maximum (coins)</label>
          <input type="number" min={0} className={field} value={v.maxTotalReward} onChange={(e) => setV({ ...v, maxTotalReward: num(e.target.value) })} />
        </div>
      </div>
      <Toggle label="Email verify zaroori" checked={v.requireEmail} onChange={(x) => setV({ ...v, requireEmail: x })} />
      <Toggle label="Mobile verify zaroori" checked={v.requirePhone} onChange={(x) => setV({ ...v, requirePhone: x })} />
      <p className={hint}>Signup par koi bonus nahi. Amount har user ke signup par lock hota hai; badlav naye signup par lagega.</p>
      {error && (
        <p className="text-xs text-red-600 mt-2 flex items-center gap-1.5"><AlertTriangle size={13} /> {error}</p>
      )}
      {stats && (
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          {([
            ["Enrolled", stats.enrolled],
            ["Completed", stats.completed],
            ["Coins paid", stats.completionCoinsCredited],
          ] as const).map(([n, val]) => (
            <div key={n} className="rounded-xl bg-secondary py-2">
              <div className="text-sm font-bold text-foreground">{Number(val ?? 0).toLocaleString()}</div>
              <div className="text-[11px] text-muted-foreground">{n}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Rewarded ads (appConfig.ads) ───────────────────────────────────────────

export function AdsRewardCard({ data }: { data: any }) {
  const stored = data?.ads || {};
  const read = () => ({
    enabled: stored.enabled === true,
    trustClient: stored.trustClient === true,
    provider: String(stored.provider ?? ""),
    reward: Number(stored.reward ?? 5),
    dailyCap: Number(stored.dailyCap ?? 10),
  });
  const [a, setA] = useState(read);
  useEffect(() => {
    setA(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const save = useAppSettingsSave("Rewarded ads saved");
  const submit = () => {
    if (!Number.isInteger(a.reward) || a.reward < 1) return toast.error("Coins per ad: 1 ya zyada poora number.");
    if (!Number.isInteger(a.dailyCap) || a.dailyCap < 1) return toast.error("Daily cap: 1 ya zyada poora number.");
    save.mutate({ ads: a });
  };
  return (
    <Card icon={Tv} title="Rewarded ads" tint="text-cyan-500" pending={save.isPending} onSave={submit}>
      <Toggle label="Enabled" checked={a.enabled} onChange={(x) => setA({ ...a, enabled: x })} />
      {a.enabled && (
        <Toggle label="Bina server verification ke coin do (risky)" checked={a.trustClient} onChange={(x) => setA({ ...a, trustClient: x })} />
      )}
      <div className="grid grid-cols-3 gap-3 mt-2">
        <div>
          <label className={label}>Provider</label>
          <input className={field} value={a.provider} placeholder="admob" onChange={(e) => setA({ ...a, provider: e.target.value })} />
        </div>
        <div>
          <label className={label}>Coins per ad</label>
          <input type="number" min={1} className={field} value={a.reward} onChange={(e) => setA({ ...a, reward: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Daily cap (ads)</label>
          <input type="number" min={1} className={field} value={a.dailyCap} onChange={(e) => setA({ ...a, dailyCap: num(e.target.value) })} />
        </div>
      </div>
      <p className={hint}>
        Ek user roz zyada se zyada {(a.reward * a.dailyCap).toLocaleString()} coin. "Bina verification" tabhi chalega jab Worker par
        ALLOW_UNVERIFIED_AD_REWARDS=true ho.
      </p>
    </Card>
  );
}

// ─── Daily login (gamification) ─────────────────────────────────────────────

export function DailyLoginCard({ rewards }: { rewards: any }) {
  const read = () => ({
    dailyLoginReward: Number(rewards?.dailyLoginReward ?? rewards?.dailyBaseReward ?? 10),
    dailyStreakBonus: Number(rewards?.dailyStreakBonus ?? 2),
  });
  const [d, setD] = useState(read);
  useEffect(() => {
    setD(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards]);
  const save = useRewardsSave("Daily login reward saved");
  const submit = () => {
    for (const [n, v] of [["Daily reward", d.dailyLoginReward], ["Streak bonus", d.dailyStreakBonus]] as const) {
      if (!Number.isInteger(v) || v < 0 || v > 1_000_000) return toast.error(`${n}: 0 ya zyada poora number.`);
    }
    save.mutate(d);
  };
  // The server caps the streak part at 30 days (DAILY_STREAK_BONUS_MAX_DAYS).
  const maxDay = d.dailyLoginReward + 30 * d.dailyStreakBonus;
  return (
    <Card icon={CalendarCheck} title="Daily login reward" tint="text-violet-500" pending={save.isPending} onSave={submit}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Har din (coins)</label>
          <input type="number" min={0} className={field} value={d.dailyLoginReward} onChange={(e) => setD({ ...d, dailyLoginReward: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Streak bonus × din (coins)</label>
          <input type="number" min={0} className={field} value={d.dailyStreakBonus} onChange={(e) => setD({ ...d, dailyStreakBonus: num(e.target.value) })} />
        </div>
      </div>
      <p className={hint}>
        Din 1: {(d.dailyLoginReward + d.dailyStreakBonus).toLocaleString()} coin · din 7: {(d.dailyLoginReward + 7 * d.dailyStreakBonus).toLocaleString()} ·
        30+ din par max {maxDay.toLocaleString()} coin/din (streak bonus 30 din par ruk jata hai).
      </p>
    </Card>
  );
}

// ─── Daily tasks (gamification.dailyTasks) ──────────────────────────────────

interface Task {
  id: string;
  title: string;
  reward: number;
  target: number;
  type: "vote" | "share" | "ad";
}
const DEFAULT_TASKS: Task[] = [
  { id: "vote5", title: "Vote in 5 battles", reward: 15, target: 5, type: "vote" },
  { id: "share", title: "Share your profile", reward: 10, target: 1, type: "share" },
  { id: "watch_ad", title: "Watch a video ad", reward: 5, target: 1, type: "ad" },
];

export function DailyTasksCard({ rewards }: { rewards: any }) {
  const read = (): Task[] =>
    Array.isArray(rewards?.dailyTasks) && rewards.dailyTasks.length
      ? rewards.dailyTasks.map((t: any) => ({
          id: String(t.id ?? ""),
          title: String(t.title ?? ""),
          reward: Number(t.reward ?? 0),
          target: Number(t.target ?? 1),
          type: ["vote", "share", "ad"].includes(t.type) ? t.type : "ad",
        }))
      : DEFAULT_TASKS;
  const [tasks, setTasks] = useState<Task[]>(read);
  useEffect(() => {
    setTasks(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards]);
  const save = useRewardsSave("Daily tasks saved");
  const setTask = (i: number, patch: Partial<Task>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const total = tasks.reduce((s, t) => s + (Number(t.reward) || 0), 0);
  return (
    <Card icon={ListChecks} title="Daily tasks" tint="text-orange-500" pending={save.isPending} onSave={() => save.mutate({ dailyTasks: tasks })}>
      <div className="space-y-2">
        {tasks.map((t, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              {i === 0 && <label className={label}>Title</label>}
              <input className={field} value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} />
            </div>
            <div className="col-span-2">
              {i === 0 && <label className={label}>Type</label>}
              <select className={field} value={t.type} onChange={(e) => setTask(i, { type: e.target.value as Task["type"] })}>
                <option value="vote">vote</option>
                <option value="share">share</option>
                <option value="ad">ad</option>
              </select>
            </div>
            <div className="col-span-2">
              {i === 0 && <label className={label}>Target</label>}
              <input type="number" min={1} className={field} value={t.target} onChange={(e) => setTask(i, { target: num(e.target.value) })} />
            </div>
            <div className="col-span-3">
              {i === 0 && <label className={label}>Coins</label>}
              <input type="number" min={0} className={field} value={t.reward} onChange={(e) => setTask(i, { reward: num(e.target.value) })} />
            </div>
            <button
              type="button"
              title="Remove"
              onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
              className="col-span-1 p-2 rounded-lg text-red-600 hover:bg-secondary"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setTasks([...tasks, { id: `task_${Date.now().toString(36)}`, title: "", reward: 5, target: 1, type: "vote" }])}
        className="mt-3 flex items-center gap-1 text-sm font-medium text-primary"
      >
        <Plus size={14} /> Task jodo
      </button>
      <p className={hint}>Sab task poore karne par ek user ko roz {total.toLocaleString()} coin. "ad" task watch-ad se claim hota hai.</p>
    </Card>
  );
}

// ─── Hall of Fame (gamification.hallOfFameRewards) ──────────────────────────

export function HallOfFameCard({ rewards }: { rewards: any }) {
  const read = () =>
    Array.isArray(rewards?.hallOfFameRewards) && rewards.hallOfFameRewards.length === 3
      ? rewards.hallOfFameRewards.map((n: any) => String(n))
      : ["1000", "500", "250"];
  const [r, setR] = useState<string[]>(read);
  useEffect(() => {
    setR(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards]);
  const save = useRewardsSave("Hall of Fame rewards saved");
  const submit = () => {
    const vals = r.map(Number);
    if (!vals.every((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000)) return toast.error("Teeno amount 0 ya zyada poore number hone chahiye.");
    save.mutate({ hallOfFameRewards: vals });
  };
  return (
    <Card icon={Crown} title="Monthly Hall of Fame" tint="text-amber-500" pending={save.isPending} onSave={submit}>
      <div className="grid grid-cols-3 gap-3">
        {["Rank 1", "Rank 2", "Rank 3"].map((n, i) => (
          <div key={n}>
            <label className={label}>{n} (coins)</label>
            <input type="number" min={0} className={field} value={r[i]} onChange={(e) => setR(r.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
      </div>
      <p className={hint}>
        Mahine ke sabse zyada jeetne wale 3 users ko, mahina khatam hone par. Ye contest jeet ka inaam hai, isliye withdraw ho sakta hai.
        Badlav agle mahine ke settlement par lagega.
      </p>
    </Card>
  );
}
