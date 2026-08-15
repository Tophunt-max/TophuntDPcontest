import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDate, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Plus, Trash2, Pencil, Image as ImageIcon } from "lucide-react";

export default function Contests() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const { data = [], isLoading } = useQuery({ queryKey: ["contests"], queryFn: api.contests });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["contests"] });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteContest(id),
    onSuccess: () => {
      toast.success("Contest deleted");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.updateContest(id, { status }),
    onSuccess: () => {
      toast.success("Status updated");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Contests"
        subtitle={`${data.length} contests`}
        action={
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg hover:opacity-95"
          >
            <Plus size={16} /> New Contest
          </button>
        }
      />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(c: any) => c.id}
        empty="No contests yet"
        columns={[
          { key: "name", header: "Name", render: (c: any) => <span className="font-medium text-foreground">{c.name || "Untitled"}</span> },
          { key: "type", header: "Type", render: (c: any) => <Badge variant={c.type === "video" ? "video" : "audio"}>{c.type || "photo"}</Badge> },
          {
            key: "status",
            header: "Status",
            render: (c: any) => (
              <select
                value={c.status}
                onChange={(e) => statusMut.mutate({ id: c.id, status: e.target.value })}
                className="text-xs rounded-lg border border-border bg-card px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="live">live</option>
                <option value="upcoming">upcoming</option>
                <option value="paused">paused</option>
                <option value="ended">ended</option>
              </select>
            ),
          },
          { key: "entry", header: "Entry Fee", render: (c: any) => <span>{fmtNumber(c.entryFishCoins)}</span> },
          { key: "prize", header: "Prize Pool", render: (c: any) => <span>{fmtNumber(c.prizePool)}</span> },
          { key: "minVotes", header: "Min Votes", render: (c: any) => <span>{fmtNumber(c.minVotes)}</span> },
          { key: "created", header: "Created", render: (c: any) => <span className="text-muted-foreground">{fmtDate(c.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (c: any) => (
              <div className="flex items-center justify-end gap-1">
                <button
                  title="Edit"
                  onClick={() => setEditing(c)}
                  className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"
                >
                  <Pencil size={15} />
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    if (await confirm({ title: "Delete contest?", description: `Delete "${c.name}"? This cannot be undone.`, variant: "destructive" }))
                      delMut.mutate(c.id);
                  }}
                  className="p-2 rounded-lg hover:bg-secondary text-red-600"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ),
          },
        ]}
      />

      {creating && <ContestDialog onClose={() => setCreating(false)} onDone={invalidate} />}
      {editing && <ContestDialog contest={editing} onClose={() => setEditing(null)} onDone={invalidate} />}
    </div>
  );
}

function ContestDialog({ contest, onClose, onDone }: { contest?: any; onClose: () => void; onDone: () => void }) {
  const isEdit = !!contest;
  const [form, setForm] = useState({
    title: contest?.name || "",
    type: contest?.type || "photo",
    status: contest?.status || "live",
    bannerUrl: contest?.bannerUrl || "",
    totalEntryFee: String(contest?.entryFishCoins ?? 0),
    rewardCoins: String(contest?.prizePool ?? 0),
    voteDurationDays: String(contest?.voteDurationDays ?? 1),
    minVotes: String(contest?.minVotes ?? 0),
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const payload = () => ({
    title: form.title,
    type: form.type,
    status: form.status,
    bannerUrl: form.bannerUrl.trim(),
    totalEntryFee: Number(form.totalEntryFee),
    rewardCoins: Number(form.rewardCoins),
    voteDurationDays: Number(form.voteDurationDays),
    minVotes: Number(form.minVotes),
  });

  const mut = useMutation({
    mutationFn: () => (isEdit ? api.updateContest(contest.id, payload()) : api.createContest(payload())),
    onSuccess: () => {
      toast.success(isEdit ? "Contest updated" : "Contest created");
      onDone();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-4">{isEdit ? "Edit Contest" : "New Contest"}</h3>
        <div className="space-y-3">
          <input className={field} placeholder="Contest title" value={form.title} onChange={(e) => set("title", e.target.value)} />

          {/* Contest photo / banner */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Contest photo (banner image URL)</label>
            <div className="flex gap-3 items-start">
              <div className="w-24 h-16 rounded-xl overflow-hidden border border-border bg-secondary flex items-center justify-center flex-shrink-0">
                {form.bannerUrl.trim() ? (
                  <img
                    src={form.bannerUrl.trim()}
                    alt="preview"
                    className="w-full h-full object-cover"
                    onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.2")}
                    onLoad={(e) => ((e.target as HTMLImageElement).style.opacity = "1")}
                  />
                ) : (
                  <ImageIcon size={20} className="text-muted-foreground" />
                )}
              </div>
              <input
                className={`${field} flex-1`}
                placeholder="https://…/photo.jpg"
                value={form.bannerUrl}
                onChange={(e) => set("bannerUrl", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <select className={field} value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="photo">Photo</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
            </select>
            <select className={field} value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="live">Live</option>
              <option value="upcoming">Upcoming</option>
              <option value="ended">Ended</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LabeledNum label="Entry Fee" value={form.totalEntryFee} onChange={(v: string) => set("totalEntryFee", v)} cls={field} />
            <LabeledNum label="Reward Coins" value={form.rewardCoins} onChange={(v: string) => set("rewardCoins", v)} cls={field} />
            <LabeledNum label="Vote Duration (days)" value={form.voteDurationDays} onChange={(v: string) => set("voteDurationDays", v)} cls={field} />
            <LabeledNum label="Min Votes" value={form.minVotes} onChange={(v: string) => set("minVotes", v)} cls={field} />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-sm font-medium">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={!form.title || mut.isPending}
            className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
          >
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LabeledNum({ label, value, onChange, cls }: any) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <input type="number" className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
