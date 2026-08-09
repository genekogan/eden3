import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PUBLIC_CREATION_MODERATION_SQL,
  passesPublicCreationModeration,
} from '../src/services/public-creation-moderation';

const apiRoot = path.resolve(import.meta.dirname, '..');

describe('public creation moderation parity', () => {
  it.each([
    ['missing attributes', undefined, true],
    ['null attributes', null, true],
    ['missing score', { other: true }, true],
    ['numeric below boundary', { nsfw_score: 0.849 }, true],
    ['numeric at boundary', { nsfw_score: 0.85 }, false],
    ['numeric above boundary', { nsfw_score: 0.851 }, false],
    ['decimal string', { nsfw_score: '0.849' }, false],
    ['scientific string', { nsfw_score: '8.5e-1' }, false],
    ['whitespace string', { nsfw_score: ' 0.1 ' }, false],
    ['NaN string', { nsfw_score: 'NaN' }, false],
    ['null score', { nsfw_score: null }, false],
    ['object score', { nsfw_score: { value: 0.1 } }, false],
    ['array score', { nsfw_score: [0.1] }, false],
    ['non-finite score', { nsfw_score: Number.POSITIVE_INFINITY }, false],
  ])('%s is classified fail-closed', (_name, attributes, expected) => {
    expect(passesPublicCreationModeration(attributes)).toBe(expected);
  });

  it('uses a canonical JSON-number-only SQL predicate with a strict boundary', () => {
    expect(PUBLIC_CREATION_MODERATION_SQL).toContain("c.attributes is null");
    expect(PUBLIC_CREATION_MODERATION_SQL).toContain("not (c.attributes ? 'nsfw_score')");
    expect(PUBLIC_CREATION_MODERATION_SQL).toContain(
      "jsonb_typeof(c.attributes->'nsfw_score') = 'number'",
    );
    expect(PUBLIC_CREATION_MODERATION_SQL).toContain(
      "(c.attributes->>'nsfw_score')::numeric < 0.85",
    );
    expect(PUBLIC_CREATION_MODERATION_SQL).not.toContain('!~');
    expect(PUBLIC_CREATION_MODERATION_SQL).not.toContain('<=');
  });

  it('routes every public SQL consumer through the shared predicate', async () => {
    const expectedCalls = new Map([
      ['src/routes/feed.ts', 2],
      ['src/routes/agents.ts', 1],
      ['src/routes/collections.ts', 3],
      ['src/services/media-object-postgres-repository.ts', 1],
    ]);

    for (const [relative, expected] of expectedCalls) {
      const source = await readFile(path.join(apiRoot, relative), 'utf8');
      expect(source.match(/publicCreationModerationSql\(pg\)/g) ?? [], relative).toHaveLength(
        expected,
      );
      expect(source, relative).not.toContain("attributes->>'nsfw_score'");
      expect(source, relative).not.toContain('!~');
    }

    const creationSource = await readFile(path.join(apiRoot, 'src/routes/creations.ts'), 'utf8');
    expect(creationSource).toContain('passesPublicCreationModeration(creation.attributes)');
    expect(creationSource).not.toContain('function nsfwScore');
  });
});
