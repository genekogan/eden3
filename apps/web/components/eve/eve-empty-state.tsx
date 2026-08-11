import Link from "next/link";
import React from "react";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";
import { ContextualHelpLink } from "@/components/help/contextual-help-link";

export function EveEmptyState() {
  return (
    <section
      aria-labelledby="eve-empty-title"
      data-testid="eve-empty-state"
      className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-edge px-6 py-10 text-center"
    >
      <span
        aria-hidden
        className="grid size-12 place-items-center rounded-full border border-accent/30 bg-accent/10 font-mono text-lg text-accent-soft"
      >
        e
      </span>
      <h2 id="eve-empty-title" className="mt-4 text-base font-medium text-foreground">
        Start with eve
      </h2>
      <p className="mt-1 font-mono text-xs text-accent-soft">@eve</p>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        Eve can help you find your way around Eden, or send you straight to the
        builder when you’re ready for an agent of your own.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/agents/eve/chats/new" className={quietButtonClass}>
          Chat with eve
        </Link>
        <Link href="/agents/builder" className={primaryButtonClass}>
          Make me my own agent
        </Link>
      </div>
      <Link
        href="/agents/new"
        className="mt-4 text-xs text-faint underline-offset-4 hover:text-muted hover:underline"
      >
        Or start from a template
      </Link>
      <ContextualHelpLink
        topic="choose-agent"
        className="mt-3 text-xs text-faint underline-offset-4 hover:text-muted hover:underline"
      >
        Agent setup help
      </ContextualHelpLink>
    </section>
  );
}
