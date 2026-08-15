import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Users as UsersIcon,
  Flag,
  MessageSquare,
  Smartphone,
  Monitor,
  HelpCircle,
  IndianRupee,
  Swords,
  Trophy,
  Banknote,
  UserPlus,
  Activity,
  Vote,
  Coins,
  ArrowRight,
  Wallet,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";

// Poll the light-weight summary endpoints so the dashboard stays near-live
// without a manual refresh. Heavier queries refresh a little less often.
const FAST = 30_000;
const SLOW = 60_000;

export default function Dashboard() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: FAST });
  const analytics = useQuery({ queryKey: ["analytics"], queryFn: api.analytics, refetchInterval: FAST });
  const devices = useQuery({ queryKey: ["device-stats"], queryFn: api.deviceStats, refetchInterval: SLOW });
  const growth = useQuery({ queryKey: ["user-growth"], queryFn: api.userGrowth, refetchInterval: SLOW });
  const finance = useQuery({ queryKey: ["finance-trends"], queryFn: api.financeTrends, refetchInterval: SLOW });
  const revenue = useQuery({ queryKey: ["revenue"], queryFn: api.revenue, refetchInterval: SLOW });
  const tickets = useQuery({ queryKey: ["recent-tickets"], queryFn: api.recentTickets, refetchInterval: SLOW });

  const chartData =
    growth.data?.categories.map((c, i) => ({ month: c, users: growth.data!.data[i] })) ?? [];

  const financeData =
    finance.data?.map((d) => ({ day: d.date.slice(5), deposits: d.deposits, withdrawals: d.withdrawals })) ?? [];

  // Actionable items that need an admin's attention right now.
  const o = overview.data;
  const alerts = [
    { n: o?.pendingWithdrawals ?? 0, label: "payout(s) awaiting action", href: "/withdrawals", icon: Banknote, tone: "amber" as const },
    { n: o?.pendingDeposits ?? 0, label: "deposit(s) to verify", href: "/deposits", icon: Wallet, tone: "blue" as const },
    { n: o?.reports ?? 0, label: "open report(s)", href: "/reports", icon: Flag, tone: "red" as const },
    { n: o?.support ?? 0, label: "pending ticket(s)", href: "/support", icon: MessageSquare, tone: "violet" as const },
  ].filter((a) => a.n > 0);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Live overview of your TopHunt platform" />

      {/* Action items band — only shows when something needs attention. */}
      {alerts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {alerts.map((a) => (
            <AlertChip key={a.href} {...a} />
          ))}
        </div>
      )}

      {/* Primary KPIs (clickable → drill into the relevant page). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <LinkCard href="/users">
          <StatCard icon={UsersIcon} label="Total Users" value={fmtNumber(o?.users)} gradient="gradient-purple" />
        </LinkCard>
        <LinkCard href="/transactions">
          <StatCard icon={IndianRupee} label="Coins Sold (all-time)" value={fmtNumber(o?.revenue)} gradient="gradient-green" />
        </LinkCard>
        <LinkCard href="/matches">
          <StatCard icon={Swords} label="Active Battles" value={fmtNumber(o?.activeMatches)} gradient="gradient-blue" />
        </LinkCard>
        <LinkCard href="/contests">
          <StatCard icon={Trophy} label="Live Contests" value={fmtNumber(o?.liveContests)} gradient="gradient-orange" />
        </LinkCard>
      </div>

      {/* Today's activity (from analytics). */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={UserPlus} label="New Users (today)" value={fmtNumber(analytics.data?.newUsersToday)} gradient="gradient-purple" />
        <StatCard icon={Activity} label="Active Users (24h)" value={fmtNumber(analytics.data?.dau)} gradient="gradient-blue" />
        <StatCard icon={Coins} label="Coins Sold (today)" value={fmtNumber(analytics.data?.revenueToday)} gradient="gradient-green" />
        <StatCard icon={Vote} label="Votes (today)" value={fmtNumber(analytics.data?.votesToday)} gradient="gradient-orange" />
      </div>

      {/* Charts row. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Growth chart */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-1">User Growth</h3>
          <p className="text-xs text-muted-foreground mb-4">New signups over the last 7 months</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="uv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7C3AED" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#7C3AED" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 91%)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="hsl(220 9% 46%)" />
                <YAxis tick={{ fontSize: 12 }} stroke="hsl(220 9% 46%)" allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="users" stroke="#7C3AED" strokeWidth={2} fill="url(#uv)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Finance trends: deposits vs withdrawals (14 days) */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-1">Deposits vs Withdrawals</h3>
          <p className="text-xs text-muted-foreground mb-4">Approved deposits &amp; processed payouts (coins, last 14 days)</p>
          <div className="h-64">
            {financeData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={financeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 91%)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(220 9% 46%)" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(220 9% 46%)" allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="deposits" name="Deposits" fill="#16A34A" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="withdrawals" name="Withdrawals" fill="#F97316" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                No deposit / withdrawal activity yet
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom row: platform split, top spenders, recent tickets. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Device split */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-4">Platform Split</h3>
          <div className="space-y-4">
            <DeviceRow icon={Smartphone} label="Mobile" value={devices.data?.mobile ?? 0} color="gradient-purple" />
            <DeviceRow icon={Monitor} label="Web" value={devices.data?.web ?? 0} color="gradient-blue" />
            <DeviceRow icon={HelpCircle} label="Other" value={devices.data?.other ?? 0} color="gradient-orange" />
          </div>
          <div className="mt-5 pt-4 border-t border-border">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Coins in circulation</span>
              <span className="font-bold text-foreground">{fmtNumber(revenue.data?.coinsInCirculation)}</span>
            </div>
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-muted-foreground">Successful payments</span>
              <span className="font-bold text-foreground">{fmtNumber(revenue.data?.paymentCount)}</span>
            </div>
          </div>
        </div>

        {/* Top spenders */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground">Top Spenders</h3>
            <Link href="/transactions" className="text-xs text-primary font-medium flex items-center gap-1 hover:underline">
              All <ArrowRight size={12} />
            </Link>
          </div>
          {revenue.data?.topSpenders && revenue.data.topSpenders.length > 0 ? (
            <div className="space-y-1">
              {revenue.data.topSpenders.slice(0, 6).map((s, i) => (
                <Link
                  key={s.userId}
                  href="/users"
                  className="flex items-center gap-3 p-2 rounded-xl hover:bg-secondary/40 transition-colors"
                >
                  <span className="w-6 h-6 rounded-lg bg-secondary text-xs font-bold flex items-center justify-center text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{s.fullName || s.username || "Unknown"}</p>
                    {s.username && <p className="text-xs text-muted-foreground truncate">@{s.username}</p>}
                  </div>
                  <span className="text-sm font-bold text-foreground flex-shrink-0">{fmtNumber(s.total)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">No purchases yet</p>
          )}
        </div>

        {/* Recent tickets */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground">Recent Support Tickets</h3>
            <Link href="/support" className="text-xs text-primary font-medium flex items-center gap-1 hover:underline">
              All <ArrowRight size={12} />
            </Link>
          </div>
          {tickets.data && tickets.data.length > 0 ? (
            <div className="space-y-2">
              {tickets.data.slice(0, 5).map((t: any) => (
                <div key={t.id} className="flex items-center justify-between gap-3 p-2.5 rounded-xl hover:bg-secondary/40 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.subject || "(no subject)"}</p>
                    <p className="text-xs text-muted-foreground truncate">{t.message}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Badge variant={t.status === "resolved" ? "success" : "pending"}>{t.status}</Badge>
                    <span className="text-xs text-muted-foreground">{fmtDateTime(t.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">No recent tickets</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Wraps a StatCard so the whole card navigates on click. */
function LinkCard({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block focus:outline-none focus:ring-2 focus:ring-ring rounded-2xl">
      {children}
    </Link>
  );
}

const TONES: Record<string, string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  red: "border-red-200 bg-red-50 text-red-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
};

function AlertChip({ n, label, href, icon: Icon, tone }: { n: number; label: string; href: string; icon: any; tone: string }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 p-3.5 rounded-2xl border transition-all hover:shadow-md ${TONES[tone]}`}
    >
      <div className="w-9 h-9 rounded-xl bg-white/70 flex items-center justify-center flex-shrink-0">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-bold leading-none">{n}</p>
        <p className="text-xs font-medium truncate mt-0.5">{label}</p>
      </div>
      <ArrowRight size={16} className="flex-shrink-0 opacity-60" />
    </Link>
  );
}

function DeviceRow({ icon: Icon, label, value, color }: any) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg ${color} flex items-center justify-center`}>
        <Icon size={16} className="text-white" />
      </div>
      <span className="text-sm text-foreground flex-1">{label}</span>
      <span className="text-sm font-bold text-foreground">{fmtNumber(value)}</span>
    </div>
  );
}
