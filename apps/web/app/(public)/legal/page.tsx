import type { Metadata } from "next";
import Link from "next/link";
import React from "react";

import { legalDocuments } from "./_content";
import { LegalNav } from "./_document";

export const metadata: Metadata = {
  title: "Legal drafts",
  description: "Pre-live draft legal documents for Eden's closed test cohort.",
  alternates: { canonical: "/legal" },
  robots: { index: false, follow: true },
};

export default function LegalIndexPage() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-5 py-10 md:px-8 md:py-14">
      <LegalNav />
      <header className="mt-10 border-b border-edge pb-8">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-warning">
          Pre-live drafts · not effective
        </p>
        <h1 className="mt-3 text-3xl font-light tracking-tight">Eden legal review pack</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">
          These working documents describe a closed, invitation-only test service. They are not
          legal advice, are not approved terms, and do not open public signup or live payments.
        </p>
      </header>

      <section aria-label="Draft legal documents" className="grid gap-4 py-10 sm:grid-cols-2">
        {legalDocuments.map((document) => (
          <Link
            key={document.slug}
            href={`/legal/${document.slug}`}
            className="rounded-2xl border border-edge bg-surface p-5 transition-colors hover:border-accent/40"
          >
            <h2 className="font-medium">{document.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{document.summary}</p>
            <p className="mt-4 font-mono text-[11px] uppercase tracking-wide text-faint">
              Draft · review required
            </p>
          </Link>
        ))}
      </section>

      <aside className="rounded-2xl border border-warning/30 bg-warning/5 p-5 text-sm leading-6 text-muted">
        Legal sign-off is still required for operator identity, age posture, adult content,
        subprocessors, retention, consumer rights, dispute terms, copyright agent details, and
        launch acceptance.
      </aside>
    </main>
  );
}
