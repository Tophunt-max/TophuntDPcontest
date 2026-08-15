import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDate, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { fmtDateTime, exportCsv } from "@/lib/format";
import { Search, Ban, CheckCircle2, Trash2, Wallet, ShieldCheck, Eye, BadgeCheck, Star, Download, ChevronLeft, ChevronRight } from "lucide-react";

export default function UsersPage() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [wallet, setWallet] = useState<{ id: string; name: string } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const LIMIT = 50;
  const { data = [], isLoading } = useQuery({
    queryKey: ["users", search, offset],
    queryFn: () => api.users({ q: search.length >= 2 ? search : undefined, offset, limit: LIMIT }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const blockMut = useMutation({
    mutationFn: ({ id, isBlocked }: { id: string; isBlocked: boolean }) =>
      api.setUserBlocked(id, isBlocked),
    onSuccess: (_d, v) => {
      toast.success(v.isBlocked ? "User blocked" : "User unblocked");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => {
      toast.success("User deleted");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const roleMut = useMutation({
    mutationFn: (userId: string) => api.setRole({ userId, makeAdmin: true }),
    onSuccess: () => {
      toast.success("User promoted to admin");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const filtered = data;

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={search.length >= 2 ? `Search results` : `Page ${offset / LIMIT + 1}`}
        action={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
                placeholder="Search users…"
                className="pl-9 pr-3 py-2 rounded-xl border border-border bg-card text-sm w-56 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => exportCsv(`users-${Date.now()}.csv`, data, ["id", "username", "fullName", "email", "Dpcoin", "level", "role", "isBlocked", "createdAt"])}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70"
            >
              <Download size={15} /> CSV
            </button>
          </div>
        }
      />

      <Table
        loading={isLoading}
        data={filtered}
        keyFn={(u: any) => u.id}
        empty="No users found"
        columns={[
          {
            key: "user",
            header: "User",
            render: (u: any) => (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0">
                  {u.profileImageUrl ? (
                    <img src={u.profileImageUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="font-semibold text-muted-foreground">
                      {(u.fullName || u.username || "?")[0]?.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate flex items-center gap-1">
                    {u.fullName || u.username || "Unnamed"}
                    {u.verified && <BadgeCheck size={13} className="text-blue-500 flex-shrink-0" />}
                    {u.featured && <Star size={12} className="text-amber-500 flex-shrink-0" />}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{u.email || u.phone || u.id}</p>
                </div>
              </div>
            ),
          },
          {
            key: "role",
            header: "Role",
            render: (u: any) => <Badge variant={u.role === "admin" ? "admin" : "user"}>{u.role || "user"}</Badge>,
          },
          {
            key: "coins",
            header: "DP Coins",
            render: (u: any) => <span className="font-medium">{fmtNumber(u.Dpcoin)}</span>,
          },
          { key: "level", header: "Level", render: (u: any) => <span>{u.level ?? 0}</span> },
          {
            key: "followers",
            header: "Followers",
            render: (u: any) => <span>{fmtNumber(u.stats?.followersCount)}</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (u: any) => (
              <Badge variant={u.isBlocked ? "danger" : "active"}>{u.isBlocked ? "blocked" : "active"}</Badge>
            ),
          },
          { key: "joined", header: "Joined", render: (u: any) => <span className="text-muted-foreground">{fmtDate(u.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (u: any) => (
              <div className="flex items-center justify-end gap-1">
                <IconBtn title="View / edit" onClick={() => setDetailId(u.id)}>
                  <Eye size={15} />
                </IconBtn>
                <IconBtn title="Adjust wallet" onClick={() => setWallet({ id: u.id, name: u.fullName || u.username })}>
                  <Wallet size={15} />
                </IconBtn>
                {u.role !== "admin" && (
                  <IconBtn
                    title="Make admin"
                    onClick={async () => {
                      if (await confirm({ title: "Promote to admin?", description: `Grant admin access to ${u.fullName || u.username}?` }))
                        roleMut.mutate(u.id);
                    }}
                  >
                    <ShieldCheck size={15} />
                  </IconBtn>
                )}
                <IconBtn
                  title={u.isBlocked ? "Unblock" : "Block"}
                  onClick={() => blockMut.mutate({ id: u.id, isBlocked: !u.isBlocked })}
                >
                  {u.isBlocked ? <CheckCircle2 size={15} className="text-green-600" /> : <Ban size={15} className="text-amber-600" />}
                </IconBtn>
                <IconBtn
                  title="Delete"
                  onClick={async () => {
                    if (await confirm({ title: "Delete user?", description: "This permanently removes the user and their auth account.", variant: "destructive" }))
                      delMut.mutate(u.id);
                  }}
                >
                  <Trash2 size={15} className="text-red-600" />
                </IconBtn>
              </div>
            ),
          },
        ]}
      />

      {search.length < 2 && (
        <div className="flex items-center justify-between mt-4">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-secondary text-sm font-medium disabled:opacity-40"
          >
            <ChevronLeft size={15} /> Prev
          </button>
          <span className="text-xs text-muted-foreground">Page {offset / LIMIT + 1}</span>
          <button
            disabled={data.length < LIMIT}
            onClick={() => setOffset(offset + LIMIT)}
            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-secondary text-sm font-medium disabled:opacity-40"
          >
            Next <ChevronRight size={15} />
          </button>
        </div>
      )}

      {wallet && <WalletDialog user={wallet} onClose={() => setWallet(null)} onDone={invalidate} />}
      {detailId && <UserDetail id={detailId} onClose={() => setDetailId(null)} onDone={invalidate} />}
    </div>
  );
}

function UserDetail({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const user = useQuery({ queryKey: ["user", id], queryFn: () => api.user(id) });
  const followers = useQuery({ queryKey: ["user-followers", id], queryFn: () => api.userFollowers(id) });
  const txns = useQuery({ queryKey: ["user-txns", id], queryFn: () => api.transactions({ uid: id, limit: 50 }) });
  const [tab, setTab] = useState<"profile" | "followers" | "transactions">("profile");
  const u = user.data;

  const [form, setForm] = useState({ fullName: "", username: "", bio: "" });
  const [xp, setXp] = useState("");
  const [badge, setBadge] = useState("");
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Prefill once loaded.
  if (u && form.fullName === "" && form.username === "" && form.bio === "" && (u.fullName || u.username || u.bio)) {
    setForm({ fullName: u.fullName || "", username: u.username || "", bio: u.bio || "" });
  }

  const saveMut = useMutation({
    mutationFn: () => api.updateUserProfile(id, form),
    onSuccess: () => { toast.success("Profile updated"); user.refetch(); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });
  const flagMut = useMutation({
    mutationFn: (patch: { verified?: boolean; featured?: boolean }) => api.updateUserProfile(id, patch),
    onSuccess: () => { toast.success("Updated"); user.refetch(); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });
  const grantMut = useMutation({
    mutationFn: () => api.grantUser(id, { xp: xp ? Number(xp) : undefined, badge: badge || undefined }),
    onSuccess: () => { toast.success("Granted"); setXp(""); setBadge(""); user.refetch(); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        {!u ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl overflow-hidden bg-secondary flex items-center justify-center">
                {u.profileImageUrl ? <img src={u.profileImageUrl} alt="" className="w-full h-full object-cover" /> : <span className="font-bold text-lg text-muted-foreground">{(u.fullName || u.username || "?")[0]?.toUpperCase()}</span>}
              </div>
              <div className="min-w-0">
                <p className="font-bold text-foreground truncate flex items-center gap-1">{u.fullName || u.username} {u.verified && <BadgeCheck size={15} className="text-blue-500" />}</p>
                <p className="text-xs text-muted-foreground truncate">Lv {u.level ?? 0} · {u.Dpcoin ?? 0} coins · {u.stats?.followersCount ?? 0} followers</p>
              </div>
              <div className="ml-auto flex gap-2">
                <button onClick={() => flagMut.mutate({ verified: !u.verified })} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${u.verified ? "bg-blue-100 text-blue-700" : "bg-secondary text-foreground"}`}>{u.verified ? "Verified ✓" : "Verify"}</button>
                <button onClick={() => flagMut.mutate({ featured: !u.featured })} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${u.featured ? "bg-amber-100 text-amber-700" : "bg-secondary text-foreground"}`}>{u.featured ? "Featured ★" : "Feature"}</button>
              </div>
            </div>

            <div className="flex gap-1 mb-4 bg-secondary/50 p-1 rounded-xl w-fit">
              {(["profile", "followers", "transactions"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize ${tab === t ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}>{t}</button>
              ))}
            </div>

            {tab === "profile" && (
              <div className="space-y-3">
                <input className={field} placeholder="Full name" value={form.fullName} onChange={(e) => set("fullName", e.target.value)} />
                <input className={field} placeholder="Username" value={form.username} onChange={(e) => set("username", e.target.value)} />
                <textarea className={field} placeholder="Bio" value={form.bio} onChange={(e) => set("bio", e.target.value)} />
                <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50">Save Profile</button>

                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-sm font-semibold mb-2">Grant XP / Badge</p>
                  <div className="flex flex-wrap gap-2">
                    <input type="number" className={`${field} w-32`} placeholder="XP" value={xp} onChange={(e) => setXp(e.target.value)} />
                    <input className={`${field} flex-1 min-w-[140px]`} placeholder="Badge name" value={badge} onChange={(e) => setBadge(e.target.value)} />
                    <button onClick={() => grantMut.mutate()} disabled={(!xp && !badge) || grantMut.isPending} className="bg-secondary text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-50">Grant</button>
                  </div>
                </div>
              </div>
            )}

            {tab === "followers" && (
              <div className="space-y-2 max-h-72 overflow-auto">
                {(followers.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground py-6 text-center">No followers</p> : followers.data!.map((f: any) => (
                  <div key={f.uid} className="flex items-center gap-2 p-2 rounded-lg hover:bg-secondary/40">
                    <span className="text-sm text-foreground">{f.fullName || f.username || f.uid}</span>
                  </div>
                ))}
              </div>
            )}

            {tab === "transactions" && (
              <div className="space-y-1 max-h-72 overflow-auto">
                {(txns.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground py-6 text-center">No transactions</p> : txns.data!.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-secondary/40 text-sm">
                    <span className="text-muted-foreground truncate">{t.type} · {fmtDateTime(t.createdAt)}</span>
                    <span className={`font-bold ${t.amount >= 0 ? "text-green-600" : "text-red-600"}`}>{t.amount >= 0 ? "+" : ""}{t.amount}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium">Close</button>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick }: any) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

function WalletDialog({
  user,
  onClose,
  onDone,
}: {
  user: { id: string; name: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"add" | "subtract">("add");
  const mut = useMutation({
    mutationFn: () => api.adjustWallet(user.id, Number(amount), type),
    onSuccess: (d: any) => {
      toast.success(`Wallet updated. New balance: ${d.newBalance}`);
      onDone();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-1">Adjust Wallet</h3>
        <p className="text-sm text-muted-foreground mb-4">{user.name}</p>
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setType("add")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium ${type === "add" ? "gradient-green text-white" : "bg-secondary text-foreground"}`}
          >
            Add
          </button>
          <button
            onClick={() => setType("subtract")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium ${type === "subtract" ? "gradient-red text-white" : "bg-secondary text-foreground"}`}
          >
            Subtract
          </button>
        </div>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount of DP Coins"
          className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-medium">
            Cancel
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!amount || mut.isPending}
            className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
