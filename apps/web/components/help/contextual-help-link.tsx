"use client";

import React, { useEffect, useId, useRef, useState } from "react";

import { HELP_ARTICLES, type HelpArticleId } from "@/lib/help-content";

export function ContextualHelpLink({
  topic,
  children = "Learn how",
  className,
}: {
  topic: HelpArticleId;
  children?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const article = HELP_ARTICLES.find((candidate) => candidate.id === topic);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!article) return null;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={
          className ??
          "inline-flex min-h-11 items-center rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        }
      >
        {children}
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto bg-background/75 px-4 py-8 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-lg rounded-xl border border-edge bg-raised p-5 text-left shadow-2xl shadow-black/40"
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-soft">
                  Quick help
                </p>
                <h2 id={titleId} className="mt-1 text-lg font-medium text-foreground">
                  {article.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {article.summary}
                </p>
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

            <ol className="mt-5 space-y-3">
              {article.steps.map((step, index) => (
                <li key={step} className="flex gap-3 text-sm leading-relaxed text-foreground">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/10 font-mono text-[10px] text-accent-soft">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            {article.notes.length > 0 ? (
              <div className="mt-5 rounded-lg border border-edge bg-surface px-4 py-3">
                {article.notes.map((note) => (
                  <p key={note} className="text-xs leading-relaxed text-muted not-first:mt-2">
                    {note}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Got it
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
