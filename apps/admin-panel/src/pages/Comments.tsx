import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2 } from "lucide-react";

/**
 * Two separate lists, not one merged feed.
 *
 * App comments (`post_comments`) and blog comments (`blog_comments`) live in
 * different tables with different id spaces, and the delete endpoint has to be
 * told which one a row came from. Merging them would mean every row carried a
 * discriminator that a mis-click could get wrong, on an action that is immediate
 * and irreversible. A tab makes the current table explicit.
 *
 * Blog comments matter more here than the tab order suggests: they are published
 * on pages search engines index, so spam there is public, not just in-app.
 */
type Source = "app" | "blog";

export default function Comments() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [source, setSource] = useState<Source>("app");
  const isBlog = source === "blog";

  const { data = [], isLoading } = useQuery({
    queryKey: ["comments", source],
    queryFn: () => api.comments(undefined, isBlog ? "blog" : undefined),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteComment(id, isBlog ? "blog" : undefined),
    onSuccess: () => {
      toast.success("Comment deleted");
      qc.invalidateQueries({ queryKey: ["comments", source] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Comments"
        subtitle={`${data.length} recent ${isBlog ? "blog" : "app"} comments`}
      />

      <div className="flex gap-2 mb-4">
        {([
          ["app", "App posts"],
          ["blog", "Blog articles"],
        ] as [Source, string][]).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setSource(value)}
            className={`px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
              source === value
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Table
        loading={isLoading}
        data={data}
        keyFn={(c: any) => c.id}
        empty={isBlog ? "No blog comments yet" : "No comments found"}
        columns={[
          {
            key: "author",
            header: "Author",
            render: (c: any) => (
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{c.fullName || c.username || "Unknown"}</p>
                <p className="text-xs text-muted-foreground truncate">{c.userId}</p>
              </div>
            ),
          },
          { key: "text", header: "Comment", render: (c: any) => <span className="text-foreground">{c.text || "—"}</span> },
          { key: "likes", header: "Likes", render: (c: any) => <span>{fmtNumber(c.likeCount)}</span> },
          {
            key: "post",
            header: isBlog ? "Article" : "Post",
            // The blog list joins the article, so show something a moderator can
            // actually judge context from instead of an opaque row id.
            render: (c: any) =>
              isBlog ? (
                <div className="min-w-0 max-w-xs">
                  <p className="text-foreground truncate">{c.postTitle || c.postId}</p>
                  {c.postSlug && <p className="text-xs text-muted-foreground truncate">/{c.postSlug}</p>}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">{c.postId}</span>
              ),
          },
          { key: "date", header: "Date", render: (c: any) => <span className="text-muted-foreground">{fmtDateTime(c.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (c: any) => (
              <button
                title="Delete"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Delete comment?",
                      description: isBlog
                        ? "This permanently removes the comment from the public article page."
                        : "This permanently removes the comment.",
                      variant: "destructive",
                    })
                  )
                    delMut.mutate(c.id);
                }}
                className="p-2 rounded-lg hover:bg-secondary text-red-600"
              >
                <Trash2 size={15} />
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}
