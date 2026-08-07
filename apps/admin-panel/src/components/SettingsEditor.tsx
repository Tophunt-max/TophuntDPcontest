import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Save, RotateCcw, AlertTriangle } from "lucide-react";

interface Props {
  title: string;
  subtitle: string;
  queryKey: string;
  load: () => Promise<any>;
  save: (payload: any) => Promise<any>;
}

/**
 * Generic editor for the Worker's flexible settings objects (appConfig /
 * gamification). Renders the current config and lets an admin edit it as
 * validated JSON — the Worker merges the posted object into the stored one.
 */
export function SettingsEditor({ title, subtitle, queryKey, load, save }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: [queryKey], queryFn: load });
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) setText(JSON.stringify(data, null, 2));
  }, [data]);

  const mut = useMutation({
    mutationFn: (payload: any) => save(payload),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: [queryKey] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const onSave = () => {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      setErr("Invalid JSON: " + e.message);
      return;
    }
    setErr(null);
    mut.mutate(parsed);
  };

  const reset = () => data && setText(JSON.stringify(data, null, 2));

  const keys = data && typeof data === "object" ? Object.keys(data) : [];

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex items-center gap-2">
            <button onClick={reset} className="flex items-center gap-2 bg-secondary text-foreground text-sm font-medium px-3 py-2 rounded-xl">
              <RotateCcw size={15} /> Reset
            </button>
            <button
              onClick={onSave}
              disabled={mut.isPending || isLoading}
              className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
            >
              <Save size={15} /> Save
            </button>
          </div>
        }
      />

      {keys.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {keys.map((k) => (
            <span key={k} className="text-xs bg-violet-100 text-violet-700 px-2.5 py-1 rounded-full font-medium">
              {k}
            </span>
          ))}
        </div>
      )}

      {err && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-3">
          <AlertTriangle size={16} /> {err}
        </div>
      )}

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-secondary/40 flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Configuration (JSON)</span>
        </div>
        <textarea
          value={isLoading ? "Loading…" : text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="w-full min-h-[460px] p-4 font-mono text-[13px] leading-relaxed bg-background text-foreground focus:outline-none resize-y"
        />
      </div>
    </div>
  );
}
