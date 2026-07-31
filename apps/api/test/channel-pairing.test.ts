import { describe, expect, it } from 'vitest';

import { addConnectionScopedPeer, decidePendingPairing } from '../src/services/channel-pairing.js';
import {
  channelCredentialLockKeys,
  pairingCodesEqual,
} from '../src/routes/channels.js';

describe('channel pairing state machine', () => {
  it('approves or denies only a live pending request', () => {
    const now = new Date('2026-07-31T12:00:00Z');
    const expiresAt = new Date('2026-08-01T12:00:00Z');
    expect(decidePendingPairing({ status: 'pending', expiresAt, decision: 'approve', now })).toBe(
      'approved',
    );
    expect(decidePendingPairing({ status: 'pending', expiresAt, decision: 'deny', now })).toBe(
      'denied',
    );
    expect(() =>
      decidePendingPairing({ status: 'approved', expiresAt, decision: 'approve', now }),
    ).toThrow('not pending');
    expect(() =>
      decidePendingPairing({ status: 'pending', expiresAt: now, decision: 'approve', now }),
    ).toThrow('not pending');
  });

  it('adds an approved sender only to the selected connection allowlist', () => {
    const original = ['11111'];
    expect(addConnectionScopedPeer(original, '22222')).toEqual(['11111', '22222']);
    expect(addConnectionScopedPeer(original, '11111')).toEqual(['11111']);
    expect(original).toEqual(['11111']);
    expect(() => addConnectionScopedPeer(original, '../../peer')).toThrow('invalid');
  });

  it('compares one-time codes without a length timing branch', () => {
    expect(pairingCodesEqual('EDEN-1234', 'EDEN-1234')).toBe(true);
    expect(pairingCodesEqual('EDEN-1234', 'EDEN-1235')).toBe(false);
    expect(pairingCodesEqual('EDEN-1234', 'x')).toBe(false);
  });

  it('serializes both token and provider-identity uniqueness dimensions', () => {
    expect(
      channelCredentialLockKeys({
        channel: 'discord',
        tokenSha256: 'abc',
        botId: '12345',
      }),
    ).toEqual([
      'channel-credential-bot:discord:12345',
      'channel-credential-token:discord:abc',
    ]);
    expect(
      channelCredentialLockKeys({
        channel: 'telegram',
        tokenSha256: 'abc',
        botId: null,
      }),
    ).toEqual(['channel-credential-token:telegram:abc']);
  });
});
