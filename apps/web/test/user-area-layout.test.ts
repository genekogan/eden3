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

  it("opens the notification panel inward from its right-side anchor", () => {
    expect(notificationCenterSource).toContain("absolute bottom-full right-0");
    expect(notificationCenterSource).not.toContain("absolute bottom-full left-0");
  });
});
