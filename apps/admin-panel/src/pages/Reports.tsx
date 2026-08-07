import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2 } from "lucide-react";

export default function Reports() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ["reports"], queryFn: api.reports });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteReport(id),
    onSuccess: () => {
      toast.success("Report dismissed");
      qc.invalidateQueries({ queryKey: ["reports"] });
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
          { key: "target", header: "Target", render: (r: any) => (
            <div>
              <p className="text-sm font-medium text-foreground">{r.targetType || "content"}</p>
              <p className="text-xs text-muted-foreground truncate max-w-[200px]">{r.targetId}</p>
            </div>
          ) },
          { key: "reason", header: "Reason", render: (r: any) => <span className="text-sm">{r.reason || "—"}</span> },
          { key: "reporter", header: "Reporter", render: (r: any) => <span className="text-xs text-muted-foreground">{r.reporterId}</span> },
          { key: "status", header: "Status", render: (r: any) => <Badge variant={r.status === "reviewed" ? "reviewed" : r.status === "actioned" ? "actioned" : "pending"}>{r.status || "pending"}</Badge> },
          { key: "created", header: "Reported", render: (r: any) => <span className="text-muted-foreground">{fmtDateTime(r.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (r: any) => (
              <button
                title="Dismiss / delete report"
                onClick={async () => {
                  if (await confirm({ title: "Dismiss report?", description: "This removes the report from the queue." }))
                    delMut.mutate(r.id);
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
