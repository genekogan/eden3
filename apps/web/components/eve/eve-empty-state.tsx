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

export function EveSidebarEntry({
  onNavigate,
  labelsAlways = false,
}: {
  onNavigate?: () => void;
  labelsAlways?: boolean;
}) {
  return (
    <div
      data-testid="eve-sidebar-entry"
      className="mt-4 rounded-xl border border-dashed border-edge px-2 py-3 text-center lg:px-3"
    >
      <Link
        href="/agents/eve/chats/new"
        onClick={onNavigate}
        title="Chat with @eve"
        className="flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground transition-colors hover:bg-foreground/[0.04]"
      >
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-accent/12 font-mono text-xs text-accent-soft"
        >
          e
        </span>
        <span
          className={`${labelsAlways ? "block" : "hidden lg:block"} min-w-0 text-left`}
        >
          <span className="block leading-tight">eve</span>
          <span className="block font-mono text-[10px] text-faint">@eve</span>
        </span>
      </Link>
      <Link
        href="/agents/builder"
        onClick={onNavigate}
        title="Make me my own agent"
        className="mt-2 inline-flex rounded-lg border border-accent/35 px-2 py-1.5 text-[11px] text-accent-soft transition-colors hover:bg-accent/10"
      >
        <span className={labelsAlways ? "inline" : "hidden lg:inline"}>
          Make me my own agent
        </span>
        {labelsAlways ? null : (
          <span aria-hidden className="lg:hidden">+</span>
        )}
      </Link>
    </div>
  );
}
