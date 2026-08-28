import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Info,
  Lightbulb,
  RefreshCw,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { api, type SeoAudit, type SeoIssue, type SeoSeverity } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

/**
 * SEO console.
 *
 * Reads the audit the worker produces (`src/lib/seoAudit.ts`), which is refreshed
 * on a 6-hourly cron and on demand from here.
 *
 * The one design rule worth stating: a category with no data source renders as
 * "Not measurable" with the credential it needs, NOT as a number. Off-page SEO in
 * particular has no honest value without a backlink index, and a plausible-looking
 * "62/100" would get acted on. The same applies to the AI suggestions — every one
 * is derived deterministically from our own data, so there is nothing here that a
 * language model invented.
 */

const SEVERITY_ORDER: SeoSeverity[] = ["critical", "high", "medium", "low"];

const SEVERITY_META: Record<SeoSeverity, { label: string; badge: string; icon: typeof XCircle; ring: string }> = {
  critical: { label: "Critical", badge: "danger", icon: XCircle, ring: "border-l-red-500" },
  high: { label: "High", badge: "warning", icon: AlertTriangle, ring: "border-l-orange-500" },
  medium: { label: "Medium", badge: "pending", icon: Info, ring: "border-l-amber-400" },
  low: { label: "Low", badge: "info", icon: Info, ring: "border-l-sky-400" },
};

function scoreColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 90) return "text-emerald-500";
  if (score >= 70) return "text-amber-500";
  return "text-red-500";
}

function ScoreRing({ score, size = 96 }: { score: number | null; size?: number }) {
  const pct = score ?? 0;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = score === null ? 0 : (pct / 100) * circumference;
  const colour = score === null ? "#71717a" : pct >= 90 ? "#10b981" : pct >= 70 ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-muted/30" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-extrabold ${scoreColor(score)}`}>{score === null ? "—" : score}</span>
        <span className="text-[10px] text-muted-foreground font-medium">/ 100</span>
      </div>
    </div>
  );
}

function CategoryCard({ c }: { c: NonNullable<SeoAudit["categories"]>[number] }) {
  const notMeasurable = c.score === null;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-sm font-semibold text-foreground">{c.label}</span>
        {notMeasurable ? (
          <Badge variant="default">N/A</Badge>
        ) : (
          <Badge variant={c.status === "ok" ? "success" : c.status === "warn" ? "warning" : "danger"}>
            {c.status === "ok" ? "Healthy" : c.status === "warn" ? "Needs work" : "Failing"}
          </Badge>
        )}
      </div>
      <div className={`text-3xl font-extrabold ${scoreColor(c.score)}`}>
        {notMeasurable ? "—" : `${c.score}`}
        {!notMeasurable && <span className="text-sm font-semibold text-muted-foreground">/100</span>}
      </div>
      {notMeasurable ? (
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
          <ShieldQuestion size={12} className="inline mr-1 -mt-0.5" />
          Not measurable — {c.note}
        </p>
      ) : (
        <>
          <div className="mt-2 h-1.5 rounded-full bg-muted/40 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${c.score}%`,
                background: (c.score ?? 0) >= 90 ? "#10b981" : (c.score ?? 0) >= 70 ? "#f59e0b" : "#ef4444",
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {c.checksPassed}/{c.checksRun} checks passed
          </p>
          {c.note && <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">{c.note}</p>}
        </>
      )}
    </div>
  );
}

function IssueRow({ issue, categoryLabel }: { issue: SeoIssue; categoryLabel: string }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY_META[issue.severity];
  const Icon = meta.icon;
  return (
    <div className={`border-l-4 ${meta.ring} bg-card border border-border rounded-xl overflow-hidden`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-4 flex items-start gap-3 hover:bg-muted/20"
      >
        <Icon size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{issue.title}</span>
            <Badge variant={meta.badge}>{meta.label}</Badge>
            <Badge variant="default">{categoryLabel}</Badge>
            <span className="text-xs text-muted-foreground">
              {fmtNumber(issue.affectedCount)} affected
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{issue.detail}</p>
        </div>
        <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3">
          {issue.suggestion && (
            <div className="rounded-lg bg-muted/30 border border-border p-3">
              <p className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-1">
                <Lightbulb size={13} /> Recommended fix
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">{issue.suggestion}</p>
            </div>
          )}
          {issue.affected.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-foreground mb-1.5">
                Affected {issue.affectedCount > issue.affected.length && `(first ${issue.affected.length} of ${fmtNumber(issue.affectedCount)})`}
              </p>
              <ul className="space-y-1">
                {issue.affected.map((a) => (
                  <li key={a} className="text-xs text-muted-foreground font-mono break-all">{a}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground font-mono opacity-60">check id: {issue.id}</p>
        </div>
      )}
    </div>
  );
}

export default function Seo() {
  const qc = useQueryClient();
  const audit = useQuery<SeoAudit>({ queryKey: ["seo-audit"], queryFn: api.seoAudit });
  const [severityFilter, setSeverityFilter] = useState<SeoSeverity | "all">("all");
  const [showPassed, setShowPassed] = useState(false);

  const scan = useMutation({
    mutationFn: api.seoScan,
    onSuccess: (r) => {
      toast.success(r?.message || "SEO scan complete");
      qc.invalidateQueries({ queryKey: ["seo-audit"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const data = audit.data;
  const hasRun = !!data?.ranAt;
  const categories = data?.categories ?? [];
  const labelFor = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.label])) as Record<string, string>,
    [categories],
  );

  const issues = data?.issues ?? [];
  const visibleIssues = severityFilter === "all" ? issues : issues.filter((i) => i.severity === severityFilter);

  /** Download the raw audit — the report artefact, without inventing a PDF layout. */
  const downloadReport = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seo-report-${new Date(data.ranAt || Date.now()).toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="SEO"
        subtitle={
          hasRun
            ? `${data!.origin} · last scanned ${fmtDateTime(data!.ranAt!)} · ${fmtNumber(data!.scope?.posts ?? 0)} published posts`
            : "Search visibility audit across eight categories"
        }
        action={
          <div className="flex items-center gap-2">
            {hasRun && (
              <button
                onClick={downloadReport}
                className="h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground flex items-center gap-1.5 hover:bg-muted/40"
              >
                <Download size={14} /> Report
              </button>
            )}
            <button
              onClick={() => scan.mutate()}
              disabled={scan.isPending}
              className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50"
            >
              <RefreshCw size={14} className={scan.isPending ? "animate-spin" : ""} />
              {scan.isPending ? "Scanning…" : "Re-scan site"}
            </button>
          </div>
        }
      />

      {audit.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-card h-[132px] animate-pulse" />
          ))}
        </div>
      ) : !hasRun ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <ShieldQuestion size={40} className="mx-auto text-muted-foreground opacity-50 mb-3" />
          <p className="font-semibold text-foreground">No audit has run yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            The audit refreshes automatically every 6 hours. Run one now to get the first report.
          </p>
          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            className="mt-5 inline-flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50"
          >
            <RefreshCw size={14} className={scan.isPending ? "animate-spin" : ""} /> Run first scan
          </button>
        </div>
      ) : (
        <>
          {/* Overall + severity totals */}
          <div className="rounded-2xl border border-border bg-card p-5 mb-6 flex flex-col sm:flex-row items-center gap-6">
            <ScoreRing score={data!.overall ?? null} size={112} />
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-foreground mb-1">Overall SEO score</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                Average of the {categories.filter((c) => c.score !== null).length} measurable categories.
                Categories without a data source are excluded rather than counted as zero — including them
                would permanently cap the score at a number that means nothing.
              </p>
              <div className="flex flex-wrap gap-2">
                {SEVERITY_ORDER.map((s) => {
                  const n = data!.totals?.[s] ?? 0;
                  const meta = SEVERITY_META[s];
                  return (
                    <button
                      key={s}
                      onClick={() => setSeverityFilter(severityFilter === s ? "all" : s)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
                        severityFilter === s ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted/40"
                      }`}
                    >
                      <meta.icon size={13} /> {meta.label}: {n}
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowPassed((v) => !v)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
                    showPassed ? "border-emerald-500 bg-emerald-500/10 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  <CheckCircle2 size={13} /> Passed: {data!.passed?.length ?? 0}
                </button>
              </div>
            </div>
          </div>

          {/* Per-category scores */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {categories.map((c) => (
              <CategoryCard key={c.id} c={c} />
            ))}
          </div>

          {/* Passed checks */}
          {showPassed && (
            <div className="rounded-2xl border border-border bg-card p-5 mb-6">
              <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
                <CheckCircle2 size={15} className="text-emerald-500" /> Passed checks ({data!.passed?.length ?? 0})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
                {(data!.passed ?? []).map((p) => (
                  <div key={p.id} className="flex items-start gap-2 text-xs">
                    <CheckCircle2 size={13} className="text-emerald-500 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">
                      {p.title} <span className="opacity-50">· {labelFor[p.category] ?? p.category}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Issues */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-foreground flex items-center gap-2">
              <AlertTriangle size={15} /> Issues
              {severityFilter !== "all" && (
                <button onClick={() => setSeverityFilter("all")} className="text-xs font-medium text-muted-foreground underline">
                  clear {SEVERITY_META[severityFilter].label} filter
                </button>
              )}
            </h3>
            <span className="text-xs text-muted-foreground">
              {fmtNumber(visibleIssues.length)} shown · scan took {data!.durationMs}ms
            </span>
          </div>

          {visibleIssues.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card p-10 text-center">
              <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-3" />
              <p className="font-semibold text-foreground">
                {severityFilter === "all" ? "No issues found" : `No ${SEVERITY_META[severityFilter].label.toLowerCase()} issues`}
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {visibleIssues.map((i) => (
                <IssueRow key={i.id} issue={i} categoryLabel={labelFor[i.category] ?? i.category} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
