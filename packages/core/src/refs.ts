/**
 * Pure identifier-shape predicates shared by permalink resolvers, auth, and
 * session keys. Kept dependency-free so importing them never pulls in the
 * database client.
 */

const HEX24_RE = /^[0-9a-f]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a 24-char hex string — a legacy Mongo ObjectId (`external_id`). */
export function isHex24(value: string): boolean {
  return HEX24_RE.test(value);
}

/** True for a canonical hyphenated UUID (any version). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
