import { createHash } from 'node:crypto';

const SCRATCH_DATABASE = /^eden3_runtime_e2e_[a-z0-9][a-z0-9_]{7,80}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface E2EScratchUser {
  id: string;
  type: 'user';
  username: 'gene';
  externalId: null;
  clerkUserId: null;
  userImage: null;
  deleted: false;
}

export interface E2EScratchSideEffects {
  accountCount: number;
  agentCount: number;
  sessionCount: number;
  usageCount: number;
  providerRunCount: number;
  mannaAccountCount: number;
  mannaTransactionCount: number;
}

export function parseE2EScratchDatabaseUrl(raw: string): {
  databaseName: string;
  url: URL;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid E2E scratch database URL');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.port !== '5433' ||
    url.username !== 'eden3' ||
    url.pathname !== `/${databaseName}` ||
    url.search !== '' ||
    url.hash !== '' ||
    !SCRATCH_DATABASE.test(databaseName)
  ) {
    throw new Error('invalid E2E scratch database URL');
  }
  return { databaseName, url };
}

export function e2eScratchUser(databaseName: string): E2EScratchUser {
  if (!SCRATCH_DATABASE.test(databaseName)) {
    throw new Error('invalid E2E scratch database name');
  }
  const digest = createHash('sha256')
    .update('eden3:e2e-scratch-user:v1\0')
    .update(databaseName)
    .digest('hex');
  const versioned = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${(
    (Number.parseInt(digest[16]!, 16) & 0x3) |
    0x8
  ).toString(16)}${digest.slice(17, 32)}`;
  return {
    id: `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`,
    type: 'user',
    username: 'gene',
    externalId: null,
    clerkUserId: null,
    userImage: null,
    deleted: false,
  };
}

function exactScratchAccount(row: unknown, fixture: E2EScratchUser): boolean {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  return (
    candidate.id === fixture.id &&
    candidate.type === fixture.type &&
    candidate.username === fixture.username &&
    candidate.externalId === null &&
    candidate.clerkUserId === null &&
    candidate.userImage === null &&
    candidate.deleted === false
  );
}

export function assertE2EScratchAccountInventory(
  rows: readonly unknown[],
  fixture: E2EScratchUser,
): 'insert' | 'existing' {
  if (rows.length === 0) return 'insert';
  if (rows.length === 1 && exactScratchAccount(rows[0], fixture)) return 'existing';
  throw new Error('scratch database must contain only the exact synthetic scratch user');
}

function assertExactDevUsers(payload: unknown, fixture: E2EScratchUser): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('dev user preflight did not return the exact synthetic scratch user');
  }
  const users = (payload as Record<string, unknown>).users;
  if (!Array.isArray(users) || users.length !== 1) {
    throw new Error('dev user preflight did not return the exact synthetic scratch user');
  }
  const user = users[0];
  if (user === null || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('dev user preflight did not return the exact synthetic scratch user');
  }
  const candidate = user as Record<string, unknown>;
  if (
    candidate.id !== fixture.id ||
    candidate.type !== 'user' ||
    candidate.username !== 'gene' ||
    candidate.externalId !== null ||
    candidate.userImage !== null
  ) {
    throw new Error('dev user preflight did not return the exact synthetic scratch user');
  }
}

export function assertNoE2EScratchSideEffects(counts: E2EScratchSideEffects): void {
  if (
    counts.accountCount !== 1 ||
    counts.agentCount !== 0 ||
    counts.sessionCount !== 0 ||
    counts.usageCount !== 0 ||
    counts.providerRunCount !== 0 ||
    counts.mannaAccountCount !== 0 ||
    counts.mannaTransactionCount !== 0
  ) {
    throw new Error('scratch fixture preflight found agent or provider side effects');
  }
}

export async function verifyE2EScratchPreflight(options: {
  fixture: E2EScratchUser;
  fetchUsers: () => Promise<unknown>;
  readSideEffects: () => Promise<E2EScratchSideEffects>;
}): Promise<E2EScratchUser> {
  const users = await options.fetchUsers();
  assertExactDevUsers(users, options.fixture);
  const counts = await options.readSideEffects();
  assertNoE2EScratchSideEffects(counts);
  return options.fixture;
}
