import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, truncate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Trash2, Reply } from "lucide-react";

export default function Support() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [reply, setReply] = useState<any | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ["support"], queryFn: api.support });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["support"] });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteTicket(id),
    onSuccess: () => {
      toast.success("Ticket deleted");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Support Tickets" subtitle={`${data.length} tickets`} />
      <Table
        loading={isLoading}
        data={data}
        keyFn={(t: any) => t.id}
        empty="No tickets"
        columns={[
          { key: "subject", header: "Subject", render: (t: any) => (
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate max-w-[240px]">{t.subject || "(no subject)"}</p>
              <p className="text-xs text-muted-foreground truncate max-w-[240px]">{truncate(t.message, 60)}</p>
            </div>
          ) },
          { key: "user", header: "User", render: (t: any) => <span className="text-xs text-muted-foreground">{t.userId}</span> },
          { key: "status", header: "Status", render: (t: any) => <Badge variant={t.status === "resolved" ? "success" : "pending"}>{t.status}</Badge> },
          { key: "created", header: "Created", render: (t: any) => <span className="text-muted-foreground">{fmtDateTime(t.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (t: any) => (
              <div className="flex items-center justify-end gap-1">
                <button title="Reply / resolve" onClick={() => setReply(t)} className="p-2 rounded-lg hover:bg-secondary text-violet-600">
                  <Reply size={15} />
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    if (await confirm({ title: "Delete ticket?", variant: "destructive" })) delMut.mutate(t.id);
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
      {reply && <ReplyDialog ticket={reply} onClose={() => setReply(null)} onDone={invalidate} />}
    </div>
  );
}

function ReplyDialog({ ticket, onClose, onDone }: { ticket: any; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(ticket.adminReply || "");
  const [status, setStatus] = useState(ticket.status || "resolved");
  const mut = useMutation({
    mutationFn: () => api.updateTicket(ticket.id, status, text),
    onSuccess: () => {
      toast.success("Ticket updated");
      onDone();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const field = "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-foreground mb-1">{ticket.subject || "Ticket"}</h3>
        <p className="text-sm text-muted-foreground mb-4">{ticket.message}</p>
        <label className="text-xs text-muted-foreground mb-1 block">Admin reply</label>
        <textarea className={`${field} min-h-[100px] mb-3`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" />
        <label className="text-xs text-muted-foreground mb-1 block">Status</label>
        <select className={`${field} mb-4`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
        </select>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-sm font-medium">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
