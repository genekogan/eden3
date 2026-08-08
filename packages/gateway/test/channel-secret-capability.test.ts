import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_EPOCH_DEFAULT,
  CAPABILITY_MAC_BYTES,
  CAPABILITY_SECRET_ID,
  LEGACY_SECRET_ID,
  capabilityMac,
  deriveCapabilityKey,
  mintCapabilityId,
  parseSecretId,
  verifySecretId,
  type CapabilityScope,
} from '../src/channel-secret-capability';

const VAULT_KEY = randomBytes(32);

function scope(overrides: Partial<CapabilityScope> = {}): CapabilityScope {
  return {
    connectionId: randomUUID(),
    channel: 'discord',
    runtimeAccountId: 'eden-agent-one',
    epoch: CAPABILITY_EPOCH_DEFAULT,
    ...overrides,
  };
}

function rowOf(s: CapabilityScope) {
  return {
    connectionId: s.connectionId,
    channel: s.channel,
    runtimeAccountId: s.runtimeAccountId,
    epoch: s.epoch,
  };
}

describe('deriveCapabilityKey', () => {
  it('is deterministic and domain-separated from the raw vault key', () => {
    const a = deriveCapabilityKey(VAULT_KEY);
    const b = deriveCapabilityKey(VAULT_KEY);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    // Not the raw key, and a different vault key derives a different cap key.
    expect(a.equals(VAULT_KEY)).toBe(false);
    expect(deriveCapabilityKey(randomBytes(32)).equals(a)).toBe(false);
  });

  it('accepts hex and base64 encodings of the same 32-byte key identically', () => {
    expect(deriveCapabilityKey(VAULT_KEY.toString('hex')).equals(deriveCapabilityKey(VAULT_KEY))).toBe(
      true,
    );
    expect(
      deriveCapabilityKey(VAULT_KEY.toString('base64')).equals(deriveCapabilityKey(VAULT_KEY)),
    ).toBe(true);
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    expect(() => deriveCapabilityKey('too-short')).toThrow();
  });
});

describe('known-answer vector (independent encoding oracle, anti-drift)', () => {
  // Independently recompute HKDF + the canonical MAC input outside the module.
  // If field framing, ordering, the domain tag, truncation, or base64url change,
  // this fails — the two implementations must both match this fixed layout.
  const FIXED_KEY = Buffer.alloc(32, 7); // 0x07 * 32
  const FIXED_UUID = '11111111-1111-4111-8111-111111111111';
  const scope = { connectionId: FIXED_UUID, channel: 'discord', runtimeAccountId: 'eden-kat', epoch: 'c1' };

  it('mintCapabilityId matches an independently computed HMAC over the frozen canonical layout', () => {
    const capKey = Buffer.from(
      hkdfSync(
        'sha256',
        FIXED_KEY,
        Buffer.from('eden3-channel-secret-capability', 'utf8'),
        Buffer.from('v1', 'utf8'),
        32,
      ),
    );
    const canonical = ['eden3-channel-cap-v1', FIXED_UUID, 'discord', 'eden-kat', 'c1'].join('\0');
    const mac = createHmac('sha256', capKey).update(canonical, 'utf8').digest().subarray(0, 16);
    const macB64url = mac.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(deriveCapabilityKey(FIXED_KEY).equals(capKey)).toBe(true);
    expect(mintCapabilityId(deriveCapabilityKey(FIXED_KEY), scope)).toBe(
      `channel/${FIXED_UUID}.c1.${macB64url}`,
    );
  });
});

describe('mintCapabilityId / parseSecretId', () => {
  it('mints an id that matches the capability regex and round-trips through parse', () => {
    const capKey = deriveCapabilityKey(VAULT_KEY);
    const s = scope();
    const id = mintCapabilityId(capKey, s);
    expect(CAPABILITY_SECRET_ID.test(id)).toBe(true);
    // 128-bit MAC → 22 base64url chars, no padding, no + or /.
    const mac = id.split('.').pop()!;
    expect(mac).toHaveLength(22);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(capabilityMac(capKey, s)).toHaveLength(CAPABILITY_MAC_BYTES);
    const parsed = parseSecretId(id);
    expect(parsed).toMatchObject({ kind: 'capability', connectionId: s.connectionId, epoch: s.epoch });
  });

  it('mints ids that satisfy OpenClaw 2026.7.1 EXEC_SECRET_REF_ID grammar (round-trip safety)', () => {
    // Mirror of openclaw src/secrets/ref-contract.ts EXEC_SECRET_REF_ID_PATTERN
    // + its traversal-segment rule. A capability id must survive OpenClaw config
    // schema validation to reach the resolver at all.
    const EXEC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
    const capKey = deriveCapabilityKey(VAULT_KEY);
    for (let i = 0; i < 50; i += 1) {
      const id = mintCapabilityId(capKey, scope());
      expect(EXEC_PATTERN.test(id)).toBe(true);
      expect(id.split('/').every((seg) => seg !== '.' && seg !== '..')).toBe(true);
    }
  });

  it('classifies legacy and malformed ids', () => {
    expect(parseSecretId(`channel/${randomUUID()}`).kind).toBe('legacy');
    expect(parseSecretId('channel/../../etc').kind).toBe('malformed');
    expect(parseSecretId('channel/*').kind).toBe('malformed');
    expect(parseSecretId('channel/all').kind).toBe('malformed');
    expect(parseSecretId(42 as unknown).kind).toBe('malformed');
    expect(LEGACY_SECRET_ID.test(`channel/${randomUUID()}`)).toBe(true);
  });
});

describe('capabilityMac binds every scope field', () => {
  const capKey = deriveCapabilityKey(VAULT_KEY);
  const base = scope();
  const baseMac = capabilityMac(capKey, base).toString('hex');

  it.each<[string, CapabilityScope]>([
    ['connectionId', { ...base, connectionId: randomUUID() }],
    ['channel', { ...base, channel: 'telegram' }],
    ['runtimeAccountId', { ...base, runtimeAccountId: 'eden-agent-two' }],
    ['epoch', { ...base, epoch: 'c2' }],
  ])('flipping %s changes the MAC', (_field, mutated) => {
    expect(capabilityMac(capKey, mutated).toString('hex')).not.toBe(baseMac);
  });

  it('a different capability key changes the MAC', () => {
    expect(capabilityMac(deriveCapabilityKey(randomBytes(32)), base).toString('hex')).not.toBe(
      baseMac,
    );
  });
});

describe('verifySecretId — fail closed unless the capability is exact', () => {
  const capKey = deriveCapabilityKey(VAULT_KEY);

  it('grants a legitimate capability for its own connection', () => {
    const s = scope();
    const id = mintCapabilityId(capKey, s);
    const v = verifySecretId({ id, capKey, row: rowOf(s), allowLegacyUnscoped: false });
    expect(v).toEqual({ ok: true, connectionId: s.connectionId, reason: 'granted' });
  });

  it('DENIES cross-agent: a capability minted for A presented against row B', () => {
    const a = scope({ runtimeAccountId: 'eden-agent-A' });
    const b = scope({ runtimeAccountId: 'eden-agent-B' });
    const idA = mintCapabilityId(capKey, a);
    // Attacker swaps the connectionId to B but keeps A's MAC.
    const forged = idA.replace(a.connectionId, b.connectionId);
    const v = verifySecretId({ id: forged, capKey, row: rowOf(b), allowLegacyUnscoped: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('capability_forged');
  });

  it('DENIES cross-channel: a discord capability presented against a telegram row', () => {
    const s = scope({ channel: 'discord' });
    const id = mintCapabilityId(capKey, s);
    const telegramRow = { ...rowOf(s), channel: 'telegram' };
    expect(verifySecretId({ id, capKey, row: telegramRow, allowLegacyUnscoped: false }).ok).toBe(
      false,
    );
  });

  it('DENIES a forged MAC (attacker without the capability key)', () => {
    const s = scope();
    const id = mintCapabilityId(deriveCapabilityKey(randomBytes(32)), s);
    expect(verifySecretId({ id, capKey, row: rowOf(s), allowLegacyUnscoped: false }).reason).toBe(
      'capability_forged',
    );
  });

  it('DENIES a stale-epoch capability (revocation hook)', () => {
    const s = scope({ epoch: 'c1' });
    const id = mintCapabilityId(capKey, s);
    const rotatedRow = { ...rowOf(s), epoch: 'c2' };
    expect(
      verifySecretId({ id, capKey, row: rotatedRow, allowLegacyUnscoped: false }).reason,
    ).toBe('capability_epoch_revoked');
  });

  it('DENIES a bare legacy id by default; grants only under break-glass', () => {
    const s = scope();
    const legacy = `channel/${s.connectionId}`;
    expect(verifySecretId({ id: legacy, capKey, row: rowOf(s), allowLegacyUnscoped: false })).toEqual(
      { ok: false, connectionId: s.connectionId, reason: 'legacy_unscoped_denied' },
    );
    expect(verifySecretId({ id: legacy, capKey, row: rowOf(s), allowLegacyUnscoped: true })).toEqual({
      ok: true,
      connectionId: s.connectionId,
      reason: 'granted_legacy_unscoped',
    });
  });

  it('DENIES when the row has no runtime_account_id to bind against', () => {
    const s = scope();
    const id = mintCapabilityId(capKey, s);
    expect(
      verifySecretId({
        id,
        capKey,
        row: { ...rowOf(s), runtimeAccountId: null },
        allowLegacyUnscoped: false,
      }).ok,
    ).toBe(false);
  });
});
