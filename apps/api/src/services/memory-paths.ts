import path from 'node:path';

const ACCOUNT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** Stable display portion for a per-peer memory filename (identity is the id). */
export function safeMemoryPeerName(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 48);
  return safe === '' ? 'user' : safe;
}

/**
 * Per-user memory identity contract. Names are readability only; the
 * immutable Eden account id prevents rename collisions and spoofing.
 */
export function memoryUserFilename(name: string, accountId: string): string {
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new TypeError(`invalid Eden account id ${JSON.stringify(accountId)}`);
  }
  return `${safeMemoryPeerName(name)}-${accountId}.md`;
}

export function memoryUserRelativePath(name: string, accountId: string): string {
  return path.posix.join('memory', 'users', memoryUserFilename(name, accountId));
}
