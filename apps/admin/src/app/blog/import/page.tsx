"use client";

import React, { useEffect, useState, useCallback } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";

interface Progress {
  startedAt?: number;
  total?: number;
  processed?: number;
  imported?: number;
  updated?: number;
  skipped?: number;
  duplicates?: number;
  failed?: number;
  missingImages?: number;
  currentUrl?: string;
  speedPerMin?: number;
  done?: boolean;
  updatedAt?: number;
}

interface LogRow {
  id: string;
  url: string;
  status: string;
  error?: string;
  imagesTotal?: number;
  imagesMissing?: number;
  attempts?: number;
  updatedAt: number;
}

const ImportDashboard = () => {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<{ byStatus: Record<string, number>; missingImages: number } | null>(null);
  const [failures, setFailures] = useState<LogRow[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);

  const refresh = useCallback(async () => {
    try {
      const [p, s, f] = await Promise.all([
        fetch("/api/blog/import/progress", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/blog/import/summary", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/blog/import/log?status=failed&limit=100", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setProgress(p || null);
      setSummary(s || null);
      setFailures(Array.isArray(f) ? f : []);
      setLastRefresh(Date.now());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const handleRetry = async () => {
    if (!confirm("Requeue all failed URLs? The importer must be running (or run again) to process them.")) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/blog/import/retry-failed", { method: "POST" });
      const data = await res.json();
      alert(`Requeued failed imports.${data.requeued != null ? ` (${data.requeued})` : ""}\nRe-run the importer to process them.`);
      refresh();
    } catch {
      alert("Failed to requeue.");
    } finally {
      setRetrying(false);
    }
  };

  const total = progress?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const running = progress && !progress.done && progress.updatedAt && Date.now() - progress.updatedAt < 15000;

  const Stat = ({ label, value, color = "text-black dark:text-white" }: { label: string; value: number | string; color?: string }) => (
    <div className="rounded-sm border border-stroke bg-white py-4 px-5 shadow-default dark:border-strokedark dark:bg-boxdark">
      <span className="text-sm text-gray-500">{label}</span>
      <h4 className={`mt-1 text-2xl font-bold ${color}`}>{value}</h4>
    </div>
  );

  const fmtTime = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString() : "—");

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Archive Import" />

      {/* Status banner */}
      <div className="mb-6 rounded-sm border border-stroke bg-white p-5 shadow-default dark:border-strokedark dark:bg-boxdark">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-block h-3 w-3 rounded-full ${
                running ? "animate-pulse bg-success" : progress?.done ? "bg-primary" : "bg-gray-400"
              }`}
            />
            <span className="font-medium text-black dark:text-white">
              {running ? "Import running…" : progress?.done ? "Import complete" : "Idle / no active import"}
            </span>
            {progress?.speedPerMin ? (
              <span className="text-sm text-gray-500">• {progress.speedPerMin} posts/min</span>
            ) : null}
          </div>
          <span className="text-xs text-gray-400">Auto-refreshing • last {fmtTime(lastRefresh)}</span>
        </div>

        {/* Progress bar */}
        <div className="mb-2 flex justify-between text-sm text-gray-500">
          <span>
            {processed} / {total} pages
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-gray-2 dark:bg-meta-4">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>

        {progress?.currentUrl && !progress.done && (
          <p className="mt-3 truncate text-xs text-gray-500">
            <span className="font-medium">Current:</span> {progress.currentUrl}
          </p>
        )}
      </div>

      {/* Counters */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Found" value={total} />
        <Stat label="Imported" value={progress?.imported ?? 0} color="text-success" />
        <Stat label="Updated" value={progress?.updated ?? 0} color="text-primary" />
        <Stat label="Skipped" value={progress?.skipped ?? 0} color="text-warning" />
        <Stat label="Duplicates" value={progress?.duplicates ?? 0} color="text-gray-500" />
        <Stat label="Failed" value={progress?.failed ?? summary?.byStatus?.failed ?? 0} color="text-danger" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Missing Images" value={progress?.missingImages ?? summary?.missingImages ?? 0} color="text-danger" />
        <Stat label="Logged: imported" value={summary?.byStatus?.imported ?? 0} color="text-success" />
        <Stat label="Logged: duplicate" value={summary?.byStatus?.duplicate ?? 0} />
        <Stat label="Logged: skipped" value={summary?.byStatus?.skipped ?? 0} />
      </div>

      {/* Failures + retry */}
      <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-4 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-black dark:text-white">Failed pages ({failures.length})</h3>
          <button
            onClick={handleRetry}
            disabled={retrying || failures.length === 0}
            className="rounded-md bg-danger py-2 px-5 text-sm font-medium text-white transition hover:bg-opacity-90 disabled:opacity-50"
          >
            {retrying ? "Requeuing…" : "↻ Retry Failed"}
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {failures.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">No failed pages. 🎉</p>
          ) : (
            <table className="w-full table-auto text-sm">
              <thead>
                <tr className="border-b border-stroke text-left dark:border-strokedark">
                  <th className="py-2 pr-4 font-medium text-black dark:text-white">URL</th>
                  <th className="py-2 pr-4 font-medium text-black dark:text-white">Error</th>
                  <th className="py-2 font-medium text-black dark:text-white">Tries</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((row) => (
                  <tr key={row.id} className="border-b border-[#eee] dark:border-strokedark">
                    <td className="max-w-xs truncate py-2 pr-4 text-primary" title={row.url}>
                      {row.url}
                    </td>
                    <td className="max-w-xs truncate py-2 pr-4 text-gray-500" title={row.error}>
                      {row.error || "—"}
                    </td>
                    <td className="py-2 text-gray-500">{row.attempts ?? 1}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* How to run */}
      <div className="mt-6 rounded-sm border border-stroke bg-gray-1 p-5 text-sm dark:border-strokedark dark:bg-meta-4">
        <p className="mb-2 font-medium text-black dark:text-white">Run the importer</p>
        <pre className="overflow-x-auto rounded bg-black/80 p-3 text-xs text-green-300">
{`cd scripts/archive-import && npm install
WORKER_URL=<your-worker-url> ADMIN_PROXY_SECRET=<secret> \\
  node import.mjs            # full run (resumable)
# node import.mjs --dry-run --limit=10   # preview
# node import.mjs --retry-failed          # after clicking Retry Failed`}
        </pre>
        <p className="mt-2 text-gray-500">
          This page live-updates from the running importer. Progress is safe to close and reopen.
        </p>
      </div>
    </DefaultLayout>
  );
};

export default ImportDashboard;
