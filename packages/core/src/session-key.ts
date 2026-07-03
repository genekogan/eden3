import { isUuid } from './refs';

/**
 * Gateway session keys.
 *
 * Every eden3 chat session maps to exactly one OpenClaw gateway session whose
 * key is `eden3:s:<session uuid>` (sent as `x-openclaw-session-key` and
 * mirrored in the OpenAI-compat `user` field). The gateway reserves some key
 * prefixes for its own machinery; an eden3 key must never collide with them.
 */

export const GATEWAY_SESSION_KEY_PREFIX = 'eden3:s:';

/** Prefixes the OpenClaw gateway reserves for internal session kinds. */
export const RESERVED_SESSION_KEY_PREFIXES = ['subagent:', 'cron:', 'acp:'] as const;

export class InvalidSessionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionKeyError';
  }
}

/** True when `key` starts with a prefix the gateway reserves for itself. */
export function isReservedSessionKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return RESERVED_SESSION_KEY_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/** Throw {@link InvalidSessionKeyError} unless `key` is non-empty and unreserved. */
export function assertSafeSessionKey(key: string): void {
  if (!key) throw new InvalidSessionKeyError('session key must be non-empty');
  if (isReservedSessionKey(key)) {
    throw new InvalidSessionKeyError(
      `session key ${JSON.stringify(key)} collides with a reserved gateway prefix ` +
        `(${RESERVED_SESSION_KEY_PREFIXES.join(', ')})`,
    );
  }
}

/**
 * Build the gateway session key for an eden3 session id:
 * `eden3:s:<lowercased uuid>`. Throws unless `sessionId` is a UUID.
 */
export function gatewaySessionKey(sessionId: string): string {
  if (!isUuid(sessionId)) {
    throw new InvalidSessionKeyError(
      `sessionId must be a UUID, got ${JSON.stringify(sessionId)}`,
    );
  }
  const key = `${GATEWAY_SESSION_KEY_PREFIX}${sessionId.toLowerCase()}`;
  assertSafeSessionKey(key); // belt-and-braces: our prefix is not reserved
  return key;
}

/**
 * Inverse of {@link gatewaySessionKey}: extract the session uuid from an
 * `eden3:s:<uuid>` key, or `null` when the key is not an eden3 session key.
 */
export function parseGatewaySessionKey(key: string): string | null {
  if (!key.startsWith(GATEWAY_SESSION_KEY_PREFIX)) return null;
  const uuid = key.slice(GATEWAY_SESSION_KEY_PREFIX.length);
  return isUuid(uuid) ? uuid.toLowerCase() : null;
}
