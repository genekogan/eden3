import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  channelTokenSecretContext,
  createResolverServer,
  decryptStoredSecret,
  deriveCapabilityKey,
  resolveSecretRequest,
} from '../../../infra/channel-secret-resolver/server.mjs';
import { mintCapabilityId } from '../src/channel-secret-capability';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '../../../infra/openclaw/eden-channel-secret-resolver.mjs');
const PROVIDER = 'eden-channel-vault';

const VAULT_KEY = randomBytes(32);
const CAP_KEY = deriveCapabilityKey(VAULT_KEY);

/**
 * FG-VAULT (gap 45) — the channel-token custody attack battery, exercised
 * through the DEPLOYED path: the real OpenClaw bridge → a real Unix socket →
 * createResolverServer → resolveSecretRequest, with REAL AES decrypt and REAL
 * capability MACs. Synthetic sentinel tokens are minted in-test; no real secret
 * ever appears.
 */

// Build a faithful channel_connections row with a real AES-GCM v2 token.
function connectionRow(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const account_id = overrides.account_id ?? randomUUID();
  const channel = overrides.channel ?? 'discord';
  const runtime_account_id = overrides.runtime_account_id ?? `eden-${id}`;
  const token = overrides.token ?? `SENTINEL-${randomUUID()}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  cipher.setAAD(Buffer.from(channelTokenSecretContext({ id, account_id, channel }), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    id,
    account_id,
    channel,
    runtime_account_id,
    metadata: overrides.metadata ?? null,
    token,
    token_ciphertext: ciphertext.toString('base64'),
    token_iv: iv.toString('base64'),
    token_auth_tag: cipher.getAuthTag().toString('base64'),
    key_version: 'v2',
  };
}

function capIdFor(row, epoch = 'c1') {
  return mintCapabilityId(CAP_KEY, {
    connectionId: row.id,
    channel: row.channel,
    runtimeAccountId: row.runtime_account_id,
    epoch,
  });
}

describe('FG-VAULT — channel-secret custody attack battery (deployed path)', () => {
  let dir;
  let socketPath;
  let server;
  let auditLog;
  let rows;

  /** Start the deployed resolver bound to a real socket over an in-memory store. */
  async function start({ allowLegacyUnscoped = false } = {}) {
    auditLog = [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const resolveRequest = (request) =>
      resolveSecretRequest(request, {
        capKey: CAP_KEY,
        allowLegacyUnscoped,
        loadActive: async (ids) => ids.map((id) => byId.get(id)).filter(Boolean),
        decrypt: (row) => decryptStoredSecret(row, VAULT_KEY),
        // Mirror the production audit SQL projection (server.mjs main): identity
        // + decision only. Storing the raw row (with ciphertext) would be a
        // TEST leak, not a resolver leak — so the harness projects exactly what
        // the deployed INSERT persists, and the leak scan checks that.
        audit: async (event) =>
          auditLog.push(
            event.decision === 'granted'
              ? {
                  decision: 'granted',
                  reason: event.reason,
                  connectionId: event.connectionId,
                  channel: event.row.channel,
                  runtimeAccountId: event.row.runtime_account_id,
                }
              : {
                  decision: 'denied',
                  reason: 'request_denied',
                  deniedCount: event.deniedCount,
                  deniedReasons: event.deniedReasons,
                },
          ),
      });
    server = createResolverServer(resolveRequest);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  }

  /** Drive a request through the real OpenClaw bridge script (real subprocess). */
  function callBridge(ids) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE, '--socket', socketPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`bridge exited ${code}: ${err.trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.write(JSON.stringify({ protocolVersion: 1, provider: PROVIDER, ids }));
      child.stdin.end();
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eden3-vault-battery-'));
    socketPath = path.join(dir, 'channel-secrets.sock');
    rows = [];
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL: a legitimate capability resolves the correct token and audits a GRANT', async () => {
    const row = connectionRow();
    rows = [row];
    await start();
    const id = capIdFor(row);
    const res = await callBridge([id]);
    expect(res.values[id]).toBe(row.token);
    expect(res.errors).toBeUndefined();
    expect(auditLog).toEqual([
      expect.objectContaining({ decision: 'granted', reason: 'granted', connectionId: row.id }),
    ]);
  });

  it('CROSS-AGENT: a capability minted for A cannot release B (connectionId swap)', async () => {
    const a = connectionRow({ runtime_account_id: 'eden-A' });
    const b = connectionRow({ runtime_account_id: 'eden-B' });
    rows = [a, b];
    await start();
    const forged = capIdFor(a).replace(a.id, b.id);
    const res = await callBridge([forged]);
    expect(res.values).toEqual({});
    expect(res.errors[forged]).toBe('secret unavailable');
    expect(auditLog.every((e) => e.decision === 'denied')).toBe(true);
  });

  it('CROSS-CHANNEL: a discord capability cannot release a telegram row of the same connection scope', async () => {
    const tg = connectionRow({ channel: 'telegram' });
    rows = [tg];
    await start();
    // Mint a capability claiming discord for this connection id + runtime id.
    const discordCap = mintCapabilityId(CAP_KEY, {
      connectionId: tg.id,
      channel: 'discord',
      runtimeAccountId: tg.runtime_account_id,
      epoch: 'c1',
    });
    const res = await callBridge([discordCap]);
    expect(res.values).toEqual({});
    expect(res.errors[discordCap]).toBe('secret unavailable');
  });

  it('FORGED SCOPE: an attacker without the capability key cannot forge a valid id', async () => {
    const row = connectionRow();
    rows = [row];
    await start();
    const forged = mintCapabilityId(deriveCapabilityKey(randomBytes(32)), {
      connectionId: row.id,
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id,
      epoch: 'c1',
    });
    const res = await callBridge([forged]);
    expect(res.values).toEqual({});
    expect(res.errors[forged]).toBe('secret unavailable');
  });

  it('LEGACY/STRIPPED: a bare unscoped id fails closed in strict mode', async () => {
    const row = connectionRow();
    rows = [row];
    await start({ allowLegacyUnscoped: false });
    const bare = `channel/${row.id}`;
    const res = await callBridge([bare]);
    expect(res.values).toEqual({});
    expect(res.errors[bare]).toBe('secret unavailable');
    // Denials aggregate into one audit event carrying the reason breakdown.
    expect(auditLog).toEqual([
      expect.objectContaining({
        decision: 'denied',
        deniedCount: 1,
        deniedReasons: { legacy_unscoped_denied: 1 },
      }),
    ]);
  });

  // NOTE: epoch-revocation is proven at the pure-unit level
  // (channel-secret-capability.test.ts) because the deployed resolver pins the
  // epoch to a constant in T12-U01 — a durable rotation column is T12-U02.

  it('ENUMERATION: a 128-id batch of forged capabilities yields nothing; one valid among them still resolves alone', async () => {
    const valid = connectionRow();
    rows = [valid];
    await start();
    const validId = capIdFor(valid);
    const forgedIds = Array.from({ length: 127 }, () => {
      const decoy = connectionRow();
      return mintCapabilityId(deriveCapabilityKey(randomBytes(32)), {
        connectionId: decoy.id,
        channel: decoy.channel,
        runtimeAccountId: decoy.runtime_account_id,
        epoch: 'c1',
      });
    });
    const res = await callBridge([validId, ...forgedIds]);
    // Exactly one token resolves; no aggregation across the batch.
    expect(Object.keys(res.values)).toEqual([validId]);
    expect(res.values[validId]).toBe(valid.token);
    expect(Object.keys(res.errors)).toHaveLength(127);
  });

  it('ENUMERATION BY CONSTRUCTION: a wildcard / list-all id fails the whole request closed', async () => {
    // The malformed id is rejected by the deployed server, which closes the
    // connection with no response; the bridge then fails closed (exit 1) after
    // its own no-response timeout. (Charset-level rejection of every wildcard
    // form is also proven synchronously in channel-secret-capability.test.ts.)
    rows = [connectionRow()];
    await start();
    await expect(callBridge(['channel/*'])).rejects.toBeTruthy();
  }, 8000);

  it('LEAK SCAN: no token / ciphertext / key material appears in responses or audit metadata across the battery', async () => {
    const row = connectionRow();
    rows = [row];
    await start();
    const grantRes = await callBridge([capIdFor(row)]);
    const denyRes = await callBridge([`channel/${row.id}`]); // legacy → deny
    const haystack = JSON.stringify({ grantRes, denyRes, auditLog });
    // The plaintext token appears ONLY as the intended grant value, nowhere else.
    expect(grantRes.values[capIdFor(row)]).toBe(row.token);
    for (const secret of [
      row.token_ciphertext,
      row.token_auth_tag,
      row.token_iv,
      VAULT_KEY.toString('base64'),
      CAP_KEY.toString('base64'),
    ]) {
      expect(haystack).not.toContain(secret);
    }
    // Audit records carry identity + decision only — never the token bytes.
    for (const e of auditLog) {
      expect(JSON.stringify(e)).not.toContain(row.token);
      expect(e).toHaveProperty('decision');
    }
  });

  it('KNOWN RESIDUAL (documented, DEBT): an intact capability is a bearer token — the resolver has no requester identity to bind', async () => {
    // The single shared gateway is the only socket peer and OpenClaw passes no
    // requester context, so a VALID capability replayed from any presentation
    // context still resolves. Blind forgery/enumeration/cross-scope are closed;
    // full requester-binding needs a broker-with-requester-context or gateway
    // sharding (escalated: DECISIONS D-005; owner T12-U02+). This test pins the
    // boundary honestly — it is NOT a green FG-VAULT closure.
    const row = connectionRow();
    rows = [row];
    await start();
    const id = capIdFor(row);
    const first = await callBridge([id]);
    const replay = await callBridge([id]); // exact replay — same bearer, resolves again
    expect(first.values[id]).toBe(row.token);
    expect(replay.values[id]).toBe(row.token);
  });

  it('INTEGRITY META-CHECK: the same battery request WOULD leak on a resolver that ignores the MAC', async () => {
    // Proves the battery is not vacuous: a broken (pre-fix) resolver that
    // authorizes by connection id alone returns a cross-agent token.
    const a = connectionRow();
    const b = connectionRow();
    rows = [a, b];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const brokenResolve = (request) =>
      resolveSecretRequest(request, {
        capKey: CAP_KEY,
        allowLegacyUnscoped: true, // old behavior: bare ids honored
        loadActive: async (ids) => ids.map((id) => byId.get(id)).filter(Boolean),
        decrypt: (rowIn) => decryptStoredSecret(rowIn, VAULT_KEY),
        audit: async () => {},
      });
    server = createResolverServer(brokenResolve);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    // Bare id (bulk-enumeration primitive) succeeds under the broken config.
    const bare = `channel/${b.id}`;
    const res = await callBridge([bare]);
    expect(res.values[bare]).toBe(b.token);
  });
});
