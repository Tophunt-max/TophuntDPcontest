import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Plus, Pencil, Trash2, FileText, CheckCircle2, FilePlus, DownloadCloud } from "lucide-react";

export default function Blog() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [editing, setEditing] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading } = useQuery({ queryKey: ["blog"], queryFn: () => api.blog() });
  const stats = useQuery({ queryKey: ["blog-stats"], queryFn: api.blogStats });
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
