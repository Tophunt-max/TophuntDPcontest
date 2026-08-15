import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2, Ban, ImageOff } from "lucide-react";

export default function Reports() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ["reports"], queryFn: api.reports });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["reports"] });

  const resolveMut = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "dismiss" | "remove" }) => api.resolveReport(id, action),
    onSuccess: (_d, v) => {
      toast.success(v.action === "remove" ? "Content removed" : "Report dismissed");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Reports" subtitle={`${data.length} content reports`} />
      <Table
        loading={isLoading}
        data={data}
        keyFn={(r: any) => r.id}
        empty="No reports"
        columns={[
          {
            key: "preview",
            header: "Content",
            render: (r: any) => {
              const p = r.preview;
              return (
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0">
                    {p?.mediaUrl ? (
                      <img src={p.mediaUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <ImageOff size={16} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{r.targetType || "content"}{p?.missing ? " (deleted)" : ""}</p>
                    <p className="text-xs text-muted-foreground truncate max-w-[200px]">{p?.text || r.targetId}</p>
                  </div>
                </div>
              );
            },
          },
          { key: "reason", header: "Reason", render: (r: any) => <span className="text-sm">{r.reason || "—"}</span> },
          { key: "reporter", header: "Reporter", render: (r: any) => <span className="text-xs text-muted-foreground">{r.reporterId}</span> },
          { key: "status", header: "Status", render: (r: any) => <Badge variant={r.status === "reviewed" ? "reviewed" : r.status === "actioned" ? "actioned" : "pending"}>{r.status || "pending"}</Badge> },
          { key: "created", header: "Reported", render: (r: any) => <span className="text-muted-foreground">{fmtDateTime(r.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (r: any) => (
              <div className="flex items-center justify-end gap-1">
                <button
                  title="Remove reported content"
                  onClick={async () => {
                    if (await confirm({ title: "Remove content?", description: "This deletes the reported content and closes the report.", variant: "destructive" }))
                      resolveMut.mutate({ id: r.id, action: "remove" });
                  }}
                  className="p-2 rounded-lg hover:bg-secondary text-red-600"
                >
                  <Ban size={15} />
                </button>
                <button
                  title="Dismiss report"
                  onClick={async () => {
                    if (await confirm({ title: "Dismiss report?", description: "Keep the content and remove the report from the queue." }))
                      resolveMut.mutate({ id: r.id, action: "dismiss" });
                  }}
                  className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"
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
