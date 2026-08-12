import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(
  new URL('../src/services/chat-media-reconciler.ts', import.meta.url),
  'utf8',
);
const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

describe('chat-media completion reconciliation production wiring', () => {
  it('selects durable pending media authorizations instead of browser state', () => {
    expect(serviceSource).toContain('eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE)');
    expect(serviceSource).toContain("inArray(usageEvents.status, ['pending', 'provider_admitted'])");
    expect(serviceSource).toContain('eq(sessions.deleted, false)');
    expect(serviceSource).toContain('isNotNull(sessions.gatewaySessionKey)');
    expect(serviceSource).not.toMatch(/request|reply|socket|subscriber/i);
  });

  it('starts only after attachment ingestion is installed and follows the media runtime lifecycle', () => {
    const callback = serverSource.indexOf('historySync.setAttachmentCallback(');
    const reconciler = serverSource.indexOf('new ChatMediaCompletionReconciler(historySync');
    const start = serverSource.indexOf('chatMediaCompletionReconciler?.start()');
    const stop = serverSource.indexOf('chatMediaCompletionReconciler?.stop()');
    expect(callback).toBeGreaterThanOrEqual(0);
    expect(reconciler).toBeGreaterThan(callback);
    expect(start).toBeGreaterThan(reconciler);
    expect(stop).toBeGreaterThan(reconciler);
    expect(serverSource).toContain(
      'if (opts.media?.autoStartWatcher === true) chatMediaCompletionReconciler?.start();',
    );
  });

  it('runs immediately on process start and then on a bounded cadence', () => {
    expect(serviceSource).toContain('void this.runOnce()');
    expect(serviceSource).toContain('CHAT_MEDIA_RECONCILE_INTERVAL_MS = 15_000');
    expect(serviceSource).toContain('CHAT_MEDIA_RECONCILE_TIMEOUT_MS = 10_000');
    expect(serviceSource).toContain('controller.abort(');
    expect(serviceSource).toContain('this.timer.unref?.()');
  });
});
