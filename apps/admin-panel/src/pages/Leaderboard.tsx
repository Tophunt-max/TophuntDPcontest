import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtNumber } from "@/lib/format";
import { BadgeCheck } from "lucide-react";

const METRICS = [
  { key: "monthlyWins", label: "Monthly Wins" },
  { key: "wins", label: "Total Wins" },
  { key: "xp", label: "XP" },
  { key: "dpcoin", label: "Coins" },
  { key: "totalVotesReceived", label: "Votes Received" },
  { key: "followersCount", label: "Followers" },
];

export default function Leaderboard() {
  const [metric, setMetric] = useState("monthlyWins");
  const { data = [], isLoading } = useQuery({ queryKey: ["leaderboard", metric], queryFn: () => api.leaderboard(metric) });
  const field = "px-3 py-2 rounded-xl border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader
        title="Leaderboard"
        subtitle="Top users across the platform"
        action={
          <select className={field} value={metric} onChange={(e) => setMetric(e.target.value)}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        }
      />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(u: any) => u.uid}
        empty="No users"
        columns={[
          {
            key: "user",
            header: "User",
            render: (u: any) => (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0">
                  {u.profileImageUrl ? <img src={u.profileImageUrl} alt="" className="w-full h-full object-cover" /> : <span className="font-semibold text-muted-foreground">{(u.fullName || u.username || "?")[0]?.toUpperCase()}</span>}
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate flex items-center gap-1">{u.fullName || u.username || "Unnamed"} {u.verified && <BadgeCheck size={13} className="text-blue-500" />}</p>
                  <p className="text-xs text-muted-foreground truncate">@{u.username || u.uid}</p>
                </div>
              </div>
            ),
          },
          { key: "level", header: "Level", render: (u: any) => <Badge variant="primary">Lv {u.level ?? 0}</Badge> },
          { key: "monthlyWins", header: "Monthly Wins", render: (u: any) => <span>{fmtNumber(u.monthlyWins)}</span> },
          { key: "wins", header: "Wins", render: (u: any) => <span>{fmtNumber(u.wins)}</span> },
          { key: "xp", header: "XP", render: (u: any) => <span>{fmtNumber(u.xp)}</span> },
          { key: "coins", header: "Coins", render: (u: any) => <span>{fmtNumber(u.dpcoin)}</span> },
          { key: "votes", header: "Votes", render: (u: any) => <span>{fmtNumber(u.totalVotesReceived)}</span> },
          { key: "followers", header: "Followers", render: (u: any) => <span>{fmtNumber(u.followersCount)}</span> },
        ]}
      />
    </div>
  );
}
