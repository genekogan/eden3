import Link from "next/link";
import React from "react";

import type { LegalDocument } from "./_content";

const links = [
  ["Terms", "/legal/terms"],
  ["Privacy", "/legal/privacy"],
  ["Content & copyright", "/legal/content"],
  ["Cookies", "/legal/cookies"],
] as const;

export function LegalNav() {
  return (
    <nav aria-label="Legal documents" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      <Link href="/legal" className="text-accent hover:underline">
        Legal drafts
      </Link>
      {links.map(([label, href]) => (
        <Link key={href} href={href} className="text-muted hover:text-foreground hover:underline">
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-5 py-10 md:px-8 md:py-14">
      <LegalNav />
      <header className="mt-10 border-b border-edge pb-8">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-warning">
          Pre-live draft · not effective
        </p>
        <h1 className="mt-3 text-3xl font-light tracking-tight">{document.title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{document.summary}</p>
        <p className="mt-4 font-mono text-xs text-faint">{document.version}</p>
      </header>

      <div className="space-y-10 py-10">
        {document.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-xl font-medium tracking-tight">{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph} className="mt-3 text-sm leading-7 text-muted">
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-muted">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      <footer className="border-t border-edge pt-6 text-xs leading-5 text-faint">
        Draft for legal and operator review. Do not treat this page as an effective agreement or
        representation of legal compliance.
      </footer>
    </main>
  );
}
