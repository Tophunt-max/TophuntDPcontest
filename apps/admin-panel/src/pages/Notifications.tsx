import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Send, CheckCheck, Bell, Megaphone, Clock, X } from "lucide-react";

export default function Notifications() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ["notifications"], queryFn: api.notifications });
  const [form, setForm] = useState({ userId: "", title: "", body: "", type: "system" });
  const [bcast, setBcast] = useState({ title: "", body: "", image: "", platform: "", minLevel: "" });
  const [sched, setSched] = useState({ title: "", body: "", image: "", sendAt: "", platform: "", minLevel: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setB = (k: string, v: string) => setBcast((f) => ({ ...f, [k]: v }));
  const setS = (k: string, v: string) => setSched((f) => ({ ...f, [k]: v }));

  const buildSegment = (platform: string, minLevel: string) => {
    const seg: { platform?: string; minLevel?: number } = {};
    if (platform) seg.platform = platform;
    if (minLevel) seg.minLevel = Number(minLevel);
    return Object.keys(seg).length ? seg : undefined;
  };

  const broadcastMut = useMutation({
    mutationFn: () => api.broadcast({ title: bcast.title, body: bcast.body, image: bcast.image || undefined, segment: buildSegment(bcast.platform, bcast.minLevel) }),
    onSuccess: (d: any) => {
      toast.success(`Broadcast sent to ${d.recipients} users`);
      setBcast({ title: "", body: "", image: "", platform: "", minLevel: "" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const scheduled = useQuery({ queryKey: ["scheduled-notifications"], queryFn: api.scheduledNotifications });
  const scheduleMut = useMutation({
    mutationFn: () => api.createScheduledNotification({ title: sched.title, body: sched.body, image: sched.image || undefined, sendAt: sched.sendAt || undefined, segment: buildSegment(sched.platform, sched.minLevel) }),
    onSuccess: () => {
      toast.success("Notification scheduled");
      setSched({ title: "", body: "", image: "", sendAt: "", platform: "", minLevel: "" });
      qc.invalidateQueries({ queryKey: ["scheduled-notifications"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const cancelSchedMut = useMutation({
    mutationFn: (id: string) => api.cancelScheduledNotification(id),
    onSuccess: () => { toast.success("Cancelled"); qc.invalidateQueries({ queryKey: ["scheduled-notifications"] }); },
    onError: (e: any) => toast.error(e.message),
  });

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

      {/* Broadcast to all users */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-1 flex items-center gap-2">
          <Megaphone size={16} className="text-violet-600" /> Broadcast to All Users
        </h3>
        <p className="text-xs text-muted-foreground mb-4">Sends an in-app + push notification to every registered user.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input className={field} placeholder="Title" value={bcast.title} onChange={(e) => setB("title", e.target.value)} />
          <input className={`${field} md:col-span-2`} placeholder="Message body" value={bcast.body} onChange={(e) => setB("body", e.target.value)} />
          <input className={`${field} md:col-span-3`} placeholder="Image URL (optional)" value={bcast.image} onChange={(e) => setB("image", e.target.value)} />
          <select className={field} value={bcast.platform} onChange={(e) => setB("platform", e.target.value)}>
            <option value="">All platforms</option>
            <option value="android">Android</option>
            <option value="ios">iOS</option>
            <option value="web">Web</option>
          </select>
          <input type="number" className={field} placeholder="Min level (optional)" value={bcast.minLevel} onChange={(e) => setB("minLevel", e.target.value)} />
          <button
            onClick={async () => {
              const seg = bcast.platform || bcast.minLevel;
              if (await confirm({ title: "Send broadcast?", description: seg ? "This notification will be delivered to the matching user segment." : "This notification will be delivered to ALL users. This cannot be undone." }))
                broadcastMut.mutate();
            }}
            disabled={!bcast.title || !bcast.body || broadcastMut.isPending}
            className="gradient-purple text-white text-sm font-semibold py-2.5 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Megaphone size={15} /> {broadcastMut.isPending ? "Sending…" : "Broadcast"}
          </button>
        </div>
      </div>

      {/* Scheduled notifications */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-1 flex items-center gap-2">
          <Clock size={16} className="text-violet-600" /> Scheduled Notifications
        </h3>
        <p className="text-xs text-muted-foreground mb-4">Queued broadcasts sent automatically at the chosen time (checked every 10 min).</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <input className={field} placeholder="Title" value={sched.title} onChange={(e) => setS("title", e.target.value)} />
          <input className={`${field} md:col-span-2`} placeholder="Message body" value={sched.body} onChange={(e) => setS("body", e.target.value)} />
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Send at</label>
            <input type="datetime-local" className={field} value={sched.sendAt} onChange={(e) => setS("sendAt", e.target.value)} />
          </div>
          <select className={field} value={sched.platform} onChange={(e) => setS("platform", e.target.value)}>
            <option value="">All platforms</option>
            <option value="android">Android</option>
            <option value="ios">iOS</option>
            <option value="web">Web</option>
          </select>
          <input type="number" className={field} placeholder="Min level (optional)" value={sched.minLevel} onChange={(e) => setS("minLevel", e.target.value)} />
          <button onClick={() => scheduleMut.mutate()} disabled={!sched.title || !sched.body || !sched.sendAt || scheduleMut.isPending} className="md:col-span-3 gradient-purple text-white text-sm font-semibold py-2.5 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2">
            <Clock size={15} /> Schedule
          </button>
        </div>
        <div className="space-y-2 max-h-56 overflow-auto">
          {(scheduled.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No scheduled notifications</p>
          ) : (
            scheduled.data!.map((n: any) => (
              <div key={n.id} className="flex items-center gap-3 p-3 rounded-xl border border-border">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{n.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{n.body}</p>
                </div>
                <Badge variant={n.status === "sent" ? "success" : n.status === "cancelled" ? "default" : "pending"}>{n.status}</Badge>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(n.sendAt)}</span>
                {n.status === "pending" && (
                  <button onClick={() => cancelSchedMut.mutate(n.id)} title="Cancel" className="p-1.5 rounded-lg hover:bg-secondary text-red-600"><X size={14} /></button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Send push */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
            <Send size={16} className="text-violet-600" /> Send Push to One User
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
