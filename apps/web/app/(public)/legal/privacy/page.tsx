import type { Metadata } from "next";
import React from "react";

import { legalDocument } from "../_content";
import { LegalDocumentPage } from "../_document";

export const metadata: Metadata = {
  title: "Draft Privacy Policy",
  description: "Pre-live draft privacy disclosures for Eden's closed test cohort.",
  alternates: { canonical: "/legal/privacy" },
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return <LegalDocumentPage document={legalDocument("privacy")} />;
}
