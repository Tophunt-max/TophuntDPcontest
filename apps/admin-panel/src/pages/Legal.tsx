import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type LegalDoc } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { FileText, RotateCcw, Save, Loader2 } from "lucide-react";

/**
 * Legal documents editor.
 *
 * The four legally-required documents (privacy, terms, refund, community) are
 * BUNDLED with the Worker so a policy is never blank — an empty privacy policy is
 * an app-store rejection. The old admin surface exposed only raw "override" boxes,
 * which sat empty and read as "the app has no policy" even though it always serves
 * the bundled text.
 *
 * This editor prefills each box with the EFFECTIVE content the app currently serves
 * (a stored override, or the bundled default), tokens intact. Saving stores an
 * override the app serves immediately; "Reset to default" clears it so the bundled
 * text takes over again. Everything is per-document, so customising one never
 * disturbs the others.
 */

function DocCard({ doc }: { doc: LegalDoc }) {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [value, setValue] = useState(doc.content);

  // Keep the editor in sync when the server copy changes (after a save/reset).
  useEffect(() => {
    setValue(doc.content);
  }, [doc.content]);

  const dirty = value !== doc.content;

  const saveMut = useMutation({
    mutationFn: (content: string) => api.saveLegal(doc.key, content),
    onSuccess: () => {
      toast.success(`${doc.label} saved — live in the app.`);
      qc.invalidateQueries({ queryKey: ["legal"] });
    },
    onError: (e: any) => toast.error(e?.message || "Could not save."),
  });

  const resetMut = useMutation({
    // Empty content clears the override -> app falls back to the bundled default.
    mutationFn: () => api.saveLegal(doc.key, ""),
    onSuccess: () => {
      toast.success(`${doc.label} reset to the built-in default.`);
      qc.invalidateQueries({ queryKey: ["legal"] });
    },
    onError: (e: any) => toast.error(e?.message || "Could not reset."),
  });

  const busy = saveMut.isPending || resetMut.isPending;

  const askReset = async () => {
    if (
      await confirm({
        title: `Reset ${doc.label}?`,
        description:
          "Your custom text is discarded and the app goes back to the document bundled with the app. This cannot be undone.",
        variant: "destructive",
      })
    ) {
      resetMut.mutate();
    }
  };

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="flex flex-col gap-2 p-4 border-b border-border sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FileText size={15} className="text-violet-600 flex-shrink-0" />
            <h3 className="font-bold text-foreground">{doc.label}</h3>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                doc.isCustom
                  ? "bg-violet-100 text-violet-700"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {doc.isCustom ? "Custom" : "Default"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{doc.note}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {doc.isCustom && (
            <button
              onClick={askReset}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw size={13} /> Reset to default
            </button>
          )}
          <button
            onClick={() => saveMut.mutate(value)}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-primary text-primary-foreground disabled:opacity-40"
          >
            {saveMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full resize-y bg-transparent px-4 py-3 text-sm font-mono leading-relaxed text-foreground outline-none"
        placeholder="Document content (Markdown). Leave empty and Reset to use the bundled default."
      />

      <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
        <span>
          Markdown supported. Tokens{" "}
          <code className="font-mono">{"{{SUPPORT_EMAIL}}"}</code> and{" "}
          <code className="font-mono">{"{{DELETION_GRACE_DAYS}}"}</code> are filled in automatically.
        </span>
        <span>{value.length.toLocaleString()} chars</span>
      </div>
    </div>
  );
}

export default function Legal() {
  const q = useQuery({ queryKey: ["legal"], queryFn: api.legal });

  return (
    <div>
      <PageHeader
        title="Legal Content"
        subtitle="Privacy, Terms, Refund and Community docs shown in the app and on the website"
      />

      <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4 mb-6 text-sm text-sky-900">
        Each box shows the text the app is serving <strong>right now</strong>. Edit and{" "}
        <strong>Save</strong> to publish your own version; <strong>Reset to default</strong> restores
        the document built into the app. Nothing is ever blank — a policy left untouched keeps serving
        the built-in text.
        {q.data?.lastUpdated && (
          <span className="block mt-1 text-xs text-sky-700">
            Built-in documents last updated: {q.data.lastUpdated}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : q.isError ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-800">
          Could not load legal documents. Please retry.
        </div>
      ) : (
        <div className="space-y-6">
          {(q.data?.docs ?? []).map((doc) => (
            <DocCard key={doc.key} doc={doc} />
          ))}
        </div>
      )}
    </div>
  );
}
