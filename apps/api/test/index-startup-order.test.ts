import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  events: [] as string[],
  ensureBaseline: vi.fn(async () => {
    boot.events.push('baseline');
  }),
  refreshActiveConceptInventories: vi.fn(async () => {
    boot.events.push('concepts');
  }),
  buildServer: vi.fn(async (options: unknown) => {
    boot.events.push('server');
    return {
      close: vi.fn(async () => undefined),
      listen: vi.fn(async () => {
        boot.events.push('listen');
      }),
      log: { info: vi.fn() },
      options,
    };
  }),
}));

vi.mock('@eden3/core', () => ({
  getEnv: () => {
    boot.events.push('env');
    return { API_PORT: 4999 };
  },
}));

vi.mock('@eden3/db', () => ({
  checkSchemaReadiness: vi.fn(),
  loadRootEnv: () => {
    boot.events.push('load-env');
  },
}));

vi.mock('@eden3/gateway', () => ({ ensureBaseline: boot.ensureBaseline }));
vi.mock('../src/gateway-glue', () => ({ defaultOpenclawDataDir: () => '/closed-e2e' }));
vi.mock('../src/production-boundary', () => ({
  assertProductionBoundary: () => {
    boot.events.push('boundary');
  },
}));
vi.mock('../src/server', () => ({ buildServer: boot.buildServer }));
vi.mock('../src/services/concepts', () => ({
  refreshActiveConceptInventories: boot.refreshActiveConceptInventories,
}));

const managedEnvironment = [
  'DATABASE_URL',
  'EDEN3_E2E_INTEGRATION_HEAD',
  'EDEN3_E2E_RUNTIME_NONCE',
  'NODE_ENV',
] as const;
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((name) => [name, process.env[name]]),
);

function setAttestationEnvironment(input: {
  databaseUrl?: string;
  database?: string;
  head?: string;
  nodeEnv?: string;
  nonce?: string;
}): void {
  for (const name of managedEnvironment) delete process.env[name];
  process.env.DATABASE_URL = input.databaseUrl ??
    `postgres://127.0.0.1:5433/${input.database ?? 'eden3_channel_client_entrypoint_order'}`;
  process.env.NODE_ENV = input.nodeEnv ?? 'test';
  if (input.head !== undefined) process.env.EDEN3_E2E_INTEGRATION_HEAD = input.head;
  if (input.nonce !== undefined) process.env.EDEN3_E2E_RUNTIME_NONCE = input.nonce;
}

async function importEntrypoint(): Promise<void> {
  vi.resetModules();
  await import('../src/index');
}

beforeEach(() => {
  boot.events.length = 0;
  boot.ensureBaseline.mockClear();
  boot.refreshActiveConceptInventories.mockClear();
  boot.buildServer.mockClear();
});

afterAll(() => {
  for (const name of managedEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('API entrypoint runtime-attestation ordering', () => {
  it.each([
    ['partial', { head: 'a'.repeat(40) }],
    ['malformed', { head: 'not-a-head', nonce: 'valid_nonce_123456' }],
    ['canonical', {
      database: 'eden3',
      head: 'a'.repeat(40),
      nonce: 'valid_nonce_123456',
    }],
    ['production', {
      head: 'a'.repeat(40),
      nodeEnv: 'production',
      nonce: 'valid_nonce_123456',
    }],
    ['localhost endpoint', {
      databaseUrl: 'postgres://localhost:5433/eden3_channel_client_entrypoint_order',
      head: 'a'.repeat(40),
      nonce: 'valid_nonce_123456',
    }],
    ['remote endpoint', {
      databaseUrl: 'postgres://remote.example:5433/eden3_channel_client_entrypoint_order',
      head: 'a'.repeat(40),
      nonce: 'valid_nonce_123456',
    }],
    ['default endpoint port', {
      databaseUrl: 'postgres://127.0.0.1/eden3_channel_client_entrypoint_order',
      head: 'a'.repeat(40),
      nonce: 'valid_nonce_123456',
    }],
    ['canonical Postgres port', {
      databaseUrl: 'postgres://127.0.0.1:5432/eden3_channel_client_entrypoint_order',
      head: 'a'.repeat(40),
      nonce: 'valid_nonce_123456',
    }],
  ] as const)('rejects %s inputs before any mutating boot work', async (_name, environment) => {
    setAttestationEnvironment(environment);

    await expect(importEntrypoint()).rejects.toThrow(/runtime attestation/);

    expect(boot.events).toEqual(['load-env', 'env', 'boundary']);
    expect(boot.ensureBaseline).not.toHaveBeenCalled();
    expect(boot.refreshActiveConceptInventories).not.toHaveBeenCalled();
    expect(boot.buildServer).not.toHaveBeenCalled();
  });

  it('admits a valid scratch pair before baseline, projection, server, and listen', async () => {
    const integrationHead = 'b'.repeat(40);
    const nonce = 'valid_nonce_123456';
    setAttestationEnvironment({ head: integrationHead, nonce });

    await importEntrypoint();

    expect(boot.events).toEqual([
      'load-env',
      'env',
      'boundary',
      'baseline',
      'concepts',
      'server',
      'listen',
    ]);
    expect(boot.buildServer).toHaveBeenCalledWith(expect.objectContaining({
      health: expect.objectContaining({
        runtimeAttestation: { integrationHead, nonce },
      }),
    }));
  });
});
