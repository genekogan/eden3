import { describe, expect, it, vi } from 'vitest';

import {
  assertE2EScratchAccountInventory,
  assertNoE2EScratchSideEffects,
  e2eScratchUser,
  parseE2EScratchDatabaseUrl,
  verifyE2EScratchPreflight,
} from '../src/testing/e2e-scratch-fixture';

const databaseName = 'eden3_runtime_e2e_20260808t210520z';
const databaseUrl = `postgres://eden3:eden3@127.0.0.1:5433/${databaseName}`;

describe('isolated E2E scratch user fixture', () => {
  it('accepts only a uniquely named local scratch database', () => {
    expect(parseE2EScratchDatabaseUrl(databaseUrl).databaseName).toBe(databaseName);
    for (const candidate of [
      'postgres://eden3:eden3@127.0.0.1:5433/eden3',
      'postgres://eden3:eden3@127.0.0.1:5433/eden3_stg',
      'postgres://eden3:eden3@example.com:5433/eden3_runtime_e2e_x',
      'postgres://eden3:eden3@127.0.0.1:5432/eden3_runtime_e2e_x',
      'postgres://eden3:eden3@127.0.0.1:5433/eden3_runtime_e2e_x?sslmode=disable',
    ]) {
      expect(() => parseE2EScratchDatabaseUrl(candidate)).toThrow(/scratch database URL/);
    }
  });

  it('derives one deterministic synthetic human identity from the scratch database', () => {
    const fixture = e2eScratchUser(databaseName);
    expect(fixture).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      type: 'user',
      username: 'gene',
      externalId: null,
      clerkUserId: null,
      userImage: null,
      deleted: false,
    });
    expect(e2eScratchUser(databaseName)).toEqual(fixture);
    expect(e2eScratchUser(`${databaseName}_other`).id).not.toBe(fixture.id);
  });

  it('permits only an empty inventory or the exact idempotent fixture row', () => {
    const fixture = e2eScratchUser(databaseName);
    expect(assertE2EScratchAccountInventory([], fixture)).toBe('insert');
    expect(assertE2EScratchAccountInventory([fixture], fixture)).toBe('existing');
    for (const rows of [
      [{ ...fixture, username: 'eve' }],
      [{ ...fixture, type: 'agent' }],
      [{ ...fixture, clerkUserId: 'clerk_subject' }],
      [{ ...fixture, externalId: 'legacy_id' }],
      [fixture, { ...fixture, id: e2eScratchUser(`${databaseName}_other`).id }],
    ]) {
      expect(() => assertE2EScratchAccountInventory(rows, fixture)).toThrow(
        /exact synthetic scratch user/,
      );
    }
  });

  it('requires the HTTP user preflight before proving zero agent/provider side effects', async () => {
    const fixture = e2eScratchUser(databaseName);
    const calls: string[] = [];
    const result = await verifyE2EScratchPreflight({
      fixture,
      fetchUsers: vi.fn(async () => {
        calls.push('users');
        return {
          users: [
            {
              id: fixture.id,
              externalId: null,
              type: 'user',
              username: 'gene',
              userImage: null,
            },
          ],
        };
      }),
      readSideEffects: vi.fn(async () => {
        calls.push('side-effects');
        return {
          accountCount: 1,
          agentCount: 0,
          sessionCount: 0,
          usageCount: 0,
          providerRunCount: 0,
          mannaAccountCount: 0,
          mannaTransactionCount: 0,
        };
      }),
    });
    expect(result).toEqual(fixture);
    expect(calls).toEqual(['users', 'side-effects']);
  });

  it('fails closed on an absent/ambiguous user or any pre-Playwright side effect', async () => {
    const fixture = e2eScratchUser(databaseName);
    const readSideEffects = vi.fn(async () => ({
      accountCount: 1,
      agentCount: 0,
      sessionCount: 0,
      usageCount: 0,
      providerRunCount: 0,
      mannaAccountCount: 0,
      mannaTransactionCount: 0,
    }));
    await expect(
      verifyE2EScratchPreflight({
        fixture,
        fetchUsers: async () => ({ users: [] }),
        readSideEffects,
      }),
    ).rejects.toThrow(/exact synthetic scratch user/);
    expect(readSideEffects).not.toHaveBeenCalled();

    expect(() =>
      assertNoE2EScratchSideEffects({
        accountCount: 1,
        agentCount: 0,
        sessionCount: 0,
        usageCount: 0,
        providerRunCount: 1,
        mannaAccountCount: 0,
        mannaTransactionCount: 0,
      }),
    ).toThrow(/side effects/);
  });
});
