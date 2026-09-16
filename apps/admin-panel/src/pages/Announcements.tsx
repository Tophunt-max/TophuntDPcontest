import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AdminAnnouncement, type AnnouncementWritePayload, type AnnouncementTargetType } from "@/lib/api";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Megaphone, Plus, Save, X, Trash2, Pencil, Users, Globe, Search } from "lucide-react";

type FormState = {
  title: string;
  body: string;
  link: string;
  image: string;
  isActive: boolean;
  targetType: AnnouncementTargetType;
  snoozeHours: string;
  priority: string;
  startAt: string; // datetime-local value
  endAt: string; // datetime-local value
};

const EMPTY_FORM: FormState = {
  title: "",
  body: "",
  link: "",
  image: "",
  isActive: true,
  targetType: "all",
  snoozeHours: "24",
  priority: "0",
  startAt: "",
  endAt: "",
};

/** epoch ms -> value a <input type="datetime-local"> accepts (local time). */
function toLocalInput(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local string -> epoch ms (or null when blank). */
function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export default function Announcements() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data: list = [], isLoading } = useQuery({ queryKey: ["announcements"], queryFn: api.announcements });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [userIds, setUserIds] = useState<string[]>([]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setUserIds([]);
  };

  const startEdit = async (a: AdminAnnouncement) => {
    setEditingId(a.id);
    setForm({
      title: a.title,
      body: a.body,
      link: a.link ?? "",
      image: a.image ?? "",
      isActive: a.isActive,
      targetType: a.targetType,
      snoozeHours: String(a.snoozeHours),
      priority: String(a.priority),
      startAt: toLocalInput(a.startAt),
      endAt: toLocalInput(a.endAt),
    });
    setUserIds([]);
    if (a.targetType === "users") {
      try {
        setUserIds(await api.announcementTargets(a.id));
      } catch {
        /* leave empty; admin can re-add */
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const buildPayload = (): AnnouncementWritePayload => ({
    title: form.title.trim(),
    body: form.body.trim(),
    link: form.link.trim() || null,
    image: form.image.trim() || null,
    isActive: form.isActive,
    targetType: form.targetType,
    snoozeHours: Number(form.snoozeHours) || 24,
    priority: Number(form.priority) || 0,
    startAt: fromLocalInput(form.startAt),
    endAt: fromLocalInput(form.endAt),
    ...(form.targetType === "users" ? { userIds } : {}),
  });

  const saveMut = useMutation({
    mutationFn: () => (editingId ? api.updateAnnouncement(editingId, buildPayload()) : api.createAnnouncement(buildPayload())),
    onSuccess: () => {
      toast.success(editingId ? "Announcement updated" : "Announcement created");
      qc.invalidateQueries({ queryKey: ["announcements"] });
      resetForm();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleMut = useMutation({
    mutationFn: (a: AdminAnnouncement) => api.updateAnnouncement(a.id, { isActive: !a.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements"] }),
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteAnnouncement(id),
    onSuccess: () => {
      toast.success("Announcement deleted");
      qc.invalidateQueries({ queryKey: ["announcements"] });
      if (editingId) resetForm();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const canSave = form.title.trim() && form.body.trim() && !(form.targetType === "users" && userIds.length === 0);

  return (
    <div>
      <PageHeader
        title="Announcements"
        subtitle="Popups shown in the user app — targeted, dismissible, re-shown after a snooze window"
        action={
          editingId ? (
            <button onClick={resetForm} className="flex items-center gap-2 border border-border text-sm font-semibold px-4 py-2 rounded-xl hover:bg-secondary">
              <Plus size={16} /> New announcement
            </button>
          ) : undefined
        }
      />

      {/* Editor */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
          <Megaphone size={16} className="text-violet-600" />
          {editingId ? "Edit announcement" : "Create announcement"}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className={field} placeholder="Title" value={form.title} onChange={(e) => set("title", e.target.value)} />
          <input className={field} placeholder="Link URL (optional, opened on tap)" value={form.link} onChange={(e) => set("link", e.target.value)} />
          <textarea className={`${field} md:col-span-2 min-h-[90px]`} placeholder="Message body" value={form.body} onChange={(e) => set("body", e.target.value)} />
          <input className={`${field} md:col-span-2`} placeholder="Image URL (optional, shown above the text)" value={form.image} onChange={(e) => set("image", e.target.value)} />

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Re-show after (hours)</label>
            <input type="number" min={1} className={field} value={form.snoozeHours} onChange={(e) => set("snoozeHours", e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Priority (higher shows first)</label>
            <input type="number" min={0} className={field} value={form.priority} onChange={(e) => set("priority", e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Start (optional)</label>
            <input type="datetime-local" className={field} value={form.startAt} onChange={(e) => set("startAt", e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">End (optional)</label>
            <input type="datetime-local" className={field} value={form.endAt} onChange={(e) => set("endAt", e.target.value)} />
          </div>
        </div>

        {/* Targeting */}
        <div className="mt-4">
          <label className="text-xs text-muted-foreground mb-2 block">Audience</label>
          <div className="flex gap-2 mb-3">
            <TargetTab active={form.targetType === "all"} onClick={() => set("targetType", "all")} icon={Globe} label="All users" />
            <TargetTab active={form.targetType === "users"} onClick={() => set("targetType", "users")} icon={Users} label="Specific users" />
          </div>
          {form.targetType === "users" && <UserPicker userIds={userIds} onChange={setUserIds} />}
        </div>

        <div className="flex items-center justify-between mt-5">
          <Toggle label="Active" checked={form.isActive} onChange={(v) => set("isActive", v)} />
          <div className="flex items-center gap-2">
            {editingId && (
              <button onClick={resetForm} className="text-sm font-medium px-4 py-2 rounded-xl border border-border hover:bg-secondary">
                Cancel
              </button>
            )}
            <button
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50"
            >
              <Save size={16} /> {saveMut.isPending ? "Saving…" : editingId ? "Save changes" : "Create"}
            </button>
          </div>
        </div>
        {form.targetType === "users" && userIds.length === 0 && (
          <p className="text-xs text-amber-600 mt-2">Add at least one user, or switch the audience to All users.</p>
        )}
      </div>

      {/* List */}
      <div className="bg-card border border-border rounded-2xl p-5">
        <h3 className="font-bold text-foreground mb-4">All announcements</h3>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No announcements yet</p>
        ) : (
          <div className="space-y-2">
            {list.map((a) => (
              <div key={a.id} className="flex items-start gap-3 p-3 rounded-xl border border-border">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground truncate">{a.title}</p>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${a.isActive ? "bg-green-100 text-green-700" : "bg-secondary text-muted-foreground"}`}>
                      {a.isActive ? "Active" : "Off"}
                    </span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 inline-flex items-center gap-1">
                      {a.targetType === "all" ? <><Globe size={11} /> All</> : <><Users size={11} /> {a.targetCount} user{a.targetCount === 1 ? "" : "s"}</>}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{a.body}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Re-show every {a.snoozeHours}h · priority {a.priority} · {fmtDateTime(a.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => toggleMut.mutate(a)} title={a.isActive ? "Turn off" : "Turn on"} className="p-1.5 rounded-lg hover:bg-secondary">
                    <Toggle mini label="" checked={a.isActive} onChange={() => toggleMut.mutate(a)} />
                  </button>
                  <button onClick={() => startEdit(a)} title="Edit" className="p-1.5 rounded-lg hover:bg-secondary text-violet-600">
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={async () => {
                      if (await confirm({ title: "Delete announcement?", description: "This removes it and its dismissal history. This cannot be undone." }))
                        deleteMut.mutate(a.id);
                    }}
                    title="Delete"
                    className="p-1.5 rounded-lg hover:bg-secondary text-red-600"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TargetTab({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium border transition-colors ${
        active ? "border-violet-500 bg-violet-50 text-violet-700" : "border-border text-muted-foreground hover:bg-secondary"
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

/** Search users and build a chip list of target uids. */
function UserPicker({ userIds, onChange }: { userIds: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["announcement-user-search", debounced],
    queryFn: () => api.users({ q: debounced, limit: 10 }),
    enabled: debounced.length >= 2,
  });

  const selected = useMemo(() => new Set(userIds), [userIds]);
  const add = (uid: string) => !selected.has(uid) && onChange([...userIds, uid]);
  const remove = (uid: string) => onChange(userIds.filter((u) => u !== uid));

  // Map uid -> label for the chips we've already picked (best-effort from results).
  const labelFor = (uid: string) => {
    const u = (results as any[]).find((r) => r.uid === uid || r.id === uid);
    return u?.username || u?.fullName || uid;
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="relative mb-3">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input className={`${field} pl-9`} placeholder="Search users by name, username or email…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {userIds.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {userIds.map((uid) => (
            <span key={uid} className="inline-flex items-center gap-1.5 bg-violet-100 text-violet-700 text-xs font-medium px-2 py-1 rounded-full">
              {labelFor(uid)}
              <button onClick={() => remove(uid)} className="hover:text-violet-900">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {debounced.length >= 2 && (
        <div className="max-h-52 overflow-auto space-y-1">
          {isFetching ? (
            <p className="text-xs text-muted-foreground py-2 text-center">Searching…</p>
          ) : (results as any[]).length === 0 ? (
            <p className="text-xs text-muted-foreground py-2 text-center">No users found</p>
          ) : (
            (results as any[]).map((u) => {
              const uid = u.uid || u.id;
              const picked = selected.has(uid);
              return (
                <button
                  key={uid}
                  onClick={() => (picked ? remove(uid) : add(uid))}
                  className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-lg border ${
                    picked ? "border-violet-300 bg-violet-50" : "border-border hover:bg-secondary"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-foreground block truncate">{u.username || u.fullName || uid}</span>
                    {u.email && <span className="text-[11px] text-muted-foreground truncate block">{u.email}</span>}
                  </span>
                  {picked ? <X size={14} className="text-violet-600" /> : <Plus size={14} className="text-muted-foreground" />}
                </button>
              );
            })
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground mt-2">{userIds.length} user{userIds.length === 1 ? "" : "s"} selected</p>
    </div>
  );
}

function Toggle({ label, checked, onChange, mini }: { label: string; checked: boolean; onChange: (v: boolean) => void; mini?: boolean }) {
  if (mini) {
    return (
      <span className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 inline-block ${checked ? "bg-violet-500" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    );
  }
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-3 py-1.5 text-left">
      <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-violet-500" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
      <span className="text-sm text-foreground">{label}</span>
    </button>
  );
}
