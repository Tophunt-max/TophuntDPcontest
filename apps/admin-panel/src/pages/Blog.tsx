import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, describeError, type BlogListItem, type BlogPostDetail, type BlogStatus, type BlogWritePayload } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  Archive,
  Bold,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  DownloadCloud,
  ExternalLink,
  FilePlus,
  FileText,
  Heading2,
  Link as LinkIcon,
  List,
  Loader2,
  Pencil,
  Pilcrow,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";

export default function Blog() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const posts = useQuery({
    queryKey: ["blog", search],
    queryFn: () => api.blog(search || undefined),
  });
  const data = posts.data ?? [];
  const stats = useQuery({
    queryKey: ["blog-stats"],
    queryFn: api.blogStats,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const categories = useMemo(
    () => [...new Set(data.map((post) => post.category).filter((value): value is string => !!value))].sort(),
    [data],
  );
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
    onError: (error: Error) => toast.error(error.message),
  });

  const closeEditor = () => {
    setCreating(false);
    setEditingId(null);
  };

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

      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput.trim());
        }}
      >
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <Input
            aria-label="Search blog posts"
            className="h-10 rounded-xl pl-9 pr-9"
            placeholder="Search posts by title…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          {searchInput && (
            <button
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => {
                setSearchInput("");
                setSearch("");
              }}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <Button className="h-10 rounded-xl" type="submit" variant="secondary">Search</Button>
      </form>

      {posts.isError && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center">
          <AlertCircle className="text-destructive" size={18} />
          <p className="flex-1">Could not load blog posts: {describeError(posts.error)}</p>
          <Button size="sm" type="button" variant="outline" onClick={() => posts.refetch()}>Retry</Button>
        </div>
      )}

      <Table<BlogListItem>
        loading={posts.isLoading}
        data={data}
        keyFn={(post) => post.id}
        empty={search ? `No posts found for “${search}”` : "No blog posts"}
        columns={[
          {
            key: "post",
            header: "Post",
            render: (post) => (
              <div className="flex items-center gap-3">
                <div className="w-14 h-10 rounded-lg overflow-hidden bg-secondary flex-shrink-0">
                  {post.coverImageUrl && <img src={post.coverImageUrl} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate max-w-[280px]">{post.title}</p>
                  <p className="text-xs text-muted-foreground truncate max-w-[280px]">/{post.slug}</p>
                </div>
              </div>
            ),
          },
          { key: "category", header: "Category", render: (post) => <span className="text-sm">{post.category || "—"}</span> },
          { key: "status", header: "Status", render: (post) => <Badge variant={post.status === "published" ? "success" : "pending"}>{post.status}</Badge> },
          { key: "views", header: "Views", render: (post) => <span>{post.viewCount ?? 0}</span> },
          { key: "date", header: "Published", render: (post) => <span className="text-muted-foreground">{fmtDate(post.publishedAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (post) => (
              <div className="flex items-center justify-end gap-1">
                <button title="Edit" onClick={() => setEditingId(post.id)} className="p-2 rounded-lg hover:bg-secondary text-violet-600">
                  <Pencil size={15} />
                </button>
                <button
                  title="Delete"
                  disabled={delMut.isPending && delMut.variables === post.id}
                  onClick={async () => {
                    if (await confirm({ title: "Delete post?", description: `Delete “${post.title}”? This cannot be undone.`, variant: "destructive" })) {
                      delMut.mutate(post.id);
                    }
                  }}
                  className="p-2 rounded-lg hover:bg-secondary text-red-600 disabled:opacity-50"
                >
                  {delMut.isPending && delMut.variables === post.id ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
                </button>
              </div>
            ),
          },
        ]}
      />

      {(creating || editingId) && (
        <BlogDialog
          postId={editingId}
          categories={categories}
          onClose={closeEditor}
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
      toast.error(describeError(e));
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
    onError: (e: any) => toast.error(describeError(e)),
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

type BlogFormState = {
  title: string;
  slug: string;
  excerpt: string;
  coverImageUrl: string;
  category: string;
  author: string;
  tags: string;
  status: BlogStatus;
  publishedAt: string;
  content: string;
  metaTitle: string;
  metaDescription: string;
};

type BlogFormErrors = Partial<Record<keyof BlogFormState, string>>;

const BLOG_FORM_LIMITS = {
  title: 200,
  excerpt: 500,
  category: 100,
  author: 100,
  tag: 50,
  tags: 20,
  content: 1_000_000,
  metaTitle: 160,
  metaDescription: 300,
};

function toLocalDateTime(timestamp: number | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialBlogForm(post: BlogPostDetail | null): BlogFormState {
  return {
    title: post?.title || "",
    slug: post?.slug || "",
    excerpt: post?.excerpt || "",
    coverImageUrl: post?.coverImageUrl || "",
    category: post?.category || "",
    author: post?.author || "TopHunt",
    tags: (post?.tags || []).join("\n"),
    status: post?.status || "draft",
    publishedAt: toLocalDateTime(post?.publishedAt || null),
    content: post?.content || "",
    metaTitle: post?.metaTitle || "",
    metaDescription: post?.metaDescription || "",
  };
}

function parseTags(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const tag = raw.trim().replace(/\s+/g, " ");
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

function readableContent(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHttpUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateBlogForm(form: BlogFormState, initial: BlogFormState, isEditing: boolean): BlogFormErrors {
  const errors: BlogFormErrors = {};
  const tags = parseTags(form.tags);
  const changed = (key: keyof BlogFormState) => !isEditing || form[key] !== initial[key];

  if (!form.title.trim()) errors.title = "Title is required.";
  else if (changed("title") && form.title.trim().length > BLOG_FORM_LIMITS.title) errors.title = `Use ${BLOG_FORM_LIMITS.title} characters or fewer.`;
  if (isEditing && changed("slug") && !form.slug.trim()) errors.slug = "An existing post needs a permalink slug.";
  else if (changed("slug") && form.slug.trim().length > 120) errors.slug = "Use 120 characters or fewer.";
  if (changed("excerpt") && form.excerpt.trim().length > BLOG_FORM_LIMITS.excerpt) errors.excerpt = `Use ${BLOG_FORM_LIMITS.excerpt} characters or fewer.`;
  if (changed("coverImageUrl") && !isHttpUrl(form.coverImageUrl)) errors.coverImageUrl = "Enter a valid http:// or https:// URL.";
  if (changed("category") && form.category.trim().length > BLOG_FORM_LIMITS.category) errors.category = `Use ${BLOG_FORM_LIMITS.category} characters or fewer.`;
  if (!form.author.trim()) errors.author = "Author is required.";
  else if (changed("author") && form.author.trim().length > BLOG_FORM_LIMITS.author) errors.author = `Use ${BLOG_FORM_LIMITS.author} characters or fewer.`;
  if (changed("tags") && tags.length > BLOG_FORM_LIMITS.tags) errors.tags = `Add no more than ${BLOG_FORM_LIMITS.tags} tags.`;
  else if (changed("tags") && tags.some((tag) => tag.length > BLOG_FORM_LIMITS.tag)) errors.tags = `Each tag must be ${BLOG_FORM_LIMITS.tag} characters or fewer.`;
  if (changed("content") && form.content.length > BLOG_FORM_LIMITS.content) errors.content = "Content is too large.";
  else if (
    (changed("content") || changed("status")) &&
    form.status === "published" &&
    readableContent(form.content).length < 20
  ) {
    errors.content = "Published posts need at least 20 characters of readable content.";
  }
  if (changed("metaTitle") && form.metaTitle.trim().length > BLOG_FORM_LIMITS.metaTitle) errors.metaTitle = `Use ${BLOG_FORM_LIMITS.metaTitle} characters or fewer.`;
  if (changed("metaDescription") && form.metaDescription.trim().length > BLOG_FORM_LIMITS.metaDescription) errors.metaDescription = `Use ${BLOG_FORM_LIMITS.metaDescription} characters or fewer.`;
  if (changed("publishedAt") && form.publishedAt && Number.isNaN(new Date(form.publishedAt).getTime())) errors.publishedAt = "Enter a valid publish date.";
  return errors;
}

function BlogDialog({
  postId,
  categories,
  onClose,
  onDone,
}: {
  postId: string | null;
  categories: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { confirm } = useConfirm();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const detail = useQuery({
    queryKey: ["blog-post", postId],
    queryFn: () => api.blogPost(postId!),
    enabled: !!postId,
    retry: 1,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!dirty || saving) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, saving]);

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const discard = await confirm({
        title: "Discard unsaved changes?",
        description: "Your edits have not been saved.",
        confirmLabel: "Discard changes",
        variant: "destructive",
      });
      if (!discard) return;
    }
    onClose();
  };

  const post = postId ? detail.data ?? null : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DialogContent className="h-[100dvh] max-h-[100dvh] w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[92vh] sm:max-h-[920px] sm:w-[calc(100vw-2rem)] sm:max-w-4xl sm:rounded-2xl sm:border">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{postId ? "Edit Post" : "New Post"}</DialogTitle>
            {post && <Badge variant={post.source === "archive" ? "info" : "primary"}>{post.source === "archive" ? "Archive import" : "Admin post"}</Badge>}
          </div>
          <DialogDescription>
            {postId ? "Loading the complete saved post before editing, so hidden fields are never overwritten." : "Create a draft, review the content, then publish when it is ready."}
          </DialogDescription>
        </DialogHeader>

        {postId && detail.isLoading ? (
          <div className="flex min-h-0 items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
            <Loader2 className="animate-spin text-violet-600" size={20} /> Loading complete post…
          </div>
        ) : postId && detail.isError ? (
          <div className="flex min-h-0 flex-col items-center justify-center gap-4 p-8 text-center">
            <AlertCircle className="text-destructive" size={28} />
            <div>
              <p className="font-semibold">Could not load this post</p>
              <p className="mt-1 text-sm text-muted-foreground">{(detail.error as Error).message}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void requestClose()}>Cancel</Button>
              <Button type="button" onClick={() => detail.refetch()}>Retry</Button>
            </div>
          </div>
        ) : (
          <BlogForm
            key={post?.id || "new"}
            post={post}
            categories={categories}
            onCancel={requestClose}
            onDirtyChange={setDirty}
            onSavingChange={setSaving}
            onSaved={() => {
              setDirty(false);
              onDone();
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BlogForm({
  post,
  categories,
  onCancel,
  onDirtyChange,
  onSavingChange,
  onSaved,
}: {
  post: BlogPostDetail | null;
  categories: string[];
  onCancel: () => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const initial = useMemo(() => initialBlogForm(post), [post]);
  const [form, setForm] = useState<BlogFormState>(initial);
  const [errors, setErrors] = useState<BlogFormErrors>({});
  const [serverError, setServerError] = useState("");
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const tags = useMemo(() => parseTags(form.tags), [form.tags]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = <K extends keyof BlogFormState>(key: K, value: BlogFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setServerError("");
  };

  const mutation = useMutation<unknown, Error, BlogWritePayload>({
    mutationFn: (payload) => {
      if (!post) return api.createBlog(payload);
      const patch: Partial<BlogWritePayload> = { expectedUpdatedAt: post.updatedAt };
      if (form.title !== initial.title) patch.title = payload.title;
      if (form.slug !== initial.slug) patch.slug = payload.slug;
      if (form.excerpt !== initial.excerpt) patch.excerpt = payload.excerpt;
      if (form.coverImageUrl !== initial.coverImageUrl) patch.coverImageUrl = payload.coverImageUrl;
      if (form.category !== initial.category) patch.category = payload.category;
      if (form.author !== initial.author) patch.author = payload.author;
      if (form.tags !== initial.tags) patch.tags = payload.tags;
      if (form.status !== initial.status) patch.status = payload.status;
      if (form.content !== initial.content) patch.content = payload.content;
      if (form.metaTitle !== initial.metaTitle) patch.metaTitle = payload.metaTitle;
      if (form.metaDescription !== initial.metaDescription) patch.metaDescription = payload.metaDescription;
      if (form.publishedAt !== initial.publishedAt) patch.publishedAt = payload.publishedAt;
      return api.updateBlog(post.id, patch);
    },
    onMutate: () => {
      setServerError("");
      onSavingChange(true);
    },
    onSuccess: () => {
      if (post) qc.removeQueries({ queryKey: ["blog-post", post.id] });
      toast.success(post ? "Post updated" : "Post created");
      onSaved();
    },
    onError: (error: Error) => {
      setServerError(error.message || "Could not save the post.");
      toast.error(error.message || "Could not save the post");
    },
    onSettled: () => onSavingChange(false),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateBlogForm(form, initial, !!post);
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0] as keyof BlogFormState | undefined;
    if (firstError) {
      document.getElementById(`blog-${firstError}`)?.focus();
      return;
    }
    const payload: BlogWritePayload = {
      title: form.title.trim(),
      slug: form.slug.trim() || undefined,
      excerpt: form.excerpt.trim() || null,
      coverImageUrl: form.coverImageUrl.trim() || null,
      category: form.category.trim() || null,
      author: form.author.trim(),
      tags,
      status: form.status,
      content: form.content.trim() || null,
      metaTitle: form.metaTitle.trim() || null,
      metaDescription: form.metaDescription.trim() || null,
    };
    if (!post || form.publishedAt !== initial.publishedAt) {
      payload.publishedAt = form.publishedAt ? new Date(form.publishedAt).getTime() : null;
    }
    mutation.mutate(payload);
  };

  const insertMarkup = (before: string, after: string, placeholder: string) => {
    const textarea = contentRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selection = form.content.slice(start, end) || placeholder;
    const next = `${form.content.slice(0, start)}${before}${selection}${after}${form.content.slice(end)}`;
    set("content", next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selection.length);
    });
  };

  const inputClass = (key: keyof BlogFormState) => `h-10 rounded-xl ${errors[key] ? "border-destructive focus-visible:ring-destructive" : ""}`;
  const textAreaClass = (key: keyof BlogFormState) => `rounded-xl ${errors[key] ? "border-destructive focus-visible:ring-destructive" : ""}`;
  const errorText = (key: keyof BlogFormState) => errors[key] ? <p className="text-xs text-destructive">{errors[key]}</p> : null;

  return (
    <form className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]" onSubmit={submit} noValidate>
      <div className="min-h-0 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
        {post?.source === "archive" && (
          <div className="flex flex-col gap-2 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-muted-foreground sm:flex-row sm:items-center">
            <Archive className="shrink-0 text-blue-600" size={16} />
            <span className="flex-1">Imported post. Missing category means none could be recovered from the archive; you can add one below.</span>
            {post.originalUrl && (
              <a className="inline-flex items-center gap-1 font-medium text-violet-600 hover:underline" href={post.originalUrl} target="_blank" rel="noreferrer">
                Original <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}

        <section className="space-y-4" aria-labelledby="blog-basics-heading">
          <div>
            <h4 id="blog-basics-heading" className="text-sm font-semibold">Post details</h4>
            <p className="text-xs text-muted-foreground">Title, summary, permalink and ownership.</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="blog-title">Title <span className="text-destructive">*</span></Label>
              <span className="text-xs text-muted-foreground">{form.title.length}/{BLOG_FORM_LIMITS.title}</span>
            </div>
            <Input id="blog-title" className={inputClass("title")} maxLength={BLOG_FORM_LIMITS.title} value={form.title} onChange={(event) => set("title", event.target.value)} aria-invalid={!!errors.title} />
            {errorText("title")}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="blog-excerpt">Excerpt</Label>
              <span className="text-xs text-muted-foreground">{form.excerpt.length}/{BLOG_FORM_LIMITS.excerpt}</span>
            </div>
            <Textarea id="blog-excerpt" className={textAreaClass("excerpt")} rows={3} maxLength={BLOG_FORM_LIMITS.excerpt} placeholder="Short summary shown on blog cards" value={form.excerpt} onChange={(event) => set("excerpt", event.target.value)} aria-invalid={!!errors.excerpt} />
            {errorText("excerpt")}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="blog-slug">Permalink slug</Label>
              <Input id="blog-slug" className={inputClass("slug")} maxLength={120} placeholder="Generated from title when blank" value={form.slug} onChange={(event) => set("slug", event.target.value)} aria-invalid={!!errors.slug} />
              <p className="truncate text-xs text-muted-foreground">/blog/{form.slug.trim() || "generated-from-title"}</p>
              {errorText("slug")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="blog-author">Author <span className="text-destructive">*</span></Label>
              <Input id="blog-author" className={inputClass("author")} maxLength={BLOG_FORM_LIMITS.author} value={form.author} onChange={(event) => set("author", event.target.value)} aria-invalid={!!errors.author} />
              {errorText("author")}
            </div>
          </div>
        </section>

        <section className="space-y-4 border-t border-border pt-5" aria-labelledby="blog-media-heading">
          <div>
            <h4 id="blog-media-heading" className="text-sm font-semibold">Media & organization</h4>
            <p className="text-xs text-muted-foreground">Featured image, category and searchable tags.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <div className="space-y-2">
              <Label htmlFor="blog-coverImageUrl">Cover image URL</Label>
              <Input id="blog-coverImageUrl" className={inputClass("coverImageUrl")} inputMode="url" placeholder="https://…" value={form.coverImageUrl} onChange={(event) => set("coverImageUrl", event.target.value)} aria-invalid={!!errors.coverImageUrl} />
              {errorText("coverImageUrl")}
            </div>
            <div className="flex h-24 items-center justify-center overflow-hidden rounded-xl border border-border bg-secondary/40">
              {form.coverImageUrl && isHttpUrl(form.coverImageUrl) ? (
                <img key={form.coverImageUrl} src={form.coverImageUrl} alt="Cover preview" className="h-full w-full object-cover" />
              ) : (
                <span className="px-3 text-center text-xs text-muted-foreground">Cover preview</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="blog-category">Category</Label>
              <Input id="blog-category" className={inputClass("category")} list="blog-category-options" maxLength={BLOG_FORM_LIMITS.category} placeholder="e.g. Amazon Quiz" value={form.category} onChange={(event) => set("category", event.target.value)} aria-invalid={!!errors.category} />
              <datalist id="blog-category-options">{categories.map((category) => <option key={category} value={category} />)}</datalist>
              {errorText("category")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="blog-tags">Tags</Label>
              <Textarea id="blog-tags" className={textAreaClass("tags")} rows={3} placeholder={"Amazon\nQuiz\nRewards"} value={form.tags} onChange={(event) => set("tags", event.target.value)} aria-invalid={!!errors.tags} />
              <p className="text-xs text-muted-foreground">One tag per line; commas inside a tag are preserved ({tags.length}/{BLOG_FORM_LIMITS.tags}).</p>
              {tags.length > 0 && <div className="flex flex-wrap gap-1.5">{tags.slice(0, BLOG_FORM_LIMITS.tags).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}
              {errorText("tags")}
            </div>
          </div>
        </section>

        <section className="space-y-4 border-t border-border pt-5" aria-labelledby="blog-publishing-heading">
          <div>
            <h4 id="blog-publishing-heading" className="text-sm font-semibold">Publishing</h4>
            <p className="text-xs text-muted-foreground">Drafts stay hidden from readers until published.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="blog-status">Status</Label>
              <select id="blog-status" className={`${inputClass("status")} w-full border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring`} value={form.status} onChange={(event) => set("status", event.target.value as BlogStatus)}>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="blog-publishedAt">Publish date (optional)</Label>
              <Input id="blog-publishedAt" className={inputClass("publishedAt")} type="datetime-local" value={form.publishedAt} onChange={(event) => set("publishedAt", event.target.value)} aria-invalid={!!errors.publishedAt} />
              {errorText("publishedAt")}
            </div>
          </div>
        </section>

        <section className="space-y-3 border-t border-border pt-5" aria-labelledby="blog-content-heading">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
            <div>
              <h4 id="blog-content-heading" className="text-sm font-semibold">Content (HTML source)</h4>
              <p className="text-xs text-muted-foreground">HTML is stored and rendered as-is. Markdown is not supported.</p>
            </div>
            <span className="text-xs text-muted-foreground">{form.content.length.toLocaleString()} characters</span>
          </div>
          <div className="flex flex-wrap gap-1 rounded-t-xl border border-b-0 border-input bg-secondary/40 p-2" aria-label="HTML formatting tools">
            <Button type="button" size="sm" variant="ghost" title="Paragraph" onClick={() => insertMarkup("<p>", "</p>", "Paragraph text")}><Pilcrow /> Paragraph</Button>
            <Button type="button" size="sm" variant="ghost" title="Heading 2" onClick={() => insertMarkup("<h2>", "</h2>", "Section heading")}><Heading2 /> Heading</Button>
            <Button type="button" size="sm" variant="ghost" title="Bold" onClick={() => insertMarkup("<strong>", "</strong>", "bold text")}><Bold /> Bold</Button>
            <Button type="button" size="sm" variant="ghost" title="Link" onClick={() => insertMarkup('<a href="https://example.com">', "</a>", "link text")}><LinkIcon /> Link</Button>
            <Button type="button" size="sm" variant="ghost" title="Bulleted list" onClick={() => insertMarkup("<ul>\n  <li>", "</li>\n</ul>", "List item")}><List /> List</Button>
          </div>
          <Textarea
            ref={contentRef}
            id="blog-content"
            className={`${textAreaClass("content")} min-h-[320px] rounded-t-none font-mono text-[13px] leading-5`}
            placeholder="<p>Write the post content here…</p>"
            value={form.content}
            onChange={(event) => set("content", event.target.value)}
            aria-invalid={!!errors.content}
          />
          {errorText("content")}
        </section>

        <details className="border-t border-border pt-5">
          <summary className="cursor-pointer text-sm font-semibold">SEO settings</summary>
          <p className="mt-1 text-xs text-muted-foreground">Leave blank to derive metadata from the title, excerpt and content.</p>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="blog-metaTitle">SEO title</Label>
                <span className="text-xs text-muted-foreground">{form.metaTitle.length}/{BLOG_FORM_LIMITS.metaTitle}</span>
              </div>
              <Input id="blog-metaTitle" className={inputClass("metaTitle")} maxLength={BLOG_FORM_LIMITS.metaTitle} placeholder={form.title || "Defaults to post title"} value={form.metaTitle} onChange={(event) => set("metaTitle", event.target.value)} aria-invalid={!!errors.metaTitle} />
              {errorText("metaTitle")}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="blog-metaDescription">SEO description</Label>
                <span className="text-xs text-muted-foreground">{form.metaDescription.length}/{BLOG_FORM_LIMITS.metaDescription}</span>
              </div>
              <Textarea id="blog-metaDescription" className={textAreaClass("metaDescription")} rows={3} maxLength={BLOG_FORM_LIMITS.metaDescription} placeholder="Defaults to excerpt or readable content" value={form.metaDescription} onChange={(event) => set("metaDescription", event.target.value)} aria-invalid={!!errors.metaDescription} />
              {errorText("metaDescription")}
            </div>
            {post?.canonicalUrl && <p className="break-all text-xs text-muted-foreground">Canonical source: {post.canonicalUrl}</p>}
          </div>
        </details>

        {serverError && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            <AlertCircle className="mt-0.5 shrink-0" size={16} /> {serverError}
          </div>
        )}
      </div>

      <DialogFooter className="sticky bottom-0 gap-2 border-t border-border bg-background px-5 py-4 sm:px-6">
        <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => void onCancel()}>Cancel</Button>
        <Button className="gradient-purple border-0 text-white" type="submit" disabled={mutation.isPending || (!!post && !dirty)}>
          {mutation.isPending && <Loader2 className="animate-spin" />}
          {mutation.isPending ? "Saving…" : post ? "Save Changes" : form.status === "published" ? "Create & Publish" : "Create Draft"}
        </Button>
      </DialogFooter>
    </form>
  );
}
