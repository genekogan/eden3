"use client";

import { useEffect, useState } from "react";

/**
 * Tiny environment chip (ENV-1): shows which database the stack points at so
 * staging-mirror fixture data is never mistaken for the canonical prod fork.
 * Renders nothing on the canonical DB or when /health doesn't say.
 */
export function EnvChip({ className }: { className?: string }) {
  const [database, setDatabase] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { database?: string | null } | null) => {
        if (!cancelled) setDatabase(body?.database ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!database || database === "eden3") return null;
  const label = database === "eden3_stg" ? "staging db" : database;
  return (
    <span
      title={`Stack database: ${database}`}
      className={`rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300/90 ${className ?? ""}`}
    >
      {label}
    </span>
  );
}
