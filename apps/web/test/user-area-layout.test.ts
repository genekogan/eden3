import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const userAreaSource = readFileSync(
  new URL("../components/shell/user-area.tsx", import.meta.url),
  "utf8",
);
const notificationCenterSource = readFileSync(
  new URL("../components/notification-center.tsx", import.meta.url),
  "utf8",
);

describe("sidebar account footer layout", () => {
  it("places notifications after the account control on the right", () => {
    const footerStart = userAreaSource.indexOf(
      '<div className={`flex items-center ${collapsed ? "flex-col" : ""}`}>',
    );
    const accountControl = userAreaSource.indexOf('data-testid="user-area"', footerStart);
    const notificationControl = userAreaSource.indexOf("<NotificationCenter", footerStart);

    expect(footerStart).toBeGreaterThanOrEqual(0);
    expect(accountControl).toBeGreaterThan(footerStart);
    expect(notificationControl).toBeGreaterThan(accountControl);
  });

  it("keeps the notification panel inside the viewport at narrow and desktop widths", () => {
    expect(notificationCenterSource).toContain("fixed bottom-14 left-2");
    expect(notificationCenterSource).toContain("max-h-[calc(100vh-4rem)]");
    expect(notificationCenterSource).toContain("w-[min(21rem,calc(100vw-1rem))]");
    expect(notificationCenterSource).toContain("sm:absolute sm:bottom-full sm:left-0");
    expect(notificationCenterSource).not.toContain("bottom-full right-0");
  });

  it("uses a compact unread dot without tinting whole notification rows", () => {
    expect(notificationCenterSource).toContain('aria-label="Unread"');
    expect(notificationCenterSource).toContain("rounded-full bg-accent");
    expect(notificationCenterSource).not.toContain('item.readAt === null ? "bg-accent');
    expect(notificationCenterSource).toContain("focus-visible:ring-accent/50");
  });

  it("paints an opaque isolated notification surface above the conversation rail", () => {
    expect(notificationCenterSource).toContain('backgroundColor: "var(--color-raised)"');
    expect(notificationCenterSource).toContain('isolation: "isolate"');
    expect(notificationCenterSource).toContain("z-[100]");
    expect(notificationCenterSource).toContain("divide-y divide-edge/50");
    expect(notificationCenterSource).toContain("min-h-12");
  });
});
