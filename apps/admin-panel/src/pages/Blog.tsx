import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Plus, Pencil, Trash2, FileText, CheckCircle2, FilePlus, DownloadCloud, Archive, ChevronDown, ChevronUp, ExternalLink, Loader2, Play, RotateCcw, Square } from "lucide-react";

export default function Blog() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [editing, setEditing] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading } = useQuery({ queryKey: ["blog"], queryFn: () => api.blog() });
  const stats = useQuery({
    queryKey: ["blog-stats"],
    queryFn: api.blogStats,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["blog"] });
    qc.invalidateQueries({ queryKey: ["blog-stats"] });
  };

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteBlog(id),
    onSuccess: () => {
      toast.success("Post deleted");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Blog"
        subtitle="Manage blog posts and content"
        action={
          <button onClick={() => setCreating(true)} className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg">
            <Plus size={16} /> New Post
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={FileText} label="Total Posts" value={stats.data?.total ?? "–"} gradient="gradient-purple" />
        <StatCard icon={CheckCircle2} label="Published" value={stats.data?.published ?? "–"} gradient="gradient-green" />
        <StatCard icon={FilePlus} label="Drafts" value={stats.data?.drafts ?? "–"} gradient="gradient-orange" />
        <StatCard icon={DownloadCloud} label="Imported" value={stats.data?.imported ?? "–"} gradient="gradient-blue" />
      </div>

      <ImportStatus />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(p: any) => p.id}
        empty="No blog posts"
        columns={[
          {
            key: "post",
            header: "Post",
            render: (p: any) => (
              <div className="flex items-center gap-3">
                <div className="w-14 h-10 rounded-lg overflow-hidden bg-secondary flex-shrink-0">
                  {p.coverImageUrl && <img src={p.coverImageUrl} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate max-w-[280px]">{p.title}</p>
                  <p className="text-xs text-muted-foreground truncate max-w-[280px]">/{p.slug}</p>
                </div>
              </div>
            ),
          },
          { key: "category", header: "Category", render: (p: any) => <span className="text-sm">{p.category || "—"}</span> },
          { key: "status", header: "Status", render: (p: any) => <Badge variant={p.status === "published" ? "success" : "pending"}>{p.status}</Badge> },
          { key: "views", header: "Views", render: (p: any) => <span>{p.viewCount ?? 0}</span> },
          { key: "date", header: "Published", render: (p: any) => <span className="text-muted-foreground">{fmtDate(p.publishedAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (p: any) => (
              <div className="flex items-center justify-end gap-1">
                <button title="Edit" onClick={() => setEditing(p)} className="p-2 rounded-lg hover:bg-secondary text-violet-600">
                  <Pencil size={15} />
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    if (await confirm({ title: "Delete post?", description: `Delete "${p.title}"?`, variant: "destructive" })) delMut.mutate(p.id);
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

      {(creating || editing) && (
        <BlogDialog
          post={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={invalidate}
        />
      )}
    </div>
  );
}

const STATUS_META: Record<string, { label: string; cls: string; hoverCls?: string }> = {
  imported: { label: "Imported", cls: "bg-green-500/15 text-green-700 border-green-500/30" },
  updated: { label: "Updated", cls: "bg-blue-500/15 text-blue-700 border-blue-500/30", hoverCls: "hover:bg-blue-500/20" },
  duplicate: { label: "Duplicate", cls: "bg-slate-500/15 text-slate-600 border-slate-500/30", hoverCls: "hover:bg-slate-500/20" },
  skipped: { label: "Skipped", cls: "bg-amber-500/15 text-amber-700 border-amber-500/30", hoverCls: "hover:bg-amber-500/20" },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-700 border-red-500/30", hoverCls: "hover:bg-red-500/20" },
  pending: { label: "Pending", cls: "bg-violet-500/15 text-violet-700 border-violet-500/30" },
};

function ImportStatus() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("failed");

  const summary = useQuery({
    queryKey: ["blog-import-summary"],
    queryFn: api.blogImportSummary,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const progress = useQuery({
    queryKey: ["blog-import-progress"],
    queryFn: api.blogImportProgress,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const logQ = useQuery({
    queryKey: ["blog-import-log", filter],
    queryFn: () => api.blogImportLog(filter === "all" ? undefined : filter, 100),
    enabled: expanded,
  });

  const [importing, setImporting] = useState(false);
  const abortRef = useRef(false);

  const runImport = async (type: string) => {
    if (importing) return;
    setImporting(true);
    abortRef.current = false;
    try {
      const { urls } = await api.blogImportDiscover({ type });
      if (urls.length === 0) {
        toast.info("No URLs found to import");
        setImporting(false);
        return;
      }

      let state = {
        startedAt: Date.now(),
        total: urls.length,
        processed: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        duplicates: 0,
        failed: 0,
        missingImages: 0,
        currentUrl: "",
        speedPerMin: 0,
        done: false,
        created: 0,
      };

      toast.success(`Starting import of ${urls.length} posts...`);
      refresh();

      const BATCH_SIZE = 3;
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        if (abortRef.current) {
          toast.info("Import aborted by user");
          break;
        }
        const batch = urls.slice(i, i + BATCH_SIZE);
        try {
          const res = await api.blogImportProcessBatch({ urls: batch, state });
          state = res.state;
        } catch (batchError: any) {
          // If the batch fails (e.g., 500 error, network timeout), log failures for these URLs and advance state
          console.error("Batch failed:", batchError);
          for (const url of batch) {
            try {
              await api.blogImportFail({ url, error: batchError.message || "Batch failure" });
            } catch (e) {
              // Ignore failure to log failure
            }
          }
          state.processed += batch.length;
          state.failed += batch.length;
        }
        refresh();
      }

      if (!abortRef.current) {
        await api.blogImportFinish({ state });
        toast.success("Import complete!");
      }
    } catch (e: any) {
      toast.error(e.message || "Import failed");
    } finally {
      setImporting(false);
      refresh();
    }
  };

  const retryMut = useMutation({
    mutationFn: (status: string) => api.blogImportRetry({ status }),
    onSuccess: async (data: any, status) => {
      toast.success(`Marked ${data.requeued || 0} ${status} rows for retry`);
      await runImport(status);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const by = summary.data?.byStatus || {};
  const done = (by.imported || 0) + (by.updated || 0);
  const notDone = (by.failed || 0) + (by.skipped || 0);
  const p = progress.data;
  // A progress row older than a few minutes is stale — e.g. a job that was
  // killed (or hit the KV write limit) before it could report `done`. Don't
  // surface such a row as a live "Paused" job; it would otherwise show a
  // phantom progress bar forever until the next successful import.
  const PROGRESS_FRESH_MS = 5 * 60 * 1000;
  const progressFresh = !!p && typeof p.updatedAt === "number" && Date.now() - p.updatedAt < PROGRESS_FRESH_MS;
  const running = importing; // only consider running if actively importing in this session
  const paused = !importing && !!p && !p.done && p.total > 0 && progressFresh;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["blog-import-summary"] });
    qc.invalidateQueries({ queryKey: ["blog-import-progress"] });
    qc.invalidateQueries({ queryKey: ["blog-import-log"] });
  };

  return (
    <div className="bg-card border border-border rounded-2xl p-5 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-xl gradient-blue">
          <Archive size={16} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-foreground text-sm">Archive Import</p>
          <p className="text-xs text-muted-foreground">
            {done} imported · {notDone} not imported (failed/skipped)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
           <button disabled={running} onClick={async () => { if(window.confirm("Start a fresh import job from the archive?")) runImport("fresh") }} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-green-500/10 text-green-700 hover:bg-green-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50">
             {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start Import
           </button>
           <button disabled={running} onClick={async () => { if(window.confirm("Resume import job?")) runImport("resume") }} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50">
             <Play size={14} /> Resume Import
           </button>
           {running && (
            <button onClick={() => { abortRef.current = true; }} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-red-500/10 text-red-700 hover:bg-red-500/20 transition-colors flex items-center gap-1.5 shadow-sm border border-red-500/20">
              <Square size={14} /> Stop
            </button>
           )}
          <button onClick={refresh} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-secondary hover:bg-secondary/80 text-foreground transition-colors flex items-center gap-1.5">
            {summary.isFetching ? <Loader2 size={14} className="animate-spin" /> : null} Refresh
          </button>
        </div>
      </div>

      {(running || paused) && (
        <div className="mt-3 mb-2 px-1">
          <div className="flex justify-between items-end text-xs font-medium text-muted-foreground mb-2">
            <span>{paused ? "Paused" : "Importing"}… {p.processed} / {p.total} URLs</span>
            <span>{p.speedPerMin} / min</span>
          </div>
          <div className="h-2.5 rounded-full bg-secondary overflow-hidden border border-border/50">
            <div className={`h-full transition-all duration-500 ease-out ${paused ? "bg-muted-foreground/30" : "gradient-purple"}`} style={{ width: `${Math.min(100, Math.round((p.processed / p.total) * 100))}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2.5 mt-2">
        {["imported", "updated", "duplicate", "skipped", "failed"].map((s) => (
          <div key={s} className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border ${STATUS_META[s].cls}`}>
            <span>{STATUS_META[s].label}: {by[s] ?? 0}</span>
            {s !== "imported" && (
              <button
                disabled={running || retryMut.isPending || (by[s] ?? 0) === 0}
                onClick={() => {
                  if (window.confirm(`Do you want to re-import all ${by[s]} ${STATUS_META[s].label} posts?`)) {
                    retryMut.mutate(s);
                  }
                }}
                className={`ml-1 p-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${STATUS_META[s].hoverCls || "hover:bg-black/10"}`}
                title={`Retry ${STATUS_META[s].label}`}
              >
                {retryMut.isPending && retryMut.variables === s ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              </button>
            )}
          </div>
        ))}
        {typeof summary.data?.missingImages === "number" && (
          <div className="flex items-center text-xs font-semibold px-3 py-1.5 rounded-xl border bg-slate-500/10 text-slate-600 border-slate-500/20">
            Missing images: {summary.data.missingImages}
          </div>
        )}
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-4 text-xs font-medium text-violet-600 flex items-center gap-1"
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? "Hide" : "View"} import log (which URLs did / didn't import)
      </button>

      {expanded && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {["failed", "skipped", "imported", "updated", "duplicate", "all"].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`text-xs px-2.5 py-1 rounded-lg border ${filter === s ? "gradient-purple text-white border-transparent" : "bg-secondary text-muted-foreground border-border"}`}
              >
                {s === "all" ? "All" : STATUS_META[s].label}
              </button>
            ))}
          </div>
          {logQ.isLoading ? (
            <div className="py-8 flex justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
          ) : (logQ.data || []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No “{filter}” rows.</p>
          ) : (
            <div className="overflow-x-auto -mx-1 mt-2">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border/80 bg-secondary/30">
                    <th className="py-2.5 px-3 font-semibold rounded-tl-lg">URL</th>
                    <th className="py-2.5 px-3 font-semibold">Status</th>
                    <th className="py-2.5 px-3 font-semibold hidden sm:table-cell">Reason / error</th>
                    <th className="py-2.5 px-3 font-semibold rounded-tr-lg">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {(logQ.data || []).map((r: any) => (
                    <tr key={r.id} className="hover:bg-secondary/20 transition-colors">
                      <td className="py-2.5 px-3 max-w-[220px]">
                        <a href={r.url} target="_blank" rel="noreferrer" className="text-violet-600 hover:text-violet-500 hover:underline flex items-center gap-1.5 truncate">
                          <span className="truncate">{(r.url || "").replace(/^https?:\/\/(www\.)?tophunt\.in/, "")}</span>
                          <ExternalLink size={13} className="flex-shrink-0" />
                        </a>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${STATUS_META[r.status]?.cls || ""}`}>
                          {STATUS_META[r.status]?.label || r.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground hidden sm:table-cell max-w-[260px] truncate" title={r.error || ""}>{r.error || "—"}</td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 px-1 flex justify-between items-center text-xs text-muted-foreground">
                <p>Showing up to 100 latest “{filter}” rows.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BlogDialog({ post, onClose, onDone }: { post: any | null; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    title: post?.title || "",
    excerpt: post?.excerpt || "",
    coverImageUrl: post?.coverImageUrl || "",
    category: post?.category || "",
    author: post?.author || "TopHunt",
    status: post?.status || "published",
    content: post?.content || "",
    tags: (post?.tags || []).join(", "),
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        title: form.title,
        excerpt: form.excerpt,
        coverImageUrl: form.coverImageUrl,
        category: form.category,
        author: form.author,
        status: form.status,
        content: form.content,
        tags: form.tags.split(",").map((t: string) => t.trim()).filter(Boolean),
      };
      return post ? api.updateBlog(post.id, payload) : api.createBlog(payload);
    },
    onSuccess: () => {
      toast.success(post ? "Post updated" : "Post created");
      onDone();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-4">{post ? "Edit Post" : "New Post"}</h3>
        <div className="space-y-3">
          <input className={field} placeholder="Title" value={form.title} onChange={(e) => set("title", e.target.value)} />
          <input className={field} placeholder="Excerpt" value={form.excerpt} onChange={(e) => set("excerpt", e.target.value)} />
          <input className={field} placeholder="Cover image URL" value={form.coverImageUrl} onChange={(e) => set("coverImageUrl", e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Category" value={form.category} onChange={(e) => set("category", e.target.value)} />
            <input className={field} placeholder="Author" value={form.author} onChange={(e) => set("author", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Tags (comma separated)" value={form.tags} onChange={(e) => set("tags", e.target.value)} />
            <select className={field} value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
          </div>
          <textarea className={`${field} min-h-[220px] font-mono text-[13px]`} placeholder="Content (HTML / Markdown)" value={form.content} onChange={(e) => set("content", e.target.value)} />
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-sm font-medium">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={!form.title || mut.isPending} className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50">
            {post ? "Save Changes" : "Create Post"}
          </button>
        </div>
      </div>
    </div>
  );
}
