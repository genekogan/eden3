import { randomUUID } from 'node:crypto';

import { pg } from '@eden3/db';
import type {
  AppNotificationDto,
  AppNotificationKind,
  AppNotificationsResponseDto,
} from '@eden3/shared';

import type { EventsBus } from '../events-bus';

export const notificationChannel = (accountId: string): string => `account:${accountId}`;

export interface AppNotificationStore {
  list(accountId: string, limit: number): Promise<AppNotificationsResponseDto>;
  markRead(accountId: string, id: string): Promise<boolean>;
  markAllRead(accountId: string): Promise<number>;
  dismiss(accountId: string, id: string): Promise<boolean>;
}

interface NotificationRow {
  id: string;
  kind: AppNotificationKind;
  target_path: string | null;
  read_at: Date | null;
  created_at: Date;
  source_id: string;
  source_type: 'agent';
  source_username: string;
  source_image: string | null;
}

function toDto(row: NotificationRow): AppNotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    sourceAgent: {
      id: row.source_id,
      type: row.source_type,
      username: row.source_username,
      userImage: row.source_image,
    },
    targetPath: row.target_path,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresAppNotificationStore implements AppNotificationStore {
  async list(accountId: string, limit: number): Promise<AppNotificationsResponseDto> {
    const [rows, counts] = await Promise.all([
      pg<NotificationRow[]>`
        select n.id, n.kind, n.target_path, n.read_at, n.created_at,
               a.id as source_id, a.type as source_type,
               a.username::text as source_username, a.user_image as source_image
        from app_notifications n
        join accounts a on a.id = n.source_agent_id
        where n.account_id = ${accountId}
          and n.dismissed_at is null
        order by n.created_at desc, n.id desc
        limit ${limit}
      `,
      pg<{ unread_count: string }[]>`
        select count(*)::text as unread_count
        from app_notifications
        where account_id = ${accountId}
          and read_at is null
          and dismissed_at is null
      `,
    ]);
    return { items: rows.map(toDto), unreadCount: Number(counts[0]?.unread_count ?? 0) };
  }

  async markRead(accountId: string, id: string): Promise<boolean> {
    const rows = await pg<{ id: string }[]>`
      update app_notifications
      set read_at = coalesce(read_at, now())
      where id = ${id}::uuid
        and account_id = ${accountId}
        and dismissed_at is null
      returning id
    `;
    return rows.length === 1;
  }

  async markAllRead(accountId: string): Promise<number> {
    const rows = await pg<{ id: string }[]>`
      update app_notifications
      set read_at = now()
      where account_id = ${accountId}
        and read_at is null
        and dismissed_at is null
      returning id
    `;
    return rows.length;
  }

  async dismiss(accountId: string, id: string): Promise<boolean> {
    const rows = await pg<{ id: string }[]>`
      update app_notifications
      set read_at = coalesce(read_at, now()), dismissed_at = now()
      where id = ${id}::uuid
        and account_id = ${accountId}
        and dismissed_at is null
      returning id
    `;
    return rows.length === 1;
  }
}

/** Insert once and publish only after the transaction that created it commits. */
export async function publishBuildNotification(
  bus: EventsBus,
  accountId: string,
  kind: AppNotificationKind,
  notificationId: string = randomUUID(),
): Promise<void> {
  bus.publish(notificationChannel(accountId), {
    type: 'notification.created',
    notificationId,
    kind,
  });
}

export function publishNotificationChanged(bus: EventsBus, accountId: string): void {
  bus.publish(notificationChannel(accountId), { type: 'notification.changed' });
}
