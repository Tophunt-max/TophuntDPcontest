import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DeepHealth, type MoneyHealth, type CronJobHealth } from "@/lib/api";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Database,
  HardDrive,
  Server,
  KeyRound,
  Plug,
  Clock,
  Wallet,
  Scale,
  ServerCrash,
  Bell,
} from "lucide-react";

/**
 * System Health — one screen that answers "is anything broken right now?".
 *
 * Pulls three authenticated aggregations from the worker (app/backend health,
 * money-flow integrity, and — via the health payload — cron status), plus the
 * existing error-log and ops-alert feeds, and auto-refreshes. The intent is that
 * an operator opens this page and, without knowing the internals, sees exactly
 * where a problem is: a dependency, a missing secret, a stalled cron, a spike in
 * API errors, or — the one that matters most — coins that don't add up.
 */

const REFRESH_MS = 20_000;

function fmtAge(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const CHECK_ICON: Record<string, any> = {
  d1: Database,
  kv_cache: HardDrive,
  kv_otp: HardDrive,
  r2: Server,
  secrets: KeyRound,
  integrations: Plug,
  cron: Clock,
};

function Pill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
        ok ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
      }`}
    >
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {label ?? (ok ? "Healthy" : "Attention")}
    </span>
  );
}

/** A single metric tile. `bad` turns it red; `warn` amber. */
function Metric({
  icon: Icon,
  label,
  value,
  sub,
  bad,
  warn,
}: {
  icon: any;
  label: string;
  value: React.ReactNode;
  sub?: string;
  bad?: boolean;
  warn?: boolean;
}) {
  const tone = bad ? "border-red-300 bg-red-50" : warn ? "border-amber-300 bg-amber-50" : "border-border bg-card";
  const valueTone = bad ? "text-red-600" : warn ? "text-amber-700" : "text-foreground";
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
        <Icon size={14} /> {label}
      </div>
      <div className={`text-2xl font-bold ${valueTone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default function SystemHealth() {
  const qc = useQueryClient();

  const health = useQuery<DeepHealth>({ queryKey: ["sys-health"], queryFn: api.systemHealth, refetchInterval: REFRESH_MS });
  const money = useQuery<MoneyHealth>({ queryKey: ["sys-money"], queryFn: api.moneyHealth, refetchInterval: REFRESH_MS });
  const logStats = useQuery({ queryKey: ["sys-logstats"], queryFn: api.logStats, refetchInterval: REFRESH_MS });
  const recentErrors = useQuery({ queryKey: ["sys-logs"], queryFn: () => api.logs({ limit: 8 }), refetchInterval: REFRESH_MS });
  const alerts = useQuery<any[]>({ queryKey: ["sys-alerts"], queryFn: api.notifications, refetchInterval: REFRESH_MS });

  const refresh = () => {
    for (const k of ["sys-health", "sys-money", "sys-logstats", "sys-logs", "sys-alerts"]) {
      qc.invalidateQueries({ queryKey: [k] });
    }
  };

  const h = health.data;
  const m = money.data;
  const crons: CronJobHealth[] = h?.crons ?? [];

  // Overall: red if any known signal is bad. Unknown (still loading) is neutral.
  const appOk = h?.ok;
  const moneyOk = m?.ok;
  const overall = appOk === false || moneyOk === false ? false : appOk === true && moneyOk === true ? true : null;

  return (
    <div>
      <PageHeader
        title="System Health"
        subtitle="Backend, integrations, cron, API errors and money-flow integrity — one place"
        action={
          <button
            onClick={refresh}
            className="h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground flex items-center gap-1.5 hover:bg-muted/40"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        }
      />

      {/* Overall banner */}
      <div
        className={`flex items-center gap-3 rounded-2xl border px-5 py-4 mb-6 ${
          overall === false
            ? "border-red-300 bg-red-50"
            : overall === true
              ? "border-green-300 bg-green-50"
              : "border-border bg-card"
        }`}
      >
        {overall === false ? (
          <AlertTriangle className="text-red-600 shrink-0" size={22} />
        ) : (
          <Activity className={overall === true ? "text-green-600 shrink-0" : "text-muted-foreground shrink-0"} size={22} />
        )}
        <div className="flex-1">
          <div className="font-bold text-foreground">
            {overall === false ? "Something needs attention" : overall === true ? "All systems operational" : "Checking…"}
          </div>
          <div className="text-xs text-muted-foreground">
            Auto-refreshes every {REFRESH_MS / 1000}s · last checked {h ? fmtDateTime(h.ts) : "—"}
          </div>
        </div>
        <div className="flex gap-2">
          {appOk !== undefined && <Pill ok={!!appOk} label={appOk ? "Backend OK" : "Backend"} />}
          {moneyOk !== undefined && <Pill ok={!!moneyOk} label={moneyOk ? "Money OK" : "Money"} />}
        </div>
      </div>

      {/* ---------------- Application / backend health ---------------- */}
      <h3 className="text-sm font-bold text-foreground mb-3">Backend &amp; dependencies</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
        {h
          ? Object.entries(h.checks).map(([name, check]) => {
              const Icon = CHECK_ICON[name] ?? Server;
              return (
                <div key={name} className={`rounded-2xl border p-4 ${check.ok ? "border-border bg-card" : "border-red-300 bg-red-50"}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <Icon size={14} /> {name}
                    </div>
                    {check.ok ? <CheckCircle2 size={15} className="text-green-600" /> : <XCircle size={15} className="text-red-600" />}
                  </div>
                  <div className={`text-sm font-semibold ${check.ok ? "text-foreground" : "text-red-600"}`}>
                    {check.ok ? "OK" : "Failing"}
                    {typeof check.ms === "number" && <span className="text-muted-foreground font-normal"> · {check.ms}ms</span>}
                  </div>
                  {check.detail && <div className="text-[11px] text-red-600 mt-1 break-words">{check.detail}</div>}
                </div>
              );
            })
          : Array.from({ length: 7 }).map((_, i) => <div key={i} className="rounded-2xl border border-border bg-card p-4 h-[92px] animate-pulse" />)}
      </div>

      {/* ---------------- Money-flow integrity ---------------- */}
      <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <Wallet size={15} /> Money-flow integrity
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
        <Metric
          icon={Scale}
          label="Ledger drift"
          value={m ? (m.ledgerDrift.count < 0 ? "?" : fmtNumber(m.ledgerDrift.count)) : "—"}
          sub="wallet ≠ sum(ledger)"
          bad={!!m && m.ledgerDrift.count !== 0}
        />
        <Metric
          icon={Wallet}
          label="Negative balances"
          value={m ? fmtNumber(m.negativeBalances.count) : "—"}
          bad={!!m && m.negativeBalances.count !== 0}
        />
        <Metric
          icon={AlertTriangle}
          label="Paid, not credited"
          value={m ? fmtNumber(m.strandedPaidOrders) : "—"}
          sub="captured at gateway"
          bad={!!m && m.strandedPaidOrders !== 0}
        />
        <Metric
          icon={AlertTriangle}
          label="Clawback shortfall"
          value={m ? fmtNumber(m.clawbackShortfalls.count) : "—"}
          sub={m && m.clawbackShortfalls.count ? `${fmtNumber(m.clawbackShortfalls.coins)} coins unrecovered` : "refund-farming"}
          bad={!!m && m.clawbackShortfalls.count !== 0}
        />
        <Metric
          icon={Clock}
          label="Stuck orders"
          value={m ? fmtNumber(m.stuckCreatedOrders) : "—"}
          sub="created > 10m ago"
          warn={!!m && m.stuckCreatedOrders !== 0}
        />
        <Metric
          icon={Wallet}
          label="Pending deposits"
          value={m ? fmtNumber(m.pendingDeposits.count) : "—"}
          sub={m ? `oldest ${fmtAge(m.pendingDeposits.oldestAgeMs)}` : undefined}
          warn={!!m && m.pendingDeposits.count > 0}
        />
        <Metric
          icon={Wallet}
          label="Pending withdrawals"
          value={m ? fmtNumber(m.pendingWithdrawals.count) : "—"}
          sub={m ? `oldest ${fmtAge(m.pendingWithdrawals.oldestAgeMs)}` : undefined}
          warn={!!m && m.pendingWithdrawals.count > 0}
        />
      </div>

      {/* Drift detail — only when there is drift, because it is the serious one. */}
      {m && m.ledgerDrift.samples.length > 0 && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 mb-8">
          <div className="text-sm font-bold text-red-700 mb-2">Users whose balance does not match their ledger</div>
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-4">User</th>
                  <th className="py-1 pr-4">Balance</th>
                  <th className="py-1 pr-4">Ledger sum</th>
                  <th className="py-1">Diff</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {m.ledgerDrift.samples.map((s) => (
                  <tr key={s.uid} className="border-t border-red-200">
                    <td className="py-1 pr-4">{s.uid}</td>
                    <td className="py-1 pr-4">{fmtNumber(s.balance)}</td>
                    <td className="py-1 pr-4">{fmtNumber(s.ledger)}</td>
                    <td className={`py-1 font-bold ${s.diff > 0 ? "text-red-600" : "text-amber-700"}`}>
                      {s.diff > 0 ? "+" : ""}
                      {fmtNumber(s.diff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="mb-8" />

      {/* ---------------- Cron jobs ---------------- */}
      <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <Clock size={15} /> Scheduled jobs
      </h3>
      <div className="rounded-2xl border border-border bg-card overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground text-xs border-b border-border">
              <th className="px-4 py-2.5">Job</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Last run</th>
              <th className="px-4 py-2.5">Duration</th>
            </tr>
          </thead>
          <tbody>
            {crons.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground text-sm">
                  {health.isLoading ? "Loading…" : "No cron runs recorded yet."}
                </td>
              </tr>
            )}
            {crons.map((job) => {
              const bad = job.lastOk === false || job.stale;
              return (
                <tr key={job.job} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{job.job}</td>
                  <td className="px-4 py-2.5">
                    {job.lastRunAt == null ? (
                      <span className="text-xs text-muted-foreground">never run</span>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold ${
                          bad ? "text-red-600" : "text-green-600"
                        }`}
                      >
                        {bad ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
                        {job.stale ? "stale" : job.lastOk === false ? "failing" : "ok"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{job.lastRunAt ? fmtDateTime(job.lastRunAt) : "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {job.lastDurationMs != null ? `${job.lastDurationMs}ms` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ---------------- API errors ---------------- */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <ServerCrash size={15} /> API errors
            </h3>
            <div className="text-xs text-muted-foreground">
              <span className={`font-bold ${logStats.data && logStats.data.last24h > 0 ? "text-red-600" : "text-foreground"}`}>
                {logStats.data ? fmtNumber(logStats.data.last24h) : "—"}
              </span>{" "}
              in 24h · {logStats.data ? fmtNumber(logStats.data.total) : "—"} total
            </div>
          </div>
          {(recentErrors.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">No recent errors 🎉</div>
          ) : (
            <ul className="space-y-2">
              {(recentErrors.data ?? []).map((l: any) => (
                <li key={l.id} className="text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="font-mono">{l.status ?? "—"}</span>
                    <span className="font-mono text-foreground">{l.method} {l.path || "—"}</span>
                    <span className="ml-auto">{fmtDateTime(l.createdAt)}</span>
                  </div>
                  <div className="text-foreground mt-0.5 truncate">{l.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------------- Ops alerts ---------------- */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2 mb-3">
            <Bell size={15} /> Recent ops alerts
          </h3>
          {(alerts.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">No alerts.</div>
          ) : (
            <ul className="space-y-2">
              {(alerts.data ?? []).slice(0, 8).map((a: any) => (
                <li key={a.id} className="text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{a.title}</span>
                    <span className="ml-auto text-muted-foreground">{fmtDateTime(a.createdAt)}</span>
                  </div>
                  {a.message && <div className="text-muted-foreground mt-0.5">{a.message}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
