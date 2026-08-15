import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trophy, XCircle, Eye, Swords } from "lucide-react";

const STATUS = ["", "active", "waiting_for_opponent", "completed", "cancelled"];

export default function Matches() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [status, setStatus] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["matches", status],
    queryFn: () => api.matches(status || undefined),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["matches"] });

  const winnerMut = useMutation({
    mutationFn: ({ id, winnerUid }: { id: string; winnerUid?: string }) => api.declareWinner(id, winnerUid),
    onSuccess: () => { toast.success("Winner declared & reward paid"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const cancelMut = useMutation({
    mutationFn: (id: string) => api.cancelMatch(id),
    onSuccess: () => { toast.success("Match cancelled & refunded"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "px-3 py-2 rounded-xl border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader
        title="Contest Matches"
        subtitle={`${data.length} battles`}
        action={
          <select className={field} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS.map((s) => (
              <option key={s} value={s}>{s === "" ? "All statuses" : s.replace(/_/g, " ")}</option>
            ))}
          </select>
        }
      />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(m: any) => m.id}
        empty="No matches found"
        columns={[
          {
            key: "battle",
            header: "Battle",
            render: (m: any) => (
              <div className="flex items-center gap-2 min-w-0">
                <Swords size={15} className="text-violet-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate">
                    {m.userA?.username || "?"} <span className="text-muted-foreground">vs</span> {m.userB?.username || "waiting"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{m.title || m.id}</p>
                </div>
              </div>
            ),
          },
          {
            key: "votes",
            header: "Votes (A / B)",
            render: (m: any) => (
              <span className="font-medium">{fmtNumber(m.userA?.votes)} / {fmtNumber(m.userB?.votes)}</span>
            ),
          },
          { key: "status", header: "Status", render: (m: any) => <Badge variant={m.status === "active" ? "active" : m.status === "completed" ? "ended" : m.status === "cancelled" ? "cancelled" : "pending"}>{m.status?.replace(/_/g, " ")}</Badge> },
          { key: "entry", header: "Entry", render: (m: any) => <span>{fmtNumber(m.entryFee)}</span> },
          { key: "reward", header: "Reward", render: (m: any) => <span>{fmtNumber(m.rewardAmount)}</span> },
          { key: "created", header: "Created", render: (m: any) => <span className="text-muted-foreground">{fmtDateTime(m.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (m: any) => (
              <div className="flex items-center justify-end gap-1">
                <IconBtn title="View votes" onClick={() => setDetailId(m.id)}><Eye size={15} /></IconBtn>
                {m.status !== "completed" && m.status !== "cancelled" && (
                  <>
                    <IconBtn
                      title="Declare winner (by votes)"
                      onClick={async () => {
                        if (await confirm({ title: "Declare winner?", description: "Resolve this battle by current votes and pay out the winner." }))
                          winnerMut.mutate({ id: m.id });
                      }}
                    >
                      <Trophy size={15} className="text-amber-500" />
                    </IconBtn>
                    <IconBtn
                      title="Cancel & refund"
                      onClick={async () => {
                        if (await confirm({ title: "Cancel match?", description: "Both entry fees will be refunded.", variant: "destructive" }))
                          cancelMut.mutate(m.id);
                      }}
                    >
                      <XCircle size={15} className="text-red-600" />
                    </IconBtn>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      {detailId && (
        <MatchDetail
          id={detailId}
          onClose={() => setDetailId(null)}
          onDeclare={(winnerUid) => { winnerMut.mutate({ id: detailId, winnerUid }); setDetailId(null); }}
        />
      )}
    </div>
  );
}

function IconBtn({ children, title, onClick }: any) {
  return (
    <button title={title} onClick={onClick} className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
      {children}
    </button>
  );
}

function MatchDetail({ id, onClose, onDeclare }: { id: string; onClose: () => void; onDeclare: (uid: string) => void }) {
  const match = useQuery({ queryKey: ["match", id], queryFn: () => api.match(id) });
  const votes = useQuery({ queryKey: ["match-votes", id], queryFn: () => api.matchVotes(id) });
  const m = match.data;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-4">Match Detail</h3>
        {!m ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 mb-5">
              {[m.userA, m.userB].map((u: any, idx: number) => (
                <div key={idx} className={`rounded-xl border p-4 ${m.winnerUid === u?.uid ? "border-amber-400 bg-amber-50/50" : "border-border"}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg overflow-hidden bg-secondary flex items-center justify-center">
                      {u?.profilePic ? <img src={u.profilePic} alt="" className="w-full h-full object-cover" /> : <span>{(u?.username || "?")[0]}</span>}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{u?.username || "waiting"}</p>
                      <p className="text-xs text-muted-foreground">{fmtNumber(u?.votes)} votes</p>
                    </div>
                    {m.winnerUid === u?.uid && <Trophy size={15} className="text-amber-500 ml-auto" />}
                  </div>
                  {u?.mediaUrl && <img src={u.mediaUrl} alt="" className="w-full h-32 object-cover rounded-lg" />}
                  {m.status !== "completed" && m.status !== "cancelled" && u?.uid && (
                    <button onClick={() => onDeclare(u.uid)} className="mt-3 w-full py-2 rounded-lg gradient-purple text-white text-xs font-semibold">
                      Declare as Winner
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 mb-3 text-sm">
              <Badge variant={m.status === "active" ? "active" : m.status === "completed" ? "ended" : "pending"}>{m.status?.replace(/_/g, " ")}</Badge>
              <span className="text-muted-foreground">Total votes: {fmtNumber(m.totalVotes)}</span>
            </div>

            <h4 className="font-semibold text-sm text-foreground mb-2">Votes ({votes.data?.length ?? 0})</h4>
            <div className="border border-border rounded-xl overflow-hidden max-h-52 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40">
                  <tr>
                    <th className="text-left px-3 py-2">Voter</th>
                    <th className="text-left px-3 py-2">Voted for</th>
                    <th className="text-left px-3 py-2">Device</th>
                    <th className="text-left px-3 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {(votes.data ?? []).map((v: any) => (
                    <tr key={v.id} className="border-t border-border">
                      <td className="px-3 py-2 truncate max-w-[120px]">{v.username || v.voterUid}</td>
                      <td className="px-3 py-2 truncate max-w-[100px]">{v.votedForUid}</td>
                      <td className="px-3 py-2 truncate max-w-[100px] text-muted-foreground">{v.deviceId || "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDateTime(v.createdAt)}</td>
                    </tr>
                  ))}
                  {(votes.data ?? []).length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No votes yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium">Close</button>
        </div>
      </div>
    </div>
  );
}
