import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContentReportQueueItem } from "@/components/operator/content-reports-panel";
import type { ContentReportDto } from "@/lib/types";

function report(overrides: Partial<ContentReportDto> = {}): ContentReportDto {
  return {
    id: "019797a8-2b2e-7bbb-8f2a-111111111111",
    targetType: "creation",
    targetId: "019797a8-2b2e-7bbb-8f2a-222222222222",
    reason: "review me",
    status: "open",
    reporter: {
      id: "019797a8-2b2e-7bbb-8f2a-333333333333",
      username: "viewer",
    },
    reviewerId: null,
    reviewedAt: null,
    createdAt: "2026-08-08T12:00:00.000Z",
    targetExists: true,
    targetPublic: true,
    targetDeleted: false,
    ...overrides,
  };
}

function renderRow(value: ContentReportDto): string {
  return renderToStaticMarkup(
    <ContentReportQueueItem report={value} acting={false} onDecide={() => undefined} />,
  );
}

describe("operator content report actions", () => {
  it("renders review and takedown only for an existing public undeleted creation", () => {
    const html = renderRow(report());
    expect(html).toContain("Review target");
    expect(html).toContain("Take down");
    expect(html).toContain("Dismiss");
  });

  it.each([
    [
      "unsupported",
      { targetType: "agent", targetExists: false, targetPublic: null, targetDeleted: null },
    ],
    ["private", { targetPublic: false }],
    ["deleted", { targetDeleted: true }],
    ["missing", { targetExists: false, targetPublic: null, targetDeleted: null }],
  ])("renders dismiss alone for a %s target", (_label, overrides) => {
    const html = renderRow(report(overrides));
    expect(html).not.toContain("Review target");
    expect(html).not.toContain("Take down");
    expect(html).toContain("Dismiss");
  });
});
