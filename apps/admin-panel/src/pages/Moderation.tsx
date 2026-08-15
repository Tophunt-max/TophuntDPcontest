import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { PageHeader, fmtDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { Plus, X, Trash2, ShieldBan, MessagesSquare } from "lucide-react";

export default function Moderation() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [word, setWord] = useState("");

  const words = useQuery({ queryKey: ["banned-words"], queryFn: api.bannedWords });
  const messages = useQuery({ queryKey: ["messages"], queryFn: api.messages });

  const addWord = useMutation({
    mutationFn: () => api.addBannedWord(word.trim()),
    onSuccess: () => { toast.success("Word added"); setWord(""); qc.invalidateQueries({ queryKey: ["banned-words"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const delWord = useMutation({
    mutationFn: (w: string) => api.deleteBannedWord(w),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["banned-words"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const delMsg = useMutation({
    mutationFn: (id: string) => api.deleteMessage(id),
    onSuccess: () => { toast.success("Message deleted"); qc.invalidateQueries({ queryKey: ["messages"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const field = "px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader title="Moderation" subtitle="Banned words & message moderation" />

      {/* Banned words */}
      <div className="bg-card border border-border rounded-2xl p-5 mb-6">
        <h3 className="font-bold text-foreground mb-1 flex items-center gap-2"><ShieldBan size={16} className="text-red-500" /> Banned Words</h3>
        <p className="text-xs text-muted-foreground mb-4">Words the app/worker can reject in usernames, captions and comments.</p>
        <div className="flex gap-2 mb-4">
          <input className={`${field} flex-1`} placeholder="Add a word…" value={word} onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === "Enter" && word.trim() && addWord.mutate()} />
          <button onClick={() => word.trim() && addWord.mutate()} disabled={!word.trim() || addWord.isPending} className="gradient-purple text-white text-sm font-semibold px-4 py-2.5 rounded-xl disabled:opacity-50 flex items-center gap-1"><Plus size={15} /> Add</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(words.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No banned words</p>
          ) : (
            words.data!.map((w) => (
              <span key={w} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-50 text-red-700 text-sm">
                {w}
                <button onClick={() => delWord.mutate(w)} className="hover:text-red-900"><X size={13} /></button>
              </span>
            ))
          )}
        </div>
      </div>

      {/* Messages */}
      <h3 className="font-bold text-foreground mb-3 flex items-center gap-2"><MessagesSquare size={16} className="text-violet-600" /> Recent Messages</h3>
      <Table
        loading={messages.isLoading}
        data={messages.data ?? []}
        keyFn={(m: any) => m.id}
        empty="No messages"
        columns={[
          { key: "sender", header: "Sender", render: (m: any) => <span className="font-medium text-foreground">{m.username || m.senderId}</span> },
          { key: "text", header: "Message", render: (m: any) => <span className="text-foreground">{m.text || "—"}</span> },
          { key: "chat", header: "Chat", render: (m: any) => <span className="text-xs text-muted-foreground">{m.chatId}</span> },
          { key: "date", header: "When", render: (m: any) => <span className="text-muted-foreground">{fmtDateTime(m.createdAt)}</span> },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (m: any) => (
              <button title="Delete" onClick={async () => { if (await confirm({ title: "Delete message?", description: "This permanently removes the message.", variant: "destructive" })) delMsg.mutate(m.id); }} className="p-2 rounded-lg hover:bg-secondary text-red-600"><Trash2 size={15} /></button>
            ),
          },
        ]}
      />
    </div>
  );
}
