"use client";

import Link from "next/link";
import React, { useState } from "react";

import { resolveHelpAction, searchHelpArticles } from "@/lib/help-content";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function HelpSearch({
  selectedAgentUsername,
  initialQuery = "",
}: {
  selectedAgentUsername?: string | null;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const results = searchHelpArticles(query);

  return (
    <div>
      <form role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="help-search" className="text-sm font-medium text-foreground">
          Search help
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="help-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            maxLength={120}
            placeholder="Try “upload”, “quote”, or “Discord”"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-edge bg-surface px-3.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="min-h-11 rounded-xl border border-edge px-3.5 py-2 text-sm text-muted hover:text-foreground"
            >
              Clear
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-faint">
          Search stays in this browser. Queries are not sent to Eden or another service.
        </p>
      </form>

      <p role="status" aria-live="polite" className="mt-8 font-mono text-xs text-faint">
        {results.length} {results.length === 1 ? "guide" : "guides"}
        {query.trim() ? ` matching “${query.trim()}”` : " for your first hour"}
      </p>

      {results.length === 0 ? (
        <div
          className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-edge px-6 py-10 text-center"
        >
          <h2 className="text-base font-medium text-foreground">
            No help guide matches that search
          </h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted">
            Try a task name such as agent, chat, manna, upload, channel, or error.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-5 min-h-11 rounded-lg border border-edge px-3.5 py-2 text-sm text-muted hover:text-foreground"
          >
            Show all guides
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {results.map((article) => {
            const action = resolveHelpAction(article, selectedAgentUsername);
            return (
              <article
                key={article.id}
                id={article.id}
                tabIndex={-1}
                aria-labelledby={`${article.id}-title`}
                className="scroll-mt-6 rounded-2xl border border-edge bg-surface p-5 md:p-6"
              >
                <h2 id={`${article.id}-title`} className="text-xl font-medium tracking-tight">
                  {article.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted">{article.summary}</p>
                <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted">
                  {article.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <div className="mt-5 space-y-2 rounded-xl bg-raised px-4 py-3">
                  {article.notes.map((note) => (
                    <p key={note} className="text-xs leading-5 text-faint">
                      {note}
                    </p>
                  ))}
                </div>
                <Link
                  href={action.href}
                  className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-sm text-accent-soft hover:bg-accent/15"
                >
                  {action.label}
                </Link>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function HelpCenter() {
  const { username } = useSelectedAgent();
  return <HelpSearch selectedAgentUsername={username} />;
}
