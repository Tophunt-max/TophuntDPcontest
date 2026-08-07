import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDate, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Search, Ban, CheckCircle2, Trash2, Wallet, ShieldCheck } from "lucide-react";

export default function UsersPage() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [wallet, setWallet] = useState<{ id: string; name: string } | null>(null);

  const { data = [], isLoading } = useQuery({ queryKey: ["users"], queryFn: api.users });

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

  const filtered = data.filter((u: any) => {
    const q = search.toLowerCase();
    return (
      !q ||
      (u.username || "").toLowerCase().includes(q) ||
      (u.fullName || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={`${data.length} registered users`}
        action={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users…"
              className="pl-9 pr-3 py-2 rounded-xl border border-border bg-card text-sm w-56 focus:outline-none focus:ring-2 focus:ring-ring"
            />
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
                  <p className="font-medium text-foreground truncate">{u.fullName || u.username || "Unnamed"}</p>
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

      {wallet && <WalletDialog user={wallet} onClose={() => setWallet(null)} onDone={invalidate} />}
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
