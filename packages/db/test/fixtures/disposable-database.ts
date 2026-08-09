const DATABASE_NAME = /^[A-Za-z0-9_-]+$/;
const LOCAL_ENDPOINTS = new Set(['127.0.0.1:5433', 'localhost:5433']);

interface LocalDisposableSource {
  authority: string;
  databaseName: string;
  protocol: 'postgres:' | 'postgresql:';
}

function parseLocalDisposableSource(raw: string): LocalDisposableSource {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error();
    if (parsed.search || parsed.hash) throw new Error();

    const authorityStart = raw.indexOf('://') + 3;
    const pathOffset = raw.slice(authorityStart).search(/[/?#]/);
    if (authorityStart < 3 || pathOffset < 0) throw new Error();
    const pathStart = authorityStart + pathOffset;
    if (raw[pathStart] !== '/') throw new Error();

    const authority = raw.slice(authorityStart, pathStart);
    const endpoint = authority.slice(authority.lastIndexOf('@') + 1);
    if (!LOCAL_ENDPOINTS.has(endpoint)) throw new Error();

    const rawPathname = raw.slice(pathStart);
    const match = /^\/([A-Za-z0-9_-]+)$/.exec(rawPathname);
    const databaseName = match?.[1];
    if (!databaseName || !DATABASE_NAME.test(databaseName)) throw new Error();

    return {
      authority,
      databaseName,
      protocol: parsed.protocol,
    };
  } catch {
    throw new Error('local disposable PostgreSQL source is invalid');
  }
}

export function localSourceDatabaseName(sourceDatabaseUrl: string): string {
  return parseLocalDisposableSource(sourceDatabaseUrl).databaseName;
}

export function localDisposableDatabaseUrl(
  sourceDatabaseUrl: string,
  database: string,
  scratchPattern: RegExp,
): string {
  if (scratchPattern.global || scratchPattern.sticky) {
    throw new Error('scratch database pattern must be stateless');
  }
  if (database !== 'postgres' && !scratchPattern.test(database)) {
    throw new Error('refusing non-disposable database');
  }
  const source = parseLocalDisposableSource(sourceDatabaseUrl);
  return `${source.protocol}//${source.authority}/${database}`;
}
