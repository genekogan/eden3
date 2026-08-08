import type { Metadata } from "next";
import React from "react";

import { legalDocument } from "../_content";
import { LegalDocumentPage } from "../_document";

export const metadata: Metadata = {
  title: "Draft Content and Copyright Policy",
  description: "Pre-live draft content, reporting, and copyright rules for Eden.",
  alternates: { canonical: "/legal/content" },
  robots: { index: false, follow: true },
};

export default function ContentPolicyPage() {
  return <LegalDocumentPage document={legalDocument("content")} />;
}
