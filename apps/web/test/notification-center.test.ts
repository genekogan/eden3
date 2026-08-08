import { describe, expect, it } from "vitest";

import {
  dismissNotification,
  markEveryNotificationRead,
  markNotificationRead,
  notificationCopy,
} from "../components/notification-model";
import type { AppNotificationDto } from "../lib/types";

const ready: AppNotificationDto = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "agent_build_ready",
  sourceAgent: {
    id: "22222222-2222-4222-8222-222222222222",
    type: "agent",
    username: "small-moon",
    userImage: null,
  },
  targetPath: "/agents/small-moon",
  readAt: null,
  createdAt: "2026-08-08T12:00:00.000Z",
};

describe("notification center model", () => {
  it("derives safe copy from typed build events", () => {
    expect(notificationCopy(ready)).toBe("@small-moon is ready");
    expect(notificationCopy({ ...ready, kind: "agent_build_failed" })).toBe(
      "@small-moon could not be built",
    );
  });

  it("marks a notification once without underflowing unread count", () => {
    const first = markNotificationRead(
      { items: [ready], unreadCount: 1 },
      ready.id,
      "2026-08-08T12:01:00.000Z",
    );
    expect(first.unreadCount).toBe(0);
    expect(first.items[0]?.readAt).toBe("2026-08-08T12:01:00.000Z");
    expect(markNotificationRead(first, ready.id, "2026-08-08T12:02:00.000Z")).toBe(first);
  });

  it("marks all and dismisses unread/read items consistently", () => {
    const second = { ...ready, id: "33333333-3333-4333-8333-333333333333" };
    const all = markEveryNotificationRead(
      { items: [ready, second], unreadCount: 2 },
      "2026-08-08T12:01:00.000Z",
    );
    expect(all.unreadCount).toBe(0);
    expect(all.items.every((item) => item.readAt !== null)).toBe(true);
    expect(dismissNotification(all, ready.id)).toEqual({
      items: [all.items[1]],
      unreadCount: 0,
    });
  });
});
