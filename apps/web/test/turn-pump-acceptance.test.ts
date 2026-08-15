import { describe, expect, it } from 'vitest';

import { turnPumpInternals } from '../components/chat/turn-pump';

describe('turn pump durable acceptance', () => {
  it('refuses to acknowledge a lost request before turn.started', async () => {
    const pump = new turnPumpInternals.Pump('private transcript', [], null, '11111111-1111-4111-8111-111111111111');
    const rejected = expect(pump.accepted).rejects.toThrow('network lost');
    pump.push({ kind: 'rejected', message: 'network lost', manna: false });
    await rejected;
  });

  it('acknowledges exactly the server turn.started durability event', async () => {
    const pump = new turnPumpInternals.Pump('private transcript', [], null, '11111111-1111-4111-8111-111111111111');
    pump.push({
      kind: 'event',
      event: {
        type: 'turn.started',
        sessionId: '11111111-1111-4111-8111-111111111111',
        turnId: '22222222-2222-4222-8222-222222222222',
      },
    });
    await expect(pump.accepted).resolves.toBeUndefined();
    pump.push({ kind: 'failed', code: 'stream_lost', message: 'later stream failure' });
    await expect(pump.accepted).resolves.toBeUndefined();
  });
});
