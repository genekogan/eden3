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

// Real-path (§1.13) proof for T12-U01. The deployed resolver's production
// request wiring is imported as `buildResolveRequest` (the SAME closures main()
// uses — no hand-copied SQL), wired to the real Postgres via @eden3/db's pg,
// bound to a real Unix socket, and driven through the real OpenClaw bridge. It
// exercises the real engine + real SQL scoping + real audit INSERT + real AES +
// real bridge. (main()'s uid-drop + socket-perms bootstrap is covered by the
// sidecar healthcheck test + the T27 deploy review.)
import {
  buildResolveRequest,
  createResolverServer,
  // eslint-disable-next-line import/no-relative-packages
} from '../../../../infra/channel-secret-resolver/server.mjs';

loadRootEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '../../../../infra/openclaw/eden-channel-secret-resolver.mjs');
const TEST_KEY = randomBytes(32);
const CAP_KEY = deriveCapabilityKey(TEST_KEY);
const MARKER = `T12U01-ITEST-${randomUUID()}`;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let canConnect = false;
let server: Server | undefined;
let socketDir: string;
let socketPath: string;
let ownerAccountId: string;
let connectionId = '';
let runtimeAccountId = '';
let token: string;
let capId: string;
let seededCiphertext = '';

function encryptToken(id: string, accountId: string, channel: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_KEY, iv);
  const aad = ['eden3-secret-v2', 'channel-token', id, accountId, channel].join('\0');
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function callBridge(
  ids: string[],
): Promise<{ values: Record<string, string>; errors?: Record<string, string>; _stderr: string }> {
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
          resolve({ ...JSON.parse(out), _stderr: err });
        } catch (e) {
          reject(e as Error);
        }
    });
    child.stdin.write(JSON.stringify({ protocolVersion: 1, provider: 'eden-channel-vault', ids }));
    child.stdin.end();
  });
}

beforeAll(async () => {
  // Distinguish "DB genuinely unreachable" (legitimate skip) from a real setup
  // failure (must throw — never a silent pass). Only a failed connection probe
  // skips; everything after runs OUTSIDE any swallowing catch.
  try {
    await pg`select 1`;
    canConnect = true;
  } catch {
    canConnect = false;
    return;
  }

  const acct = await pg<{ id: string }[]>`select id from accounts limit 1`;
  if (acct.length === 0) throw new Error('itest requires at least one account row in the target DB');
  ownerAccountId = acct[0]!.id;

  connectionId = randomUUID();
  runtimeAccountId = `eden-${connectionId}`;
  token = `SENTINEL-${randomUUID()}`;
  const enc = encryptToken(connectionId, ownerAccountId, 'discord', token);
  seededCiphertext = enc.ciphertext;
  await pg`
    insert into channel_connections (
      id, account_id, channel, label, runtime_account_id, desired_state, status,
      token_ciphertext, token_iv, token_auth_tag, token_sha256, key_version
    ) values (
      ${connectionId}, ${ownerAccountId}, 'discord', ${MARKER}, ${runtimeAccountId}, 'active', 'connected',
      ${enc.ciphertext}, ${enc.iv}, ${enc.tag}, ${'itest-no-real-hash'}, 'v2'
    )
  `;
  capId = mintCapabilityId(CAP_KEY, {
    connectionId,
    accountId: ownerAccountId,
    channel: 'discord',
    runtimeAccountId,
    epoch: 'c1',
  });

  socketDir = await mkdtemp(path.join(tmpdir(), 'eden3-t12u01-itest-'));
  socketPath = path.join(socketDir, 'channel-secrets.sock');
  // The EXACT production wiring (buildResolveRequest) against the real DB.
  server = createResolverServer(
    buildResolveRequest(pg, { encryptionKey: TEST_KEY, capKey: CAP_KEY, allowLegacyUnscoped: false }),
  ) as Server;
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, resolve);
  });
}, 30_000);

afterAll(async () => {
  if (server) await new Promise((r) => server!.close(() => r(null)));
  if (socketDir) await rm(socketDir, { recursive: true, force: true });
  // Delete ONLY this test's own rows. GRANT rows are keyed by our unique
  // connectionId. The aggregated DENY rows share the ZERO_UUID sentinel with
  // every other request, so we NEVER delete them (that would erase unrelated
  // evidence) — the deny assertion uses a before/after count delta instead.
  if (connectionId) {
    await pg`delete from secret_access_audit_events where secret_id = ${connectionId} and metadata->>'actor' = 'openclaw_secret_resolver'`;
    await pg`delete from channel_connections where id = ${connectionId}`;
  }
});

describe('channel-secret resolver — deployed wiring (buildResolveRequest) + real Postgres', () => {
  it('resolves a legitimate capability and writes a real GRANT audit row with zero secret material', async () => {
    if (!canConnect) {
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
    // No token/ciphertext/key material in the persisted GRANT row or bridge stderr.
    for (const secret of [token, seededCiphertext, TEST_KEY.toString('base64'), CAP_KEY.toString('base64')]) {
      expect(JSON.stringify(rows[0]!.metadata)).not.toContain(secret);
      expect(res._stderr).not.toContain(secret);
    }
  });

  it('denies a forged capability + a bare-legacy id, writing exactly ONE aggregated DENY row (no evidence erased)', async () => {
    if (!canConnect) return;
    const forged = mintCapabilityId(deriveCapabilityKey(randomBytes(32)), {
      connectionId,
      accountId: ownerAccountId,
      channel: 'discord',
      runtimeAccountId,
      epoch: 'c1',
    });
    const bare = `channel/${connectionId}`;
    const before = (
      await pg<{ n: number }[]>`select count(*)::int as n from secret_access_audit_events where secret_id = ${ZERO_UUID} and action = 'runtime_retrieve_denied'`
    )[0]!.n;

    const res = await callBridge([forged, bare]);
    expect(res.values).toEqual({});
    expect(Object.keys(res.errors ?? {})).toHaveLength(2);

    const after = (
      await pg<{ n: number }[]>`select count(*)::int as n from secret_access_audit_events where secret_id = ${ZERO_UUID} and action = 'runtime_retrieve_denied'`
    )[0]!.n;
    expect(after).toBe(before + 1);
  });
});
