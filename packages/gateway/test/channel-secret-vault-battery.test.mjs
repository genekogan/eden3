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
 * FG-VAULT (gap 45) — the channel-token custody attack battery, through the
 * DEPLOYED path: the real OpenClaw bridge → a real Unix socket →
 * createResolverServer → resolveSecretRequest, with REAL AES decrypt and REAL
 * capability MACs. Synthetic sentinel tokens are minted in-test and kept
 * OUT-OF-BAND (never in the row objects the resolver sees), so a broken
 * decryptor that echoes a row field cannot pass. Every denial path is asserted
 * to perform ZERO real decryptions.
 */

const tokensById = new Map(); // connectionId -> plaintext sentinel (out-of-band)

// A faithful channel_connections row with a real AES-GCM v2 token. The plaintext
// is stored out-of-band; the row carries ONLY ciphertext, as the DB would.
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
  tokensById.set(id, token);
  return {
    id,
    account_id,
    channel,
    runtime_account_id,
    token_ciphertext: ciphertext.toString('base64'),
    token_iv: iv.toString('base64'),
    token_auth_tag: cipher.getAuthTag().toString('base64'),
    key_version: 'v2',
  };
}

function capIdFor(row, epoch = 'c1', key = CAP_KEY) {
  return mintCapabilityId(key, {
    connectionId: row.id,
    accountId: row.account_id,
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
  let decryptCount;
  let loadActiveCalls;

  async function start({ allowLegacyUnscoped = false, resolveOverride } = {}) {
    auditLog = [];
    decryptCount = 0;
    loadActiveCalls = 0;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const resolveRequest =
      resolveOverride ??
      ((request) =>
        resolveSecretRequest(request, {
          capKey: CAP_KEY,
          allowLegacyUnscoped,
          loadActive: async (ids) => {
            loadActiveCalls += 1;
            return ids.map((id) => byId.get(id)).filter(Boolean);
          },
          decrypt: (row) => {
            decryptCount += 1;
            return decryptStoredSecret(row, VAULT_KEY);
          },
          // Mirror the production audit SQL projection (server.mjs main): identity
          // + decision only — storing the raw row would be a TEST leak.
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
        }));
    server = createResolverServer(resolveRequest);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  }

  /** Drive a request through the real OpenClaw bridge; capture stdout AND stderr. */
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
          reject(Object.assign(new Error(`bridge exited ${code}`), { code, stderr: err }));
          return;
        }
        try {
          resolve({ ...JSON.parse(out), _stderr: err });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.write(JSON.stringify({ protocolVersion: 1, provider: PROVIDER, ids }));
      child.stdin.end();
    });
  }

  const aggregateDenied = () => auditLog.filter((e) => e.decision === 'denied');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eden3-vault-battery-'));
    socketPath = path.join(dir, 'channel-secrets.sock');
    rows = [];
    tokensById.clear();
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL: a legitimate capability resolves the correct token, decrypts exactly once, audits a GRANT', async () => {
    const row = connectionRow();
    rows = [row];
    await start();
    const id = capIdFor(row);
    const res = await callBridge([id]);
    expect(res.values[id]).toBe(tokensById.get(row.id));
    expect(res.errors).toBeUndefined();
    expect(decryptCount).toBe(1);
    expect(auditLog).toEqual([
      expect.objectContaining({ decision: 'granted', reason: 'granted', connectionId: row.id }),
    ]);
  });

  it('CROSS-AGENT: a capability minted for active A cannot release active B (connectionId swap) — zero decrypts', async () => {
    const a = connectionRow({ runtime_account_id: 'eden-A' });
    const b = connectionRow({ runtime_account_id: 'eden-B' });
    rows = [a, b]; // BOTH active, so denial is at MAC, not row-missing
    await start();
    const forged = capIdFor(a).replace(a.id, b.id);
    const res = await callBridge([forged]);
    expect(res.values).toEqual({});
    expect(res.errors[forged]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      { decision: 'denied', reason: 'request_denied', deniedCount: 1, deniedReasons: { capability_forged: 1 } },
    ]);
  });

  it('CROSS-CHANNEL: a discord capability cannot release a telegram row — zero decrypts', async () => {
    const tg = connectionRow({ channel: 'telegram' });
    rows = [tg];
    await start();
    const discordCap = mintCapabilityId(CAP_KEY, {
      connectionId: tg.id,
      accountId: tg.account_id,
      channel: 'discord',
      runtimeAccountId: tg.runtime_account_id,
      epoch: 'c1',
    });
    const res = await callBridge([discordCap]);
    expect(res.values).toEqual({});
    expect(res.errors[discordCap]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      expect.objectContaining({ deniedReasons: { capability_forged: 1 } }),
    ]);
  });

  it('CROSS-ACCOUNT (deployed): a capability whose only difference is the owner account fails closed — zero decrypts', async () => {
    // Same connection/channel/runtime, DIFFERENT accountId (a capability minted
    // before an ownership transfer). Forces the deployed accountId binding to be
    // load-bearing: removing accountId symmetrically from mint+verify turns this
    // battery case RED.
    const row = connectionRow();
    rows = [row];
    await start();
    const otherOwnerCap = mintCapabilityId(CAP_KEY, {
      connectionId: row.id,
      accountId: randomUUID(), // not row.account_id
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id,
      epoch: 'c1',
    });
    const res = await callBridge([otherOwnerCap]);
    expect(res.values).toEqual({});
    expect(res.errors[otherOwnerCap]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      expect.objectContaining({ deniedReasons: { capability_forged: 1 } }),
    ]);
  });

  it('FORGED SCOPE: an attacker without the capability key cannot forge a valid id — zero decrypts', async () => {
    const row = connectionRow();
    rows = [row]; // active target
    await start();
    const forged = capIdFor(row, 'c1', deriveCapabilityKey(randomBytes(32)));
    const res = await callBridge([forged]);
    expect(res.values).toEqual({});
    expect(res.errors[forged]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      expect.objectContaining({ deniedReasons: { capability_forged: 1 } }),
    ]);
  });

  it('LEGACY/STRIPPED: a bare unscoped id fails closed in strict mode — zero decrypts', async () => {
    const row = connectionRow();
    rows = [row];
    await start({ allowLegacyUnscoped: false });
    const bare = `channel/${row.id}`;
    const res = await callBridge([bare]);
    expect(res.values).toEqual({});
    expect(res.errors[bare]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      { decision: 'denied', reason: 'request_denied', deniedCount: 1, deniedReasons: { legacy_unscoped_denied: 1 } },
    ]);
  });

  it('EPOCH REVOCATION (deployed): a correctly-MACed stale-epoch capability fails closed against the deployed resolver — zero decrypts', async () => {
    // Row exists and is active; the deployed resolver pins the epoch to the c1
    // constant, so a genuine c2-minted capability (valid MAC for the c2 scope)
    // is rejected at the deployed epoch check (server.mjs), not the TS one.
    const row = connectionRow();
    rows = [row];
    await start();
    const staleCap = capIdFor(row, 'c2'); // correctly MACed for epoch c2
    const res = await callBridge([staleCap]);
    expect(res.values).toEqual({});
    expect(res.errors[staleCap]).toBe('secret unavailable');
    expect(decryptCount).toBe(0);
    expect(aggregateDenied()).toEqual([
      expect.objectContaining({ deniedReasons: { capability_epoch_revoked: 1 } }),
    ]);
  });

  it('ENUMERATION: 127 ACTIVE decoy rows with wrong-key capabilities + 1 valid → only the valid resolves; one decrypt; 127 forged denied', async () => {
    const valid = connectionRow();
    const wrongKey = deriveCapabilityKey(randomBytes(32));
    const decoys = Array.from({ length: 127 }, () => connectionRow());
    rows = [valid, ...decoys]; // ALL active — denial must come from MAC verification
    await start();
    const validId = capIdFor(valid);
    const forgedIds = decoys.map((d) => capIdFor(d, 'c1', wrongKey));
    const res = await callBridge([validId, ...forgedIds]);
    expect(Object.keys(res.values)).toEqual([validId]);
    expect(res.values[validId]).toBe(tokensById.get(valid.id));
    expect(Object.keys(res.errors)).toHaveLength(127);
    expect(decryptCount).toBe(1); // only the valid capability reached decrypt
    expect(aggregateDenied()).toEqual([
      expect.objectContaining({ deniedCount: 127, deniedReasons: { capability_forged: 127 } }),
    ]);
  });

  it('BATCH BOUND (deployed): a 129-id request fails the whole request closed with zero backend calls', async () => {
    rows = [connectionRow()];
    await start();
    const ids = Array.from({ length: 129 }, () => capIdFor(connectionRow()));
    await expect(callBridge(ids)).rejects.toBeTruthy();
    expect(loadActiveCalls).toBe(0);
    expect(decryptCount).toBe(0);
  });

  it('ENUMERATION BY CONSTRUCTION: a wildcard / list-all id fails closed with zero backend calls', async () => {
    // Positive control first: the same server resolves a valid cap, proving the
    // wildcard failure is the malformed rejection, not an unrelated breakage.
    const row = connectionRow();
    rows = [row];
    await start();
    expect((await callBridge([capIdFor(row)])).values).toHaveProperty(capIdFor(row));
    const backendBefore = loadActiveCalls;
    await expect(callBridge(['channel/*'])).rejects.toBeTruthy();
    expect(loadActiveCalls).toBe(backendBefore); // malformed rejected before any backend hit
  }, 8000);

  it('LEAK SCAN: no token / ciphertext / iv / tag / key material appears in responses, bridge stderr, or audit projection', async () => {
    const row = connectionRow();
    rows = [row];
    await start();
    const grantId = capIdFor(row);
    const grantRes = await callBridge([grantId]);
    const denyRes = await callBridge([`channel/${row.id}`]); // legacy → deny
    const forgedRes = await callBridge([capIdFor(row, 'c1', deriveCapabilityKey(randomBytes(32)))]);
    const token = tokensById.get(row.id);
    const haystack = JSON.stringify({ grantRes, denyRes, forgedRes, auditLog });
    const stderrs = `${grantRes._stderr}${denyRes._stderr}${forgedRes._stderr}`;

    expect(grantRes.values[grantId]).toBe(token); // the ONLY place the token may appear
    for (const secret of [
      token,
      row.token_ciphertext,
      row.token_auth_tag,
      row.token_iv,
      VAULT_KEY.toString('base64'),
      VAULT_KEY.toString('hex'),
      CAP_KEY.toString('base64'),
      CAP_KEY.toString('hex'),
    ]) {
      // The token appears once, as the intended grant value; strip that single
      // occurrence, then require zero remaining sentinel hits anywhere.
      const scrubbed = haystack.replace(JSON.stringify(token), '""');
      expect(scrubbed).not.toContain(secret);
      expect(stderrs).not.toContain(secret);
    }
    for (const e of auditLog) {
      expect(JSON.stringify(e)).not.toContain(token);
      expect(e).toHaveProperty('decision');
    }
  });

  it('INTEGRITY META-CHECK: a genuine MAC-BYPASS resolver leaks the SAME forged-cap stimulus (battery is non-vacuous)', async () => {
    // A mutant resolver that skips capability verification (authorizes by row
    // existence alone — the pre-fix behavior) DOES release the token for a
    // wrong-key capability against an active row. This proves the FORGED case
    // above fails on a broken implementation, so its denial is meaningful.
    const victim = connectionRow();
    rows = [victim];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const brokenResolve = async (request) => {
      const values = {};
      for (const id of request.ids) {
        const connectionId = id.split('/')[1].split('.')[0];
        const row = byId.get(connectionId);
        if (row) values[id] = decryptStoredSecret(row, VAULT_KEY); // NO verify
      }
      return { protocolVersion: 1, values };
    };
    await start({ resolveOverride: brokenResolve });
    const forged = capIdFor(victim, 'c1', deriveCapabilityKey(randomBytes(32)));
    const res = await callBridge([forged]);
    expect(res.values[forged]).toBe(tokensById.get(victim.id)); // leaks → real check is load-bearing
  });

  it('KNOWN RESIDUAL (documented, DEBT-012): an intact capability is a bearer token — the resolver has no requester identity', async () => {
    // Blind forgery/enumeration/cross-scope are closed; full requester-binding
    // needs a broker-with-requester-context or gateway sharding (D-005). This
    // pins the boundary honestly — NOT a green FG-VAULT closure.
    const row = connectionRow();
    rows = [row];
    await start();
    const id = capIdFor(row);
    const first = await callBridge([id]);
    const replay = await callBridge([id]);
    expect(first.values[id]).toBe(tokensById.get(row.id));
    expect(replay.values[id]).toBe(tokensById.get(row.id));
  });
});
