import { describe, expect, it } from "vitest";

import {
  applyLatestNotificationLoad,
  dismissNotification,
  markEveryNotificationRead,
  markNotificationRead,
  NotificationLoadFence,
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

  it("derives scheduled-completion copy without exposing prompt or transcript content", () => {
    const completed: AppNotificationDto = {
      ...ready,
      kind: "scheduled_task_completed",
      targetPath: "/sessions/33333333-3333-4333-8333-333333333333",
    };
    expect(notificationCopy(completed)).toBe(
      "@small-moon completed a scheduled task",
    );
    expect(notificationCopy(completed)).not.toContain("prompt");
    expect(completed.targetPath).toBe(
      "/sessions/33333333-3333-4333-8333-333333333333",
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

  it("rejects a delayed tenant A load after fast tenant B becomes current", async () => {
    const fence = new NotificationLoadFence();
    let releaseA!: (state: { items: AppNotificationDto[]; unreadCount: number }) => void;
    const delayedA = new Promise<{ items: AppNotificationDto[]; unreadCount: number }>(
      (resolve) => {
        releaseA = resolve;
      },
    );
    const applied: string[][] = [];
    const aGeneration = fence.beginAccount();
    const aToken = fence.beginRequest(aGeneration)!;
    const aLoad = applyLatestNotificationLoad(
      fence,
      aToken,
      () => delayedA,
      (state) => applied.push(state.items.map((item) => item.sourceAgent.username)),
    );

    fence.invalidateAccount(aGeneration);
    const bGeneration = fence.beginAccount();
    const bToken = fence.beginRequest(bGeneration)!;
    await applyLatestNotificationLoad(
      fence,
      bToken,
      async () => ({
        items: [{ ...ready, sourceAgent: { ...ready.sourceAgent, username: "tenant-b" } }],
        unreadCount: 1,
      }),
      (state) => applied.push(state.items.map((item) => item.sourceAgent.username)),
    );
    releaseA({ items: [ready], unreadCount: 1 });
    await aLoad;
    expect(applied).toEqual([["tenant-b"]]);
  });

  it("rejects an older same-tenant snapshot that resolves after a newer one", async () => {
    const fence = new NotificationLoadFence();
    const account = fence.beginAccount();
    let releaseOld!: (state: { items: AppNotificationDto[]; unreadCount: number }) => void;
    const oldResponse = new Promise<{ items: AppNotificationDto[]; unreadCount: number }>(
      (resolve) => {
        releaseOld = resolve;
      },
    );
    const applied: number[] = [];
    const oldLoad = applyLatestNotificationLoad(
      fence,
      fence.beginRequest(account)!,
      () => oldResponse,
      (state) => applied.push(state.unreadCount),
    );
    await applyLatestNotificationLoad(
      fence,
      fence.beginRequest(account)!,
      async () => ({ items: [ready], unreadCount: 1 }),
      (state) => applied.push(state.unreadCount),
    );
    releaseOld({ items: [], unreadCount: 0 });
    await oldLoad;
    expect(applied).toEqual([1]);
  });
});
