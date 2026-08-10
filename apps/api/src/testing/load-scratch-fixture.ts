import { createHash } from 'node:crypto';

const LOAD_DATABASE = /^eden3_runtime_load_[a-z0-9][a-z0-9_]{7,48}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface LoadScratchUser {
  id: string;
  username: string;
}

export interface LoadScratchFixtureRepository {
  transaction<T>(operation: (repository: LoadScratchFixtureRepository) => Promise<T>): Promise<T>;
  currentDatabase(): Promise<string>;
  currentAccounts(): Promise<readonly { id: string; username: string; type: string }[]>;
  insertUsers(users: readonly LoadScratchUser[]): Promise<void>;
  insertMannaAccounts(users: readonly LoadScratchUser[]): Promise<void>;
  mannaAccountIds(): Promise<readonly string[]>;
}

export function parseLoadScratchDatabaseUrl(raw: string): {
  databaseName: string;
  url: URL;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid load scratch database URL');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = Number(url.port);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === 5432 ||
    port === 5433 ||
    url.username !== 'eden3' ||
    url.password !== '' ||
    url.pathname !== `/${databaseName}` ||
    url.search !== '' ||
    url.hash !== '' ||
    !LOAD_DATABASE.test(databaseName)
  ) {
    throw new Error('invalid load scratch database URL');
  }
  return { databaseName, url };
}

function deterministicUuid(databaseName: string, index: number): string {
  const digest = createHash('sha256')
    .update('eden3:load-scratch-user:v1\0')
    .update(databaseName)
    .update('\0')
    .update(String(index))
    .digest('hex');
  const versioned = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${(
    (Number.parseInt(digest[16]!, 16) & 0x3) |
    0x8
  ).toString(16)}${digest.slice(17, 32)}`;
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`;
}

export function loadScratchUsers(databaseName: string, count = 50): LoadScratchUser[] {
  if (!LOAD_DATABASE.test(databaseName)) throw new Error('invalid load scratch database name');
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw new Error('load scratch user count must be between 1 and 50');
  }
  return Array.from({ length: count }, (_, index) => ({
    id: deterministicUuid(databaseName, index + 1),
    username: `load-user-${String(index + 1).padStart(3, '0')}`,
  }));
}

function assertExactUsers(
  actual: readonly { id: string; username: string; type: string }[],
  expected: readonly LoadScratchUser[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some((row, index) =>
      row.id !== expected[index]?.id ||
      row.username !== expected[index]?.username ||
      row.type !== 'user')
  ) {
    throw new Error('load scratch database contains an unexpected account inventory');
  }
}

export async function seedLoadScratchUsers(options: {
  repository: LoadScratchFixtureRepository;
  databaseName: string;
  count?: number;
}): Promise<readonly LoadScratchUser[]> {
  const expected = loadScratchUsers(options.databaseName, options.count);
  return options.repository.transaction(async (repository) => {
    if ((await repository.currentDatabase()) !== options.databaseName) {
      throw new Error('load scratch fixture connected to an unexpected database');
    }
    const before = await repository.currentAccounts();
    if (before.length === 0) {
      await repository.insertUsers(expected);
      await repository.insertMannaAccounts(expected);
    } else {
      assertExactUsers(before, expected);
    }
    assertExactUsers(await repository.currentAccounts(), expected);
    const mannaIds = [...await repository.mannaAccountIds()].sort();
    const userIds = expected.map((user) => user.id).sort();
    if (mannaIds.length !== userIds.length || mannaIds.some((id, index) => id !== userIds[index])) {
      throw new Error('load scratch manna account inventory did not converge');
    }
    return expected;
  });
}
