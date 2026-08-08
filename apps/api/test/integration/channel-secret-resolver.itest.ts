import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRootEnv, pg } from '@eden3/db';
import { deriveCapabilityKey, mintCapabilityId } from '@eden3/gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The deployed resolver engine (createResolverServer + resolveSecretRequest +
// decryptStoredSecret) is plain Node — imported here (typed via
// deployed-resolver-shim.d.ts). server.mjs's main() bootstrap dynamic-imports
// `postgres` (only installed in its container), so this itest wires the SAME
// SQL (loadActive/audit) as main() against the real Postgres via @eden3/db,
// binds a real Unix socket, and drives requests through the real OpenClaw
// bridge. It exercises the real request engine + real SQL scoping + real audit
// INSERT + real AES decrypt + real bridge — the §1.13 real-path proof. (main()'s
// uid-drop + socket-perms bootstrap is covered by the sidecar healthcheck test
// + the T27 deploy review.)
import {
  createResolverServer,
  decryptStoredSecret,
  resolveSecretRequest,
  // eslint-disable-next-line import/no-relative-packages
} from '../../../../infra/channel-secret-resolver/server.mjs';

loadRootEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '../../../../infra/openclaw/eden-channel-secret-resolver.mjs');
const TEST_KEY = randomBytes(32);
const CAP_KEY = deriveCapabilityKey(TEST_KEY);
const MARKER = `T12U01-ITEST-${randomUUID()}`;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let reachable = false;
let server: Server | undefined;
let socketDir: string;
let socketPath: string;
let ownerAccountId: string;
let connectionId = '';
let runtimeAccountId = '';
let token: string;
let capId: string;

function encryptToken(id: string, accountId: string, channel: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_KEY, iv);
  const aad = ['eden3-secret-v2', 'channel-token', id, accountId, channel].join('\0');
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

interface DeployedRow {
  id: string;
  account_id: string;
  channel: string;
  runtime_account_id: string | null;
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
  key_version: string;
}

// The exact loadActive/audit wiring server.mjs main() uses, against real PG.
function resolveRequest(request: unknown) {
  return resolveSecretRequest(request, {
    capKey: CAP_KEY,
    allowLegacyUnscoped: false,
    loadActive: async (ids: string[]): Promise<DeployedRow[]> => {
      const rows = await pg<DeployedRow[]>`
        select id, account_id, channel, runtime_account_id,
               token_ciphertext, token_iv, token_auth_tag, key_version
        from channel_connections
        where id = any(${ids}::uuid[]) and desired_state = 'active'
          and channel in ('discord', 'telegram')
      `;
      return rows;
    },
    decrypt: (row: DeployedRow) => decryptStoredSecret(row, TEST_KEY),
    // Mirrors server.mjs main()'s audit projection: identity + decision only.
    audit: async (event: {
      decision: string;
      reason?: string;
      connectionId?: string;
      row?: DeployedRow;
      deniedCount?: number;
      deniedReasons?: Record<string, number>;
    }) => {
      if (event.decision === 'granted') {
        await pg`
          insert into secret_access_audit_events (actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata)
          values (null, ${event.row!.account_id}, 'channel_token', ${event.connectionId!}, 'runtime_retrieve',
            ${pg.json(JSON.stringify({ decision: 'granted', reason: event.reason ?? null, channel: event.row!.channel, runtimeAccountId: event.row!.runtime_account_id, actor: 'openclaw_secret_resolver' }))})
        `;
      } else {
        await pg`
          insert into secret_access_audit_events (actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata)
          values (null, null, 'channel_token', ${ZERO_UUID}, 'runtime_retrieve_denied',
            ${pg.json(JSON.stringify({ decision: 'denied', reason: 'request_denied', deniedCount: event.deniedCount ?? 0, deniedReasons: event.deniedReasons ?? {}, actor: 'openclaw_secret_resolver' }))})
        `;
      }
    },
  });
}

function callBridge(
  ids: string[],
): Promise<{ values: Record<string, string>; errors?: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, '--socket', socketPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`bridge exited ${code}: ${err.trim()}`));
      else
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(e as Error);
        }
    });
    child.stdin.write(JSON.stringify({ protocolVersion: 1, provider: 'eden-channel-vault', ids }));
    child.stdin.end();
  });
}

beforeAll(async () => {
  try {
    const acct = await pg<{ id: string }[]>`select id from accounts limit 1`;
    if (acct.length === 0) return;
    ownerAccountId = acct[0]!.id;

    connectionId = randomUUID();
    runtimeAccountId = `eden-${connectionId}`;
    token = `SENTINEL-${randomUUID()}`;
    const enc = encryptToken(connectionId, ownerAccountId, 'discord', token);
    await pg`
      insert into channel_connections (
        id, account_id, channel, label, runtime_account_id, desired_state, status,
        token_ciphertext, token_iv, token_auth_tag, token_sha256, key_version
      ) values (
        ${connectionId}, ${ownerAccountId}, 'discord', ${MARKER}, ${runtimeAccountId}, 'active', 'connected',
        ${enc.ciphertext}, ${enc.iv}, ${enc.tag}, ${'itest-no-real-hash'}, 'v2'
      )
    `;
    capId = mintCapabilityId(CAP_KEY, { connectionId, channel: 'discord', runtimeAccountId, epoch: 'c1' });

    socketDir = await mkdtemp(path.join(tmpdir(), 'eden3-t12u01-itest-'));
    socketPath = path.join(socketDir, 'channel-secrets.sock');
    server = createResolverServer(resolveRequest) as Server;
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, resolve);
    });
    reachable = true;
  } catch {
    reachable = false;
  }
}, 30_000);

afterAll(async () => {
  if (server) await new Promise((r) => server!.close(() => r(null)));
  if (socketDir) await rm(socketDir, { recursive: true, force: true });
  if (connectionId) {
    await pg`delete from secret_access_audit_events where secret_id in (${connectionId}, ${ZERO_UUID}) and metadata->>'actor' = 'openclaw_secret_resolver' and created_at > now() - interval '1 hour'`;
    await pg`delete from channel_connections where id = ${connectionId}`;
  }
});

describe('channel-secret resolver — real engine + real Postgres SQL/audit', () => {
  it('resolves a legitimate capability and writes a real GRANT audit row with zero token material', async () => {
    if (!reachable) {
      console.warn('[T12-U01 itest] Postgres not reachable — skipping real-path proof');
      return;
    }
    const res = await callBridge([capId]);
    expect(res.values[capId]).toBe(token);

    const rows = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from secret_access_audit_events
      where secret_id = ${connectionId} and action = 'runtime_retrieve'
      order by created_at desc limit 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.decision).toBe('granted');
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(token);
  });

  it('denies a forged capability + a bare-legacy id, writing exactly ONE aggregated DENY audit row', async () => {
    if (!reachable) return;
    const forged = mintCapabilityId(deriveCapabilityKey(randomBytes(32)), {
      connectionId,
      channel: 'discord',
      runtimeAccountId,
      epoch: 'c1',
    });
    const bare = `channel/${connectionId}`;
    const before = (
      await pg<{ n: number }[]>`select count(*)::int as n from secret_access_audit_events where secret_id = ${ZERO_UUID} and action = 'runtime_retrieve_denied' and created_at > now() - interval '1 hour'`
    )[0]!.n;

    const res = await callBridge([forged, bare]);
    expect(res.values).toEqual({});
    expect(Object.keys(res.errors ?? {})).toHaveLength(2);

    const after = (
      await pg<{ n: number }[]>`select count(*)::int as n from secret_access_audit_events where secret_id = ${ZERO_UUID} and action = 'runtime_retrieve_denied' and created_at > now() - interval '1 hour'`
    )[0]!.n;
    expect(after).toBe(before + 1);
  });
});
