import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ACCOUNT_LOCK_PREFIX,
  CHANNEL_ACCOUNT_LOCK_SEED,
  ChannelConnectionQuotaExceededError,
  lockAndAssertChannelConnectionQuota,
} from '../src/services/channel-connection-quota.js';

type QueryResult = Array<Record<string, unknown>>;

function fakeTransaction(count: number) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });
    return sql.includes('count(*)::int') ? [{ count }] : [];
  };
  return { tx, calls };
}

describe('channel connection owner quota', () => {
  it('takes the canonical account lock before counting and fails with a typed stable error', async () => {
    const accountId = '223e4567-e89b-42d3-a456-426614174000';
    const { tx, calls } = fakeTransaction(2);

    const error = await lockAndAssertChannelConnectionQuota(tx as never, {
      accountId,
      limit: 2,
      bypassAccountQuota: false,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChannelConnectionQuotaExceededError);
    expect(error).toMatchObject({
      code: 'channel_quota_exceeded',
      statusCode: 429,
      limit: 2,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      values: [`${CHANNEL_ACCOUNT_LOCK_PREFIX}${accountId}`, CHANNEL_ACCOUNT_LOCK_SEED],
    });
    expect(calls[1]?.sql).toContain('where account_id = ?');
  });

  it('serializes an administrator bypass without executing the quota count', async () => {
    const { tx, calls } = fakeTransaction(999);
    await lockAndAssertChannelConnectionQuota(tx as never, {
      accountId: '223e4567-e89b-42d3-a456-426614174000',
      limit: 2,
      bypassAccountQuota: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock');
  });

  it('uses the same account-first primitive in every channel insertion transaction', () => {
    const hosted = readFileSync(new URL('../src/routes/channels.ts', import.meta.url), 'utf8');
    const xCustody = readFileSync(
      new URL('../src/services/postgres-channel-connector-custody.ts', import.meta.url),
      'utf8',
    );
    const telegramCustody = readFileSync(
      new URL('../src/services/postgres-telegram-managed-bot-custody.ts', import.meta.url),
      'utf8',
    );
    const xService = readFileSync(
      new URL('../src/services/x-byo-connector.ts', import.meta.url),
      'utf8',
    );
    const telegramService = readFileSync(
      new URL('../src/services/telegram-managed-bots.ts', import.meta.url),
      'utf8',
    );

    const hostedInsert = hosted.slice(
      hosted.indexOf('const rows = await pg.begin'),
      hosted.indexOf("app.patch('/connections/:id'", hosted.indexOf('const rows = await pg.begin')),
    );
    expect(hostedInsert.indexOf('lockAndAssertChannelConnectionQuota')).toBeGreaterThanOrEqual(0);
    expect(hostedInsert.indexOf('lockAndAssertChannelConnectionQuota')).toBeLessThan(
      hostedInsert.indexOf('channelCredentialLockKeys'),
    );

    for (const [source, startMarker, endMarker] of [
      [xCustody, 'async sealScoped', 'async withPlaintext'],
      [telegramCustody, 'async storeManagedBotToken', '\n  }\n}'],
    ] as const) {
      const start = source.indexOf(startMarker);
      const transaction = source.slice(
        start,
        source.indexOf(endMarker, start + startMarker.length),
      );
      expect(transaction.indexOf('lockAndAssertChannelConnectionQuota')).toBeGreaterThanOrEqual(0);
      expect(transaction.indexOf('lockAndAssertChannelConnectionQuota')).toBeLessThan(
        transaction.indexOf('channel-credential-'),
      );
    }

    expect(xService).toMatch(
      /ChannelConnectionQuotaExceededError[\s\S]*catch \(error\)[\s\S]*instanceof ChannelConnectionQuotaExceededError[\s\S]*throw error/,
    );
    expect(telegramService).toMatch(
      /ChannelConnectionQuotaExceededError[\s\S]*channel_quota_exceeded[\s\S]*instanceof ChannelConnectionQuotaExceededError/,
    );
  });
});
