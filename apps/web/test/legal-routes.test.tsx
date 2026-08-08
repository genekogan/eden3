import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import CookieNoticePage from "../app/(public)/legal/cookies/page";
import ContentPolicyPage from "../app/(public)/legal/content/page";
import { legalDocument, legalDocuments } from "../app/(public)/legal/_content";
import LegalIndexPage from "../app/(public)/legal/page";
import PrivacyPage from "../app/(public)/legal/privacy/page";
import TermsPage from "../app/(public)/legal/terms/page";
import { isPublicLegalPath, isPublicRoutePath, isPublicSharePath } from "../lib/public-routes";

const rendered = [
  renderToStaticMarkup(<LegalIndexPage />),
  renderToStaticMarkup(<TermsPage />),
  renderToStaticMarkup(<PrivacyPage />),
  renderToStaticMarkup(<ContentPolicyPage />),
  renderToStaticMarkup(<CookieNoticePage />),
];

const routeText = rendered.join("\n");

describe("pre-live legal routes", () => {
  it("publicly admits only the exact static legal routes", () => {
    for (const path of [
      "/legal",
      "/legal/",
      "/legal/terms",
      "/legal/privacy/",
      "/legal/content",
      "/legal/cookies",
    ]) {
      expect(isPublicLegalPath(path), path).toBe(true);
      expect(isPublicRoutePath(path), path).toBe(true);
    }

    for (const path of [
      "/legalish",
      "/legal/unknown",
      "/legal/terms/accept",
      "/LEGAL",
      "/api/legal",
    ]) {
      expect(isPublicLegalPath(path), path).toBe(false);
      expect(isPublicRoutePath(path), path).toBe(false);
    }

    expect(isPublicSharePath("/share/opaque-value")).toBe(true);
    expect(isPublicRoutePath("/share/opaque-value")).toBe(true);
  });

  it("renders every document with visible draft and pre-live warnings", () => {
    expect(rendered).toHaveLength(5);
    for (const html of rendered) {
      expect(html).toMatch(/pre-live draft/i);
      expect(html).toMatch(/not effective/i);
      expect(html).not.toContain("[object Object]");
    }
    expect(legalDocuments.map((document) => document.slug)).toEqual([
      "terms",
      "privacy",
      "content",
      "cookies",
    ]);
  });

  it("contains the required product, privacy, safety, and consent disclosures", () => {
    for (const heading of [
      "Closed cohort and test mode",
      "Your content and permissions",
      "AI and third-party services",
      "Information we expect to handle",
      "Retention",
      "Access, export, correction, and deletion",
      "Provisional adult-content posture",
      "Copyright notice procedure",
      "Storage categories",
      "Choices and consent",
    ]) {
      expect(routeText).toContain(heading);
    }
    expect(routeText).toMatch(/no public signup offer/i);
    expect(routeText).toMatch(/test instruments only/i);
    expect(routeText).toMatch(/not money, stored value, cryptocurrency/i);
    expect(routeText).toMatch(/DMCA AGENT.*REQUIRED/i);
  });

  it("keeps navigation internal, exact, and free of acceptance actions", () => {
    const hrefs = [...routeText.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(hrefs)).toEqual(
      new Set(["/legal", "/legal/terms", "/legal/privacy", "/legal/content", "/legal/cookies"]),
    );
    expect(routeText).not.toMatch(
      /accept (?:these )?terms|sign up now|buy manna|checkout now|enforce these drafts/i,
    );
  });

  it("keeps the test-enforcement clause non-operative and aligned with the long-form Terms", () => {
    const root = resolve(process.cwd(), "../..");
    const longFormTerms = readFileSync(resolve(root, "docs/legal/TERMS-DRAFT.md"), "utf8");
    const webTerms = legalDocument("terms").sections
      .flatMap((section) => section.paragraphs ?? [])
      .join("\n");

    expect(longFormTerms).toContain("enforce an approved policy");
    expect(webTerms).toContain("enforce an approved policy");
    expect(`${longFormTerms}\n${webTerms}`).not.toMatch(
      /enforce these drafts|these terms (?:are|become) effective|by using .*agree to (?:these|the) terms/i,
    );
  });

  it("does not disclose internal topology, secrets, or unsupported compliance claims", () => {
    const denylist = [
      /OPENCLAW_GATEWAY_TOKEN/i,
      /ANTHROPIC_API_KEY/i,
      /DATABASE_URL/i,
      /127\.0\.0\.1/,
      /postgres(?:ql)?:\/\//i,
      /mongodb(?:\+srv)?:\/\//i,
      /Bearer\s+[A-Za-z0-9._-]+/,
      /SOC\s*2 certified/i,
      /GDPR compliant/i,
      /CCPA compliant/i,
      /guaranteed secure/i,
      /DMCA safe harbor protected/i,
    ];
    for (const denied of denylist) expect(routeText).not.toMatch(denied);
  });

  it("ships matching draft documents and a counsel decision register", () => {
    const root = resolve(process.cwd(), "../..");
    const paths = [
      "docs/legal/TERMS-DRAFT.md",
      "docs/legal/PRIVACY-DRAFT.md",
      "docs/legal/CONTENT-DMCA-DRAFT.md",
      "docs/legal/COOKIES-DRAFT.md",
      "docs/legal/SOURCES.md",
      "docs/LEGAL-QUESTIONS.md",
    ];
    const files = paths.map((path) => readFileSync(resolve(root, path), "utf8"));

    for (const content of files.slice(0, 4)) {
      expect(content).toMatch(/PRE-LIVE.*NOT EFFECTIVE/i);
      expect(content).toMatch(/Requires .*legal-counsel approval/i);
    }
    expect(files.at(-1)).toMatch(/Adult and sensitive content/);
    expect(files.at(-1)).toMatch(/Providers, subprocessors, and international transfers/);
    expect(files.at(-1)).toMatch(/DMCA and other rights reports/);
    expect(files.join("\n")).not.toMatch(/(?:sk_live|sk_test|xox[baprs]-|ghp_)[A-Za-z0-9_-]+/);
  });
});
