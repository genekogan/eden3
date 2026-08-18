import { describe, expect, it } from 'vitest';

import {
  loadScratchRuntimeAttestation,
  loadScratchUsers,
  parseLoadScratchDatabaseUrl,
  seedLoadScratchUsers,
  type LoadScratchFixtureRepository,
  type LoadScratchUser,
} from '../src/testing/load-scratch-fixture';

class FakeRepository implements LoadScratchFixtureRepository {
  accounts: { id: string; username: string; type: string }[] = [];
  mannaIds: string[] = [];
  transactionCount = 0;

  constructor(readonly databaseName: string) {}

  async transaction<T>(
    operation: (repository: LoadScratchFixtureRepository) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    return operation(this);
  }

  async currentDatabase() { return this.databaseName; }
  async currentAccounts() { return this.accounts; }
  async insertUsers(users: readonly LoadScratchUser[]) {
    this.accounts.push(...users.map((user) => ({ ...user, type: 'user' })));
  }
  async insertMannaAccounts(users: readonly LoadScratchUser[]) {
    this.mannaIds.push(...users.map((user) => user.id));
  }
  async mannaAccountIds() { return this.mannaIds; }
}

describe('disposable population load fixture', () => {
  it('accepts only explicit alternate-port loopback databases with the load namespace', () => {
    expect(parseLoadScratchDatabaseUrl(
      'postgres://eden3@127.0.0.1:55450/eden3_runtime_load_20260810_abcd',
    ).databaseName).toBe('eden3_runtime_load_20260810_abcd');
    for (const unsafe of [
      'postgres://eden3@127.0.0.1:5432/eden3_runtime_load_20260810_abcd',
      'postgres://eden3@127.0.0.1:5433/eden3_runtime_load_20260810_abcd',
      'postgres://eden3@db.example:55450/eden3_runtime_load_20260810_abcd',
      'postgres://postgres@127.0.0.1:55450/eden3_runtime_load_20260810_abcd',
      'postgres://eden3:secret@127.0.0.1:55450/eden3_runtime_load_20260810_abcd',
      'postgres://eden3@127.0.0.1:55450/eden3',
      'postgres://eden3@127.0.0.1:55450/eden3_runtime_load_20260810_abcd?sslmode=disable',
    ]) {
      expect(() => parseLoadScratchDatabaseUrl(unsafe)).toThrow(/invalid load scratch/);
    }
  });

  it('derives an exact deterministic 50-user population', () => {
    const users = loadScratchUsers('eden3_runtime_load_20260810_abcd');
    expect(users).toHaveLength(50);
    expect(users[0]?.username).toBe('load-user-001');
    expect(users[49]?.username).toBe('load-user-050');
    expect(new Set(users.map((user) => user.id)).size).toBe(50);
    expect(loadScratchUsers('eden3_runtime_load_20260810_abcd')).toEqual(users);
    expect(() => loadScratchUsers('eden3_runtime_load_20260810_abcd', 51)).toThrow(/between 1 and 50/);
  });

  it('attests only a non-production load database and exact source identity', () => {
    expect(loadScratchRuntimeAttestation({
      DATABASE_URL: 'postgres://eden3@127.0.0.1:55450/eden3_runtime_load_20260810_abcd',
      EDEN3_E2E_INTEGRATION_HEAD: 'a'.repeat(40),
      EDEN3_E2E_RUNTIME_NONCE: 'load_20260810_abcd',
      NODE_ENV: 'development',
    })).toEqual({
      databaseName: 'eden3_runtime_load_20260810_abcd',
      integrationHead: 'a'.repeat(40),
      nonce: 'load_20260810_abcd',
    });
    expect(() => loadScratchRuntimeAttestation({
      DATABASE_URL: 'postgres://eden3@127.0.0.1:55450/eden3_runtime_load_20260810_abcd',
      EDEN3_E2E_INTEGRATION_HEAD: 'a'.repeat(40),
      EDEN3_E2E_RUNTIME_NONCE: 'load_20260810_abcd',
      NODE_ENV: 'production',
    })).toThrow(/forbidden in production/);
  });

  it('seeds users and manna accounts together and converges idempotently', async () => {
    const databaseName = 'eden3_runtime_load_20260810_abcd';
    const repository = new FakeRepository(databaseName);
    const first = await seedLoadScratchUsers({ repository, databaseName });
    const second = await seedLoadScratchUsers({ repository, databaseName });
    expect(first).toEqual(second);
    expect(repository.accounts).toHaveLength(50);
    expect(repository.mannaIds).toHaveLength(50);
    expect(repository.transactionCount).toBe(2);
  });

  it('refuses wrong database identity and any pre-existing account drift', async () => {
    const databaseName = 'eden3_runtime_load_20260810_abcd';
    await expect(seedLoadScratchUsers({
      repository: new FakeRepository('eden3_runtime_load_wrongdb'),
      databaseName,
    })).rejects.toThrow(/unexpected database/);

    const drifted = new FakeRepository(databaseName);
    drifted.accounts.push({ id: crypto.randomUUID(), username: 'alex', type: 'user' });
    await expect(seedLoadScratchUsers({ repository: drifted, databaseName }))
      .rejects.toThrow(/unexpected account inventory/);
  });
});
