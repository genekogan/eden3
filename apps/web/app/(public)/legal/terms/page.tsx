import type { Metadata } from "next";
import React from "react";

import { legalDocument } from "../_content";
import { LegalDocumentPage } from "../_document";

export const metadata: Metadata = {
  title: "Draft Terms of Service",
  description: "Pre-live draft terms for Eden's closed test cohort.",
  alternates: { canonical: "/legal/terms" },
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  return <LegalDocumentPage document={legalDocument("terms")} />;
}
