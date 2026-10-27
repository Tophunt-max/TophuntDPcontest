import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, CalendarCheck, Crown, ListChecks, Plus, ShieldCheck, Trash2, Tv } from "lucide-react";
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
    registrationReward: Number(stored.registrationReward ?? 0),
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
    for (const [name, n] of [["Signup par turant", v.registrationReward], ["Email + mobile verify par", v.completionReward]] as const) {
      if (!Number.isInteger(n) || n < 0 || n > 500_000) return `${name}: 0 se 500,000 ke beech poora number.`;
    }
    if (!v.requireEmail && !v.requirePhone && v.completionReward > 0) return "Email ya mobile me se kam se kam ek verify karna zaroori rakho.";
    return null;
  }, [v]);
  const stats = info?.stats;
  return (
    <Card
      icon={ShieldCheck}
      title="Signup bonus"
      tint="text-emerald-500"
      pending={save.isPending}
      // The worker caps signup + verify by maxTotalReward; the cap simply
      // follows the two amounts so changing either never trips it.
      onSave={() =>
        error ? toast.error(error) : save.mutate({ verificationReward: { ...v, maxTotalReward: v.registrationReward + v.completionReward } })
      }
    >
      <Toggle label="Enabled" checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} />
      <div className="grid grid-cols-2 gap-3 mt-2">
        <div>
          <label className={label}>Signup par turant (Diamond)</label>
          <input type="number" min={0} className={field} value={v.registrationReward} onChange={(e) => setV({ ...v, registrationReward: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Email + mobile verify par (Diamond)</label>
          <input type="number" min={0} className={field} value={v.completionReward} onChange={(e) => setV({ ...v, completionReward: num(e.target.value) })} />
        </div>
      </div>
      <p className={hint}>Naye user ko kul: {(v.registrationReward + v.completionReward).toLocaleString()} Diamond.</p>
      <Toggle label="Email verify zaroori" checked={v.requireEmail} onChange={(x) => setV({ ...v, requireEmail: x })} />
      <Toggle label="Mobile verify zaroori" checked={v.requirePhone} onChange={(x) => setV({ ...v, requirePhone: x })} />
      <p className={hint}>
        Signup wale Diamond account bante hi milte hain, baaki email + mobile dono verify hone par. Dono "Free rewards: sirf khelne ke liye" me
        "Signup bonus" switch se locked hote hain. Badlav sirf naye signup par lagta hai.
      </p>
      {error && (
        <p className="text-xs text-red-600 mt-2 flex items-center gap-1.5"><AlertTriangle size={13} /> {error}</p>
      )}
      {stats && (
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          {([
            ["Enrolled", stats.enrolled],
            ["Completed", stats.completed],
            ["Diamond diye", stats.completionCoinsCredited],
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
    if (!Number.isInteger(a.reward) || a.reward < 1) return toast.error("Diamond per ad: 1 ya zyada poora number.");
    if (!Number.isInteger(a.dailyCap) || a.dailyCap < 1) return toast.error("Daily cap: 1 ya zyada poora number.");
    save.mutate({ ads: a });
  };
  return (
    <Card icon={Tv} title="Rewarded ads" tint="text-cyan-500" pending={save.isPending} onSave={submit}>
      <Toggle label="Enabled" checked={a.enabled} onChange={(x) => setA({ ...a, enabled: x })} />
      {a.enabled && (
        <Toggle label="Bina server verification ke Diamond do (risky)" checked={a.trustClient} onChange={(x) => setA({ ...a, trustClient: x })} />
      )}
      <div className="grid grid-cols-3 gap-3 mt-2">
        <div>
          <label className={label}>Provider</label>
          <input className={field} value={a.provider} placeholder="admob" onChange={(e) => setA({ ...a, provider: e.target.value })} />
        </div>
        <div>
          <label className={label}>Diamond per ad</label>
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

/** Day-reset choices (minutes ahead of UTC). Custom values are kept as-is. */
const RESET_OPTIONS: { v: number; l: string }[] = [
  { v: 0, l: "Raat 12 baje UTC (subah 5:30 IST)" },
  { v: 330, l: "Raat 12 baje IST (India)" },
];
/** Server cap on the streak bonus (lib/gamification.ts DAILY_STREAK_BONUS_MAX_DAYS). */
const STREAK_CAP = 30;

function dailyAmount(d: { dailyLoginReward: number; dailyStreakBonus: number; schedule: number[]; mode: string }, day: number) {
  if (d.mode === "schedule" && d.schedule.length) return d.schedule[(day - 1) % d.schedule.length];
  return d.dailyLoginReward + Math.min(day, STREAK_CAP) * d.dailyStreakBonus;
}

export function DailyLoginCard({ rewards }: { rewards: any }) {
  const read = () => {
    const schedule: number[] = Array.isArray(rewards?.dailyRewardSchedule) ? rewards.dailyRewardSchedule.map(Number) : [];
    return {
      enabled: rewards?.dailyLoginEnabled !== false,
      dailyLoginReward: Number(rewards?.dailyLoginReward ?? rewards?.dailyBaseReward ?? 10),
      dailyStreakBonus: Number(rewards?.dailyStreakBonus ?? 2),
      mode: schedule.length ? "schedule" : "formula",
      schedule: schedule.length ? schedule : [10, 15, 20, 25, 30, 50, 100],
      offset: Number(rewards?.dayResetOffsetMinutes ?? 0),
    };
  };
  const [d, setD] = useState(read);
  useEffect(() => {
    setD(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards]);
  const save = useRewardsSave("Daily check-in saved");
  const submit = () => {
    for (const [n, v] of [["Daily reward", d.dailyLoginReward], ["Streak bonus", d.dailyStreakBonus]] as const) {
      if (!Number.isInteger(v) || v < 0 || v > 1_000_000) return toast.error(`${n}: 0 ya zyada poora number.`);
    }
    if (d.mode === "schedule") {
      if (d.schedule.length < 1 || d.schedule.length > 30) return toast.error("Schedule me 1 se 30 din rakho.");
      if (!d.schedule.every((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000)) return toast.error("Har din ka amount 0 ya zyada poora number ho.");
    }
    save.mutate({
      dailyLoginEnabled: d.enabled,
      dailyLoginReward: d.dailyLoginReward,
      dailyStreakBonus: d.dailyStreakBonus,
      dailyRewardSchedule: d.mode === "schedule" ? d.schedule : [],
      dayResetOffsetMinutes: d.offset,
    });
  };
  const preview = Array.from({ length: 7 }, (_, i) => dailyAmount(d, i + 1));
  const resetOptions = RESET_OPTIONS.some((o) => o.v === d.offset)
    ? RESET_OPTIONS
    : [...RESET_OPTIONS, { v: d.offset, l: `Custom (UTC ${d.offset >= 0 ? "+" : ""}${d.offset} min)` }];
  return (
    <Card icon={CalendarCheck} title="Daily check-in" tint="text-violet-500" pending={save.isPending} onSave={submit}>
      <Toggle label="Enabled (band karne par app me check-in chhup jata hai)" checked={d.enabled} onChange={(x) => setD({ ...d, enabled: x })} />
      <div className="mt-2">
        <label className={label}>Naya din kab shuru ho</label>
        <select className={field} value={d.offset} onChange={(e) => setD({ ...d, offset: Number(e.target.value) })}>
          {resetOptions.map((o) => (
            <option key={o.v} value={o.v}>{o.l}</option>
          ))}
        </select>
        <p className={hint}>Check-in, daily tasks aur ad limit teeno isi time par reset hote hain. Badalne wale din ek extra claim mil sakta hai.</p>
      </div>
      <div className="flex gap-1 mt-3 bg-secondary/50 p-1 rounded-xl w-fit">
        {([["formula", "Base + streak bonus"], ["schedule", "Har din ka fixed amount"]] as const).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setD({ ...d, mode: k })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${d.mode === k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {d.mode === "formula" ? (
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label className={label}>Har din (Diamond)</label>
            <input type="number" min={0} className={field} value={d.dailyLoginReward} onChange={(e) => setD({ ...d, dailyLoginReward: num(e.target.value) })} />
          </div>
          <div>
            <label className={label}>Streak bonus × din (Diamond)</label>
            <input type="number" min={0} className={field} value={d.dailyStreakBonus} onChange={(e) => setD({ ...d, dailyStreakBonus: num(e.target.value) })} />
          </div>
          <p className={`${hint} col-span-2`}>
            30+ din par max {(d.dailyLoginReward + STREAK_CAP * d.dailyStreakBonus).toLocaleString()} Diamond/din (streak bonus 30 din par ruk jata hai).
          </p>
        </div>
      ) : (
        <div className="mt-2">
          <div className="grid grid-cols-7 gap-1.5">
            {d.schedule.map((v, i) => (
              <div key={i}>
                <label className="text-[10px] text-muted-foreground">Din {i + 1}</label>
                <input
                  type="number"
                  min={0}
                  className={`${field} px-1.5 text-center`}
                  value={v}
                  onChange={(e) => setD({ ...d, schedule: d.schedule.map((x, j) => (j === i ? num(e.target.value) : x)) })}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-2">
            <button type="button" disabled={d.schedule.length >= 30} onClick={() => setD({ ...d, schedule: [...d.schedule, d.schedule[d.schedule.length - 1] ?? 10] })} className="text-xs font-medium text-primary disabled:opacity-40">
              + Din jodo
            </button>
            <button type="button" disabled={d.schedule.length <= 1} onClick={() => setD({ ...d, schedule: d.schedule.slice(0, -1) })} className="text-xs font-medium text-red-600 disabled:opacity-40">
              − Aakhri din hatao
            </button>
          </div>
          <p className={hint}>{d.schedule.length} din ke baad schedule phir Din 1 se shuru hota hai (streak chalti rehti hai).</p>
        </div>
      )}
      <p className={hint}>App me dikhega (Din 1–7): {preview.map((n) => n.toLocaleString()).join(" · ")} Diamond. Yahi amount server deta hai.</p>
    </Card>
  );
}

// ─── Daily tasks (gamification.dailyTasks) ──────────────────────────────────

type TaskType = "vote" | "share" | "contest" | "ad";
interface Task {
  id: string;
  title: string;
  reward: number;
  target: number;
  type: TaskType;
  enabled: boolean;
  startsAt: number | null;
  endsAt: number | null;
  /** UI only: a row added in this session, whose id may still be edited. */
  isNew?: boolean;
}
const TASK_TYPES: { v: TaskType; l: string }[] = [
  { v: "vote", l: "Vote karo" },
  { v: "share", l: "Battle share karo" },
  { v: "contest", l: "Contest join karo" },
  { v: "ad", l: "Ad dekho" },
];
const DEFAULT_TASKS: Task[] = [
  { id: "vote5", title: "Vote in 5 battles", reward: 15, target: 5, type: "vote", enabled: true, startsAt: null, endsAt: null },
  { id: "share", title: "Share a battle", reward: 10, target: 1, type: "share", enabled: true, startsAt: null, endsAt: null },
  { id: "watch_ad", title: "Watch a video ad", reward: 5, target: 1, type: "ad", enabled: true, startsAt: null, endsAt: null },
];
/** epoch ms <-> <input type="datetime-local"> (local time). */
const toLocalInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() || null : null);

export function DailyTasksCard({ rewards }: { rewards: any }) {
  const read = (): Task[] =>
    Array.isArray(rewards?.dailyTasks) && rewards.dailyTasks.length
      ? rewards.dailyTasks.map((t: any) => ({
          id: String(t.id ?? ""),
          title: String(t.title ?? ""),
          reward: Number(t.reward ?? 0),
          target: Number(t.target ?? 1),
          type: TASK_TYPES.some((x) => x.v === t.type) ? t.type : "ad",
          enabled: t.enabled !== false,
          startsAt: t.startsAt ? Number(t.startsAt) : null,
          endsAt: t.endsAt ? Number(t.endsAt) : null,
        }))
      : DEFAULT_TASKS;
  const [tasks, setTasks] = useState<Task[]>(read);
  useEffect(() => {
    setTasks(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards]);
  const save = useRewardsSave("Daily tasks saved");
  const setTask = (i: number, patch: Partial<Task>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const total = tasks.filter((t) => t.enabled).reduce((s, t) => s + (Number(t.reward) || 0), 0);
  const submit = () => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(t.id)) return toast.error(`Task id "${t.id}": 2–40 letters, digits, _ ya -.`);
      if (ids.has(t.id)) return toast.error(`Task id "${t.id}" do baar hai.`);
      ids.add(t.id);
      if (!t.title.trim()) return toast.error(`Task "${t.id}": title zaroori hai.`);
      if (t.startsAt && t.endsAt && t.endsAt <= t.startsAt) return toast.error(`Task "${t.id}": end, start ke baad ho.`);
    }
    save.mutate({ dailyTasks: tasks.map(({ isNew: _n, ...t }) => t) });
  };
  return (
    <Card icon={ListChecks} title="Daily tasks" tint="text-orange-500" pending={save.isPending} onSave={submit}>
      <div className="space-y-3">
        {tasks.map((t, i) => (
          <div key={i} className={`rounded-xl border border-border p-3 ${t.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center gap-2">
              <input className={`${field} flex-1`} placeholder="Title" value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} />
              <button
                type="button"
                title={t.enabled ? "Band karo" : "Chalu karo"}
                onClick={() => setTask(i, { enabled: !t.enabled })}
                className={`px-2.5 py-2 rounded-lg text-xs font-semibold ${t.enabled ? "bg-green-100 text-green-700" : "bg-secondary text-muted-foreground"}`}
              >
                {t.enabled ? "On" : "Off"}
              </button>
              <button type="button" title="Remove" onClick={() => setTasks(tasks.filter((_, j) => j !== i))} className="p-2 rounded-lg text-red-600 hover:bg-secondary">
                <Trash2 size={15} />
              </button>
            </div>
            <div className="grid grid-cols-12 gap-2 mt-2">
              <div className="col-span-4">
                <label className={label}>Type</label>
                <select className={field} value={t.type} onChange={(e) => setTask(i, { type: e.target.value as TaskType })}>
                  {TASK_TYPES.map((x) => (
                    <option key={x.v} value={x.v}>{x.l}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className={label}>Target</label>
                <input type="number" min={1} className={field} value={t.target} onChange={(e) => setTask(i, { target: num(e.target.value) })} />
              </div>
              <div className="col-span-2">
                <label className={label}>Diamond</label>
                <input type="number" min={0} className={field} value={t.reward} onChange={(e) => setTask(i, { reward: num(e.target.value) })} />
              </div>
              <div className="col-span-4">
                <label className={label}>ID {t.isNew ? "" : "(locked)"}</label>
                <input
                  className={`${field} font-mono text-xs`}
                  value={t.id}
                  readOnly={!t.isNew}
                  title={t.isNew ? "" : "Save hone ke baad id nahi badalti: nayi id se users usi din dobara claim kar lete."}
                  onChange={(e) => setTask(i, { id: e.target.value })}
                />
              </div>
              <div className="col-span-6">
                <label className={label}>Start (optional)</label>
                <input type="datetime-local" className={field} value={toLocalInput(t.startsAt)} onChange={(e) => setTask(i, { startsAt: fromLocalInput(e.target.value) })} />
              </div>
              <div className="col-span-6">
                <label className={label}>End (optional)</label>
                <input type="datetime-local" className={field} value={toLocalInput(t.endsAt)} onChange={(e) => setTask(i, { endsAt: fromLocalInput(e.target.value) })} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setTasks([
            ...tasks,
            { id: `task_${Date.now().toString(36)}`, title: "", reward: 5, target: 1, type: "vote", enabled: true, startsAt: null, endsAt: null, isNew: true },
          ])
        }
        className="mt-3 flex items-center gap-1 text-sm font-medium text-primary"
      >
        <Plus size={14} /> Task jodo
      </button>
      <p className={hint}>
        Chalu task poore karne par ek user ko roz {total.toLocaleString()} Diamond. Progress server ginta hai: vote = aaj ke vote, share = aaj share ki gayi
        alag-alag battles (ek battle do baar nahi ginti), contest = aaj ke contest entry. "Ad" task watch-ad se claim hota hai.
      </p>
    </Card>
  );
}

// ─── Check-in + task activity (GET /admin/rewards/stats) ────────────────────

export function RewardStatsCard() {
  const { data, isLoading } = useQuery({ queryKey: ["reward-stats"], queryFn: () => api.rewardStats(14) });
  const taskTitle = new Map((data?.tasks ?? []).map((t) => [t.id, t.title]));
  const today = data?.days?.[0];
  return (
    <Card icon={BarChart3} title="Check-in aur tasks: pichhle 14 din" tint="text-sky-500">
      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 mb-3 text-center">
            {([
              ["Aaj check-in", today?.checkins ?? 0],
              ["Aaj task claims", today?.taskClaims ?? 0],
              ["7+ din streak", data.activeStreaks.atLeast7],
              ["30+ din streak", data.activeStreaks.atLeast30],
            ] as const).map(([n, v]) => (
              <div key={n} className="rounded-xl bg-secondary py-2">
                <div className="text-sm font-bold text-foreground">{Number(v).toLocaleString()}</div>
                <div className="text-[11px] text-muted-foreground">{n}</div>
              </div>
            ))}
          </div>
          {today && Object.keys(today.tasks).length > 0 && (
            <p className="text-xs text-muted-foreground mb-2">
              Aaj task-wise:{" "}
              {Object.entries(today.tasks)
                .map(([id, v]) => `${taskTitle.get(id) ?? id} ${v.claims}`)
                .join(" · ")}
            </p>
          )}
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-1">Din</th>
                  <th className="text-right">Check-in</th>
                  <th className="text-right">💎 diye</th>
                  <th className="text-right">Task claims</th>
                  <th className="text-right">💎 diye</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day} className="border-t border-border">
                    <td className="py-1">{d.date}</td>
                    <td className="text-right">{d.checkins.toLocaleString()}</td>
                    <td className="text-right">{d.checkinCoins.toLocaleString()}</td>
                    <td className="text-right">{d.taskClaims.toLocaleString()}</td>
                    <td className="text-right">{d.taskCoins.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={hint}>Din admin ke reset time ke hisaab se ({data.dayResetOffsetMinutes === 330 ? "IST" : data.dayResetOffsetMinutes === 0 ? "UTC" : `UTC ${data.dayResetOffsetMinutes} min`}).</p>
        </>
      )}
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
            <label className={label}>{n} (Diamond)</label>
            <input type="number" min={0} className={field} value={r[i]} onChange={(e) => setR(r.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
      </div>
      <p className={hint}>
        Mahine ke sabse zyada jeetne wale 3 users ko, mahina khatam hone par, Diamond me. Ye platform ka free inaam hai, isliye withdraw nahi hota (fake accounts se jeet farm karke paisa nikalna band).
        Badlav agle mahine ke settlement par lagega.
      </p>
    </Card>
  );
}
