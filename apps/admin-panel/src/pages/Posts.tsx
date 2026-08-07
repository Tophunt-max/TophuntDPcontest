import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDate, truncate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Eye, EyeOff, Trash2, Heart, MessageCircle } from "lucide-react";

export default function Posts() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ["posts"], queryFn: api.posts });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["posts"] });

  const hideMut = useMutation({
    mutationFn: ({ id, isHidden }: { id: string; isHidden: boolean }) => api.setPostHidden(id, isHidden),
    onSuccess: (_d, v) => {
      toast.success(v.isHidden ? "Post hidden" : "Post shown");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => api.deletePost(id),
    onSuccess: () => {
      toast.success("Post deleted");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Posts" subtitle={`${data.length} posts — moderation`} />
      <Table
        loading={isLoading}
        data={data}
        keyFn={(p: any) => p.id}
        empty="No posts"
        columns={[
          {
            key: "media",
            header: "Post",
            render: (p: any) => (
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-lg overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0">
                  {p.mediaUrl && p.mediaType !== "video" ? (
                    <img src={p.mediaUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Badge variant="video">{p.mediaType || "media"}</Badge>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate max-w-[220px]">{truncate(p.caption, 50)}</p>
                  <p className="text-xs text-muted-foreground">{p.location || p.userId}</p>
                </div>
              </div>
            ),
          },
          {
            key: "engagement",
            header: "Engagement",
            render: (p: any) => (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Heart size={12} /> {p.likeCount ?? 0}</span>
                <span className="flex items-center gap-1"><MessageCircle size={12} /> {p.commentCount ?? 0}</span>
              </div>
            ),
          },
          { key: "status", header: "Status", render: (p: any) => <Badge variant={p.isHidden ? "danger" : "active"}>{p.isHidden ? "hidden" : "visible"}</Badge> },
          { key: "created", header: "Created", render: (p: any) => <span className="text-muted-foreground">{fmtDate(p.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (p: any) => (
              <div className="flex items-center justify-end gap-1">
                <button
                  title={p.isHidden ? "Show" : "Hide"}
                  onClick={() => hideMut.mutate({ id: p.id, isHidden: !p.isHidden })}
                  className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"
                >
                  {p.isHidden ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    if (await confirm({ title: "Delete post?", description: "This permanently removes the post.", variant: "destructive" }))
                      delMut.mutate(p.id);
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
    </div>
  );
}
