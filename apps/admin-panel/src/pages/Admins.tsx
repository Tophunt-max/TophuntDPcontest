import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { ShieldPlus, ShieldMinus, UserPlus } from "lucide-react";

export default function Admins() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("moderator");

  const { data = [], isLoading } = useQuery({ queryKey: ["admins"], queryFn: api.admins });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admins"] });

  const roleMut = useMutation({
    mutationFn: (p: { email?: string; userId?: string; role: string }) => api.setRole(p),
    onSuccess: () => { toast.success("Role updated"); setEmail(""); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader title="Admins & Roles" subtitle="Manage who can access the console" />

      {/* Add admin/moderator */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-4 flex items-center gap-2"><UserPlus size={16} className="text-violet-600" /> Grant Access</h3>
        <div className="flex flex-wrap gap-3">
          <input className={`${field} flex-1 min-w-[220px]`} placeholder="User email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className={field} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="moderator">Moderator (content only)</option>
            <option value="admin">Admin (full access)</option>
          </select>
          <button onClick={() => email && roleMut.mutate({ email, role })} disabled={!email || roleMut.isPending} className="gradient-purple text-white text-sm font-semibold px-5 py-2.5 rounded-xl disabled:opacity-50">Grant</button>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Moderators can moderate content (posts, comments, reports, messages) but cannot touch money, users, contests or settings.</p>
      </div>

      <Table
        loading={isLoading}
        data={data}
        keyFn={(u: any) => u.uid}
        empty="No admins yet"
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
                  <p className="font-medium text-foreground truncate">{u.fullName || u.username || "Unnamed"}</p>
                  <p className="text-xs text-muted-foreground truncate">{u.email || u.uid}</p>
                </div>
              </div>
            ),
          },
          { key: "role", header: "Role", render: (u: any) => <Badge variant={u.role === "moderator" ? "info" : "admin"}>{u.role}</Badge> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (u: any) => (
              <div className="flex items-center justify-end gap-1">
                {u.role === "moderator" ? (
                  <button title="Promote to admin" onClick={async () => { if (await confirm({ title: "Promote to admin?", description: `Give ${u.email || u.username} full access?` })) roleMut.mutate({ userId: u.uid, role: "admin" }); }} className="p-2 rounded-lg hover:bg-secondary text-green-600"><ShieldPlus size={15} /></button>
                ) : (
                  <button title="Demote to moderator" onClick={async () => { if (await confirm({ title: "Demote to moderator?", description: `Limit ${u.email || u.username} to content moderation?` })) roleMut.mutate({ userId: u.uid, role: "moderator" }); }} className="p-2 rounded-lg hover:bg-secondary text-amber-600"><ShieldMinus size={15} /></button>
                )}
                <button title="Revoke access" onClick={async () => { if (await confirm({ title: "Revoke admin access?", description: `Remove all console access for ${u.email || u.username}?`, variant: "destructive" })) roleMut.mutate({ userId: u.uid, role: "user" }); }} className="p-2 rounded-lg hover:bg-secondary text-red-600"><ShieldMinus size={15} /></button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
