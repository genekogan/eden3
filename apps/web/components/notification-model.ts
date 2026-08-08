import type { AppNotificationDto } from "@/lib/types";

export interface NotificationCenterState {
  items: AppNotificationDto[];
  unreadCount: number;
}

export function notificationCopy(item: AppNotificationDto): string {
  return item.kind === "agent_build_ready"
    ? `@${item.sourceAgent.username} is ready`
    : `@${item.sourceAgent.username} could not be built`;
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
