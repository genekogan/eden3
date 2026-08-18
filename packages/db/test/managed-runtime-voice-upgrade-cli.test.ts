import { describe, expect, it } from 'vitest';

import {
  assertManagedVoiceUpgradeUrls,
  buildManagedVoiceUpgradeValidation,
} from '../src/managed-runtime-voice-upgrade-cli';

const owner = 'postgresql://owner_admin:owner-placeholder-123456789@db.example.invalid/eden3?sslmode=verify-full';
const runtime = 'postgresql://eden3_runtime_prod:runtime-placeholder-123456@db.example.invalid/eden3?sslmode=verify-full';

describe('managed runtime voice upgrade authority', () => {
  it('binds distinct owner/runtime credentials to one admitted database', () => {
    expect(assertManagedVoiceUpgradeUrls(owner, runtime, 'eden3', 'eden3_runtime_prod')).toMatchObject({
      ownerAuthority: { databaseName: 'eden3', tlsMode: 'verify-full' },
      runtimeAuthority: { databaseName: 'eden3', tlsMode: 'verify-full' },
    });
    expect(buildManagedVoiceUpgradeValidation(owner, runtime, 'eden3', 'eden3_runtime_prod')).toEqual({
      databaseName: 'eden3',
      hostSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      port: 5432,
      roleSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      validation: 'managed-owner-runtime-authority-split',
    });
  });

  it.each([
    [runtime, runtime, 'eden3', 'eden3_runtime_prod'],
    [owner, runtime.replace('db.example.invalid', 'other-db.example.invalid'), 'eden3', 'eden3_runtime_prod'],
    [owner, runtime.replace('db.example.invalid/', 'db.example.invalid:5433/'), 'eden3', 'eden3_runtime_prod'],
    [owner.replace('/eden3?', '/other?'), runtime, 'eden3', 'eden3_runtime_prod'],
    [owner, runtime.replace('eden3_runtime_prod', 'wrong_role'), 'eden3', 'eden3_runtime_prod'],
    [owner, runtime.replace('runtime-placeholder-123456', 'owner-placeholder-123456789'), 'eden3', 'eden3_runtime_prod'],
  ])('refuses authority/role/secret split mutation', (ownerUrl, runtimeUrl, database, role) => {
    expect(() => assertManagedVoiceUpgradeUrls(ownerUrl, runtimeUrl, database, role)).toThrow();
  });
});
