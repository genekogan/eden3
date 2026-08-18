import { createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_VERSION = 2;
export const PROVIDER = 'eden-channel-vault';
export const MAX_IDS = 128;
export const MAX_FRAME_BYTES = 262_144;
export const DEFAULT_SOCKET_PATH = '/run/eden3/channel-secrets.sock';

// ---------------------------------------------------------------------------
// Capability binding (T12-U01). Mirrors packages/gateway/src/
// channel-secret-capability.ts; the agreement test asserts they never drift.
// The socket peer is always the single shared gateway process and carries no
// per-agent identity, so a token release is bound to a server-minted capability
// stamped into the SecretRef id — unforgeable from a sandbox/compromised-agent
// position because minting requires the HKDF-derived key held only here and in
// the API config-generator.
// ---------------------------------------------------------------------------
const HKDF_SALT = 'eden3-channel-secret-capability';
const HKDF_INFO = 'v1';
const SCOPE_DOMAIN = 'eden3-channel-cap-v1';
const CAPABILITY_MAC_BYTES = 16;
export const CAPABILITY_EPOCH_DEFAULT = 'c1';
export const CAPABILITY_EPOCH_MAX = 999_999;
const REQUESTER_HKDF_SALT = 'eden3-channel-secret-requester';
const REQUESTER_HKDF_INFO = 'v2';
const REQUESTER_DOMAIN = 'eden3-channel-request-v2';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

export function capabilityEpochId(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > CAPABILITY_EPOCH_MAX) {
    throw new Error('invalid channel capability epoch');
  }
  return `c${generation}`;
}
const LEGACY_SECRET_ID = new RegExp(`^channel/(${UUID})$`);
const CAPABILITY_SECRET_ID = new RegExp(
  `^channel/(${UUID})\\.(c[0-9]{1,6})\\.([A-Za-z0-9_-]{22})$`,
);
const RUNTIME_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROOF_B64URL = /^[A-Za-z0-9_-]{43}$/;

function b64urlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function deriveCapabilityKey(vaultKey) {
  const ikm = Buffer.isBuffer(vaultKey) ? vaultKey : parseEncryptionKey(vaultKey);
  if (ikm.length !== 32) throw new Error('resolver configuration invalid');
  return Buffer.from(
    hkdfSync('sha256', ikm, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32),
  );
}

export function deriveRequesterKey(vaultKey) {
  const ikm = Buffer.isBuffer(vaultKey) ? vaultKey : parseEncryptionKey(vaultKey);
  if (ikm.length !== 32) throw new Error('resolver configuration invalid');
  return Buffer.from(
    hkdfSync(
      'sha256',
      ikm,
      Buffer.from(REQUESTER_HKDF_SALT, 'utf8'),
      Buffer.from(REQUESTER_HKDF_INFO, 'utf8'),
      32,
    ),
  );
}

function canonicalRequesterContext(context) {
  const expectedField = context.channel === 'discord' ? 'token' : 'botToken';
  const expectedPath =
    `channels.${context.channel}.accounts.${context.runtimeAccountId}.${context.credentialField}`;
  const parts = [
    context.id,
    context.configPath,
    context.connectionId,
    context.channel,
    context.runtimeAccountId,
    context.agentId,
    context.credentialField,
  ];
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    Object.keys(context).sort().join(',') !==
      'agentId,channel,configPath,connectionId,credentialField,id,runtimeAccountId' ||
    parts.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0')) ||
    (context.channel !== 'discord' && context.channel !== 'telegram') ||
    context.credentialField !== expectedField ||
    context.configPath !== expectedPath ||
    !UUID_RE.test(context.connectionId) ||
    !RUNTIME_ACCOUNT_ID.test(context.runtimeAccountId) ||
    !RUNTIME_ACCOUNT_ID.test(context.agentId)
  ) {
    throw new Error('invalid resolver request');
  }
  return parts;
}

export function canonicalRequesterProofInput({ challenge, processInstanceId, requesters }) {
  if (
    !PROOF_B64URL.test(challenge) ||
    !UUID_RE.test(processInstanceId) ||
    !Array.isArray(requesters) ||
    requesters.length < 1 ||
    requesters.length > MAX_IDS
  ) {
    throw new Error('invalid resolver request');
  }
  const parts = [REQUESTER_DOMAIN, challenge, processInstanceId];
  const ids = new Set();
  for (const requester of requesters) {
    if (ids.has(requester?.id)) throw new Error('invalid resolver request');
    ids.add(requester.id);
    parts.push(...canonicalRequesterContext(requester));
  }
  return parts.join('\0');
}

export function requesterProof(requesterKey, params) {
  if (!Buffer.isBuffer(requesterKey) || requesterKey.length !== 32) {
    throw new Error('resolver configuration invalid');
  }
  return createHmac('sha256', requesterKey)
    .update(canonicalRequesterProofInput(params), 'utf8')
    .digest('base64url');
}

function capabilityMac(capKey, scope) {
  const parts = [
    SCOPE_DOMAIN,
    scope.connectionId,
    scope.accountId,
    scope.channel,
    scope.runtimeAccountId,
    scope.epoch,
  ];
  if (parts.some((p) => typeof p !== 'string' || p.length === 0 || p.includes('\0'))) {
    throw new Error('invalid capability scope');
  }
  return createHmac('sha256', capKey)
    .update(parts.join('\0'), 'utf8')
    .digest()
    .subarray(0, CAPABILITY_MAC_BYTES);
}

/** Classify a requested id without trusting its contents. */
export function parseSecretId(id) {
  if (typeof id !== 'string') return { kind: 'malformed' };
  const cap = CAPABILITY_SECRET_ID.exec(id);
  if (cap) return { kind: 'capability', connectionId: cap[1], epoch: cap[2], mac: cap[3] };
  const legacy = LEGACY_SECRET_ID.exec(id);
  if (legacy) return { kind: 'legacy', connectionId: legacy[1] };
  return { kind: 'malformed' };
}

/** Verify a requested id against the connection's ACTUAL DB scope. */
export function verifySecretId({ id, capKey, row, allowLegacyUnscoped }) {
  const parsed = parseSecretId(id);
  if (parsed.kind === 'malformed') return { ok: false, connectionId: null, reason: 'malformed' };
  if (parsed.kind === 'legacy') {
    return allowLegacyUnscoped
      ? { ok: true, connectionId: parsed.connectionId, reason: 'granted_legacy_unscoped' }
      : { ok: false, connectionId: parsed.connectionId, reason: 'legacy_unscoped_denied' };
  }
  const presented = b64urlDecode(parsed.mac);
  if (
    !presented ||
    presented.length !== CAPABILITY_MAC_BYTES ||
    presented.toString('base64url') !== parsed.mac ||
    row.runtimeAccountId == null ||
    row.accountId == null
  ) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  let expected;
  try {
    expected = capabilityMac(capKey, {
      connectionId: row.connectionId,
      accountId: row.accountId,
      channel: row.channel,
      runtimeAccountId: row.runtimeAccountId,
      epoch: parsed.epoch,
    });
  } catch {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  if (!timingSafeEqual(expected, presented)) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  if (parsed.epoch !== row.epoch) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_epoch_revoked' };
  }
  return { ok: true, connectionId: parsed.connectionId, reason: 'granted' };
}

const SECRET_ID = /^channel\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function databaseNameFromUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
    const authorityStart = raw.indexOf('://') + 3;
    const firstDelimiterOffset = raw.slice(authorityStart).search(/[/?#]/);
    if (authorityStart < 3 || firstDelimiterOffset < 0) return null;
    const pathStart = authorityStart + firstDelimiterOffset;
    if (raw[pathStart] !== '/') return null;
    const pathTail = raw.slice(pathStart);
    const pathEndOffset = pathTail.search(/[?#]/);
    const rawPathname = pathEndOffset < 0 ? pathTail : pathTail.slice(0, pathEndOffset);
    return /^\/([A-Za-z0-9_-]+)$/.exec(rawPathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Fail closed when the sidecar and API URLs select different logical DBs. */
export function assertMatchingDatabaseSelection(databaseUrl, apiDatabaseUrl) {
  const sidecar = databaseNameFromUrl(databaseUrl);
  const api = databaseNameFromUrl(apiDatabaseUrl);
  if (sidecar === null || api === null || sidecar !== api) {
    throw new Error('channel resolver database selection does not match the API');
  }
  return sidecar;
}

export function parseEncryptionKey(raw) {
  if (typeof raw !== 'string') throw new Error('resolver configuration invalid');
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('resolver configuration invalid');
  return key;
}

export function channelTokenSecretContext(row) {
  const parts = ['eden3-secret-v2', 'channel-token', row.id, row.account_id, row.channel];
  if (parts.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
    throw new Error('secret unavailable');
  }
  return parts.join('\0');
}

export function decryptStoredSecret(row, key) {
  if (row.key_version !== 'v1' && row.key_version !== 'v2') {
    throw new Error('secret unavailable');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(row.token_iv, 'base64'),
  );
  if (row.key_version === 'v2') {
    decipher.setAAD(Buffer.from(channelTokenSecretContext(row), 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(row.token_auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function parseResolverRequest(input, { challenge, requesterKey }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid resolver request');
  }
  if (
    input.protocolVersion !== PROTOCOL_VERSION ||
    input.provider !== PROVIDER ||
    Object.keys(input).sort().join(',') !==
      'challenge,ids,processInstanceId,proof,protocolVersion,provider,requesters' ||
    !Array.isArray(input.ids) ||
    input.ids.length < 1 ||
    input.ids.length > MAX_IDS ||
    // Syntactically valid capability OR legacy ids only. A structurally
    // malformed id (traversal, wildcard, wrong shape) fails the whole request
    // closed — there is no list-all / wildcard id by construction.
    !input.ids.every((id) => typeof id === 'string' && parseSecretId(id).kind !== 'malformed') ||
    !Array.isArray(input.requesters) ||
    input.requesters.length !== input.ids.length ||
    input.requesters.some((requester, index) => requester?.id !== input.ids[index]) ||
    input.challenge !== challenge ||
    !PROOF_B64URL.test(input.proof)
  ) {
    throw new Error('invalid resolver request');
  }
  const canonical = {
    challenge: input.challenge,
    processInstanceId: input.processInstanceId,
    requesters: input.requesters,
  };
  const expectedProof = Buffer.from(requesterProof(requesterKey, canonical), 'utf8');
  const presentedProof = Buffer.from(input.proof, 'utf8');
  if (
    expectedProof.length !== presentedProof.length ||
    !timingSafeEqual(expectedProof, presentedProof)
  ) {
    throw new Error('invalid resolver request');
  }
  if (new Set(input.ids).size !== input.ids.length) throw new Error('invalid resolver request');
  return {
    ids: input.ids,
    requesters: input.requesters,
    processInstanceId: input.processInstanceId,
  };
}

/**
 * Pure request engine. Every id is capability-verified against the connection's
 * ACTUAL scope before any decrypt; a cross-agent / cross-channel / forged /
 * stale-epoch / bare-legacy id fails closed. `loadActive` returns only
 * desired_state=active Discord/Telegram/X records; `decrypt` yields plaintext.
 *
 * Audit semantics: a GRANT is audited per connection AND is admitted only after
 * its audit write succeeds (a failed grant-audit withholds the token). DENIALS
 * are aggregated into a SINGLE best-effort event per request — this bounds
 * audit write-amplification from a 128-id enumeration attempt and gives no
 * per-id existence oracle in the audit stream.
 */
export async function resolveSecretRequest(
  input,
  { loadActive, decrypt, audit, capKey, requesterKey, challenge, allowLegacyUnscoped = false },
) {
  const { ids, requesters, processInstanceId } = parseResolverRequest(input, {
    challenge,
    requesterKey,
  });
  const parsed = ids.map((id) => ({ id, ...parseSecretId(id) }));
  const connectionIds = [...new Set(parsed.map((p) => p.connectionId))];
  const rows = await loadActive(connectionIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const values = {};
  const errors = {};
  const deniedReasons = {};
  let deniedCount = 0;
  const deny = (reason) => {
    deniedReasons[reason] = (deniedReasons[reason] ?? 0) + 1;
    deniedCount += 1;
  };

  for (let index = 0; index < parsed.length; index += 1) {
    const p = parsed[index];
    const requester = requesters[index];
    const row = byId.get(p.connectionId);
    if (!row) {
      errors[p.id] = 'secret unavailable';
      deny('connection_inactive');
      continue;
    }
    const expectedField = row.channel === 'discord' ? 'token' : 'botToken';
    if (
      requester.connectionId !== row.id ||
      requester.channel !== row.channel ||
      requester.runtimeAccountId !== row.runtime_account_id ||
      requester.agentId !== row.agent_openclaw_id ||
      requester.credentialField !== expectedField ||
      row.agent_owner_id !== row.account_id ||
      row.agent_deleted === true ||
      row.owner_deleted === true
    ) {
      errors[p.id] = 'secret unavailable';
      deny('requester_scope_mismatch');
      continue;
    }
    const scope = {
      connectionId: row.id,
      accountId: row.account_id ?? null,
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id ?? null,
      epoch: capabilityEpochId(row.capability_epoch),
    };
    const verdict = verifySecretId({ id: p.id, capKey, row: scope, allowLegacyUnscoped });
    if (!verdict.ok) {
      errors[p.id] = 'secret unavailable';
      deny(verdict.reason);
      continue;
    }
    try {
      const plaintext = decrypt(row);
      await audit({
        decision: 'granted',
        reason: verdict.reason,
        connectionId: row.id,
        row,
        requester,
        processInstanceId,
      });
      values[p.id] = plaintext;
    } catch {
      errors[p.id] = 'secret unavailable';
      deny('decrypt_or_audit_failed');
    }
  }

  if (deniedCount > 0) {
    try {
      await audit({ decision: 'denied', reason: 'request_denied', deniedCount, deniedReasons });
    } catch {
      /* aggregate denial audit is best-effort; ids are denied regardless */
    }
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    values,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

/**
 * The production resolveRequest wiring, factored out so main() AND the
 * integration test drive the IDENTICAL loadActive/decrypt/audit closures (no
 * hand-copied SQL drift). `sql` is a postgres-js tagged-template instance.
 */
export function buildResolveRequest(
  sql,
  { encryptionKey, capKey, requesterKey, allowLegacyUnscoped },
) {
  return (request, { challenge }) =>
    sql.begin((tx) =>
      resolveSecretRequest(request, {
        capKey,
        requesterKey,
        challenge,
        allowLegacyUnscoped,
        loadActive: (connectionIds) => tx`
        select c.id, c.account_id, c.channel, c.runtime_account_id,
               c.token_ciphertext, c.token_iv, c.token_auth_tag, c.key_version,
               c.capability_epoch,
               a.openclaw_id as agent_openclaw_id,
               a.owner_id as agent_owner_id,
               agent_account.deleted as agent_deleted,
               owner.deleted as owner_deleted
        from channel_connections c
        join agents a on a.account_id = c.agent_id
        join accounts agent_account on agent_account.id = a.account_id
        join accounts owner on owner.id = c.account_id
        where c.id = any(${connectionIds}::uuid[])
          and c.desired_state = 'active'
          and c.channel in ('discord', 'telegram')
        for share of c, a, agent_account, owner
      `,
        decrypt: (row) => decryptStoredSecret(row, encryptionKey),
      // Records identity + decision only. Never a token, ciphertext, hash,
      // preview, key, or capability secret. A per-connection GRANT gates the
      // plaintext release (a failed audit withholds the token); DENIALS arrive
      // aggregated (one row per request) as the enumeration/forgery signal.
        audit: (event) =>
          event.decision === 'granted'
            ? tx`
              insert into secret_access_audit_events (
                actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
              ) values (
                null, ${event.row.account_id}, 'channel_token', ${event.connectionId},
                'runtime_retrieve',
                ${tx.json(JSON.stringify({
                  decision: 'granted',
                  reason: event.reason,
                  channel: event.row.channel,
                  runtimeAccountId: event.row.runtime_account_id,
                  agentOpenclawId: event.requester.agentId,
                  configPath: event.requester.configPath,
                  processInstanceId: event.processInstanceId,
                  actor: 'openclaw_secret_resolver',
                }))}
              )
              `
            : tx`
              insert into secret_access_audit_events (
                actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
              ) values (
                null, null, 'channel_token', '00000000-0000-0000-0000-000000000000',
                'runtime_retrieve_denied',
                ${tx.json(JSON.stringify({
                  decision: 'denied',
                  reason: 'request_denied',
                  deniedCount: event.deniedCount,
                  deniedReasons: event.deniedReasons,
                  actor: 'openclaw_secret_resolver',
                }))}
              )
              `,
      }),
    );
}

export function createResolverServer(resolveRequest, options = {}) {
  const randomChallenge = options.randomChallenge ?? (() => randomBytes(32).toString('base64url'));
  return net.createServer((socket) => {
    const challenge = randomChallenge();
    if (!PROOF_B64URL.test(challenge)) {
      socket.destroy();
      return;
    }
    socket.setTimeout(5_000, () => socket.destroy());
    const chunks = [];
    let bytes = 0;
    let handled = false;

    const reject = () => {
      if (handled) return;
      handled = true;
      socket.destroy();
    };
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, challenge })}\n`);
    socket.on('data', (chunk) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) {
        reject();
        return;
      }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(0x0a);
      if (newline === -1) return;
      if (frame.subarray(newline + 1).toString('utf8').trim() !== '') {
        reject();
        return;
      }
      handled = true;
      void (async () => {
        try {
          const parsed = JSON.parse(frame.subarray(0, newline).toString('utf8'));
          const response = await resolveRequest(parsed, { challenge });
          socket.end(`${JSON.stringify(response)}\n`);
        } catch {
          socket.destroy();
        }
      })();
    });
  });
}

async function removeStaleSocket(socketPath) {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) throw new Error('resolver socket path occupied');
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiDatabaseUrl = process.env.EDEN3_API_DATABASE_URL;
  const encryptionKey = parseEncryptionKey(process.env.CHANNEL_TOKEN_ENCRYPTION_KEY);
  const capKey = deriveCapabilityKey(encryptionKey);
  const requesterKey = deriveRequesterKey(encryptionKey);
  // Break-glass only: tolerate pre-capability bare `channel/<uuid>` refs during
  // a transition. Default false = fail closed. Strict is the box + acceptance
  // default; see T12-U01 ruling proposal RP-1 for the local re-mint step.
  const allowLegacyUnscoped = process.env.CHANNEL_SECRET_ALLOW_LEGACY_UNSCOPED === '1';
  const socketPath = process.env.CHANNEL_SECRET_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  if (!databaseUrl || !socketPath.startsWith('/')) throw new Error('resolver configuration invalid');
  assertMatchingDatabaseSelection(databaseUrl, apiDatabaseUrl);

  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o770 });
  // The named volume is initialized by Docker as root. Claim only the socket
  // directory, then permanently drop to the same uid/gid as OpenClaw's node
  // user before opening either the database or the socket.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await chown(path.dirname(socketPath), 1000, 1000);
    process.setgid(1000);
    process.setuid(1000);
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, {
    max: 4,
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });
  const resolveRequest = buildResolveRequest(sql, {
    encryptionKey,
    capKey,
    requesterKey,
    allowLegacyUnscoped,
  });

  await removeStaleSocket(socketPath);
  const server = createResolverServer(resolveRequest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  process.stdout.write('channel secret resolver ready\n');

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await sql.end({ timeout: 5 });
    try {
      await unlink(socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') process.exitCode = 1;
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown().finally(() => process.exit()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('channel secret resolver failed\n');
    process.exit(1);
  });
}
