import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  addCollectionCreation,
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertCollection,
  insertCreation,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

const execFileAsync = promisify(execFile);
const marker = makeMarker('account_export');

const CLERK_SECRET = `${marker}_clerk-secret`;
const WORKSPACE_SECRET = `/private/runtime/${marker}_workspace-secret`;
const MESSAGE_INTERNAL_SECRET = `${marker}_message-internal-secret`;
const CREATION_INTERNAL_SECRET = `${marker}_creation-internal-secret`;
const BILLING_SECRET = `${marker}_billing-secret`;
const VOUCHER_SECRET = `${marker}_voucher-secret`;
const IDEMPOTENCY_SECRET = `${marker}_idempotency-secret`;
const CHANNEL_SECRET = `${marker}_channel-ciphertext-secret`;
const AUDIT_SECRET = `${marker}_audit-secret`;
const UNAUTHORIZED_MESSAGE = `${marker}_unauthorized-session-message`;
const HIDDEN_MESSAGE = `${marker}_hidden-session-message`;
const DELETED_MESSAGE = `${marker}_deleted-session-message`;
const SHARED_MESSAGE = `${marker}_shared-session-message`;

let app: FastifyInstance;
let ownerId = '';
let strangerId = '';
let agentId = '';
let creationId = '';
let collectionId = '';
let ownedSessionId = '';
let sharedSessionId = '';
let hiddenSessionId = '';
let deletedSessionId = '';

interface Manifest {
  kind: string;
  version: number;
  accountId: string;
  counts: Record<string, number>;
  files: Record<string, { format: string; count: number }>;
  scope: Record<string, string>;
}

function jsonLines<T = Record<string, unknown>>(raw: string): T[] {
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

async function readZipEntries(payload: Buffer): Promise<Map<string, string>> {
  const root = await mkdtemp(path.join(tmpdir(), 'eden3-account-export-test-'));
  const zipPath = path.join(root, 'export.zip');
  try {
    await writeFile(zipPath, payload);
    const listed = await execFileAsync('/usr/bin/unzip', ['-Z1', zipPath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const names = listed.stdout.split('\n').filter((name) => name !== '');
    const entries = new Map<string, string>();
    for (const name of names) {
      const entry = await execFileAsync('/usr/bin/unzip', ['-p', zipPath, name], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      entries.set(name, entry.stdout);
    }
    return entries;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_stranger`);
  await pg`
    update accounts
    set clerk_user_id = ${CLERK_SECRET}
    where id = ${ownerId}
  `;

  agentId = await insertAgentAccount(`${marker}_agent`, {
    ownerId,
    name: 'Exported agent',
    description: 'A safe exported persona',
    persona: 'Be thoughtful and concise.',
    openclawId: `${marker}-runtime-id`,
    workspacePath: WORKSPACE_SECRET,
    public: false,
  });
  await insertAgentAccount(`${marker}_stranger_agent`, {
    ownerId: strangerId,
    name: 'Not exported',
    public: false,
  });

  creationId = await insertCreation({
    userId: ownerId,
    agentId,
    public: false,
    url: `https://cdn.example.test/${marker}.png`,
    thumbnailUrl: `https://cdn.example.test/${marker}-thumb.png`,
  });
  await pg`
    update creations
    set args = ${JSON.stringify({ token: CREATION_INTERNAL_SECRET })}::jsonb,
        attributes = ${JSON.stringify({ localPath: CREATION_INTERNAL_SECRET })}::jsonb,
        filename = ${CREATION_INTERNAL_SECRET}
    where id = ${creationId}
  `;
  await insertCreation({
    userId: strangerId,
    public: false,
    url: `https://cdn.example.test/${marker}-not-authorized.png`,
  });

  collectionId = await insertCollection({
    userId: ownerId,
    name: 'Exported collection',
    public: false,
  });
  await addCollectionCreation(collectionId, creationId, 0);
  await pg`
    update collections
    set contributors = ${JSON.stringify([CHANNEL_SECRET])}::jsonb
    where id = ${collectionId}
  `;
  await insertCollection({ userId: strangerId, name: 'Not exported', public: false });

  await pg`
    insert into creation_likes (user_id, creation_id)
    values (${ownerId}, ${creationId})
  `;
  await pg`
    insert into agent_likes (user_id, agent_id)
    values (${ownerId}, ${agentId})
  `;

  const [ownedSession] = await pg<{ id: string }[]>`
    insert into sessions (
      owner_id, title, visible, deleted, platform, gateway_session_key, channel, message_count
    ) values (
      ${ownerId}, 'Owned export session', true, false, 'web',
      ${`${marker}:gateway-secret`},
      ${JSON.stringify({ token: CHANNEL_SECRET })}::jsonb,
      1
    )
    returning id
  `;
  ownedSessionId = ownedSession!.id;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${ownedSessionId}, ${ownerId})
  `;
  await pg`
    insert into session_agents (session_id, agent_account_id)
    values (${ownedSessionId}, ${agentId})
  `;
  await pg`
    insert into messages (
      session_id, sender_id, role, content, attachments, thought, tool_calls, eden_message_data
    ) values (
      ${ownedSessionId}, ${ownerId}, 'user', 'Owned session message',
      ${JSON.stringify([
        {
          url: `https://cdn.example.test/${marker}-attachment.png`,
          mime: 'image/png',
          width: 640,
          height: 480,
          localPath: MESSAGE_INTERNAL_SECRET,
          token: MESSAGE_INTERNAL_SECRET,
        },
      ])}::jsonb,
      ${JSON.stringify({ thinking: MESSAGE_INTERNAL_SECRET })}::jsonb,
      ${JSON.stringify([{ function: { arguments: { token: MESSAGE_INTERNAL_SECRET } } }])}::jsonb,
      ${JSON.stringify({ internalPath: MESSAGE_INTERNAL_SECRET })}::jsonb
    )
  `;

  const [sharedSession] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, visible, deleted, platform, message_count)
    values (${strangerId}, 'Shared export session', true, false, 'web', 1)
    returning id
  `;
  sharedSessionId = sharedSession!.id;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${sharedSessionId}, ${ownerId})
  `;
  await pg`
    insert into messages (session_id, sender_id, role, content)
    values (${sharedSessionId}, ${strangerId}, 'user', ${SHARED_MESSAGE})
  `;

  const [privateSession] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, visible, deleted, message_count)
    values (${strangerId}, 'Stranger-only session', true, false, 1)
    returning id
  `;
  await pg`
    insert into messages (session_id, sender_id, role, content)
    values (${privateSession!.id}, ${strangerId}, 'user', ${UNAUTHORIZED_MESSAGE})
  `;

  const [hiddenSession] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, visible, deleted, message_count)
    values (${ownerId}, 'Hidden owner session', false, false, 1)
    returning id
  `;
  hiddenSessionId = hiddenSession!.id;
  await pg`
    insert into messages (session_id, sender_id, role, content)
    values (${hiddenSession!.id}, ${ownerId}, 'user', ${HIDDEN_MESSAGE})
  `;

  const [deletedSession] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, visible, deleted, message_count)
    values (${ownerId}, 'Deleted owner session', true, true, 1)
    returning id
  `;
  deletedSessionId = deletedSession!.id;
  await pg`
    insert into messages (session_id, sender_id, role, content)
    values (${deletedSessionId}, ${ownerId}, 'user', ${DELETED_MESSAGE})
  `;

  const [manna] = await pg<{ id: string }[]>`
    insert into manna_accounts (account_id, balance, subscription_balance)
    values (${ownerId}, 12, 3)
    returning id
  `;
  await pg`
    insert into manna_transactions (
      manna_account_id, amount, type, stripe_event_id, stripe_event_type,
      stripe_event_data, voucher_external_id, code, idempotency_key
    ) values (
      ${manna!.id}, 5, 'credit_test', ${BILLING_SECRET}, 'test.event',
      ${JSON.stringify({ customer: BILLING_SECRET })}::jsonb,
      ${VOUCHER_SECRET}, ${VOUCHER_SECRET}, ${IDEMPOTENCY_SECRET}
    )
  `;

  const [connection] = await pg<{ id: string }[]>`
    insert into channel_connections (
      account_id, agent_id, channel, token_ciphertext, token_iv,
      token_auth_tag, token_sha256, token_preview
    ) values (
      ${ownerId}, ${agentId}, 'discord', ${CHANNEL_SECRET}, 'iv', 'tag', 'hash', 'last4'
    )
    returning id
  `;
  await pg`
    insert into secret_access_audit_events (
      actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
    ) values (
      ${ownerId}, ${ownerId}, 'channel_token', ${connection!.id}, 'test',
      ${JSON.stringify({ payload: AUDIT_SECRET })}::jsonb
    )
  `;

  await pg`
    insert into billing_subscriptions (
      account_id, stripe_customer_id, stripe_subscription_id, status, tier
    ) values (${ownerId}, ${BILLING_SECRET}, ${`${marker}_subscription`}, 'active', 'pro')
  `;

  app = await buildServer({ gateway: null });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /account/export', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/account/export' });
    expect(response.statusCode).toBe(401);
  });

  it('streams a complete safe bundle for only the signed-in account', async () => {
    // The ignored accountId query guards against accidentally introducing a
    // caller-controlled export target later; ownership always comes from auth.
    const response = await app.inject({
      method: 'GET',
      url: `/account/export?accountId=${strangerId}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain(`${marker}_owner-eden3-account.zip`);
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const entries = await readZipEntries(response.rawPayload);
    expect([...entries.keys()].sort()).toEqual(
      [
        'agents.ndjson',
        'collection-items.ndjson',
        'collections.ndjson',
        'creations.ndjson',
        'favorite-agents.ndjson',
        'favorite-creations.ndjson',
        'manifest.json',
        'manna-transactions.ndjson',
        'manna.json',
        'messages.ndjson',
        'profile.json',
        'sessions.ndjson',
      ].sort(),
    );

    const manifest = JSON.parse(entries.get('manifest.json')!) as Manifest;
    expect(manifest).toMatchObject({
      kind: 'eden3.account.export',
      version: 1,
      accountId: ownerId,
      counts: {
        agents: 1,
        sessions: 4,
        messages: 4,
        creations: 1,
        collections: 1,
        collectionItems: 1,
        favoriteCreations: 1,
        favoriteAgents: 1,
        mannaTransactions: 1,
      },
      scope: { sessions: 'owned-or-member, including hidden-and-deleted retained rows' },
    });
    for (const [filename, descriptor] of Object.entries(manifest.files)) {
      expect(jsonLines(entries.get(filename)!)).toHaveLength(descriptor.count);
    }

    const profile = JSON.parse(entries.get('profile.json')!) as Record<string, unknown>;
    expect(profile).toMatchObject({ id: ownerId, username: `${marker}_owner`, type: 'user' });
    expect(profile).not.toHaveProperty('clerkUserId');

    const agents = jsonLines(entries.get('agents.ndjson')!);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: agentId, name: 'Exported agent' });
    expect(agents[0]).not.toHaveProperty('openclawId');
    expect(agents[0]).not.toHaveProperty('workspacePath');
    expect(agents[0]).not.toHaveProperty('provisionStatus');

    const sessions = jsonLines<{
      id: string;
      title: string;
      visible: boolean;
      deleted: boolean;
    }>(entries.get('sessions.ndjson')!);
    expect(new Set(sessions.map((session) => session.id))).toEqual(
      new Set([ownedSessionId, sharedSessionId, hiddenSessionId, deletedSessionId]),
    );
    expect(sessions.find((session) => session.id === hiddenSessionId)).toMatchObject({
      visible: false,
      deleted: false,
    });
    expect(sessions.find((session) => session.id === deletedSessionId)).toMatchObject({
      visible: true,
      deleted: true,
    });
    expect(sessions.every((session) => !('gatewaySessionKey' in session))).toBe(true);
    expect(sessions.every((session) => !('channel' in session))).toBe(true);

    const messages = jsonLines<Record<string, unknown>>(entries.get('messages.ndjson')!);
    expect(messages.map((message) => message.content)).toContain('Owned session message');
    expect(messages.map((message) => message.content)).toContain(SHARED_MESSAGE);
    expect(messages.map((message) => message.content)).toContain(HIDDEN_MESSAGE);
    expect(messages.map((message) => message.content)).toContain(DELETED_MESSAGE);
    expect(messages[0]).not.toHaveProperty('thought');
    expect(messages[0]).not.toHaveProperty('toolCalls');
    expect(messages[0]).not.toHaveProperty('edenMessageData');
    expect(messages[0]?.attachments).toEqual([
      {
        url: `https://cdn.example.test/${marker}-attachment.png`,
        mime: 'image/png',
        width: 640,
        height: 480,
      },
    ]);

    const creations = jsonLines(entries.get('creations.ndjson')!);
    expect(creations).toHaveLength(1);
    expect(creations[0]).toMatchObject({ id: creationId, userId: ownerId });
    expect(creations[0]).not.toHaveProperty('args');
    expect(creations[0]).not.toHaveProperty('attributes');
    expect(creations[0]).not.toHaveProperty('filename');

    const collections = jsonLines(entries.get('collections.ndjson')!);
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ id: collectionId, name: 'Exported collection' });
    expect(collections[0]).not.toHaveProperty('contributors');

    const manna = JSON.parse(entries.get('manna.json')!) as {
      balance: string;
      subscriptionBalance: string;
    };
    expect(Number(manna.balance)).toBe(12);
    expect(Number(manna.subscriptionBalance)).toBe(3);
    const transactions = jsonLines(entries.get('manna-transactions.ndjson')!);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ amount: '5.0000', type: 'credit_test' });
    expect(transactions[0]).not.toHaveProperty('stripeEventId');
    expect(transactions[0]).not.toHaveProperty('stripeEventData');
    expect(transactions[0]).not.toHaveProperty('voucherExternalId');
    expect(transactions[0]).not.toHaveProperty('code');
    expect(transactions[0]).not.toHaveProperty('idempotencyKey');

    const allExportedText = [...entries.values()].join('\n');
    for (const forbidden of [
      CLERK_SECRET,
      WORKSPACE_SECRET,
      MESSAGE_INTERNAL_SECRET,
      CREATION_INTERNAL_SECRET,
      BILLING_SECRET,
      VOUCHER_SECRET,
      IDEMPOTENCY_SECRET,
      CHANNEL_SECRET,
      AUDIT_SECRET,
      UNAUTHORIZED_MESSAGE,
    ]) {
      expect(allExportedText).not.toContain(forbidden);
    }
  });
});
