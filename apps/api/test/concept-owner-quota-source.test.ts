import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('concept owner quota admission', () => {
  it('locks, counts, chooses the slug, and inserts in one transaction', () => {
    const source = readFileSync(new URL('../src/routes/concepts.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.post('/:username/concepts'");
    const end = source.indexOf("app.patch('/:username/concepts/:slug'", start);
    const create = source.slice(start, end);

    expect(source).toContain("const CONCEPT_QUOTA_LOCK_PREFIX = 'concept-quota:';");
    expect(source).toContain('const CONCEPT_QUOTA_LOCK_SEED = 0;');
    expect(create).toContain('await pg.begin(async (tx) =>');
    expect(create).toContain('hashtextextended');
    expect(create).toContain('CONCEPT_QUOTA_LOCK_SEED');
    expect(create.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      create.indexOf('count(*)::int as count'),
    );
    expect(create.indexOf('count(*)::int as count')).toBeLessThan(
      create.indexOf('availableSlug(tx'),
    );
    expect(create.indexOf('availableSlug(tx')).toBeLessThan(
      create.indexOf('insert into concepts'),
    );

    const imageStart = source.indexOf("'/:username/concepts/:slug/images'");
    const imageEnd = source.indexOf('// ---- PATCH', imageStart);
    const imageCreate = source.slice(imageStart, imageEnd);
    expect(source).toContain(
      "const CONCEPT_IMAGE_QUOTA_LOCK_PREFIX = 'concept-image-quota:';",
    );
    expect(imageCreate).toContain('await pg.begin(async (tx) =>');
    expect(imageCreate.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      imageCreate.indexOf('count(*)::int as count'),
    );
    expect(imageCreate.indexOf('count(*)::int as count')).toBeLessThan(
      imageCreate.indexOf('getStore().put'),
    );
    expect(imageCreate.indexOf('getStore().put')).toBeLessThan(
      imageCreate.indexOf('insert into concept_images'),
    );
  });
});
