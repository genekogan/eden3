import Link from "next/link";
import React from "react";
import {
  doctrineSyncStateLabel,
  type DoctrineFileOwnership,
  type DoctrineSyncState,
} from "@/lib/doctrine-file-ownership";

export function DoctrineOwnershipNotice({
  ownership,
  syncState,
  revision,
}: {
  ownership: DoctrineFileOwnership;
  syncState?: DoctrineSyncState;
  revision?: number;
}) {
  return (
    <div
      data-doctrine-file={ownership.file}
      data-doctrine-ownership={ownership.kind}
      className="rounded-lg border border-edge bg-surface px-3 py-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-medium text-accent-soft">
          {ownership.badge}
        </span>
        {syncState ? (
          <span
            role="status"
            className={syncState === "conflict" ? "text-warning-soft" : "text-muted"}
          >
            {doctrineSyncStateLabel(syncState)}
          </span>
        ) : null}
        {revision !== undefined ? (
          <span className="font-mono text-faint">Revision {revision}</span>
        ) : null}
      </div>
      <p className="mt-2 leading-relaxed text-faint">{ownership.detail}</p>
      {ownership.settingsLinks.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {ownership.settingsLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-accent-soft transition-colors hover:text-accent"
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
