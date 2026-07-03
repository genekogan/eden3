import { randomBytes, randomUUID } from 'node:crypto';

import { accounts, agents, creations, db, pg, sessions } from '@eden3/db';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  resolveAccount,
  resolveAccountByUsername,
  resolveAgentByUsername,
  resolveCreation,
  resolveSession,
} from './permalinks';

/**
 * Live-postgres tests (localhost:5433, db eden3): throwaway rows created
 * below carry random hex24 external ids / usernames and are deleted in
 * afterAll (children before accounts, FK order).
 */

const hex24 = () => randomBytes(12).toString('hex');

const suffix = randomUUID().slice(0, 8);
const created = {
  accountIds: [] as string[],
  sessionIds: [] as string[],
  creationIds: [] as string[],
  agentAccountIds: [] as string[],
};

async function makeUser(username: string, externalId?: string) {
  const [row] = await db
    .insert(accounts)
    .values({ type: 'user', username, externalId: externalId ?? null })
    .returning();
  if (!row) throw new Error('failed to insert account');
  created.accountIds.push(row.id);
  return row;
}

afterAll(async () => {
  try {
    if (created.agentAccountIds.length > 0) {
      await db.delete(agents).where(inArray(agents.accountId, created.agentAccountIds));
    }
    if (created.creationIds.length > 0) {
      await db.delete(creations).where(inArray(creations.id, created.creationIds));
    }
    if (created.sessionIds.length > 0) {
      await db.delete(sessions).where(inArray(sessions.id, created.sessionIds));
    }
    if (created.accountIds.length > 0) {
      await db.delete(accounts).where(inArray(accounts.id, created.accountIds));
    }
  } finally {
    await pg.end();
  }
});

describe('resolveSession', () => {
  it('resolves by legacy hex24 external id and by uuid', async () => {
    const owner = await makeUser(`core-perma-owner-${suffix}`);
    const externalId = hex24();
    const [session] = await db
      .insert(sessions)
      .values({ externalId, ownerId: owner.id, title: 'permalink test' })
      .returning();
    created.sessionIds.push(session!.id);

    const byHex = await resolveSession(externalId);
    expect(byHex?.id).toBe(session!.id);
    const byUuid = await resolveSession(session!.id);
    expect(byUuid?.id).toBe(session!.id);
    const byUpperUuid = await resolveSession(session!.id.toUpperCase());
    expect(byUpperUuid?.id).toBe(session!.id);
  });

  it('returns null for malformed refs without querying', async () => {
    expect(await resolveSession('not-an-id')).toBeNull();
    expect(await resolveSession('')).toBeNull();
    expect(await resolveSession('123')).toBeNull();
  });

  it('returns null for unknown ids', async () => {
    expect(await resolveSession(hex24())).toBeNull();
    expect(await resolveSession(randomUUID())).toBeNull();
  });

  it('hides soft-deleted rows unless includeDeleted', async () => {
    const [session] = await db
      .insert(sessions)
      .values({ title: 'deleted session', deleted: true })
      .returning();
    created.sessionIds.push(session!.id);

    expect(await resolveSession(session!.id)).toBeNull();
    const withDeleted = await resolveSession(session!.id, { includeDeleted: true });
    expect(withDeleted?.id).toBe(session!.id);
  });
});

describe('resolveCreation', () => {
  it('resolves by external id and uuid', async () => {
    const user = await makeUser(`core-perma-creator-${suffix}`);
    const externalId = hex24();
    const [creation] = await db
      .insert(creations)
      .values({ externalId, userId: user.id, tool: 'test', public: true })
      .returning();
    created.creationIds.push(creation!.id);

    expect((await resolveCreation(externalId))?.id).toBe(creation!.id);
    expect((await resolveCreation(creation!.id))?.id).toBe(creation!.id);
    expect(await resolveCreation('nope')).toBeNull();
  });
});

describe('resolveAccount / resolveAccountByUsername', () => {
  it('resolves accounts by uuid, hex24 external id, and username (case-insensitive)', async () => {
    const externalId = hex24();
    const username = `Core-Perma-User-${suffix}`;
    const account = await makeUser(username, externalId);

    expect((await resolveAccount(account.id))?.id).toBe(account.id);
    expect((await resolveAccount(externalId))?.id).toBe(account.id);
    expect((await resolveAccountByUsername(username.toLowerCase()))?.id).toBe(account.id);
    expect((await resolveAccountByUsername(username.toUpperCase()))?.id).toBe(account.id);
    expect(await resolveAccountByUsername('')).toBeNull();
    expect(await resolveAccountByUsername(`missing-${suffix}-${randomUUID()}`)).toBeNull();
  });

  it('filters by account type when asked', async () => {
    const username = `core-perma-typed-${suffix}`;
    const account = await makeUser(username);
    expect((await resolveAccountByUsername(username, { type: 'user' }))?.id).toBe(account.id);
    expect(await resolveAccountByUsername(username, { type: 'agent' })).toBeNull();
  });
});

describe('resolveAgentByUsername', () => {
  it('returns the account plus the agents extension row', async () => {
    const username = `core-perma-agent-${suffix}`;
    const [account] = await db
      .insert(accounts)
      .values({ type: 'agent', username })
      .returning();
    created.accountIds.push(account!.id);
    await db.insert(agents).values({ accountId: account!.id, name: 'Permalink Agent' });
    created.agentAccountIds.push(account!.id);

    const resolved = await resolveAgentByUsername(username);
    expect(resolved?.account.id).toBe(account!.id);
    expect(resolved?.agent.accountId).toBe(account!.id);
    expect(resolved?.agent.name).toBe('Permalink Agent');
  });

  it('returns null for a user (non-agent) username', async () => {
    const username = `core-perma-human-${suffix}`;
    await makeUser(username);
    expect(await resolveAgentByUsername(username)).toBeNull();
  });
});
