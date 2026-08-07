import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Send, CheckCheck, Bell } from "lucide-react";

export default function Notifications() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ["notifications"], queryFn: api.notifications });
  const [form, setForm] = useState({ userId: "", title: "", body: "", type: "system" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const readMut = useMutation({
    mutationFn: () => api.markNotificationsRead(),
    onSuccess: () => {
      toast.success("Marked all as read");
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const notifyMut = useMutation({
    mutationFn: () => api.notify(form),
    onSuccess: () => {
      toast.success("Push notification sent");
      setForm({ userId: "", title: "", body: "", type: "system" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Admin alerts and push messaging" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Send push */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
            <Send size={16} className="text-violet-600" /> Send Push Notification
          </h3>
          <div className="space-y-3">
            <input className={field} placeholder="Target user ID (uid)" value={form.userId} onChange={(e) => set("userId", e.target.value)} />
            <input className={field} placeholder="Title" value={form.title} onChange={(e) => set("title", e.target.value)} />
            <textarea className={`${field} min-h-[90px]`} placeholder="Message body" value={form.body} onChange={(e) => set("body", e.target.value)} />
            <select className={field} value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="system">System</option>
              <option value="contest">Contest</option>
              <option value="reward">Reward</option>
              <option value="social">Social</option>
            </select>
            <button
              onClick={() => notifyMut.mutate()}
              disabled={!form.userId || !form.title || notifyMut.isPending}
              className="w-full gradient-purple text-white text-sm font-semibold py-2.5 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Send size={15} /> Send
            </button>
          </div>
        </div>

        {/* Admin notifications */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground flex items-center gap-2">
              <Bell size={16} className="text-violet-600" /> Admin Alerts
            </h3>
            <button onClick={() => readMut.mutate()} className="text-xs text-violet-600 font-medium flex items-center gap-1 hover:underline">
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : data.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No admin notifications</p>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-auto">
              {data.map((n: any) => (
                <div key={n.id} className={`p-3 rounded-xl border ${n.isRead ? "border-border bg-background" : "border-violet-200 bg-violet-50/50"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{n.title}</p>
                    {!n.isRead && <Badge variant="primary">new</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{fmtDateTime(n.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
