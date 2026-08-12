import { db, sessions, usageEvents } from '@eden3/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import { CHAT_MEDIA_EVENT_TYPE } from './chat-media-authorization';
import type { HistorySync, SyncTarget } from './history-sync';

export const CHAT_MEDIA_RECONCILE_INTERVAL_MS = 15_000;
export const CHAT_MEDIA_RECONCILE_TIMEOUT_MS = 10_000;

export interface PendingChatMediaTargetLoader {
  (): Promise<SyncTarget[]>;
}

/** Durable pending authorizations are the authority—not an open browser tab. */
export async function loadPendingChatMediaSyncTargets(): Promise<SyncTarget[]> {
  const rows = await db
    .selectDistinct({
      id: sessions.id,
      gatewaySessionKey: sessions.gatewaySessionKey,
    })
    .from(usageEvents)
    .innerJoin(sessions, eq(sessions.id, usageEvents.sessionId))
    .where(
      and(
        eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
        inArray(usageEvents.status, ['pending', 'provider_admitted']),
        eq(sessions.deleted, false),
        isNotNull(sessions.gatewaySessionKey),
      ),
    )
    .limit(100);
  return rows.map((row) => ({
    session: { id: row.id, gatewaySessionKey: row.gatewaySessionKey! },
  }));
}

/**
 * Restart-safe async media completion reconciler.
 *
 * Every admitted chat-media action owns a durable `usage_events` row. While
 * that row is pending, this worker keeps pulling the authoritative OpenClaw
 * transcript whether or not any browser is viewing the conversation. History
 * sync persists the terminal assistant message and ingests its attachment;
 * settlement removes the row from the next scan. Process restart simply
 * resumes from the same rows.
 */
export class ChatMediaCompletionReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly historySync: Pick<HistorySync, 'syncSession'>,
    private readonly options: {
      intervalMs?: number;
      timeoutMs?: number;
      loadTargets?: PendingChatMediaTargetLoader;
      onError?: (error: unknown, context: string) => void;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => this.options.onError?.(error, 'initial scan'));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.options.onError?.(error, 'tick'));
    }, this.options.intervalMs ?? CHAT_MEDIA_RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ scanned: number; synced: number; failed: number }> {
    if (this.running) return { scanned: 0, synced: 0, failed: 0 };
    this.running = true;
    try {
      const targets = await (this.options.loadTargets ?? loadPendingChatMediaSyncTargets)();
      let synced = 0;
      let failed = 0;
      for (const target of targets) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error('chat-media reconciliation timed out')),
          this.options.timeoutMs ?? CHAT_MEDIA_RECONCILE_TIMEOUT_MS,
        );
        timeout.unref?.();
        try {
          await this.historySync.syncSession(target, controller.signal);
          synced += 1;
        } catch (error) {
          failed += 1;
          this.options.onError?.(error, `session ${target.session.id}`);
        } finally {
          clearTimeout(timeout);
        }
      }
      return { scanned: targets.length, synced, failed };
    } finally {
      this.running = false;
    }
  }
}
