import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  assertE2EScratchAccountInventory,
  assertE2EScratchRuntimeInventory,
  assertNoE2EScratchSideEffects,
  cleanupE2EScratchUser,
  e2eScratchUser,
  parseE2EScratchApiUrl,
  parseE2EScratchDatabaseUrl,
  preflightE2EScratchUser,
  seedE2EScratchUser,
  verifyE2EScratchPreflight,
  type E2EScratchFixtureRepository,
  type E2EScratchSideEffects,
  type E2EScratchUser,
} from '../src/testing/e2e-scratch-fixture';

const databaseName = 'eden3_runtime_e2e_20260808t210520z';
const databaseUrl = `postgres://eden3:eden3@127.0.0.1:5433/${databaseName}`;
const custodyCountKeys = [
  'agentVoiceAssignmentCount',
  'voiceCloneCount',
  'voiceCloneClipCount',
  'voiceQuoteCount',
  'voiceExecutionCount',
  'directVoiceJobCount',
  'transcriptionSessionCount',
  'transcriptionChunkCount',
  'storageUploadCount',
  'storageObjectCount',
] as const;

const seedBaseline = (): E2EScratchSideEffects => ({
  accountCount: 1,
  agentCount: 0,
  sessionCount: 0,
  usageCount: 0,
  providerRunCount: 0,
  mannaAccountCount: 0,
  mannaTransactionCount: 0,
  agentVoiceAssignmentCount: 0,
  voiceCloneCount: 0,
  voiceCloneClipCount: 0,
  voiceQuoteCount: 0,
  voiceExecutionCount: 0,
  directVoiceJobCount: 0,
  transcriptionSessionCount: 0,
  transcriptionChunkCount: 0,
  storageUploadCount: 0,
  storageObjectCount: 0,
});

const runtimeBaseline = (): E2EScratchSideEffects => ({
  ...seedBaseline(),
  accountCount: 2,
  agentCount: 1,
});

const platformEve = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'agent',
  username: 'eve',
  externalId: null,
  clerkUserId: null,
  userImage: null,
  deleted: false,
  ownerId: null,
  openclawId: 'main',
  bootstrapCanonical: true,
} as const;

class MemoryFixtureRepository implements E2EScratchFixtureRepository {
  rows: unknown[] = [];
  counts = seedBaseline();
  lockModes: boolean[] = [];
  deleteInputs: E2EScratchUser[] = [];
  inTransaction = false;

  async transaction<T>(
    operation: (repository: E2EScratchFixtureRepository) => Promise<T>,
  ): Promise<T> {
    if (this.inTransaction) throw new Error('nested fixture transaction');
    this.inTransaction = true;
    try {
      return await operation(this);
    } finally {
      this.inTransaction = false;
    }
  }

  async currentDatabase() {
    return databaseName;
  }

  async accountRows(options: { forUpdate?: boolean } = {}) {
    this.lockModes.push(options.forUpdate === true);
    return structuredClone(this.rows);
  }

  async insertUser(fixture: E2EScratchUser) {
    this.rows.push(structuredClone(fixture));
    this.counts.accountCount = this.rows.length;
  }

  async sideEffectCounts() {
    return structuredClone(this.counts);
  }

  async deleteExactUser(fixture: E2EScratchUser) {
    this.deleteInputs.push(structuredClone(fixture));
    const exact = this.rows.find((row) => (row as { id?: string }).id === fixture.id);
    if (!exact) return [];
    this.rows = this.rows.filter((row) => (row as { id?: string }).id !== fixture.id);
    this.counts.accountCount = this.rows.length;
    return [fixture.id];
  }
}

describe('isolated E2E scratch user fixture', () => {
  it('accepts only a uniquely named local scratch database', () => {
    expect(parseE2EScratchDatabaseUrl(databaseUrl).databaseName).toBe(databaseName);
    const encodedDatabaseName = `${databaseName.slice(0, -1)}%7A`;
    for (const candidate of [
      'postgres://eden3:eden3@127.0.0.1:5433/eden3',
      'postgres://eden3:eden3@127.0.0.1:5433/eden3_stg',
      `postgres://eden3:eden3@example.com:5433/${databaseName}`,
      `postgres://eden3:eden3@127.0.0.1:5432/${databaseName}`,
      `${databaseUrl}?sslmode=disable`,
      `http://eden3:eden3@127.0.0.1:5433/${databaseName}`,
      `postgres://other:eden3@127.0.0.1:5433/${databaseName}`,
      `postgres://eden3:eden3@127.0.0.1:5433/${encodedDatabaseName}`,
      `${databaseUrl}#fragment`,
    ]) {
      expect(() => parseE2EScratchDatabaseUrl(candidate)).toThrow(/scratch database URL/);
    }
  });

  it('accepts only an uncredentialed alternate loopback API root', () => {
    for (const candidate of [
      'http://127.0.0.1:4381/',
      'http://localhost:4381/',
      'http://[::1]:4381/',
    ]) {
      expect(parseE2EScratchApiUrl(candidate).port).toBe('4381');
    }
    for (const candidate of [
      'https://127.0.0.1:4381/',
      'http://example.com:4381/',
      'http://user@127.0.0.1:4381/',
      'http://:pass@127.0.0.1:4381/',
      'http://127.0.0.1:4381/dev/users',
      'http://127.0.0.1:4381/?q=alex',
      'http://127.0.0.1:4381/#fragment',
      'http://127.0.0.1:4301/',
    ]) {
      expect(() => parseE2EScratchApiUrl(candidate)).toThrow(/isolated E2E API URL/);
    }
  });

  it('derives one deterministic synthetic human identity from the scratch database', () => {
    const fixture = e2eScratchUser(databaseName);
    expect(fixture).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      type: 'user',
      username: 'alex',
      externalId: null,
      clerkUserId: null,
      userImage: null,
      deleted: false,
    });
    expect(e2eScratchUser(databaseName)).toEqual(fixture);
    expect(e2eScratchUser(`${databaseName}_other`).id).not.toBe(fixture.id);
  });

  it('accepts only exact Alex plus one canonical platform Eve after API startup', () => {
    const fixture = e2eScratchUser(databaseName);
    expect(() => assertE2EScratchRuntimeInventory([platformEve, fixture], fixture)).not.toThrow();
    expect(() =>
      assertE2EScratchRuntimeInventory([platformEve], fixture, { geneRequired: false }),
    ).not.toThrow();
    for (const rows of [
      [fixture],
      [fixture, { ...platformEve, username: 'eve-lookalike' }],
      [fixture, { ...platformEve, type: 'user' }],
      [fixture, { ...platformEve, externalId: 'eve-external' }],
      [fixture, { ...platformEve, clerkUserId: 'eve-clerk' }],
      [fixture, { ...platformEve, userImage: 'https://example.invalid/eve.png' }],
      [fixture, { ...platformEve, ownerId: fixture.id }],
      [fixture, { ...platformEve, openclawId: 'not-main' }],
      [fixture, { ...platformEve, deleted: true }],
      [fixture, { ...platformEve, bootstrapCanonical: false }],
      [fixture, platformEve, { ...fixture, id: e2eScratchUser(`${databaseName}_other`).id }],
      [fixture, platformEve, { ...platformEve, id: '00000000-0000-4000-8000-000000000002' }],
    ]) {
      expect(() => assertE2EScratchRuntimeInventory(rows, fixture)).toThrow(/platform Eve baseline/);
    }
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
      [{ ...fixture, id: e2eScratchUser(`${databaseName}_other`).id }],
      [{ ...fixture, userImage: 'https://example.invalid/image.png' }],
      [{ ...fixture, deleted: true }],
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
              username: 'alex',
              userImage: null,
            },
          ],
        };
      }),
      readSideEffects: vi.fn(async () => {
        calls.push('side-effects');
        return runtimeBaseline();
      }),
    });
    expect(result).toEqual(fixture);
    expect(calls).toEqual(['users', 'side-effects']);
  });

  it('fails closed on an absent/ambiguous user or any pre-Playwright side effect', async () => {
    const fixture = e2eScratchUser(databaseName);
    const readSideEffects = vi.fn(async () => runtimeBaseline());
    await expect(
      verifyE2EScratchPreflight({
        fixture,
        fetchUsers: async () => ({ users: [] }),
        readSideEffects,
      }),
    ).rejects.toThrow(/exact synthetic scratch user/);
    expect(readSideEffects).not.toHaveBeenCalled();

    for (const key of [
      'agentCount',
      'sessionCount',
      'usageCount',
      'providerRunCount',
      'mannaAccountCount',
      'mannaTransactionCount',
    ] as const) {
      const baseline = runtimeBaseline();
      expect(() =>
        assertNoE2EScratchSideEffects({ ...baseline, [key]: baseline[key] + 1 }),
      ).toThrow(/side effects/);
    }
    expect(() =>
      assertNoE2EScratchSideEffects({ ...runtimeBaseline(), accountCount: 3 }),
    ).toThrow(/side effects/);
  });

  it.each(custodyCountKeys)('refuses a stale %s row before Gate 3 starts', (key) => {
    const baseline = runtimeBaseline();
    expect(() =>
      assertNoE2EScratchSideEffects({ ...baseline, [key]: 1 }),
    ).toThrow(/side effects/);
  });

  it('queries every private voice, transcription, upload, and object custody table', async () => {
    const cli = await readFile(
      fileURLToPath(new URL('../src/testing/e2e-scratch-fixture-cli.ts', import.meta.url)),
      'utf8',
    );
    for (const key of custodyCountKeys) {
      expect([...cli.matchAll(new RegExp(`as "${key}"`, 'g'))]).toHaveLength(1);
    }
  });

  it('executes seed, HTTP+DB preflight, exact cleanup, and idempotent cleanup', async () => {
    const repository = new MemoryFixtureRepository();
    const seeded = await seedE2EScratchUser({ repository, databaseName });
    expect(seeded.action).toBe('insert');
    expect(repository.rows).toEqual([seeded.fixture]);
    expect((await seedE2EScratchUser({ repository, databaseName })).action).toBe('existing');

    repository.rows.push(platformEve);
    repository.counts = runtimeBaseline();

    const preflight = await preflightE2EScratchUser({
      repository,
      databaseName,
      fetchUsers: async () => ({
        users: [
          {
            id: seeded.fixture.id,
            externalId: null,
            type: 'user',
            username: 'alex',
            userImage: null,
          },
        ],
      }),
    });
    expect(preflight).toEqual(seeded.fixture);

    const cleaned = await cleanupE2EScratchUser({ repository, databaseName });
    expect(cleaned).toEqual({ fixture: seeded.fixture, removed: true });
    expect(repository.lockModes).toContain(true);
    expect(repository.deleteInputs).toEqual([seeded.fixture]);
    expect(repository.rows).toEqual([platformEve]);
    repository.counts.usageCount = 1;
    await expect(cleanupE2EScratchUser({ repository, databaseName })).rejects.toThrow(
      /side effects/,
    );
    repository.counts.usageCount = 0;
    expect((await cleanupE2EScratchUser({ repository, databaseName })).removed).toBe(false);
  });

  it('rechecks Clerk identity in Postgres even when the HTTP projection looks exact', async () => {
    const repository = new MemoryFixtureRepository();
    const fixture = e2eScratchUser(databaseName);
    repository.rows = [{ ...fixture, clerkUserId: 'clerk_subject' }, platformEve];
    repository.counts = runtimeBaseline();
    await expect(
      preflightE2EScratchUser({
        repository,
        databaseName,
        fetchUsers: async () => ({
          users: [
            {
              id: fixture.id,
              externalId: null,
              type: 'user',
              username: 'alex',
              userImage: null,
            },
          ],
        }),
      }),
    ).rejects.toThrow(/exact Alex and platform Eve baseline/);
  });
});
