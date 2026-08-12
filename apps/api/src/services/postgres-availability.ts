const POSTGRES_CONNECTION_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const POSTGRES_UNAVAILABLE_STATES = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

interface DatabaseAuthority {
  hostname: string;
  port: number;
}

function databaseAuthority(raw: string | undefined): DatabaseAuthority | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: url.hostname, port };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function errorCode(value: Record<string, unknown>): string | null {
  return typeof value.code === 'string' ? value.code.toUpperCase() : null;
}

function matchesAuthority(value: Record<string, unknown>, authority: DatabaseAuthority | null): boolean {
  if (!authority) return false;
  const address = typeof value.address === 'string' ? value.address : null;
  const port = typeof value.port === 'number' ? value.port : Number(value.port);
  return address === authority.hostname && Number.isSafeInteger(port) && port === authority.port;
}

/**
 * Classify only structured PostgreSQL connectivity failures. Generic network
 * failures are admitted only when their address and port match DATABASE_URL,
 * so a provider/gateway ECONNREFUSED cannot be mislabeled as database loss.
 */
export function isPostgresUnavailableError(
  error: unknown,
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): boolean {
  const authority = databaseAuthority(databaseUrl);
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.value) || current.depth > 4) continue;
    seen.add(current.value);
    const candidate = record(current.value);
    if (!candidate) continue;
    const code = errorCode(candidate);
    if (code && (code.startsWith('08') || POSTGRES_UNAVAILABLE_STATES.has(code))) return true;
    if (code && POSTGRES_CONNECTION_CODES.has(code) && matchesAuthority(candidate, authority)) {
      return true;
    }
    if ('cause' in candidate) queue.push({ value: candidate.cause, depth: current.depth + 1 });
    if (Array.isArray(candidate.errors)) {
      for (const nested of candidate.errors) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

