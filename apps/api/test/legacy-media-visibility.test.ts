import { describe, expect, it } from 'vitest';

import type { PgClient } from '@eden3/db';

import { legacyMediaIsPubliclyReachable } from '../src/services/legacy-media-visibility';

function clientReturning(row: { known: boolean; live: boolean; erasing: boolean }): PgClient {
  return (async () => [row]) as unknown as PgClient;
}

describe('legacy media visibility gate', () => {
  const path = `/media/${'a'.repeat(64)}.png`;

  it('hides all-erasing bytes before physical deletion', async () => {
    await expect(legacyMediaIsPubliclyReachable(
      clientReturning({ known: true, live: false, erasing: true }),
      path,
    )).resolves.toBe(false);
  });

  it('preserves an exact live foreign/shared reference', async () => {
    await expect(legacyMediaIsPubliclyReachable(
      clientReturning({ known: true, live: true, erasing: true }),
      path,
    )).resolves.toBe(true);
  });

  it('retains legacy unknown files and rejects noncanonical paths', async () => {
    await expect(legacyMediaIsPubliclyReachable(
      clientReturning({ known: false, live: false, erasing: false }),
      path,
    )).resolves.toBe(true);
    await expect(legacyMediaIsPubliclyReachable(
      clientReturning({ known: false, live: false, erasing: false }),
      `/media/nested/${'a'.repeat(64)}.png`,
    )).resolves.toBe(false);
  });

  it('classifies every voice digest as known without making voice a public reference', async () => {
    let statement = '';
    const client = (async (strings: TemplateStringsArray) => {
      statement = strings.join('?').replace(/\s+/g, ' ');
      return [{ known: true, live: false, erasing: false }];
    }) as unknown as PgClient;
    await expect(legacyMediaIsPubliclyReachable(client, path)).resolves.toBe(false);
    expect(statement).toContain('matching_voice');
    expect(statement).toContain('v.output_sha256=?');
    const liveClause = statement.slice(statement.indexOf('as live,'));
    expect(liveClause).not.toContain('matching_voice');
  });
});
