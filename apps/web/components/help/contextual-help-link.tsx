import Link from "next/link";
import React from "react";

import { helpHref, type HelpArticleId } from "@/lib/help-content";

export function ContextualHelpLink({
  topic,
  children = "Learn how",
  className,
}: {
  topic: HelpArticleId;
  children?: string;
  className?: string;
}) {
  return (
    <Link
      href={helpHref(topic)}
      className={
        className ??
        "inline-flex min-h-11 items-center rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
      }
    >
      {children}
    </Link>
  );
}
