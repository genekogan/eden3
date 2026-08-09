/**
 * Return one literal PostgreSQL database pathname without allowing URL
 * normalization, percent-decoding, or nested segments to change its identity.
 */
export function databaseNameFromUrl(raw: string): string | null {
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
    const match = /^\/([A-Za-z0-9_-]+)$/.exec(rawPathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Match one literal host:port authority without accepting URL host
 * normalization or query/fragment connection overrides.
 */
export function hasLiteralPostgresEndpoint(
  raw: string,
  expectedHost: string,
  expectedPort: number,
): boolean {
  if (databaseNameFromUrl(raw) === null) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.search || parsed.hash) return false;
    const authorityStart = raw.indexOf('://') + 3;
    const pathOffset = raw.slice(authorityStart).indexOf('/');
    if (authorityStart < 3 || pathOffset < 0) return false;
    const authority = raw.slice(authorityStart, authorityStart + pathOffset);
    const endpoint = authority.slice(authority.lastIndexOf('@') + 1);
    return endpoint === `${expectedHost}:${expectedPort}`;
  } catch {
    return false;
  }
}
