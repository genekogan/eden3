import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Channel-secret capability binding (T12-U01, MVP gap 45 / codex finding #4).
 *
 * The channel-token custody resolver serves decrypted bot tokens over a Unix
 * socket whose only peer is the single shared OpenClaw gateway process. The
 * socket peer therefore carries NO per-agent identity (one process serves every
 * agent), so a token release cannot be bound to a requester at the transport.
 *
 * The binding instead rides in the one field Eden controls end-to-end: the
 * OpenClaw exec SecretRef `id`. Eden mints a capability id
 *
 *     channel/<connectionId>.<epoch>.<macB64url>
 *
 * where the MAC is HMAC-SHA256 over the connection's routing scope, keyed by a
 * secret derived from CHANNEL_TOKEN_ENCRYPTION_KEY (which lives only in the
 * resolver sidecar and the API/gateway config-generator — never in a sandbox).
 * The resolver recomputes the MAC over the DB row's ACTUAL scope and releases a
 * token only on an exact, constant-time match at the current epoch. A caller in
 * a sandbox or compromised-agent position cannot forge, cross-scope-replay, or
 * enumerate tokens because it cannot produce a valid MAC for any connection.
 *
 * Rotation / mass-revocation (bumping the epoch), KMS envelope encryption, and
 * the breach drill are T12-U02 — this module ships the epoch field + the
 * revocation-by-epoch hook so U02 can rotate, but performs no rotation itself.
 */

/** Domain-separated HKDF derivation from the shared vault key. */
const HKDF_SALT = 'eden3-channel-secret-capability';
const HKDF_INFO = 'v1';
/** Domain tag inside the MAC input, distinct from the AES-GCM AAD tag. */
const SCOPE_DOMAIN = 'eden3-channel-cap-v1';
/** 128-bit truncated MAC → 22 base64url chars (no padding). */
export const CAPABILITY_MAC_BYTES = 16;
export const CAPABILITY_EPOCH_DEFAULT = 'c1';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EPOCH = 'c[0-9]{1,6}';
const MAC_B64URL = '[A-Za-z0-9_-]{22}';

/** Legacy, unscoped id: `channel/<uuid>` (pre-capability custody). */
export const LEGACY_SECRET_ID = new RegExp(`^channel/(${UUID})$`, 'i');
/** Capability-bound id: `channel/<uuid>.<epoch>.<mac>`. */
export const CAPABILITY_SECRET_ID = new RegExp(
  `^channel/(${UUID})\\.(${EPOCH})\\.(${MAC_B64URL})$`,
  'i',
);
const EPOCH_RE = new RegExp(`^${EPOCH}$`, 'i');
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

export interface CapabilityScope {
  /** channel_connections.id (PK). */
  connectionId: string;
  /** channel_connections.channel — 'discord' | 'telegram'. */
  channel: string;
  /** channel_connections.runtime_account_id — the stable named-account key. */
  runtimeAccountId: string;
  /** Capability epoch; bumped by T12-U02 rotation to revoke prior capabilities. */
  epoch: string;
}

export type SecretIdDecision =
  | { kind: 'capability'; connectionId: string; epoch: string; mac: string }
  | { kind: 'legacy'; connectionId: string }
  | { kind: 'malformed' };

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const buf = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  return buf;
}

function parseVaultKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

/**
 * Derive the capability MAC key from the shared vault key. Domain-separated so
 * it can never coincide with the AES-GCM encryption key or any other use.
 */
export function deriveCapabilityKey(vaultKey: Buffer | string): Buffer {
  const ikm = typeof vaultKey === 'string' ? parseVaultKey(vaultKey) : vaultKey;
  if (ikm.length !== 32) throw new Error('vault key must be exactly 32 bytes');
  return Buffer.from(
    hkdfSync('sha256', ikm, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32),
  );
}

function canonicalScope(scope: CapabilityScope): string {
  const parts = [
    SCOPE_DOMAIN,
    scope.connectionId,
    scope.channel,
    scope.runtimeAccountId,
    scope.epoch,
  ];
  if (parts.some((p) => typeof p !== 'string' || p.length === 0 || p.includes('\0'))) {
    throw new Error('invalid capability scope');
  }
  return parts.join('\0');
}

/** Raw 16-byte MAC over the scope. */
export function capabilityMac(capKey: Buffer, scope: CapabilityScope): Buffer {
  return createHmac('sha256', capKey)
    .update(canonicalScope(scope), 'utf8')
    .digest()
    .subarray(0, CAPABILITY_MAC_BYTES);
}

/** Mint the capability-bound SecretRef id for a connection scope. */
export function mintCapabilityId(capKey: Buffer, scope: CapabilityScope): string {
  if (!UUID_RE.test(scope.connectionId)) throw new Error('invalid connectionId');
  if (!EPOCH_RE.test(scope.epoch)) throw new Error('invalid epoch');
  const id = `channel/${scope.connectionId}.${scope.epoch}.${b64url(capabilityMac(capKey, scope))}`;
  // Self-check: the minted id must parse back as a capability id.
  if (parseSecretId(id).kind !== 'capability') throw new Error('minted id failed self-parse');
  return id;
}

/** Classify a requested SecretRef id without trusting its contents. */
export function parseSecretId(id: unknown): SecretIdDecision {
  if (typeof id !== 'string') return { kind: 'malformed' };
  const cap = CAPABILITY_SECRET_ID.exec(id);
  if (cap) return { kind: 'capability', connectionId: cap[1]!, epoch: cap[2]!, mac: cap[3]! };
  const legacy = LEGACY_SECRET_ID.exec(id);
  if (legacy) return { kind: 'legacy', connectionId: legacy[1]! };
  return { kind: 'malformed' };
}

export type VerifyReason =
  | 'granted'
  | 'granted_legacy_unscoped'
  | 'malformed'
  | 'capability_forged'
  | 'capability_epoch_revoked'
  | 'legacy_unscoped_denied';

export interface VerifyResult {
  ok: boolean;
  connectionId: string | null;
  reason: VerifyReason;
}

/**
 * Verify a requested id against the connection's ACTUAL scope from the DB.
 *
 * The MAC is recomputed over the row's own (connectionId, channel,
 * runtimeAccountId) at the id's claimed epoch and constant-time compared to the
 * presented MAC — so a capability minted for one connection can never release
 * another connection's token, and a forged MAC (no capKey) never matches. The
 * id's claimed epoch must also equal the connection's current epoch, giving
 * T12-U02 a revoke-by-epoch hook. Legacy bare ids fail closed unless the
 * documented break-glass is enabled.
 */
export function verifySecretId(params: {
  id: unknown;
  capKey: Buffer;
  row: { connectionId: string; channel: string; runtimeAccountId: string | null; epoch: string };
  allowLegacyUnscoped: boolean;
}): VerifyResult {
  const parsed = parseSecretId(params.id);
  if (parsed.kind === 'malformed') {
    return { ok: false, connectionId: null, reason: 'malformed' };
  }
  if (parsed.kind === 'legacy') {
    return params.allowLegacyUnscoped
      ? { ok: true, connectionId: parsed.connectionId, reason: 'granted_legacy_unscoped' }
      : { ok: false, connectionId: parsed.connectionId, reason: 'legacy_unscoped_denied' };
  }

  // capability
  const { connectionId, channel, runtimeAccountId } = params.row;
  const presented = b64urlDecode(parsed.mac);
  if (!presented || presented.length !== CAPABILITY_MAC_BYTES || runtimeAccountId === null) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  let expected: Buffer;
  try {
    expected = capabilityMac(params.capKey, {
      connectionId,
      channel,
      runtimeAccountId,
      epoch: parsed.epoch,
    });
  } catch {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  if (!timingSafeEqual(expected, presented)) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_forged' };
  }
  if (parsed.epoch !== params.row.epoch) {
    return { ok: false, connectionId: parsed.connectionId, reason: 'capability_epoch_revoked' };
  }
  return { ok: true, connectionId: parsed.connectionId, reason: 'granted' };
}
