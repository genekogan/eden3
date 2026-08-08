"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ContentReportDto } from "@/lib/types";

export function ContentReportsPanel() {
  const [reports, setReports] = useState<ContentReportDto[] | null>(null);
  const [error, setError] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.operator.contentReports({ status: "open", limit: 50 });
      setReports(data.reports);
      setError(false);
    } catch {
      setReports(null);
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(report: ContentReportDto, decision: "takedown" | "dismiss") {
    setActing(report.id);
    setError(false);
    try {
      await api.operator.resolveContentReport(report.id, decision);
      setReports((current) => current?.filter((row) => row.id !== report.id) ?? null);
    } catch {
      setError(true);
    } finally {
      setActing(null);
    }
  }

  return (
    <section aria-labelledby="content-reports-heading" className="rounded-lg border border-edge bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <div>
          <h2 id="content-reports-heading" className="text-sm font-medium">Content reports</h2>
          <p className="mt-0.5 text-xs text-faint">Open reports from the closed cohort.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-11 rounded-md px-3 text-xs text-muted hover:text-foreground"
        >
          Refresh
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-4 py-4 text-sm text-danger">
          The report queue could not be loaded or updated.
        </p>
      ) : reports === null ? (
        <p className="px-4 py-6 text-sm text-muted">Loading reports…</p>
      ) : reports.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No open reports.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {reports.map((report) => (
            <li key={report.id} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    @{report.reporter.username}: {report.reason || "No reason supplied"}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-faint">
                    {report.targetType} · {report.targetId}
                  </p>
                </div>
                {report.target.exists && !report.target.deleted ? (
                  <Link
                    href={`/creations/${encodeURIComponent(report.targetId)}`}
                    className="min-h-11 px-2 py-3 text-xs text-accent-soft hover:underline"
                  >
                    Review target
                  </Link>
                ) : (
                  <span className="px-2 py-3 text-xs text-faint">Target unavailable</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={acting === report.id}
                  onClick={() => void decide(report, "takedown")}
                  className="min-h-11 rounded-md border border-danger/40 px-3.5 py-2 text-xs text-danger disabled:opacity-50"
                >
                  Take down
                </button>
                <button
                  type="button"
                  disabled={acting === report.id}
                  onClick={() => void decide(report, "dismiss")}
                  className="min-h-11 rounded-md border border-edge px-3.5 py-2 text-xs text-muted disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
