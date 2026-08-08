import type { Metadata } from "next";
import React from "react";

import { legalDocument } from "../_content";
import { LegalDocumentPage } from "../_document";

export const metadata: Metadata = {
  title: "Draft Cookie and Local Storage Notice",
  description: "Pre-live draft browser-storage and consent posture for Eden.",
  alternates: { canonical: "/legal/cookies" },
  robots: { index: false, follow: true },
};

export default function CookieNoticePage() {
  return <LegalDocumentPage document={legalDocument("cookies")} />;
}
