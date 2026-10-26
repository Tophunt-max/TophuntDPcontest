import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";

/**
 * For You ranking weights (apps/worker/src/lib/feedWeights.ts, docs/RANKING.md).
 *
 * The weights existed only as `appConfig.feedWeights`, which App Settings shows
 * in its Advanced JSON box only once something has been stored, so on a fresh
 * install there was nothing to edit. This page lists every weight with its
 * default, its allowed range and the value the feed uses now. The Worker
 * validates and audits each save; the feed picks it up on the next request
 * (other servers within 30 s).
 */

type Key = string;
interface FeedWeightsInfo {
  algorithm: string;
  defaults: Record<Key, number>;
  bounds: Record<Key, [number, number]>;
  integerKeys: Key[];
  stored: Record<Key, number> | null;
  effective: Record<Key, number>;
  version: string;
  defaultVersion: string;
}

const GROUPS: Array<{ title: string; hint: string; keys: Array<[Key, string, string]> }> = [
  {
    title: "Content score (same for everyone)",
    hint: "Decides which battles are good on their own, before anything about the viewer.",
    keys: [
      ["freshness", "Freshness", "Newer battles rank higher (decays over ~24 h)."],
      ["velocity", "Velocity", "Votes, likes, comments and shares per hour."],
      ["urgency", "Ending soon", "Boost in the last 6 hours of voting."],
      ["prize", "Prize", "Higher entry fee ranks slightly higher."],
      ["result", "Fresh result", "Keeps a just-finished battle's winner visible."],
      ["newCreator", "New creator", "Live battles by accounts under 30 days and 50 followers."],
    ],
  },
  {
    title: "Personal signals (signed-in viewers)",
    hint: "Added for the viewer's own history with the creators.",
    keys: [
      ["follow", "Follows a participant", "Strongest signal."],
      ["votedAffinity", "Voted for them before", "Last 500 votes."],
      ["visitAffinity", "Visited their profile", "Last 500 visits."],
      ["resultVotedBoost", "Result of a battle they voted on", "Finished battles only."],
    ],
  },
  {
    title: "Penalties (subtracted)",
    hint: "Each one only ever lowers a battle; none can go negative.",
    keys: [
      ["votedPenalty", "Already voted", "Live battle the viewer already voted on."],
      ["seenPenalty", "Shown, not voted", "Per time shown, up to the cap below."],
      ["seenCap", "Times-shown cap", "Whole number."],
      ["notInterested", "Not interested", "Other battles by a creator the viewer dismissed."],
    ],
  },
];

const field =
  "w-24 px-2 py-1.5 rounded-lg border border-border bg-background text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

export default function FeedRanking() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const q = useQuery({ queryKey: ["feed-weights"], queryFn: api.feedWeights });
  const [draft, setDraft] = useState<Record<Key, string>>({});

  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(Object.entries(q.data.effective).map(([k, v]) => [k, String(v)])));
  }, [q.data]);

  const info = q.data as FeedWeightsInfo | undefined;

  const errors = useMemo(() => {
    const out: Record<Key, string> = {};
    if (!info) return out;
    for (const [k, raw] of Object.entries(draft)) {
      const v = Number(raw);
      const [lo, hi] = info.bounds[k] ?? [0, 0];
      if (raw.trim() === "" || !Number.isFinite(v)) out[k] = "Enter a number";
      else if (v < lo || v > hi) out[k] = `${lo}–${hi}`;
      else if (info.integerKeys.includes(k) && !Number.isInteger(v)) out[k] = "Whole number";
    }
    return out;
  }, [draft, info]);

  const changed = useMemo(
    () => (info ? Object.keys(draft).filter((k) => Number(draft[k]) !== info.effective[k]) : []),
    [draft, info],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["feed-weights"] });
    qc.invalidateQueries({ queryKey: ["app-settings"] });
  };
  const save = useMutation({
    mutationFn: () => api.saveAppSettings({ feedWeights: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])) }),
    onSuccess: () => {
      toast.success("Ranking weights saved. The feed uses them on the next request.");
      refresh();
    },
    onError: (e: any) => toast.error(e?.message || "Could not save"),
  });
  const reset = useMutation({
    mutationFn: () => api.saveAppSettings({ feedWeights: null }),
    onSuccess: () => {
      toast.success("Default weights restored.");
      refresh();
    },
    onError: (e: any) => toast.error(e?.message || "Could not reset"),
  });

  if (q.isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;
  if (q.isError || !info) return <div className="text-sm text-red-600 py-10 text-center">Could not load the ranking weights.</div>;

  const usingDefaults = info.version === info.defaultVersion;

  return (
    <div>
      <PageHeader title="Feed Ranking" subtitle="Weights for the For You and Following feeds" />

      <div className="bg-card border border-border rounded-2xl p-4 mb-5 text-sm flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <span className="text-muted-foreground">Ranking version </span>
          <code className="font-mono">{info.version}</code>
        </div>
        <div className={usingDefaults ? "text-muted-foreground" : "text-amber-600 font-medium"}>
          {usingDefaults ? "Using the defaults" : "Custom weights in use"}
        </div>
        <div className="text-xs text-muted-foreground w-full">
          Every save is recorded in Audit &amp; Security with the old and new values. The feed sends this version in the
          <code className="mx-1">X-Feed-Ranking</code> header, so you can tell which weights ranked a page. Details: docs/RANKING.md.
        </div>
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="bg-card border border-border rounded-2xl p-5 mb-5">
          <h3 className="font-bold text-foreground">{g.title}</h3>
          <p className="text-xs text-muted-foreground mb-4">{g.hint}</p>
          <div className="divide-y divide-border">
            {g.keys.map(([k, labelText, help]) => {
              const [lo, hi] = info.bounds[k];
              const isChanged = changed.includes(k);
              return (
                <div key={k} className="py-3 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <div className="text-sm font-medium text-foreground">
                      {labelText} <code className="text-[11px] text-muted-foreground ml-1">{k}</code>
                    </div>
                    <div className="text-xs text-muted-foreground">{help}</div>
                  </div>
                  <div className="text-xs text-muted-foreground w-36">
                    Default {info.defaults[k]} · range {lo}–{hi}
                  </div>
                  <div className="flex flex-col items-end">
                    <input
                      aria-label={labelText}
                      className={`${field} ${isChanged ? "border-amber-500" : ""}`}
                      inputMode="decimal"
                      value={draft[k] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                    />
                    {errors[k] && <span className="text-[11px] text-red-600 mt-1">{errors[k]}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap gap-3 justify-end">
        <button
          onClick={async () => {
            if (await confirm({ title: "Restore default weights?", description: "The feed goes back to the built-in weights on the next request.", variant: "destructive" }))
              reset.mutate();
          }}
          disabled={reset.isPending || (usingDefaults && info.stored == null)}
          className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 flex items-center gap-2"
        >
          <RotateCcw size={16} /> Restore defaults
        </button>
        <button
          onClick={async () => {
            if (
              await confirm({
                title: `Save ${changed.length} change${changed.length === 1 ? "" : "s"}?`,
                description: changed.map((k) => `${k}: ${info.effective[k]} → ${Number(draft[k])}`).join(", "),
              })
            )
              save.mutate();
          }}
          disabled={save.isPending || changed.length === 0 || Object.keys(errors).length > 0}
          className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        >
          <Save size={16} /> Save weights
        </button>
      </div>
    </div>
  );
}
