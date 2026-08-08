import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// server.mjs is the deployed plain-Node resolver (typed via
// test/deployed-resolver-shim.d.ts). This test pins its runtime behavior
// against the typed gateway module — the anti-drift contract.
import {
  deriveCapabilityKey as mjsDeriveKey,
  parseSecretId as mjsParse,
  verifySecretId as mjsVerify,
  CAPABILITY_EPOCH_DEFAULT as MJS_EPOCH,
} from '../../../infra/channel-secret-resolver/server.mjs';
import {
  CAPABILITY_EPOCH_DEFAULT,
  deriveCapabilityKey,
  mintCapabilityId,
  parseSecretId,
  verifySecretId,
} from '../src/channel-secret-capability';

/**
 * The deployed resolver sidecar (server.mjs) re-implements the capability
 * primitives in plain Node (no bundler into the container). This test is the
 * anti-drift contract: the two implementations MUST agree bit-for-bit.
 */
describe('capability implementations agree (gateway TS ↔ deployed server.mjs)', () => {
  const vaultKey = randomBytes(32);

  it('derive the same capability key and default epoch', () => {
    expect((mjsDeriveKey(vaultKey) as Buffer).equals(deriveCapabilityKey(vaultKey))).toBe(true);
    expect(MJS_EPOCH).toBe(CAPABILITY_EPOCH_DEFAULT);
  });

  it('parse ids identically', () => {
    const id = mintCapabilityId(deriveCapabilityKey(vaultKey), {
      connectionId: randomUUID(),
      channel: 'telegram',
      runtimeAccountId: 'eden-x',
      epoch: CAPABILITY_EPOCH_DEFAULT,
    });
    expect(mjsParse(id)).toEqual(parseSecretId(id));
    expect(mjsParse('channel/../x')).toEqual(parseSecretId('channel/../x'));
  });

  it('a TS-minted capability verifies under the deployed resolver and vice-versa', () => {
    const capKey = deriveCapabilityKey(vaultKey);
    const scope = {
      connectionId: randomUUID(),
      channel: 'discord',
      runtimeAccountId: 'eden-agent',
      epoch: CAPABILITY_EPOCH_DEFAULT,
    };
    const id = mintCapabilityId(capKey, scope);
    const row = { ...scope };

    const tsVerdict = verifySecretId({ id, capKey, row, allowLegacyUnscoped: false });
    const mjsVerdict = mjsVerify({ id, capKey, row, allowLegacyUnscoped: false });
    expect(tsVerdict).toEqual({ ok: true, connectionId: scope.connectionId, reason: 'granted' });
    expect(mjsVerdict).toEqual(tsVerdict);
  });

  it('both reject a forged MAC and a cross-connection swap', () => {
    const capKey = deriveCapabilityKey(vaultKey);
    const a = { connectionId: randomUUID(), channel: 'discord', runtimeAccountId: 'a', epoch: 'c1' };
    const b = { connectionId: randomUUID(), channel: 'discord', runtimeAccountId: 'b', epoch: 'c1' };
    const forged = mintCapabilityId(capKey, a).replace(a.connectionId, b.connectionId);
    const row = { ...b };
    expect(mjsVerify({ id: forged, capKey, row, allowLegacyUnscoped: false }).ok).toBe(false);
    expect(verifySecretId({ id: forged, capKey, row, allowLegacyUnscoped: false }).ok).toBe(false);
  });
});
