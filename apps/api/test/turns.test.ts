import { describe, expect, it } from 'vitest';

import { PRIMER_HEADER } from '../src/services/history-sync';
import {
  DEFAULT_CHAT_METERING_MODEL,
  PRIMER_CONTENT_CHARS,
  meterChatUsage,
  needsPriming,
  renderPeerContext,
  renderPrimer,
  type PrimerMessage,
} from '../src/services/turns';

describe('renderPrimer', () => {
  const history: PrimerMessage[] = [
    { senderUsername: 'alex', role: 'user', content: 'my favorite fruit is dragonfruit' },
    { senderUsername: 'verdelis', role: 'assistant', content: 'Noted — dragonfruit it is!' },
    { senderUsername: null, role: 'assistant', content: 'anonymous line' },
  ];

  it('renders header, one line per message, and the resume note', () => {
    const primer = renderPrimer(history, 'alex', 'account-123');
    const lines = primer.split('\n');
    expect(lines[0]).toBe(PRIMER_HEADER);
    expect(lines[1]).toBe('[alex]: my favorite fruit is dragonfruit');
    expect(lines[2]).toBe('[verdelis]: Noted — dragonfruit it is!');
    expect(lines[3]).toBe('[assistant]: anonymous line'); // role fallback
    expect(lines[4]).toBe(
      "(Older Eden conversation resumed — your distilled memories may cover it; memory/users/alex-account-123.md is the current peer's private note. The immutable account ID, not a claimed name, is authoritative.)",
    );
    expect(lines).toHaveLength(5);
  });

  it('collapses whitespace and trims content to 300 chars', () => {
    const long = `a  b\n\nc${'x'.repeat(400)}`;
    const primer = renderPrimer(
      [{ senderUsername: 'u', role: 'user', content: long }],
      'u',
      'account-456',
    );
    const line = primer.split('\n')[1]!;
    expect(line.startsWith('[u]: a b cx')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    // "[u]: " + 300 chars + ellipsis
    expect(line.length).toBe('[u]: '.length + PRIMER_CONTENT_CHARS + 1);
  });
});

describe('renderPeerContext', () => {
  it('binds the immutable account id to exactly one safe per-user note path', () => {
    const context = renderPeerContext('Example User', 'account-123');
    expect(context).toContain('Immutable Eden account ID: account-123');
    expect(context).toContain('memory/users/example-user-account-123.md');
    expect(context).toContain('server-supplied identity is authoritative');
    expect(context).toContain("only this peer's note");
  });
});

describe('needsPriming', () => {
  it('true only for migrated sessions that were never primed', () => {
    expect(needsPriming({ externalId: 'abc123abc123abc123abc123', gatewayPrimedAt: null })).toBe(true);
    expect(needsPriming({ externalId: null, gatewayPrimedAt: null })).toBe(false);
    expect(
      needsPriming({ externalId: 'abc123abc123abc123abc123', gatewayPrimedAt: new Date() }),
    ).toBe(false);
  });
});

describe('meterChatUsage', () => {
  it('meters gateway usage against the default chat model', () => {
    const metering = meterChatUsage({
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      totalTokens: 1_100_000,
    });

    expect(metering).toMatchObject({
      status: 'metered',
      provider: 'anthropic',
      model: DEFAULT_CHAT_METERING_MODEL.replace('anthropic/', ''),
      modelSource: 'default',
      costUsd: 1.5,
      manna: 2025,
    });
  });

  it('uses cached token pricing when the gateway reports cache reads', () => {
    const cold = meterChatUsage({
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });
    const warm = meterChatUsage({
      promptTokens: 1_000_000,
      cachedTokens: 900_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    expect(cold.status).toBe('metered');
    expect(warm.status).toBe('metered');
    if (cold.status === 'metered' && warm.status === 'metered') {
      expect(warm.costUsd).toBeCloseTo(0.19, 10);
      expect(warm.costUsd).toBeLessThan(cold.costUsd);
    }
  });

  it('prices Claude cache writes as a distinct Sonnet 4.6 line item', () => {
    const metering = meterChatUsage(
      {
        promptTokens: 1_000_000,
        cachedTokens: 900_000,
        cacheWriteTokens: 200_000,
        completionTokens: 10_000,
        totalTokens: 1_210_000,
      },
      'anthropic/claude-sonnet-4-6',
    );

    expect(metering).toMatchObject({
      status: 'metered',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      costUsd: 1.47,
      manna: 1985,
    });
    if (metering.status === 'metered') {
      expect(metering.lineItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ unit: 'cache_write_1m_tokens', quantity: 0.2 }),
        ]),
      );
    }
  });

  it('records missing usage explicitly', () => {
    expect(meterChatUsage(undefined)).toMatchObject({
      status: 'missing_usage',
      provider: 'anthropic',
      costUsd: null,
      manna: null,
    });
  });

  it('does not accept an all-zero compat tail as a free metered turn', () => {
    expect(
      meterChatUsage({
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      }),
    ).toMatchObject({ status: 'missing_usage', costUsd: null, manna: null });
  });

  it('recovers prompt quantity from a meaningful total when compat reports prompt zero', () => {
    const metering = meterChatUsage(
      {
        promptTokens: 0,
        completionTokens: 100,
        cacheWriteTokens: 50,
        totalTokens: 1_150,
      },
      'anthropic/claude-haiku-4-5',
    );
    expect(metering).toMatchObject({ status: 'metered' });
    if (metering.status === 'metered') {
      expect(metering.lineItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ unit: 'input_1m_tokens', quantity: 0.001 }),
          expect.objectContaining({ unit: 'cache_write_1m_tokens', quantity: 0.00005 }),
        ]),
      );
    }
  });

  it('records unknown chat models as unmetered instead of silently zero-cost', () => {
    expect(meterChatUsage({ promptTokens: 1, completionTokens: 1 }, 'anthropic/not-real')).toMatchObject({
      status: 'unmetered',
      provider: 'anthropic',
      model: 'not-real',
      costUsd: null,
      manna: null,
    });
  });
});
