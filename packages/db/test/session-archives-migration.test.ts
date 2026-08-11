import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { sessions } from '../src/schema';

const migration = readFileSync(
  new URL('../migrations/0044_session_archives.sql', import.meta.url),
  'utf8',
);

describe('session archives migration', () => {
  it('adds one nullable reversible archive timestamp without repurposing legacy visibility', () => {
    expect(migration.trim()).toBe(
      'ALTER TABLE "sessions" ADD COLUMN "archived_at" timestamp with time zone;',
    );
    expect(migration).not.toContain('visible');
    expect(migration).not.toContain('deleted');
    expect(sessions.archivedAt.getSQLType()).toBe('timestamp with time zone');
  });
});
