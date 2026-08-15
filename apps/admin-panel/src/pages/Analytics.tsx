import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Users, UserPlus, Activity, IndianRupee, Swords, Vote, Image, PlayCircle, Trophy } from "lucide-react";

export default function Analytics() {
  const { confirm } = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ["analytics"], queryFn: api.analytics });

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
            <StatCard icon={IndianRupee} label="Revenue (today)" value={fmtNumber(d?.revenueToday ?? 0)} gradient="gradient-green" />
            <StatCard icon={IndianRupee} label="Revenue (30d)" value={fmtNumber(d?.revenue30d ?? 0)} gradient="gradient-green" />
            <StatCard icon={Swords} label="Active Battles" value={fmtNumber(d?.activeMatches ?? 0)} gradient="gradient-purple" />
            <StatCard icon={Trophy} label="Completed Battles" value={fmtNumber(d?.completedMatches ?? 0)} gradient="gradient-blue" />
          </div>

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
                onClick={async () => { if (await confirm({ title: "Run Hall of Fame?", description: "Rewards top-3 by monthly wins and resets monthly counters.", variant: "destructive" })) hofMut.mutate(); }}
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
