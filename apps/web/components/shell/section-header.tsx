"use client";

import React, { type ReactNode, useEffect, useId, useRef, useState } from "react";

function SectionHelp({
  title,
  summary,
}: {
  title: string;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const summaryId = useId();
  const triggerButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerButton}
        type="button"
        aria-label={`About ${title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="grid size-8 place-items-center rounded-lg text-faint transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <span
          aria-hidden
          className="grid size-4 place-items-center rounded-full border border-current font-mono text-[10px] leading-none"
        >
          ?
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-background/75 px-4 py-8 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={summaryId}
            className="w-full max-w-md rounded-xl border border-edge bg-raised p-5 shadow-2xl shadow-black/40"
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-soft">
                  About this section
                </p>
                <h2 id={titleId} className="mt-1 text-lg font-medium text-foreground">
                  {title}
                </h2>
              </div>
              <button
                ref={closeButton}
                type="button"
                aria-label="Close help"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-faint transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <span aria-hidden>✕</span>
              </button>
            </header>
            <p id={summaryId} className="mt-4 text-sm leading-relaxed text-muted">
              {summary}
            </p>
          </section>
        </div>
      ) : null}
    </>
  );
}

/** Compact, repeatable chrome for agent work areas. Agent identity already lives in the sidebar. */
export function SectionHeader({
  title,
  help,
  actions,
  sticky = false,
}: {
  title: string;
  help: string;
  actions?: ReactNode;
  sticky?: boolean;
}) {
  return (
    <header
      className={`flex h-16 shrink-0 items-center justify-between gap-4 border-b border-edge bg-background/95 px-5 backdrop-blur md:px-6 ${
        sticky ? "sticky top-0 z-20" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="truncate text-lg font-medium tracking-tight">{title}</h1>
        <SectionHelp title={title} summary={help} />
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
