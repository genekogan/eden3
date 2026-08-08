import { describe, expect, it } from 'vitest';

import {
  channelRuntimeBindingMatches,
  storedChannelRuntimeBindingId,
} from './channel-runtime-binding';

const BINDING = '33333333-3333-4333-8333-333333333333';

describe('channel runtime binding generation', () => {
  it('keeps pre-generation callbacks compatible only with a legacy row', () => {
    expect(channelRuntimeBindingMatches({ metadata: {}, storedAgentId: 'agent-a' })).toBe(true);
    expect(channelRuntimeBindingMatches({
      metadata: {},
      storedAgentId: 'agent-a',
      requesterAgentId: 'agent-a',
    })).toBe(true);
    expect(channelRuntimeBindingMatches({
      metadata: {},
      storedAgentId: 'agent-a',
      requesterBindingId: BINDING,
    })).toBe(false);
  });

  it('requires the exact agent and exact generation once published', () => {
    const metadata = { _runtimeBindingId: BINDING };
    expect(channelRuntimeBindingMatches({
      metadata,
      storedAgentId: 'agent-a',
      requesterAgentId: 'agent-a',
      requesterBindingId: BINDING,
    })).toBe(true);
    for (const candidate of [
      {},
      { requesterAgentId: 'agent-a' },
      { requesterBindingId: BINDING },
      { requesterAgentId: 'agent-b', requesterBindingId: BINDING },
      {
        requesterAgentId: 'agent-a',
        requesterBindingId: '44444444-4444-4444-8444-444444444444',
      },
    ]) {
      expect(channelRuntimeBindingMatches({ metadata, storedAgentId: 'agent-a', ...candidate }))
        .toBe(false);
    }
  });

  it('fails closed on malformed persisted generations', () => {
    expect(() => storedChannelRuntimeBindingId({ _runtimeBindingId: 'not-a-uuid' }))
      .toThrow('invalid channel runtime binding');
    expect(channelRuntimeBindingMatches({
      metadata: { _runtimeBindingId: 'not-a-uuid' },
      storedAgentId: 'agent-a',
      requesterAgentId: 'agent-a',
      requesterBindingId: BINDING,
    })).toBe(false);
  });
});
