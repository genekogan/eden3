import { timingSafeEqual } from 'node:crypto';

export function isValidChannelRuntimeAuthorization(
  authorization: string | string[] | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || typeof authorization !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return false;
  const supplied = authorization.slice(prefix.length);
  const expected = Buffer.from(expectedToken, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
