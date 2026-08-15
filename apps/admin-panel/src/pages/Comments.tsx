import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2 } from "lucide-react";

export default function Comments() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();

  const { data = [], isLoading } = useQuery({ queryKey: ["comments"], queryFn: () => api.comments() });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteComment(id),
    onSuccess: () => { toast.success("Comment deleted"); qc.invalidateQueries({ queryKey: ["comments"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Comments" subtitle={`${data.length} recent comments`} />

      <Table
        loading={isLoading}
        data={data}
        keyFn={(c: any) => c.id}
        empty="No comments found"
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
          { key: "post", header: "Post", render: (c: any) => <span className="text-xs text-muted-foreground">{c.postId}</span> },
          { key: "date", header: "Date", render: (c: any) => <span className="text-muted-foreground">{fmtDateTime(c.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (c: any) => (
              <button
                title="Delete"
                onClick={async () => {
                  if (await confirm({ title: "Delete comment?", description: "This permanently removes the comment.", variant: "destructive" }))
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
