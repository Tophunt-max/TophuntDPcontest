import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describeError } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { isFullAdminRole, useAuth } from "@/lib/auth";
import {
  MilestonesEditor, QuestsEditor, RanksEditor,
  type MilestoneRow, type QuestRow, type RankRow,
} from "@/components/gamification/ProgressionEditors";

/**
 * Gamification admin: XP rules, levels, achievements, cosmetics, seasons,
 * user inspection with audited corrections, review flags and analytics.
 *
 * Every rule is validated again by the Worker (routes/adminGamification.ts);
 * the forms here only make it easier to get right. Writes that move XP or
 * coins ask for a recent sign-in, and budget-linked rewards ask for the
 * approval password (handled by lib/api.ts `req`).
 */
const TABS = ["overview", "rules", "achievements", "catalog", "seasons", "grants", "users", "flags"] as const;
type Tab = (typeof TABS)[number];

const field = "w-full px-3 py-2 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const btn = "gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50";
const btn2 = "bg-secondary text-foreground text-sm font-medium px-3 py-1.5 rounded-lg disabled:opacity-50";
const card = "bg-card border border-border rounded-2xl p-5";

export default function GamificationPage() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div>
      <PageHeader title="Gamification" subtitle="XP, levels, achievements, cosmetics, quests and seasons" />
      <div className="flex flex-wrap gap-1 mb-5 bg-secondary/50 p-1 rounded-xl w-fit">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize ${tab === t ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview />}
      {tab === "rules" && <Rules />}
      {tab === "achievements" && <Achievements />}
      {tab === "catalog" && <Catalog />}
      {tab === "seasons" && <Seasons />}
      {tab === "grants" && <Grants />}
      {tab === "users" && <UserInspector />}
      {tab === "flags" && <Flags />}
    </div>
  );
}

// ---------------------------------------------------------------- overview
function Overview() {
  const { user } = useAuth();
  // Older servers do not report a role; the Worker still enforces it.
  const full = !user?.role || isFullAdminRole(user.role);
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["gam", "analytics", days], queryFn: () => api.gamification.analytics(days), enabled: full });
  const recon = useMutation({
    mutationFn: () => api.gamification.reconcile(),
    onSuccess: (r) => (r.mismatches.length ? toast.error(`${r.mismatches.length} of ${r.checked} accounts do not match their XP ledger`) : toast.success(`All ${r.checked} recent accounts match their XP ledger`)),
    onError: (e) => toast.error(describeError(e)),
  });
  if (!full) return <p className="text-sm text-muted-foreground">Analytics are available to full admins.</p>;
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{describeError(q.error)}</p>;
  const d = q.data;
  const byAction: Record<string, { xp: number; events: number }> = {};
  for (const r of d.xpByDay) {
    byAction[r.action] ??= { xp: 0, events: 0 };
    byAction[r.action].xp += Number(r.xp);
    byAction[r.action].events += Number(r.events);
  }
  const earners = d.activeEarners.map((r: any) => Number(r.n));
  return (
    <div className="space-y-5">
      <div className="flex gap-2 items-center">
        <select className={`${field} w-40`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
        </select>
        <button className={btn2} onClick={() => recon.mutate()} disabled={recon.isPending}>Check XP ledger</button>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <div className={card}>
          <p className="text-sm text-muted-foreground">Active XP earners (latest day)</p>
          <p className="text-2xl font-bold">{fmtNumber(earners[earners.length - 1] ?? 0)}</p>
          <p className="text-xs text-muted-foreground">Average {fmtNumber(Math.round(earners.reduce((a: number, b: number) => a + b, 0) / Math.max(1, earners.length)))} a day</p>
        </div>
        <div className={card}>
          <p className="text-sm text-muted-foreground">Open review flags</p>
          <p className="text-2xl font-bold">{fmtNumber(d.flags.filter((f: any) => f.status === "open").reduce((a: number, f: any) => a + Number(f.n), 0))}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-muted-foreground">Reward budget</p>
          {d.rewardBudget ? (
            <p className="text-sm">{d.rewardBudget.name}: {fmtNumber(d.rewardBudget.spentCoins ?? d.rewardBudget.spent_coins)} / {fmtNumber(d.rewardBudget.totalCoins ?? d.rewardBudget.total_coins)} spent</p>
          ) : <p className="text-sm text-muted-foreground">Falls back to the free-rewards budget (or none).</p>}
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className={card}>
          <p className="font-semibold mb-3">XP issued by activity</p>
          <Table data={Object.entries(byAction).map(([action, v]) => ({ action, ...v }))} keyFn={(r: any) => r.action} empty="No XP yet"
            columns={[
              { key: "action", header: "Activity", render: (r: any) => <span>{r.action}</span> },
              { key: "xp", header: "XP", render: (r: any) => <span>{fmtNumber(r.xp)}</span> },
              { key: "events", header: "Events", render: (r: any) => <span>{fmtNumber(r.events)}</span> },
            ]} />
        </div>
        <div className={card}>
          <p className="font-semibold mb-3">Level distribution</p>
          <Table data={d.levelDistribution} keyFn={(r: any) => r.rank} empty="No users"
            columns={[
              { key: "rank", header: "Rank", render: (r: any) => <span>{r.rank} (Lv {r.minLevel}+)</span> },
              { key: "minXp", header: "From XP", render: (r: any) => <span>{fmtNumber(r.minXp)}</span> },
              { key: "users", header: "Users", render: (r: any) => <span>{fmtNumber(r.users)}</span> },
            ]} />
        </div>
        <div className={card}>
          <p className="font-semibold mb-3">Achievement completion</p>
          <Table data={d.achievements} keyFn={(r: any) => r.achievement_id} empty="None unlocked yet"
            columns={[
              { key: "id", header: "Achievement", render: (r: any) => <span>{r.achievement_id}</span> },
              { key: "n", header: "Users", render: (r: any) => <span>{fmtNumber(r.n)}</span> },
            ]} />
        </div>
        <div className={card}>
          <p className="font-semibold mb-3">Reward grants</p>
          <Table data={d.rewardGrants} keyFn={(r: any) => `${r.source_type}:${r.status}`} empty="No coin rewards configured"
            columns={[
              { key: "source", header: "Source", render: (r: any) => <span>{r.source_type}</span> },
              { key: "status", header: "Status", render: (r: any) => <Badge>{r.status}</Badge> },
              { key: "n", header: "Count", render: (r: any) => <span>{fmtNumber(r.n)}</span> },
              { key: "coins", header: "Diamond", render: (r: any) => <span>{fmtNumber(r.coins)}</span> },
            ]} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- rules
const ACTIONS = ["vote", "contest_entry", "match_win", "match_loss", "daily_checkin", "hall_of_fame", "daily_task", "quest", "achievement"];
const VARIABLE = new Set(["daily_task", "quest", "achievement"]);

function Rules() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["gam", "config"], queryFn: api.gamification.config });
  const catalog = useQuery({ queryKey: ["gam", "catalog"], queryFn: api.gamification.catalog });
  const [draft, setDraft] = useState<any>(null);
  const [betaUids, setBetaUids] = useState("");
  useEffect(() => {
    if (!q.data) return;
    setDraft({ ...q.data.progression, xpThreshold: q.data.xpThreshold, xpIncrement: q.data.xpIncrement });
    setBetaUids((q.data.progression.betaUids || []).join("\n"));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const { xpThreshold, xpIncrement, version, ...rest } = draft;
      void version;
      return api.gamification.saveConfig({
        xpThreshold: Number(xpThreshold),
        xpIncrement: Number(xpIncrement),
        progression: {
          ...rest,
          maxLevel: Number(rest.maxLevel),
          pinnedLimit: Number(rest.pinnedLimit),
          velocityFlagEvents: Number(rest.velocityFlagEvents),
          rewardBudgetId: rest.rewardBudgetId || null,
          betaUids: betaUids.split(/[\s,]+/).filter(Boolean),
          // The Worker wants ranks by increasing level; milestones read best that way too.
          ranks: [...(rest.ranks as RankRow[])]
            .map((r) => ({ ...r, id: r.id.trim(), name: r.name.trim(), minLevel: Number(r.minLevel) }))
            .sort((a, b) => a.minLevel - b.minLevel),
          milestones: [...(rest.milestones as MilestoneRow[])]
            .map((m) => ({ ...m, level: Number(m.level), coins: Number(m.coins || 0), feature: m.feature || null }))
            .sort((a, b) => a.level - b.level),
          quests: (rest.quests as QuestRow[]).map((x) => ({
            ...x, id: x.id.trim(), target: Number(x.target), xp: Number(x.xp), minLevel: Number(x.minLevel || 1), enabled: x.enabled !== false,
          })),
        },
      });
    },
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["gam"] }); },
    onError: (e) => toast.error(describeError(e)),
  });
  if (q.isLoading || !draft) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{describeError(q.error)}</p>;
  const setRule = (a: string, k: string, v: any) => setDraft((d: any) => ({ ...d, rules: { ...d.rules, [a]: { ...d.rules[a], [k]: v } } }));
  return (
    <div className="space-y-5">
      <div className={card}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="font-semibold">Experience</p>
            <p className="text-xs text-muted-foreground">Off: XP is still recorded on the ledger and levels still compute, but achievements, quests, seasons, level-up notifications and coin rewards are hidden. Turn on for beta users first.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={!!draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled for everyone
          </label>
        </div>
        <p className="text-sm font-medium mt-4 mb-1">Beta users (uids, one per line)</p>
        <textarea className={`${field} h-20 font-mono`} value={betaUids} onChange={(e) => setBetaUids(e.target.value)} />
      </div>

      <div className={card}>
        <p className="font-semibold mb-3">Level curve</p>
        <p className="text-xs text-muted-foreground mb-3">Going from level L to L+1 costs threshold + (L−1) × increment. Changing these moves every user's level immediately (XP is never changed).</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-sm">Threshold<input type="number" className={field} value={draft.xpThreshold} onChange={(e) => setDraft({ ...draft, xpThreshold: e.target.value })} /></label>
          <label className="text-sm">Increment<input type="number" className={field} value={draft.xpIncrement} onChange={(e) => setDraft({ ...draft, xpIncrement: e.target.value })} /></label>
          <label className="text-sm">Max level<input type="number" className={field} value={draft.maxLevel} onChange={(e) => setDraft({ ...draft, maxLevel: e.target.value })} /></label>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Saved curve: {q.data.curvePreview.map((c: any) => `L${c.level}=${fmtNumber(c.xp)}`).join(" · ")}
        </p>
      </div>

      <div className={card}>
        <p className="font-semibold mb-3">XP rules</p>
        <Table data={ACTIONS} keyFn={(a: string) => a}
          columns={[
            { key: "a", header: "Action", render: (a: string) => <span className="font-mono text-xs">{a}</span> },
            { key: "xp", header: "XP", render: (a: string) => VARIABLE.has(a)
              ? <span className="text-xs text-muted-foreground">set per task / quest / achievement</span>
              : <input type="number" className={`${field} w-24`} value={draft.rules[a]?.xp ?? 0} onChange={(e) => setRule(a, "xp", Number(e.target.value))} /> },
            { key: "cap", header: "Daily cap (XP)", render: (a: string) => (
              <input type="number" placeholder="none" className={`${field} w-28`} value={draft.rules[a]?.dailyCap ?? ""} onChange={(e) => setRule(a, "dailyCap", e.target.value === "" ? null : Number(e.target.value))} />
            ) },
            { key: "on", header: "Enabled", render: (a: string) => <input type="checkbox" checked={draft.rules[a]?.enabled !== false} onChange={(e) => setRule(a, "enabled", e.target.checked)} /> },
          ]} />
      </div>

      <div className={card}>
        <p className="font-semibold mb-3">Limits</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-sm">Pinned achievements<input type="number" className={field} value={draft.pinnedLimit} onChange={(e) => setDraft({ ...draft, pinnedLimit: e.target.value })} /></label>
          <label className="text-sm">Velocity flag (events/day/action)<input type="number" className={field} value={draft.velocityFlagEvents} onChange={(e) => setDraft({ ...draft, velocityFlagEvents: e.target.value })} /></label>
          <label className="text-sm">Reward budget id (free_rewards)<input className={field} value={draft.rewardBudgetId ?? ""} onChange={(e) => setDraft({ ...draft, rewardBudgetId: e.target.value })} /></label>
        </div>
      </div>

      <div className={card}>
        <p className="font-semibold mb-1">Ranks</p>
        <p className="text-xs text-muted-foreground mb-3">A rank covers every level from its start level up to the next rank. The first rank must start at level 1; rows are sorted by level on save.</p>
        <RanksEditor rows={draft.ranks} onChange={(ranks) => setDraft({ ...draft, ranks })} />
      </div>
      <div className={card}>
        <p className="font-semibold mb-1">Level milestones</p>
        <p className="text-xs text-muted-foreground mb-3">One per level. Items are catalog ids granted on reaching the level. Diamond is paid through the reward budget and needs the approval password. Existing unlocks are never taken away.</p>
        <MilestonesEditor rows={draft.milestones} onChange={(milestones) => setDraft({ ...draft, milestones })} itemIds={(catalog.data ?? []).map((i: any) => i.id)} />
      </div>
      <div className={card}>
        <p className="font-semibold mb-1">Quests</p>
        <p className="text-xs text-muted-foreground mb-3">Weekly or monthly goals. The user claims the XP once per period. Min level hides the quest from lower levels.</p>
        <QuestsEditor rows={draft.quests} onChange={(quests) => setDraft({ ...draft, quests })} />
      </div>
      <button className={btn} onClick={() => save.mutate()} disabled={save.isPending}>Save configuration</button>
    </div>
  );
}

// ------------------------------------------------------------ achievements
const EMPTY_ACH = { id: "", name: "", description: "", icon: "trophy", category: "general", rarity: "common", metric: "wins", threshold: 1, xpReward: 25, itemId: "", repeatable: false, maxTiers: 1, active: true, hidden: false, sort: 0 };

function Achievements() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["gam", "achievements"], queryFn: api.gamification.achievements });
  const cfg = useQuery({ queryKey: ["gam", "config"], queryFn: api.gamification.config });
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({
    mutationFn: () => api.gamification.saveAchievement(edit.id, {
      ...edit, threshold: Number(edit.threshold), xpReward: Number(edit.xpReward), maxTiers: Number(edit.maxTiers), sort: Number(edit.sort), itemId: edit.itemId || null,
    }),
    onSuccess: () => { toast.success("Saved"); setEdit(null); qc.invalidateQueries({ queryKey: ["gam", "achievements"] }); },
    onError: (e) => toast.error(describeError(e)),
  });
  return (
    <div className="space-y-4">
      <button className={btn} onClick={() => setEdit({ ...EMPTY_ACH })}>New achievement</button>
      {edit && (
        <div className={card}>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="text-sm">Id<input className={field} value={edit.id} disabled={!!q.data?.some((a: any) => a.id === edit.id && edit._existing)} onChange={(e) => setEdit({ ...edit, id: e.target.value })} /></label>
            <label className="text-sm">Name<input className={field} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="text-sm">Icon<input className={field} value={edit.icon} onChange={(e) => setEdit({ ...edit, icon: e.target.value })} /></label>
            <label className="text-sm sm:col-span-3">Description<input className={field} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <label className="text-sm">Metric
              <select className={field} value={edit.metric} onChange={(e) => setEdit({ ...edit, metric: e.target.value })}>
                {(cfg.data?.metrics ?? []).map((m: string) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="text-sm">Threshold<input type="number" className={field} value={edit.threshold} onChange={(e) => setEdit({ ...edit, threshold: e.target.value })} /></label>
            <label className="text-sm">XP reward<input type="number" className={field} value={edit.xpReward} onChange={(e) => setEdit({ ...edit, xpReward: e.target.value })} /></label>
            <label className="text-sm">Category<input className={field} value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></label>
            <label className="text-sm">Rarity
              <select className={field} value={edit.rarity} onChange={(e) => setEdit({ ...edit, rarity: e.target.value })}>
                {["common", "uncommon", "rare", "epic", "legendary"].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="text-sm">Reward item id<input className={field} value={edit.itemId ?? ""} onChange={(e) => setEdit({ ...edit, itemId: e.target.value })} /></label>
            <label className="text-sm">Max tiers<input type="number" className={field} value={edit.maxTiers} onChange={(e) => setEdit({ ...edit, maxTiers: e.target.value })} /></label>
            <label className="text-sm">Sort<input type="number" className={field} value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: e.target.value })} /></label>
          </div>
          <div className="flex gap-4 mt-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.repeatable} onChange={(e) => setEdit({ ...edit, repeatable: e.target.checked })} /> Repeatable (tiers)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.hidden} onChange={(e) => setEdit({ ...edit, hidden: e.target.checked })} /> Hidden until unlocked</label>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Changing a rule never removes an achievement someone already unlocked.</p>
          <div className="flex gap-2 mt-4">
            <button className={btn} onClick={() => save.mutate()} disabled={save.isPending || !edit.id || !edit.name}>Save</button>
            <button className={btn2} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      <Table loading={q.isLoading} data={q.data ?? []} keyFn={(a: any) => a.id} empty="No achievements"
        columns={[
          { key: "name", header: "Achievement", render: (a: any) => <div><p className="font-medium">{a.name}</p><p className="text-xs text-muted-foreground">{a.id} · {a.description}</p></div> },
          { key: "rule", header: "Rule", render: (a: any) => <span className="text-xs">{a.metric} ≥ {a.threshold}{a.repeatable ? ` ×${a.maxTiers}` : ""}</span> },
          { key: "xp", header: "XP", render: (a: any) => <span>{a.xpReward}</span> },
          { key: "state", header: "State", render: (a: any) => <Badge variant={a.active ? "primary" : undefined}>{a.active ? "active" : "inactive"}</Badge> },
          { key: "n", header: "Unlocked by", render: (a: any) => <span>{fmtNumber(a.unlockedBy)}</span> },
          { key: "edit", header: "", render: (a: any) => <button className={btn2} onClick={() => setEdit({ ...a, itemId: a.itemId ?? "", _existing: true })}>Edit</button> },
        ]} />
    </div>
  );
}

// ----------------------------------------------------------------- catalog
/** Frame designs the app draws (apps/expo/src/lib/gamificationAssets.ts). */
const FRAME_KEYS = ["frame.starter", "frame.bronze", "frame.silver", "frame.gold", "frame.champion", "frame.legendary"];
const EMPTY_ITEM = { id: "", type: "frame", name: "", description: "", rarity: "common", asset: { key: "frame.gold", colors: ["#FF4D67", "#8B5CF6"], animated: false }, active: true, sort: 0 };

function Catalog() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["gam", "catalog"], queryFn: api.gamification.catalog });
  const [edit, setEdit] = useState<any>(null);
  const [asset, setAsset] = useState("");
  const save = useMutation({
    mutationFn: () => {
      let parsed: any;
      try { parsed = JSON.parse(asset || "{}"); } catch { throw new Error("asset is not valid JSON."); }
      return api.gamification.saveItem(edit.id, { ...edit, asset: parsed, sort: Number(edit.sort) });
    },
    onSuccess: () => { toast.success("Saved"); setEdit(null); qc.invalidateQueries({ queryKey: ["gam", "catalog"] }); },
    onError: (e) => toast.error(describeError(e)),
  });
  const open = (it: any) => { setEdit(it); setAsset(JSON.stringify(it.asset ?? {}, null, 2)); };
  const swatch = (a: any) => {
    const c = Array.isArray(a?.colors) ? a.colors : [];
    return <div className="w-8 h-8 rounded-full border border-border" style={{ background: c.length > 1 ? `linear-gradient(135deg, ${c[0]}, ${c[1]})` : c[0] || "#ddd" }} />;
  };
  return (
    <div className="space-y-4">
      <button className={btn} onClick={() => open({ ...EMPTY_ITEM })}>New item</button>
      {edit && (
        <div className={card}>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="text-sm">Id<input className={field} value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} /></label>
            <label className="text-sm">Type
              <select className={field} value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                {["frame", "theme", "title", "badge", "accessory", "effect", "sticker", "collectible"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="text-sm">Name<input className={field} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="text-sm sm:col-span-3">Description<input className={field} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <label className="text-sm">Rarity
              <select className={field} value={edit.rarity} onChange={(e) => setEdit({ ...edit, rarity: e.target.value })}>
                {["common", "uncommon", "rare", "epic", "legendary"].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="text-sm">Sort<input type="number" className={field} value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Available</label>
          </div>
          <p className="text-sm font-medium mt-3 mb-1">Asset (key, colors: up to 4 #RRGGBB, animated, icon, text)</p>
          <p className="text-xs text-muted-foreground mb-1">
            <code>key</code> picks the app artwork. Frames: {FRAME_KEYS.join(", ")}. Without a key the app picks a design from the item id, then rarity.
          </p>
          <div className="flex gap-3 items-start">
            <textarea className={`${field} h-28 font-mono text-xs`} value={asset} onChange={(e) => setAsset(e.target.value)} />
            {(() => { try { return swatch(JSON.parse(asset)); } catch { return null; } })()}
          </div>
          <p className="text-xs text-muted-foreground mt-2">Items are visual only. An owned item keeps its type; edits apply to everyone who owns it and are audit-logged.</p>
          <div className="flex gap-2 mt-4">
            <button className={btn} onClick={() => save.mutate()} disabled={save.isPending || !edit.id || !edit.name}>Save</button>
            <button className={btn2} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      <Table loading={q.isLoading} data={q.data ?? []} keyFn={(i: any) => i.id} empty="No items"
        columns={[
          { key: "prev", header: "", render: (i: any) => swatch(i.asset) },
          { key: "name", header: "Item", render: (i: any) => <div><p className="font-medium">{i.name}</p><p className="text-xs text-muted-foreground">{i.id} · {i.type}</p></div> },
          { key: "rarity", header: "Rarity", render: (i: any) => <Badge>{i.rarity}</Badge> },
          { key: "owners", header: "Owners", render: (i: any) => <span>{fmtNumber(i.owners)}</span> },
          { key: "active", header: "State", render: (i: any) => <span className="text-xs">{i.active ? "available" : "hidden"}</span> },
          { key: "edit", header: "", render: (i: any) => <button className={btn2} onClick={() => open(i)}>Edit</button> },
        ]} />
    </div>
  );
}

// ----------------------------------------------------------------- seasons
const toLocal = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function Seasons() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["gam", "seasons"], queryFn: api.gamification.seasons });
  const blank = () => ({ name: "", description: "", startsAt: toLocal(Date.now() + 86400000), endsAt: toLocal(Date.now() + 29 * 86400000), topN: 100, rewards: '[{"fromRank":1,"toRank":3,"coins":0,"itemId":"collectible_season_top"}]' });
  const [form, setForm] = useState(blank);
  // The season being edited, or null when the form schedules a new one.
  const [editing, setEditing] = useState<{ id: string; status: string } | null>(null);
  const [results, setResults] = useState<string | null>(null);
  const res = useQuery({ queryKey: ["gam", "seasonResults", results], queryFn: () => api.gamification.seasonResults(results!), enabled: !!results });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["gam", "seasons"] });
  const startEdit = (s: any) => {
    setEditing({ id: s.id, status: s.status });
    setForm({ name: s.name, description: s.description ?? "", startsAt: toLocal(s.starts_at), endsAt: toLocal(s.ends_at), topN: s.top_n, rewards: JSON.stringify(s.rewards ?? []) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const stopEdit = () => { setEditing(null); setForm(blank()); };
  const submit = useMutation({
    mutationFn: () => {
      let rewards: any;
      try { rewards = JSON.parse(form.rewards); } catch { throw new Error("rewards is not valid JSON."); }
      const payload: any = { name: form.name, description: form.description, topN: Number(form.topN), rewards };
      // A running season keeps its schedule (the Worker ignores new dates for it).
      if (!editing || editing.status === "scheduled") {
        payload.startsAt = new Date(form.startsAt).getTime();
        payload.endsAt = new Date(form.endsAt).getTime();
      }
      return editing ? api.gamification.updateSeason(editing.id, payload) : api.gamification.createSeason(payload);
    },
    onSuccess: () => { toast.success(editing ? "Season updated" : "Season scheduled"); stopEdit(); invalidate(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const datesLocked = editing?.status === "active";
  const finalize = useMutation({ mutationFn: (id: string) => api.gamification.finalizeSeason(id), onSuccess: () => { toast.success("Finalized"); invalidate(); }, onError: (e) => toast.error(describeError(e)) });
  const cancel = useMutation({
    mutationFn: (id: string) => { const r = window.prompt("Reason for cancelling this season?") || ""; return api.gamification.cancelSeason(id, r); },
    onSuccess: () => { toast.success("Cancelled"); invalidate(); },
    onError: (e) => toast.error(describeError(e)),
  });
  return (
    <div className="space-y-4">
      <div className={card}>
        <p className="font-semibold mb-3">{editing ? `Edit season “${form.name}”` : "Schedule a season"}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-sm">Name<input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="text-sm">Ranked places (top N)<input type="number" className={field} value={form.topN} onChange={(e) => setForm({ ...form, topN: Number(e.target.value) })} /></label>
          <label className="text-sm">Starts<input type="datetime-local" className={field} disabled={datesLocked} value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label>
          <label className="text-sm">Ends<input type="datetime-local" className={field} disabled={datesLocked} value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></label>
          {datesLocked && <p className="text-xs text-muted-foreground sm:col-span-2">This season is running, so its dates are fixed. Moving them would change who earned what.</p>}
          <label className="text-sm sm:col-span-2">Description<input className={field} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="text-sm sm:col-span-2">Reward bands (JSON: fromRank, toRank, coins, itemId)
            <textarea className={`${field} h-24 font-mono text-xs`} value={form.rewards} onChange={(e) => setForm({ ...form, rewards: e.target.value })} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Ranking: season XP, then lifetime XP, then account age. Admin XP adjustments do not count. Coin rewards become claimable grants paid from the reward budget. Lifetime XP is never reset.</p>
        <div className="flex gap-2 mt-3">
          <button className={btn} onClick={() => submit.mutate()} disabled={submit.isPending || !form.name}>{editing ? "Save changes" : "Schedule"}</button>
          {editing && <button className={btn2} onClick={stopEdit}>Cancel edit</button>}
        </div>
      </div>
      <Table loading={q.isLoading} data={q.data ?? []} keyFn={(s: any) => s.id} empty="No seasons"
        columns={[
          { key: "name", header: "Season", render: (s: any) => <div><p className="font-medium">{s.name}</p><p className="text-xs text-muted-foreground">{fmtDateTime(s.starts_at)} → {fmtDateTime(s.ends_at)}</p></div> },
          { key: "status", header: "Status", render: (s: any) => <Badge>{s.status}</Badge> },
          { key: "top", header: "Top N", render: (s: any) => <span>{s.top_n}</span> },
          { key: "rewards", header: "Rewards", render: (s: any) => <span className="text-xs">{s.rewards.map((r: any) => `#${r.fromRank}-${r.toRank}: ${r.coins ? `${r.coins}💎 ` : ""}${r.itemId ?? ""}`).join(" · ") || "—"}</span> },
          { key: "act", header: "", render: (s: any) => (
            <div className="flex gap-2">
              {["scheduled", "active"].includes(s.status) && <button className={btn2} onClick={() => startEdit(s)}>Edit</button>}
              <button className={btn2} onClick={() => setResults(s.id)}>Results</button>
              {["active", "finalizing"].includes(s.status) && <button className={btn2} onClick={() => finalize.mutate(s.id)}>Finalize</button>}
              {["scheduled", "active"].includes(s.status) && <button className={btn2} onClick={() => cancel.mutate(s.id)}>Cancel</button>}
            </div>
          ) },
        ]} />
      {results && (
        <div className={card}>
          <div className="flex justify-between mb-3"><p className="font-semibold">Results</p><button className={btn2} onClick={() => setResults(null)}>Close</button></div>
          <Table loading={res.isLoading} data={res.data ?? []} keyFn={(r: any) => r.uid} empty="Not finalized yet"
            columns={[
              { key: "rank", header: "#", render: (r: any) => <span>{r.rank}</span> },
              { key: "user", header: "User", render: (r: any) => <span>@{r.username ?? r.uid}</span> },
              { key: "xp", header: "Season XP", render: (r: any) => <span>{fmtNumber(r.xp)}</span> },
              { key: "state", header: "Rewards", render: (r: any) => <span className="text-xs">{r.reward_state}{r.grant_status ? ` · grant ${r.grant_status}` : ""}</span> },
            ]} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- users
function UserInspector() {
  const qc = useQueryClient();
  const [uidInput, setUidInput] = useState("");
  const [uid, setUid] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(false);
  const u = useQuery({ queryKey: ["gam", "user", uid], queryFn: () => api.gamification.user(uid!), enabled: !!uid });
  const ev = useQuery({ queryKey: ["gam", "userEvents", uid], queryFn: () => api.gamification.userEvents(uid!), enabled: !!uid });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["gam", "user", uid] }); qc.invalidateQueries({ queryKey: ["gam", "userEvents", uid] }); };
  const adjust = useMutation({
    mutationFn: () => api.gamification.adjustXp(uid!, { amount: Number(amount), reason, notify }),
    onSuccess: (r) => { toast.success(`Applied ${r.applied} XP (${r.before} → ${r.after})`); setAmount(""); setReason(""); refresh(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const reverse = useMutation({
    mutationFn: (id: string) => { const r = window.prompt("Reason for reversing this XP event?") || ""; return api.gamification.reverseEvent(id, r); },
    onSuccess: () => { toast.success("Reversed"); refresh(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const revoke = useMutation({
    mutationFn: (itemId: string) => { const r = window.prompt("Reason for revoking this item?") || ""; return api.gamification.revokeItem(uid!, itemId, r); },
    onSuccess: () => { toast.success("Revoked"); refresh(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const restore = useMutation({
    mutationFn: (itemId: string) => { const r = window.prompt("Reason for restoring this item?") || ""; return api.gamification.restoreItem(uid!, itemId, r); },
    onSuccess: () => { toast.success("Restored"); refresh(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const grantAch = useMutation({
    mutationFn: () => { const id = window.prompt("Achievement id to grant (e.g. community_contributor)") || ""; const r = window.prompt("Reason?") || ""; return api.gamification.grantAchievement(uid!, id, r); },
    onSuccess: (r) => { toast.success(r.granted ? "Granted" : "Already unlocked"); refresh(); },
    onError: (e) => toast.error(describeError(e)),
  });
  const d = u.data;
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input className={`${field} max-w-sm`} placeholder="User id (uid)" value={uidInput} onChange={(e) => setUidInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setUid(uidInput.trim())} />
        <button className={btn} onClick={() => setUid(uidInput.trim() || null)}>Inspect</button>
      </div>
      {u.isError && <p className="text-sm text-red-600">{describeError(u.error)}</p>}
      {d && (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <div className={card}>
              <p className="text-sm text-muted-foreground">@{d.username}</p>
              <p className="text-2xl font-bold">Lv {d.levelInfo.level} · {d.levelInfo.rank.name}</p>
              <p className="text-sm">{fmtNumber(d.levelInfo.xp)} XP · streak {d.streak ?? 0}</p>
              <p className={`text-xs mt-1 ${d.ledger.matchesBalance ? "text-green-600" : "text-red-600"}`}>
                Ledger {fmtNumber(d.ledger.sum)} over {fmtNumber(d.ledger.events)} events {d.ledger.matchesBalance ? "matches" : "DOES NOT match"} the balance
              </p>
            </div>
            <div className={`${card} md:col-span-2`}>
              <p className="font-semibold mb-2">Adjust XP</p>
              <div className="flex flex-wrap gap-2">
                <input type="number" className={`${field} w-32`} placeholder="+/- XP" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <input className={`${field} flex-1 min-w-[200px]`} placeholder="Reason (required, audit-logged)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify user</label>
                <button className={btn} onClick={() => adjust.mutate()} disabled={!amount || reason.trim().length < 3 || adjust.isPending}>Apply</button>
                <button className={btn2} onClick={() => grantAch.mutate()}>Grant achievement…</button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">A correction is a new ledger event; history is never edited. XP never goes below zero.</p>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className={card}>
              <p className="font-semibold mb-2">Achievements</p>
              <Table data={d.achievements} keyFn={(a: any) => `${a.achievement_id}:${a.tier}`} empty="None"
                columns={[
                  { key: "id", header: "Achievement", render: (a: any) => <span>{a.achievement_id}{a.tier > 1 ? ` ×${a.tier}` : ""}</span> },
                  { key: "src", header: "Source", render: (a: any) => <span className="text-xs">{a.source}</span> },
                  { key: "xp", header: "XP", render: (a: any) => <span>{a.xp_awarded}</span> },
                  { key: "at", header: "When", render: (a: any) => <span className="text-xs">{fmtDateTime(a.unlocked_at)}</span> },
                ]} />
            </div>
            <div className={card}>
              <p className="font-semibold mb-2">Inventory</p>
              <Table data={d.inventory} keyFn={(i: any) => i.itemId} empty="None"
                columns={[
                  { key: "id", header: "Item", render: (i: any) => <span>{i.itemId}</span> },
                  { key: "src", header: "Source", render: (i: any) => <span className="text-xs">{i.source}</span> },
                  { key: "state", header: "", render: (i: any) => i.revoked
                    ? <div className="flex gap-2 items-center"><Badge>revoked</Badge><button className={btn2} onClick={() => restore.mutate(i.itemId)} disabled={restore.isPending}>Restore</button></div>
                    : <button className={btn2} onClick={() => revoke.mutate(i.itemId)} disabled={revoke.isPending}>Revoke</button> },
                ]} />
            </div>
          </div>
          {Array.isArray(d.rewardGrants) && (
            <div className={card}>
              <p className="font-semibold mb-2">Diamond reward grants</p>
              <GrantsTable rows={d.rewardGrants} showUser={false} />
            </div>
          )}
          <div className={card}>
            <p className="font-semibold mb-2">XP events</p>
            <Table loading={ev.isLoading} data={ev.data?.events ?? []} keyFn={(e: any) => e.id} empty="No events"
              columns={[
                { key: "at", header: "When", render: (e: any) => <span className="text-xs">{fmtDateTime(e.created_at)}</span> },
                { key: "action", header: "Action", render: (e: any) => <span className="font-mono text-xs">{e.action}</span> },
                { key: "delta", header: "XP", render: (e: any) => <span className={e.delta < 0 ? "text-red-600" : ""}>{e.delta}{e.requested !== e.delta && e.action !== "opening_balance" ? ` (asked ${e.requested})` : ""}</span> },
                { key: "src", header: "Source", render: (e: any) => <span className="text-xs">{e.source_type ?? ""} {e.source_id ?? ""}</span> },
                { key: "why", header: "Reason", render: (e: any) => <span className="text-xs">{e.reason ?? ""}{e.actor ? ` · ${e.actor}` : ""}</span> },
                { key: "rev", header: "", render: (e: any) => e.reversed_by ? <Badge>reversed</Badge> : e.delta > 0 && e.action !== "reversal" ? <button className={btn2} onClick={() => reverse.mutate(e.id)}>Reverse</button> : null },
              ]} />
          </div>
          {d.flags.length > 0 && (
            <div className={card}>
              <p className="font-semibold mb-2">Review flags</p>
              {d.flags.map((f: any) => <p key={f.id} className="text-sm">{f.kind} · {f.status} · {fmtDateTime(f.created_at)}</p>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ grants
/** Diamond rewards from level milestones and seasons (worker lib/rewardGrants.ts). */
function GrantsTable({ rows, loading, showUser = true }: { rows: any[]; loading?: boolean; showUser?: boolean }) {
  return (
    <Table loading={loading} data={rows} keyFn={(g: any) => g.id} empty="No grants"
      columns={[
        { key: "at", header: "Created", render: (g: any) => <span className="text-xs">{fmtDateTime(g.created_at)}</span> },
        ...(showUser ? [{ key: "user", header: "User", render: (g: any) => <span>@{g.username ?? g.uid}</span> }] : []),
        { key: "src", header: "Source", render: (g: any) => <div><p className="text-sm">{g.source_type}</p><p className="text-xs text-muted-foreground font-mono">{g.source_id}</p></div> },
        { key: "coins", header: "Diamond", render: (g: any) => <span className="font-semibold">{fmtNumber(g.coins)}</span> },
        { key: "status", header: "Status", render: (g: any) => <Badge variant={g.status === "claimable" ? "primary" : undefined}>{g.status}</Badge> },
        { key: "claimed", header: "Claimed", render: (g: any) => <span className="text-xs">{g.claimed_at ? fmtDateTime(g.claimed_at) : "—"}</span> },
        { key: "note", header: "Note", render: (g: any) => <span className="text-xs">{g.note ?? ""}</span> },
      ]} />
  );
}

function Grants() {
  const { user } = useAuth();
  const full = !user?.role || isFullAdminRole(user.role);
  const [status, setStatus] = useState("claimable");
  const q = useQuery({ queryKey: ["gam", "grants", status], queryFn: () => api.gamification.grants(status), enabled: full });
  if (!full) return <p className="text-sm text-muted-foreground">Reward grants are available to full admins.</p>;
  const total = (q.data ?? []).reduce((a: number, g: any) => a + Number(g.coins || 0), 0);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Diamonds a user earned from a level milestone or a season result. A claimable grant is paid from the reward budget when the user taps Claim; nothing is paid before that.</p>
      <div className="flex gap-3 items-center">
        <select className={`${field} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["claimable", "claimed"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {q.data && <span className="text-sm text-muted-foreground">{fmtNumber(q.data.length)} grants · {fmtNumber(total)} Diamond{q.data.length === 200 ? " (latest 200)" : ""}</span>}
      </div>
      {q.isError && <p className="text-sm text-red-600">{describeError(q.error)}</p>}
      <GrantsTable rows={q.data ?? []} loading={q.isLoading} />
    </div>
  );
}

// ------------------------------------------------------------------- flags
function Flags() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const q = useQuery({ queryKey: ["gam", "flags", status], queryFn: () => api.gamification.flags(status) });
  const review = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => api.gamification.reviewFlag(id, s, window.prompt("Note (optional)") || undefined),
    onSuccess: () => { toast.success("Updated"); qc.invalidateQueries({ queryKey: ["gam", "flags"] }); },
    onError: (e) => toast.error(describeError(e)),
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Signals for a human to look at. Nothing here penalises anyone automatically — a shared family phone looks like two accounts on one device.</p>
      <select className={`${field} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
        {["open", "dismissed", "actioned"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <Table loading={q.isLoading} data={q.data ?? []} keyFn={(f: any) => f.id} empty="No flags"
        columns={[
          { key: "at", header: "When", render: (f: any) => <span className="text-xs">{fmtDateTime(f.created_at)}</span> },
          { key: "user", header: "User", render: (f: any) => <span>@{f.username ?? f.uid}</span> },
          { key: "kind", header: "Kind", render: (f: any) => <Badge>{f.kind}</Badge> },
          { key: "detail", header: "Detail", render: (f: any) => <span className="text-xs font-mono break-all">{typeof f.detail === "string" ? f.detail : JSON.stringify(f.detail)}</span> },
          { key: "act", header: "", render: (f: any) => f.status === "open" ? (
            <div className="flex gap-2">
              <button className={btn2} onClick={() => review.mutate({ id: f.id, s: "dismissed" })}>Dismiss</button>
              <button className={btn2} onClick={() => review.mutate({ id: f.id, s: "actioned" })}>Actioned</button>
            </div>
          ) : <span className="text-xs">{f.review_note ?? ""}</span> },
        ]} />
    </div>
  );
}
