import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// server.mjs is the deployed plain-Node resolver (typed via
// test/deployed-resolver-shim.d.ts). This test pins its runtime behavior
// against the typed gateway module — the anti-drift contract.
import {
  deriveCapabilityKey as mjsDeriveKey,
  deriveRequesterKey as mjsDeriveRequesterKey,
  parseSecretId as mjsParse,
  requesterProof as mjsRequesterProof,
  verifySecretId as mjsVerify,
  CAPABILITY_EPOCH_DEFAULT as MJS_EPOCH,
} from '../../../infra/channel-secret-resolver/server.mjs';
import {
  CAPABILITY_EPOCH_DEFAULT,
  deriveCapabilityKey,
  deriveRequesterKey,
  mintCapabilityId,
  parseSecretId,
  requesterProof,
  verifySecretId,
} from '../src/channel-secret-capability';

/**
 * The deployed resolver sidecar (server.mjs) re-implements the capability
 * primitives in plain Node (no bundler into the container). This test is the
 * anti-drift contract: the two implementations MUST agree bit-for-bit across a
 * table of grant + every fail-closed vector, with EXACT reason parity.
 */
describe('capability implementations agree (gateway TS ↔ deployed server.mjs)', () => {
  const vaultKey = randomBytes(32);
  const capKey = deriveCapabilityKey(vaultKey);

  it('derive the same capability key (byte-for-byte) and default epoch', () => {
    expect((mjsDeriveKey(vaultKey) as Buffer).equals(deriveCapabilityKey(vaultKey))).toBe(true);
    expect((mjsDeriveKey(vaultKey.toString('hex')) as Buffer).equals(capKey)).toBe(true);
    expect(MJS_EPOCH).toBe(CAPABILITY_EPOCH_DEFAULT);
  });

  it('derives and signs requester challenges identically', () => {
    const requesterKey = deriveRequesterKey(vaultKey);
    const scope = base();
    const id = mintCapabilityId(capKey, scope);
    const params = {
      challenge: randomBytes(32).toString('base64url'),
      processInstanceId: randomUUID(),
      requesters: [
        {
          id,
          configPath: 'channels.discord.accounts.eden-test.token',
          connectionId: scope.connectionId,
          channel: 'discord' as const,
          runtimeAccountId: 'eden-test',
          agentId: 'test-agent',
          credentialField: 'token' as const,
        },
      ],
    };
    expect(mjsDeriveRequesterKey(vaultKey)).toEqual(requesterKey);
    expect(mjsRequesterProof(requesterKey, params)).toBe(requesterProof(requesterKey, params));
  });

  it('parse capability, legacy, and malformed ids identically', () => {
    const id = mintCapabilityId(capKey, {
      connectionId: randomUUID(),
      accountId: randomUUID(),
      channel: 'telegram',
      runtimeAccountId: 'eden-x',
      epoch: CAPABILITY_EPOCH_DEFAULT,
    });
    for (const probe of [id, `channel/${randomUUID()}`, 'channel/../x', 'channel/*', 'nonsense']) {
      expect(mjsParse(probe)).toEqual(parseSecretId(probe));
    }
  });

  // Each vector: mint (TS) an id for `mintScope`, present it against `row`, and
  // require BOTH verifiers return the exact same {ok, reason}. This is the
  // mutation guard — if either implementation's check drifts, a row here fails.
  const base = () => {
    const connectionId = randomUUID();
    const accountId = randomUUID();
    return {
      connectionId,
      accountId,
      channel: 'discord' as const,
      runtimeAccountId: `eden-${connectionId}`,
      epoch: 'c1',
    };
  };

  it.each<[string, () => { mint: any; row: any; capKey: Buffer; expectOk: boolean; reason: string }]>([
    ['grant (exact match)', () => { const s = base(); return { mint: s, row: { ...s }, capKey, expectOk: true, reason: 'granted' }; }],
    ['forged MAC (wrong key)', () => { const s = base(); return { mint: s, row: { ...s }, capKey: deriveCapabilityKey(randomBytes(32)), expectOk: false, reason: 'capability_forged' }; }],
    ['cross-connection swap', () => { const s = base(); const b = base(); return { mint: s, row: { ...b }, capKey, expectOk: false, reason: 'capability_forged' }; }],
    ['cross-account (owner changed)', () => { const s = base(); return { mint: s, row: { ...s, accountId: randomUUID() }, capKey, expectOk: false, reason: 'capability_forged' }; }],
    ['cross-channel', () => { const s = base(); return { mint: s, row: { ...s, channel: 'telegram' }, capKey, expectOk: false, reason: 'capability_forged' }; }],
    ['cross-runtime', () => { const s = base(); return { mint: s, row: { ...s, runtimeAccountId: 'eden-other' }, capKey, expectOk: false, reason: 'capability_forged' }; }],
    ['stale epoch', () => { const s = base(); return { mint: s, row: { ...s, epoch: 'c2' }, capKey, expectOk: false, reason: 'capability_epoch_revoked' }; }],
    ['null runtime', () => { const s = base(); return { mint: s, row: { ...s, runtimeAccountId: null }, capKey, expectOk: false, reason: 'capability_forged' }; }],
    ['null account', () => { const s = base(); return { mint: s, row: { ...s, accountId: null }, capKey, expectOk: false, reason: 'capability_forged' }; }],
  ])('agree on: %s', (_name, make) => {
    const { mint, row, capKey: verifyKey, expectOk, reason } = make();
    // Mint always with the true capKey (an attacker's forged case overrides verifyKey).
    const mintKey = _name.includes('forged') ? verifyKey : capKey;
    const id = mintCapabilityId(mintKey, mint);
    const ts = verifySecretId({ id, capKey, row, allowLegacyUnscoped: false });
    const mjs = mjsVerify({ id, capKey, row, allowLegacyUnscoped: false });
    expect(ts).toEqual(mjs);
    expect(ts.ok).toBe(expectOk);
    expect(ts.reason).toBe(reason);
  });

  it('agree on legacy id under both strict and break-glass', () => {
    const s = base();
    const legacy = `channel/${s.connectionId}`;
    for (const allow of [false, true]) {
      expect(mjsVerify({ id: legacy, capKey, row: { ...s }, allowLegacyUnscoped: allow })).toEqual(
        verifySecretId({ id: legacy, capKey, row: { ...s }, allowLegacyUnscoped: allow }),
      );
    }
  });
});
