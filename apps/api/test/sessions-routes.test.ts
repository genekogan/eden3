import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ApiError } from '../src/errors';
import {
  decodeMessagesCursor,
  decodeSessionListCursor,
  encodeCursor,
  toAttachments,
} from '../src/routes/sessions';

describe('session cursors', () => {
  it('round-trips a session list cursor (including the null tail)', () => {
    const withTime = { p: true, m: '2026-07-03T10:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' };
    expect(decodeSessionListCursor(encodeCursor(withTime))).toEqual(withTime);
    const nullTail = { m: null, id: '11111111-1111-4111-8111-111111111111' };
    expect(decodeSessionListCursor(encodeCursor(nullTail))).toEqual(nullTail);
  });

  it('round-trips a messages cursor', () => {
    const cursor = { t: '2026-07-03T10:00:00.000Z', q: 42, id: '11111111-1111-4111-8111-111111111111' };
    expect(decodeMessagesCursor(encodeCursor(cursor))).toEqual(cursor);
    const legacy = { t: cursor.t, id: cursor.id };
    expect(decodeMessagesCursor(encodeCursor(legacy))).toEqual(legacy);
  });

  it('rejects malformed cursors with a 400 ApiError', () => {
    for (const bad of ['not-base64!!!', Buffer.from('{"m":42}').toString('base64url')]) {
      try {
        decodeSessionListCursor(bad);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(400);
        expect((err as ApiError).code).toBe('bad_cursor');
      }
    }
  });
});

describe('toAttachments', () => {
  it('maps migrated string-array attachments (live eden1 shape) to {url}', () => {
    expect(
      toAttachments(['https://cdn.example/a.jpeg', 'https://cdn.example/b.png']),
    ).toEqual([{ url: 'https://cdn.example/a.jpeg' }, { url: 'https://cdn.example/b.png' }]);
  });

  it('passes through eden3-native attachment objects, dropping junk fields', () => {
    expect(
      toAttachments([
        { url: 'http://localhost:4301/media/x.png', mime: 'image/png', width: 10, height: 20 },
        { url: '' }, // invalid — dropped
        { nope: true }, // invalid — dropped
        42, // invalid — dropped
      ]),
    ).toEqual([{ url: 'http://localhost:4301/media/x.png', mime: 'image/png', width: 10, height: 20 }]);
  });

  it('returns [] for null / non-array jsonb', () => {
    expect(toAttachments(null)).toEqual([]);
    expect(toAttachments({ url: 'x' })).toEqual([]);
  });
});

describe('conversation management route contract', () => {
  it('keeps archive separate from legacy visibility and deletion owner-only/soft', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/routes/sessions.ts'), 'utf8');
    expect(source).toContain("archived: z.enum(['active', 'archived'])");
    expect(source).toContain('sql`${sessions.archivedAt} is not null`');
    expect(source).toContain('sql`${sessions.archivedAt} is null`');
    expect(source).toContain('session.ownerId !== account.accountId');
    expect(source).toContain(".set({ deleted: true, pinned: false, updatedAt: new Date() })");
    expect(source).toContain('coalesce(${sessions.pinned}, false) desc');
  });
});
