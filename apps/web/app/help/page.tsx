import type { Metadata } from "next";
import React from "react";

import { HelpCenter } from "@/components/help/help-search";

export const metadata: Metadata = {
  title: "Help",
  description: "Closed-cohort help for Eden's core first-hour tasks.",
};

export default function HelpPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10 md:px-10 md:py-14">
      <header className="border-b border-edge pb-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-accent-soft">
          Closed-cohort help
        </p>
        <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Get oriented in Eden</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">
          Complete one useful task without guessing. Eden is still an invitation-only test: there
          is no public signup, Manna and checkout are test mode, and provider-dependent features
          may be unavailable.
        </p>
      </header>
      <div className="mt-8">
        <HelpCenter />
      </div>
    </div>
  );
}
