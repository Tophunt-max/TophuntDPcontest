import { useQuery } from "@tanstack/react-query";
import {
  Users as UsersIcon,
  Image,
  Flag,
  MessageSquare,
  Smartphone,
  Monitor,
  HelpCircle,
  IndianRupee,
  Swords,
  Trophy,
  Banknote,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";

export default function Dashboard() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const devices = useQuery({ queryKey: ["device-stats"], queryFn: api.deviceStats });
  const growth = useQuery({ queryKey: ["user-growth"], queryFn: api.userGrowth });
  const tickets = useQuery({ queryKey: ["recent-tickets"], queryFn: api.recentTickets });

  const chartData =
    growth.data?.categories.map((c, i) => ({ month: c, users: growth.data!.data[i] })) ??
    [];

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Overview of your TopHunt platform" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={UsersIcon}
          label="Total Users"
          value={overview.data?.users ?? "–"}
          gradient="gradient-purple"
        />
        <StatCard
          icon={Image}
          label="Total Posts"
          value={overview.data?.posts ?? "–"}
          gradient="gradient-blue"
        />
        <StatCard
          icon={Flag}
          label="Open Reports"
          value={overview.data?.reports ?? "–"}
          gradient="gradient-orange"
        />
        <StatCard
          icon={MessageSquare}
          label="Pending Tickets"
          value={overview.data?.support ?? "–"}
          gradient="gradient-green"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={IndianRupee}
          label="Total Revenue"
          value={overview.data?.revenue ?? "–"}
          gradient="gradient-green"
        />
        <StatCard
          icon={Swords}
          label="Active Battles"
          value={overview.data?.activeMatches ?? "–"}
          gradient="gradient-purple"
        />
        <StatCard
          icon={Trophy}
          label="Live Contests"
          value={overview.data?.liveContests ?? "–"}
          gradient="gradient-blue"
        />
        <StatCard
          icon={Banknote}
          label="Pending Payouts"
          value={overview.data?.pendingWithdrawals ?? "–"}
          gradient="gradient-orange"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Growth chart */}
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-5">
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

        {/* Device split */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-4">Platform Split</h3>
          <div className="space-y-4">
            <DeviceRow icon={Smartphone} label="Mobile" value={devices.data?.mobile ?? 0} color="gradient-purple" />
            <DeviceRow icon={Monitor} label="Web" value={devices.data?.web ?? 0} color="gradient-blue" />
            <DeviceRow icon={HelpCircle} label="Other" value={devices.data?.other ?? 0} color="gradient-orange" />
          </div>
        </div>
      </div>

      {/* Recent tickets */}
      <div className="bg-card border border-border rounded-2xl p-5 mt-6">
        <h3 className="font-bold text-foreground mb-4">Recent Support Tickets</h3>
        {tickets.data && tickets.data.length > 0 ? (
          <div className="space-y-2">
            {tickets.data.map((t: any) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 p-3 rounded-xl hover:bg-secondary/40 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{t.subject || "(no subject)"}</p>
                  <p className="text-xs text-muted-foreground truncate">{t.message}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
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
  );
}

function DeviceRow({ icon: Icon, label, value, color }: any) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg ${color} flex items-center justify-center`}>
        <Icon size={16} className="text-white" />
      </div>
      <span className="text-sm text-foreground flex-1">{label}</span>
      <span className="text-sm font-bold text-foreground">{value}</span>
    </div>
  );
}
