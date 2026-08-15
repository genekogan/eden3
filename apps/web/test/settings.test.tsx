import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSummary } from "../app/account/account-client";

describe("settings page", () => {
  it("renders account identity and manna state", () => {
    const html = renderToStaticMarkup(
      <SettingsSummary
        data={{
          user: {
            id: "acct-123",
            username: "gene",
            type: "user",
            userImage: null,
            isAdmin: true,
          },
          manna: { balance: 1200, subscriptionBalance: 300 },
          subscription: {
            status: "active",
            tier: "pro",
            monthlyManna: 9000,
            currentPeriodEnd: "2026-08-01T00:00:00.000Z",
            cancelAtPeriodEnd: true,
            updatedAt: "2026-07-07T00:00:00.000Z",
          },
        }}
      />,
    );

    expect(html).toContain("@gene");
    expect(html).toContain("Add photo");
    expect(html).toContain("sign-in photo is imported automatically");
    expect(html).toContain("acct-123");
    expect(html).toContain("Admin access");
    expect(html).toContain("Enabled");
    expect(html).toContain("1,500");
    expect(html).toContain("Subscription");
    expect(html).toContain("Pro");
    expect(html).toContain("9,000");
    expect(html).toContain("Cancellation is scheduled");
    expect(html).toContain("Manage manna");
    expect(html).toContain("Your data");
    expect(html).toContain("Download account data");
    expect(html).toContain("all retained conversations");
    // Cross-user surfaces are purged from the cockpit — no favorites link.
    expect(html).not.toContain("Browse favorites");
    expect(html).not.toContain("/explore");
  });

  it("renders a signed-out local state", () => {
    const html = renderToStaticMarkup(
      <SettingsSummary data={{ user: null, manna: null, subscription: null }} />,
    );

    expect(html).toContain("No account selected");
  });
});
