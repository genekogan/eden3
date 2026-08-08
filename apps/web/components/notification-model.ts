import type { AppNotificationDto } from "@/lib/types";

export interface NotificationCenterState {
  items: AppNotificationDto[];
  unreadCount: number;
}

/** Monotonic fence for account-scoped async loads across direct A→B switches. */
export class NotificationLoadFence {
  private accountGeneration = 0;
  private requestGeneration = 0;

  beginAccount(): number {
    this.accountGeneration += 1;
    this.requestGeneration = 0;
    return this.accountGeneration;
  }

  currentAccount(): number {
    return this.accountGeneration;
  }

  beginRequest(accountGeneration: number): { account: number; request: number } | null {
    if (this.accountGeneration !== accountGeneration) return null;
    this.requestGeneration += 1;
    return { account: accountGeneration, request: this.requestGeneration };
  }

  invalidateAccount(accountGeneration: number): void {
    if (this.accountGeneration === accountGeneration) {
      this.accountGeneration += 1;
      this.requestGeneration = 0;
    }
  }

  isCurrent(token: { account: number; request: number }): boolean {
    return (
      this.accountGeneration === token.account && this.requestGeneration === token.request
    );
  }
}

export async function applyLatestNotificationLoad(
  fence: NotificationLoadFence,
  token: { account: number; request: number },
  load: () => Promise<NotificationCenterState>,
  apply: (state: NotificationCenterState) => void,
): Promise<void> {
  const state = await load();
  if (fence.isCurrent(token)) apply(state);
}

export function notificationCopy(item: AppNotificationDto): string {
  switch (item.kind) {
    case "agent_build_ready":
      return `@${item.sourceAgent.username} is ready`;
    case "agent_build_failed":
      return `@${item.sourceAgent.username} could not be built`;
    case "scheduled_task_completed":
      return `@${item.sourceAgent.username} completed a scheduled task`;
  }
}

export function markNotificationRead(
  state: NotificationCenterState,
  id: string,
  readAt: string,
): NotificationCenterState {
  const target = state.items.find((item) => item.id === id);
  if (!target || target.readAt !== null) return state;
  return {
    items: state.items.map((item) => (item.id === id ? { ...item, readAt } : item)),
    unreadCount: Math.max(0, state.unreadCount - 1),
  };
}

export function markEveryNotificationRead(
  state: NotificationCenterState,
  readAt: string,
): NotificationCenterState {
  return {
    items: state.items.map((item) => ({ ...item, readAt: item.readAt ?? readAt })),
    unreadCount: 0,
  };
}

export function dismissNotification(
  state: NotificationCenterState,
  id: string,
): NotificationCenterState {
  const target = state.items.find((item) => item.id === id);
  if (!target) return state;
  return {
    items: state.items.filter((item) => item.id !== id),
    unreadCount: target.readAt === null ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
  };
}
