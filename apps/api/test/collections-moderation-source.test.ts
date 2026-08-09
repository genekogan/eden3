import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('collection public-list moderation wiring', () => {
  it('applies one exact threshold predicate to detail, list count, and list covers', () => {
    const source = readFileSync(new URL('../src/routes/collections.ts', import.meta.url), 'utf8');
    expect(source.match(/publicCreationModeration\(\)/g)).toHaveLength(4);
    expect(source).toContain("(c.attributes->>'nsfw_score')::double precision < 0.85");
    expect(source).toMatch(
      /and \(c\.public = true or \$\{isOwner\}\)\s*\$\{isOwner \? pg`` : publicCreationModeration\(\)\}/,
    );
    expect(source).toMatch(
      /and c\.public = true\s*\$\{options\.includeModerated \? pg`` : publicCreationModeration\(\)\}/,
    );
  });
});
