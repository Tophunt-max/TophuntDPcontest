import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2 } from "lucide-react";

export default function Stories() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ["stories"], queryFn: api.stories });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteStory(id),
    onSuccess: () => {
      toast.success("Story deleted");
      qc.invalidateQueries({ queryKey: ["stories"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Stories" subtitle={`${data.length} active stories`} />
      <Table
        loading={isLoading}
        data={data}
        keyFn={(s: any) => s.id}
        empty="No stories"
        columns={[
          {
            key: "story",
            header: "Story",
            render: (s: any) => (
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-lg overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0">
                  {s.mediaUrl && s.mediaType !== "video" ? (
                    <img src={s.mediaUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Badge variant="video">{s.mediaType || "media"}</Badge>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{s.username || s.userId}</p>
                  <p className="text-xs text-muted-foreground truncate">{s.overlayText || s.contestTitle || s.type}</p>
                </div>
              </div>
            ),
          },
          { key: "type", header: "Type", render: (s: any) => <Badge variant="primary">{s.type || "story"}</Badge> },
          { key: "visibility", header: "Visibility", render: (s: any) => <span className="text-muted-foreground">{s.visibility || "public"}</span> },
          { key: "created", header: "Created", render: (s: any) => <span className="text-muted-foreground">{fmtDateTime(s.createdAt)}</span> },
          { key: "expires", header: "Expires", render: (s: any) => <span className="text-muted-foreground">{fmtDateTime(s.expiresAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (s: any) => (
              <button
                title="Delete"
                onClick={async () => {
                  if (await confirm({ title: "Delete story?", description: "This permanently removes the story.", variant: "destructive" }))
                    delMut.mutate(s.id);
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
