import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtNumber } from "@/lib/format";
import { useAuth, isFullAdminRole } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Users, UserPlus, Activity, IndianRupee, Swords, Vote, Image, PlayCircle, Trophy } from "lucide-react";

export default function Analytics() {
  const { confirm } = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ["analytics"], queryFn: api.analytics });

  const trends = useQuery({ queryKey: ["finance-trends"], queryFn: api.financeTrends });
  const { user } = useAuth();
  const isFullAdmin = isFullAdminRole(user?.role);
  const [usageDays, setUsageDays] = useState(7);
  const usage = useQuery({ queryKey: ["usage-events", usageDays], queryFn: () => api.usageEvents(usageDays), enabled: isFullAdmin });

  const resolveMut = useMutation({ mutationFn: api.opsResolveContests, onSuccess: () => toast.success("Contest resolver ran"), onError: (e: any) => toast.error(e.message) });
  const hofMut = useMutation({ mutationFn: api.opsHallOfFame, onSuccess: () => toast.success("Hall of Fame ran"), onError: (e: any) => toast.error(e.message) });

  const d = data;
  return (
    <div>
      <PageHeader title="Analytics" subtitle="Growth, engagement and money at a glance" />

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>
      ) : (
        <>
          <h3 className="font-bold text-foreground mb-3">Users</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard icon={Users} label="Total Users" value={fmtNumber(d?.totalUsers ?? 0)} gradient="gradient-purple" />
            <StatCard icon={UserPlus} label="New (today)" value={fmtNumber(d?.newUsersToday ?? 0)} gradient="gradient-blue" />
            <StatCard icon={UserPlus} label="New (7d)" value={fmtNumber(d?.newUsers7d ?? 0)} gradient="gradient-blue" />
            <StatCard icon={UserPlus} label="New (30d)" value={fmtNumber(d?.newUsers30d ?? 0)} gradient="gradient-blue" />
          </div>

          <h3 className="font-bold text-foreground mb-3">Engagement (active voters)</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard icon={Activity} label="DAU (24h)" value={fmtNumber(d?.dau ?? 0)} gradient="gradient-green" />
            <StatCard icon={Activity} label="MAU (30d)" value={fmtNumber(d?.mau ?? 0)} gradient="gradient-green" />
            <StatCard icon={Vote} label="Votes (today)" value={fmtNumber(d?.votesToday ?? 0)} gradient="gradient-orange" />
            <StatCard icon={Image} label="Posts (today)" value={fmtNumber(d?.postsToday ?? 0)} gradient="gradient-orange" />
          </div>

          <h3 className="font-bold text-foreground mb-3">Money & Contests</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {/* These cards used to render a COIN count with a ₹ icon. */}
            <StatCard icon={IndianRupee} label="Revenue (today)" value={`₹${fmtNumber(d?.revenueTodayInr ?? 0)}`} gradient="gradient-green" />
            <StatCard icon={IndianRupee} label="Revenue (30d)" value={`₹${fmtNumber(d?.revenue30dInr ?? 0)}`} gradient="gradient-green" />
            <StatCard icon={Swords} label="Active Battles" value={fmtNumber(d?.activeMatches ?? 0)} gradient="gradient-purple" />
            <StatCard icon={Trophy} label="Completed Battles" value={fmtNumber(d?.completedMatches ?? 0)} gradient="gradient-blue" />
          </div>

          {/* Deposits vs withdrawals chart */}
          <div className="bg-card border border-border rounded-2xl p-5 mb-6">
            <h3 className="font-bold text-foreground mb-1">Deposits vs Withdrawals</h3>
            <p className="text-xs text-muted-foreground mb-4">Rupees in (approved deposits) vs out (paid withdrawals) — last 14 days</p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trends.data ?? []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 91%)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(220 9% 46%)" tickFormatter={(d) => String(d).slice(5)} />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(220 9% 46%)" allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="deposits" name="Deposits" fill="#22C55E" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="withdrawals" name="Withdrawals" fill="#FF4D67" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {isFullAdmin && <UsageCard days={usageDays} setDays={setUsageDays} q={usage} />}

          <div className="bg-card border border-border rounded-2xl p-5">
            <h3 className="font-bold text-foreground mb-1 flex items-center gap-2"><PlayCircle size={16} className="text-violet-600" /> Manual Operations</h3>
            <p className="text-xs text-muted-foreground mb-4">Trigger scheduled jobs on demand (normally run by cron).</p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={async () => { if (await confirm({ title: "Run contest resolver?", description: "Resolves expired matches, refunds unmatched, sends ending-soon alerts." })) resolveMut.mutate(); }}
                disabled={resolveMut.isPending}
                className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
              >
                Resolve Contests Now
              </button>
              <button
                onClick={async () => { if (await confirm({ title: "Run Hall of Fame?", description: "Top-3 (monthly wins) ko Hall of Fame Diamond deta hai aur monthly counters reset karta hai.", variant: "destructive" })) hofMut.mutate(); }}
                disabled={hofMut.isPending}
                className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
              >
                Run Monthly Hall of Fame
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const USAGE_LABEL: Record<string, string> = {
  "feed_impression/home": "Home feed battles seen",
  "story/complete": "Stories watched to the end",
  "story/skip": "Stories skipped",
  "story/close": "Story viewer closed early",
  "video/first_frame": "Story videos started",
  "video/stall": "Story video stalls",
  "video/error": "Story video errors",
  "search/results": "Searches with results",
  "search/empty": "Searches with no results",
  "sync/sent": "Offline actions sent",
  "sync/retry": "Offline actions retried",
  "sync/failed": "Offline actions dropped",
  "upload/ok": "Uploads finished",
  "upload/failed": "Uploads failed",
  "upload/cancelled": "Uploads cancelled",
};

/** Anonymous usage counters (no user identifiers), summed across platforms. */
function UsageCard({ days, setDays, q }: { days: number; setDays: (d: number) => void; q: any }) {
  const rows: { name: string; dim: string; platform: string; count: number; avgMs: number | null }[] = q.data?.rows ?? [];
  const byKey = new Map<string, { count: number; ms: number; platforms: Record<string, number> }>();
  for (const r of rows) {
    const k = `${r.name}/${r.dim}`;
    const cur = byKey.get(k) ?? { count: 0, ms: 0, platforms: {} };
    cur.count += r.count;
    cur.ms += (r.avgMs ?? 0) * r.count;
    cur.platforms[r.platform] = (cur.platforms[r.platform] ?? 0) + r.count;
    byKey.set(k, cur);
  }
  return (
    <div className="bg-card border border-border rounded-2xl p-5 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-bold text-foreground">App usage (anonymous)</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-sm border border-border rounded-lg px-2 py-1 bg-background">
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} {d === 1 ? "day" : "days"}</option>)}
        </select>
      </div>
      <p className="text-xs text-muted-foreground mb-4">Counts sent by the app without any account or device id. Users can turn this off in Settings › Privacy, so treat these as a sample.</p>
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : q.isError ? (
        <div className="text-sm text-red-600">Could not load usage counters.</div>
      ) : !q.data?.configured ? (
        <div className="text-sm text-muted-foreground">Not configured: set the CF_ANALYTICS_TOKEN secret on the Worker (Account Analytics: Read).</div>
      ) : byKey.size === 0 ? (
        <div className="text-sm text-muted-foreground">No data yet for this period.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-2 font-medium">Event</th>
              <th className="py-2 font-medium text-right">Count</th>
              <th className="py-2 font-medium text-right">Avg time</th>
              <th className="py-2 font-medium text-right">Android / iOS / Web</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(USAGE_LABEL).filter((k) => byKey.has(k)).map((k) => {
              const v = byKey.get(k)!;
              return (
                <tr key={k} className="border-b border-border/50">
                  <td className="py-2">{USAGE_LABEL[k]}</td>
                  <td className="py-2 text-right tabular-nums">{fmtNumber(v.count)}</td>
                  <td className="py-2 text-right tabular-nums">{v.ms > 0 ? `${(v.ms / v.count / 1000).toFixed(1)} s` : "—"}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {fmtNumber(v.platforms.android ?? 0)} / {fmtNumber(v.platforms.ios ?? 0)} / {fmtNumber(v.platforms.web ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
